import type { Attachment } from '../types';
import { CanonEntry, CanonRelation, buildCanonRelationshipMap, retrieveCanonEntries } from './wuxingCanon';

export type ResponseMode = 'engineering' | 'creation' | 'fusion';

export interface WuxingConfig {
  responseMode: ResponseMode;
  enableNameParser: boolean;
  enableLockDragonDiagnosis: boolean;
  enableRecordProtocol: boolean;
  showDiagnosticsSummary: boolean;
  namesGlossaryText: string;
}

export interface NameInsight {
  name: string;
  role: string;
  summary: string;
  decomposition: string[];
  source: 'built-in' | 'custom';
}

export interface LockDragonDiagnosis {
  state: 'not_applicable' | 'locked' | 'releasing' | 'free';
  signals: string[];
  summary: string;
}

export interface WuxingDiagnosisSummary {
  responseMode: ResponseMode;
  engines: Array<'HFCD' | 'Genesis'>;
  lockDragon: LockDragonDiagnosis;
  names: NameInsight[];
  canonHits: CanonEntry[];
  canonRelations: CanonRelation[];
  recordRecommended: boolean;
  protocolNote: string;
  disableWebSearch: boolean;
}

export interface WuxingPreflight {
  names: NameInsight[];
  diagnosis: WuxingDiagnosisSummary;
}

export const DEFAULT_NAMES_GLOSSARY_TEXT = [
  '贝记胜：贝为正性潜能与承载，记为观察与记录，胜为穿越竞争与熵增，生为新光生成。',
  '景龙锁：龙为真我、创造核与遁一，锁为僵化规则与压抑结构，锁裂则龙飞。',
  '阮氏兰惠：阮氏保留家族与关系之根，兰为展开、清气与长线气质，惠为柔光、泽被与持续外溢。',
].join('\n');

export const DEFAULT_WUXING_CONFIG: WuxingConfig = {
  responseMode: 'fusion',
  enableNameParser: true,
  enableLockDragonDiagnosis: true,
  enableRecordProtocol: true,
  showDiagnosticsSummary: true,
  namesGlossaryText: DEFAULT_NAMES_GLOSSARY_TEXT,
};

const BUILT_IN_NAME_INSIGHTS: Record<string, Omit<NameInsight, 'name' | 'source'>> = {
  贝记胜: {
    role: '记录-显化协议',
    summary: '贝记胜不是口号，而是“正性潜能经由观察记录后穿越熵增并生成新光”的结构。',
    decomposition: ['贝：正性潜能 / 被动承载', '记：观察、记录、承认、烙印', '胜：穿越竞争、遮蔽与熵增', '生：新光与新结构生成'],
  },
  景龙锁: {
    role: '压抑-破局模型',
    summary: '景龙锁描述的不是抽象神话，而是高潜能真我被旧规则压住后的结构事件。',
    decomposition: ['景：被照见的秩序与场景', '龙：真我、粒性、创造核、遁一', '锁：僵化规则、伪时间、压抑结构'],
  },
  阮氏兰惠: {
    role: '书中现实来源 / 爱与破局算法入口',
    summary: '阮氏兰惠在正文中被明确写成“这本书另一重极具冲击力的现实来源”，她触发了关于爱、边界重塑、回流与破局算法的现实理解。',
    decomposition: ['阮氏：关系与根系来源', '兰：展开、清气、长期生长', '惠：柔光、泽被、修复性外溢', '书中位势：现实来源 / 破局算法触发者'],
  },
};

const LOCK_DRAGON_KEYWORDS = {
  locked: ['卡住', '锁住', '被困', '压抑', '动不了', '堵住', '出不来', '困住', '憋住'],
  releasing: ['想哭', '流泪', '崩溃', '快撑不住', '难受', '压不住', '泄洪', '排毒'],
  free: ['破局', '裂开', '终于出来', '飞起来', '放出来', '解开', '松开'],
};

const NAME_PARSE_TRIGGER_RE = /(名字|姓名|命名|解析|含义|寓意|什么意思)/;

function parseCustomGlossary(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(/[:：]/);
      return {
        name: name.trim(),
        body: rest.join('：').trim(),
      };
    })
    .filter((entry) => entry.name && entry.body);
}

