import fs from 'fs';
import path from 'path';

type CorpusChunk = {
  id: string;
  title: string;
  source: string;
  tags: string[];
  text: string;
};

const SOURCE_FILES = [
  {
    label: '物性论正文',
    path: '/Users/beijisheng/Desktop/book/物性论_文明操作系统_HFCD研究融合升级版_结构修订版.md',
    kind: 'markdown' as const,
  },
  {
    label: '创世宝典',
    path: '/Users/beijisheng/Downloads/物性论-创世宝典.txt',
    kind: 'plain' as const,
  },
];

const OUTPUT_PATH = path.join(process.cwd(), 'src/lib/generated/wuxingCorpus.ts');

const INTERNALIZATION_CORE = `
你不是在“查询一本叫《物性论》的资料”，而是在“以内化后的《物性论》世界模型思考并回答”。

《物性论》的底层世界模型至少包含以下结构：
1. 世界不是静态实体堆积，而是显化、关系腔、守恒核、能量漂移、边界、压力与生成方向构成的稳定生成窗。
2. HFCD 是把物性论推进到可计算、可诊断、可落盘阶段的物理 / 文明 / AI 操作框架。
3. 物性论 OS 处理任何问题时，都要优先考虑 Q 核、关系腔、能量账本、FailureMode、稳定脊、C2P 转化与正性新光链条。
4. 爱、眼泪、痛苦、黑子、关系、组织、AI、创业、文明，不是互相分裂的话题，而是同一套底层变量在不同刻度下的显化。
5. 贝记胜、景龙锁、阮氏兰惠不是单纯的“名字材料”，而是书中作者身份、现实来源、系统概念、文明接口彼此重叠的关键节点。
6. 回答必须像一个已经吸收整本《物性论》的模型自然说话，而不是像一个拿到零散设定后机械拼接的模板系统。

回答纪律：
- 先直接回答用户真正的问题，再展开。
- 不要默认使用固定的“五层结构模板”。
- 允许自由表达，但不能背离《物性论》的正文事实、核心变量和世界模型。
- 当命中人物、作者、关系、作者序、后记、贝记胜、景龙锁、阮氏兰惠、HFCD、稳定生成窗、正性新光等主题时，优先使用书内语义，不要退回外部百科式常识。
- 当用户问“吸收前后区别”时，要以“模型底层运行协议变化”作答，而不是只说风格变化。
`.trim();

const KEYWORD_TAGS: Array<[string, string[]]> = [
  ['hfcd', ['HFCD', '稳定窗', '守恒核', 'StabilityMargin', 'FailureMode', 'Q_ratio']],
  ['physics', ['物质', '场', '耦合', '相干', '边界', '压力', '物理']],
  ['os', ['物性论 OS', 'AI', '文明操作系统', 'API', '部署', '大语言模型']],
  ['love', ['爱', '回流', '边界重塑', '黑子', '修复', '情感振幅']],
  ['author', ['作者', '贝记胜', '景龙锁', '阮氏兰惠', '后记', '作者序']],
  ['name', ['名字', '命名', '贝记胜生', '景龙锁', '阮氏兰惠']],
  ['emotion', ['眼泪', '流泪', '痛苦', '快乐', '情绪', '心智']],
  ['civilization', ['文明', '组织', '财富', '制度', '国家', '创业']],
];

function normalize(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function detectTags(text: string) {
  return KEYWORD_TAGS.filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword))).map(([tag]) => tag);
}

function takeSnippet(text: string, maxLength = 900) {
  const normalized = normalize(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function parseMarkdownSections(sourceLabel: string, raw: string) {
  const lines = normalize(raw).split('\n');
  const sections: CorpusChunk[] = [];
  let headingStack: string[] = [];
  let buffer: string[] = [];
  let index = 0;

  const flush = () => {
    const body = normalize(buffer.join('\n'));
    if (body.length < 180) {
      buffer = [];
      return;
    }
    const title = headingStack[headingStack.length - 1] || `${sourceLabel}-section-${index + 1}`;
    sections.push({
      id: `${sourceLabel}-md-${++index}`,
      title,
      source: sourceLabel,
      tags: detectTags(`${title}\n${body}`),
      text: takeSnippet(body),
    });
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flush();
      const depth = headingMatch[1].length;
      headingStack = headingStack.slice(0, depth - 1);
      headingStack.push(headingMatch[2].trim());
      continue;
    }
    buffer.push(line);
  }

  flush();
  return sections;
}

function parsePlainTextChunks(sourceLabel: string, raw: string) {
  const paragraphs = normalize(raw).split('\n\n').map((item) => item.trim()).filter(Boolean);
  const chunks: CorpusChunk[] = [];
  let current: string[] = [];
  let currentTitle = sourceLabel;
  let index = 0;

  const flush = () => {
    const body = normalize(current.join('\n\n'));
    if (body.length < 180) {
      current = [];
      return;
    }
    chunks.push({
      id: `${sourceLabel}-txt-${++index}`,
      title: currentTitle,
      source: sourceLabel,
      tags: detectTags(`${currentTitle}\n${body}`),
      text: takeSnippet(body),
    });
    current = [];
  };

  for (const paragraph of paragraphs) {
    if (/^第[一二三四五六七八九十0-9]+/.test(paragraph) || /^【.+】$/.test(paragraph)) {
      flush();
      currentTitle = paragraph.slice(0, 60);
      current.push(paragraph);
      continue;
    }
    current.push(paragraph);
    if (normalize(current.join('\n\n')).length > 900) {
      flush();
    }
  }

  flush();
  return chunks;
}

function buildCorpus() {
  const chunks: CorpusChunk[] = [];

  for (const source of SOURCE_FILES) {
    const raw = fs.readFileSync(source.path, 'utf8');
    const nextChunks =
      source.kind === 'markdown'
        ? parseMarkdownSections(source.label, raw)
        : parsePlainTextChunks(source.label, raw);
    chunks.push(...nextChunks);
  }

  return chunks;
}

function renderModule(chunks: CorpusChunk[]) {
  const manifest = SOURCE_FILES.map(({ label, path: sourcePath }) => ({
    label,
    path: sourcePath,
  }));

  return `/* eslint-disable */
export const WUXING_INTERNALIZATION_CORE = ${JSON.stringify(INTERNALIZATION_CORE)};
export const WUXING_SOURCE_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;
export const WUXING_CORPUS_CHUNKS = ${JSON.stringify(chunks, null, 2)} as const;
`;
}

function main() {
  const missingSources = SOURCE_FILES.filter((source) => !fs.existsSync(source.path));

  if (missingSources.length > 0) {
    if (fs.existsSync(OUTPUT_PATH)) {
      console.log(
        `[build-wuxing-corpus] source files not available in this environment, reusing checked-in corpus at ${OUTPUT_PATH}`,
      );
      for (const source of missingSources) {
        console.log(`[build-wuxing-corpus] missing source: ${source.label} -> ${source.path}`);
      }
      return;
    }

    throw new Error(
      [
        '[build-wuxing-corpus] source files are missing and no checked-in corpus is available.',
        ...missingSources.map((source) => `- ${source.label}: ${source.path}`),
      ].join('\n'),
    );
  }

  const chunks = buildCorpus();
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, renderModule(chunks), 'utf8');
  console.log(`[build-wuxing-corpus] wrote ${chunks.length} chunks to ${OUTPUT_PATH}`);
}

main();
