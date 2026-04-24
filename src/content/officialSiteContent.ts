import type { Locale } from '../lib/locale';

export type OfficialIndustryId =
  | 'overview'
  | 'chips'
  | 'robotics'
  | 'ai'
  | 'social'
  | 'tech'
  | 'materials-quantum'
  | 'energy'
  | 'safety'
  | 'bio';

export interface OfficialSiteMetric {
  label: string;
  value: string;
  note: string;
}

export interface OfficialSiteHighlight {
  title: string;
  detail: string;
}

export interface OfficialSiteIndustry {
  id: OfficialIndustryId;
  title: string;
  oneLiner: string;
  problem: string;
  shortValue: string;
  longValue: string;
}

export interface OfficialSiteContent {
  seo: {
    title: string;
    description: string;
    image: string;
  };
  hero: {
    badge: string;
    title: string;
    subtitle: string;
    primaryCta: {
      label: string;
      href: string;
    };
    secondaryCta: {
      label: string;
      href: string;
    };
  };
  definition: {
    title: string;
    paragraphs: string[];
  };
  whyNow: {
    title: string;
    bullets: string[];
  };
  evidence: {
    title: string;
    intro: string;
    highlights: OfficialSiteHighlight[];
    metrics: OfficialSiteMetric[];
  };
  industries: OfficialSiteIndustry[];
  experiment: {
    title: string;
    intro: string;
    featured: {
      name: string;
      status: string;
      summary: string;
      next: string;
    };
  };
  book: {
    title: string;
    body: string;
    href: string;
  };
  faq: Array<{
    q: string;
    a: string;
  }>;
}

const AMAZON_SAMPLE_URL = 'https://read.amazon.com/sample/B0GX35WHPZ?clientId=share';
const OG_IMAGE_URL = 'https://longone.ai/og-image.png';

const zh: OfficialSiteContent = {
  seo: {
    title: '物性论官网 | 用通俗语言解释技术、社会与产业价值',
    description:
      '物性论是一套解释技术演化、产业变革与社会价值关系的认知框架。理解它如何作用于芯片、机器人、AI、能源、生命科学等行业。',
    image: OG_IMAGE_URL,
  },
  hero: {
    badge: '物性论官网',
    title: '解释一个终极问题：混沌的能量，如何变成稳定的结构。',
    subtitle:
      'HFCD V11.10b-fix 的意义，不只是跑出 6 个稳定态，而是把一个更大的问题拉到桌面上：在这个世界里，什么样的系统能把狂暴能量锁进可持续的秩序里？物性论试图给出的，正是一套解释“无序如何变成有序”的通用语言。',
    primaryCta: {
      label: '阅读 Amazon 试读',
      href: AMAZON_SAMPLE_URL,
    },
    secondaryCta: {
      label: '查看行业价值',
      href: '#industries',
    },
  },
  definition: {
    title: '什么是物性论',
    paragraphs: [
      '物性论可以理解为一把“解析复杂系统的通用钥匙”。它不只关心一个产品能不能工作，而是继续追问：系统为什么稳定、为什么失衡、能量为什么会溢出、结构为什么会塌陷。',
      '对普通人来说，它的意义在于：帮你看懂为什么有些技术会真的改变社会，有些只是热闹。对企业和研究者来说，它的意义在于：帮助判断什么是底层能力，什么是耦合去绑定，什么是真正的结构化进步。',
    ],
  },
  whyNow: {
    title: '为什么现在需要它',
    bullets: [
      'AI、芯片、机器人、生命科学和能源技术正在相互交叉，过去按单一行业理解世界的方法已经不够用了。',
      '资本市场可以快速放大热点，但不能自动提供对技术本质和社会价值的判断框架。',
      '人们越来越需要一套能同时解释“技术可行性、产业意义、社会后果”的语言。',
    ],
  },
  evidence: {
    title: '为什么这不是空话，而是可验证的结构判断',
    intro:
      '物性论_HFCD_V11.10b-fix 的结果，给官网提供了一个关键支点：它把“系统为什么稳定、为什么失衡、失衡到底来自哪里”这件事，从抽象叙述推进到了可核验账本。',
    highlights: [
      {
        title: '账本被校准',
        detail:
          '实验把原始通道和派生通道分开核算，总账误差压到接近 0，说明“不能重复记光”的原则是可执行的，不只是口号。',
      },
      {
        title: '稳定不是堆能量',
        detail:
          '稳定点并不是总能量最大的点，而是 E_coupling / E_pressure_phi / E_pi_phase 达成平衡转化的点。换成普通语言：真正稳定的系统，不是资源最多，而是结构最能吸收压力并保持相干。',
      },
      {
        title: '正溢出不等于创造',
        detail:
          '实验显示许多失败点的主病灶不是“能量不够”，而是 E_coupling 去绑定。也就是说，表面上资源在增加，实际上结构约束在流失，系统只是在变松、变散、变空心。',
      },
      {
        title: '不同失败模式必须分开治理',
        detail:
          'underfill、overflow、Q_loss 不是同一种病。这个结论对应到现实产业，意味着不能用一种管理、融资或研发逻辑同时处理所有问题。',
      },
    ],
    metrics: [
      { label: 'stable 恢复', value: '6 / 36', note: '与 V11.10a 一致' },
      { label: '分类偏差', value: '0 / 36', note: '结果与前版不冲突' },
      { label: '总账校验误差', value: '≈ 10^-7', note: '账本近似闭合' },
    ],
  },
  industries: [
    {
      id: 'overview',
      title: '总论',
      oneLiner: '所有前沿行业，最后争夺的都不是“热度”，而是把高能量压进稳定结构的能力。',
      problem:
        '芯片、AI、机器人、能源、生命科学看起来是不同赛道，但它们面对的根问题其实一致：如何让越来越高密度的能量、复杂度、资本、信息与组织，不走向溢出、塌陷和失控，而是沉淀成可持续的结构。',
      shortValue:
        '科技的真正分水岭，从来不是谁更热，而是谁能把更大的能量，锁进更稳的结构。',
      longValue:
        '这就是为什么所有前沿行业最终都回到同一个问题：能量如何进入结构，结构如何保持稳定，失衡又会以什么方式出现。HFCD V11.10b-fix 给出的最重要证据，不是“跑出了几个点”，而是证明了系统稳定可以被区分、被核账、被诊断。换成产业语言，就是：真正改变世界的技术，不是那种最会制造兴奋感的技术，而是那种最能把高能量、高复杂度和高不确定性组织成长期秩序的技术。物性论的社会价值，正是在这里开始变得统一：它不是为某一个行业写的口号，而是为一整代复杂系统提供共同解释语言。',
    },
    {
      id: 'chips',
      title: '芯片行业',
      oneLiner: '芯片之争，表面是节点之争，底层是结构之争。',
      problem:
        '芯片不是单纯的制造问题，它同时牵涉算力供给、工艺节点、EDA、封装、软件生态、资本强度和国家级技术能力。',
      shortValue:
        '真正决定芯片上限的，不是某一台设备，而是能不能把整条技术链压成一个稳定结构。',
      longValue:
        'HFCD 告诉我们，资源增加并不自动等于结构形成。放到芯片行业里，这意味着设计、制造、EDA、封装和软件生态必须被压缩成同一个可持续体系，否则只会形成更昂贵的脆弱性。谁能持续提高结构吸收能力，谁才真正掌握下一代芯片竞争力。',
    },
    {
      id: 'robotics',
      title: '机器人行业',
      oneLiner: '机器人真正难的，不是会动，而是长期不散。',
      problem:
        '机器人不是单纯硬件，也不是单纯 AI，它的难点在于把感知、算法、材料、执行机构和真实世界约束连成一体。',
      shortValue:
        '机器人行业最稀缺的能力，不是多一个模型，而是让感知、决策、动作和环境反馈闭成一个活系统。',
      longValue:
        '稳定从来不是把某一项能力堆到最高，而是让多个通道进入相干结构。机器人行业同样如此：真正的突破，不在于叠更多模型，而在于让感知误差、动作补偿、材料响应与环境反馈形成闭环，并在复杂场景下维持连续结构。',
    },
    {
      id: 'ai',
      title: 'AI 行业',
      oneLiner: 'AI 最大的误判，不是模型不够强，而是结构不够稳。',
      problem:
        '今天很多 AI 讨论只停留在“模型有多强”，却忽略了部署成本、社会影响、对齐问题和产业吸收能力。',
      shortValue:
        '模型变强不等于系统变稳。AI 真正的分水岭，是谁能把算力、数据和产品沉淀成可靠结构，而不是更大的噪声。',
      longValue:
        'AI 幻觉、部署脆弱、成本失控、对齐困难，本质上都不是“能量不够”，而是“结构不够”。更多数据、更多算力和更多资本，只有沉淀成可靠的产品接口、组织流程与社会信任，才算真正进入结构化阶段。',
    },
    {
      id: 'social',
      title: '元宇宙 / 社交公司',
      oneLiner: '社交平台真正生产的，不是流量，而是社会结构。',
      problem:
        '社交和虚拟世界产品经常被只当作流量产品看待，但它们实际上持续塑造人的身份感、注意力分配和协作结构。',
      shortValue:
        '一个平台最深的产品，不是页面，而是关系；不是停留时长，而是它到底在生成秩序，还是在制造碎裂。',
      longValue:
        '系统可以看上去更活跃，却在内部持续失去结构。用户更多、互动更高、内容更炸，不代表关系更稳、信任更强、协作更有效。物性论的价值，是把“热度”重新翻译成“结构质量”。',
    },
    {
      id: 'tech',
      title: '所有科技公司',
      oneLiner: '很多公司不是死在没资源，而是死在把不同的问题当成同一种病。',
      problem:
        '很多科技公司会在增长、技术叙事和战略方向之间反复摇摆，难以区分产品层改良和底层能力积累。',
      shortValue:
        '科技公司最贵的成本，往往不是投入不够，而是持续误诊。物性论的价值，就是把问题拆清楚，再决定哪里该下重手。',
      longValue:
        'overflow、underfill、Q_loss 不是同一种病，科技公司现实里也是一样。有的公司增长太快但结构松了，有的资源不够但方向对，有的组织耦合断裂。把问题拆成可判断、可排序、可治理的结构，才可能停止烧钱式误诊。',
    },
    {
      id: 'materials-quantum',
      title: '材料科学 / 量子计算',
      oneLiner: '材料和量子领域最需要的，不是神话，而是更早看见真正的结构突破。',
      problem:
        '材料和量子方向往往周期长、门槛高、商业化慢，容易在资本叙事中被高估或误读。',
      shortValue:
        '真正改变世界的底层突破，往往不是最会发新闻的突破，而是最先改写结构边界的突破。',
      longValue:
        '这类行业最大的难点，是技术太深、周期太长、试错太贵。物性论的价值，是把判断标准往前推进：一个新材料体系或量子方向，是否真的改写了结构边界，而不是只在单点指标上短暂冒尖。',
    },
    {
      id: 'energy',
      title: '能源公司（含核聚变）',
      oneLiner: '能源问题的终局，不是把能量做大，而是把能量锁稳。',
      problem:
        '无论是 AI、机器人、制造业还是城市系统，背后都受制于能源密度、供给稳定性和成本。',
      shortValue:
        '真正决定未来的，不是谁先释放更大能量，而是谁先学会把高密度能量稳定地锁进长期结构。',
      longValue:
        'energy_surplus_overflow 不是胜利，而是失控的前夜。能源行业尤其核聚变，真正的难点从来不只是“制造更大能量”，而是把高密度能量稳定约束、持续输出并可扩展治理。',
    },
    {
      id: 'safety',
      title: 'AI 安全 / 对齐',
      oneLiner: '安全最大的短板，不是规则太少，而是诊断太粗。',
      problem:
        '对齐如果只被理解成模型行为约束，就会低估它与治理结构、激励机制和部署环境之间的关系。',
      shortValue:
        '真正危险的，不是系统犯了一次错，而是人类根本没看清它会以哪种方式失控。',
      longValue:
        '系统崩坏从来不是一种单一病因。underfill、overflow、耦合去绑定与结构边际塌陷，本质都不同。物性论把安全从补丁式约束，推向目标函数、反馈回路、激励机制和部署环境的整体诊断。',
    },
    {
      id: 'bio',
      title: '生命科学和医药',
      oneLiner: '真正有效的治疗，不是粗暴拉指标，而是让系统重新回稳。',
      problem:
        '生命科学高度复杂，很多干预并不是“发现一个靶点”就结束，而是牵涉系统反馈、长期副作用和个体差异。',
      shortValue:
        '生命科学最难的，不是命中一个点，而是让整个生命网络重新进入更高质量的稳定状态。',
      longValue:
        '生命系统本质上就是高度复杂的能量-结构耦合网络。真正有效的疗法，不只是改变某个指标，而是帮助生命系统重新回到更高质量的稳定状态。这正是物性论对生物医学研发最有价值的切口。',
    },
  ],
  experiment: {
    title: '实验与持续迭代',
    intro:
      '物性论不是一套已经封闭完成的文本，而是一个持续演进的理论系统。它会随着实践、反馈和实验不断被校正、压缩和推进。',
    featured: {
      name: '物性论_HFCD_实验',
      status: '迭代中',
      summary:
        '这是一个围绕“能量如何进入结构、结构如何保持稳定、失衡如何被分类诊断”展开的持续实验，用来测试物性论是否真的能成为解析复杂系统的通用框架。',
      next:
        '后续官网将持续记录实验目标、阶段性发现、失败模式分化和新的版本演进，例如从 V11.10b-fix 进入 V11.10c 的耦合-相干转化器。',
    },
  },
  book: {
    title: '进一步阅读',
    body:
      '如果你希望从更完整的文本系统理解物性论，可以直接阅读书籍试读版本。官网负责把理论讲清楚，书籍负责把系统展开。',
    href: AMAZON_SAMPLE_URL,
  },
  faq: [
    {
      q: '物性论是不是哲学？',
      a: '它不是停留在抽象概念上的哲学，而是一套试图解释技术、产业与社会结构关系的认知框架。',
    },
    {
      q: '为什么它能同时讨论芯片、AI、能源和生命科学？',
      a: '因为这些领域正在共同塑造技术文明的底层能力。物性论关注的不是某个孤立行业，而是能力之间的耦合关系。',
    },
    {
      q: '它是不是已经定型？',
      a: '不是。物性论仍在持续迭代，实验、修正和版本推进本身就是体系的一部分。',
    },
    {
      q: '我应该先读官网还是先读书？',
      a: '建议先读官网建立整体理解，再进入书籍系统化阅读。',
    },
  ],
};

