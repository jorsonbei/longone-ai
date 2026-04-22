import React, { useMemo, useState } from 'react';
import { BarChart3, FileText, MessagesSquare, Plus, Settings2, Shield, Trash2 } from 'lucide-react';
import { ChatSession } from '../types';
import { OfficialSiteContent } from '../content/officialSiteContent';
import { AdminContentDraft } from '../hooks/useAdminContent';

interface AdminDashboardProps {
  userEmail?: string | null;
  content: OfficialSiteContent;
  draft: AdminContentDraft;
  chats: ChatSession[];
  activeChat: ChatSession | null;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  updateField: (field: keyof Omit<AdminContentDraft, 'industries' | 'definitionParagraphs' | 'whyNowBullets' | 'evidenceHighlights' | 'evidenceMetrics' | 'faq'>, value: string) => void;
  updateListField: (field: 'definitionParagraphs' | 'whyNowBullets', index: number, value: string) => void;
  addListFieldItem: (field: 'definitionParagraphs' | 'whyNowBullets') => void;
  removeListFieldItem: (field: 'definitionParagraphs' | 'whyNowBullets', index: number) => void;
  updateEvidenceHighlight: (index: number, field: 'title' | 'detail', value: string) => void;
  addEvidenceHighlight: () => void;
  removeEvidenceHighlight: (index: number) => void;
  updateEvidenceMetric: (index: number, field: 'label' | 'value' | 'note', value: string) => void;
  addEvidenceMetric: () => void;
  removeEvidenceMetric: (index: number) => void;
  updateFaq: (index: number, field: 'q' | 'a', value: string) => void;
  addFaq: () => void;
  removeFaq: (index: number) => void;
  updateIndustry: (industryId: string, field: 'oneLiner' | 'problem' | 'shortValue' | 'longValue', value: string) => void;
  resetDraft: () => void;
  contentSyncState: 'idle' | 'loading' | 'synced' | 'saving' | 'fallback-local' | 'error';
  contentSyncError: string | null;
  systemInstruction: string;
  setSystemInstruction: (value: string) => void;
  settingsSyncState: 'idle' | 'loading' | 'saving' | 'synced' | 'fallback-local';
}

const TABS = [
  { id: 'overview', label: '仪表盘', icon: BarChart3 },
  { id: 'content', label: '内容管理', icon: FileText },
  { id: 'chats', label: '会话管理', icon: MessagesSquare },
  { id: 'system', label: '系统设置', icon: Settings2 },
] as const;

type TabId = typeof TABS[number]['id'];

function PanelTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-2xl font-black tracking-tight text-white">{title}</h2>
      <p className="mt-2 text-sm leading-7 text-slate-400">{description}</p>
    </div>
  );
}

function FieldBlock({
  label,
  hint,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-sm font-semibold text-slate-100">{label}</div>
      <div className="mt-1 text-xs leading-6 text-slate-500">{hint}</div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-3 min-h-[132px] w-full rounded-2xl border border-white/10 bg-[#141821] px-4 py-3 text-sm leading-7 text-slate-200 outline-none transition-colors focus:border-[#52DBA9]/50"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-3 h-12 w-full rounded-2xl border border-white/10 bg-[#141821] px-4 text-sm text-slate-200 outline-none transition-colors focus:border-[#52DBA9]/50"
        />
      )}
    </label>
  );
}

function SectionCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-2 text-xs leading-6 text-slate-500">{description}</div>
      <div className="mt-5 space-y-5">{children}</div>
    </div>
  );
}

function ItemToolbar({
  onAdd,
  addLabel,
}: {
  onAdd: () => void;
  addLabel: string;
}) {
  return (
    <div className="flex justify-end">
      <button
        onClick={onAdd}
        className="inline-flex items-center gap-2 rounded-full border border-[#52DBA9]/20 bg-[#52DBA9]/10 px-4 py-2 text-xs font-semibold text-[#9df4d7] transition-colors hover:bg-[#52DBA9]/16"
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </button>
    </div>
  );
}

