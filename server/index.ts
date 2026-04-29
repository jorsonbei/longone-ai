import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, GenerateContentResponse, Part } from '@google/genai';
import { getGoogleCloudAccessToken } from '../functions/_lib/gemini';
import { buildInternalizedOperatingInstruction } from '../src/lib/wuxingInternalization';
import { resolvePreferredLocale } from '../src/lib/locale';
import {
  auditRecords,
  HFCDFieldSimulationInput,
  HFCDIndustry,
  HFCDGates,
  learnHFCDParameters,
  normalizeHFCDThresholds,
  parseCsv,
  runHFCDFieldSimulation,
  simulateHFCDScenarios,
  summarizeAudit,
  summarizeGateSafety,
  validateBlindMetrics,
  validateRows,
} from '../src/lib/hfcdCore';
import {
  buildHFCDResearchCloudConfig,
  buildHFCDResearchJobPlan,
  HFCDResearchJobRequest,
} from '../src/lib/hfcdResearchJobs';

type Attachment = {
  name: string;
  mimeType: string;
  data?: string;
  url?: string;
};

type Message = {
  role: 'user' | 'model';
  content: string;
  attachments?: Attachment[];
};

const PORT = Number(process.env.PORT || 4173);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const firebaseConfigPath = path.join(projectRoot, 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));

dotenv.config({ path: path.join(projectRoot, '.env.local') });
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, 'training', 'vertex-ai', 'config', 'vertex.env') });

const app = express();
const instructionCache = new Map<string, string>();
const MAX_INSTRUCTION_CACHE = 120;

app.use(express.json({ limit: '60mb' }));

function setInstructionCache(key: string, value: string) {
  if (instructionCache.size >= MAX_INSTRUCTION_CACHE) {
    const oldestKey = instructionCache.keys().next().value;
    if (oldestKey) {
      instructionCache.delete(oldestKey);
    }
  }
  instructionCache.set(key, value);
}

function buildInstructionCacheKey(payload: {
  baseInstruction: string;
  systemInstruction: string;
  omegaPrompt: string;
  content: string;
  diagnosis: unknown;
}) {
  return JSON.stringify([
    payload.baseInstruction,
    payload.systemInstruction,
    payload.omegaPrompt,
    payload.content,
    payload.diagnosis,
  ]);
}

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY on the server.');
  }
  return new GoogleGenAI({ apiKey });
}

function getVertexAiClient() {
  const project = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_REGION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
  if (!project) {
    throw new Error('Missing VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT for Vertex AI.');
  }

  return new GoogleGenAI({
    vertexai: true,
    project,
    location,
    apiVersion: 'v1',
  });
}

function resolveChatClientAndModel(requestedModel: string) {
  const tunedModel = process.env.VERTEX_TUNED_MODEL;
  const vertexEnabled = process.env.VERTEX_ENABLED === 'true';
  if (vertexEnabled && tunedModel) {
    return {
      ai: getVertexAiClient(),
      model: tunedModel,
      provider: 'vertex',
    };
  }

  return {
    ai: getAiClient(),
    model: requestedModel,
    provider: 'gemini-api',
  };
}

async function urlToBase64(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return undefined;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.toString('base64');
  } catch (error) {
    console.error('Failed to recover attachment data from URL:', error);
    return undefined;
  }
}

async function buildContents(messages: Message[]) {
  return Promise.all(
    messages.map(async (message) => {
      const parts: Part[] = [];

      for (const attachment of message.attachments || []) {
        const data = attachment.data || (attachment.url ? await urlToBase64(attachment.url) : undefined);
        if (!data) {
          continue;
        }

        parts.push({
          inlineData: {
            mimeType: attachment.mimeType,
            data,
          },
        });
      }

      if (message.content) {
        parts.push({ text: message.content });
      }

      return {
        role: message.role,
        parts,
      };
    })
  );
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/locale', (req, res) => {
  const locale = resolvePreferredLocale({
    country: req.header('cf-ipcountry') || req.header('x-vercel-ip-country') || undefined,
    acceptLanguage: req.header('accept-language') || undefined,
    fallback: 'en',
  });

  res.json({
    locale,
    source: req.header('cf-ipcountry') ? 'ip-country' : 'accept-language',
  });
});