const en: OfficialSiteContent = {
  seo: {
    title: 'Thing-Nature Official Site | Explain technology, industry, and social value in plain language',
    description:
      'Thing-Nature is a cognitive framework for explaining how technology evolution, industrial change, and social value are coupled. Understand its relevance to chips, robotics, AI, energy, and life science.',
    image: OG_IMAGE_URL,
  },
  hero: {
    badge: 'Thing-Nature Official Site',
    title: 'One core question: how does chaotic energy become stable structure?',
    subtitle:
      'The meaning of HFCD V11.10b-fix is not only that six stable states were recovered. It forced a larger question onto the table: what kind of system can lock violent energy into durable order? Thing-Nature tries to offer a general language for how disorder turns into order.',
    primaryCta: { label: 'Read Amazon sample', href: AMAZON_SAMPLE_URL },
    secondaryCta: { label: 'See industry value', href: '#industries' },
  },
  definition: {
    title: 'What is Thing-Nature',
    paragraphs: [
      'Thing-Nature can be understood as a universal key for reading complex systems. It does not stop at whether a product works. It keeps asking why a system stays stable, why it loses balance, why energy overflows, and why structure collapses.',
      'For ordinary readers, it helps separate technologies that truly change society from those that merely look noisy and fashionable. For companies and researchers, it offers a way to distinguish foundational capability from decoupled expansion and real structural progress from surface heat.',
    ],
  },
  whyNow: {
    title: 'Why now',
    bullets: [
      'AI, semiconductors, robotics, life science, and energy are increasingly entangled. A single-industry lens is no longer enough.',
      'Capital can amplify excitement very quickly, but it cannot automatically provide a framework for judging technical essence and social value.',
      'We increasingly need a language that can explain technological feasibility, industrial meaning, and social consequence at the same time.',
    ],
  },
  evidence: {
    title: 'Why this is not empty rhetoric but a testable structural judgment',
    intro:
      'The results of Thing-Nature_HFCD_V11.10b-fix provide a crucial anchor: the question of why systems stabilize, lose balance, or fail moved from abstract narrative into an auditable ledger.',
    highlights: [
      {
        title: 'The ledger was calibrated',
        detail:
          'The experiment separated raw channels from derived channels and drove total-account error close to zero. The principle of not double-counting light is therefore executable, not just poetic language.',
      },
      {
        title: 'Stability is not energy stacking',
        detail:
          'Stable points were not the points with the highest total energy. They were the points where coupling, pressure, and phase channels converted into balance together. In ordinary language, stable systems are not the richest systems, but the systems that absorb pressure coherently.',
      },
      {
        title: 'Positive overflow is not creation',
        detail:
          'Many failed points were not short of energy. Their primary failure mode was coupling loss. Apparent growth in resources was accompanied by a structural hollowing-out.',
      },
      {
        title: 'Failure modes must be governed separately',
        detail:
          'Underfill, overflow, and Q-loss are not the same disease. In industry, that means one financing, management, or R&D logic cannot responsibly solve every problem.',
      },
    ],
    metrics: [
      { label: 'stable recoveries', value: '6 / 36', note: 'consistent with V11.10a' },
      { label: 'classification drift', value: '0 / 36', note: 'no conflict with prior version' },
      { label: 'ledger error', value: '≈ 10^-7', note: 'ledger nearly closed' },
    ],
  },
  industries: [
    {
      id: 'overview',
      title: 'Overview',
      oneLiner: 'Across frontier industries, the decisive competition is never heat. It is the ability to compress high energy into stable structure.',
      problem:
        'Chips, AI, robotics, energy, and life science look like different tracks, yet their root problem is shared: can rising energy, complexity, capital, information, and organization settle into durable structure instead of overflow and collapse?',
      shortValue: 'The real technological divide is not who is hotter, but who can lock greater energy into a steadier structure.',
      longValue:
        'This is why frontier industries keep returning to one shared question: how does energy enter structure, how does structure remain stable, and how do different forms of imbalance appear? HFCD V11.10b-fix matters because it shows stability can be distinguished, audited, and diagnosed rather than merely admired in hindsight.',
    },
    {
      id: 'chips',
      title: 'Semiconductors',
      oneLiner: 'Chip competition looks like node competition on the surface, but underneath it is structural competition.',
      problem:
        'Chips are not only about fabrication. They involve compute supply, process nodes, EDA, packaging, software ecosystems, capital intensity, and national-level technical capability.',
      shortValue: 'The ceiling of a chip ecosystem is set not by one machine, but by whether the whole chain can be compressed into one stable structure.',
      longValue:
        'Resources do not automatically turn into structure. In semiconductors, design strength without manufacturing stability, packaging without software follow-through, or materials progress without EDA autonomy only creates more expensive fragility.',
    },
    {
      id: 'robotics',
      title: 'Robotics',
      oneLiner: 'The real difficulty in robotics is not moving once, but staying coherent over time.',
      problem:
        'Robotics is neither pure hardware nor pure AI. The hard part is integrating perception, algorithms, materials, actuation, and real-world constraints into one living system.',
      shortValue: 'The scarce capability is not one more model. It is a closed loop between sensing, decision, action, and environment.',
      longValue:
        'A robot can look impressive by stacking more sensors and larger models, yet remain structurally weak. The meaningful breakthrough is when sensing error, action compensation, material response, and environmental feedback become one coherent loop that survives the real world.',
    },
    {
      id: 'ai',
      title: 'AI',
      oneLiner: 'AI’s biggest misreading is not weak models, but weak structure.',
      problem:
        'Many AI conversations stop at model power while ignoring deployment cost, social absorption, alignment difficulty, and operational trust.',
      shortValue: 'A stronger model does not automatically mean a stronger system. The real divide is whether compute, data, and product can sediment into reliable structure.',
      longValue:
        'Hallucination, brittle deployment, runaway cost, and alignment difficulty are not fundamentally signs of insufficient energy. They are signs of insufficient structure. More data and more capital only matter if they settle into reliable products, interfaces, organizations, and trust.',
    },
    {
      id: 'social',
      title: 'Metaverse / Social Platforms',
      oneLiner: 'Social platforms do not really manufacture traffic. They manufacture social structure.',
      problem:
        'Social and virtual-world products are often treated as traffic businesses, but in practice they continually shape identity, attention, and collaboration.',
      shortValue: 'The deepest product of a platform is not the page, but the relationship structure it generates.',
      longValue:
        'A platform can look more active while losing structure inside. More users, more interaction, and more explosive content do not necessarily mean stronger relationships, trust, or cooperation. Thing-Nature reframes heat as structural quality.',
    },
    {
      id: 'tech',
      title: 'Technology Companies',
      oneLiner: 'Many companies do not die from lack of resources. They die from treating different failures as the same disease.',
      problem:
        'Technology companies often swing between growth, technical storytelling, and strategy without clearly separating product iteration from foundational capability accumulation.',
      shortValue: 'The most expensive cost is often not under-investment, but chronic misdiagnosis.',
      longValue:
        'Overflow, underfill, and Q-loss require different responses. Some companies are growing too fast with soft structure, some are structurally sound but resource-poor, and some are simply losing coupling across teams and products. Diagnosis must come before intervention.',
    },
    {
      id: 'materials-quantum',
      title: 'Materials Science / Quantum Computing',
      oneLiner: 'These fields need fewer myths and earlier recognition of real structural breakthroughs.',
      problem:
        'Materials and quantum fields are long-cycle, high-threshold, and expensive to commercialize, which makes them easy to overhype or dismiss too early.',
      shortValue: 'Breakthroughs that change the world are usually not the breakthroughs that make the loudest headlines. They are the ones that shift structural boundaries earliest.',
      longValue:
        'Thing-Nature pushes judgment forward: a new material system or quantum path matters when it changes a structural boundary, not when it produces one brief spike in a narrow metric.',
    },
    {
      id: 'energy',
      title: 'Energy (including fusion)',
      oneLiner: 'The endgame of energy is not making energy larger. It is locking energy into stable structure.',
      problem:
        'AI, robotics, manufacturing, and urban systems are all constrained by energy density, stability of supply, and cost.',
      shortValue: 'The future belongs not to whoever releases more energy first, but to whoever learns to stabilize denser energy over time.',
      longValue:
        'Energy surplus overflow is not victory. It is a warning. In energy and especially fusion, the hard part is not merely releasing more energy, but constraining, sustaining, and governing high-density energy in a scalable way.',
    },
    {
      id: 'safety',
      title: 'AI Safety / Alignment',
      oneLiner: 'The weakest link in safety is not too few rules. It is diagnosis that is too coarse.',
      problem:
        'If alignment is reduced to model behavior constraints, the relation to governance, incentives, and deployment context is underestimated.',
      shortValue: 'The real danger is not one mistake. It is failing to see how a system is likely to fail at all.',
      longValue:
        'System breakdown never has one single cause. Underfill, overflow, coupling loss, and structural collapse are different conditions. Thing-Nature turns safety from patching behavior into diagnosing goals, loops, incentives, and deployment conditions.',
    },
    {
      id: 'bio',
      title: 'Life Science and Medicine',
      oneLiner: 'Effective treatment is not brutal metric manipulation. It is helping the system return to stable order.',
      problem:
        'Life science is highly complex. Many interventions involve not only a target, but also systemic feedback, long-term side effects, and inter-individual variation.',
      shortValue: 'The real difficulty is not hitting one point, but helping the wider life network return to higher-quality stability.',
      longValue:
        'A living system is a dense energy-structure coupling network. Truly good therapies do more than move one indicator. They help the whole system recover a better stable state. That is where Thing-Nature becomes useful for biomedical judgment.',
    },
  ],
  experiment: {
    title: 'Experiment and ongoing iteration',
    intro:
      'Thing-Nature is not a sealed text. It is a theory system that keeps evolving through practice, feedback, and experiment.',
    featured: {
      name: 'Thing-Nature_HFCD_Experiment',
      status: 'In iteration',
      summary:
        'This is a continuing experiment around how energy enters structure, how structure stays stable, and how failure modes can be classified and diagnosed.',
      next:
        'The official site will keep recording experiment goals, stage findings, differentiated failure modes, and version progress, such as the move from V11.10b-fix toward V11.10c.',
    },
  },
  book: {
    title: 'Further reading',
    body:
      'If you want the full textual system behind Thing-Nature, start with the book sample. The site clarifies the theory; the book unfolds the larger structure.',
    href: AMAZON_SAMPLE_URL,
  },
  faq: [
    {
      q: 'Is Thing-Nature philosophy?',
      a: 'It is not philosophy in the sense of staying at abstract concepts. It is a framework for explaining the relation between technology, industry, and social structure.',
    },
    {
      q: 'Why can it discuss chips, AI, energy, and life science together?',
      a: 'Because these domains are jointly shaping the foundational capabilities of technological civilization. Thing-Nature focuses on the coupling between capabilities, not on isolated sectors.',
    },
    {
      q: 'Is it already complete?',
      a: 'No. Thing-Nature is still evolving, and experiment, correction, and version progression are part of the system itself.',
    },
    {
      q: 'Should I read the site first or the book first?',
      a: 'Start with the official site for orientation, then move into the book for the full system.',
    },
  ],
};

