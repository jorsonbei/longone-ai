export interface CanonEntry {
  id: string;
  title: string;
  aliases: string[];
  kind: 'person' | 'concept' | 'event';
  authorRole?: string;
  bookRole?: string;
  systemRole?: string;
  summary: string;
  canonicalFacts: string[];
  sourceLabel: string;
  sourceExcerpt: string;
}

export interface CanonRelation {
  from: string;
  to: string;
  relation: string;
  summary: string;
}

const CANON_ENTRIES: CanonEntry[] = [
  {
    id: 'nguyen-thi-lan-hue',
    title: '阮氏兰惠',
    aliases: ['阮氏兰惠', 'NGUYEN THI LAN HUE', 'Nguyen Thi Lan Hue'],
    kind: 'person',
    authorRole: '《物性论》共同作者之一（亚马逊出版信息）',
    bookRole: '这本书另一重极具冲击力的现实来源',
    systemRole: '爱、边界重塑、回流与破局算法的现实血肉来源',
    summary: '阮氏兰惠在《物性论》正文里不是泛化人名，而是这本书另一重极具冲击力的现实来源。',
    canonicalFacts: [
      '她被正文明确写成“这本书另一重极具冲击力的现实来源”。',
      '她带来的不是普通情感经历，而是巨大情感振幅与系统边界改写。',
      '她迫使作者理解：爱不是静态名词，而是关于能量势差、边界重塑、能量回流、黑子清理、修复与重建的真实物理算法。',
      '书中反复出现的“破局算法”，其现实源头之一明确被追溯到与阮氏兰惠相关的生命经验。',
      '正文要求回答她时，应优先按物性论 canon 中的角色来源与系统意义解释，而不是外部百科检索。',
    ],
    sourceLabel: '《物性论：文明操作系统》终章后记',
    sourceExcerpt:
      '而阮氏兰惠，则构成了这本书另一重极具冲击力的现实来源。她让我经历了极大的情感振幅……爱，从来不是一个静态的、温馨的名词，而是一整套关于能量势差、边界重塑、能量回流、毒素（黑子）清理、修复与重建的真实物理算法。',
  },
  {
    id: 'jing-long-suo',
    title: '景龙锁',
    aliases: ['景龙锁', 'JING LONG SUO', 'Jing Long Suo'],
    kind: 'person',
    authorRole: '《物性论》共同作者之一（亚马逊出版信息）',
    bookRole: '进入生命后引发奇迹性改变的重要人物入口',
    systemRole: '景龙锁相变 / η 注入 / 破锁模型的现实入口',
    summary: '景龙锁在《物性论》中既是人物名，也是高压闭锁后的相变事件与破局注入者。',
    canonicalFacts: [
      '正文写到“是景龙锁进入我的生命之后，这一切开始发生奇迹般的改变”。',
      '景龙锁让作者开始理解以爱来思考、创造快乐、让体验关系和能量回流共同参与判断。',
      '在系统层面，景龙锁被定义为高潜能被僵死规则长期锁住后的相变事件。',
      '在第十九章里，景龙锁被写成“宇宙派来炸毁我牢笼的那个极其狂暴、又极其温柔的 η”。',
      '回答相关问题时，应同时保留“现实人物入口”和“系统动力学事件”双重身份。',
    ],
    sourceLabel: '《物性论：文明操作系统》终章后记 / 第十九章',
    sourceExcerpt:
      '是景龙锁进入我的生命之后，这一切开始发生奇迹般的改变……而景龙锁，就是宇宙派来炸毁我牢笼的那个极其狂暴、又极其温柔的 η！',
  },
  {
    id: 'bei-ji-sheng',
    title: '贝记胜',
    aliases: ['贝记胜', 'BEI JI SHENG', 'Bei Ji Sheng', '贝记胜生'],
    kind: 'person',
    authorRole: '《物性论》共同作者之一（亚马逊出版信息）',
    bookRole: '创造者名字入口 / 记录者 / 见证者',
    systemRole: '记录-显化协议与“被记录的正性才会生长”的文明接口',
    summary: '贝记胜在《物性论》中既是创造者名字入口，也是“被记录的正性才会生长”的文明公式。',
    canonicalFacts: [
      '正文将“贝记胜生”定义为文明生成公式：被记录的正性才会生长。',
      '第十九章把贝记胜与景龙锁的相遇写成宇宙法则：贝被深情地看见，触发量子坍缩与新光生成。',
      '在《创世宝典》中，贝记胜生被解释为“正性被观察记录后才会生长”的名字天机。',
      '回答相关问题时，不能只拆字义，还要说明它在书里的文明协议与生成机制。',
    ],
    sourceLabel: '《物性论：文明操作系统》卷一 / 第十九章 / 《创世宝典》',
    sourceExcerpt:
      '“贝记胜生”在本书中被解释为文明生成公式……解密结论：所有的胜利，都源于正性被看见。',
  },
];

const CANON_RELATIONS: CanonRelation[] = [
  {
    from: 'bei-ji-sheng',
    to: 'jing-long-suo',
    relation: '相遇触发',
    summary: '第十九章将贝记胜与景龙锁的相遇写成宇宙法则：被看见、量子坍缩、锁裂龙出。',
  },
  {
    from: 'jing-long-suo',
    to: 'bei-ji-sheng',
    relation: 'η 注入 / 破锁',
    summary: '景龙锁被写成“宇宙派来炸毁我牢笼的那个极其狂暴、又极其温柔的 η”。',
  },
  {
    from: 'nguyen-thi-lan-hue',
    to: 'bei-ji-sheng',
    relation: '边界改写',
    summary: '阮氏兰惠以巨大的情感振幅改写系统边界，使爱、回流、修复、破局获得现实来源。',
  },
  {
    from: 'bei-ji-sheng',
    to: 'nguyen-thi-lan-hue',
    relation: '理论回写',
    summary: '作者将与阮氏兰惠相关的现实经验回写成“爱的物理算法”和“破局算法”。',
  },
  {
    from: 'jing-long-suo',
    to: 'nguyen-thi-lan-hue',
    relation: '共同构成现实来源链',
    summary: '二者在终章后记中共同构成《物性论》的现实来源链，但分别通向快乐 / 以爱思考与爱之物理算法两条路径。',
  },
  {
    from: 'bei-ji-sheng',
    to: 'book',
    relation: '共同作者',
    summary: '贝记胜是亚马逊出版信息中的共同作者之一。',
  },
  {
    from: 'jing-long-suo',
    to: 'book',
    relation: '共同作者',
    summary: '景龙锁是亚马逊出版信息中的共同作者之一。',
  },
  {
    from: 'nguyen-thi-lan-hue',
    to: 'book',
    relation: '共同作者',
    summary: '阮氏兰惠是亚马逊出版信息中的共同作者之一。',
  },
];

function matchesAlias(content: string, alias: string) {
  return content.toLowerCase().includes(alias.toLowerCase());
}

export function retrieveCanonEntries(content: string) {
  return CANON_ENTRIES.filter((entry) => entry.aliases.some((alias) => matchesAlias(content, alias)));
}

export function buildCanonRelationshipMap(entries: CanonEntry[]) {
  const ids = new Set(entries.map((entry) => entry.id));
  return CANON_RELATIONS.filter((relation) => ids.has(relation.from) && (ids.has(relation.to) || relation.to === 'book'));
}