function assertHfcdApiKey(req: express.Request) {
  const configuredKeys = (process.env.HFCD_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (configuredKeys.length === 0) return true;
  const key = String(req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '') || '');
  return configuredKeys.includes(key);
}

function getProcessEnvRecord() {
  return process.env as Record<string, unknown>;
}

async function callGoogleApi(url: string, init: RequestInit = {}) {
  const token = await getGoogleCloudAccessToken({ env: getProcessEnvRecord() });
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload?.error?.message || text || `Google API failed with status ${response.status}`);
  }
  return payload;
}

function operationToStatus(operation: any) {
  if (!operation) return 'unknown';
  if (operation.error) return 'failed';
  if (operation.done) return 'succeeded';
  return 'running';
}

async function fetchGcsJson(bucket: string, objectName: string) {
  try {
    const token = await getGoogleCloudAccessToken({ env: getProcessEnvRecord() });
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) return undefined;
    return response.json();
  } catch {
    return undefined;
  }
}

app.get('/api/hfcd/research-jobs/status', async (req, res) => {
  try {
    if (!assertHfcdApiKey(req)) {
      res.status(401).json({ error: 'Invalid HFCD API key.' });
      return;
    }
    const cloud = buildHFCDResearchCloudConfig(getProcessEnvRecord());
    const operationName = typeof req.query.operationName === 'string' ? req.query.operationName : undefined;
    const artifactPrefix = typeof req.query.artifactPrefix === 'string' ? req.query.artifactPrefix : undefined;
    if (!cloud.enabled) {
      res.status(503).json({
        ok: false,
        status: 'not_configured',
        cloud,
        message: 'HFCD 云端长程仿真未配置。需要 HFCD_CLOUD_PROJECT_ID / HFCD_CLOUD_RUN_JOB / HFCD_GCS_BUCKET。',
      });
      return;
    }
    const operation = operationName ? await callGoogleApi(`https://run.googleapis.com/v2/${operationName}`) : undefined;
    const manifest = artifactPrefix && cloud.bucket
      ? await fetchGcsJson(cloud.bucket, `${artifactPrefix}/cloud_manifest.json`)
      : undefined;
    const status = (manifest as { status?: string } | undefined)?.status || operationToStatus(operation);
    res.json({
      ok: status !== 'failed',
      status,
      operationName,
      operation,
      artifactPrefix,
      manifest,
    });
  } catch (error) {
    console.error('HFCD research status API failed:', error);
    res.status(500).json({ ok: false, status: 'unknown', error: error instanceof Error ? error.message : 'HFCD research status failed.' });
  }
});

app.post('/api/hfcd/research-jobs/submit', async (req, res) => {
  try {
    if (!assertHfcdApiKey(req)) {
      res.status(401).json({ error: 'Invalid HFCD API key.' });
      return;
    }
    const request = req.body as HFCDResearchJobRequest;
    const cloud = buildHFCDResearchCloudConfig(getProcessEnvRecord());
    const plan = buildHFCDResearchJobPlan(request, getProcessEnvRecord());
    if (!cloud.enabled) {
      res.status(503).json({
        ok: false,
        status: 'not_configured',
        plan,
        cloud,
        message: 'HFCD 云端长程仿真未配置。需要先部署 Cloud Run Job 与 GCS 源目录。',
      });
      return;
    }
    const envVars = {
      ...plan.env,
      HFCD_JOB_ID: plan.jobId,
      HFCD_GCS_BUCKET: cloud.bucket || '',
      HFCD_SOURCE_GCS_PREFIX: plan.sourcePrefix,
      HFCD_ARTIFACT_PREFIX: plan.artifactPrefix,
      HFCD_EXPERIMENT_SCRIPT: plan.experimentScript,
      HFCD_OUTPUT_GLOBS: plan.outputGlobs,
    };
    const operation = await callGoogleApi(
      `https://run.googleapis.com/v2/projects/${cloud.projectId}/locations/${cloud.region}/jobs/${cloud.cloudRunJob}:run`,
      {
        method: 'POST',
        body: JSON.stringify({
          overrides: {
            taskCount: 1,
            timeout: '3600s',
            containerOverrides: [
              {
                env: Object.entries(envVars).map(([name, value]) => ({
                  name,
                  value: String(value),
                })),
              },
            ],
          },
        }),
      },
    );
    res.json({
      ok: true,
      status: 'queued',
      plan,
      cloud,
      operationName: operation?.name,
      operation,
    });
  } catch (error) {
    console.error('HFCD research submit API failed:', error);
    res.status(500).json({ ok: false, status: 'failed', error: error instanceof Error ? error.message : 'HFCD research submit failed.' });
  }
});

