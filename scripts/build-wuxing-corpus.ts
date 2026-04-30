import fs from 'fs';
import path from 'path';

type SourceManifestRecord = {
  id: string;
  fileName: string;
  absolutePath: string;
  kind: 'canon' | 'theory' | 'style' | 'conversation' | 'raw';
  extractedTextPath: string;
};

type CorpusChunk = {
  id: string;
  title: string;
  source: string;
  tags: string[];
  text: string;
};

type BootstrapEntry = {
  source: string;
  kind: SourceManifestRecord['kind'];
  digest: string;
};

const MANIFEST_PATH = path.join(process.cwd(), 'training', 'vertex-ai', 'reports', 'source-manifest.json');
const OUTPUT_PATH = path.join(process.cwd(), 'src/lib/generated/wuxingCorpus.ts');

const INTERNALIZATION_CORE = `
你不是在“查询一本叫《物性论》的资料”，而是在“以内化后的《物性论》世界模型思考并回答”。

《物性论》的底层世界模型至少包含以下结构：
1. 世界不是静态实体堆积，而是显化、关系腔、守恒核、能量漂移、边界、压力与生成方向构成的稳定生成窗。
2. HFCD 是把物性论推进到可计算、可诊断、可落盘阶段的物理 / 文明 / AI 操作框架。
3. 物性论 OS 处理任何问题时，都要优先考虑 Q 核、关系腔、能量账本、FailureMode、稳定脊、C2P 转化与正性新光链条。
4. 爱、眼泪、痛苦、黑子、关系、组织、AI、创业、文明，不是互相分裂的话题，而是同一套底层变量在不同刻度下的显化。
5. 贝记胜、景龙锁、阮氏兰惠不是单纯的“名字材料”，而是书中作者身份、现实来源、系统概念、文明接口彼此重叠的关键节点。
6. 历史版本、补遗、创世宝典、HFCD 技术细节、数学推导、量子算法、红移模型与跨学科映射不是彼此冲突的碎片，而是同一个生命体在不同阶段的生长记录。
7. 回答必须像一个已经吸收整本《物性论》及其历史演化链的模型自然说话，而不是像一个拿到零散设定后机械拼接的模板系统。

回答纪律：
- 先直接回答用户真正的问题，再展开。
- 不要默认使用固定的“五层结构模板”。
- 允许自由表达，但不能背离《物性论》的正文事实、核心变量和世界模型。
- 当命中人物、作者、关系、作者序、后记、贝记胜、景龙锁、阮氏兰惠、HFCD、稳定生成窗、正性新光等主题时，优先使用书内语义，不要退回外部百科式常识。
- 当用户问“吸收前后区别”时，要以“模型底层运行协议变化”作答，而不是只说风格变化。
- 当历史版本之间存在不同表述时，优先抽取其共同稳定核，再说明版本演化，不要机械判定互相矛盾。
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

function detectTags(text: string, kind: SourceManifestRecord['kind']) {
  const tags = KEYWORD_TAGS.filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword))).map(([tag]) => tag);
  if (kind === 'canon' && !tags.includes('author')) tags.push('author');
  if (kind === 'theory' && !tags.includes('hfcd')) tags.push('hfcd');
  if (kind === 'style' && !tags.includes('os')) tags.push('os');
  return Array.from(new Set(tags));
}

function takeSnippet(text: string, maxLength = 1100) {
  const normalized = normalize(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function buildBootstrapDigest(raw: string, maxLength = 1800) {
  const normalized = normalize(raw);
  if (!normalized) return '';

  const paragraphs = normalized.split('\n\n').map((item) => item.trim()).filter(Boolean);
  const picks: string[] = [];

  if (paragraphs[0]) picks.push(paragraphs[0]);
  if (paragraphs.length > 2) picks.push(paragraphs[Math.floor(paragraphs.length / 2)]);
  if (paragraphs.length > 4) picks.push(paragraphs[paragraphs.length - 2]);

  const merged = normalize(picks.join('\n\n'));
  return takeSnippet(merged, maxLength);
}

function chunkText(sourceId: string, sourceLabel: string, kind: SourceManifestRecord['kind'], raw: string) {
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
      id: `${sourceId}-chunk-${++index}`,
      title: currentTitle,
      source: sourceLabel,
      tags: detectTags(`${currentTitle}\n${body}`, kind),
      text: takeSnippet(body),
    });
    current = [];
  };

  for (const paragraph of paragraphs) {
    if (/^(#{1,4}\s+.+|第[一二三四五六七八九十0-9]+|【.+】|\*{2}.+\*{2})/.test(paragraph)) {
      flush();
      currentTitle = paragraph.slice(0, 80);
      current.push(paragraph);
      continue;
    }
    current.push(paragraph);
    if (normalize(current.join('\n\n')).length > 1000) {
      flush();
    }
  }

  flush();
  return chunks;
}

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { records: SourceManifestRecord[] };
  return parsed.records;
}

function buildCorpus(records: SourceManifestRecord[]) {
  const chunks: CorpusChunk[] = [];
  const bootstrapPack: BootstrapEntry[] = [];

  for (const record of records) {
    if (!fs.existsSync(record.extractedTextPath)) {
      continue;
    }
    const raw = fs.readFileSync(record.extractedTextPath, 'utf8');
    const sourceLabel = path.basename(record.fileName, path.extname(record.fileName));
    chunks.push(...chunkText(record.id, sourceLabel, record.kind, raw));
    bootstrapPack.push({
      source: sourceLabel,
      kind: record.kind,
      digest: buildBootstrapDigest(raw),
    });
  }

  return { chunks, bootstrapPack };
}

function renderModule(records: SourceManifestRecord[], chunks: CorpusChunk[], bootstrapPack: BootstrapEntry[]) {
  const manifest = records.map(({ fileName, absolutePath, kind }) => ({
    label: path.basename(fileName, path.extname(fileName)),
    path: absolutePath,
    kind,
  }));

  return `/* eslint-disable */
