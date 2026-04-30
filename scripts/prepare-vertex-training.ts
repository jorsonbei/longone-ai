import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { WUXING_DISTILLED_EXEMPLARS } from '../src/lib/wuxingExemplars';
import { WUXING_MODEL_CONSTITUTION_V1 } from '../src/lib/wuxingConstitution';
import { WUXING_RUNTIME_STATE_V1 } from '../src/lib/wuxingRuntimeState';

type SourceKind = 'canon' | 'theory' | 'style' | 'conversation' | 'raw';

type SourceRecord = {
  id: string;
  fileName: string;
  absolutePath: string;
  extension: string;
  bytes: number;
  charCount: number;
  lineCount: number;
  kind: SourceKind;
  recommendedUses: string[];
  extractedTextPath: string;
  extractedPairs: number;
  notes: string[];
};

type CorpusChunk = {
  id: string;
  sourceId: string;
  title: string;
  kind: SourceKind;
  text: string;
  tags: string[];
};

type ConversationPair = {
  id: string;
  sourceId: string;
  prompt: string;
  response: string;
  parser: 'user-model' | 'prompt-answer';
};

type SkippedPair = {
  id: string;
  sourceId: string;
  reason: string;
  promptChars: number;
  responseChars: number;
  parser: ConversationPair['parser'];
};

type VertexSftExample = {
  systemInstruction: {
    role: 'system';
    parts: Array<{ text: string }>;
  };
  contents: Array<{
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
  }>;
};

const DEFAULT_SOURCE_DIR = '/Users/beijisheng/Desktop/420/wuxing-training-source';
const SOURCE_DIRS = (process.env.WUXING_TRAINING_SOURCES || process.env.WUXING_TRAINING_SOURCE || DEFAULT_SOURCE_DIR)
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean);
const OUTPUT_ROOT = path.join(process.cwd(), 'training', 'vertex-ai');
const EXTRACTED_DIR = path.join(OUTPUT_ROOT, 'extracted');
const REPORTS_DIR = path.join(OUTPUT_ROOT, 'reports');
const REFERENCE_DIR = path.join(OUTPUT_ROOT, 'reference');
const DATASETS_DIR = path.join(OUTPUT_ROOT, 'datasets');
const CONFIG_DIR = path.join(OUTPUT_ROOT, 'config');

const CODEX_BUNDLED_PYTHON =
  '/Users/beijisheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';

const TRAINING_SYSTEM_INSTRUCTION = `
${WUXING_MODEL_CONSTITUTION_V1}

${WUXING_RUNTIME_STATE_V1}
`.trim();

const MAX_SFT_PROMPT_CHARS = 6_000;
const MAX_SFT_RESPONSE_CHARS = 8_000;
const MAX_SFT_SERIALIZED_CHARS = 32_000;