app.post('/api/hfcd/audit', (req, res) => {
  try {
    if (!assertHfcdApiKey(req)) {
      res.status(401).json({ error: 'Invalid HFCD API key.' });
      return;
    }

    const body = req.body as {
      industry?: HFCDIndustry;
      rows?: Array<Record<string, unknown>>;
      records?: Array<Record<string, unknown>>;
      csv?: string;
      model?: string;
      mode?: 'audit' | 'calibrate' | 'simulate' | 'advanced' | 'field';
      thresholds?: Partial<HFCDGates>;
      fieldSimulation?: HFCDFieldSimulationInput;
    };
    const industry = body.industry || 'quantum';
    const rows = body.csv ? parseCsv(body.csv) : body.rows || body.records || [];
    const validation = validateRows(rows, industry);
    if (!validation.isValid) {
      res.status(400).json({
        error: 'Invalid HFCD input.',
        validation,
      });
      return;
    }

    const mode = body.mode || 'audit';
    const parameterProfile = mode === 'audit' && !body.thresholds ? undefined : learnHFCDParameters(rows, industry);
    const activeThresholds = body.thresholds
      ? normalizeHFCDThresholds(body.thresholds)
      : parameterProfile?.thresholds;
    const results = auditRecords(rows, industry, { thresholds: activeThresholds });
    const simulation =
      mode === 'simulate' || mode === 'advanced'
        ? simulateHFCDScenarios(rows, industry, parameterProfile || learnHFCDParameters(rows, industry))
        : undefined;
    const fieldSimulation =
      mode === 'field' || (mode === 'advanced' && body.fieldSimulation)
        ? runHFCDFieldSimulation({
            rows,
            industry,
            profile: parameterProfile || learnHFCDParameters(rows, industry),
            input: body.fieldSimulation,
          })
        : undefined;
    res.json({
      model: body.model || 'hfcd-v1',
      mode,
      industry,
      validation,
      parameterProfile,
      thresholds: activeThresholds,
      summary: summarizeAudit(results),
      gateSafety: summarizeGateSafety(results),
      blindMetrics: validateBlindMetrics(results),
      simulation,
      fieldSimulation,
      results,
    });
  } catch (error) {
    console.error('HFCD audit API failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'HFCD audit failed.' });
  }
});

async function proxyFirebaseHelper(req: express.Request, res: express.Response, targetPath: string) {
  try {
    const upstreamUrl = new URL(`https://gen-lang-client-0488652785.firebaseapp.com${targetPath}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        value.forEach((item) => upstreamUrl.searchParams.append(key, String(item)));
      } else if (value != null) {
        upstreamUrl.searchParams.set(key, String(value));
      }
    }

    const upstream = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: {
        accept: req.headers.accept || '*/*',
        'content-type': req.headers['content-type'] || 'application/octet-stream',
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
      redirect: 'manual',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-encoding') {
        return;
      }
      res.setHeader(key, value);
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error(`Firebase helper proxy failed for ${targetPath}:`, error);
    res.status(502).send('Firebase helper proxy failed.');
  }
}

app.get('/__/firebase/init.json', (req, res) => {
  res.json({
    ...firebaseConfig,
    authDomain: req.headers.host || firebaseConfig.authDomain,
  });
});

app.get('/__/auth/:file', (req, res) => {
  proxyFirebaseHelper(req, res, `/__/auth/${req.params.file}`);
});

app.post('/__/auth/:file', (req, res) => {
  proxyFirebaseHelper(req, res, `/__/auth/${req.params.file}`);
});

app.post('/api/gemini/chat/stream', async (req, res) => {
  try {
    const { messages, model, systemInstruction, webSearchEnabled = true } = req.body as {
      messages: Message[];
      model: string;
      systemInstruction?: string;
      webSearchEnabled?: boolean;
    };

    const { ai, model: resolvedModel, provider } = resolveChatClientAndModel(model);
    const contents = await buildContents(messages);
    const tools = provider === 'vertex' ? undefined : webSearchEnabled ? [{ googleSearch: {} }] : undefined;

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const stream = await ai.models.generateContentStream({
      model: resolvedModel,
      contents,
      config: {
        tools,
        systemInstruction,
        temperature: 0.7,
      },
    });

    const citations: { uri: string; title: string }[] = [];

    for await (const chunk of stream) {
      const text =
        chunk.text ||
        ((chunk as GenerateContentResponse).candidates?.[0]?.content?.parts?.[0]?.text ?? '');

      const metadata = (chunk as GenerateContentResponse).candidates?.[0]?.groundingMetadata;
      if (metadata?.groundingChunks) {
        for (const groundingChunk of metadata.groundingChunks) {
          const uri = groundingChunk.web?.uri;
          if (!uri || citations.some((item) => item.uri === uri)) {
            continue;
          }

          citations.push({
            uri,
            title: groundingChunk.web?.title || 'Web Page',
          });
        }
      }

      if (text) {
        res.write(`${JSON.stringify({ type: 'text', text })}\n`);
      }
    }

    if (citations.length > 0) {
      res.write(`${JSON.stringify({ type: 'metadata', citations })}\n`);
    }

    res.end();
  } catch (error) {
    console.error('Gemini stream proxy failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Stream proxy failed.' });
      return;
    }

    res.write(`${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Stream proxy failed.' })}\n`);
    res.end();
  }
});

app.post('/api/gemini/evaluate', async (req, res) => {
  try {
    const { prompt, model } = req.body as { prompt: string; model: string };
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.1 },
    });

    const cleaned = (response.text || '').replace(/```json/g, '').replace(/```/g, '').trim();
    res.json({ data: JSON.parse(cleaned) });
  } catch (error) {
    console.error('Gemini evaluate proxy failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Evaluate proxy failed.' });
  }
});

