import { buildContents, geminiGenerateJson, normalizeSystemInstruction, streamGeminiToNdjson } from '../functions/_lib/gemini';

type Env = {
  ASSETS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  GEMINI_API_KEY?: string;
  NODE_ENV?: string;
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, { status: 405 });
  }

  try {
    if (url.pathname === '/api/gemini/chat/stream') {
      const { messages, model, systemInstruction, webSearchEnabled = true } = await request.json();
      const contents = await buildContents(messages || []);

      return streamGeminiToNdjson({ env }, model, {
        contents,
        systemInstruction: normalizeSystemInstruction(systemInstruction),
        generationConfig: {
          temperature: 0.7,
        },
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
