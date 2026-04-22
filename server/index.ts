import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, GenerateContentResponse, Part } from '@google/genai';
import { buildInternalizedOperatingInstruction } from '../src/lib/wuxingInternalization';

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

const app = express();

app.use(express.json({ limit: '60mb' }));

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY on the server.');
  }
  return new GoogleGenAI({ apiKey });
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

    const ai = getAiClient();
    const contents = await buildContents(messages);
    const tools = webSearchEnabled ? [{ googleSearch: {} }] : undefined;

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const stream = await ai.models.generateContentStream({
      model,
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
    const { baseInstruction, systemInstruction, omegaPrompt, content, diagnosis } = req.body as {
      baseInstruction: string;
      systemInstruction: string;
      omegaPrompt: string;
      content: string;
      diagnosis: Parameters<typeof buildInternalizedOperatingInstruction>[0]['diagnosis'];
    };

    const instruction = buildInternalizedOperatingInstruction({
      baseInstruction,
      systemInstruction,
      omegaPrompt,
      content,
      diagnosis,
    });

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
