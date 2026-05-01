import type { Locale } from '../lib/locale';

export interface UiText {
  brand: {
    chatSubtitle: string;
    officialSubtitle: string;
    sidebarSubtitle: string;
    appTitle: string;
    appDescription: string;
  };
  common: {
    backToChat: string;
    loading: string;
    generating: string;
    genericError: string;
    quotaError: string;
  };
  auth: {
    title: string;
    subtitle: string;
    continueWithGoogle: string;
    redirectHint: string;
  };
  models: {
    flash: string;
    pro: string;
    select: string;
  };
  sidebar: {
    officialSiteTitle: string;
    officialSiteSubtitle: string;
    adminTitle: string;
    adminSubtitle: string;
    newChatTitle: string;
    newChatSubtitle: string;
    chatHistory: string;
    noRecentChats: string;
    accountFallback: string;
    accountHelp: string;
    helpCenter: string;
    signOut: string;
    settings: string;
    deleteConfirm: string;
    rename: string;
    delete: string;
  };
  chat: {
    emptyTitle: string;
    emptySubtitle: string;
    copyResponse: string;
    retryResponse: string;
    sources: string;
    userLabel: string;
  };
  input: {
    dragAndPaste: string;
    placeholder: string;
    placeholderGenerating: string;
    attachFile: string;
    webSearchEnabled: string;
    webSearchDisabled: string;
    startDictation: string;
    stopDictation: string;
    speechUnsupported: string;
    stopGenerating: string;
    disclaimer: string;
    localAttachment: string;
    completed: string;
    fileTooLarge: (name: string, maxMb: number) => string;
    omegaShort: string;
    omegaShortDesc: string;
    omegaMedium: string;
    omegaMediumDesc: string;
    omegaLong: string;
    omegaLongDesc: string;
  };
  settings: {
    title: string;
    description: string;
    persona: string;
    systemInstruction: string;
    placeholder: string;
    help: string;
  };
  share: {
    shareButton: string;
    titleFallback: string;
    noMessages: string;
    copyLink: string;
    exportMarkdown: string;
    clearMessages: string;
    deleteChat: string;
    lightLog: string;
    scanningLightLog: string;
  };
  officialSite: {
    definitionEyebrow: string;
    whyNowEyebrow: string;
    evidenceEyebrow: string;
    industriesEyebrow: string;
    industriesTitle: string;
    industriesDescription: string;
    overviewLabel: string;
    overviewTitle: string;
    overviewBody: string;
    industryProblem: string;
    shortJudgment: string;
    longArgument: string;
    iterationEyebrow: string;
    featuredExperiment: string;
    nextStep: string;
    bookEyebrow: string;
    faqEyebrow: string;
    faqTitle: string;
    coreThesis: string;
    industryValue: string;
    industryValueBody: string;
    socialValue: string;
    socialValueBody: string;
    amazonSample: string;
  };
}