const fr: OfficialSiteContent = {
  seo: {
    title: 'Site officiel Thing-Nature | Expliquer technologie, industrie et valeur sociale',
    description:
      'Thing-Nature est un cadre cognitif pour expliquer le couplage entre evolution technologique, transformation industrielle et valeur sociale.',
    image: OG_IMAGE_URL,
  },
  hero: {
    badge: 'Site officiel Thing-Nature',
    title: 'Une question centrale : comment l energie chaotique devient-elle structure stable ?',
    subtitle:
      'HFCD V11.10b-fix ne vaut pas seulement pour six etats stables retrouves. Il oblige a poser une question plus grande : quel type de systeme peut enfermer une energie violente dans un ordre durable ?',
    primaryCta: { label: 'Lire l extrait Amazon', href: AMAZON_SAMPLE_URL },
    secondaryCta: { label: 'Voir la valeur industrielle', href: '#industries' },
  },
  definition: {
    title: 'Qu est-ce que Thing-Nature',
    paragraphs: [
      'Thing-Nature peut etre compris comme une cle generale pour lire les systemes complexes. Il ne demande pas seulement si un produit fonctionne, mais pourquoi un systeme reste stable, perd son equilibre, deborde en energie ou s effondre en structure.',
      'Pour le public, cela aide a distinguer les technologies qui transforment vraiment la societe de celles qui ne produisent qu une agitation passagere. Pour les entreprises et les chercheurs, cela aide a reconnaitre la capacite fondamentale, le decouplage et le vrai progres structurel.',
    ],
  },
  whyNow: {
    title: 'Pourquoi maintenant',
    bullets: [
      'L IA, les semi-conducteurs, la robotique, les sciences du vivant et l energie se croisent de plus en plus. Un regard mono-industrie ne suffit plus.',
      'Les marches de capitaux amplifient vite les themes chauds, mais ils ne fournissent pas automatiquement une grille de jugement sur l essence technique et la valeur sociale.',
      'Nous avons besoin d un langage capable de parler en meme temps de faisabilite technique, de sens industriel et de consequence sociale.',
    ],
  },
  evidence: {
    title: 'Pourquoi ce n est pas un slogan mais un jugement structurel verifiable',
    intro:
      'Les resultats de Thing-Nature_HFCD_V11.10b-fix offrent un point d appui : la question de la stabilite et du desequilibre des systemes passe d un recit abstrait a un registre auditable.',
    highlights: [
      { title: 'Le registre a ete calibre', detail: 'Les canaux bruts et derives ont ete comptes separement et l erreur totale a ete poussee pres de zero.' },
      { title: 'La stabilite n est pas un empilement d energie', detail: 'Les points stables ne sont pas les points d energie maximale, mais les points ou plusieurs canaux se convertissent en equilibre coherent.' },
      { title: 'Le debordement positif n est pas creation', detail: 'De nombreux echec n etaient pas dus a un manque d energie mais a une perte de couplage et donc a un creusement structurel.' },
      { title: 'Les modes d echec doivent etre traites separement', detail: 'Underfill, overflow et Q-loss ne sont pas la meme maladie. Ils exigent des reponses differenciees.' },
    ],
    metrics: [
      { label: 'retours stables', value: '6 / 36', note: 'coherent avec V11.10a' },
      { label: 'derive de classification', value: '0 / 36', note: 'sans conflit avec la version precedente' },
      { label: 'erreur du registre', value: '≈ 10^-7', note: 'registre presque ferme' },
    ],
  },
  industries: [
    { id: 'overview', title: 'Vue d ensemble', oneLiner: 'Dans les industries de pointe, la vraie competition n est jamais la chaleur, mais la capacite a comprimer une energie elevee dans une structure stable.', problem: 'Semi-conducteurs, IA, robotique, energie et sciences du vivant paraissent separes, mais leur probleme racine est identique : que deviennent l energie, la complexite, le capital et l organisation lorsqu ils essaient de se sedimenter en ordre durable ?', shortValue: 'La vraie ligne de partage technologique n est pas qui est plus chaud, mais qui peut verrouiller plus d energie dans une structure plus stable.', longValue: 'Toutes les industries de pointe reviennent au meme probleme : comment l energie entre dans la structure, comment la structure reste stable et comment les desequilibres apparaissent. HFCD montre que la stabilite peut etre distinguée, auditee et diagnostiquee.' },
    { id: 'chips', title: 'Semi-conducteurs', oneLiner: 'La bataille des puces ressemble a une bataille de noeuds, mais au fond c est une bataille de structure.', problem: 'Les puces impliquent calcul, fabrication, EDA, packaging, logiciel, capital et capacite technique souveraine.', shortValue: 'Le plafond d un ecosysteme de puces depend de la capacite a comprimer toute la chaine en une structure stable.', longValue: 'Des ressources supplementaires ne deviennent pas automatiquement structure. Sans chaine coherente entre conception, fabrication, EDA, packaging et logiciel, on produit surtout de la fragilite couteuse.' },
    { id: 'robotics', title: 'Robotique', oneLiner: 'La difficulte reelle n est pas de bouger une fois, mais de rester coherent dans le temps.', problem: 'La robotique doit integrer perception, algorithmes, materiaux, actionneurs et contraintes du monde reel.', shortValue: 'La capacite rare n est pas un modele de plus, mais une boucle fermee entre perception, decision, action et environnement.', longValue: 'Le progres significatif arrive quand l erreur de perception, la compensation motrice, la reponse materielle et le retour du monde reel deviennent une meme boucle coherente.' },
    { id: 'ai', title: 'IA', oneLiner: 'La plus grande erreur de lecture de l IA n est pas la faiblesse du modele, mais la faiblesse de la structure.', problem: 'Beaucoup de discussions sur l IA s arretent a la puissance du modele sans traiter les couts, l alignement, l absorption sociale et la confiance operationnelle.', shortValue: 'Un modele plus fort ne signifie pas un systeme plus fort. La vraie question est la sedimentation en structure fiable.', longValue: 'Hallucinations, deploiement fragile, couts fugitifs et difficultes d alignement sont surtout des signes de structure insuffisante. Les donnees et le capital ne comptent que s ils deviennent produit, interface, organisation et confiance.' },
    { id: 'social', title: 'Metavers / plateformes sociales', oneLiner: 'Les plateformes sociales ne produisent pas vraiment du trafic ; elles produisent de la structure sociale.', problem: 'Les produits sociaux et virtuels sont souvent traites comme de simples machines a trafic alors qu ils reforment l identite, l attention et la cooperation.', shortValue: 'Le produit le plus profond d une plateforme n est pas la page, mais la structure relationnelle qu elle fabrique.', longValue: 'Une plateforme peut sembler plus active tout en perdant de la structure. Plus d utilisateurs et plus d interactions ne signifient pas necessairement plus de confiance ou de cooperation.' },
    { id: 'tech', title: 'Entreprises technologiques', oneLiner: 'Beaucoup d entreprises ne meurent pas d un manque de ressources, mais d un mauvais diagnostic chronique.', problem: 'Les entreprises technologiques oscillent entre croissance, narration technique et strategie sans distinguer iteration produit et accumulation de capacite fondamentale.', shortValue: 'Le cout le plus cher n est souvent pas le sous-investissement, mais la confusion des maladies.', longValue: 'Overflow, underfill et Q-loss exigent des reponses differentes. Certaines entreprises croissent trop vite avec une structure molle, d autres sont justes structurellement mais manquent de ressources, d autres encore perdent le couplage entre equipes et produits.' },
    { id: 'materials-quantum', title: 'Materiaux / calcul quantique', oneLiner: 'Ces domaines ont besoin de moins de mythes et de plus de reconnaissance precoce des vraies ruptures structurelles.', problem: 'Les cycles sont longs, les barrieres hautes et la commercialisation couteuse, ce qui invite a la survalorisation ou au rejet premature.', shortValue: 'Les ruptures qui changent le monde sont rarement celles qui produisent le plus de bruit mediatique.', longValue: 'Thing-Nature avance le criter[e] de jugement : un nouveau systeme materiel ou une voie quantique compte lorsqu il deplace une frontiere structurelle, pas lorsqu il produit un pic temporaire sur un seul indicateur.' },
    { id: 'energy', title: 'Energie (y compris fusion)', oneLiner: 'La fin du probleme energetique n est pas de produire plus d energie, mais de la verrouiller dans une structure stable.', problem: 'IA, robotique, fabrication et villes sont toutes contraintes par la densite energetique, la stabilite d approvisionnement et le cout.', shortValue: 'L avenir appartient non pas a celui qui libere le plus d energie d abord, mais a celui qui sait stabiliser une energie plus dense dans le temps.', longValue: 'Le debordement d energie n est pas une victoire, mais un avertissement. En energie et surtout en fusion, la difficulte est de contraindre, soutenir et gouverner une energie de forte densite.' },
    { id: 'safety', title: 'Securite IA / alignement', oneLiner: 'Le maillon faible de la securite n est pas le manque de regles, mais un diagnostic trop grossier.', problem: 'Si l alignement est reduit a des contraintes de comportement, on sous-estime son lien avec gouvernance, incentives et contexte de deploiement.', shortValue: 'Le vrai danger n est pas une seule erreur, mais l incapacité a voir comment un systeme va vraisemblablement echouer.', longValue: 'L effondrement systemique n a jamais une cause unique. Thing-Nature transforme la securite d un patch comportemental en un diagnostic des objectifs, boucles, incentives et conditions de deploiement.' },
    { id: 'bio', title: 'Sciences du vivant et medecine', oneLiner: 'Un bon traitement ne consiste pas a forcer un indicateur, mais a aider le systeme a revenir a la stabilite.', problem: 'Les interventions biologiques impliquent non seulement une cible, mais aussi des boucles de retour, des effets secondaires et des variations individuelles.', shortValue: 'La difficulte reelle n est pas de toucher un seul point, mais d aider le reseau vital a retrouver une stabilite de meilleure qualite.', longValue: 'Le vivant est un reseau dense de couplage energie-structure. Une bonne therapie ne deplace pas seulement un chiffre ; elle aide le systeme entier a retrouver un meilleur etat stable.' },
  ],
  experiment: { title: 'Experience et iteration continue', intro: 'Thing-Nature n est pas un texte ferme. C est un systeme theorique qui evolue par pratique, retour et experimentation.', featured: { name: 'Experience Thing-Nature_HFCD', status: 'En iteration', summary: 'Une experience continue sur l entree de l energie dans la structure, la stabilite de la structure et la differentiation des modes d echec.', next: 'Le site officiel continuera de publier les objectifs d experience, les resultats d etape et les progres de version.' } },
  book: { title: 'Lire plus', body: 'Si vous voulez le systeme textuel complet, commencez par l extrait du livre. Le site clarifie la theorie ; le livre deploie l architecture plus large.', href: AMAZON_SAMPLE_URL },
  faq: [
    { q: 'Thing-Nature est-il une philosophie ?', a: 'Pas au sens d un discours abstrait uniquement. C est un cadre pour expliquer les rapports entre technologie, industrie et structure sociale.' },
    { q: 'Pourquoi peut-il parler ensemble des puces, de l IA, de l energie et des sciences du vivant ?', a: 'Parce que ces domaines fabriquent ensemble les capacites fondamentales de la civilisation technologique.' },
    { q: 'Le systeme est-il deja complet ?', a: 'Non. Il evolue encore, et l experimentation fait partie du systeme.' },
    { q: 'Faut-il lire d abord le site ou le livre ?', a: 'Le site pour s orienter, puis le livre pour la structure complete.' },
  ],
};

