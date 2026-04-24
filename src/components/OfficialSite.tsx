import React from 'react';
import { ArrowRight, BookOpen, Cpu, Microscope, Orbit, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { ThingNatureBrand } from './ThingNatureBrand';
import { officialSiteContent, OfficialSiteContent } from '../content/officialSiteContent';
import type { UiText } from '../content/uiText';

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
  content?: OfficialSiteContent;
  ui: UiText;
}

function SectionTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="max-w-3xl">
      <div className="text-xs font-bold uppercase tracking-[0.28em] text-[#7ef8d2]/80">{eyebrow}</div>
      <h2 className="mt-4 text-3xl font-black tracking-tight text-white md:text-4xl">{title}</h2>
      {description ? <p className="mt-4 text-base leading-8 text-slate-400 md:text-lg">{description}</p> : null}
    </div>
  );
}

export function OfficialSite({ onBackToChat, content = officialSiteContent, ui }: OfficialSiteProps) {
  const { hero, definition, whyNow, evidence, industries, experiment, book, faq } = content;
  const overviewIndustry = industries.find((industry) => industry.id === 'overview');

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
