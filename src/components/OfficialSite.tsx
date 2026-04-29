import React from 'react';
import { Activity, ArrowRight, BookOpen, Cpu, Microscope, Orbit, ShieldCheck, Sparkles, Upload, Zap } from 'lucide-react';
import { ThingNatureBrand } from './ThingNatureBrand';
import { officialSiteContent, OfficialSiteContent } from '../content/officialSiteContent';
import type { UiText } from '../content/uiText';
import type { Locale } from '../lib/locale';

const industryIcons = {
  chips: Cpu,
  robotics: Orbit,
  ai: Sparkles,
  social: Orbit,
  tech: Zap,
  'materials-quantum': Microscope,
  energy: Zap,
  safety: ShieldCheck,
  bio: Microscope,
} as const;

interface OfficialSiteProps {
  onBackToChat: () => void;
  onOpenHFCD: () => void;
  content?: OfficialSiteContent;
  ui: UiText;
  locale: Locale;
}

const hfcdSectionCopy: Record<Locale, {
  eyebrow: string;
  title: string;
  body: string;
  primary: string;
  secondary: string;
  gates: string[];
}> = {
  en: {
    eyebrow: 'Industry Intelligence Tool',
    title: 'HFCD Stability-Window Audit',
    body: 'A cross-industry stability diagnosis and R&D repair-plan system for quantum chips, advanced materials, new energy, and life sciences. Upload experimental or production data; HFCD identifies stability windows, failure modes, risk samples, and repair routes.',
    primary: 'Enter HFCD Tool',
    secondary: 'View Industry Mapping',
    gates: [
      'Q core: protect system identity before capability drifts into noise.',
      'Energy: detect energy_surplus_overflow and ultra-micro surplus.',
      'Cavity and radius: judge support capacity and boundary diffusion.',
      'Manifestation and buffer: catch the edge between usable and unstable.',
    ],
  },
  zh: {
    eyebrow: '产业智能工具',
    title: 'HFCD 稳定窗审计',
    body: '面向量子芯片、新材料、新能源、生命科学的跨行业稳定性诊断与研发方案生成系统。上传实验或生产数据，HFCD 自动识别稳定窗、失效模式、风险样本，并生成研发修复方案。',
    primary: '进入 HFCD 工具',
    secondary: '查看产业映射',
    gates: [
      'Q 核：守住系统身份，不让能力漂移成噪声。',
      '能量：识别 energy_surplus_overflow 和微溢出。',
      '腔体与半径：判断结构是否承载、扩散是否越界。',
      '显化与缓冲：判断看似可用的系统是否正在进入失稳边界。',
    ],
  },
  fr: {
    eyebrow: 'Outil d intelligence industrielle',
    title: 'Audit HFCD de fenetre de stabilite',
    body: 'Un systeme de diagnostic de stabilite et de plans de correction R&D pour puces quantiques, materiaux avances, energie nouvelle et sciences du vivant. Importez des donnees; HFCD detecte fenetres stables, modes de defaillance, echantillons a risque et pistes de reparation.',
    primary: 'Ouvrir HFCD',
    secondary: 'Voir la carte industrielle',
    gates: [
      'Noyau Q : proteger l identite du systeme avant que la capacite ne devienne bruit.',
      'Energie : detecter energy_surplus_overflow et les micro-surplus.',
      'Cavite et rayon : juger la capacite de support et la diffusion des frontieres.',
      'Manifestation et tampon : voir la limite entre utilisable et instable.',
    ],
  },
  es: {
    eyebrow: 'Herramienta de inteligencia industrial',
    title: 'Auditoria HFCD de ventana estable',
    body: 'Sistema transversal de diagnostico de estabilidad y generacion de planes de I+D para chips cuanticos, nuevos materiales, nueva energia y ciencias de la vida. Sube datos experimentales o productivos; HFCD identifica ventanas estables, modos de fallo, muestras de riesgo y rutas de reparacion.',
    primary: 'Entrar a HFCD',
    secondary: 'Ver mapeo industrial',
    gates: [
      'Nucleo Q: proteger la identidad del sistema antes de que la capacidad derive en ruido.',
      'Energia: detectar energy_surplus_overflow y microexcesos.',
      'Cavidad y radio: juzgar soporte estructural y difusion de frontera.',
      'Manifestacion y buffer: detectar el borde entre utilizable e inestable.',
    ],
  },
  vi: {
    eyebrow: 'Cong cu tri tue cong nghiep',
    title: 'Kiem dinh cua so on dinh HFCD',
    body: 'He thong chan doan on dinh va tao phuong an sua chua R&D cho chip luong tu, vat lieu moi, nang luong moi va khoa hoc su song. Tai du lieu thi nghiem hoac san xuat; HFCD tu dong nhan dien cua so on dinh, failure mode, mau rui ro va huong sua chua.',
    primary: 'Vao cong cu HFCD',
    secondary: 'Xem ban do nganh',
    gates: [
      'Loi Q: giu danh tinh he thong truoc khi nang luc tro thanh nhieu.',
      'Nang luong: phat hien energy_surplus_overflow va vi du thua.',
      'Khoang chua va ban kinh: do kha nang nang do va khu ech bien.',
      'Hien hoa va dem: bat ranh gioi giua dung duoc va bat on.',
    ],
  },
  de: {
    eyebrow: 'Industrielles Intelligenzwerkzeug',
    title: 'HFCD Stabilitaetsfenster-Audit',
    body: 'Ein branchenuebergreifendes System fuer Stabilitaetsdiagnose und F&E-Reparaturplaene fuer Quantenchips, neue Materialien, neue Energie und Lebenswissenschaften. Laden Sie Daten hoch; HFCD erkennt Stabilitaetsfenster, FailureModes, Risikoproben und Reparaturpfade.',
    primary: 'HFCD oeffnen',
    secondary: 'Branchenmapping ansehen',
    gates: [
      'Q-Kern: Systemidentitaet schuetzen, bevor Faehigkeit zu Rauschen driftet.',
      'Energie: energy_surplus_overflow und Mikroueberschuss erkennen.',
      'Kavitaet und Radius: Tragfaehigkeit und Grenzdiffusion beurteilen.',
      'Manifestation und Puffer: die Kante zwischen nutzbar und instabil erkennen.',
    ],
  },
  ja: {
    eyebrow: '産業インテリジェンスツール',
    title: 'HFCD 安定窓監査',
    body: '量子チップ、新素材、新エネルギー、生命科学に向けた横断的な安定性診断と研究開発修復案生成システムです。実験または生産データをアップロードすると、HFCD が安定窓、FailureMode、リスクサンプル、修復ルートを識別します。',
    primary: 'HFCD ツールへ',
    secondary: '産業マッピングを見る',
    gates: [
      'Q核：能力がノイズへ漂流する前にシステムの同一性を守る。',
      'エネルギー：energy_surplus_overflow と微小過剰を検出する。',
      '空洞と半径：構造の受容力と境界拡散を判定する。',
      '顕化とバッファ：使用可能と不安定の境界を捉える。',
    ],
  },
};

function SectionTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="max-w-3xl">
      <div className="text-xs font-bold uppercase tracking-[0.28em] text-[#7ef8d2]/80">{eyebrow}</div>
      <h2 className="mt-4 text-3xl font-black tracking-tight text-white md:text-4xl">{title}</h2>
      {description ? <p className="mt-4 text-base leading-8 text-slate-400 md:text-lg">{description}</p> : null}
    </div>
  );
}

export function OfficialSite({ onBackToChat, onOpenHFCD, content = officialSiteContent, ui, locale }: OfficialSiteProps) {
  const { hero, definition, whyNow, evidence, industries, experiment, book, faq } = content;
  const overviewIndustry = industries.find((industry) => industry.id === 'overview');
  const hfcdCopy = hfcdSectionCopy[locale] || hfcdSectionCopy.en;

  return (
    <div className="h-full overflow-y-auto bg-[#0f1117] text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col px-4 pb-24 pt-6 md:px-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <ThingNatureBrand subtitle={ui.brand.officialSubtitle} compact className="md:hidden" />
          <button
            onClick={onBackToChat}
            className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            {ui.common.backToChat}
          </button>
        </div>

        <section className="relative overflow-hidden rounded-[36px] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(82,219,169,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(92,111,255,0.18),transparent_24%),linear-gradient(180deg,#171a24_0%,#10131b_100%)] px-6 py-10 shadow-[0_30px_120px_rgba(0,0,0,0.35)] md:px-10 md:py-14">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.04),transparent_22%,transparent_78%,rgba(255,255,255,0.03))]" />
          <div className="relative grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:items-center">
            <div className="max-w-3xl">
              <div className="inline-flex items-center rounded-full border border-[#7ef8d2]/20 bg-[#7ef8d2]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-[#91ffe1]">
                {hero.badge}
              </div>
              <h1 className="mt-6 text-4xl font-black tracking-tight text-white md:text-6xl md:leading-[1.02]">
                {hero.title}
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 md:text-xl md:leading-9">
                {hero.subtitle}
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a
                  href={hero.primaryCta.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#52DBA9] px-6 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
                >
                  <BookOpen className="h-4 w-4" />
                  {hero.primaryCta.label}
                </a>
                <a
                  href={hero.secondaryCta.href}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/[0.08]"
                >
                  {hero.secondaryCta.label}
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </div>

            <div className="grid gap-4 rounded-[28px] border border-white/8 bg-black/15 p-4 backdrop-blur-sm">
              <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                <div className="text-xs font-bold uppercase tracking-[0.24em] text-[#7ef8d2]/75">{ui.officialSite.definitionEyebrow}</div>
                <div className="mt-3 text-2xl font-black text-white">{ui.officialSite.coreThesis}</div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                  <div className="text-sm font-semibold text-white">{ui.officialSite.industryValue}</div>
                  <p className="mt-2 text-sm leading-7 text-slate-400">{ui.officialSite.industryValueBody}</p>
                </div>
                <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                  <div className="text-sm font-semibold text-white">{ui.officialSite.socialValue}</div>
                  <p className="mt-2 text-sm leading-7 text-slate-400">{ui.officialSite.socialValueBody}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-20">
          <SectionTitle eyebrow={ui.officialSite.definitionEyebrow} title={definition.title} />
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            {definition.paragraphs.map((paragraph) => (
              <div key={paragraph} className="rounded-[28px] border border-white/8 bg-white/[0.03] p-6 text-base leading-8 text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                {paragraph}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <SectionTitle eyebrow={ui.officialSite.whyNowEyebrow} title={whyNow.title} />
          <div className="mt-8 grid gap-4">
            {whyNow.bullets.map((bullet, index) => (
              <div key={bullet} className="flex items-start gap-4 rounded-[24px] border border-white/8 bg-white/[0.03] p-5">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#52DBA9]/12 text-sm font-bold text-[#7ef8d2]">
                  {index + 1}
                </div>
                <p className="text-base leading-8 text-slate-300">{bullet}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <SectionTitle eyebrow={ui.officialSite.evidenceEyebrow} title={evidence.title} description={evidence.intro} />
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {evidence.metrics.map((metric) => (
              <div key={metric.label} className="rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,rgba(82,219,169,0.08),rgba(255,255,255,0.02))] p-5">
                <div className="text-xs font-bold uppercase tracking-[0.24em] text-slate-500">{metric.label}</div>
                <div className="mt-3 text-3xl font-black tracking-tight text-white">{metric.value}</div>
                <p className="mt-2 text-sm leading-7 text-slate-400">{metric.note}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {evidence.highlights.map((item) => (
              <div key={item.title} className="rounded-[26px] border border-white/8 bg-white/[0.03] p-5">
                <h3 className="text-xl font-black tracking-tight text-white">{item.title}</h3>
                <p className="mt-3 text-sm leading-8 text-slate-300">{item.detail}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="industries" className="mt-20">
          <SectionTitle
            eyebrow={ui.officialSite.industriesEyebrow}
            title={ui.officialSite.industriesTitle}
            description={ui.officialSite.industriesDescription}
          />
          <div className="mt-8 rounded-[30px] border border-[#52DBA9]/12 bg-[radial-gradient(circle_at_top_left,rgba(82,219,169,0.12),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-6 md:p-7">
            <div className="text-xs font-bold uppercase tracking-[0.24em] text-[#91ffe1]/75">{ui.officialSite.overviewLabel}</div>
            <p className="mt-4 text-xl font-black leading-9 tracking-tight text-white md:text-2xl md:leading-10">
              {overviewIndustry?.shortValue || ui.officialSite.overviewTitle}
            </p>
            <p className="mt-4 max-w-5xl text-sm leading-8 text-slate-300 md:text-base">
              {overviewIndustry?.longValue || ui.officialSite.overviewBody}
            </p>
          </div>
          <div className="mt-10 grid gap-5 lg:grid-cols-2">
            {industries.map((industry) => {
              if (industry.id === 'overview') return null;
              const Icon = industryIcons[industry.id as keyof typeof industryIcons] || Sparkles;
              return (
                <article
                  key={industry.id}
                  className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-[#52DBA9]/10 text-[#7ef8d2]">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-2xl font-black tracking-tight text-white">{industry.title}</h3>
                      <p className="mt-2 text-sm font-semibold leading-7 text-[#9df4d7]">{industry.oneLiner}</p>
                    </div>
                  </div>
                    <div className="mt-5 grid gap-4">
                    <div className="rounded-[22px] border border-white/6 bg-black/10 p-4">
                      <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{ui.officialSite.industryProblem}</div>
                      <p className="mt-2 text-sm leading-7 text-slate-300">{industry.problem}</p>
                    </div>
                    <div className="rounded-[22px] border border-[#52DBA9]/12 bg-[linear-gradient(180deg,rgba(82,219,169,0.08),rgba(255,255,255,0.02))] p-4">
                      <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#91ffe1]/70">{ui.officialSite.shortJudgment}</div>
                      <p className="mt-2 text-sm font-semibold leading-7 text-white">{industry.shortValue}</p>
                    </div>
                    <div className="rounded-[22px] border border-white/6 bg-black/10 p-4">
                      <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{ui.officialSite.longArgument}</div>
                      <p className="mt-2 text-sm leading-7 text-slate-300">{industry.longValue}</p>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mt-20">
          <div className="overflow-hidden rounded-[34px] border border-amber-300/14 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(82,219,169,0.16),transparent_24%),linear-gradient(180deg,#181923_0%,#10131b_100%)] p-6 md:p-8">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-200/20 bg-amber-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-amber-100">
                  <Activity className="h-3.5 w-3.5" />
                  {hfcdCopy.eyebrow}
                </div>
                <h2 className="mt-5 text-3xl font-black tracking-tight text-white md:text-4xl">{hfcdCopy.title}</h2>
                <p className="mt-4 max-w-4xl text-base leading-8 text-slate-300 md:text-lg">
                  {hfcdCopy.body}
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    onClick={onOpenHFCD}
                    className="inline-flex items-center gap-2 rounded-full bg-amber-200 px-6 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-amber-100"
                  >
                    <Upload className="h-4 w-4" />
                    {hfcdCopy.primary}
                  </button>
                  <a
                    href="#industries"
                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/[0.08]"
                  >
                    {hfcdCopy.secondary}
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </div>
              </div>
              <div className="rounded-[28px] border border-white/8 bg-black/15 p-5">
                <div className="text-xs font-bold uppercase tracking-[0.24em] text-slate-500">Seven Gates</div>
                <div className="mt-4 grid gap-3 text-sm leading-7 text-slate-300">
                  {hfcdCopy.gates.map((gate) => (
                    <div key={gate}>{gate}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-20">
          <SectionTitle eyebrow={ui.officialSite.iterationEyebrow} title={experiment.title} description={experiment.intro} />
          <div className="mt-8 rounded-[32px] border border-white/8 bg-[linear-gradient(180deg,#161922_0%,#10131b_100%)] p-6 md:p-8">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-[#7ef8d2]/20 bg-[#52DBA9]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-[#91ffe1]">
                {experiment.featured.status}
              </span>
              <span className="text-sm text-slate-500">{ui.officialSite.featuredExperiment}</span>
            </div>
            <h3 className="mt-5 text-3xl font-black tracking-tight text-white">{experiment.featured.name}</h3>
            <p className="mt-4 max-w-3xl text-base leading-8 text-slate-300">{experiment.featured.summary}</p>
            <div className="mt-6 rounded-[24px] border border-white/8 bg-white/[0.03] p-5 text-sm leading-7 text-slate-400">
              <span className="font-semibold text-slate-200">{ui.officialSite.nextStep}：</span> {experiment.featured.next}
            </div>
          </div>
        </section>

        <section className="mt-20">
          <div className="overflow-hidden rounded-[32px] border border-white/8 bg-[radial-gradient(circle_at_top_right,rgba(82,219,169,0.2),transparent_26%),linear-gradient(180deg,#171a24_0%,#11141c_100%)] p-6 md:p-8">
            <SectionTitle eyebrow={ui.officialSite.bookEyebrow} title={book.title} description={book.body} />
            <div className="mt-8">
              <a
                href={book.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-bold text-[#11141c] transition-colors hover:bg-[#e8ecf5]"
              >
                <BookOpen className="h-4 w-4" />
                {ui.officialSite.amazonSample}
              </a>
            </div>
          </div>
        </section>

        <section className="mt-20">
          <SectionTitle eyebrow={ui.officialSite.faqEyebrow} title={ui.officialSite.faqTitle} />
          <div className="mt-8 grid gap-4">
            {faq.map((item) => (
              <div key={item.q} className="rounded-[24px] border border-white/8 bg-white/[0.03] p-5">
                <h3 className="text-lg font-bold text-white">{item.q}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-400">{item.a}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
