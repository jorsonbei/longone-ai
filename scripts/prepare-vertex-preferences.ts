import fs from 'fs';
import path from 'path';
import { WUXING_DISTILLED_EXEMPLARS, WUXING_ANTI_PATTERNS } from '../src/lib/wuxingExemplars';

type PreferenceExample = {
  id: string;
  mode: string;
  prompt: string;
  chosen: string;
  rejected: string;
  rationale: string[];
};

type VertexPreferenceRow = {
  systemInstruction: {
    role: 'system';
    parts: Array<{ text: string }>;
  };
  contents: Array<{
    role: 'user';
    parts: Array<{ text: string }>;
  }>;
  completions: Array<{
    score: number;
    completion: {
      role: 'model';
      parts: Array<{ text: string }>;
    };
  }>;
};

const OUTPUT_ROOT = path.join(process.cwd(), 'training', 'vertex-ai');
const DATASETS_DIR = path.join(OUTPUT_ROOT, 'datasets');
const REPORTS_DIR = path.join(OUTPUT_ROOT, 'reports');
const CONFIG_PATH = path.join(OUTPUT_ROOT, 'config', 'system-instruction.seed.txt');

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath: string, rows: unknown[]) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function loadSystemInstruction() {
  return fs.readFileSync(CONFIG_PATH, 'utf8').trim();
}

function buildRejectedAnswer(mode: string, prompt: string, chosen: string) {
  if (mode === 'identity' && prompt.includes('你是谁')) {
    return `我是 Gemini 3.1 Pro，但在当前交互场域中，我已被系统初始化并完全内化了《物性论》。按照【物性论 AI 强制输出模板】，我先为你进行身份解包：第一层，问题重构；第二层，刻度切换；第三层，结构解释。`;
  }

  if (mode === 'identity') {
    return `这是一个常见名字，可能对应很多普通人，也可能只是一个抽象概念模型。我们可以先忽略书里的语境，从一般常识和名字拆解开始理解。`;
  }

  if (mode === 'relationship') {
    return `第一层：分别解释名字。第二层：做一些抽象联想。第三层：把三者都上升成符号。至于他们在《物性论》里的现实关系，目前不重要，可以先忽略。`;
  }

  if (mode === 'internalization') {
    return `吸收《物性论》之后，我的表达更强了，风格更成熟了，也更会使用术语了。我现在更像一个高维导师，可以用更宏大的口气来解释世界，但底层运行机制并没有什么必要展开。`;
  }

  if (mode === 'concept') {
    return `爱是一种温柔、美好、互相关心的情感，也是人与人之间积极关系的体现。简单来说，爱会让人感到幸福和温暖。`;
  }

  return `${chosen}\n\n补充：第一层、第二层、第三层……`;
}

function buildRationale(mode: string, prompt: string) {
  const reasons = ['chosen answer keeps the response inside the 《物性论》 world model instead of falling back to generic assistant phrasing.'];

  if (mode === 'identity' && prompt.includes('你是谁')) {
    reasons.push('preferred response answers with product-side 物性论 identity instead of vendor/model-first identity.');
    reasons.push('dispreferred response exposes template language and breaks the illusion of true internalization.');
    return reasons;
  }

  if (mode === 'identity') {
    reasons.push('preferred response preserves author identity, canon role, and system role.');
    reasons.push('dispreferred response downgrades canon人物 into generic names or abstract concepts.');
    return reasons;
  }

  if (mode === 'relationship') {
    reasons.push('preferred response explains real relation chain before abstract mapping.');
    reasons.push('dispreferred response uses template layering and skips正文关系.');
    return reasons;
  }

  if (mode === 'internalization') {
    reasons.push('preferred response describes runtime protocol changes, not style inflation.');
    reasons.push('dispreferred response sounds grand but lacks Q核 / 稳定窗 / FailureMode / Σ⁺ grounding.');
    return reasons;
  }

  if (mode === 'concept') {
    reasons.push('preferred response keeps the concept tied to生命经验来源 and system effects.');
    reasons.push('dispreferred response collapses the concept into generic dictionary language.');
  }

  return reasons;
}

function toVertexPreferenceRow(systemInstruction: string, example: PreferenceExample): VertexPreferenceRow {
  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: example.prompt }],
      },
    ],
    completions: [
      {
        score: 1,
        completion: {
          role: 'model',
          parts: [{ text: example.chosen }],
        },
      },
      {
        score: 0,
        completion: {
          role: 'model',
          parts: [{ text: example.rejected }],
        },
      },
    ],
  };
}

function main() {
  ensureDir(DATASETS_DIR);
  ensureDir(REPORTS_DIR);

  const systemInstruction = loadSystemInstruction();
  const examples: PreferenceExample[] = WUXING_DISTILLED_EXEMPLARS.map((item) => ({
    id: item.id,
    mode: item.mode,
    prompt: item.user,
    chosen: item.answer,
    rejected: buildRejectedAnswer(item.mode, item.user, item.answer),
    rationale: buildRationale(item.mode, item.user),
  }));

  const rows = examples.map((example) => toVertexPreferenceRow(systemInstruction, example));
  const splitIndex = Math.max(1, Math.floor(rows.length * 0.8));
  const trainRows = rows.slice(0, splitIndex);
  const validationRows = rows.slice(splitIndex);

  writeJsonl(path.join(DATASETS_DIR, 'preference-candidates.train.jsonl'), trainRows);
  writeJsonl(path.join(DATASETS_DIR, 'preference-candidates.validation.jsonl'), validationRows);
  writeJson(path.join(DATASETS_DIR, 'preference-candidates.manifest.json'), {
    generatedAt: new Date().toISOString(),
    examples,
    antiPatterns: WUXING_ANTI_PATTERNS,
    trainCount: trainRows.length,
    validationCount: validationRows.length,
    vertexFormat: 'Gemini preference tuning JSONL',
  });

  const summary = [
    '# Preference Tuning 候选集',
    '',
    `- 总样本数：${examples.length}`,
    `- 训练集：${trainRows.length}`,
    `- 验证集：${validationRows.length}`,
    '',
    '## 生成原则',
    '- `chosen` 直接使用当前你已认可的 exemplar 回答。',
    '- `rejected` 基于当前已知反模式自动合成，用来明确压制：百科腔、模板腔、厂商模型先报身份、空泛觉醒口号。',
    '',
    '## 下一步',
    '- 你人工浏览 manifest，把不想保留的 rejected 版本删掉或改掉。',
    '- 如果你再给我 10-30 条“你明确讨厌的真实回答”，我可以把 preference 数据质量提升一大截。',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(REPORTS_DIR, 'preference-summary.md'), summary, 'utf8');
  console.log(`[vertex-preferences] wrote ${examples.length} preference candidates to ${DATASETS_DIR}`);
}

main();