const uiTextByLocaleBase: Record<Exclude<Locale, 'ja'>, UiText> = {
  en: {
    brand: {
      chatSubtitle: 'THING NATURE OS',
      officialSubtitle: 'OFFICIAL SITE',
      sidebarSubtitle: 'CIVILIZATION INTELLIGENCE',
      appTitle: 'Thing-Nature OS',
      appDescription: 'Thing-Nature OS: structured conversations with the Thing-Nature system.',
    },
    common: {
      backToChat: 'Back to chat',
      loading: 'Loading...',
      generating: 'Generating...',
      genericError: 'An error occurred while generating the reply. Please try again.',
      quotaError: 'The current model is temporarily out of quota. Please try again later.',
    },
    auth: {
      title: 'Welcome to Thing-Nature',
      subtitle: 'Sign in to sync conversations, use multiple models, and access enterprise features.',
      continueWithGoogle: 'Continue with Google',
      redirectHint: 'This environment uses redirect login and will return here automatically after sign-in.',
    },
    models: { flash: 'Genius Model', pro: 'Oracle Model', select: 'Select model' },
    sidebar: {
      officialSiteTitle: 'Official Site',
      officialSiteSubtitle: 'Theory, industry, and social value',
      adminTitle: 'Admin Console',
      adminSubtitle: 'Content, sessions, and system controls',
      newChatTitle: 'New Chat',
      newChatSubtitle: 'Start a new Thing-Nature conversation',
      chatHistory: 'Chat History',
      noRecentChats: 'No recent chats',
      accountFallback: 'Account',
      accountHelp: 'Account and help',
      helpCenter: 'Help Center',
      signOut: 'Sign Out',
      settings: 'Settings',
      deleteConfirm: 'Are you sure you want to delete this chat?',
      rename: 'Rename',
      delete: 'Delete',
    },
    chat: {
      emptyTitle: 'How can I assist you today?',
      emptySubtitle: 'Type a message to start conversing with the system.',
      copyResponse: 'Copy response',
      retryResponse: 'Retry this response',
      sources: 'Sources',
      userLabel: 'You',
    },
    input: {
      dragAndPaste: 'Drag or paste files',
      placeholder: 'Message Thing-Nature... (⌘+Enter to send)',
      placeholderGenerating: 'Generating reply...',
      attachFile: 'Attach file',
      webSearchEnabled: 'Web search enabled',
      webSearchDisabled: 'Web search disabled',
      startDictation: 'Start dictation',
      stopDictation: 'Stop dictation',
      speechUnsupported: 'Your browser does not support speech recognition.',
      stopGenerating: 'Stop generating',
      disclaimer: '',
      localAttachment: 'Local only',
      completed: 'Completed',
      fileTooLarge: (name, maxMb) => `File ${name} is too large. Max size is ${maxMb}MB.`,
      omegaShort: 'Short Ω',
      omegaShortDesc: 'Solve the immediate problem directly.',
      omegaMedium: '3-Year Ω',
      omegaMediumDesc: 'Focus on mid-term structure and strategy.',
      omegaLong: 'Life Ω',
      omegaLongDesc: 'Align with long-term and civilizational direction.',
    },
    settings: {
      title: 'System Settings',
      description: 'Define how Thing-Nature behaves, sounds, and structures each conversation.',
      persona: 'Persona',
      systemInstruction: 'System Instruction',
      placeholder: 'You are a helpful assistant...',
      help: 'This text is layered on top of the system core to shape tone, structure, and preferences.',
    },
    share: {
      shareButton: 'Share',
      titleFallback: 'New Chat',
      noMessages: 'No messages to share yet.',
      copyLink: 'Copy link',
      exportMarkdown: 'Export Markdown',
      clearMessages: 'Clear messages',
      deleteChat: 'Delete chat',
      lightLog: 'Extract Light Log',
      scanningLightLog: 'Scanning Pi-structure changes...',
    },
    officialSite: {
      definitionEyebrow: 'Definition',
      whyNowEyebrow: 'Why Now',
      evidenceEyebrow: 'Evidence',
      industriesEyebrow: 'Industries',
      industriesTitle: 'Why Thing-Nature matters across key industries',
      industriesDescription: 'Every frontier industry faces its own engineering constraints, but all of them share a deeper problem: how to organize high energy and high complexity into stable, governable structure.',
      overviewLabel: 'Overview',
      overviewTitle: 'The real competition of technological civilization is not who is hotter, but who can compress more energy, complexity, and uncertainty into more stable structure.',
      overviewBody: 'Semiconductors, AI, robotics, energy, and life science look like separate sectors, yet they fight the same structural war: whether energy overflows, whether structure collapses, and whether local capability can settle into durable order.',
      industryProblem: 'Industry Problem',
      shortJudgment: 'Short Judgment',
      longArgument: 'Long Argument',
      iterationEyebrow: 'Iteration',
      featuredExperiment: 'Featured Experiment',
      nextStep: 'Next',
      bookEyebrow: 'Book',
      faqEyebrow: 'FAQ',
      faqTitle: 'Frequently Asked Questions',
      coreThesis: 'Real progress is not bigger energy, but energy organized into stable structure.',
      industryValue: 'Industry Value',
      industryValueBody: 'A framework for telling foundational capability from high-heat, low-structure expansion.',
      socialValue: 'Social Value',
      socialValueBody: 'A way to explain why order forms, why systems fail, and how technology can truly serve the real world.',
      amazonSample: 'Read Amazon sample',
    },
  },
  zh: {
    brand: {
      chatSubtitle: '物性论OS',
      officialSubtitle: '官网',
      sidebarSubtitle: '文明智能',
      appTitle: '物性论OS',
      appDescription: '物性论OS：以结构化方式与物性论系统对话。',
    },
    common: {
      backToChat: '返回对话',
      loading: '加载中...',
      generating: '正在生成...',
      genericError: '生成回答时发生错误，请重试。',
      quotaError: '当前模型额度暂时耗尽，请稍后再试。',
    },
    auth: {
      title: '欢迎来到物性论',
      subtitle: '登录后可同步对话、使用多模型，并访问企业能力。',
      continueWithGoogle: 'Continue with Google',
      redirectHint: '当前环境使用重定向登录，登录完成后会自动返回此页面。',
    },
    models: { flash: '天才模型', pro: '预言家模型', select: '选择模型' },
    sidebar: {
      officialSiteTitle: '物性论官网',
      officialSiteSubtitle: '28800步实验与产业价值',
      adminTitle: '管理后台',
      adminSubtitle: '内容、会话与系统控制台',
      newChatTitle: '新建会话',
      newChatSubtitle: '开始一次新的物性论对话',
      chatHistory: '会话记录',
      noRecentChats: '暂无最近会话',
      accountFallback: '账户',
      accountHelp: '账号与帮助',
      helpCenter: '帮助中心',
      signOut: '退出登录',
      settings: '设置',
      deleteConfirm: '确定要删除这个会话吗？',
      rename: '重命名',
      delete: '删除',
    },
    chat: {
      emptyTitle: '今天想一起推演什么？',
      emptySubtitle: '输入一条消息，开始和物性论系统对话。',
      copyResponse: '复制回答',
      retryResponse: '重试本次回答',
      sources: '来源',
      userLabel: '你',
    },
    input: {
      dragAndPaste: '拖拽或粘贴文件',
      placeholder: '向物性论发送消息...（⌘+Enter 发送）',
      placeholderGenerating: '正在生成回答...',
      attachFile: '添加文件',
      webSearchEnabled: '网页搜索已开启',
      webSearchDisabled: '网页搜索已关闭',
      startDictation: '开始语音输入',
      stopDictation: '停止语音输入',
      speechUnsupported: '你的浏览器暂不支持语音识别。',
      stopGenerating: '停止生成',
      disclaimer: '',
      localAttachment: '本地',
      completed: '完成',
      fileTooLarge: (name, maxMb) => `文件 ${name} 过大，最大支持 ${maxMb}MB。`,
      omegaShort: '短期 Ω',
      omegaShortDesc: '解决当下问题，直接给答案',
      omegaMedium: '三年 Ω',
      omegaMediumDesc: '看系统发展，给中期策略',
      omegaLong: '一生 Ω',
      omegaLongDesc: '对齐长期方向，看文明路线',
    },
    settings: {
      title: '系统设置',
      description: '定义物性论在每次对话中的行为、语气与结构偏好。',
      persona: '人格层',
      systemInstruction: '系统指令',
      placeholder: 'You are a helpful assistant...',
      help: '这里的内容会叠加在系统内核之上，用来定义语气、输出结构和个性化偏好。',
    },
    share: {
      shareButton: '分享',
      titleFallback: '新对话',
      noMessages: '当前还没有可分享的消息。',
      copyLink: '复制链接',
      exportMarkdown: '导出 Markdown',
      clearMessages: '清空消息',
      deleteChat: '删除会话',
      lightLog: '提取光之日志',
      scanningLightLog: '正在扫描 Π 结构变化...',
    },
    officialSite: {
      definitionEyebrow: '一句话看懂',
      whyNowEyebrow: '为什么现在必须看',
      evidenceEyebrow: '28800步铁证',
      industriesEyebrow: '行业价值',
      industriesTitle: '物性论能直接改变哪些行业',
      industriesDescription: '材料、芯片、能源、AI、机器人、医药和数据决策面对的都是同一个问题：怎样把混乱、能量和风险锁成长期稳定的结构。',
      overviewLabel: '总图纸',
      overviewTitle: '真正的革命，从来不是能量变大，而是能量被组织成长期稳定的结构。',
      overviewBody: '28800步严格稳定闭环，正在把芯片、能源、AI、医药和数据决策从经验试错推向结构化研发。',
      industryProblem: '以前的难题',
      shortJudgment: '现在的突破',
      longArgument: '真实收益',
      iterationEyebrow: '持续实验',
      featuredExperiment: '28800步实验',
      nextStep: '下一步',
      bookEyebrow: '完整阅读',
      faqEyebrow: 'FAQ',
      faqTitle: '常见问题',
      coreThesis: '28800步不崩：混沌能量可以被锁成长期稳定结构。',
      industryValue: '真实收益',
      industryValueBody: '帮助研发团队更早发现高风险样本、主要失效原因和优先改进方案。',
      socialValue: '商业价值',
      socialValueBody: '少走弯路，少烧钱，把研发讨论从经验争论推进到证据决策。',
      amazonSample: '阅读 Amazon 完整版',
    },
  },
  fr: {
    brand: {
      chatSubtitle: 'THING NATURE OS',
      officialSubtitle: 'SITE OFFICIEL',
      sidebarSubtitle: 'INTELLIGENCE CIVILISATIONNELLE',
      appTitle: 'Thing-Nature OS',
      appDescription: 'Thing-Nature OS : dialoguer avec le systeme Thing-Nature de facon structuree.',
    },
    common: {
      backToChat: 'Retour au chat',
      loading: 'Chargement...',
      generating: 'Generation...',
      genericError: 'Une erreur est survenue pendant la generation. Veuillez reessayer.',
      quotaError: 'Le quota du modele est temporairement epuise. Veuillez reessayer plus tard.',
    },
    auth: {
      title: 'Bienvenue dans Thing-Nature',
      subtitle: 'Connectez-vous pour synchroniser les conversations, utiliser plusieurs modeles et acceder aux fonctions avancees.',
      continueWithGoogle: 'Continuer avec Google',
      redirectHint: 'Cet environnement utilise une connexion par redirection et reviendra ici automatiquement.',
    },
    models: { flash: 'Modele Genie', pro: 'Modele Prophete', select: 'Choisir un modele' },
    sidebar: {
      officialSiteTitle: 'Site officiel',
      officialSiteSubtitle: 'Theorie, industrie et valeur sociale',
      adminTitle: 'Console admin',
      adminSubtitle: 'Contenu, sessions et controles systeme',
      newChatTitle: 'Nouveau chat',
      newChatSubtitle: 'Demarrer une nouvelle conversation Thing-Nature',
      chatHistory: 'Historique',
      noRecentChats: 'Aucune conversation recente',
      accountFallback: 'Compte',
      accountHelp: 'Compte et aide',
      helpCenter: 'Centre d aide',
      signOut: 'Se deconnecter',
      settings: 'Parametres',
      deleteConfirm: 'Voulez-vous vraiment supprimer cette conversation ?',
      rename: 'Renommer',
      delete: 'Supprimer',
    },
    chat: {
      emptyTitle: 'Comment puis-je vous aider aujourd hui ?',
      emptySubtitle: 'Saisissez un message pour commencer a converser avec le systeme.',
      copyResponse: 'Copier la reponse',
      retryResponse: 'Reessayer cette reponse',
      sources: 'Sources',
      userLabel: 'Vous',
    },
    input: {
      dragAndPaste: 'Glisser ou coller des fichiers',
      placeholder: 'Envoyer un message a Thing-Nature... (⌘+Entrer pour envoyer)',
      placeholderGenerating: 'Generation en cours...',
      attachFile: 'Joindre un fichier',
      webSearchEnabled: 'Recherche web activee',
      webSearchDisabled: 'Recherche web desactivee',
      startDictation: 'Demarrer la dictee',
      stopDictation: 'Arreter la dictee',
      speechUnsupported: 'Votre navigateur ne prend pas en charge la reconnaissance vocale.',
      stopGenerating: 'Arreter la generation',
      disclaimer: '',
      localAttachment: 'Local',
      completed: 'Termine',
      fileTooLarge: (name, maxMb) => `Le fichier ${name} est trop volumineux. Taille maximale : ${maxMb} Mo.`,
      omegaShort: 'Omega court',
      omegaShortDesc: 'Resoudre le probleme immediat directement.',
      omegaMedium: 'Omega 3 ans',
      omegaMediumDesc: 'Se concentrer sur la structure et la strategie a moyen terme.',
      omegaLong: 'Omega vie',
      omegaLongDesc: 'S aligner sur le long terme et l echelle civilisationnelle.',
    },
    settings: {
      title: 'Parametres systeme',
      description: 'Definissez le comportement, le ton et la structure des conversations Thing-Nature.',
      persona: 'Persona',
      systemInstruction: 'Instruction systeme',
      placeholder: 'You are a helpful assistant...',
      help: 'Ce texte se superpose au noyau systeme pour definir le ton, la structure et vos preferences.',
    },
    share: {
      shareButton: 'Partager',
      titleFallback: 'Nouveau chat',
      noMessages: 'Aucun message a partager pour le moment.',
      copyLink: 'Copier le lien',
      exportMarkdown: 'Exporter en Markdown',
      clearMessages: 'Effacer les messages',
      deleteChat: 'Supprimer le chat',
      lightLog: 'Extraire le journal de lumiere',
      scanningLightLog: 'Analyse des changements de structure Pi...',
    },
    officialSite: {
      definitionEyebrow: 'Definition',
      whyNowEyebrow: 'Pourquoi maintenant',
      evidenceEyebrow: 'Preuves',
      industriesEyebrow: 'Industries',
      industriesTitle: 'Pourquoi Thing-Nature compte pour les industries cle',
      industriesDescription: 'Chaque industrie de pointe a ses propres contraintes, mais toutes partagent une question plus profonde : comment organiser une energie et une complexite elevees en structure stable et gouvernable.',
      overviewLabel: 'Vue d ensemble',
      overviewTitle: 'La vraie competition technologique ne porte pas sur la chaleur du moment, mais sur la capacite a comprimer plus d energie et d incertitude dans une structure stable.',
      overviewBody: 'Semi-conducteurs, IA, robotique, energie et sciences du vivant semblent separees, mais elles livrent la meme guerre structurelle : debordement d energie, effondrement de structure et incapacite a sedimenter une capacite durable.',
      industryProblem: 'Probleme du secteur',
      shortJudgment: 'Jugement bref',
      longArgument: 'Argument long',
      iterationEyebrow: 'Iteration',
      featuredExperiment: 'Experience vedette',
      nextStep: 'Etape suivante',
      bookEyebrow: 'Livre',
      faqEyebrow: 'FAQ',
      faqTitle: 'Questions frequentes',
      coreThesis: 'Le vrai progres n est pas une energie plus grande, mais une energie organisee en structure stable.',
      industryValue: 'Valeur industrielle',
      industryValueBody: 'Distinguer la capacite fondamentale d une expansion chaude mais fragile.',
      socialValue: 'Valeur sociale',
      socialValueBody: 'Expliquer pourquoi l ordre emerge, pourquoi les systemes se degradent et comment la technologie peut servir le monde reel.',
      amazonSample: 'Lire l extrait Amazon',
    },
  },
  es: {
    brand: {
      chatSubtitle: 'THING NATURE OS',
      officialSubtitle: 'SITIO OFICIAL',
      sidebarSubtitle: 'INTELIGENCIA CIVILIZATORIA',
      appTitle: 'Thing-Nature OS',
      appDescription: 'Thing-Nature OS: conversaciones estructuradas con el sistema Thing-Nature.',
    },
    common: {
      backToChat: 'Volver al chat',
      loading: 'Cargando...',
      generating: 'Generando...',
      genericError: 'Ocurrio un error al generar la respuesta. Intentalo de nuevo.',
      quotaError: 'La cuota del modelo esta temporalmente agotada. Vuelve a intentarlo mas tarde.',
    },
    auth: {
      title: 'Bienvenido a Thing-Nature',
      subtitle: 'Inicia sesion para sincronizar conversaciones, usar varios modelos y acceder a funciones empresariales.',
      continueWithGoogle: 'Continuar con Google',
      redirectHint: 'Este entorno usa inicio de sesion por redireccion y volvera aqui automaticamente.',
    },
    models: { flash: 'Modelo Genio', pro: 'Modelo Profeta', select: 'Seleccionar modelo' },
    sidebar: {
      officialSiteTitle: 'Sitio oficial',
      officialSiteSubtitle: 'Teoria, industria y valor social',
      adminTitle: 'Consola admin',
      adminSubtitle: 'Contenido, sesiones y controles del sistema',
      newChatTitle: 'Nuevo chat',
      newChatSubtitle: 'Inicia una nueva conversacion Thing-Nature',
      chatHistory: 'Historial',
      noRecentChats: 'No hay chats recientes',
      accountFallback: 'Cuenta',
      accountHelp: 'Cuenta y ayuda',
      helpCenter: 'Centro de ayuda',
      signOut: 'Cerrar sesion',
      settings: 'Configuracion',
      deleteConfirm: 'Seguro que quieres eliminar este chat?',
      rename: 'Renombrar',
      delete: 'Eliminar',
    },
    chat: {
      emptyTitle: 'Como puedo ayudarte hoy?',
      emptySubtitle: 'Escribe un mensaje para empezar a conversar con el sistema.',
      copyResponse: 'Copiar respuesta',
      retryResponse: 'Reintentar esta respuesta',
      sources: 'Fuentes',
      userLabel: 'Tu',
    },
    input: {
      dragAndPaste: 'Arrastra o pega archivos',
      placeholder: 'Enviar mensaje a Thing-Nature... (⌘+Enter para enviar)',
      placeholderGenerating: 'Generando respuesta...',
      attachFile: 'Adjuntar archivo',
      webSearchEnabled: 'Busqueda web activada',
      webSearchDisabled: 'Busqueda web desactivada',
      startDictation: 'Iniciar dictado',
      stopDictation: 'Detener dictado',
      speechUnsupported: 'Tu navegador no admite reconocimiento de voz.',
      stopGenerating: 'Detener generacion',
      disclaimer: '',
      localAttachment: 'Local',
      completed: 'Completado',
      fileTooLarge: (name, maxMb) => `El archivo ${name} es demasiado grande. Tamano maximo: ${maxMb}MB.`,
      omegaShort: 'Omega corto',
      omegaShortDesc: 'Resolver el problema inmediato de forma directa.',
      omegaMedium: 'Omega 3 anos',
      omegaMediumDesc: 'Mirar estructura y estrategia de mediano plazo.',
      omegaLong: 'Omega vida',
      omegaLongDesc: 'Alinear con la direccion de largo plazo y civilizatoria.',
    },
    settings: {
      title: 'Configuracion del sistema',
      description: 'Define como se comporta, habla y estructura cada conversacion Thing-Nature.',
      persona: 'Persona',
      systemInstruction: 'Instruccion del sistema',
      placeholder: 'You are a helpful assistant...',
      help: 'Este texto se superpone al nucleo del sistema para definir tono, estructura y preferencias.',
    },
    share: {
      shareButton: 'Compartir',
      titleFallback: 'Nuevo chat',
      noMessages: 'Todavia no hay mensajes para compartir.',
      copyLink: 'Copiar enlace',
      exportMarkdown: 'Exportar Markdown',
      clearMessages: 'Borrar mensajes',
      deleteChat: 'Eliminar chat',
      lightLog: 'Extraer Light Log',
      scanningLightLog: 'Analizando cambios en la estructura Pi...',
    },
    officialSite: {
      definitionEyebrow: 'Definicion',
      whyNowEyebrow: 'Por que ahora',
      evidenceEyebrow: 'Evidencia',
      industriesEyebrow: 'Industrias',
      industriesTitle: 'Por que Thing-Nature importa en las industrias clave',
      industriesDescription: 'Cada industria de frontera tiene sus propios retos, pero todas comparten una pregunta mas profunda: como organizar alta energia y alta complejidad en una estructura estable y gobernable.',
      overviewLabel: 'Vision general',
      overviewTitle: 'La competencia real de la civilizacion tecnologica no es quien esta mas caliente, sino quien puede comprimir mas energia y complejidad en una estructura estable.',
      overviewBody: 'Chips, IA, robotica, energia y ciencias de la vida parecen sectores separados, pero libran la misma guerra estructural: si la energia se desborda, si la estructura colapsa y si la capacidad local puede asentarse en orden duradero.',
      industryProblem: 'Problema del sector',
      shortJudgment: 'Juicio corto',
      longArgument: 'Argumento largo',
      iterationEyebrow: 'Iteracion',
      featuredExperiment: 'Experimento destacado',
      nextStep: 'Siguiente paso',
      bookEyebrow: 'Libro',
      faqEyebrow: 'FAQ',
      faqTitle: 'Preguntas frecuentes',
      coreThesis: 'El progreso real no es mas energia, sino energia organizada como estructura estable.',
      industryValue: 'Valor industrial',
      industryValueBody: 'Distinguir la capacidad fundacional de una expansion caliente pero fragil.',
      socialValue: 'Valor social',
      socialValueBody: 'Explicar por que surge el orden, por que fallan los sistemas y como la tecnologia puede servir de verdad al mundo real.',
      amazonSample: 'Leer muestra de Amazon',
    },
  },
  vi: {
    brand: {
      chatSubtitle: 'THING NATURE OS',
      officialSubtitle: 'TRANG CHINH THUC',
      sidebarSubtitle: 'TRI TUE VAN MINH',
      appTitle: 'Thing-Nature OS',
      appDescription: 'Thing-Nature OS: tro chuyen co cau truc voi he thong Thing-Nature.',
    },
    common: {
      backToChat: 'Quay lai hoi thoai',
      loading: 'Dang tai...',
      generating: 'Dang tao...',
      genericError: 'Da xay ra loi khi tao cau tra loi. Vui long thu lai.',
      quotaError: 'Han muc cua mo hinh tam thoi da het. Vui long thu lai sau.',
    },
    auth: {
      title: 'Chao mung den voi Thing-Nature',
      subtitle: 'Dang nhap de dong bo hoi thoai, dung nhieu mo hinh va truy cap tinh nang nang cao.',
      continueWithGoogle: 'Tiep tuc voi Google',
      redirectHint: 'Moi truong nay dung dang nhap chuyen huong va se tu dong quay lai day sau khi dang nhap.',
    },
    models: { flash: 'Mo hinh Thien tai', pro: 'Mo hinh Tien tri', select: 'Chon mo hinh' },
    sidebar: {
      officialSiteTitle: 'Trang chinh thuc',
      officialSiteSubtitle: 'Ly thuyet, cong nghiep va gia tri xa hoi',
      adminTitle: 'Bang dieu khien admin',
      adminSubtitle: 'Noi dung, phien hoi thoai va dieu khien he thong',
      newChatTitle: 'Hoi thoai moi',
      newChatSubtitle: 'Bat dau mot cuoc doi thoai Thing-Nature moi',
      chatHistory: 'Lich su hoi thoai',
      noRecentChats: 'Chua co hoi thoai gan day',
      accountFallback: 'Tai khoan',
      accountHelp: 'Tai khoan va tro giup',
      helpCenter: 'Trung tam tro giup',
      signOut: 'Dang xuat',
      settings: 'Cai dat',
      deleteConfirm: 'Ban co chac muon xoa cuoc hoi thoai nay khong?',
      rename: 'Doi ten',
      delete: 'Xoa',
    },
    chat: {
      emptyTitle: 'Hom nay toi co the ho tro ban the nao?',
      emptySubtitle: 'Nhap mot tin nhan de bat dau tro chuyen voi he thong.',
      copyResponse: 'Sao chep cau tra loi',
      retryResponse: 'Thu lai cau tra loi nay',
      sources: 'Nguon',
      userLabel: 'Ban',
    },
    input: {
      dragAndPaste: 'Keo tha hoac dan tep',
      placeholder: 'Gui tin nhan cho Thing-Nature... (⌘+Enter de gui)',
      placeholderGenerating: 'Dang tao cau tra loi...',
      attachFile: 'Dinh kem tep',
      webSearchEnabled: 'Da bat tim kiem web',
      webSearchDisabled: 'Da tat tim kiem web',
      startDictation: 'Bat dau nhap bang giong noi',
      stopDictation: 'Dung nhap bang giong noi',
      speechUnsupported: 'Trinh duyet cua ban khong ho tro nhan dang giong noi.',
      stopGenerating: 'Dung tao',
      disclaimer: '',
      localAttachment: 'Cuc bo',
      completed: 'Hoan tat',
      fileTooLarge: (name, maxMb) => `Tep ${name} qua lon. Gioi han toi da la ${maxMb}MB.`,
      omegaShort: 'Omega ngan han',
      omegaShortDesc: 'Giai quyet truc tiep van de truoc mat.',
      omegaMedium: 'Omega 3 nam',
      omegaMediumDesc: 'Tap trung vao cau truc va chien luoc trung han.',
      omegaLong: 'Omega ca doi',
      omegaLongDesc: 'Can chinh theo huong dai han va van minh.',
    },
    settings: {
      title: 'Cai dat he thong',
      description: 'Xac dinh cach Thing-Nature hanh xu, giong dieu va cau truc moi cuoc tro chuyen.',
      persona: 'Persona',
      systemInstruction: 'Huong dan he thong',
      placeholder: 'You are a helpful assistant...',
      help: 'Van ban nay duoc dat len tren loi he thong de dinh hinh giong dieu, cau truc va so thich.',
    },
    share: {
      shareButton: 'Chia sẻ',
      titleFallback: 'Hoi thoai moi',
      noMessages: 'Chua co tin nhan de chia se.',
      copyLink: 'Sao chep lien ket',
      exportMarkdown: 'Xuat Markdown',
      clearMessages: 'Xoa tin nhan',
      deleteChat: 'Xoa hoi thoai',
      lightLog: 'Trich xuat Nhat ky Anh sang',
      scanningLightLog: 'Dang quet thay doi cau truc Pi...',
    },
    officialSite: {
      definitionEyebrow: 'Dinh nghia',
      whyNowEyebrow: 'Tai sao la bay gio',
      evidenceEyebrow: 'Bang chung',
      industriesEyebrow: 'Nganh',
      industriesTitle: 'Vi sao Thing-Nature quan trong voi cac nganh then chot',
      industriesDescription: 'Moi nganh tien phong deu co bai toan ky thuat rieng, nhung tat ca deu chia se mot van de sau hon: lam sao to chuc nang luong va do phuc tap cao thanh cau truc on dinh va co the quan tri.',
      overviewLabel: 'Tong quan',
      overviewTitle: 'Canh tranh that su cua van minh cong nghe khong phai ai nong hon, ma ai nen duoc nhieu nang luong, phuc tap va bat dinh hon vao cau truc on dinh hon.',
      overviewBody: 'Chip, AI, robot, nang luong va khoa hoc su song trong co ve rieng re, nhung thuc chat cung dang chien dau trong mot cuoc chien cau truc: nang luong co tran khong, cau truc co sap khong, va nang luc cuc bo co the lang thanh trat tu ben vung hay khong.',
      industryProblem: 'Van de nganh',
      shortJudgment: 'Nhan dinh ngan',
      longArgument: 'Lap luan dai',
      iterationEyebrow: 'Lap lai va tien hoa',
      featuredExperiment: 'Thi nghiem tieu bieu',
      nextStep: 'Buoc tiep theo',
      bookEyebrow: 'Sach',
      faqEyebrow: 'FAQ',
      faqTitle: 'Cau hoi thuong gap',
      coreThesis: 'Tien bo that su khong phai nang luong lon hon, ma la nang luong duoc to chuc thanh cau truc on dinh.',
      industryValue: 'Gia tri cong nghiep',
      industryValueBody: 'Phan biet nang luc nen tang voi su mo rong nong nhung mong manh.',
      socialValue: 'Gia tri xa hoi',
      socialValueBody: 'Giai thich vi sao trat tu hinh thanh, vi sao he thong mat kiem soat, va cong nghe co the phuc vu the gioi that nhu the nao.',
      amazonSample: 'Doc mau tren Amazon',
    },
  },
  de: {
    brand: {
      chatSubtitle: 'THING NATURE OS',
      officialSubtitle: 'OFFIZIELLE SEITE',
      sidebarSubtitle: 'ZIVILISATORISCHE INTELLIGENZ',
      appTitle: 'Thing-Nature OS',
      appDescription: 'Thing-Nature OS: strukturierte Gespraeche mit dem Thing-Nature-System.',
    },
    common: {
      backToChat: 'Zurueck zum Chat',
      loading: 'Laedt...',
      generating: 'Generiert...',
      genericError: 'Beim Generieren der Antwort ist ein Fehler aufgetreten. Bitte erneut versuchen.',
      quotaError: 'Das Kontingent des Modells ist voruebergehend erschoepft. Bitte spaeter erneut versuchen.',
    },
    auth: {
      title: 'Willkommen bei Thing-Nature',
      subtitle: 'Melden Sie sich an, um Gespraeche zu synchronisieren, mehrere Modelle zu nutzen und erweiterte Funktionen zu erhalten.',
      continueWithGoogle: 'Mit Google fortfahren',
      redirectHint: 'Diese Umgebung verwendet Redirect-Login und kehrt danach automatisch hierher zurueck.',
    },
    models: { flash: 'Genie-Modell', pro: 'Propheten-Modell', select: 'Modell auswaehlen' },
    sidebar: {
      officialSiteTitle: 'Offizielle Seite',
      officialSiteSubtitle: 'Theorie, Industrie und gesellschaftlicher Wert',
      adminTitle: 'Admin-Konsole',
      adminSubtitle: 'Inhalte, Sitzungen und Systemsteuerung',
      newChatTitle: 'Neuer Chat',
      newChatSubtitle: 'Eine neue Thing-Nature-Konversation starten',
      chatHistory: 'Chatverlauf',
      noRecentChats: 'Keine letzten Chats',
      accountFallback: 'Konto',
      accountHelp: 'Konto und Hilfe',
      helpCenter: 'Hilfecenter',
      signOut: 'Abmelden',
      settings: 'Einstellungen',
      deleteConfirm: 'Moechten Sie diesen Chat wirklich loeschen?',
      rename: 'Umbenennen',
      delete: 'Loeschen',
    },
    chat: {
      emptyTitle: 'Wie kann ich Ihnen heute helfen?',
      emptySubtitle: 'Geben Sie eine Nachricht ein, um mit dem System zu sprechen.',
      copyResponse: 'Antwort kopieren',
      retryResponse: 'Diese Antwort erneut versuchen',
      sources: 'Quellen',
      userLabel: 'Sie',
    },
    input: {
      dragAndPaste: 'Dateien ziehen oder einfuegen',
      placeholder: 'Nachricht an Thing-Nature senden... (⌘+Enter zum Senden)',
      placeholderGenerating: 'Antwort wird generiert...',
      attachFile: 'Datei anhaengen',
      webSearchEnabled: 'Websuche aktiviert',
      webSearchDisabled: 'Websuche deaktiviert',
      startDictation: 'Diktat starten',
      stopDictation: 'Diktat stoppen',
      speechUnsupported: 'Ihr Browser unterstuetzt keine Spracherkennung.',
      stopGenerating: 'Generierung stoppen',
      disclaimer: '',
      localAttachment: 'Lokal',
      completed: 'Abgeschlossen',
      fileTooLarge: (name, maxMb) => `Die Datei ${name} ist zu gross. Maximale Groesse: ${maxMb}MB.`,
      omegaShort: 'Kurzes Omega',
      omegaShortDesc: 'Das unmittelbare Problem direkt loesen.',
      omegaMedium: '3-Jahres-Omega',
      omegaMediumDesc: 'Auf mittelfristige Struktur und Strategie schauen.',
      omegaLong: 'Lebens-Omega',
      omegaLongDesc: 'An langfristiger und zivilisatorischer Richtung ausrichten.',
    },
    settings: {
      title: 'Systemeinstellungen',
      description: 'Definieren Sie Verhalten, Ton und Struktur jeder Thing-Nature-Konversation.',
      persona: 'Persona',
      systemInstruction: 'Systemanweisung',
      placeholder: 'You are a helpful assistant...',
      help: 'Dieser Text wird ueber den Systemkern gelegt, um Ton, Struktur und Praeferenzen zu formen.',
    },
    share: {
      shareButton: 'Teilen',
      titleFallback: 'Neuer Chat',
      noMessages: 'Noch keine Nachrichten zum Teilen vorhanden.',
      copyLink: 'Link kopieren',
      exportMarkdown: 'Markdown exportieren',
      clearMessages: 'Nachrichten leeren',
      deleteChat: 'Chat loeschen',
      lightLog: 'Light Log extrahieren',
      scanningLightLog: 'Pi-Strukturveraenderungen werden analysiert...',
    },
    officialSite: {
      definitionEyebrow: 'Definition',
      whyNowEyebrow: 'Warum jetzt',
      evidenceEyebrow: 'Evidenz',
      industriesEyebrow: 'Branchen',
      industriesTitle: 'Warum Thing-Nature fuer Schluesselbranchen relevant ist',
      industriesDescription: 'Jede Spitzenbranche hat eigene technische Zwange, doch alle teilen dieselbe tiefere Frage: Wie wird hohe Energie und hohe Komplexitaet in stabile, steuerbare Struktur ueberfuehrt?',
      overviewLabel: 'Ueberblick',
      overviewTitle: 'Der eigentliche Wettbewerb technologischer Zivilisation ist nicht, wer heisser ist, sondern wer mehr Energie und Unsicherheit in stabilere Struktur komprimieren kann.',
      overviewBody: 'Halbleiter, KI, Robotik, Energie und Lebenswissenschaften wirken getrennt, fuehren aber denselben Strukturkrieg: ob Energie ueberlaeuft, Struktur kollabiert und lokale Faehigkeit zu dauerhafter Ordnung gerinnt.',
      industryProblem: 'Branchenproblem',
      shortJudgment: 'Kurzurteil',
      longArgument: 'Langes Argument',
      iterationEyebrow: 'Iteration',
      featuredExperiment: 'Hervorgehobenes Experiment',
      nextStep: 'Naechster Schritt',
      bookEyebrow: 'Buch',
      faqEyebrow: 'FAQ',
      faqTitle: 'Haeufige Fragen',
      coreThesis: 'Echter Fortschritt ist nicht groessere Energie, sondern Energie als stabile Struktur.',
      industryValue: 'Industrieller Wert',
      industryValueBody: 'Fundamentale Faehigkeit von heisser, aber fragiler Expansion unterscheiden.',
      socialValue: 'Gesellschaftlicher Wert',
      socialValueBody: 'Erklaeren, warum Ordnung entsteht, warum Systeme scheitern und wie Technologie der realen Welt dienen kann.',
      amazonSample: 'Amazon-Leseprobe',
    },
  },
};

