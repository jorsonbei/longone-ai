import { Message, Citation, WuxingDiagnosisSummary } from "../types";
import { THING_NATURE_MANIFESTO } from "../lib/thingNatureManifesto";

export const MODELS = {
  FLASH: "gemini-3-flash-preview",
  PRO: "gemini-3.1-pro-preview",
};

const FALLBACK_MODELS: Record<string, string | undefined> = {
  [MODELS.FLASH]: 'gemini-2.5-flash',
  [MODELS.PRO]: 'gemini-2.5-pro',
};

export type StreamEvent = {
  type: 'text';
  text: string;
} | {
  type: 'metadata';
  citations: Citation[];
} | {
  type: 'error';
  message: string;
};

export async function buildInternalizedSystemInstruction(input: {
  baseInstruction: string;
  systemInstruction: string;
  omegaPrompt: string;
  content: string;
  diagnosis: WuxingDiagnosisSummary;
}) {
  const response = await postJson<{ instruction: string }>('/api/wuxing/instruction', input);
  return response.instruction;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }

  return response.json();
}

const STREAM_TIMEOUT_MS = 90_000;

function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    controller.abort(parentSignal?.reason || new DOMException('Request aborted.', 'AbortError'));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onAbort();
    } else {
      parentSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  if (!controller.signal.aborted) {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`Gemini request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onAbort);
    }
  };

  return {
    signal: controller.signal,
    cleanup,
  };
}

async function requestStream(
  messages: Message[],
  model: string,
  systemInstruction?: string,
  signal?: AbortSignal,
  webSearchEnabled: boolean = true,
) {
  const { signal: requestSignal, cleanup } = createTimeoutSignal(STREAM_TIMEOUT_MS, signal);

  try {
    const response = await fetch('/api/gemini/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        model,
        systemInstruction,
        webSearchEnabled,
      }),
      signal: requestSignal,
    });

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Stream request failed with status ${response.status}`);
    }

    return response;
  } finally {
    cleanup();
  }
}

export async function* streamChat(
  messages: Message[],
  model: string = MODELS.FLASH,
  systemInstruction?: string,
  signal?: AbortSignal,
  webSearchEnabled: boolean = true
): AsyncGenerator<StreamEvent, void, unknown> {
  let response: Response;

  try {
    response = await requestStream(messages, model, systemInstruction, signal, webSearchEnabled);
  } catch (error) {
    const fallbackModel = FALLBACK_MODELS[model];
    if (fallbackModel) {
      console.warn(`Primary model ${model} failed, retrying with ${fallbackModel}.`, error);
      response = await requestStream(messages, fallbackModel, systemInstruction, signal, webSearchEnabled);
    } else {
      throw error;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      yield JSON.parse(line) as StreamEvent;
    }
  }

  if (buffer.trim()) {
    yield JSON.parse(buffer) as StreamEvent;
  }
}

export async function evaluateThingNature(
  userQuery: string,
  botResponse: string,
  model: string = MODELS.FLASH
): Promise<any> {
  const evaluatePrompt = `你现在是《物性论》高阶审计系统（Dragon API 守护引擎）。
${THING_NATURE_MANIFESTO}

根据上述底层标准，请审视以下对话。
用户的输入（Query）：
"""
${userQuery}
"""

AI的输出（Answer）：
"""
${botResponse}
"""

请按照以下结构返回 JSON，不要包含任何额外的 markdown 标记或文本：
{
  "phi": {
    "L": 8, // 逻辑性 0-10
    "H": 8, // 人性 0-10
    "R": 8, // 稳健性 0-10
    "N": 8  // 新颖度 0-10
  },
  "sigma_plus": 5, // 正性账本 -10 到 10
  "b_sigma": 0, // 黑子密度 0 到 10 (越高越危险)
  "pi_d": "High", // 整合深度 "Low", "Medium", "High"
  "action": "PASS" // "PASS", "AUGMENT", 或 "REJECT" (如果检测到大幅加剧Bσ必须REJECT)
}`;

  try {
    const response = await postJson<{ data: any }>('/api/gemini/evaluate', {
      prompt: evaluatePrompt,
      model,
    });
    return response.data;
  } catch (err) {
    console.error('Failed to parse ThingNature evaluation:', err);
    return null;
  }
}

export async function extractLightLog(
  conversationContext: string,
  model: string = MODELS.FLASH
): Promise<string> {
  const prompt = `你现在是《物性论》系统中的 Π 日志生成器。
${THING_NATURE_MANIFESTO}

请通读以下对话历史（从最新的视角），基于上述物性论底层标准，找出用户在结构（Π）、正性势能（Σ⁺）和黑子净化（Bσ排毒）上的实质性演化。
请用一句话提取本次的“光之日志（Light Log）”。
要求：结构清晰，像一行代码 commit 一样。

对话记录：
${conversationContext}

格式示例：
"【光之日志】今天在长 Ω 下拆解了关于职业的自我恐惧，减少了 Bσ 沉积，明确了核心物性优势 φ（强执行、弱情绪）。"

现在请输出你生成的【光之日志】：
`;
  try {
    const response = await postJson<{ text: string }>('/api/gemini/light-log', {
      prompt,
      model,
    });
    return response.text || "未提取到明显的光性变化。";
  } catch (err) {
    console.error('Failed to extract Light Log:', err);
    return "提取日志失败，请稍后再试。";
  }
}