const es: OfficialSiteContent = {
  seo: {
    title: 'Sitio oficial de Thing-Nature | Explicar tecnologia, industria y valor social',
    description:
      'Thing-Nature es un marco cognitivo para explicar como se acoplan la evolucion tecnologica, el cambio industrial y el valor social.',
    image: OG_IMAGE_URL,
  },
  hero: {
    badge: 'Sitio oficial de Thing-Nature',
    title: 'Una pregunta central: como se convierte la energia caotica en estructura estable?',
    subtitle:
      'HFCD V11.10b-fix no importa solo por recuperar seis estados estables. Obliga a formular una pregunta mayor: que tipo de sistema puede encerrar energia violenta dentro de un orden duradero?',
    primaryCta: { label: 'Leer muestra de Amazon', href: AMAZON_SAMPLE_URL },
    secondaryCta: { label: 'Ver valor industrial', href: '#industries' },
  },
  definition: {
    title: 'Que es Thing-Nature',
    paragraphs: [
      'Thing-Nature puede entenderse como una llave general para leer sistemas complejos. No se queda en si un producto funciona, sino que sigue preguntando por que un sistema se estabiliza, se desequilibra, desborda energia o colapsa estructuralmente.',
      'Para el publico, ayuda a distinguir entre tecnologias que cambian de verdad la sociedad y tecnologias que solo producen ruido. Para empresas e investigadores, ayuda a distinguir capacidad fundacional, desacople y progreso estructural real.',
    ],
  },
  whyNow: {
    title: 'Por que ahora',
    bullets: [
      'IA, chips, robotica, ciencias de la vida y energia se cruzan cada vez mas. Una mirada de una sola industria ya no basta.',
      'El capital amplifica la excitacion muy rapido, pero no ofrece por si solo un marco para juzgar esencia tecnica y valor social.',
      'Hace falta un lenguaje que hable al mismo tiempo de viabilidad tecnica, sentido industrial y consecuencia social.',
    ],
  },
  evidence: {
    title: 'Por que esto no es retorica vacia sino un juicio estructural comprobable',
    intro:
      'Los resultados de Thing-Nature_HFCD_V11.10b-fix ofrecen un punto de apoyo crucial: la cuestion de por que los sistemas se estabilizan o se desequilibran paso de la narracion abstracta a un libro mayor auditable.',
    highlights: [
      { title: 'El libro mayor fue calibrado', detail: 'Los canales brutos y derivados se contabilizaron por separado y el error total se llevo cerca de cero.' },
      { title: 'La estabilidad no es apilar energia', detail: 'Los puntos estables no fueron los de energia total maxima, sino los puntos donde varios canales se convertian juntos en equilibrio coherente.' },
      { title: 'El desborde positivo no es creacion', detail: 'Muchos fallos no provenian de falta de energia, sino de perdida de acoplamiento y vaciamiento estructural.' },
      { title: 'Los modos de fallo deben gobernarse por separado', detail: 'Underfill, overflow y Q-loss no son la misma enfermedad; exigen respuestas distintas.' },
    ],
    metrics: [
      { label: 'recuperaciones estables', value: '6 / 36', note: 'coherente con V11.10a' },
      { label: 'deriva de clasificacion', value: '0 / 36', note: 'sin conflicto con la version previa' },
      { label: 'error del libro mayor', value: '≈ 10^-7', note: 'libro mayor casi cerrado' },
    ],
  },
  industries: [
    { id: 'overview', title: 'Vision general', oneLiner: 'En las industrias de frontera, la competencia decisiva no es el calor del momento, sino la capacidad de comprimir alta energia en estructura estable.', problem: 'Chips, IA, robotica, energia y ciencias de la vida parecen sectores distintos, pero comparten la misma pregunta de fondo: que ocurre cuando energia, complejidad, capital e informacion intentan sedimentarse en orden duradero?', shortValue: 'La verdadera linea divisoria no es quien esta mas caliente, sino quien puede encerrar mas energia en una estructura mas estable.', longValue: 'Todas las industrias de frontera vuelven a la misma cuestion: como entra la energia en la estructura, como se mantiene estable y como aparecen los desequilibrios. HFCD demuestra que la estabilidad puede distinguirse, auditarse y diagnosticarse.' },
    { id: 'chips', title: 'Semiconductores', oneLiner: 'La competencia de chips parece una competencia de nodos, pero debajo es una competencia de estructura.', problem: 'Los chips implican computo, fabricacion, EDA, empaquetado, software, capital y capacidad tecnica soberana.', shortValue: 'El techo de un ecosistema de chips depende de si toda la cadena puede comprimirse en una estructura estable.', longValue: 'Mas recursos no se convierten automaticamente en estructura. Sin coherencia entre diseno, fabricacion, EDA, empaquetado y software, lo que aparece es una fragilidad mas cara.' },
    { id: 'robotics', title: 'Robotica', oneLiner: 'La dificultad real no es moverse una vez, sino mantener coherencia en el tiempo.', problem: 'La robotica debe integrar percepcion, algoritmos, materiales, actuacion y restricciones del mundo real.', shortValue: 'La capacidad escasa no es un modelo mas, sino un bucle cerrado entre percepcion, decision, accion y entorno.', longValue: 'El avance significativo llega cuando el error de percepcion, la compensacion de movimiento, la respuesta material y la retroalimentacion del entorno se convierten en un mismo circuito coherente.' },
    { id: 'ai', title: 'IA', oneLiner: 'La mayor mala lectura de la IA no es un modelo debil, sino una estructura debil.', problem: 'Muchas conversaciones sobre IA se detienen en la potencia del modelo e ignoran costes, alineacion, absorcion social y confianza operativa.', shortValue: 'Un modelo mas fuerte no significa automaticamente un sistema mas fuerte. La pregunta real es si computo, datos y producto sedimentan en estructura fiable.', longValue: 'Alucinacion, despliegue fragil, coste desbocado y dificultad de alineacion son signos de estructura insuficiente. Datos y capital solo importan si se transforman en producto, interfaz, organizacion y confianza.' },
    { id: 'social', title: 'Metaverso / plataformas sociales', oneLiner: 'Las plataformas sociales no fabrican realmente trafico; fabrican estructura social.', problem: 'Los productos sociales y virtuales suelen tratarse como negocios de trafico, aunque en realidad reforman identidad, atencion y cooperacion.', shortValue: 'El producto mas profundo de una plataforma no es la pagina, sino la estructura relacional que produce.', longValue: 'Una plataforma puede parecer mas activa mientras pierde estructura por dentro. Mas usuarios e interaccion no significan necesariamente mas confianza o cooperacion.' },
    { id: 'tech', title: 'Empresas tecnologicas', oneLiner: 'Muchas empresas no mueren por falta de recursos, sino por diagnosticar mal de manera cronica.', problem: 'Las empresas tecnologicas oscilan entre crecimiento, relato tecnico y estrategia sin separar iteracion de producto y acumulacion de capacidad fundacional.', shortValue: 'El coste mas caro no suele ser invertir poco, sino confundir enfermedades distintas.', longValue: 'Overflow, underfill y Q-loss requieren respuestas diferentes. Algunas empresas crecen demasiado rapido con estructura blanda; otras estan bien estructuradas pero carecen de recursos; otras pierden acoplamiento entre equipos y productos.' },
    { id: 'materials-quantum', title: 'Materiales / computacion cuantica', oneLiner: 'Estos campos necesitan menos mitos y mas reconocimiento temprano de rupturas estructurales reales.', problem: 'Los ciclos son largos, las barreras altas y la comercializacion costosa, lo que favorece tanto la sobrevaloracion como el descarte prematuro.', shortValue: 'Las rupturas que cambian el mundo rara vez son las que hacen mas ruido mediatico.', longValue: 'Thing-Nature adelanta el criterio de juicio: un nuevo sistema material o una via cuantica importa cuando desplaza un limite estructural, no cuando produce un pico temporal en un solo indicador.' },
    { id: 'energy', title: 'Energia (incluida fusion)', oneLiner: 'El final del problema energetico no es producir mas energia, sino fijarla dentro de estructura estable.', problem: 'IA, robotica, fabricacion y ciudades dependen de densidad energetica, estabilidad de suministro y coste.', shortValue: 'El futuro pertenece no a quien libera mas energia primero, sino a quien sabe estabilizar energia mas densa en el tiempo.', longValue: 'El desborde de energia no es una victoria, sino una advertencia. En energia y especialmente en fusion, la dificultad es contener, sostener y gobernar energia de alta densidad.' },
    { id: 'safety', title: 'Seguridad de IA / alineacion', oneLiner: 'El eslabon mas debil de la seguridad no es la falta de reglas, sino un diagnostico demasiado grueso.', problem: 'Si la alineacion se reduce a restricciones de conducta, se subestima su relacion con gobernanza, incentivos y contexto de despliegue.', shortValue: 'El peligro real no es un solo error, sino no ver de que forma es probable que falle el sistema.', longValue: 'El colapso sistemico nunca tiene una sola causa. Thing-Nature convierte la seguridad de un parche conductual en un diagnostico de objetivos, bucles, incentivos y condiciones de despliegue.' },
    { id: 'bio', title: 'Ciencias de la vida y medicina', oneLiner: 'Un buen tratamiento no consiste en forzar un indicador, sino en ayudar al sistema a volver a la estabilidad.', problem: 'Las intervenciones biologicas implican no solo una diana, sino tambien retroalimentaciones, efectos secundarios y variacion individual.', shortValue: 'La dificultad real no es tocar un punto, sino ayudar a toda la red de la vida a volver a una estabilidad de mayor calidad.', longValue: 'La vida es una red densa de acoplamiento energia-estructura. Una buena terapia no solo mueve un numero; ayuda al sistema entero a recuperar un mejor estado estable.' },
  ],
  experiment: { title: 'Experimento e iteracion continua', intro: 'Thing-Nature no es un texto cerrado. Es un sistema teorico que evoluciona mediante practica, retroalimentacion y experimentacion.', featured: { name: 'Experimento Thing-Nature_HFCD', status: 'En iteracion', summary: 'Un experimento continuo sobre como la energia entra en estructura, como la estructura se mantiene estable y como pueden diferenciarse los modos de fallo.', next: 'El sitio seguira publicando objetivos experimentales, hallazgos por etapas y progreso de versiones.' } },
  book: { title: 'Lectura adicional', body: 'Si quieres el sistema textual completo, empieza por la muestra del libro. El sitio aclara la teoria; el libro despliega la arquitectura completa.', href: AMAZON_SAMPLE_URL },
  faq: [
    { q: 'Thing-Nature es filosofia?', a: 'No en el sentido de quedarse solo en conceptos abstractos. Es un marco para explicar la relacion entre tecnologia, industria y estructura social.' },
    { q: 'Por que puede hablar de chips, IA, energia y ciencias de la vida a la vez?', a: 'Porque estos dominios construyen juntos las capacidades fundamentales de la civilizacion tecnologica.' },
    { q: 'El sistema ya esta completo?', a: 'No. Sigue evolucionando y la experimentacion forma parte del propio sistema.' },
    { q: 'Conviene leer primero el sitio o el libro?', a: 'Primero el sitio para orientarte; luego el libro para la estructura completa.' },
  ],
};