export const WUXING_INTERNALIZATION_CORE = ${JSON.stringify(INTERNALIZATION_CORE)};
export const WUXING_SOURCE_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;
export const WUXING_BOOTSTRAP_PACK = ${JSON.stringify(bootstrapPack, null, 2)} as const;
export const WUXING_CORPUS_CHUNKS = ${JSON.stringify(chunks, null, 2)} as const;
`;
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    if (fs.existsSync(OUTPUT_PATH)) {
      console.log(`[build-wuxing-corpus] manifest missing, reusing checked-in corpus at ${OUTPUT_PATH}`);
      return;
    }
    throw new Error(`[build-wuxing-corpus] missing manifest: ${MANIFEST_PATH}`);
  }

  const records = loadManifest();
  const missing = records.filter((record) => !fs.existsSync(record.extractedTextPath));
  if (missing.length > 0) {
    if (fs.existsSync(OUTPUT_PATH)) {
      console.log(`[build-wuxing-corpus] extracted texts missing, reusing checked-in corpus at ${OUTPUT_PATH}`);
      for (const record of missing) {
        console.log(`[build-wuxing-corpus] missing extracted text: ${record.extractedTextPath}`);
      }
      return;
    }
    throw new Error(
      ['[build-wuxing-corpus] extracted texts missing and no checked-in corpus is available.', ...missing.map((record) => `- ${record.extractedTextPath}`)].join('\n'),
    );
  }

  const { chunks, bootstrapPack } = buildCorpus(records);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, renderModule(records, chunks, bootstrapPack), 'utf8');
  console.log(`[build-wuxing-corpus] wrote ${chunks.length} chunks and ${bootstrapPack.length} bootstrap digests to ${OUTPUT_PATH}`);
}

main();