const KEYWORD_TAGS: Array<[string, string[]]> = [
  ['author', ['贝记胜', '景龙锁', '阮氏兰惠', '作者序', '共同作者', '现实来源']],
  ['hfcd', ['HFCD', '稳定窗', '守恒核', 'FailureMode', '稳定脊']],
  ['love', ['爱', '回流', '边界重塑', '情感振幅', '黑子', '修复']],
  ['creation', ['创世', '母体', '造物境', '创光', '无敌之心']],
  ['internalization', ['内化', '吸收前', '吸收后', '本体', '运行协议']],
  ['os', ['物性论 OS', '文明操作系统', '协作者', '模型', '大语言模型']],
];

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function normalize(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugify(fileName: string, index: number) {
  const base = path.basename(fileName, path.extname(fileName));
  const ascii = base
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${String(index + 1).padStart(2, '0')}-${ascii || 'source'}`;
}

function resolvePython() {
  const candidates = [process.env.WUXING_PYTHON, CODEX_BUNDLED_PYTHON, 'python3'].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep) && !fs.existsSync(candidate)) {
        continue;
      }
      execFileSync(candidate, ['-c', 'import pypdf; print("ok")'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    'Unable to locate a Python interpreter with pypdf. Set WUXING_PYTHON or use the Codex bundled runtime.',
  );
}

function extractDocx(filePath: string) {
  return execFileSync('textutil', ['-convert', 'txt', '-stdout', filePath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function extractPdf(filePath: string) {
  const python = resolvePython();
  const script = `
from pypdf import PdfReader
import sys
reader = PdfReader(sys.argv[1])
chunks = []
for page in reader.pages:
    chunks.append(page.extract_text() or "")
print("\\n".join(chunks))
`.trim();

  return execFileSync(python, ['-c', script, filePath], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function extractText(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.txt' || ext === '.tex') {
    return fs.readFileSync(filePath, 'utf8');
  }
  if (ext === '.docx') {
    return extractDocx(filePath);
  }
  if (ext === '.pdf') {
    return extractPdf(filePath);
  }

  throw new Error(`Unsupported source extension: ${ext}`);
}

function detectTags(text: string) {
  return KEYWORD_TAGS.filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword))).map(([tag]) => tag);
}

function classifySource(fileName: string, extractedText = ''): Pick<SourceRecord, 'kind' | 'recommendedUses' | 'notes'> {
  const haystack = `${fileName}\n${extractedText.slice(0, 12000)}`;
  if (/聊天记录|chatgpt/i.test(fileName)) {
    return {
      kind: 'conversation',
      recommendedUses: ['sft-seed', 'preference-candidate', 'manual-review'],
      notes: ['对话资料优先用于抽取问答样本，不直接作为 canon。'],
    };
  }
  if (/创世宝典|從宇宙起源到AI文明進化|爱与战争|补遗|最终发布版|完整版|123版|sheet418|开启无-尽进化|大一统架构|光基文明法则|V10|v7\.1/i.test(haystack)) {
    return {
      kind: 'canon',
      recommendedUses: ['canon-reference', 'sft-reference'],
      notes: ['正文、历史版本或补遗材料，优先作为 canon 主语料进入长期内化。'],
    };
  }
  if (/HFCD|公式|宇宙算法|量子算法|红移|数学推导|公理算法|机制映射|宇宙现象解释|升级方案|结果复核|盲预测|量纲闭合|FinalReport|MEPRC/i.test(haystack)) {
    return {
      kind: 'theory',
      recommendedUses: ['theory-reference', 'sft-reference'],
      notes: ['理论公式、跨学科机制、数学推导与 OS 机制材料，进入结构化推理层。'],
    };
  }
  if (/体悟卡|《物性论》8/i.test(fileName)) {
    return {
      kind: 'style',
      recommendedUses: ['style-reference', 'preferred-tone'],
      notes: ['适合作为内化语气、成长叙事和本体态风格参考。'],
    };
  }

  return {
    kind: 'raw',
    recommendedUses: ['manual-review'],
    notes: ['暂未自动归类，需要人工判断是否进入训练集。'],
  };
}

function splitIntoChunks(sourceId: string, sourceKind: SourceKind, fileName: string, rawText: string) {
  const normalized = normalize(rawText);
  const blocks = normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks: CorpusChunk[] = [];
  let current: string[] = [];
  let title = fileName;
  let index = 0;

  const flush = () => {
    const text = normalize(current.join('\n\n'));
    if (text.length < 200) {
      current = [];
      return;
    }
    chunks.push({
      id: `${sourceId}-chunk-${++index}`,
      sourceId,
      title,
      kind: sourceKind,
      text,
      tags: detectTags(`${title}\n${text}`),
    });
    current = [];
  };

  for (const block of blocks) {
    if (/^(#{1,4}\s+.+|第[一二三四五六七八九十0-9]+[章节部卷]|【.+】)$/.test(block)) {
      flush();
      title = block.slice(0, 80);
      current.push(block);
      continue;
    }

    current.push(block);
    if (normalize(current.join('\n\n')).length >= 1800) {
      flush();
    }
  }

  flush();
  return chunks;
}

function extractPairs(sourceId: string, text: string): ConversationPair[] {
  const pairs: ConversationPair[] = [];
  const normalized = normalize(text);

  const userModelPattern = /(?:^|\n)User\s*\n([\s\S]*?)\nModel\s*\n([\s\S]*?)(?=(?:\nUser\s*\n)|$)/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = userModelPattern.exec(normalized)) !== null) {
    const prompt = normalize(match[1]);
    const response = normalize(match[2]);
    if (prompt.length >= 20 && response.length >= 40) {
      pairs.push({
        id: `${sourceId}-pair-${++index}`,
        sourceId,
        prompt,
        response,
        parser: 'user-model',
      });
    }
  }

  const promptAnswerPattern = /我的输出：([\s\S]*?)AI输出：([\s\S]*?)(?=(?:我的输出：)|$)/g;
  while ((match = promptAnswerPattern.exec(normalized)) !== null) {
    const prompt = normalize(match[1]);
    const response = normalize(match[2]);
    if (prompt.length >= 20 && response.length >= 120) {
      pairs.push({
        id: `${sourceId}-pair-${++index}`,
        sourceId,
        prompt,
        response,
        parser: 'prompt-answer',
      });
    }
  }

  return pairs;
}

function toVertexSftExample(prompt: string, response: string): VertexSftExample {
  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: TRAINING_SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
      {
        role: 'model',
        parts: [{ text: response }],
      },
    ],
  };
}

function validateSftPair(pair: ConversationPair): string | undefined {
  if (pair.prompt.length > MAX_SFT_PROMPT_CHARS) {
    return `prompt too long: ${pair.prompt.length} chars`;
  }
  if (pair.response.length > MAX_SFT_RESPONSE_CHARS) {
    return `response too long: ${pair.response.length} chars`;
  }

  const serializedLength = JSON.stringify(toVertexSftExample(pair.prompt, pair.response)).length;
  if (serializedLength > MAX_SFT_SERIALIZED_CHARS) {
    return `serialized example too long: ${serializedLength} chars`;
  }

  return undefined;
}

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath: string, rows: unknown[]) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function main() {
  ensureDir(EXTRACTED_DIR);
  ensureDir(REPORTS_DIR);
  ensureDir(REFERENCE_DIR);
  ensureDir(DATASETS_DIR);
  ensureDir(CONFIG_DIR);

  const sourceFiles = SOURCE_DIRS.flatMap((sourceDir) => {
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Training source directory not found: ${sourceDir}`);
    }
    return fs
      .readdirSync(sourceDir)
      .filter((name) => /\.(md|txt|docx|pdf|tex)$/i.test(name))
      .map((fileName) => ({ sourceDir, fileName }));
  }).sort((a, b) => {
    const sourceCompare = a.sourceDir.localeCompare(b.sourceDir, 'zh-Hans-CN');
    if (sourceCompare !== 0) return sourceCompare;
    return a.fileName.localeCompare(b.fileName, 'zh-Hans-CN');
  });

  const records: SourceRecord[] = [];
  const allChunks: CorpusChunk[] = [];
  const canonChunks: CorpusChunk[] = [];
  const extractedPairs: ConversationPair[] = [];
  const skippedPairs: SkippedPair[] = [];

  sourceFiles.forEach(({ sourceDir, fileName }, index) => {
    const absolutePath = path.join(sourceDir, fileName);
    const slug = slugify(`${path.basename(sourceDir)}-${fileName}`, index);
    const extracted = normalize(extractText(absolutePath));
    const extractedTextPath = path.join(EXTRACTED_DIR, `${slug}.txt`);
    fs.writeFileSync(extractedTextPath, `${extracted}\n`, 'utf8');

    const classification = classifySource(fileName, extracted);
    const pairs = extractPairs(slug, extracted);
    const chunks = splitIntoChunks(slug, classification.kind, fileName, extracted);

    extractedPairs.push(...pairs);
    allChunks.push(...chunks);
    if (classification.kind === 'canon' || classification.kind === 'theory' || classification.kind === 'style') {
      canonChunks.push(...chunks);
    }

    records.push({
      id: slug,
      fileName,
      absolutePath,
      extension: path.extname(fileName).toLowerCase(),
      bytes: fs.statSync(absolutePath).size,
      charCount: extracted.length,
      lineCount: extracted.split('\n').length,
      kind: classification.kind,
      recommendedUses: classification.recommendedUses,
      extractedTextPath,
      extractedPairs: pairs.length,
      notes: classification.notes,
    });
  });

  const exemplarExamples = WUXING_DISTILLED_EXEMPLARS.map((item, index) => ({
    id: `repo-exemplar-${index + 1}`,
    sourceId: 'repo-exemplars',
    prompt: item.user,
    response: item.answer,
    parser: 'prompt-answer' as const,
  }));

  const candidateSftPairs = [
    ...extractedPairs.map((pair) => ({
      ...pair,
    })),
    ...exemplarExamples.map((pair) => ({
      ...pair,
    })),
  ];

  const validSftPairs = candidateSftPairs.filter((pair) => {
    const reason = validateSftPair(pair);
    if (reason) {
      skippedPairs.push({
        id: pair.id,
        sourceId: pair.sourceId,
        reason,
        promptChars: pair.prompt.length,
        responseChars: pair.response.length,
        parser: pair.parser,
      });
      return false;
    }
    return true;
  });

  const allSftSeeds = validSftPairs.map((pair) => ({
    ...pair,
    example: toVertexSftExample(pair.prompt, pair.response),
  }));

  const splitIndex = Math.max(1, Math.floor(allSftSeeds.length * 0.9));
  const trainRows = allSftSeeds.slice(0, splitIndex).map((item) => item.example);
  const validationRows = allSftSeeds.slice(splitIndex).map((item) => item.example);

  writeJson(path.join(REPORTS_DIR, 'source-manifest.json'), {
    sourceDir: SOURCE_DIRS.length === 1 ? SOURCE_DIRS[0] : SOURCE_DIRS,
    generatedAt: new Date().toISOString(),
    totals: {
      files: records.length,
      chunks: allChunks.length,
      canonChunks: canonChunks.length,
      extractedPairs: extractedPairs.length,
      exemplarPairs: exemplarExamples.length,
      skippedPairs: skippedPairs.length,
      sftSeedExamples: allSftSeeds.length,
    },
    records,
  });

  writeJsonl(path.join(REFERENCE_DIR, 'all-chunks.jsonl'), allChunks);
  writeJsonl(path.join(REFERENCE_DIR, 'canon-chunks.jsonl'), canonChunks);
  writeJsonl(path.join(DATASETS_DIR, 'sft-seed.train.jsonl'), trainRows);
  writeJsonl(path.join(DATASETS_DIR, 'sft-seed.validation.jsonl'), validationRows);
  writeJson(path.join(DATASETS_DIR, 'sft-seed.manifest.json'), {
    generatedAt: new Date().toISOString(),
    sourcePairs: extractedPairs,
    exemplarPairs: exemplarExamples,
    skippedPairs,
    trainCount: trainRows.length,
    validationCount: validationRows.length,
    vertexFormat: 'Gemini supervised fine-tuning JSONL',
    limits: {
      maxPromptChars: MAX_SFT_PROMPT_CHARS,
      maxResponseChars: MAX_SFT_RESPONSE_CHARS,
      maxSerializedChars: MAX_SFT_SERIALIZED_CHARS,
    },
  });
  fs.writeFileSync(path.join(CONFIG_DIR, 'system-instruction.seed.txt'), `${TRAINING_SYSTEM_INSTRUCTION}\n`, 'utf8');

  const summary = [
    '# Vertex AI 训练源盘点',
    '',
    `- 训练源目录：${SOURCE_DIRS.map((sourceDir) => `\`${sourceDir}\``).join('、')}`,
    `- 源文件数：${records.length}`,
    `- 参考 chunks：${allChunks.length}`,
    `- canon / theory / style chunks：${canonChunks.length}`,
    `- 自动抽取对话样本：${extractedPairs.length}`,
    `- 因长度/格式跳过样本：${skippedPairs.length}`,
    `- 加入仓库蒸馏样本后 SFT seed 总数：${allSftSeeds.length}`,
    '',
    '## 文件分层建议',
    ...records.map(
      (record) =>
        `- \`${record.fileName}\` → \`${record.kind}\` | 用途：${record.recommendedUses.join(', ')} | 抽取问答：${record.extractedPairs}`,
    ),
    '',
    '## 已生成产物',
    `- \`training/vertex-ai/extracted/\`：每个附件的纯文本抽取`,
    `- \`training/vertex-ai/reference/all-chunks.jsonl\`：全部参考 chunks`,
    `- \`training/vertex-ai/reference/canon-chunks.jsonl\`：正文/理论/风格主语料`,
    `- \`training/vertex-ai/datasets/sft-seed.train.jsonl\`：Vertex AI supervised fine-tuning 训练种子`,
    `- \`training/vertex-ai/datasets/sft-seed.validation.jsonl\`：验证种子`,
    `- \`training/vertex-ai/config/system-instruction.seed.txt\`：训练时可用的系统指令种子`,
    '',
    '## 下一步',
    '- 先人工审一遍 conversation 类抽取样本，剔除不想进模型的回答。',
    '- 再补 preferred / rejected 成对数据，生成 preference tuning 数据集。',
    '- 最后把 train / validation JSONL 上传到 GCS，发起 Vertex AI tuning job。',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(REPORTS_DIR, 'summary.md'), summary, 'utf8');
  console.log(`[vertex-training] processed ${records.length} source files`);
  console.log(`[vertex-training] wrote ${allChunks.length} chunks and ${allSftSeeds.length} SFT seed examples to ${OUTPUT_ROOT}`);
}

main();