export function AdminDashboard({
  userEmail,
  content,
  draft,
  chats,
  activeChat,
  onSelectChat,
  onDeleteChat,
  updateField,
  updateListField,
  addListFieldItem,
  removeListFieldItem,
  updateEvidenceHighlight,
  addEvidenceHighlight,
  removeEvidenceHighlight,
  updateEvidenceMetric,
  addEvidenceMetric,
  removeEvidenceMetric,
  updateFaq,
  addFaq,
  removeFaq,
  updateIndustry,
  resetDraft,
  contentSyncState,
  contentSyncError,
  systemInstruction,
  setSystemInstruction,
  settingsSyncState,
}: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [selectedIndustryId, setSelectedIndustryId] = useState(
    content.industries.find((item) => item.id !== 'overview')?.id || 'ai'
  );
  const [selectedChatId, setSelectedChatId] = useState<string | null>(chats[0]?.id || null);

  React.useEffect(() => {
    if (selectedChatId && chats.some((chat) => chat.id === selectedChatId)) {
      return;
    }
    setSelectedChatId(chats[0]?.id || null);
  }, [chats, selectedChatId]);

  const selectedIndustry = content.industries.find((item) => item.id === selectedIndustryId);
  const selectedChatSummary = chats.find((chat) => chat.id === selectedChatId) || null;
  const selectedChat =
    selectedChatId && activeChat?.id === selectedChatId
      ? activeChat
      : selectedChatSummary;

  const metrics = useMemo(() => {
    const messageCount = chats.reduce((sum, chat) => sum + (chat.messageCount || 0), 0);
    const avgMessages = chats.length ? (messageCount / chats.length).toFixed(1) : '0.0';
    return {
      chatCount: chats.length,
      messageCount,
      avgMessages,
      industryCount: content.industries.filter((item) => item.id !== 'overview').length,
      faqCount: content.faq.length,
      evidenceCount: content.evidence.highlights.length,
    };
  }, [chats, content.industries, content.faq.length, content.evidence.highlights.length]);

  const contentSyncLabel =
    contentSyncState === 'loading'
      ? '正在读取云端内容'
      : contentSyncState === 'saving'
        ? '正在同步到 Firestore'
        : contentSyncState === 'synced'
          ? '已同步到 Firestore'
          : contentSyncState === 'fallback-local'
            ? '当前退回本地草稿模式'
            : contentSyncState === 'error'
              ? '云端同步失败'
              : '等待同步';

  return (
    <div className="h-full overflow-y-auto bg-[#0f1117] text-slate-100">
      <div className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 md:px-8">
        <div className="rounded-[30px] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(82,219,169,0.16),transparent_26%),linear-gradient(180deg,#171a24_0%,#10131b_100%)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.32)] md:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-[#7ef8d2]/20 bg-[#52DBA9]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-[#9df4d7]">
                <Shield className="h-3.5 w-3.5" />
                管理后台
              </div>
              <h1 className="mt-5 text-4xl font-black tracking-tight text-white">物性论 OS 控制台</h1>
              <p className="mt-3 max-w-3xl text-sm leading-8 text-slate-300 md:text-base">
                第一阶段后台先解决三个实际问题：内容改动不再每次重写官网、会话能被集中查看、系统提示可以统一收口。
              </p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-slate-300">
              当前管理员：<span className="font-semibold text-white">{userEmail || '未知账号'}</span>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                  isActive
                    ? 'border-[#52DBA9]/30 bg-[#52DBA9]/14 text-[#9df4d7]'
                    : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.07] hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === 'overview' ? (
          <section className="mt-8">
            <PanelTitle title="后台总览" description="先看站点和内容的基础健康度，再决定是改文案、查会话还是调系统提示。" />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[
                { label: '总会话数', value: metrics.chatCount, note: '当前 Firestore 会话记录' },
                { label: '总消息数', value: metrics.messageCount, note: '用户与模型消息总量' },
                { label: '平均会话深度', value: metrics.avgMessages, note: '每个会话平均消息数' },
                { label: '官网行业卡片', value: metrics.industryCount, note: '当前已覆盖的行业模块' },
                { label: 'FAQ 数量', value: metrics.faqCount, note: '后台现已可编辑 FAQ' },
                { label: '证据模块条目', value: metrics.evidenceCount, note: '实验亮点与证据项' },
              ].map((item) => (
                <div key={item.label} className="rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-5">
                  <div className="text-xs font-bold uppercase tracking-[0.24em] text-slate-500">{item.label}</div>
                  <div className="mt-4 text-4xl font-black tracking-tight text-white">{item.value}</div>
                  <p className="mt-3 text-sm leading-7 text-slate-400">{item.note}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === 'content' ? (
          <section className="mt-8">
            <PanelTitle
              title="内容管理"
              description="这一版已经把官网真正关键的内容区都纳进后台：SEO、首屏、定义、Why Now、证据区、行业价值、实验区、书籍区和 FAQ。"
            />
            <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(360px,1.05fr)]">
              <div className="space-y-5">
                <SectionCard title="SEO 与分享" description="控制官网标题和描述，决定搜索结果与分享卡片的第一印象。">
                  <FieldBlock label="SEO 标题" hint="浏览器标题、社交分享标题。" value={draft.seoTitle} onChange={(value) => updateField('seoTitle', value)} />
                  <FieldBlock label="SEO 描述" hint="搜索引擎描述与分享摘要。" value={draft.seoDescription} onChange={(value) => updateField('seoDescription', value)} multiline />
                  <FieldBlock label="SEO 分享图" hint="Open Graph 图片 URL。" value={draft.seoImage} onChange={(value) => updateField('seoImage', value)} />
                </SectionCard>

                <SectionCard title="首屏 Hero" description="官网第一屏最重要的两行话，负责把人拉进来。">
                  <FieldBlock label="徽标短语" hint="Hero 顶部的小徽标文案。" value={draft.heroBadge} onChange={(value) => updateField('heroBadge', value)} />
                  <FieldBlock label="Hero 标题" hint="官网首屏的最大标题。" value={draft.heroTitle} onChange={(value) => updateField('heroTitle', value)} />
                  <FieldBlock label="Hero 副标题" hint="解释官网想打出的主问题。" value={draft.heroSubtitle} onChange={(value) => updateField('heroSubtitle', value)} multiline />
                  <FieldBlock label="主按钮文案" hint="首屏主要 CTA。" value={draft.heroPrimaryCtaLabel} onChange={(value) => updateField('heroPrimaryCtaLabel', value)} />
                  <FieldBlock label="主按钮链接" hint="通常指向 Amazon 试读。" value={draft.heroPrimaryCtaHref} onChange={(value) => updateField('heroPrimaryCtaHref', value)} />
                  <FieldBlock label="副按钮文案" hint="首屏第二 CTA。" value={draft.heroSecondaryCtaLabel} onChange={(value) => updateField('heroSecondaryCtaLabel', value)} />
                  <FieldBlock label="副按钮链接" hint="通常是站内锚点，如 #industries。" value={draft.heroSecondaryCtaHref} onChange={(value) => updateField('heroSecondaryCtaHref', value)} />
                </SectionCard>

                <SectionCard title="什么是物性论" description="用普通人能懂的话先立住定义。">
                  <FieldBlock label="区块标题" hint="Definition 模块标题。" value={draft.definitionTitle} onChange={(value) => updateField('definitionTitle', value)} />
                  {draft.definitionParagraphs.map((paragraph, index) => (
                    <div key={`definition-${index}`} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{`定义段落 ${index + 1}`}</div>
                        <button
                          onClick={() => removeListFieldItem('definitionParagraphs', index)}
                          className="rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/16"
                        >
                          删除
                        </button>
                      </div>
                      <FieldBlock
                        label={`定义段落 ${index + 1}`}
                        hint="建议保持通俗解释，少术语。"
                        value={paragraph}
                        onChange={(value) => updateListField('definitionParagraphs', index, value)}
                        multiline
                      />
                    </div>
                  ))}
                  <ItemToolbar onAdd={() => addListFieldItem('definitionParagraphs')} addLabel="新增定义段落" />
                </SectionCard>

                <SectionCard title="为什么现在需要它" description="把理论与时代问题真正接上。">
                  <FieldBlock label="区块标题" hint="Why Now 模块标题。" value={draft.whyNowTitle} onChange={(value) => updateField('whyNowTitle', value)} />
                  {draft.whyNowBullets.map((bullet, index) => (
                    <div key={`why-${index}`} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{`论点 ${index + 1}`}</div>
                        <button
                          onClick={() => removeListFieldItem('whyNowBullets', index)}
                          className="rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/16"
                        >
                          删除
                        </button>
                      </div>
                      <FieldBlock
                        label={`论点 ${index + 1}`}
                        hint="每条都要能独立成立。"
                        value={bullet}
                        onChange={(value) => updateListField('whyNowBullets', index, value)}
                        multiline
                      />
                    </div>
                  ))}
                  <ItemToolbar onAdd={() => addListFieldItem('whyNowBullets')} addLabel="新增 Why Now 论点" />
                </SectionCard>

                <SectionCard title="证据与实验支撑" description="这是官网最容易被忽略，但也最能建立可信度的区块。">
                  <FieldBlock label="区块标题" hint="Evidence 模块标题。" value={draft.evidenceTitle} onChange={(value) => updateField('evidenceTitle', value)} />
                  <FieldBlock label="证据区引言" hint="先告诉用户为什么这不是空话。" value={draft.evidenceIntro} onChange={(value) => updateField('evidenceIntro', value)} multiline />
                  {draft.evidenceMetrics.map((metric, index) => (
                    <div key={`metric-${index}`} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">指标 {index + 1}</div>
                        <button
                          onClick={() => removeEvidenceMetric(index)}
                          className="rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/16"
                        >
                          删除
                        </button>
                      </div>
                      <div className="mt-4 grid gap-4">
                        <FieldBlock label="标签" hint="例如 stable 恢复。" value={metric.label} onChange={(value) => updateEvidenceMetric(index, 'label', value)} />
                        <FieldBlock label="数值" hint="例如 6 / 36。" value={metric.value} onChange={(value) => updateEvidenceMetric(index, 'value', value)} />
                        <FieldBlock label="说明" hint="指标的意义。" value={metric.note} onChange={(value) => updateEvidenceMetric(index, 'note', value)} multiline />
                      </div>
                    </div>
                  ))}
                  <ItemToolbar onAdd={addEvidenceMetric} addLabel="新增证据指标" />
                  {draft.evidenceHighlights.map((item, index) => (
                    <div key={`highlight-${index}`} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">亮点 {index + 1}</div>
                        <button
                          onClick={() => removeEvidenceHighlight(index)}
                          className="rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/16"
                        >
                          删除
                        </button>
                      </div>
                      <div className="mt-4 grid gap-4">
                        <FieldBlock label="标题" hint="这条证据的短标题。" value={item.title} onChange={(value) => updateEvidenceHighlight(index, 'title', value)} />
                        <FieldBlock label="说明" hint="展开解释这个证据为什么有意义。" value={item.detail} onChange={(value) => updateEvidenceHighlight(index, 'detail', value)} multiline />
                      </div>
                    </div>
                  ))}
                  <ItemToolbar onAdd={addEvidenceHighlight} addLabel="新增证据亮点" />
                </SectionCard>
              </div>

              <div className="space-y-5">
                <div className="rounded-[28px] border border-[#52DBA9]/14 bg-[linear-gradient(180deg,rgba(82,219,169,0.08),rgba(255,255,255,0.02))] p-5">
                  <div className="text-sm font-semibold text-white">行业卡片编辑器</div>
                  <div className="mt-3 text-xs leading-6 text-slate-400">
                    每个行业现在都有金句式短版判断和展开式长版论证。这里按单行业编辑，避免一次改乱全部结构。
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {content.industries.filter((item) => item.id !== 'overview').map((industry) => (
                      <button
                        key={industry.id}
                        onClick={() => setSelectedIndustryId(industry.id)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                          selectedIndustryId === industry.id
                            ? 'border-[#52DBA9]/30 bg-[#52DBA9]/14 text-[#9df4d7]'
                            : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.07]'
                        }`}
                      >
                        {industry.title}
                      </button>
                    ))}
                  </div>
                </div>

                <SectionCard title="行业总论" description="先把所有行业为什么共同回到能量与结构问题讲透。">
                  <FieldBlock
                    label="总论长版"
                    hint="这是行业总论的大段解释。"
                    value={draft.industryMacroThesis}
                    onChange={(value) => updateField('industryMacroThesis', value)}
                    multiline
                  />
                </SectionCard>

                {selectedIndustry ? (
                  <SectionCard title={selectedIndustry.title} description="每个行业都保留三层表达：金句、短版价值、长版论证。">
                    <FieldBlock
                      label="金句短判断"
                      hint="适合截图传播，必须短、硬、清楚。"
                      value={draft.industries[selectedIndustry.id]?.oneLiner || ''}
                      onChange={(value) => updateIndustry(selectedIndustry.id, 'oneLiner', value)}
                      multiline
                    />
                    <FieldBlock
                      label="行业问题"
                      hint="这个行业在现实世界里到底卡在哪里。"
                      value={draft.industries[selectedIndustry.id]?.problem || ''}
                      onChange={(value) => updateIndustry(selectedIndustry.id, 'problem', value)}
                      multiline
                    />
                    <FieldBlock
                      label="短版价值"
                      hint="官网卡片中间那层核心判断。"
                      value={draft.industries[selectedIndustry.id]?.shortValue || ''}
                      onChange={(value) => updateIndustry(selectedIndustry.id, 'shortValue', value)}
                      multiline
                    />
                    <FieldBlock
                      label="长版论证"
                      hint="把价值说透，不怕稍微猛一点，但要讲因果。"
                      value={draft.industries[selectedIndustry.id]?.longValue || ''}
                      onChange={(value) => updateIndustry(selectedIndustry.id, 'longValue', value)}
                      multiline
                    />
                  </SectionCard>
                ) : null}

                <SectionCard title="实验区与书籍区" description="这两块决定官网的持续更新感和进一步转化。">
                  <FieldBlock label="实验区标题" hint="Iteration 模块标题。" value={draft.experimentTitle} onChange={(value) => updateField('experimentTitle', value)} />
                  <FieldBlock label="实验区引言" hint="解释实验与迭代为什么重要。" value={draft.experimentIntro} onChange={(value) => updateField('experimentIntro', value)} multiline />
                  <FieldBlock label="实验名称" hint="例如 物性论_HFCD_实验。" value={draft.experimentName} onChange={(value) => updateField('experimentName', value)} />
                  <FieldBlock label="实验状态" hint="例如 迭代中。" value={draft.experimentStatus} onChange={(value) => updateField('experimentStatus', value)} />
                  <FieldBlock label="实验摘要" hint="HFCD 实验区块的主摘要。" value={draft.experimentSummary} onChange={(value) => updateField('experimentSummary', value)} multiline />
                  <FieldBlock label="实验下一步" hint="官网上给出的迭代方向。" value={draft.experimentNext} onChange={(value) => updateField('experimentNext', value)} multiline />
                  <FieldBlock label="书籍区标题" hint="书籍 CTA 区块标题。" value={draft.bookTitle} onChange={(value) => updateField('bookTitle', value)} />
                  <FieldBlock label="书籍区说明" hint="Amazon 阅读入口上方的解释文案。" value={draft.bookBody} onChange={(value) => updateField('bookBody', value)} multiline />
                  <FieldBlock label="书籍区链接" hint="默认是 Amazon 试读链接。" value={draft.bookHref} onChange={(value) => updateField('bookHref', value)} />
                </SectionCard>

                <SectionCard title="FAQ 常见问题" description="FAQ 已纳入后台，这一块是当前最明显的缺口之一。">
                  {draft.faq.map((item, index) => (
                    <div key={`faq-${index}`} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">问题 {index + 1}</div>
                        <button
                          onClick={() => removeFaq(index)}
                          className="rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/16"
                        >
                          删除
                        </button>
                      </div>
                      <div className="mt-4 grid gap-4">
                        <FieldBlock label="问题" hint="尽量用用户会真实搜索的问法。" value={item.q} onChange={(value) => updateFaq(index, 'q', value)} />
                        <FieldBlock label="回答" hint="保持清楚、有理有据，避免过长。" value={item.a} onChange={(value) => updateFaq(index, 'a', value)} multiline />
                      </div>
                    </div>
                  ))}
                  <ItemToolbar onAdd={addFaq} addLabel="新增 FAQ" />
                </SectionCard>

                <div className="flex items-center justify-between rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <div>
                    <div className="text-sm font-semibold text-white">{contentSyncLabel}</div>
                    <p className="mt-2 text-xs leading-6 text-slate-400">
                      {contentSyncError || '这一版会优先同步到当前 workspace 的 Firestore；如果规则或网络挡住了，再自动退回本地草稿。'}
                    </p>
                  </div>
                  <button
                    onClick={resetDraft}
                    className="rounded-full border border-red-400/20 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/16"
                  >
                    重置草稿
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'chats' ? (
          <section className="mt-8">
            <PanelTitle title="会话管理" description="先做最有价值的后台能力：集中查看对话、回溯高价值会话、快速删除明显无效内容。" />
            <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
              <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-4">
                <div className="mb-3 text-sm font-semibold text-white">会话列表</div>
                <div className="space-y-2">
                  {chats.map((chat) => (
                    <button
                      key={chat.id}
                      onClick={() => {
                        setSelectedChatId(chat.id);
                        onSelectChat(chat.id);
                      }}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${
                        selectedChatId === chat.id
                          ? 'border-[#52DBA9]/25 bg-[#52DBA9]/10 text-white'
                          : 'border-white/8 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]'
                      }`}
                    >
                      <div className="truncate text-sm font-semibold">{chat.title}</div>
                      <div className="mt-1 text-xs text-slate-500">{chat.messageCount || 0} 条消息</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                {selectedChat ? (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="text-2xl font-black tracking-tight text-white">{selectedChat.title}</div>
                        <div className="mt-2 text-xs uppercase tracking-[0.22em] text-slate-500">Chat ID · {selectedChat.id}</div>
                      </div>
                      <button
                        onClick={() => {
                          if (confirm('确认删除这个会话吗？')) {
                            onDeleteChat(selectedChat.id);
                            setSelectedChatId(chats.find((chat) => chat.id !== selectedChat.id)?.id || null);
                          }
                        }}
                        className="inline-flex items-center gap-2 rounded-full border border-red-400/20 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/16"
                      >
                        <Trash2 className="h-4 w-4" />
                        删除会话
                      </button>
                    </div>
                    <div className="mt-6 max-h-[560px] space-y-3 overflow-y-auto pr-1">
                      {selectedChat.messages.length > 0 ? (
                        selectedChat.messages.map((message) => (
                          <div key={message.id} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                            <div className="text-xs font-bold uppercase tracking-[0.22em] text-slate-500">{message.role === 'user' ? '用户' : '模型'}</div>
                            <div className="mt-3 whitespace-pre-wrap text-sm leading-8 text-slate-200">{message.content || '（空内容）'}</div>
                          </div>
                        ))
                      ) : (
                        <div className="text-sm text-slate-500">当前会话的消息还在读取中，或尚无正文可显示。</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-slate-500">当前没有可查看的会话。</div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'system' ? (
          <section className="mt-8">
            <PanelTitle title="系统设置" description="第一期先把最影响体验的系统提示收口到一个后台入口，避免继续散在代码和个人本地设置里。" />
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                <FieldBlock
                  label="默认 Persona / 系统提示"
                  hint={
                    settingsSyncState === 'synced'
                      ? '当前系统提示已同步到 Firestore。'
                      : settingsSyncState === 'saving'
                        ? '正在把系统提示写入 Firestore。'
                        : settingsSyncState === 'fallback-local'
                          ? '当前退回本地浏览器保存；稍后可检查 Firestore 规则。'
                          : '系统设置正在初始化。'
                  }
                  value={systemInstruction}
                  onChange={setSystemInstruction}
                  multiline
                />
              </div>
              <div className="rounded-[28px] border border-[#52DBA9]/14 bg-[linear-gradient(180deg,rgba(82,219,169,0.08),rgba(255,255,255,0.02))] p-5">
                <div className="text-sm font-semibold text-white">这一页当前能管什么</div>
                <ul className="mt-4 space-y-2 text-sm leading-7 text-slate-200">
                  <li>1. 默认短答 / 长答风格。</li>
                  <li>2. 轻量消息时是否过度解读。</li>
                  <li>3. 未来可扩展成分享模板、官网 SEO、模型默认策略。</li>
                </ul>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