app.post('/api/gemini/light-log', async (req, res) => {
  try {
    const { prompt, model } = req.body as { prompt: string; model: string };
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.2 },
    });

    res.json({ text: response.text || '未提取到明显的光性变化。' });
  } catch (error) {
    console.error('Gemini light-log proxy failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Light-log proxy failed.' });
  }
});

app.post('/api/wuxing/instruction', async (req, res) => {
  try {
    const payload = req.body as {
      baseInstruction: string;
      systemInstruction: string;
      omegaPrompt: string;
      content: string;
      diagnosis: Parameters<typeof buildInternalizedOperatingInstruction>[0]['diagnosis'];
    };
    const cacheKey = buildInstructionCacheKey(payload);
    const cached = instructionCache.get(cacheKey);
    if (cached) {
      res.json({ instruction: cached });
      return;
    }

    const instruction = buildInternalizedOperatingInstruction({
      baseInstruction: payload.baseInstruction,
      systemInstruction: payload.systemInstruction,
      omegaPrompt: payload.omegaPrompt,
      content: payload.content,
      diagnosis: payload.diagnosis,
    });
    setInstructionCache(cacheKey, instruction);

    res.json({ instruction });
  } catch (error) {
    console.error('Wuxing instruction build failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Instruction build failed.' });
  }
});

app.use(express.static(distDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ThingNature OS server listening on http://0.0.0.0:${PORT}`);
});
