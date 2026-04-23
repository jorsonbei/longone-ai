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
const VERTEX_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

let vertexTokenCache: { token: string; expiresAt: number } | undefined;

export function normalizeSystemInstruction(input?: unknown) {
  if (!input || typeof input !== 'string' || !input.trim()) {
    return undefined;
  }

  return {
    parts: [{ text: input }],
  };
}

function getApiKey(context: { env?: Record<string, unknown> }) {
  const apiKey = context.env?.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('Missing GEMINI_API_KEY in Cloudflare Worker environment variables.');
  }
  return apiKey;
}

function base64UrlEncode(input: string | ArrayBuffer) {
  let binary = '';
  if (typeof input === 'string') {
    binary = input;
  } else {
    const bytes = new Uint8Array(input);
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8ToArrayBuffer(input: string) {
  return new TextEncoder().encode(input).buffer;
}

function pemToArrayBuffer(pem: string) {
  const normalized = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function getServiceAccount(context: { env?: Record<string, unknown> }) {
  const encoded = context.env?.VERTEX_SERVICE_ACCOUNT_JSON_BASE64;
  const raw =
    encoded && typeof encoded === 'string'
      ? atob(encoded)
      : context.env?.VERTEX_SERVICE_ACCOUNT_JSON;
  if (!raw || typeof raw !== 'string') {
    throw new Error('Missing VERTEX_SERVICE_ACCOUNT_JSON_BASE64 in Cloudflare Worker environment variables.');
  }

  const serviceAccount = JSON.parse(raw) as {
    client_email?: string;
    private_key?: string;
  };
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('VERTEX_SERVICE_ACCOUNT_JSON must contain client_email and private_key.');
  }
  return serviceAccount;
}

async function signJwt(privateKeyPem: string, signingInput: string) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8ToArrayBuffer(signingInput));
  return base64UrlEncode(signature);
}

async function getVertexAccessToken(context: { env?: Record<string, unknown> }) {
  const now = Math.floor(Date.now() / 1000);
  if (vertexTokenCache && vertexTokenCache.expiresAt - 60 > now) {
    return vertexTokenCache.token;
  }

  const serviceAccount = getServiceAccount(context);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: VERTEX_SCOPE,
      aud: VERTEX_TOKEN_URL,
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const signature = await signJwt(serviceAccount.private_key!, signingInput);
  const assertion = `${signingInput}.${signature}`;

  const response = await fetch(VERTEX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error((await response.text()) || `Vertex token request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error('Vertex token response did not include access_token.');
  }

  vertexTokenCache = {
    token: payload.access_token,
    expiresAt: now + (payload.expires_in || 3600),
  };
  return vertexTokenCache.token;
}

function getVertexEndpoint(context: { env?: Record<string, unknown> }, model?: string) {
  const endpoint = context.env?.VERTEX_TUNED_MODEL || model;
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('Missing VERTEX_TUNED_MODEL for Vertex AI request.');
  }
  if (!endpoint.includes('/endpoints/')) {
    throw new Error('VERTEX_TUNED_MODEL must be a full Vertex endpoint resource path.');
  }
  return endpoint;
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

export async function vertexGenerateJson(
  context: { env?: Record<string, unknown> },
  model: string,
  body: Record<string, unknown>,
) {
  const token = await getVertexAccessToken(context);
  const endpoint = getVertexEndpoint(context, model);
  const region = endpoint.match(/\/locations\/([^/]+)\//)?.[1] || 'us-central1';
  const response = await fetch(`https://${region}-aiplatform.googleapis.com/v1/${endpoint}:generateContent`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Vertex request failed with status ${response.status}`);
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
  const payload = (await geminiGenerateJson(context, model, body)) as GeminiChunk;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const text = extractText(payload);
      if (text) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'text', text })}\n`));
      }

      const citations = extractCitations(payload, new Set<string>());
      if (citations.length > 0) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'metadata', citations })}\n`));
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

export async function streamVertexToNdjson(
  context: { env?: Record<string, unknown> },
  model: string,
  body: Record<string, unknown>,
) {
  const payload = (await vertexGenerateJson(context, model, body)) as GeminiChunk;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const text = extractText(payload);
      if (text) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'text', text })}\n`));
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