const ja: UiText = {
  ...uiTextByLocaleBase.en,
  brand: {
    ...uiTextByLocaleBase.en.brand,
    officialSubtitle: '公式サイト',
    sidebarSubtitle: '文明知能',
    appDescription: 'Thing-Nature OS: 物性論システムとの構造化された対話。',
  },
  common: {
    ...uiTextByLocaleBase.en.common,
    backToChat: 'チャットに戻る',
    loading: '読み込み中...',
    generating: '生成中...',
    genericError: '回答の生成中にエラーが発生しました。もう一度お試しください。',
    quotaError: '現在のモデルの利用枠が一時的に不足しています。後でもう一度お試しください。',
  },
  auth: {
    ...uiTextByLocaleBase.en.auth,
    title: 'Thing-Natureへようこそ',
    subtitle: '会話を同期し、複数モデルを使い、高度な機能にアクセスするにはサインインしてください。',
    continueWithGoogle: 'Googleで続行',
    redirectHint: 'この環境はリダイレクトログインを使用しており、サインイン後に自動的にここへ戻ります。',
  },
  models: { flash: '天才モデル', pro: '預言者モデル', select: 'モデルを選択' },
  sidebar: {
    ...uiTextByLocaleBase.en.sidebar,
    officialSiteTitle: '公式サイト',
    officialSiteSubtitle: '理論・産業・社会的価値',
    adminTitle: '管理コンソール',
    adminSubtitle: 'コンテンツ、会話、システム管理',
    newChatTitle: '新しい会話',
    newChatSubtitle: '新しいThing-Nature対話を開始',
    chatHistory: '会話履歴',
    noRecentChats: '最近の会話はありません',
    accountFallback: 'アカウント',
    accountHelp: 'アカウントとヘルプ',
    helpCenter: 'ヘルプセンター',
    signOut: 'サインアウト',
    settings: '設定',
    deleteConfirm: 'この会話を削除してもよろしいですか？',
    rename: '名前を変更',
    delete: '削除',
  },
  chat: {
    ...uiTextByLocaleBase.en.chat,
    emptyTitle: '今日はどのようにお手伝いできますか？',
    emptySubtitle: 'メッセージを入力してシステムとの対話を始めてください。',
    copyResponse: '回答をコピー',
    retryResponse: 'この回答を再試行',
    sources: '情報源',
    userLabel: 'あなた',
  },
  input: {
    ...uiTextByLocaleBase.en.input,
    dragAndPaste: 'ファイルをドラッグまたは貼り付け',
    placeholder: 'Thing-Nature にメッセージを送信...（⌘+Enterで送信）',
    placeholderGenerating: '回答を生成中...',
    attachFile: 'ファイルを添付',
    webSearchEnabled: 'Web検索オン',
    webSearchDisabled: 'Web検索オフ',
    startDictation: '音声入力を開始',
    stopDictation: '音声入力を停止',
    speechUnsupported: 'お使いのブラウザは音声認識に対応していません。',
    stopGenerating: '生成を停止',
    disclaimer: '',
    localAttachment: 'ローカルのみ',
    completed: '完了',
    fileTooLarge: (name, maxMb) => `ファイル ${name} は大きすぎます。上限は ${maxMb}MB です。`,
    omegaShort: '短期Ω',
    omegaShortDesc: '目の前の問題を直接解決する。',
    omegaMedium: '3年Ω',
    omegaMediumDesc: '中期の構造と戦略に注目する。',
    omegaLong: '人生Ω',
    omegaLongDesc: '長期および文明的方向に合わせる。',
  },
  settings: {
    ...uiTextByLocaleBase.en.settings,
    title: 'システム設定',
    description: 'Thing-Nature が各会話でどのように振る舞い、どのような口調と構造を取るかを定義します。',
    systemInstruction: 'システム指示',
    help: 'このテキストはシステムコアの上に重ねられ、口調、構造、好みを調整します。',
  },
  share: {
    ...uiTextByLocaleBase.en.share,
    shareButton: '共有',
    titleFallback: '新しい会話',
    noMessages: '共有できるメッセージがまだありません。',
    copyLink: 'リンクをコピー',
    exportMarkdown: 'Markdownを書き出す',
    clearMessages: 'メッセージを消去',
    deleteChat: '会話を削除',
    lightLog: 'Light Log を抽出',
    scanningLightLog: 'Pi構造の変化を解析中...',
  },
  officialSite: {
    ...uiTextByLocaleBase.en.officialSite,
    definitionEyebrow: '定義',
    whyNowEyebrow: 'なぜ今か',
    evidenceEyebrow: '根拠',
    industriesEyebrow: '産業',
    industriesTitle: '主要産業において Thing-Nature が重要である理由',
    industriesDescription: '最先端産業はそれぞれ固有の技術制約を持ちますが、どれも同じ深層課題を共有しています。高いエネルギーと複雑性を、いかに安定し統治可能な構造へ組織化するかという課題です。',
    overviewLabel: '概要',
    overviewTitle: '技術文明の真の競争は、誰がより熱いかではなく、より多くのエネルギーと不確実性をより安定した構造へ圧縮できるかにある。',
    overviewBody: '半導体、AI、ロボティクス、エネルギー、生命科学は別々に見えて、実は同じ構造戦を戦っています。',
    industryProblem: '産業課題',
    shortJudgment: '短い判断',
    longArgument: '長い論点',
    iterationEyebrow: '反復',
    featuredExperiment: '注目実験',
    nextStep: '次の一歩',
    bookEyebrow: '書籍',
    faqEyebrow: 'FAQ',
    faqTitle: 'よくある質問',
    coreThesis: '真の進歩とは、より大きなエネルギーではなく、安定構造へ組織化されたエネルギーである。',
    industryValue: '産業的価値',
    industryValueBody: '基盤能力と、熱いだけで脆い拡張を見分けるための枠組み。',
    socialValue: '社会的価値',
    socialValueBody: '秩序がなぜ形成され、システムがなぜ失敗し、技術がどのように現実世界へ奉仕できるかを説明する方法。',
    amazonSample: 'Amazon サンプルを読む',
  },
};

const uiTextByLocale: Record<Locale, UiText> = {
  ...uiTextByLocaleBase,
  ja,
};

export function getUiText(locale: Locale): UiText {
  return uiTextByLocale[locale] || uiTextByLocale.en;
}