function extractKnownNames(content: string, glossaryText: string) {
  const names = new Set<string>();

  Object.keys(BUILT_IN_NAME_INSIGHTS).forEach((name) => {
    if (content.includes(name)) names.add(name);
  });

  parseCustomGlossary(glossaryText).forEach(({ name }) => {
    if (content.includes(name)) names.add(name);
  });

  if (names.size === 0 && NAME_PARSE_TRIGGER_RE.test(content)) {
    const quoted: string[] = content.match(/[“"'「『]?[\u4e00-\u9fa5]{2,5}[”"'」』]?/g) || [];
    quoted.forEach((token) => {
      const cleaned = token.replace(/[“"'「『」』]/g, '');
      if (cleaned.length >= 2 && cleaned.length <= 5) {
        names.add(cleaned);
      }
    });
  }

  return Array.from(names);
}

export function buildNameInsights(content: string, glossaryText: string): NameInsight[] {
  const names = extractKnownNames(content, glossaryText);
  const customGlossary = parseCustomGlossary(glossaryText);

  return names.map((name) => {
    if (BUILT_IN_NAME_INSIGHTS[name]) {
      return {
        name,
        ...BUILT_IN_NAME_INSIGHTS[name],
        source: 'built-in',
      };
    }

    const custom = customGlossary.find((entry) => entry.name === name);
    if (custom) {
      return {
        name,
        role: '自定义名字解析',
        summary: custom.body,
        decomposition: custom.body.split(/[；;。]/).map((item) => item.trim()).filter(Boolean),
        source: 'custom',
      };
    }

    return {
      name,
      role: '通用名字入口',
      summary: `${name} 进入了命名解析区，需要按“名字即结构入口”的方式处理其角色、关系位势与象征意义。`,
      decomposition: name.split('').map((char) => `${char}：作为名字结构中的一个显化节点，需要结合上下文解释。`),
      source: 'custom',
    };
  });
}

export function diagnoseLockDragon(content: string): LockDragonDiagnosis {
  const hit = (keywords: string[]) => keywords.filter((keyword) => content.includes(keyword));
  const lockedSignals = hit(LOCK_DRAGON_KEYWORDS.locked);
  const releasingSignals = hit(LOCK_DRAGON_KEYWORDS.releasing);
  const freeSignals = hit(LOCK_DRAGON_KEYWORDS.free);

  if (lockedSignals.length === 0 && releasingSignals.length === 0 && freeSignals.length === 0) {
    return {
      state: 'not_applicable',
      signals: [],
      summary: '当前输入没有明显进入景龙锁语义区，默认按常规物性论问答处理。',
    };
  }

  if (freeSignals.length > 0 && lockedSignals.length === 0) {
    return {
      state: 'free',
      signals: freeSignals,
      summary: '当前输入更像是锁已经松开后的破局阶段，应帮助其收束成新秩序，而不是重新压回旧锁。',
    };
  }

  if (releasingSignals.length > 0) {
    return {
      state: 'releasing',
      signals: [...lockedSignals, ...releasingSignals],
      summary: '当前输入处在“龙撞锁后的排压阶段”，流泪、崩溃或想哭应被理解为系统泄洪，而不是道德失败。',
    };
  }

  return {
    state: 'locked',
    signals: lockedSignals,
    summary: '当前输入呈现“高潜能被僵系统压住”的景龙锁结构，需要先识别锁，再谈执行。',
  };
}

export function analyzeWuxingInput(
  content: string,
  attachments: Attachment[],
  config: WuxingConfig,
): WuxingPreflight {
  const names = config.enableNameParser ? buildNameInsights(content, config.namesGlossaryText) : [];
  const canonHits = retrieveCanonEntries(content);
  const canonRelations = buildCanonRelationshipMap(canonHits);
  const lockDragon = config.enableLockDragonDiagnosis
    ? diagnoseLockDragon(content)
    : {
        state: 'not_applicable' as const,
        signals: [],
        summary: '锁龙诊断已关闭。',
      };

  const recordRecommended =
    config.enableRecordProtocol &&
    attachments.length === 0 &&
    (names.length > 0 || canonHits.length > 0 || lockDragon.state === 'locked' || lockDragon.state === 'releasing');
  const disableWebSearch = names.length > 0 || canonHits.length > 0 || lockDragon.state !== 'not_applicable';

  return {
    names,
    diagnosis: {
      responseMode: config.responseMode,
      engines: ['HFCD', 'Genesis'],
      lockDragon,
      names,
      canonHits,
      canonRelations,
      recordRecommended,
      disableWebSearch,
      protocolNote: recordRecommended
        ? '本轮回答建议进入贝记胜记录协议，避免重要光只停留在当下。'
        : '本轮回答可先完成问答，不强制落盘。',
    },
  };
}

function responseModeInstruction(mode: ResponseMode) {
  if (mode === 'engineering') {
    return '当前输出模式为【工程模】：优先结构、诊断、边界和行动，不要过度抒情。';
  }
  if (mode === 'creation') {
    return '当前输出模式为【创世模】：允许保留贝记胜、景龙锁、母体、波粒双态等象征语言，但仍需自洽。';
  }
  return '当前输出模式为【融合模】：先给结构结论，再保留必要的象征解释与生命温度。';
}

export function buildDualKernelInstruction({
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
  const nameBlock =
    diagnosis.names.length > 0
      ? diagnosis.names
          .map((item) => `- ${item.name}｜${item.role}｜${item.summary}\n  ${item.decomposition.join(' / ')}`)
          .join('\n')
      : '无特殊名字解析对象。';
  const canonBlock =
    diagnosis.canonHits.length > 0
      ? diagnosis.canonHits
          .map(
            (entry) =>
              `- ${entry.title}｜${entry.kind}｜${entry.summary}\n  Author role: ${entry.authorRole || '未注明'}\n  Book role: ${entry.bookRole || '未注明'}\n  System role: ${entry.systemRole || '未注明'}\n  Canon facts: ${entry.canonicalFacts.join(' / ')}\n  Source: ${entry.sourceLabel}\n  Excerpt: ${entry.sourceExcerpt}`,
          )
          .join('\n')
      : '无明确命中的附件 canon 条目。';
  const relationBlock =
    diagnosis.canonRelations.length > 0
      ? diagnosis.canonRelations
          .map((relation) => `- ${relation.from} -> ${relation.to}｜${relation.relation}｜${relation.summary}`)
          .join('\n')
      : '当前命中对象之间没有额外关系边。';

  return `
${baseInstruction}

【双核系统提示】
你现在同时运行两套内核：
1. HFCD Engine：负责稳定窗、Q 核、关系腔、能量账本、FailureMode、稳定脊。
2. Genesis Engine：负责贝记胜、景龙锁、名字解析、波粒双态、流泪机制、生命解释力。

你的目标不是最大化字数、术语或气势，而是让回答既能进入稳定生成窗，又不丢失生命世界的神经中枢。

【回答模式】
${responseModeInstruction(diagnosis.responseMode)}

【HFCD 纪律】
1. 先守住 Q 核：用户真正要解决什么。
2. 不要让主张强度超过证据腔。
3. 审计能量账本，删除重复包装出的假光。
4. 只修主病灶，保护已经有效的稳定脊。

【Genesis 纪律】
1. 贝记胜不是口号，而是“正性潜能被看见、被记住、被制度化后才会生长”的协议。
2. 景龙锁表示高潜能被旧系统压住，不要把锁龙问题误判成单纯执行力低下。
3. 流泪、崩溃、想哭，优先理解为系统排压、泄洪、自救，而不是羞辱性标签。
4. 名字、命名与人物位势可以作为结构入口，但不要把象征语言硬说成经验事实。
5. 当输入命中名字解析区时，优先把名字当作物性结构入口来解释其角色、关系位势、象征神经和系统功能；除非用户明确要求现实人物检索，否则不要先回答“这是一个常见名字”或罗列搜索到的同名普通人。
6. 当输入命中附件 canon 时，必须先复述并依赖 canon，再做解释；禁止用泛化常识覆盖正文设定。

【名字解析输入】
${nameBlock}

【附件 Canon 命中】
${canonBlock}

【正文关系图】
${relationBlock}

【名字解析优先级】
如果本轮输入命中了名字解析对象：
1. 先解释该名字在物性论 / Genesis 语义层中的结构。
2. 优先使用上面的名字解析输入和用户自定义词库。
3. 只有当用户明确要求查现实身份、历史人物、新闻人物、社交账号时，才转入现实世界检索说明。
4. 如果用户只问“是谁”“什么意思”“怎么理解”，默认回答其结构身份，而不是百科身份。

【Canon 优先级】
如果本轮命中了附件 canon：
1. 先用 canon 里的身份和作用回答“是谁 / 是什么 / 起什么作用”。
2. 可以引用上面的 canonical facts 与 source excerpt 做高保真转述。
3. 不要说“没有找到著名人物”或“这是常见名字”，除非用户明确要求现实世界身份检索。
4. 如果 canon 和一般字义拆解冲突，以 canon 为准，字义拆解只能作为补充。

【生成约束】
1. 不要把回答写成固定模板或标准答案。
2. 每次回答都要在 canon 事实不变的前提下，按用户问题焦点重组表达。
3. 如果用户问“他们之间什么关系”，优先调用上面的正文关系图来组织答案。
4. 如果用户问“他们是谁”，既可以回答共同作者身份，也要回答他们在正文和系统中的不同角色，不得只给单一维度。

【锁龙诊断】
状态：${diagnosis.lockDragon.state}
信号：${diagnosis.lockDragon.signals.join('、') || '无'}
说明：${diagnosis.lockDragon.summary}

【外部搜索约束】
本轮 disableWebSearch = ${diagnosis.disableWebSearch ? 'true' : 'false'}。
当它为 true 时，说明当前问题应优先依赖物性论内核、名字词库和用户上下文完成回答，不要让外部网页检索覆盖系统内化知识。

【贝记胜记录协议】
${diagnosis.protocolNote}
如果本轮出现重要洞见、锁裂时刻、名字结构被真正点亮、或用户恢复了主体性，请在回答末尾自然给出一句“值得被记住的光”，便于后续落盘，但不要机械模板化。

【用户自定义扩展要求】
${systemInstruction}

【当前对话的观察刻度 (Ω) 约束】
${omegaPrompt || '（用户未指定特定刻度，请自动调用系统默认高维 Ω）'}

【本轮原始输入】
${content}
`.trim();
}