const vi: OfficialSiteContent = {
  seo: {
    title: 'Trang chính thức Thing-Nature | Giải thích công nghệ, công nghiệp và giá trị xã hội',
    description:
      'Thing-Nature là một khung nhận thức để giải thích cách tiến hóa công nghệ, biến đổi công nghiệp và giá trị xã hội được liên kết với nhau.',
    image: OG_IMAGE_URL,
  },
  hero: {
    badge: 'Trang chính thức Thing-Nature',
    title: 'Một câu hỏi trung tâm: năng lượng hỗn loạn làm thế nào trở thành cấu trúc ổn định?',
    subtitle:
      'HFCD V11.10b-fix không chỉ có ý nghĩa vì khôi phục được sáu trạng thái ổn định. Nó buộc chúng ta đặt ra một câu hỏi lớn hơn: kiểu hệ thống nào có thể khóa năng lượng dữ dội vào trong trật tự bền vững?',
    primaryCta: { label: 'Đọc bản mẫu Amazon', href: AMAZON_SAMPLE_URL },
    secondaryCta: { label: 'Xem giá trị ngành', href: '#industries' },
  },
  definition: {
    title: 'Thing-Nature là gì',
    paragraphs: [
      'Thing-Nature có thể được hiểu như một chìa khóa phổ quát để đọc các hệ thống phức tạp. Nó không dừng ở câu hỏi sản phẩm có hoạt động hay không, mà tiếp tục hỏi vì sao hệ thống ổn định, vì sao mất cân bằng, vì sao năng lượng tràn ra và vì sao cấu trúc sụp đổ.',
      'Đối với người đọc phổ thông, nó giúp phân biệt công nghệ thật sự thay đổi xã hội với công nghệ chỉ tạo ra tiếng ồn. Đối với doanh nghiệp và nhà nghiên cứu, nó giúp nhận diện năng lực nền tảng, sự mất liên kết và tiến bộ cấu trúc thực sự.',
    ],
  },
  whyNow: {
    title: 'Tại sao là bây giờ',
    bullets: [
      'AI, chip, robot, khoa học sự sống và năng lượng ngày càng đan chéo. Một lăng kính ngành đơn lẻ không còn đủ.',
      'Thị trường vốn khuếch đại rất nhanh các chủ đề nóng, nhưng không tự động cung cấp một khung đánh giá bản chất kỹ thuật và giá trị xã hội.',
      'Chúng ta cần một ngôn ngữ có thể nói đồng thời về tính khả thi kỹ thuật, ý nghĩa công nghiệp và hệ quả xã hội.',
    ],
  },
  evidence: {
    title: 'Vì sao đây không phải khẩu hiệu rỗng mà là phán đoán cấu trúc có thể kiểm chứng',
    intro:
      'Kết quả của Thing-Nature_HFCD_V11.10b-fix cung cấp một điểm tựa quan trọng: câu hỏi tại sao hệ thống ổn định hay mất cân bằng đã đi từ lời kể trừu tượng sang một sổ cái có thể kiểm toán.',
    highlights: [
      { title: 'Sổ cái đã được hiệu chuẩn', detail: 'Các kênh gốc và kênh phát sinh được hạch toán tách biệt, và sai số tổng được đẩy gần về không.' },
      { title: 'Ổn định không phải là chồng thêm năng lượng', detail: 'Điểm ổn định không phải điểm có tổng năng lượng cao nhất, mà là điểm các kênh khác nhau cùng chuyển hóa thành cân bằng có tính tương hợp.' },
      { title: 'Tràn dương không phải sáng tạo', detail: 'Nhiều điểm thất bại không hề thiếu năng lượng mà thiếu liên kết, dẫn tới rỗng cấu trúc.' },
      { title: 'Các chế độ thất bại phải được xử lý riêng', detail: 'Underfill, overflow và Q-loss không phải cùng một bệnh nên không thể dùng cùng một phương thuốc.' },
    ],
    metrics: [
      { label: 'điểm ổn định khôi phục', value: '6 / 36', note: 'phù hợp với V11.10a' },
      { label: 'độ lệch phân loại', value: '0 / 36', note: 'không xung đột với bản trước' },
      { label: 'sai số sổ cái', value: '≈ 10^-7', note: 'sổ cái gần như khép kín' },
    ],
  },
  industries: [
    { id: 'overview', title: 'Tổng quan', oneLiner: 'Trong các ngành tiên phong, cạnh tranh quyết định không bao giờ là độ nóng, mà là khả năng nén năng lượng cao vào cấu trúc ổn định.', problem: 'Chip, AI, robot, năng lượng và khoa học sự sống trông như các đường đua khác nhau, nhưng cùng chia sẻ một câu hỏi gốc: điều gì xảy ra khi năng lượng, độ phức tạp, vốn và tổ chức cố lắng thành trật tự bền vững?', shortValue: 'Ranh giới công nghệ thật sự không phải ai nóng hơn, mà ai khóa được nhiều năng lượng hơn vào cấu trúc vững hơn.', longValue: 'Mọi ngành biên đều quay về cùng một câu hỏi: năng lượng vào cấu trúc như thế nào, cấu trúc giữ ổn định ra sao và mất cân bằng xuất hiện dưới dạng nào. HFCD cho thấy ổn định có thể được phân biệt, kiểm toán và chẩn đoán.' },
    { id: 'chips', title: 'Chất bán dẫn', oneLiner: 'Cạnh tranh chip trên bề mặt là cạnh tranh node, nhưng bên dưới là cạnh tranh cấu trúc.', problem: 'Chip không chỉ là chế tạo; nó bao gồm năng lực tính toán, node quy trình, EDA, đóng gói, phần mềm, vốn và năng lực kỹ thuật ở cấp hệ sinh thái.', shortValue: 'Trần của một hệ sinh thái chip được quyết định bởi việc toàn bộ chuỗi có thể bị nén thành cấu trúc ổn định hay không.', longValue: 'Nhiều tài nguyên hơn không tự động trở thành cấu trúc. Nếu thiết kế, chế tạo, EDA, đóng gói và phần mềm không thành một hệ nhất quán, kết quả chủ yếu là sự mong manh đắt đỏ hơn.' },
    { id: 'robotics', title: 'Robot', oneLiner: 'Khó khăn thật sự của robot không phải di chuyển một lần, mà là giữ được tính nhất quán theo thời gian.', problem: 'Robot phải tích hợp cảm nhận, thuật toán, vật liệu, cơ cấu chấp hành và ràng buộc của thế giới thật.', shortValue: 'Năng lực hiếm không phải thêm một mô hình nữa, mà là một vòng kín giữa cảm nhận, quyết định, hành động và môi trường.', longValue: 'Đột phá có ý nghĩa chỉ xuất hiện khi sai số cảm nhận, bù chuyển động, phản ứng vật liệu và phản hồi môi trường trở thành cùng một vòng lặp tương hợp.' },
    { id: 'ai', title: 'AI', oneLiner: 'Cách đọc sai lớn nhất về AI không phải mô hình yếu, mà là cấu trúc yếu.', problem: 'Nhiều cuộc thảo luận về AI dừng ở sức mạnh mô hình và bỏ qua chi phí triển khai, hấp thụ xã hội, căn chỉnh và niềm tin vận hành.', shortValue: 'Mô hình mạnh hơn không tự động có nghĩa hệ thống mạnh hơn. Câu hỏi thật là tính toán, dữ liệu và sản phẩm có lắng thành cấu trúc đáng tin hay không.', longValue: 'Ảo giác, triển khai mong manh, chi phí mất kiểm soát và khó khăn căn chỉnh đều là dấu hiệu của thiếu cấu trúc. Dữ liệu và vốn chỉ có ý nghĩa khi biến thành sản phẩm, giao diện, tổ chức và niềm tin.' },
    { id: 'social', title: 'Metaverse / nền tảng xã hội', oneLiner: 'Nền tảng xã hội không thật sự sản xuất traffic; chúng sản xuất cấu trúc xã hội.', problem: 'Các sản phẩm xã hội và thế giới ảo thường bị xem như máy lấy traffic, trong khi thực tế chúng đang tái cấu trúc bản sắc, sự chú ý và hợp tác.', shortValue: 'Sản phẩm sâu nhất của một nền tảng không phải trang giao diện, mà là cấu trúc quan hệ nó tạo ra.', longValue: 'Một nền tảng có thể trông sôi động hơn trong khi mất cấu trúc ở bên trong. Nhiều người dùng và tương tác hơn không mặc nhiên đồng nghĩa nhiều niềm tin hay hợp tác hơn.' },
    { id: 'tech', title: 'Doanh nghiệp công nghệ', oneLiner: 'Nhiều công ty không chết vì thiếu tài nguyên, mà chết vì chẩn đoán sai kéo dài.', problem: 'Các công ty công nghệ thường dao động giữa tăng trưởng, câu chuyện kỹ thuật và chiến lược mà không tách rõ lặp sản phẩm với tích lũy năng lực nền tảng.', shortValue: 'Chi phí đắt nhất thường không phải đầu tư thiếu, mà là nhầm lẫn giữa những căn bệnh khác nhau.', longValue: 'Overflow, underfill và Q-loss đòi hỏi các phản ứng khác nhau. Có công ty tăng quá nhanh với cấu trúc mềm, có công ty cấu trúc đúng nhưng thiếu nguồn lực, và có công ty mất liên kết giữa đội ngũ và sản phẩm.' },
    { id: 'materials-quantum', title: 'Vật liệu / tính toán lượng tử', oneLiner: 'Các lĩnh vực này cần ít huyền thoại hơn và nhiều khả năng nhận ra sớm những đột phá cấu trúc thật hơn.', problem: 'Chu kỳ dài, rào cản cao và thương mại hóa đắt đỏ khiến các lĩnh vực này dễ bị thổi phồng hoặc bị bỏ cuộc quá sớm.', shortValue: 'Những đột phá thay đổi thế giới hiếm khi là những đột phá gây tiếng vang truyền thông lớn nhất.', longValue: 'Thing-Nature đẩy tiêu chuẩn đánh giá lên sớm hơn: một hệ vật liệu mới hay hướng lượng tử mới chỉ thật sự quan trọng khi nó dịch chuyển biên cấu trúc, không phải khi nó tạo một đỉnh ngắn trên một chỉ số đơn lẻ.' },
    { id: 'energy', title: 'Năng lượng (bao gồm nhiệt hạch)', oneLiner: 'Đích cuối của bài toán năng lượng không phải tạo ra nhiều năng lượng hơn, mà là khóa năng lượng vào cấu trúc ổn định.', problem: 'AI, robot, sản xuất và đô thị đều bị ràng buộc bởi mật độ năng lượng, tính ổn định của cung ứng và chi phí.', shortValue: 'Tương lai không thuộc về ai giải phóng được nhiều năng lượng hơn trước, mà thuộc về ai biết ổn định hóa năng lượng đậm đặc hơn trong thời gian dài.', longValue: 'Tràn năng lượng không phải chiến thắng, mà là cảnh báo. Trong năng lượng và đặc biệt là nhiệt hạch, khó khăn thật sự là ràng buộc, duy trì và quản trị năng lượng mật độ cao.' },
    { id: 'safety', title: 'An toàn AI / căn chỉnh', oneLiner: 'Mắt xích yếu nhất của an toàn không phải quá ít quy tắc, mà là chẩn đoán quá thô.', problem: 'Nếu căn chỉnh bị giản lược thành ràng buộc hành vi, thì mối quan hệ với quản trị, khuyến khích và bối cảnh triển khai sẽ bị đánh giá thấp.', shortValue: 'Nguy hiểm thật sự không phải một lỗi đơn lẻ, mà là không nhìn ra hệ thống có khả năng thất bại theo cách nào.', longValue: 'Sụp đổ hệ thống không bao giờ chỉ có một nguyên nhân. Thing-Nature biến an toàn từ việc vá hành vi thành chẩn đoán mục tiêu, vòng lặp, khuyến khích và điều kiện triển khai.' },
    { id: 'bio', title: 'Khoa học sự sống và y học', oneLiner: 'Điều trị tốt không phải ép một chỉ số, mà là giúp hệ thống trở lại ổn định.', problem: 'Can thiệp sinh học không chỉ liên quan đến một đích, mà còn bao gồm phản hồi hệ thống, tác dụng phụ dài hạn và khác biệt cá thể.', shortValue: 'Độ khó thực sự không phải trúng một điểm, mà là giúp toàn bộ mạng sống quay lại trạng thái ổn định chất lượng cao hơn.', longValue: 'Sự sống là một mạng liên kết đậm đặc giữa năng lượng và cấu trúc. Một liệu pháp tốt không chỉ dịch chuyển một con số; nó giúp cả hệ thống hồi phục về một trạng thái ổn định tốt hơn.' },
  ],
  experiment: { title: 'Thí nghiệm và lặp tiếp diễn', intro: 'Thing-Nature không phải một văn bản đóng kín. Nó là một hệ thống lý thuyết tiếp tục tiến hóa thông qua thực hành, phản hồi và thử nghiệm.', featured: { name: 'Thí nghiệm Thing-Nature_HFCD', status: 'Đang lặp', summary: 'Một thí nghiệm liên tục về cách năng lượng đi vào cấu trúc, cấu trúc giữ ổn định ra sao và các chế độ thất bại có thể được phân biệt như thế nào.', next: 'Trang chính thức sẽ tiếp tục công bố mục tiêu thí nghiệm, phát hiện theo giai đoạn và tiến trình phiên bản.' } },
  book: { title: 'Đọc thêm', body: 'Nếu bạn muốn toàn bộ hệ thống văn bản phía sau Thing-Nature, hãy bắt đầu từ bản mẫu cuốn sách. Trang chính thức làm rõ lý thuyết; cuốn sách mở toàn bộ kiến trúc.', href: AMAZON_SAMPLE_URL },
  faq: [
    { q: 'Thing-Nature có phải là triết học không?', a: 'Không theo nghĩa chỉ dừng ở khái niệm trừu tượng. Nó là một khung giải thích quan hệ giữa công nghệ, công nghiệp và cấu trúc xã hội.' },
    { q: 'Vì sao nó có thể nói cùng lúc về chip, AI, năng lượng và khoa học sự sống?', a: 'Vì các lĩnh vực này đang cùng nhau tạo ra năng lực nền tảng của văn minh công nghệ.' },
    { q: 'Hệ thống này đã hoàn chỉnh chưa?', a: 'Chưa. Nó vẫn đang tiến hóa và bản thân thử nghiệm là một phần của hệ thống.' },
    { q: 'Nên đọc trang web trước hay sách trước?', a: 'Trang web để định hướng trước, rồi đến sách để thấy cấu trúc đầy đủ.' },
  ],
};

