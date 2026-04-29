import {
  buildContents,
  geminiGenerateJson,
  normalizeSystemInstruction,
  streamGeminiToNdjson,
  streamVertexToNdjson,
} from '../functions/_lib/gemini';
import { buildInternalizedOperatingInstruction } from '../src/lib/wuxingInternalization';
import { resolvePreferredLocale } from '../src/lib/locale';
import {
  auditRecords,
  HFCDIndustry,
  HFCDGates,
  learnHFCDParameters,
  normalizeHFCDThresholds,
  parseCsv,
  simulateHFCDScenarios,
  summarizeAudit,
  summarizeGateSafety,
  validateBlindMetrics,
  validateRows,
} from '../src/lib/hfcdCore';

type Env = {
  ASSETS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  GEMINI_API_KEY?: string;
  VERTEX_ENABLED?: string;
  VERTEX_TUNED_MODEL?: string;
  VERTEX_SERVICE_ACCOUNT_JSON?: string;
  VERTEX_SERVICE_ACCOUNT_JSON_BASE64?: string;
  HFCD_API_KEYS?: string;
  NODE_ENV?: string;
};
const instructionCache = new Map<string, string>();
const MAX_INSTRUCTION_CACHE = 120;

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

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

function assertHfcdApiKey(request: Request, env: Env) {
  const configuredKeys = (env.HFCD_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (configuredKeys.length === 0) return true;
  const authorization = request.headers.get('authorization') || '';
  const key = request.headers.get('x-api-key') || authorization.replace(/^Bearer\s+/i, '');
  return configuredKeys.includes(key);
}

async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true });
  }

  if (url.pathname === '/api/locale' && request.method === 'GET') {
    const country = request.headers.get('cf-ipcountry') || (request as Request & { cf?: { country?: string } }).cf?.country;
    const locale = resolvePreferredLocale({
      country,
      acceptLanguage: request.headers.get('accept-language'),
      fallback: 'en',
    });

    return json({
      locale,
      source: country ? 'ip-country' : 'accept-language',
    });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, { status: 405 });
  }

  try {
    if (url.pathname === '/api/gemini/chat/stream') {
      const { messages, model, systemInstruction, webSearchEnabled = true } = await request.json();
      const contents = await buildContents(messages || []);
      const vertexEnabled = Boolean(
        env.VERTEX_ENABLED === 'true' &&
          env.VERTEX_TUNED_MODEL &&
          (env.VERTEX_SERVICE_ACCOUNT_JSON_BASE64 || env.VERTEX_SERVICE_ACCOUNT_JSON),
      );
      const body = {
        contents,
        systemInstruction: normalizeSystemInstruction(systemInstruction),
        generationConfig: {
          temperature: 0.7,
        },
        ...(!vertexEnabled && webSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
      };

      if (vertexEnabled) {
        return streamVertexToNdjson({ env }, env.VERTEX_TUNED_MODEL!, body);
      }

      return streamGeminiToNdjson({ env }, model, {
        ...body,
        ...(webSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
      });
    }

    if (url.pathname === '/api/gemini/evaluate') {
      const { prompt, model } = await request.json();
      const response = await geminiGenerateJson({ env }, model, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      });

      const text =
        response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return json({ data: JSON.parse(cleaned) });
    }

    if (url.pathname === '/api/gemini/light-log') {
      const { prompt, model } = await request.json();
      const response = await geminiGenerateJson({ env }, model, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      });

      const text =
        response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
      return json({ text: text || '未提取到明显的光性变化。' });
    }

    if (url.pathname === '/api/wuxing/instruction') {
      const payload = await request.json();
      const cacheKey = buildInstructionCacheKey(payload);
      const cached = instructionCache.get(cacheKey);
      if (cached) {
        return json({ instruction: cached });
      }
      
      const { baseInstruction, systemInstruction, omegaPrompt, content, diagnosis } = payload;
      const instruction = buildInternalizedOperatingInstruction({
        baseInstruction,
        systemInstruction,
        omegaPrompt,
        content,
        diagnosis,
      });
      setInstructionCache(cacheKey, instruction);
      return json({
        instruction,
      });
    }

    if (url.pathname === '/api/hfcd/audit') {
      if (!assertHfcdApiKey(request, env)) {
        return json({ error: 'Invalid HFCD API key.' }, { status: 401 });
      }

      const payload = (await request.json()) as {
        industry?: HFCDIndustry;
        rows?: Array<Record<string, unknown>>;
        records?: Array<Record<string, unknown>>;
        csv?: string;
        model?: string;
        mode?: 'audit' | 'calibrate' | 'simulate' | 'advanced';
        thresholds?: Partial<HFCDGates>;
      };
      const industry = payload.industry || 'quantum';
      const rows = payload.csv ? parseCsv(payload.csv) : payload.rows || payload.records || [];
      const validation = validateRows(rows, industry);
      if (!validation.isValid) {
        return json({ error: 'Invalid HFCD input.', validation }, { status: 400 });
      }

      const mode = payload.mode || 'audit';
      const parameterProfile = mode === 'audit' && !payload.thresholds ? undefined : learnHFCDParameters(rows, industry);
      const activeThresholds = payload.thresholds
        ? normalizeHFCDThresholds(payload.thresholds)
        : parameterProfile?.thresholds;
      const results = auditRecords(rows, industry, { thresholds: activeThresholds });
      const simulation =
        mode === 'simulate' || mode === 'advanced'
          ? simulateHFCDScenarios(rows, industry, parameterProfile || learnHFCDParameters(rows, industry))
          : undefined;
      return json({
        model: payload.model || 'hfcd-v1',
        mode,
        industry,
        validation,
        parameterProfile,
        thresholds: activeThresholds,
        summary: summarizeAudit(results),
        gateSafety: summarizeGateSafety(results),
        blindMetrics: validateBlindMetrics(results),
        simulation,
        results,
      });
    }

    return json({ error: 'Not found.' }, { status: 404 });
  } catch (error) {
    console.error('Worker API error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Worker request failed.' },
      { status: 500 },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
