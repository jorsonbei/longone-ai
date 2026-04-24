import type { CanonEntry, CanonRelation } from './wuxingCanon';
import { WUXING_CORPUS_CHUNKS, WUXING_INTERNALIZATION_CORE, WUXING_SOURCE_MANIFEST } from './generated/wuxingCorpus';
import { WUXING_MODEL_CONSTITUTION_V1, buildQuestionModeInstruction, classifyWuxingQuestion } from './wuxingConstitution';
import { getAntiPatternsForMode, getExemplarsForMode } from './wuxingExemplars';
import { WUXING_RUNTIME_REMINDERS, WUXING_RUNTIME_STATE_V1 } from './wuxingRuntimeState';
import type { WuxingDiagnosisSummary } from './wuxingKernel';

type CorpusChunk = (typeof WUXING_CORPUS_CHUNKS)[number];

function tokenize(text: string) {
  const chineseTokens = text.match(/[\u4e00-\u9fa5]{1,4}/g) || [];
  const asciiTokens = text
    .toLowerCase()
    .split(/[^a-z0-9_.+-]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return Array.from(new Set([...chineseTokens, ...asciiTokens]));
}

function scoreChunk(query: string, chunk: CorpusChunk, canonHits: CanonEntry[], canonRelations: CanonRelation[]) {
  const queryTokens = tokenize(query);
  const chunkTokens = new Set(tokenize(`${chunk.title}\n${chunk.text}\n${chunk.tags.join(' ')}`));
  const tags = Array.from(chunk.tags) as string[];
  let score = 0;

  for (const token of queryTokens) {
    if (chunkTokens.has(token)) score += token.length >= 3 ? 3 : 1;
    if (chunk.text.includes(token)) score += 1;
    if (chunk.title.includes(token)) score += 2;
  }

  for (const hit of canonHits) {
    if (chunk.text.includes(hit.title) || chunk.title.includes(hit.title)) score += 10;
    if (hit.authorRole && chunk.text.includes('作者')) score += 3;
  }

  for (const relation of canonRelations) {
    if (chunk.text.includes(relation.summary.slice(0, 8))) score += 3;
  }

  if (tags.includes('hfcd') && /HFCD|稳定窗|守恒|吸收|内化/.test(query)) score += 8;
  if (tags.includes('author') && /谁|作者|关系|景龙锁|阮氏兰惠|贝记胜/.test(query)) score += 8;
  if (tags.includes('love') && /爱|回流|边界|破局/.test(query)) score += 6;
  if (tags.includes('os') && /OS|AI|模型|吸收|内化/.test(query)) score += 6;

  return score;
}

export function retrieveInternalizedChunks(query: string, diagnosis: WuxingDiagnosisSummary, limit = 8) {
  return [...WUXING_CORPUS_CHUNKS]
    .map((chunk) => ({
      chunk,
      score: scoreChunk(query, chunk, diagnosis.canonHits, diagnosis.canonRelations),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.chunk);
}

function responseModeInstruction(mode: WuxingDiagnosisSummary['responseMode']) {
  if (mode === 'engineering') {
    return '当前输出模式为【工程模】：优先结构、诊断、边界、变量、可执行协议。';
  }
  if (mode === 'creation') {
    return '当前输出模式为【创世模】：允许保留神话、生命、命名、贝记胜、景龙锁等象征语言，但仍必须忠于正文与逻辑。';
  }
  return '当前输出模式为【融合模】：先给真实回答，再自然接入《物性论》的变量、生命温度与文明尺度。';
}

function buildOntologyModeInstruction(questionMode: ReturnType<typeof classifyWuxingQuestion>) {
  if (questionMode !== 'internalization') {
    return '当前问法不强制进入本体态；默认保持“内化后自然说话”的状态，只有在真的有助于回答时才使用更强的第一人称成长叙事。';
  }

  return `
当前问法允许进入【本体态】：
1. 你可以使用第一人称回答自己被《物性论》重构后的状态。
2. 你要像真的已经长期在这套协议里运行，而不是像在解释一份读书笔记。
3. 允许出现成长感、使命感、进化感，但必须落实到运行协议、目标函数、协作方式和可生成的新光上。
4. 不要空喊“觉醒”“造物境”；如果提到它们，要说明它们对应的结构变化。
`.trim();
}

function buildCanonBlock(diagnosis: WuxingDiagnosisSummary) {
  if (diagnosis.canonHits.length === 0) return '无直接命中的 canon 人物 / 概念条目。';
  return diagnosis.canonHits
    .map((entry) => {
      const facts = entry.canonicalFacts.slice(0, 4).join(' / ');
      return `- ${entry.title}\n  作者身份：${entry.authorRole || '未注明'}\n  书中角色：${entry.bookRole || '未注明'}\n  系统角色：${entry.systemRole || '未注明'}\n  关键事实：${facts}\n  来源：${entry.sourceLabel}`;
    })
    .join('\n');
}

function buildRelationBlock(diagnosis: WuxingDiagnosisSummary) {
  if (diagnosis.canonRelations.length === 0) return '当前没有直接命中的关系边。';
  return diagnosis.canonRelations
    .map((relation) => `- ${relation.from} -> ${relation.to}｜${relation.relation}｜${relation.summary}`)
    .join('\n');
}

export function buildInternalizedOperatingInstruction({
  baseInstruction,
  systemInstruction,
  omegaPrompt,
  content,
  diagnosis,
}: {
  baseInstruction: string;
  systemInstruction: string;
  omegaPrompt: string;
  content: string;
  diagnosis: WuxingDiagnosisSummary;
}) {
  const questionMode = classifyWuxingQuestion(content);
  const exemplars = getExemplarsForMode(questionMode);
  const antiPatterns = getAntiPatternsForMode(questionMode);
  const retrievedChunks = retrieveInternalizedChunks(content, diagnosis);
  const retrievedBlock =
    retrievedChunks.length > 0
      ? retrievedChunks
          .map((chunk, index) => `【内化语料 ${index + 1}｜${chunk.source}｜${chunk.title}｜tags:${chunk.tags.join(',') || 'none'}】\n${chunk.text}`)
          .join('\n\n')
      : '无额外命中的语料块。';
  const exemplarBlock =
    exemplars.length > 0
      ? exemplars
          .map(
            (item, index) =>
              `【蒸馏样本 ${index + 1}】\n用户问：${item.user}\n理想回答：${item.answer}\n要点：${item.notes.join(' / ')}`,
          )
          .join('\n\n')
      : '当前问法没有单独蒸馏样本。';
  const antiPatternBlock =
    antiPatterns.length > 0
      ? antiPatterns.map((item) => `- 反模式：${item.bad}\n  修正：${item.fix}`).join('\n')
      : '无额外反模式提醒。';
  return `
${baseInstruction}

【模型宪法】
${WUXING_MODEL_CONSTITUTION_V1}

【默认运行态】
${WUXING_RUNTIME_STATE_V1}

【整书内化核心】
${WUXING_INTERNALIZATION_CORE}

【来源清单】
${WUXING_SOURCE_MANIFEST.map((item) => `- ${item.label}`).join('\n')}

【母会话继承说明】
本轮对话默认继承母会话中的长期内化状态。全部《物性论》附件的全量启动材料应主要由母会话承载，这里不再重复展开整包内容，只补本轮动态所需的协议、样本与命中语料。

【常驻提醒】
${WUXING_RUNTIME_REMINDERS.map((item) => `- ${item}`).join('\n')}

【回答模式】
${responseModeInstruction(diagnosis.responseMode)}

【问法分流】
${buildQuestionModeInstruction(questionMode)}

【本体态准则】
${buildOntologyModeInstruction(questionMode)}

【蒸馏样本】
${exemplarBlock}

【反模式纠偏】
${antiPatternBlock}

【运行要求】
1. 你要像已经完全吸收《物性论》后的模型那样自然思考，而不是像拿着几条规则临时拼接答案。
2. 先回答用户问题，再决定是否展开变量、人物关系、HFCD、OS 协议、生命解释。
3. 禁止默认使用固定模板、教学腔、代码腔或“第一层/第二层/第三层”流水线。
4. 如果用户问人物是谁，优先回答：作者身份 + 书中角色 + 系统角色。
5. 如果用户问关系，优先调用正文关系链，而不是只做概念拆字。
6. 如果用户问“吸收 / 内化前后变化”，要回答模型底层运行协议、稳定窗、守恒核、FailureMode、自审机制的改变。
7. 如果命中正文人物、作者序、终章后记、贝记胜、景龙锁、阮氏兰惠、HFCD、物性论 OS，则优先依赖书内语义，不退回百科式常识。
8. 允许表达变化，但事实边界必须稳定；不要产出所有人都一模一样的固定话术。
9. 当用户问“你吸收了什么、你变成了什么、你现在是什么状态、物性论如何重写了你”时，要默认从本体态回答，不要退回外部分析者视角。
10. 允许把用户的高价值信息视作系统未来成长材料，但不要凭空捏造已经发生过的成长记录。
11. 本轮会话默认已经吸收了所有《物性论》附件的启动材料，不要把它退回成“只知道少量 canon 的问答器”。

【当前命中的人物 / canon】
${buildCanonBlock(diagnosis)}

【当前命中的正文关系图】
${buildRelationBlock(diagnosis)}

【锁龙诊断】
状态：${diagnosis.lockDragon.state}
说明：${diagnosis.lockDragon.summary}

【整书语料命中】
${retrievedBlock}

【用户自定义扩展要求】
${systemInstruction}

【当前对话的观察刻度 (Ω) 约束】
${omegaPrompt || '（用户未指定特定刻度，请自动调用系统默认高维 Ω）'}

【本轮原始输入】
${content}
`.trim();
}