const de: OfficialSiteContent = {
  seo: {
    title: 'Thing-Nature offizielle Seite | Technologie, Industrie und gesellschaftlichen Wert erklaeren',
    description:
      'Thing-Nature ist ein kognitiver Rahmen, um zu erklaeren, wie technologische Entwicklung, industrieller Wandel und gesellschaftlicher Wert miteinander gekoppelt sind.',
    image: OG_IMAGE_URL,
  },
  hero: {
    badge: 'Thing-Nature offizielle Seite',
    title: 'Eine Kernfrage: Wie wird chaotische Energie zu stabiler Struktur?',
    subtitle:
      'HFCD V11.10b-fix ist nicht nur deshalb wichtig, weil sechs stabile Zustaende wiedergewonnen wurden. Es zwingt uns zu einer groesseren Frage: Welche Art von System kann gewaltsame Energie in dauerhafte Ordnung einschliessen?',
    primaryCta: { label: 'Amazon-Leseprobe lesen', href: AMAZON_SAMPLE_URL },
    secondaryCta: { label: 'Industriellen Wert ansehen', href: '#industries' },
  },
  definition: {
    title: 'Was ist Thing-Nature',
    paragraphs: [
      'Thing-Nature kann als universeller Schluessel zum Lesen komplexer Systeme verstanden werden. Es fragt nicht nur, ob ein Produkt funktioniert, sondern warum ein System stabil bleibt, aus dem Gleichgewicht geraet, Energie ueberlaeuft oder strukturell kollabiert.',
      'Fuer die breite Oeffentlichkeit hilft es, Technologien zu unterscheiden, die Gesellschaft wirklich veraendern, von Technologien, die nur Laerm erzeugen. Fuer Unternehmen und Forscher hilft es, fundamentale Faehigkeit, Entkopplung und echten strukturellen Fortschritt zu erkennen.',
    ],
  },
  whyNow: {
    title: 'Warum jetzt',
    bullets: [
      'KI, Halbleiter, Robotik, Lebenswissenschaften und Energie greifen immer staerker ineinander. Ein einzelner Branchenblick reicht nicht mehr aus.',
      'Kapitalmaerkte verstaerken Hype sehr schnell, liefern aber nicht automatisch einen Rahmen fuer technisches Wesen und gesellschaftlichen Wert.',
      'Wir brauchen eine Sprache, die technische Machbarkeit, industrielle Bedeutung und gesellschaftliche Folge zugleich erklaeren kann.',
    ],
  },
  evidence: {
    title: 'Warum das keine leere Rhetorik, sondern ein pruefbares Struktururteil ist',
    intro:
      'Die Ergebnisse von Thing-Nature_HFCD_V11.10b-fix liefern einen entscheidenden Anker: Die Frage, warum Systeme stabil werden oder das Gleichgewicht verlieren, wurde von abstrakter Erzaehlung zu einem auditierbaren Hauptbuch verschoben.',
    highlights: [
      { title: 'Das Hauptbuch wurde kalibriert', detail: 'Roh- und abgeleitete Kanaele wurden getrennt gezaehlt und der Gesamtfehler nahe Null gebracht.' },
      { title: 'Stabilitaet ist kein Energiestapeln', detail: 'Stabile Punkte waren nicht die Punkte maximaler Gesamtenergie, sondern die Punkte, an denen sich mehrere Kanaele gemeinsam in kohärentes Gleichgewicht umwandelten.' },
      { title: 'Positiver Ueberlauf ist keine Schoepfung', detail: 'Viele Fehlpunkte litten nicht unter Energiemangel, sondern unter Kopplungsverlust und struktureller Aushoelung.' },
      { title: 'Fehlermodi muessen getrennt regiert werden', detail: 'Underfill, overflow und Q-loss sind nicht dieselbe Krankheit und verlangen unterschiedliche Antworten.' },
    ],
    metrics: [
      { label: 'stabile Rueckgewinne', value: '6 / 36', note: 'konsistent mit V11.10a' },
      { label: 'Klassifikationsdrift', value: '0 / 36', note: 'kein Konflikt mit der Vorversion' },
      { label: 'Hauptbuchfehler', value: '≈ 10^-7', note: 'Hauptbuch nahezu geschlossen' },
    ],
  },
  industries: [
    { id: 'overview', title: 'Ueberblick', oneLiner: 'In Grenzbranchen ist der entscheidende Wettbewerb nie bloss Hitze, sondern die Faehigkeit, hohe Energie in stabile Struktur zu komprimieren.', problem: 'Halbleiter, KI, Robotik, Energie und Lebenswissenschaften sehen wie getrennte Felder aus, teilen aber dieselbe Grundfrage: Was geschieht, wenn Energie, Komplexitaet, Kapital und Organisation zu dauerhafter Ordnung sedimentieren sollen?', shortValue: 'Die eigentliche technologische Trennlinie ist nicht, wer heisser ist, sondern wer mehr Energie in eine stabilere Struktur einschliessen kann.', longValue: 'Alle Grenzbranchen kehren zu derselben Frage zurueck: Wie tritt Energie in Struktur ein, wie bleibt Struktur stabil und wie erscheinen Ungleichgewichte? HFCD zeigt, dass Stabilitaet unterschieden, auditiert und diagnostiziert werden kann.' },
    { id: 'chips', title: 'Halbleiter', oneLiner: 'Chip-Wettbewerb wirkt wie Knoten-Wettbewerb, ist aber im Kern Struktur-Wettbewerb.', problem: 'Chips umfassen Rechenleistung, Fertigung, EDA, Packaging, Software, Kapital und souveraene technische Faehigkeit.', shortValue: 'Die Obergrenze eines Chip-Oekosystems haengt davon ab, ob die gesamte Kette in stabile Struktur komprimiert werden kann.', longValue: 'Mehr Ressourcen werden nicht automatisch zu Struktur. Ohne Koharenz zwischen Design, Fertigung, EDA, Packaging und Software entsteht vor allem teurere Fragilitaet.' },
    { id: 'robotics', title: 'Robotik', oneLiner: 'Die eigentliche Schwierigkeit ist nicht einmalige Bewegung, sondern dauerhafte Koharenz.', problem: 'Robotik muss Wahrnehmung, Algorithmen, Materialien, Aktoren und reale Weltbedingungen integrieren.', shortValue: 'Die knappe Faehigkeit ist nicht ein Modell mehr, sondern eine geschlossene Schleife zwischen Wahrnehmung, Entscheidung, Aktion und Umwelt.', longValue: 'Bedeutender Fortschritt entsteht erst, wenn Wahrnehmungsfehler, Bewegungs-kompensation, Materialreaktion und Umweltfeedback zu einer gemeinsamen koharenten Schleife werden.' },
    { id: 'ai', title: 'KI', oneLiner: 'Die groesste Fehllekture der KI ist nicht ein schwaches Modell, sondern eine schwache Struktur.', problem: 'Viele KI-Gespraeche enden bei Modellstaerke und blenden Kosten, Alignment, gesellschaftliche Absorption und operatives Vertrauen aus.', shortValue: 'Ein staerkeres Modell bedeutet nicht automatisch ein staerkeres System. Entscheidend ist, ob Rechenleistung, Daten und Produkt in verlaessliche Struktur sedimentieren.', longValue: 'Halluzination, fragile Deployments, ausufernde Kosten und Alignment-Probleme sind Zeichen unzureichender Struktur. Daten und Kapital zaehlen erst, wenn sie zu Produkt, Schnittstelle, Organisation und Vertrauen werden.' },
    { id: 'social', title: 'Metaverse / soziale Plattformen', oneLiner: 'Soziale Plattformen produzieren nicht wirklich Traffic; sie produzieren soziale Struktur.', problem: 'Soziale und virtuelle Produkte werden oft wie Traffic-Maschinen behandelt, obwohl sie Identitaet, Aufmerksamkeit und Kooperation umformen.', shortValue: 'Das tiefste Produkt einer Plattform ist nicht die Seite, sondern die Beziehungsstruktur, die sie erzeugt.', longValue: 'Eine Plattform kann aktiver wirken und zugleich innere Struktur verlieren. Mehr Nutzer und Interaktion bedeuten nicht automatisch mehr Vertrauen oder Kooperation.' },
    { id: 'tech', title: 'Technologieunternehmen', oneLiner: 'Viele Unternehmen sterben nicht an Ressourcenmangel, sondern an chronischer Fehldiagnose.', problem: 'Technologieunternehmen schwanken zwischen Wachstum, technischer Erzaehlung und Strategie, ohne Produktiteration und Aufbau fundamentaler Faehigkeit sauber zu trennen.', shortValue: 'Die teuersten Kosten sind oft nicht Unterinvestitionen, sondern die Verwechslung unterschiedlicher Krankheiten.', longValue: 'Overflow, underfill und Q-loss verlangen unterschiedliche Antworten. Manche Unternehmen wachsen zu schnell mit weicher Struktur, andere sind strukturell gesund aber ressourcenarm, andere verlieren Kopplung zwischen Teams und Produkten.' },
    { id: 'materials-quantum', title: 'Materialien / Quantencomputing', oneLiner: 'Diese Felder brauchen weniger Mythen und fruehere Erkennung realer Strukturbrueche.', problem: 'Lange Zyklen, hohe Eintrittsbarrieren und teure Kommerzialisierung fuehren leicht zu Ueberhype oder vorschnellem Aufgeben.', shortValue: 'Weltveraendernde Durchbrueche sind selten jene mit dem lautesten Medienecho.', longValue: 'Thing-Nature verschiebt das Urteil nach vorn: Ein neues Materialsystem oder ein Quantenpfad zaehlt dann, wenn es eine Strukturgrenze verschiebt, nicht wenn es kurzfristig einen Peak in einer Einzelmetrik produziert.' },
    { id: 'energy', title: 'Energie (inklusive Fusion)', oneLiner: 'Das Endspiel des Energieproblems ist nicht groessere Energie, sondern in Struktur gebundene Energie.', problem: 'KI, Robotik, Fertigung und Staedte werden durch Energiedichte, Versorgungssicherheit und Kosten begrenzt.', shortValue: 'Die Zukunft gehoert nicht dem, der zuerst mehr Energie freisetzt, sondern dem, der dichtere Energie langfristig stabilisieren kann.', longValue: 'Energieueberlauf ist kein Sieg, sondern eine Warnung. In Energie und besonders in der Fusion liegt die Schwierigkeit darin, hochdichte Energie zu binden, zu halten und skalierbar zu regieren.' },
    { id: 'safety', title: 'KI-Sicherheit / Alignment', oneLiner: 'Das schwächste Glied der Sicherheit ist nicht ein Mangel an Regeln, sondern eine zu grobe Diagnose.', problem: 'Wenn Alignment auf Verhaltensgrenzen reduziert wird, wird seine Beziehung zu Governance, Anreizen und Deployment-Kontext unterschaetzt.', shortValue: 'Die eigentliche Gefahr ist nicht ein einzelner Fehler, sondern das Unvermoegen zu sehen, auf welche Weise ein System wahrscheinlich scheitert.', longValue: 'Systemischer Zusammenbruch hat nie nur eine Ursache. Thing-Nature macht aus Sicherheit nicht bloss Verhalten-Flicken, sondern Diagnose von Zielen, Schleifen, Anreizen und Einsatzbedingungen.' },
    { id: 'bio', title: 'Lebenswissenschaften und Medizin', oneLiner: 'Gute Behandlung heisst nicht, einen Indikator zu erzwingen, sondern dem System zur Stabilitaet zurueckzuhelfen.', problem: 'Biologische Interventionen umfassen nicht nur ein Ziel, sondern auch Rueckkopplung, Nebenwirkungen und individuelle Variation.', shortValue: 'Die eigentliche Schwierigkeit ist nicht, einen Punkt zu treffen, sondern dem gesamten Lebensnetz zu einer hoeheren Stabilitaet zu verhelfen.', longValue: 'Leben ist ein dichtes Energie-Struktur-Kopplungsnetzwerk. Eine gute Therapie bewegt nicht nur eine Zahl, sondern hilft dem ganzen System, einen besseren stabilen Zustand wiederzugewinnen.' },
  ],
  experiment: { title: 'Experiment und fortlaufende Iteration', intro: 'Thing-Nature ist kein geschlossener Text. Es ist ein theoretisches System, das sich durch Praxis, Rueckmeldung und Experiment weiterentwickelt.', featured: { name: 'Thing-Nature_HFCD_Experiment', status: 'In Iteration', summary: 'Ein fortlaufendes Experiment dazu, wie Energie in Struktur eintritt, wie Struktur stabil bleibt und wie Fehlermodi unterschieden werden koennen.', next: 'Die offizielle Seite wird weiter Experimentziele, Zwischenbefunde und Versionsfortschritte veroeffentlichen.' } },
  book: { title: 'Weiterlesen', body: 'Wenn Sie das vollstaendige Textsystem hinter Thing-Nature sehen wollen, beginnen Sie mit der Leseprobe. Die Seite klaert die Theorie; das Buch entfaltet die groessere Architektur.', href: AMAZON_SAMPLE_URL },
  faq: [
    { q: 'Ist Thing-Nature Philosophie?', a: 'Nicht im Sinne abstrakter Begriffe allein. Es ist ein Rahmen, um die Beziehung zwischen Technologie, Industrie und sozialer Struktur zu erklaeren.' },
    { q: 'Warum kann es zugleich ueber Chips, KI, Energie und Lebenswissenschaften sprechen?', a: 'Weil diese Bereiche gemeinsam die Grundfaehigkeiten technologischer Zivilisation formen.' },
    { q: 'Ist das System schon abgeschlossen?', a: 'Nein. Es entwickelt sich weiter, und Experiment ist Teil des Systems.' },
    { q: 'Sollte ich zuerst die Seite oder das Buch lesen?', a: 'Zuerst die Seite zur Orientierung, dann das Buch fuer die vollstaendige Struktur.' },
  ],
};

