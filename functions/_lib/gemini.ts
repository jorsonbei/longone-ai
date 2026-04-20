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

type Citation = {
  uri: string;
  title: string;
};

type GeminiChunk = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
};

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function getApiKey(context: { env?: Record<string, unknown> }) {
  const apiKey = context.env?.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('Missing GEMINI_API_KEY in Cloudflare Pages environment variables.');
  }
  return apiKey;
}

async function urlToBase64(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;

    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  } catch (error) {
    console.error('Failed to recover attachment data from URL:', error);
    return undefined;
  }
}

export async function buildContents(messages: Message[]) {
  return Promise.all(
    messages.map(async (message) => {
      const parts: Array<Record<string, unknown>> = [];

      for (const attachment of message.attachments || []) {
        const data = attachment.data || (attachment.url ? await urlToBase64(attachment.url) : undefined);
        if (!data) continue;

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
    }),
  );
}

export async function geminiGenerateJson(
  context: { env?: Record<string, unknown> },
  model: string,
  body: Record<string, unknown>,
) {
  const apiKey = getApiKey(context);
  const response = await fetch(`${GEMINI_BASE_URL}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Gemini request failed with status ${response.status}`);
  }

  return response.json();
}

function extractText(payload: GeminiChunk) {
  const parts = payload.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part.text || '')
    .join('');
}

function extractCitations(payload: GeminiChunk, seen: Set<string>) {
  const citations: Citation[] = [];
  const groundingChunks = payload.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  for (const chunk of groundingChunks) {
    const uri = chunk.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    citations.push({
      uri,
      title: chunk.web?.title || 'Web Page',
    });
  }

  return citations;
}

export async function streamGeminiToNdjson(
  context: { env?: Record<string, unknown> },
  model: string,
  body: Record<string, unknown>,
) {
  const apiKey = getApiKey(context);
  const upstream = await fetch(`${GEMINI_BASE_URL}/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    throw new Error(text || `Gemini stream failed with status ${upstream.status}`);
  }

  const citationsSeen = new Set<string>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = '';

      const flushEvent = (eventText: string) => {
        const dataLines = eventText
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim();

        if (!dataLines || dataLines === '[DONE]') return;

        let parsed: GeminiChunk;
        try {
          parsed = JSON.parse(dataLines) as GeminiChunk;
        } catch {
          return;
        }

        const text = extractText(parsed);
        if (text) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'text', text })}\n`));
        }

        const citations = extractCitations(parsed, citationsSeen);
        if (citations.length > 0) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'metadata', citations })}\n`));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
          const eventText = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          flushEvent(eventText);
          separatorIndex = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim()) {
        flushEvent(buffer);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