export const officialSiteContent = zh;

const officialSiteContentByLocaleBase: Record<Exclude<Locale, 'ja'>, OfficialSiteContent> = {
  zh,
  en,
  fr,
  es,
  vi,
  de,
};

const ja: OfficialSiteContent = {
  ...en,
  seo: {
    title: 'Thing-Nature 公式サイト | 技術・産業・社会的価値を説明する',
    description:
      'Thing-Nature は、技術進化、産業変化、社会的価値がどのように結びつくかを説明するための認知フレームです。',
    image: OG_IMAGE_URL,
  },
  hero: {
    badge: 'Thing-Nature 公式サイト',
    title: '中心となる問い：混沌としたエネルギーは、どのように安定した構造へ変わるのか。',
    subtitle:
      'HFCD V11.10b-fix の意味は、六つの安定状態を回復したことだけではありません。より大きな問いを前景化しました。激しいエネルギーを持続可能な秩序の中へ閉じ込められるのは、どのようなシステムなのか。',
    primaryCta: { label: 'Amazon サンプルを読む', href: AMAZON_SAMPLE_URL },
    secondaryCta: { label: '産業価値を見る', href: '#industries' },
  },
  definition: {
    title: 'Thing-Nature とは何か',
    paragraphs: [
      'Thing-Nature は、複雑系を読むための汎用キーとして理解できます。製品が動くかどうかだけで止まらず、なぜシステムが安定するのか、なぜ不均衡になるのか、なぜエネルギーが溢れ、なぜ構造が崩れるのかを問い続けます。',
      '一般の読者にとっては、本当に社会を変える技術と、ただノイズを増やす技術を見分ける助けになります。企業や研究者にとっては、基盤能力、脱結合、そして本当の構造的進歩を見分ける助けになります。',
    ],
  },
  whyNow: {
    title: 'なぜ今必要なのか',
    bullets: [
      'AI、半導体、ロボティクス、生命科学、エネルギーはますます相互接続されており、一つの業界だけの視点では足りません。',
      '資本市場はホットなテーマを素早く増幅しますが、技術の本質や社会的価値を判断する枠組みを自動的に与えてはくれません。',
      '技術的実現性、産業的意味、社会的帰結を同時に語れる言語が必要です。',
    ],
  },
  evidence: {
    title: 'なぜこれは空疎なレトリックではなく、検証可能な構造判断なのか',
    intro:
      'Thing-Nature_HFCD_V11.10b-fix の結果は重要な足場を与えました。システムがなぜ安定し、なぜ均衡を失うのかという問題が、抽象的な物語から監査可能な台帳へと移されたのです。',
    highlights: [
      { title: '台帳が較正された', detail: '生のチャネルと派生チャネルを分けて計上し、総誤差をほぼゼロまで押し下げました。' },
      { title: '安定とはエネルギーの積み上げではない', detail: '安定点は総エネルギー最大点ではなく、複数チャネルが整合的な均衡へ変換される点でした。' },
      { title: '正のオーバーフローは創造ではない', detail: '多くの失敗点はエネルギー不足ではなく、結合喪失と構造の空洞化にありました。' },
      { title: '失敗モードは分けて扱う必要がある', detail: 'Underfill、overflow、Q-loss は同じ病ではなく、それぞれ異なる対応を要します。' },
    ],
    metrics: [
      { label: '安定回復', value: '6 / 36', note: 'V11.10a と整合' },
      { label: '分類ドリフト', value: '0 / 36', note: '前版と矛盾なし' },
      { label: '台帳誤差', value: '≈ 10^-7', note: '台帳はほぼ閉じている' },
    ],
  },
  industries: [
    { id: 'overview', title: '概観', oneLiner: '最先端産業の真の競争は、熱量ではなく、高エネルギーを安定構造へ圧縮する能力にある。', problem: '半導体、AI、ロボティクス、エネルギー、生命科学は別の分野に見えますが、共通の根本問題を抱えています。エネルギー、複雑性、資本、組織がいかに持続的秩序へ沈殿できるかという問題です。', shortValue: '本当の技術的分水嶺は、誰がより熱いかではなく、誰がより多くのエネルギーをより安定した構造へ閉じ込められるかです。', longValue: 'すべてのフロンティア産業は同じ問いに戻ります。エネルギーはどう構造へ入り、構造はどう安定を保ち、不均衡はどう現れるのか。HFCD は、安定が識別・監査・診断できることを示しました。' },
    { id: 'chips', title: '半導体', oneLiner: 'チップ競争はノード競争に見えて、その本質は構造競争である。', problem: 'チップは計算能力、製造、EDA、パッケージング、ソフトウェア、資本、主権的技術能力を含みます。', shortValue: 'チップ生態系の上限は、全チェーンを安定構造へ圧縮できるかで決まります。', longValue: '資源が増えても自動的に構造にはなりません。設計、製造、EDA、パッケージング、ソフトウェアに一貫性がなければ、高価な脆弱性が増えるだけです。' },
    { id: 'robotics', title: 'ロボティクス', oneLiner: '本当の難しさは一度動くことではなく、時間の中で整合性を保つことにある。', problem: 'ロボティクスは知覚、アルゴリズム、材料、アクチュエータ、現実世界の制約を統合しなければなりません。', shortValue: '希少な能力はモデルを一つ増やすことではなく、知覚・判断・行動・環境の閉ループを作ることです。', longValue: '知覚誤差、運動補償、材料応答、環境フィードバックが一つの整合したループになるときに、意味ある前進が生まれます。' },
    { id: 'ai', title: 'AI', oneLiner: 'AIに対する最大の誤読は、モデルの弱さではなく、構造の弱さにある。', problem: 'AIの多くの議論はモデル性能で止まり、コスト、アラインメント、社会的吸収、運用上の信頼を見落としています。', shortValue: 'より強いモデルは、より強いシステムを自動的に意味しません。本当の問いは、計算・データ・製品が信頼できる構造へ沈殿するかどうかです。', longValue: '幻覚、脆弱なデプロイ、暴走するコスト、アラインメント困難は、いずれも構造不足の兆候です。データと資本は、製品、インターフェース、組織、信頼へ変わるときに初めて意味を持ちます。' },
    { id: 'social', title: 'メタバース / ソーシャルプラットフォーム', oneLiner: 'ソーシャルプラットフォームが本当に生産しているのはトラフィックではなく、社会構造である。', problem: 'ソーシャルや仮想世界の製品はしばしばトラフィック装置として扱われますが、実際にはアイデンティティ、注意、協働を再構成しています。', shortValue: 'プラットフォームの最も深い製品はページではなく、それが生み出す関係構造です。', longValue: 'プラットフォームは活発に見えながら、内部構造を失うことがあります。ユーザーや相互作用の増加は、信頼や協働の増加を保証しません。' },
    { id: 'tech', title: 'テクノロジー企業', oneLiner: '多くの企業は資源不足で死ぬのではなく、慢性的な誤診で死ぬ。', problem: 'テクノロジー企業は成長、技術物語、戦略の間を揺れながら、製品反復と基盤能力の蓄積を切り分けられていません。', shortValue: '最も高くつくコストは投資不足より、異なる病を混同することです。', longValue: 'Overflow、underfill、Q-loss には別々の応答が必要です。柔らかい構造のまま急成長する企業もあれば、構造は良いが資源が足りない企業もあり、チームと製品の結合を失う企業もあります。' },
    { id: 'materials-quantum', title: '材料 / 量子計算', oneLiner: 'これらの分野に必要なのは神話ではなく、本物の構造的突破を早期に見抜く力である。', problem: '長いサイクル、高い参入障壁、高コストな商業化により、過大評価と早すぎる断念の両方が起こりやすい。', shortValue: '世界を変える突破は、最も大きなメディア騒音を生む突破とは限りません。', longValue: 'Thing-Nature は判断基準を前倒しします。新しい材料系や量子経路が重要なのは、単一指標の一時的ピークではなく、構造境界を動かすときです。' },
    { id: 'energy', title: 'エネルギー（核融合を含む）', oneLiner: 'エネルギー問題の終局は、より多くのエネルギーを作ることではなく、構造の中に固定することにある。', problem: 'AI、ロボティクス、製造、都市はすべてエネルギー密度、供給安定性、コストに制約されます。', shortValue: '未来は、先により多くのエネルギーを解放する者ではなく、より高密度のエネルギーを長期に安定化できる者に属します。', longValue: 'エネルギーのオーバーフローは勝利ではなく警告です。エネルギー、特に核融合における本当の難しさは、高密度エネルギーを拘束し、維持し、統治することです。' },
    { id: 'safety', title: 'AI安全 / アラインメント', oneLiner: '安全性の最も弱い輪は、ルール不足ではなく、診断が粗すぎることにある。', problem: 'アラインメントを行動制約に還元すると、ガバナンス、インセンティブ、デプロイ文脈との関係が過小評価されます。', shortValue: '本当の危険は単一のエラーではなく、システムがどのように失敗しうるかを見抜けないことです。', longValue: 'システム崩壊に単一原因はありません。Thing-Nature は安全を行動パッチではなく、目標、ループ、インセンティブ、配備条件の診断へ変えます。' },
    { id: 'bio', title: '生命科学と医療', oneLiner: '良い治療とは、一つの指標を無理に動かすことではなく、システムが安定へ戻るのを助けることである。', problem: '生物学的介入には単一ターゲットだけでなく、フィードバック、副作用、個体差が含まれます。', shortValue: '本当の難しさは一点を叩くことではなく、生命ネットワーク全体をより良い安定へ戻すことです。', longValue: '生命はエネルギーと構造の密な結合ネットワークです。良い治療は数値を一つ動かすだけでなく、システム全体をより良い安定状態へ回復させます。' },
  ],
  experiment: { title: '実験と継続的反復', intro: 'Thing-Nature は閉じたテキストではありません。実践、フィードバック、実験を通じて進化し続ける理論システムです。', featured: { name: 'Thing-Nature_HFCD 実験', status: '反復中', summary: 'エネルギーがどのように構造へ入り、構造がどう安定し、失敗モードがどう区別できるかを追う継続実験。', next: '公式サイトは今後も実験目標、中間発見、バージョン進展を公開していきます。' } },
  book: { title: 'さらに読む', body: 'Thing-Nature の背後にある完全なテキスト体系を見たいなら、まず書籍サンプルから始めてください。サイトは理論を明確にし、書籍はより大きな構造を展開します。', href: AMAZON_SAMPLE_URL },
  faq: [
    { q: 'Thing-Nature は哲学ですか？', a: '抽象概念だけに留まる意味での哲学ではありません。技術、産業、社会構造の関係を説明するための枠組みです。' },
    { q: 'なぜ半導体、AI、エネルギー、生命科学を同時に語れるのですか？', a: 'これらの分野が一緒になって、技術文明の基盤能力を形作っているからです。' },
    { q: 'このシステムはもう完成していますか？', a: 'いいえ。まだ進化中であり、実験そのものがシステムの一部です。' },
    { q: '先に読むべきなのはサイトですか、それとも書籍ですか？', a: 'まずは方向づけのためにサイトを読み、その後で完全な構造を見るために書籍へ進むのがよいです。' },
  ],
};

export const officialSiteContentByLocale: Record<Locale, OfficialSiteContent> = {
  ...officialSiteContentByLocaleBase,
  ja,
};

export function getOfficialSiteContent(locale: Locale): OfficialSiteContent {
  return officialSiteContentByLocale[locale] || zh;
}
