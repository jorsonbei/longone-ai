import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Database,
  Download,
  FileDown,
  FileText,
  FlaskConical,
  Gauge,
  Layers3,
  Microscope,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import {
  auditRecords,
  BASE_REPAIR_PLANS,
  FAILURE_MODE_LABELS,
  flattenAuditResult,
  generateMarkdownReport,
  getFieldProfile,
  getIndustryFieldProfiles,
  defaultHFCDFieldSimulationInput,
  HFCDFieldSimulationInput,
  HFCDFieldSimulationReport,
  HFCD_GATE_EXPLANATIONS,
  HFCD_INDUSTRIES,
  HFCDIndustry,
  HFCDParameterProfile,
  HFCDSimulationReport,
  HFCDAuditResult,
  HFCDFailureMode,
  learnHFCDParameters,
  normalizeHFCDFieldSimulationInput,
  parseCsv,
  runHFCDFieldSimulation,
  simulateHFCDScenarios,
  summarizeAudit,
  summarizeGateSafety,
  templateToCsv,
  toCsv,
  validateBlindMetrics,
  validateRows,
} from '../lib/hfcdCore';
import {
  HFCDResearchJobPlan,
  HFCDResearchJobRequest,
  HFCDResearchJobStatus,
} from '../lib/hfcdResearchJobs';

type WorkbenchTab =
  | 'dashboard'
  | 'upload'
  | 'templates'
  | 'reports'
  | 'blind'
  | 'calibration'
  | 'simulation'
  | 'research'
  | 'projects'
  | 'api'
  | 'knowledge';

interface HFCDReportRecord {
  id: string;
  projectId?: string;
  datasetId?: string;
  projectName: string;
  industry: HFCDIndustry;
  createdAt: number;
  fileName: string;
  results: HFCDAuditResult[];
}

interface HFCDProjectRecord {
  id: string;
  name: string;
  organization: string;
  owner: string;
  status: 'active' | 'pilot' | 'archived';
  createdAt: number;
  members: Array<{ name: string; role: 'owner' | 'research' | 'viewer' }>;
}

interface HFCDDatasetRecord {
  id: string;
  projectId: string;
  reportId: string;
  fileName: string;
  industry: HFCDIndustry;
  rowCount: number;
  createdAt: number;
}

interface HFCDApiKeyRecord {
  id: string;
  name: string;
  key: string;
  createdAt: number;
  callCount: number;
  lastUsedAt?: number;
}

interface HFCDResearchJobRecord {
  id: string;
  projectName: string;
  preset: HFCDResearchJobRequest['preset'];
  status: HFCDResearchJobStatus;
  createdAt: number;
  operationName?: string;
  artifactPrefix?: string;
  message?: string;
  plan?: HFCDResearchJobPlan;
  manifest?: unknown;
}

const REPORT_STORAGE_KEY = 'hfcdAuditReportsV1';
const PROJECT_STORAGE_KEY = 'hfcdProjectsV1';
const DATASET_STORAGE_KEY = 'hfcdDatasetsV1';
const API_KEYS_STORAGE_KEY = 'hfcdApiKeysV1';
const RESEARCH_JOBS_STORAGE_KEY = 'hfcdResearchJobsV1';

const TABS: Array<{ id: WorkbenchTab; label: string; icon: React.ElementType }> = [
  { id: 'dashboard', label: '价值与快速开始', icon: BarChart3 },
  { id: 'upload', label: '上传数据', icon: Upload },
  { id: 'blind', label: '盲测验证', icon: ShieldAlert },
  { id: 'research', label: '云端真实跑模型', icon: Microscope },
  { id: 'reports', label: '结果中心', icon: FileText },
];

const gateLabels = [
  'Q_error',
  'energy_drift_per_q',
  'cavity_peak_ratio',
  'peak_ratio',
  'radius_ratio',
  'manifest_fraction',
  'buffer_score',
] as const;

const HFCD_EXPERIMENT_EVIDENCE = {
  headline: '从 595 条候选研发路径中筛出 558 条高稳定方案',
  source: 'HFCD V12.38 Post-27000 ME28800 长程实验',
  summary:
    '这组实验不是页面演示数据，而是从本地 HFCD 长程实验链沉淀出的真实结果：系统持续比较多条修复路线，判断哪些路线能在更长运行周期里保持稳定，哪些路线应该提前淘汰。',
  metrics: [
    { label: '候选研发路径', value: '595', note: '相当于同时比较 595 条可能的修复/调参路线。' },
    { label: '高稳定候选方案', value: '558', note: '长程测试后仍保持稳定，可进入下一轮研发优先级。' },
    { label: '稳定方案占比', value: '93.78%', note: '用于说明系统能把大批候选路线压缩成可行动清单。' },
    { label: '提前淘汰风险路线', value: '37', note: '避免团队继续投入可能失稳的方向。' },
  ],
  cloudMetrics: [
    { label: '源 checkpoint 复核', value: '101', note: '从多组历史状态继续复跑，验证不是单点偶然。' },
    { label: '稳定结果落盘', value: '499', note: 'V12.37 阶段可追溯稳定结果。' },
    { label: '云端 smoke 产物', value: '447', note: 'Cloud Run 已能输出报告、图表、CSV、summary 和日志。' },
  ],
  routeBars: [
    { label: '支撑条件增强', count: 119, total: 119, note: '增强承载环境，让关键输出稳定承接。' },
    { label: '核心状态回中', count: 119, total: 119, note: '把偏离的核心状态拉回安全区。' },
    { label: '峰值/扩散保护', count: 113, total: 119, note: '防止局部性能过冲带来系统性扩散。' },
    { label: '边界组合闭合', count: 104, total: 119, note: '同时收紧多个边界条件。' },
    { label: '微能量清理', count: 103, total: 119, note: '清理小幅但持续积累的负载漂移。' },
  ],
  evolution: [
    { label: 'V12.35', step: '23,400', stable: 29, total: 43 },
    { label: 'V12.37', step: '27,000', stable: 499, total: 505 },
    { label: 'V12.38', step: '28,800', stable: 558, total: 595 },
  ],
};

function downloadText(fileName: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildClientHtmlReport({
  projectName,
  industry,
  results,
}: {
  projectName: string;
  industry: HFCDIndustry;
  results: HFCDAuditResult[];
}) {
  const spec = HFCD_INDUSTRIES[industry];
  const summary = summarizeAudit(results);
  const validation = validateBlindMetrics(results);
  const fields = getIndustryFieldProfiles(industry);
  const topRisk = [...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 10);
  const conclusion =
    summary.highRiskCount > 0
      ? `本批数据出现 ${summary.highRiskCount} 个高风险样本，主要风险为 ${compactFailureMode(summary.primaryFailureMode)}。建议先锁定风险最高的样本做研发复盘。`
      : summary.strictStableCount === summary.sampleCount && summary.sampleCount > 0
        ? '本批数据整体处于全部达标状态，可作为当前阶段的参考样本。'
        : `本批数据处于临界状态，主要风险为 ${compactFailureMode(summary.primaryFailureMode)}，建议先修复未通过的关键指标。`;

  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName || 'HFCD 稳定窗审计报告')}</title>
  <style>
    body{margin:0;background:#0f1117;color:#e5edf7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7}
    main{max-width:1120px;margin:0 auto;padding:48px 28px 72px}
    .hero,.card{border:1px solid rgba(255,255,255,.09);border-radius:28px;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.025));box-shadow:0 24px 80px rgba(0,0,0,.28)}
    .hero{padding:36px;background:radial-gradient(circle at 10% 0%,rgba(82,219,169,.18),transparent 28%),linear-gradient(180deg,#171a24,#10131b)}
    h1{margin:10px 0 10px;font-size:38px;line-height:1.12}
    h2{margin:34px 0 16px;font-size:24px}
    .eyebrow{color:#8dffdf;font-size:12px;font-weight:800;letter-spacing:.22em;text-transform:uppercase}
    .muted{color:#9aa8bd}.grid{display:grid;gap:14px}.metrics{grid-template-columns:repeat(5,minmax(0,1fr));margin-top:22px}
    .metric{border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:16px;background:rgba(0,0,0,.16)}
    .metric b{display:block;font-size:24px;color:#fff}.metric span{font-size:12px;color:#8b9bb3}
    table{width:100%;border-collapse:collapse;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden}
    th,td{border-bottom:1px solid rgba(255,255,255,.08);padding:10px 12px;text-align:left;vertical-align:top;font-size:13px}
    th{color:#8dffdf;background:rgba(82,219,169,.08);font-size:11px;letter-spacing:.12em;text-transform:uppercase}
    .card{padding:22px;margin:14px 0}.pill{display:inline-block;border-radius:999px;padding:3px 10px;background:rgba(82,219,169,.12);color:#9df4d7;font-size:12px;font-weight:800}
    .risk{background:rgba(245,158,11,.14);color:#fde68a}.high{background:rgba(248,113,113,.14);color:#fecaca}
    .cols{grid-template-columns:repeat(3,minmax(0,1fr))}.small{font-size:13px;color:#9aa8bd}
    @media(max-width:860px){.metrics,.cols{grid-template-columns:1fr}main{padding:28px 16px}h1{font-size:30px}}
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div class="eyebrow">HFCD Stability-Window Audit</div>
    <h1>${escapeHtml(projectName || 'HFCD 稳定窗审计报告')}</h1>
    <p class="muted">行业：${escapeHtml(spec.title)}。${escapeHtml(conclusion)}</p>
    <div class="grid metrics">
      <div class="metric"><b>${summary.sampleCount}</b><span>样本数</span></div>
      <div class="metric"><b>${summary.strictStableCount}</b><span>全部达标</span></div>
      <div class="metric"><b>${summary.looseStableCount}</b><span>核心达标</span></div>
      <div class="metric"><b>${summary.highRiskCount}</b><span>高风险样本</span></div>
      <div class="metric"><b>${summary.averageRiskScore}</b><span>平均风险分</span></div>
    </div>
  </section>

  <h2>字段解释</h2>
  <table>
    <thead><tr><th>字段</th><th>业务含义</th><th>推荐区间</th><th>风险信号</th></tr></thead>
    <tbody>
      ${fields
        .map(
          (field) =>
            `<tr><td><code>${escapeHtml(field.key)}</code><br />${escapeHtml(field.label)}</td><td>${escapeHtml(field.plainMeaning || field.description)}</td><td>${escapeHtml(field.goodRange || '-')}</td><td>${escapeHtml(field.riskSignal || '-')}</td></tr>`,
        )
        .join('')}
    </tbody>
  </table>

  <h2>样本诊断</h2>
  ${topRisk
    .map((result) => {
      const severityClass = result.readable.severity === '高风险' ? 'high' : result.readable.severity === '临界' ? 'risk' : '';
      return `<article class="card">
        <span class="pill ${severityClass}">${escapeHtml(result.readable.severity)} · 风险分 ${result.risk_score}</span>
        <h3>${escapeHtml(result.sample_id)} · ${escapeHtml(compactFailureMode(result.failure_mode))}</h3>
        <div class="grid cols">
          <div><b>业务解释</b><p class="small">${escapeHtml(result.readable.businessSummary)}</p></div>
          <div><b>关键指标</b><p class="small">${escapeHtml(result.readable.hfcdSummary)}</p></div>
          <div><b>修复方案</b><p class="small">${escapeHtml(result.readable.repairSummary)}</p></div>
        </div>
      </article>`;
    })
    .join('')}

  <h2>盲测指标</h2>
  <div class="card">
    <p>actual_failure 标签：${validation.hasActualFailure ? '已检测' : '未提供'}；AUC：${validation.auc ?? 'N/A'}；precision@top10%：${validation.precisionTop10 ?? 'N/A'}。</p>
    <p class="small">说明：当前报告用于快速审计历史实验、生产、寿命或质检数据；如需深度仿真，可在下一阶段补充物理参数、工艺参数、边界条件和数字孪生输入。</p>
  </div>
</main>
</body>
</html>`;
}

function MetricCard({ label, value, note }: { label: string; value: React.ReactNode; note: string }) {
  return (
    <div className="rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.018))] p-5">
      <div className="text-xs font-bold uppercase tracking-[0.24em] text-slate-500">{label}</div>
      <div className="mt-4 text-4xl font-black tracking-tight text-white">{value}</div>
      <p className="mt-3 text-sm leading-7 text-slate-400">{note}</p>
    </div>
  );
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-6">
      <div className="text-xs font-bold uppercase tracking-[0.28em] text-[#7ef8d2]/75">R&D Risk Validation</div>
      <h2 className="mt-3 text-3xl font-black tracking-tight text-white">{title}</h2>
      <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-400 md:text-base">{description}</p>
    </div>
  );
}

function evidencePercent(count: number, total: number) {
  if (!total) return '0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

function EvidenceMetricCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-[26px] border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-5">
      <div className="text-xs font-bold uppercase tracking-[0.22em] text-[#8dffdf]">{label}</div>
      <div className="mt-4 text-4xl font-black tracking-tight text-white">{value}</div>
      <p className="mt-3 text-sm leading-7 text-slate-300">{note}</p>
    </div>
  );
}

function ExperimentEvidencePanel() {
  return (
    <div className="rounded-[34px] border border-[#52DBA9]/18 bg-[radial-gradient(circle_at_12%_0%,rgba(82,219,169,0.16),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.018))] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-4xl">
          <div className="text-xs font-black uppercase tracking-[0.28em] text-[#8dffdf]">真实实验能力证据</div>
          <h3 className="mt-3 text-3xl font-black tracking-tight text-white">{HFCD_EXPERIMENT_EVIDENCE.headline}</h3>
          <p className="mt-3 text-sm leading-8 text-slate-300">{HFCD_EXPERIMENT_EVIDENCE.summary}</p>
        </div>
        <div className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs font-bold text-slate-300">
          {HFCD_EXPERIMENT_EVIDENCE.source}
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {HFCD_EXPERIMENT_EVIDENCE.metrics.map((metric) => (
          <EvidenceMetricCard key={metric.label} label={metric.label} value={metric.value} note={metric.note} />
        ))}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div className="rounded-[28px] border border-white/8 bg-black/12 p-5">
          <h4 className="text-xl font-black text-white">系统能比较不同研发修复路线</h4>
          <p className="mt-2 text-sm leading-7 text-slate-400">
            下面不是抽象分数，而是“哪类修复路线在长程测试里更稳”。客户可以用这个逻辑判断下一轮实验先做什么、暂停什么。
          </p>
          <div className="mt-5 space-y-4">
            {HFCD_EXPERIMENT_EVIDENCE.routeBars.map((item) => {
              const pct = Math.round((item.count / item.total) * 100);
              return (
                <div key={item.label}>
                  <div className="mb-2 flex items-center justify-between gap-4 text-sm">
                    <div>
                      <span className="font-bold text-white">{item.label}</span>
                      <span className="ml-2 text-slate-500">{item.note}</span>
                    </div>
                    <span className="font-mono text-[#9df4d7]">{item.count}/{item.total}</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-white/8">
                    <div className="h-full rounded-full bg-[#52DBA9]" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-[28px] border border-white/8 bg-black/12 p-5">
          <h4 className="text-xl font-black text-white">从实验数据到客户可用结果</h4>
          <div className="mt-5 space-y-4">
            {HFCD_EXPERIMENT_EVIDENCE.evolution.map((item) => {
              const pct = Math.round((item.stable / item.total) * 100);
              return (
                <div key={item.label} className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-bold text-white">{item.label}</div>
                      <div className="mt-1 text-xs text-slate-500">{item.step} 步长程测试</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-black text-[#9df4d7]">{evidencePercent(item.stable, item.total)}</div>
                      <div className="text-xs text-slate-500">{item.stable}/{item.total} 稳定</div>
                    </div>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                    <div className="h-full rounded-full bg-[#52DBA9]" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {HFCD_EXPERIMENT_EVIDENCE.cloudMetrics.map((metric) => (
              <div key={metric.label} className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
                <div className="text-2xl font-black text-white">{metric.value}</div>
                <div className="mt-1 text-xs font-bold text-[#9df4d7]">{metric.label}</div>
                <p className="mt-2 text-xs leading-5 text-slate-500">{metric.note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkflowCard({
  title,
  badge,
  description,
  points,
  action,
  onClick,
}: {
  title: string;
  badge: string;
  description: string;
  points: string[];
  action: string;
  onClick: () => void;
}) {
  return (
    <article className="rounded-[30px] border border-white/8 bg-white/[0.03] p-5">
      <div className="text-xs font-black uppercase tracking-[0.24em] text-[#8dffdf]">{badge}</div>
      <h3 className="mt-3 text-2xl font-black text-white">{title}</h3>
      <p className="mt-3 text-sm leading-7 text-slate-400">{description}</p>
      <div className="mt-4 space-y-2">
        {points.map((point) => (
          <div key={point} className="flex gap-2 text-sm leading-6 text-slate-300">
            <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[#7ef8d2]" />
            <span>{point}</span>
          </div>
        ))}
      </div>
      <button
        onClick={onClick}
        className="mt-5 rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
      >
        {action}
      </button>
    </article>
  );
}

function IndustryUploadGuide({ industry }: { industry: HFCDIndustry }) {
  const spec = HFCD_INDUSTRIES[industry];
  const required = getIndustryFieldProfiles(industry).filter((field) => field.required).slice(0, 8);
  const optional = getIndustryFieldProfiles(industry)
    .filter((field) => !field.required)
    .slice(0, 5);
  return (
    <div className="rounded-[24px] border border-white/8 bg-black/10 p-4">
      <div className="text-sm font-black text-white">你要上传什么数据？</div>
      <p className="mt-2 text-xs leading-6 text-slate-400">
        当前选择：{spec.title}。上传历史实验、生产、校准、寿命或质检 CSV；如果要做盲测验证，请额外提供 actual_failure。
      </p>
      <div className="mt-4 space-y-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">建议必填字段</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {required.map((field) => (
              <span key={field.key} className="rounded-full border border-[#52DBA9]/16 bg-[#52DBA9]/8 px-3 py-1 text-[11px] font-semibold text-[#9df4d7]">
                {field.label}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">可选增强字段</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {optional.map((field) => (
              <span key={field.key} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-slate-300">
                {field.label}
              </span>
            ))}
            <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-[11px] font-semibold text-amber-100">
              actual_failure 真实失效标签
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function IndustryCard({
  industry,
  onAnalyze,
  onDownload,
}: {
  industry: HFCDIndustry;
  onAnalyze: () => void;
  onDownload: () => void;
}) {
  const spec = HFCD_INDUSTRIES[industry];
  return (
    <article className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[#52DBA9]/16 bg-[#52DBA9]/10 text-[#8dffdf]">
          <Microscope className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-2xl font-black tracking-tight text-white">{spec.title}</h3>
          <p className="mt-2 text-sm leading-7 text-slate-400">{spec.description}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          onClick={onAnalyze}
          className="rounded-full bg-[#52DBA9] px-4 py-2 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
        >
          开始分析
        </button>
        <button
          onClick={onDownload}
          className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/[0.08]"
        >
          下载模板
        </button>
      </div>
    </article>
  );
}

function compactFailureMode(mode: string) {
  if (mode === 'none') return '无明显主要风险';
  return FAILURE_MODE_LABELS[mode as HFCDFailureMode] || mode.replace(/_/g, ' ');
}

function compactGateLabel(gate: (typeof gateLabels)[number]) {
  return HFCD_GATE_EXPLANATIONS[gate]?.label || gate;
}

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function createDefaultProject(): HFCDProjectRecord {
  return {
    id: createId('project'),
    name: '默认企业项目空间',
    organization: 'LongOne AI Pilot',
    owner: 'Food and Life',
    status: 'pilot',
    createdAt: Date.now(),
    members: [
      { name: 'Food and Life', role: 'owner' },
      { name: '研发团队', role: 'research' },
      { name: '客户观察员', role: 'viewer' },
    ],
  };
}

function createApiKey(name = 'hfcd-production-key'): HFCDApiKeyRecord {
  return {
    id: createId('api'),
    name,
    key: `hfcd_live_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    createdAt: Date.now(),
    callCount: 0,
  };
}

function splitBlindSets(results: HFCDAuditResult[]) {
  const sorted = [...results].sort((a, b) => String(a.sample_id).localeCompare(String(b.sample_id)));
  const trainCount = Math.floor(sorted.length * 0.6);
  const validationCount = Math.floor(sorted.length * 0.2);
  return {
    train: sorted.slice(0, trainCount),
    validation: sorted.slice(trainCount, trainCount + validationCount),
    blind: sorted.slice(trainCount + validationCount),
  };
}

function buildBlindValidationRows(industry: HFCDIndustry) {
  const rowsByIndustry: Record<HFCDIndustry, Array<Record<string, unknown>>> = {
    quantum: [
      { sample_id: 'qpu_stable_001', T1_us: 92, T2_us: 84, T1_ref_us: 90, T2_ref_us: 80, gate1q_error: 0.0004, gate2q_error: 0.004, assignment_fidelity: 0.985, leakage_rate: 0.0008, zz_crosstalk_khz: 28, job_success_rate: 0.98, calibration_age_hours: 4, actual_failure: 0, baseline_score: 0.38, lead_time_days: 0 },
      { sample_id: 'qpu_risk_002', T1_us: 48, T2_us: 38, T1_ref_us: 90, T2_ref_us: 80, gate1q_error: 0.004, gate2q_error: 0.038, readout_error: 0.08, assignment_fidelity: 0.82, leakage_rate: 0.012, zz_crosstalk_khz: 260, job_success_rate: 0.58, calibration_age_hours: 64, actual_failure: 1, baseline_score: 0.44, lead_time_days: 18 },
      { sample_id: 'qpu_warning_003', T1_us: 63, T2_us: 55, T1_ref_us: 90, T2_ref_us: 80, gate1q_error: 0.0018, gate2q_error: 0.022, readout_error: 0.046, assignment_fidelity: 0.89, leakage_rate: 0.006, zz_crosstalk_khz: 150, job_success_rate: 0.76, calibration_age_hours: 42, actual_failure: 1, baseline_score: 0.36, lead_time_days: 11 },
      { sample_id: 'qpu_stable_004', T1_us: 88, T2_us: 79, T1_ref_us: 90, T2_ref_us: 80, gate1q_error: 0.0006, gate2q_error: 0.006, assignment_fidelity: 0.97, leakage_rate: 0.0012, zz_crosstalk_khz: 55, job_success_rate: 0.95, calibration_age_hours: 10, actual_failure: 0, baseline_score: 0.42, lead_time_days: 0 },
      { sample_id: 'qpu_risk_005', T1_us: 44, T2_us: 35, T1_ref_us: 90, T2_ref_us: 80, gate1q_error: 0.005, gate2q_error: 0.046, readout_error: 0.095, assignment_fidelity: 0.79, leakage_rate: 0.016, zz_crosstalk_khz: 310, job_success_rate: 0.52, calibration_age_hours: 70, actual_failure: 1, baseline_score: 0.52, lead_time_days: 23 },
      { sample_id: 'qpu_ok_006', T1_us: 81, T2_us: 73, T1_ref_us: 90, T2_ref_us: 80, gate1q_error: 0.0008, gate2q_error: 0.008, assignment_fidelity: 0.95, leakage_rate: 0.0015, zz_crosstalk_khz: 70, job_success_rate: 0.93, calibration_age_hours: 16, actual_failure: 0, baseline_score: 0.41, lead_time_days: 0 },
    ],
    materials: [
      { sample_id: 'mat_ok_001', phase_purity: 0.97, defect_density_norm: 0.08, crack_length_norm: 0.02, stress_norm: 0.2, microstructure_support: 0.93, property_retention: 0.96, process_margin: 0.82, actual_failure: 0, baseline_score: 0.32, lead_time_days: 0 },
      { sample_id: 'mat_risk_002', phase_purity: 0.72, defect_density_norm: 0.66, crack_length_norm: 0.58, stress_norm: 0.82, microstructure_support: 0.62, property_retention: 0.64, process_margin: 0.28, actual_failure: 1, baseline_score: 0.46, lead_time_days: 16 },
      { sample_id: 'mat_warn_003', phase_purity: 0.86, defect_density_norm: 0.38, crack_length_norm: 0.34, stress_norm: 0.56, microstructure_support: 0.78, property_retention: 0.79, process_margin: 0.46, actual_failure: 1, baseline_score: 0.37, lead_time_days: 9 },
      { sample_id: 'mat_ok_004', phase_purity: 0.95, defect_density_norm: 0.12, crack_length_norm: 0.04, stress_norm: 0.28, microstructure_support: 0.9, property_retention: 0.93, process_margin: 0.76, actual_failure: 0, baseline_score: 0.34, lead_time_days: 0 },
    ],
    energy: [
      { sample_id: 'cell_ok_001', SOH: 0.96, capacity_retention: 0.95, impedance_growth_norm: 0.08, thermal_risk_norm: 0.1, coulombic_efficiency: 0.998, interface_stability: 0.94, degradation_spread_norm: 0.08, reserve_margin: 0.82, actual_failure: 0, baseline_score: 0.3, lead_time_days: 0 },
      { sample_id: 'cell_risk_002', SOH: 0.69, capacity_retention: 0.68, impedance_growth_norm: 0.76, thermal_risk_norm: 0.82, coulombic_efficiency: 0.972, interface_stability: 0.58, degradation_spread_norm: 0.74, reserve_margin: 0.24, actual_failure: 1, baseline_score: 0.43, lead_time_days: 21 },
      { sample_id: 'cell_warn_003', SOH: 0.82, capacity_retention: 0.81, impedance_growth_norm: 0.44, thermal_risk_norm: 0.48, coulombic_efficiency: 0.989, interface_stability: 0.76, degradation_spread_norm: 0.42, reserve_margin: 0.44, actual_failure: 1, baseline_score: 0.36, lead_time_days: 13 },
      { sample_id: 'cell_ok_004', SOH: 0.93, capacity_retention: 0.92, impedance_growth_norm: 0.16, thermal_risk_norm: 0.18, coulombic_efficiency: 0.996, interface_stability: 0.9, degradation_spread_norm: 0.14, reserve_margin: 0.72, actual_failure: 0, baseline_score: 0.35, lead_time_days: 0 },
    ],
    bio: [
      { sample_id: 'bio_ok_001', cell_identity: 0.96, viability: 0.95, productivity_retention: 0.93, metabolic_load_norm: 0.18, heterogeneity_norm: 0.08, culture_support: 0.94, stress_reserve: 0.8, CQA_pass_fraction: 0.95, actual_failure: 0, baseline_score: 0.31, lead_time_days: 0 },
      { sample_id: 'bio_risk_002', cell_identity: 0.71, viability: 0.66, productivity_retention: 0.58, metabolic_load_norm: 0.82, heterogeneity_norm: 0.72, culture_support: 0.56, stress_reserve: 0.24, CQA_pass_fraction: 0.62, actual_failure: 1, baseline_score: 0.45, lead_time_days: 12 },
      { sample_id: 'bio_warn_003', cell_identity: 0.84, viability: 0.8, productivity_retention: 0.78, metabolic_load_norm: 0.52, heterogeneity_norm: 0.44, culture_support: 0.76, stress_reserve: 0.43, CQA_pass_fraction: 0.78, actual_failure: 1, baseline_score: 0.39, lead_time_days: 8 },
      { sample_id: 'bio_ok_004', cell_identity: 0.94, viability: 0.93, productivity_retention: 0.9, metabolic_load_norm: 0.22, heterogeneity_norm: 0.12, culture_support: 0.91, stress_reserve: 0.73, CQA_pass_fraction: 0.93, actual_failure: 0, baseline_score: 0.34, lead_time_days: 0 },
    ],
  };

  return rowsByIndustry[industry];
}

function FailureModeChart({ results }: { results: HFCDAuditResult[] }) {
  const summary = summarizeAudit(results);
  const entries = Object.entries(summary.failureModeCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">暂无风险类型分布。</div>;

  return (
    <div className="space-y-3">
      {entries.map(([mode, count]) => {
        const width = summary.sampleCount ? Math.max(6, (count / summary.sampleCount) * 100) : 0;
        return (
          <div key={mode}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-300">{compactFailureMode(mode)}</span>
              <span className="text-slate-500">{count}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/8">
              <div className="h-full rounded-full bg-[#52DBA9]" style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GateSafetyChart({ results }: { results: HFCDAuditResult[] }) {
  const gates = summarizeGateSafety(results);
  return (
    <div className="grid gap-3">
      {gates.map((gate) => (
        <div key={gate.gate} className="relative overflow-hidden rounded-2xl border border-white/8 bg-black/10 p-4">
          <div className="pr-20">
            <div className="min-w-0">
              <div className="text-sm font-bold leading-6 text-white">{gate.label}</div>
              <div className="mt-1 text-[11px] text-slate-500" title={gate.gate}>指标代码：{gate.gate}</div>
            </div>
          </div>
          <div className="absolute right-4 top-4 rounded-full bg-white/8 px-2.5 py-1 text-sm font-black text-white">
            {Math.round(gate.safeRate * 100)}%
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-red-500/16">
            <div className="h-full rounded-full bg-[#52DBA9]" style={{ width: `${gate.safeRate * 100}%` }} />
          </div>
          <div className="mt-2 text-[11px] text-slate-500">通过 {gate.safeCount} · 未通过 {gate.failCount}</div>
        </div>
      ))}
    </div>
  );
}

function RiskHeatmap({ results }: { results: HFCDAuditResult[] }) {
  const rows = [...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 24);
  if (!rows.length) return <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">暂无风险热图。</div>;

  const statusForGate = {
    Q_error: 'Q_safe',
    energy_drift_per_q: 'E_safe',
    cavity_peak_ratio: 'C_safe',
    peak_ratio: 'P_safe',
    radius_ratio: 'R_safe',
    manifest_fraction: 'M_safe',
    buffer_score: 'B_safe',
  } as const;

  return (
    <div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/10 p-4">
      <div className="min-w-[720px]">
        <div className="grid grid-cols-[170px_repeat(7,minmax(0,1fr))] gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
          <div>样本</div>
          {gateLabels.map((gate) => <div key={gate}>{compactGateLabel(gate)}</div>)}
        </div>
        <div className="mt-3 space-y-2">
          {rows.map((result) => (
            <div key={result.sample_id} className="grid grid-cols-[170px_repeat(7,minmax(0,1fr))] gap-2">
              <div className="truncate text-xs font-semibold text-slate-300">{result.sample_id}</div>
              {gateLabels.map((gate) => {
                const safe = result.gate_status[statusForGate[gate]];
                return (
                  <div
                    key={gate}
                    title={`${compactGateLabel(gate)}: ${result.gates[gate]}`}
                    className={`h-7 rounded-lg border ${safe ? 'border-[#52DBA9]/20 bg-[#52DBA9]/22' : 'border-red-400/20 bg-red-500/24'}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function IndustryRepairAdvice({ industry, results }: { industry: HFCDIndustry; results: HFCDAuditResult[] }) {
  const summary = summarizeAudit(results);
  const primary = summary.primaryFailureMode === 'none' ? 'stable' : summary.primaryFailureMode;
  const adviceByIndustry: Record<HFCDIndustry, string[]> = {
    quantum: [
      '先按 Top Risk 样本复核 T1/T2、2Q error、readout error、leakage 与串扰窗口。',
      '如果主要风险是运行负荷过载，优先做 pulse/drive 小步收敛，不要直接全局重校准。',
      '如果主要风险是风险外扩，先处理 ZZ crosstalk、frequency crowding 和 coupler avoid list。',
    ],
    materials: [
      '先锁定缺陷密度、裂纹长度和应力窗口最高的批次。',
      '如果主要风险是核心状态退化，优先复核相纯度、成分偏析和晶相转变。',
      '如果主要风险是风险外扩，优先压回缺陷扩散和裂纹扩展范围。',
    ],
    energy: [
      '先锁定阻抗增长、热风险和退化扩散最高的电芯/模组。',
      '如果主要风险是运行负荷过载，优先收敛倍率、热管理和局部电化学过载。',
      '如果主要风险是安全余量不足，优先扩大 reserve_margin 而不是追求短期输出。',
    ],
    bio: [
      '先锁定 cell identity、viability、metabolic load 和 heterogeneity 的异常批次。',
      '如果主要风险是支撑条件不足，优先修复培养环境、营养供给和气体交换。',
      '如果主要风险是风险外扩，优先处理细胞状态分叉和亚群漂移。',
    ],
  };

  return (
    <div className="rounded-[24px] border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-5">
      <div className="text-sm font-black text-white">行业化研发建议 · 主要风险 {compactFailureMode(primary)}</div>
      <div className="mt-3 grid gap-2">
        {adviceByIndustry[industry].map((item) => (
          <p key={item} className="text-sm leading-7 text-slate-300">{item}</p>
        ))}
      </div>
    </div>
  );
}

function ReportAnalyticsPanel({ industry, results }: { industry: HFCDIndustry; results: HFCDAuditResult[] }) {
  if (!results.length) return null;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
          <h3 className="text-lg font-black text-white">风险类型分布</h3>
          <div className="mt-4"><FailureModeChart results={results} /></div>
        </div>
        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
          <h3 className="text-lg font-black text-white">稳定性指标通过率</h3>
          <div className="mt-4"><GateSafetyChart results={results} /></div>
        </div>
      </div>
      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
        <h3 className="text-lg font-black text-white">风险热图</h3>
        <p className="mt-1 text-sm text-slate-500">绿色为通过，红色为未通过。按风险分从高到低展示前 24 个样本。</p>
        <div className="mt-4"><RiskHeatmap results={results} /></div>
      </div>
      <IndustryRepairAdvice industry={industry} results={results} />
    </div>
  );
}

function GateLegendPanel() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {(Object.entries(HFCD_GATE_EXPLANATIONS) as Array<[keyof typeof HFCD_GATE_EXPLANATIONS, (typeof HFCD_GATE_EXPLANATIONS)[keyof typeof HFCD_GATE_EXPLANATIONS]]>).map(
        ([key, gate]) => (
          <div key={key} className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-white">{gate.label}</span>
              <span className="rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-slate-500">{key}</span>
            </div>
            <p className="mt-2 text-xs leading-6 text-slate-500">{gate.businessMeaning}</p>
            <div className="mt-2 text-[11px] font-semibold text-slate-400">安全线：{gate.safeRule}</div>
          </div>
        ),
      )}
    </div>
  );
}

function formatThresholdSource(source: HFCDParameterProfile['learnedFrom']) {
  if (source === 'actual_failure_0') return '历史未失效样本';
  if (source === 'baseline_stable') return '当前稳定样本';
  if (source === 'all_samples') return '全量样本分布';
  return '默认参数';
}

function ParameterLearningPanel({
  profile,
  onApply,
}: {
  profile: HFCDParameterProfile | null;
  onApply: () => void;
}) {
  if (!profile) {
    return (
      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-8 text-sm leading-7 text-slate-400">
        上传客户历史数据后，系统会自动学习这一批数据的候选安全线。带 actual_failure=0/1 的数据越多，学习结果越适合进入冻结参数盲测。
      </div>
    );
  }

  const thresholdRows = gateLabels.map((gate) => ({
    gate,
    label: compactGateLabel(gate),
    baseline: profile.baselineThresholds[gate],
    learned: profile.thresholds[gate],
    p25: profile.gateStats[gate].p25,
    median: profile.gateStats[gate].median,
    p75: profile.gateStats[gate].p75,
  }));

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="样本数" value={profile.sampleCount} note="本次用于学习的客户数据。" />
        <MetricCard label="带标签样本" value={profile.labeledCount} note="actual_failure=0/1 的样本。" />
        <MetricCard label="未失效样本" value={profile.stableLabelCount} note="用于拟合安全线的主要参考。" />
        <MetricCard label="学习来源" value={<span className="text-xl">{formatThresholdSource(profile.learnedFrom)}</span>} note="系统选择的参数学习依据。" />
      </div>
      <div className="rounded-[28px] border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-5">
        <h3 className="text-xl font-black text-white">自动学习结论</h3>
        <p className="mt-3 text-sm leading-7 text-slate-300">{profile.recommendedUse}</p>
        {profile.warnings.length ? (
          <div className="mt-4 grid gap-2">
            {profile.warnings.map((warning) => (
              <div key={warning} className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-7 text-amber-100">
                {warning}
              </div>
            ))}
          </div>
        ) : null}
        <button
          onClick={onApply}
          className="mt-5 rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
        >
          用学习参数重跑分析
        </button>
      </div>
      <div className="overflow-x-auto rounded-[28px] border border-white/8 bg-white/[0.03]">
        <table className="min-w-[760px] w-full border-collapse text-left text-sm">
          <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-4 py-3">指标</th>
              <th className="px-4 py-3">默认安全线</th>
              <th className="px-4 py-3">学习后安全线</th>
              <th className="px-4 py-3">P25</th>
              <th className="px-4 py-3">中位数</th>
              <th className="px-4 py-3">P75</th>
            </tr>
          </thead>
          <tbody>
            {thresholdRows.map((row) => (
              <tr key={row.gate} className="border-t border-white/8">
                <td className="px-4 py-3">
                  <div className="font-semibold text-white">{row.label}</div>
                  <div className="mt-1 font-mono text-[11px] text-slate-500">{row.gate}</div>
                </td>
                <td className="px-4 py-3 font-mono text-slate-300">{row.baseline}</td>
                <td className="px-4 py-3 font-mono text-[#9df4d7]">{row.learned}</td>
                <td className="px-4 py-3 font-mono text-slate-400">{row.p25}</td>
                <td className="px-4 py-3 font-mono text-slate-400">{row.median}</td>
                <td className="px-4 py-3 font-mono text-slate-400">{row.p75}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SimulationPanel({ report }: { report: HFCDSimulationReport | null }) {
  if (!report) {
    return (
      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-8 text-sm leading-7 text-slate-400">
        上传数据后，系统会基于当前样本生成多条研发候选方案：核心回中、降负荷、增强支撑、收窄风险、补安全余量和稳定交付。这里是轻量研发方案仿真，不是完整 V12.x 场动力学仿真。
      </div>
    );
  }

  const recommended = report.scenarios.find((item) => item.scenario.id === report.recommendedScenarioId);
  const downloadScenarioSummary = () => {
    downloadText(
      `hfcd_simulation_${report.industry}.csv`,
      toCsv(
        report.scenarios.map((item) => ({
          scenario: item.scenario.name,
          target: item.scenario.target,
          strict_stable: item.summary.strictStableCount,
          high_risk: item.summary.highRiskCount,
          average_risk_score: item.summary.averageRiskScore,
          strict_stable_gain: item.strictStableGain,
          high_risk_reduction: item.highRiskReduction,
          risk_score_delta: item.averageRiskScoreDelta,
          improvement_score: item.improvementScore,
        })),
      ),
      'text/csv;charset=utf-8',
    );
  };

  return (
    <div className="space-y-5">
      <div className="rounded-[30px] border border-[#52DBA9]/16 bg-[radial-gradient(circle_at_top_left,rgba(82,219,169,0.16),transparent_34%),rgba(82,219,169,0.06)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.24em] text-[#91ffe1]">Recommended R&D Path</div>
            <h3 className="mt-3 text-2xl font-black text-white">{recommended?.scenario.name || '暂无推荐方案'}</h3>
            <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-300">{recommended?.scenario.description || '需要先上传数据。'}</p>
          </div>
          <button onClick={downloadScenarioSummary} className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b]">
            下载仿真结果
          </button>
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {report.scenarios.map((item) => {
          const active = item.scenario.id === report.recommendedScenarioId;
          return (
            <article
              key={item.scenario.id}
              className={`rounded-[28px] border p-5 ${
                active ? 'border-[#52DBA9]/30 bg-[#52DBA9]/10' : 'border-white/8 bg-white/[0.03]'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{item.scenario.shortName}</div>
                  <h3 className="mt-2 text-xl font-black text-white">{item.scenario.name}</h3>
                </div>
                {active ? <span className="rounded-full bg-[#52DBA9]/16 px-3 py-1 text-xs font-bold text-[#9df4d7]">推荐</span> : null}
              </div>
              <p className="mt-3 text-sm leading-7 text-slate-400">{item.scenario.target}</p>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                <div className="rounded-2xl bg-black/14 p-3">
                  <div className="text-lg font-black text-white">{item.summary.strictStableCount}</div>
                  <div className="mt-1 text-[10px] text-slate-500">达标</div>
                </div>
                <div className="rounded-2xl bg-black/14 p-3">
                  <div className="text-lg font-black text-red-200">{item.summary.highRiskCount}</div>
                  <div className="mt-1 text-[10px] text-slate-500">高风险</div>
                </div>
                <div className="rounded-2xl bg-black/14 p-3">
                  <div className="text-lg font-black text-[#9df4d7]">{item.highRiskReduction}</div>
                  <div className="mt-1 text-[10px] text-slate-500">风险减少</div>
                </div>
                <div className="rounded-2xl bg-black/14 p-3">
                  <div className="text-lg font-black text-white">{item.improvementScore}</div>
                  <div className="mt-1 text-[10px] text-slate-500">提升分</div>
                </div>
              </div>
              <p className="mt-4 text-xs leading-6 text-slate-500">{item.scenario.description}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function NumberInputCard({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  hint: string;
}) {
  return (
    <label className="rounded-2xl border border-white/8 bg-black/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-bold text-white">{label}</span>
        <span className="font-mono text-xs text-[#9df4d7]">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-3 w-full accent-[#52DBA9]"
      />
      <p className="mt-2 text-xs leading-6 text-slate-500">{hint}</p>
    </label>
  );
}

function FieldSimulationPanel({
  industry,
  report,
  input,
  onInputChange,
  onNeedData,
}: {
  industry: HFCDIndustry;
  report: HFCDFieldSimulationReport | null;
  input: HFCDFieldSimulationInput;
  onInputChange: React.Dispatch<React.SetStateAction<HFCDFieldSimulationInput>>;
  onNeedData: () => void;
}) {
  const normalized = report?.input || normalizeHFCDFieldSimulationInput(input, industry);
  const setField = (section: keyof HFCDFieldSimulationInput, key: string, value: number) => {
    onInputChange((current) => ({
      ...current,
      [section]: {
        ...((current[section] as Record<string, number> | undefined) || {}),
        [key]: value,
      },
    }));
  };
  const recommended = report?.candidates.find((candidate) => candidate.scenarioId === report.recommendedCandidateId);
  const downloadFieldSimulation = () => {
    if (!report) return;
    downloadText(
      `hfcd_field_simulation_${report.industry}.csv`,
      toCsv(
        report.candidates.map((candidate) => ({
          scenario: candidate.name,
          target: candidate.target,
          strict_stable: candidate.summary.strictStableCount,
          high_risk: candidate.summary.highRiskCount,
          average_risk_score: candidate.summary.averageRiskScore,
          stability_index: candidate.stabilityIndex,
          energy_closure: candidate.energyClosure,
          convergence_score: candidate.convergenceScore,
          predicted_gain: candidate.predictedGain,
          confidence: candidate.confidence,
        })),
      ),
      'text/csv;charset=utf-8',
    );
  };

  const groups = [
    {
      title: '物理参数',
      section: 'physical' as const,
      fields: [
        ['qIdentityRigidity', '核心身份刚性', '核心状态是否不容易被扰动击穿。'],
        ['coherenceRetention', '相干保持', '系统在长程演化中保持一致性的能力。'],
        ['fieldCoupling', '场耦合强度', '关键模块之间有效协同的程度。'],
        ['thermalLoad', '热负荷', '热、代谢或能量负担；越高压力越大。'],
        ['entropyPressure', '熵压', '噪声、退化和混乱扩散压力。'],
      ],
    },
    {
      title: '工艺参数',
      section: 'process' as const,
      fields: [
        ['controlGain', '控制增益', '客户能主动调控系统的能力。'],
        ['processDrift', '工艺漂移', '制程、校准或批次漂移压力；越高越不稳。'],
        ['repairIntensity', '修复强度', '研发修复动作的可执行强度。'],
        ['measurementNoise', '测量噪声', '测量链路或数据采集噪声；越高越不稳。'],
        ['materialSupport', '环境/材料支撑', '结构、环境或材料对输出的承载能力。'],
      ],
    },
    {
      title: '边界条件',
      section: 'boundary' as const,
      fields: [
        ['boundaryTightness', '边界收紧度', '限制串扰、裂纹、退化、异质性外扩的能力。'],
        ['externalShock', '外部冲击', '环境扰动、负载波动或应力冲击；越高越不稳。'],
        ['safetyReserve', '安全余量', '系统被扰动后仍能回稳的余量。'],
      ],
    },
    {
      title: '数字孪生输入',
      section: 'digitalTwin' as const,
      fields: [
        ['coverage', '覆盖度', '数字孪生覆盖真实系统变量的比例。'],
        ['fidelity', '保真度', '数字孪生与真实系统的一致性。'],
        ['parameterCompleteness', '参数完整度', '物理、工艺、边界参数是否完整。'],
        ['historicalDepth', '历史深度', '历史实验/生产数据的长度和可复用性。'],
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-[30px] border border-white/8 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-black text-white">完整场仿真输入</h3>
            <p className="mt-2 max-w-4xl text-sm leading-8 text-slate-400">
              这里输入客户的物理参数、工艺参数、边界条件和数字孪生质量。系统会做多步场演化，比较候选研发路线的收敛度、稳定指数、能量闭合和风险下降。
            </p>
          </div>
          <button
            onClick={report ? downloadFieldSimulation : onNeedData}
            className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
          >
            {report ? '下载场仿真结果' : '先上传数据'}
          </button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {groups.map((group) => (
          <div key={group.title} className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
            <h4 className="text-lg font-black text-white">{group.title}</h4>
            <div className="mt-4 grid gap-3">
              {group.fields.map(([key, label, hint]) => {
                const value = Number((normalized[group.section] as Record<string, number>)[key]);
                return (
                  <NumberInputCard
                    key={key}
                    label={label}
                    value={value}
                    onChange={(next) => setField(group.section, key, next)}
                    hint={hint}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5 xl:col-span-2">
          <h4 className="text-lg font-black text-white">仿真网格与扫描深度</h4>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <NumberInputCard
              label="仿真步长"
              value={normalized.boundary.timeHorizon}
              min={24}
              max={720}
              step={12}
              onChange={(next) => setField('boundary', 'timeHorizon', next)}
              hint="场演化运行多少步。越高越接近长程仿真，但计算更重。"
            />
            <NumberInputCard
              label="网格分辨率"
              value={normalized.boundary.gridResolution}
              min={16}
              max={128}
              step={4}
              onChange={(next) => setField('boundary', 'gridResolution', next)}
              hint="用于模拟边界、扩散和耦合的分辨率。"
            />
            <NumberInputCard
              label="候选方案数"
              value={normalized.scan.candidateCount}
              min={2}
              max={6}
              step={1}
              onChange={(next) => setField('scan', 'candidateCount', next)}
              hint="扫描多少条研发修复路线。"
            />
            <NumberInputCard
              label="扫描深度"
              value={normalized.scan.scanDepth}
              onChange={(next) => setField('scan', 'scanDepth', next)}
              hint="参数扫描的探索强度。"
            />
            <NumberInputCard
              label="单步调节幅度"
              value={normalized.scan.stepSize}
              min={0.02}
              max={0.24}
              step={0.01}
              onChange={(next) => setField('scan', 'stepSize', next)}
              hint="每一步参数演化的调节幅度。"
            />
          </div>
        </div>
      </div>

      {report && recommended ? (
        <div className="space-y-5">
          <div className="rounded-[30px] border border-[#52DBA9]/18 bg-[#52DBA9]/8 p-6">
            <div className="text-xs font-bold uppercase tracking-[0.24em] text-[#91ffe1]">Field Simulation Recommendation</div>
            <h3 className="mt-3 text-2xl font-black text-white">{recommended.name}</h3>
            <p className="mt-3 max-w-4xl text-sm leading-8 text-slate-300">{recommended.target}</p>
            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <MetricCard label="稳定指数" value={recommended.stabilityIndex} note="综合达标、核心达标和平均风险后的场稳定度。" />
              <MetricCard label="能量闭合" value={recommended.energyClosure} note="负荷是否被当前系统吸收并闭合。" />
              <MetricCard label="收敛得分" value={recommended.convergenceScore} note="稳定指数、能量闭合和低风险合成得分。" />
              <MetricCard label="可信度" value={recommended.confidence} note="由数字孪生质量、标签数和样本量决定。" />
            </div>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {report.candidates.map((candidate) => (
              <article
                key={candidate.scenarioId}
                className={`rounded-[28px] border p-5 ${
                  candidate.scenarioId === report.recommendedCandidateId
                    ? 'border-[#52DBA9]/30 bg-[#52DBA9]/10'
                    : 'border-white/8 bg-white/[0.03]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-xl font-black text-white">{candidate.name}</h4>
                  <span className="rounded-full bg-white/8 px-3 py-1 text-xs font-bold text-slate-300">gain {candidate.predictedGain}</span>
                </div>
                <p className="mt-2 text-sm leading-7 text-slate-400">{candidate.target}</p>
                <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                  <div className="rounded-2xl bg-black/14 p-3"><div className="font-black text-white">{candidate.summary.strictStableCount}</div><div className="mt-1 text-[10px] text-slate-500">达标</div></div>
                  <div className="rounded-2xl bg-black/14 p-3"><div className="font-black text-red-200">{candidate.summary.highRiskCount}</div><div className="mt-1 text-[10px] text-slate-500">高风险</div></div>
                  <div className="rounded-2xl bg-black/14 p-3"><div className="font-black text-[#9df4d7]">{candidate.energyClosure}</div><div className="mt-1 text-[10px] text-slate-500">闭合</div></div>
                  <div className="rounded-2xl bg-black/14 p-3"><div className="font-black text-white">{candidate.convergenceScore}</div><div className="mt-1 text-[10px] text-slate-500">收敛</div></div>
                </div>
              </article>
            ))}
          </div>
          <div className="overflow-x-auto rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
            <h4 className="text-lg font-black text-white">推荐方案轨迹</h4>
            <table className="mt-4 min-w-[760px] w-full border-collapse text-left text-sm">
              <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">step</th>
                  <th className="px-4 py-3">全部达标</th>
                  <th className="px-4 py-3">核心达标</th>
                  <th className="px-4 py-3">高风险</th>
                  <th className="px-4 py-3">平均风险</th>
                  <th className="px-4 py-3">稳定指数</th>
                  <th className="px-4 py-3">能量闭合</th>
                </tr>
              </thead>
              <tbody>
                {recommended.trajectory.map((point) => (
                  <tr key={point.step} className="border-t border-white/8 text-slate-300">
                    <td className="px-4 py-3 font-mono text-xs">{point.step}</td>
                    <td className="px-4 py-3">{point.strictStableCount}</td>
                    <td className="px-4 py-3">{point.looseStableCount}</td>
                    <td className="px-4 py-3">{point.highRiskCount}</td>
                    <td className="px-4 py-3 font-mono text-xs">{point.averageRiskScore}</td>
                    <td className="px-4 py-3 font-mono text-xs">{point.stabilityIndex}</td>
                    <td className="px-4 py-3 font-mono text-xs">{point.energyClosure}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-[28px] border border-amber-300/16 bg-amber-300/8 p-5 text-sm leading-7 text-amber-100">
          还没有可运行的场仿真数据。先上传 CSV 或加载示例数据，系统会自动生成完整场仿真报告。
        </div>
      )}
    </div>
  );
}

function FieldHealthPanel({ fieldHealth }: { fieldHealth: ReturnType<typeof validateRows>['fieldHealth'] }) {
  return (
    <div className="mt-5 space-y-2">
      <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">字段体检报告</div>
      <div className="max-h-[360px] overflow-y-auto pr-1">
        <div className="grid gap-2">
          {fieldHealth.map((field) => (
            <div
              key={field.key}
              className={`rounded-2xl border px-4 py-3 ${
                field.present
                  ? 'border-[#52DBA9]/14 bg-[#52DBA9]/7'
                  : field.required
                    ? 'border-red-400/18 bg-red-500/10'
                    : 'border-white/8 bg-black/10'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-[#9df4d7]">{field.key}</span>
                <span className="text-sm font-bold text-white">{field.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${field.present ? 'bg-[#52DBA9]/16 text-[#9df4d7]' : 'bg-white/8 text-slate-400'}`}>
                  {field.present ? '已检测' : field.required ? '缺失必填' : '建议补充'}
                </span>
              </div>
              <p className="mt-2 text-xs leading-6 text-slate-400">{field.effect}</p>
              <p className="mt-1 text-xs leading-6 text-slate-500">{field.guidance}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultDiagnosisPanel({ results }: { results: HFCDAuditResult[] }) {
  if (!results.length) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-black/10 p-6 text-sm text-slate-500">
        运行分析后，这里会按“业务解释 / 关键指标 / 修复方案”三层展示每个样本。
      </div>
    );
  }

  const sorted = [...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 12);
  return (
    <div className="space-y-3">
      {sorted.map((result) => (
        <article key={result.sample_id} className="rounded-[26px] border border-white/8 bg-black/10 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono text-xs text-[#9df4d7]">{result.sample_id}</div>
              <div className="mt-1 text-lg font-black text-white">{result.failure_mode}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold ${
                  result.readable.severity === '稳定'
                    ? 'bg-[#52DBA9]/14 text-[#9df4d7]'
                    : result.readable.severity === '临界'
                      ? 'bg-amber-500/12 text-amber-200'
                      : 'bg-red-500/14 text-red-200'
                }`}
              >
                {result.readable.severity}
              </span>
              <span className="rounded-full bg-white/8 px-3 py-1 text-xs font-bold text-slate-300">风险分 {result.risk_score}</span>
            </div>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">业务解释</div>
              <p className="mt-3 text-sm leading-7 text-slate-300">{result.readable.businessSummary}</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">关键指标</div>
              <p className="mt-3 text-sm leading-7 text-slate-300">{result.readable.hfcdSummary}</p>
              <p className="mt-2 text-xs leading-6 text-slate-500">主驱动：{result.readable.primaryDrivers.join(' / ')}</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">修复方案</div>
              <p className="mt-3 text-sm leading-7 text-slate-300">{result.readable.repairSummary}</p>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function researchStatusLabel(status: HFCDResearchJobStatus) {
  const labels: Record<HFCDResearchJobStatus, string> = {
    planned: '已规划',
    queued: '已提交',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    not_configured: '未配置',
    unknown: '未知',
  };
  return labels[status] || status;
}

function researchStatusClass(status: HFCDResearchJobStatus) {
  if (status === 'succeeded') return 'border-[#52DBA9]/25 bg-[#52DBA9]/12 text-[#9df4d7]';
  if (status === 'failed' || status === 'not_configured') return 'border-red-400/25 bg-red-500/12 text-red-200';
  if (status === 'running' || status === 'queued') return 'border-amber-300/25 bg-amber-300/12 text-amber-100';
  return 'border-white/10 bg-white/[0.05] text-slate-300';
}

export function HFCDWorkbench() {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('dashboard');
  const [industry, setIndustry] = useState<HFCDIndustry>('quantum');
  const [projectName, setProjectName] = useState('HFCD 稳定窗审计项目');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [results, setResults] = useState<HFCDAuditResult[]>([]);
  const [reports, setReports] = useState<HFCDReportRecord[]>([]);
  const [projects, setProjects] = useState<HFCDProjectRecord[]>([]);
  const [datasets, setDatasets] = useState<HFCDDatasetRecord[]>([]);
  const [apiKeys, setApiKeys] = useState<HFCDApiKeyRecord[]>([]);
  const [researchJobs, setResearchJobs] = useState<HFCDResearchJobRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [apiTestResult, setApiTestResult] = useState<string | null>(null);
  const [apiResponsePreview, setApiResponsePreview] = useState<string | null>(null);
  const [fieldInput, setFieldInput] = useState<HFCDFieldSimulationInput>(() => defaultHFCDFieldSimulationInput('quantum'));
  const [researchRequest, setResearchRequest] = useState<HFCDResearchJobRequest>({
    preset: 'v12_38_me28800',
    projectName: 'V12.38 研究级长程仿真',
    sourceMode: 'best101',
    maxVariants: 1,
    topCheckpoints: 1,
    logInterval: 60,
    resume: true,
    smoke: true,
  });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(REPORT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as HFCDReportRecord[];
        setReports(Array.isArray(parsed) ? parsed : []);
      }
      const rawProjects = localStorage.getItem(PROJECT_STORAGE_KEY);
      const parsedProjects = rawProjects ? (JSON.parse(rawProjects) as HFCDProjectRecord[]) : [];
      const safeProjects = Array.isArray(parsedProjects) && parsedProjects.length ? parsedProjects : [createDefaultProject()];
      setProjects(safeProjects);
      setActiveProjectId(safeProjects[0]?.id || '');

      const rawDatasets = localStorage.getItem(DATASET_STORAGE_KEY);
      const parsedDatasets = rawDatasets ? (JSON.parse(rawDatasets) as HFCDDatasetRecord[]) : [];
      setDatasets(Array.isArray(parsedDatasets) ? parsedDatasets : []);

      const rawApiKeys = localStorage.getItem(API_KEYS_STORAGE_KEY);
      const parsedApiKeys = rawApiKeys ? (JSON.parse(rawApiKeys) as HFCDApiKeyRecord[]) : [];
      setApiKeys(Array.isArray(parsedApiKeys) ? parsedApiKeys : []);

      const rawResearchJobs = localStorage.getItem(RESEARCH_JOBS_STORAGE_KEY);
      const parsedResearchJobs = rawResearchJobs ? (JSON.parse(rawResearchJobs) as HFCDResearchJobRecord[]) : [];
      setResearchJobs(Array.isArray(parsedResearchJobs) ? parsedResearchJobs : []);
    } catch {
      setReports([]);
      const fallbackProject = createDefaultProject();
      setProjects([fallbackProject]);
      setActiveProjectId(fallbackProject.id);
      setDatasets([]);
      setApiKeys([]);
      setResearchJobs([]);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(reports.slice(0, 40)));
    } catch {
      // Report history is an enhancement; audit execution should never fail because storage is full.
    }
  }, [reports]);

  useEffect(() => {
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projects.slice(0, 80)));
    } catch {
      // Local project space should not block audit execution.
    }
  }, [projects]);

  useEffect(() => {
    try {
      localStorage.setItem(DATASET_STORAGE_KEY, JSON.stringify(datasets.slice(0, 200)));
    } catch {
      // Local dataset index should not block audit execution.
    }
  }, [datasets]);

  useEffect(() => {
    try {
      localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(apiKeys.slice(0, 20)));
    } catch {
      // API key ledger is local-first demo metadata.
    }
  }, [apiKeys]);

  useEffect(() => {
    try {
      localStorage.setItem(RESEARCH_JOBS_STORAGE_KEY, JSON.stringify(researchJobs.slice(0, 40)));
    } catch {
      // Research job ledger should not block the workbench.
    }
  }, [researchJobs]);

  useEffect(() => {
    setFieldInput(defaultHFCDFieldSimulationInput(industry));
  }, [industry]);

  const validation = useMemo(() => validateRows(rows, industry), [industry, rows]);
  const summary = useMemo(() => summarizeAudit(results), [results]);
  const blindMetrics = useMemo(() => validateBlindMetrics(results), [results]);
  const blindSplits = useMemo(() => splitBlindSets(results), [results]);
  const flatResults = useMemo(() => results.map(flattenAuditResult), [results]);
  const markdownReport = useMemo(
    () => generateMarkdownReport({ projectName, industry, results }),
    [projectName, industry, results],
  );
  const parameterProfile = useMemo(
    () => (rows.length ? learnHFCDParameters(rows, industry) : null),
    [industry, rows],
  );
  const simulationReport = useMemo(
    () => (rows.length && parameterProfile ? simulateHFCDScenarios(rows, industry, parameterProfile) : null),
    [industry, parameterProfile, rows],
  );
  const fieldSimulationReport = useMemo(
    () =>
      rows.length && parameterProfile
        ? runHFCDFieldSimulation({ rows, industry, profile: parameterProfile, input: fieldInput })
        : null,
    [fieldInput, industry, parameterProfile, rows],
  );

  const dashboardStats = useMemo(() => {
    const allResults = reports.flatMap((report) => report.results);
    const allSummary = summarizeAudit(allResults);
    return {
      reportCount: reports.length,
      projectCount: projects.length,
      ...allSummary,
    };
  }, [projects.length, reports]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) || projects[0],
    [activeProjectId, projects],
  );
  const activeProjectReports = useMemo(
    () => reports.filter((report) => !activeProject?.id || report.projectId === activeProject.id),
    [activeProject?.id, reports],
  );
  const activeProjectDatasets = useMemo(
    () => datasets.filter((dataset) => !activeProject?.id || dataset.projectId === activeProject.id),
    [activeProject?.id, datasets],
  );

  const handleDownloadTemplate = (targetIndustry = industry) => {
    const spec = HFCD_INDUSTRIES[targetIndustry];
    downloadText(spec.templateFileName, templateToCsv(targetIndustry), 'text/csv;charset=utf-8');
  };

  const handleUploadFile = async (file: File | null) => {
    setUploadError(null);
    setResults([]);
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      setRows(parsed);
      setFileName(file.name);
      if (!projectName || projectName === 'HFCD 稳定窗审计项目') {
        setProjectName(file.name.replace(/\.[^.]+$/, '') || 'HFCD 稳定窗审计项目');
      }
      if (parsed.length === 0) setUploadError('CSV 没有检测到有效数据行。');
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'CSV 读取失败。');
    }
  };

  const handleRunAudit = () => {
    if (!rows.length) {
      setUploadError('请先上传 CSV 文件，再运行分析。');
      return;
    }
    if (!validation.isValid) {
      setUploadError(validation.missingRequired.length ? `缺少必填字段：${validation.missingRequired.join(', ')}` : '请先上传 CSV 文件，再运行分析。');
      return;
    }
    const nextResults = auditRecords(rows, industry);
    setResults(nextResults);
    let projectId = activeProject?.id;
    if (!projectId) {
      const project = createDefaultProject();
      projectId = project.id;
      setProjects((current) => [project, ...current]);
      setActiveProjectId(project.id);
    }
    const datasetId = createId('dataset');
    const reportId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const report: HFCDReportRecord = {
      id: reportId,
      projectId,
      datasetId,
      projectName,
      industry,
      fileName,
      createdAt: Date.now(),
      results: nextResults,
    };
    const dataset: HFCDDatasetRecord = {
      id: datasetId,
      projectId,
      reportId,
      fileName: fileName || `${projectName}.csv`,
      industry,
      rowCount: rows.length,
      createdAt: Date.now(),
    };
    setDatasets((current) => [dataset, ...current].slice(0, 200));
    setReports((current) => [report, ...current].slice(0, 40));
    setActiveTab(validateBlindMetrics(nextResults).hasActualFailure ? 'blind' : 'reports');
  };

  const handleRunLearnedAudit = () => {
    if (!rows.length || !parameterProfile) {
      setUploadError('请先上传 CSV 文件，再运行参数学习。');
      setActiveTab('upload');
      return;
    }
    const nextResults = auditRecords(rows, industry, { thresholds: parameterProfile.thresholds });
    setResults(nextResults);
    setActiveTab('calibration');
  };

  const handleLoadSample = (targetIndustry = industry) => {
    const csv = templateToCsv(targetIndustry);
    setIndustry(targetIndustry);
    setRows(parseCsv(csv));
    setFileName(HFCD_INDUSTRIES[targetIndustry].templateFileName);
    setProjectName(`${HFCD_INDUSTRIES[targetIndustry].title} 示例审计`);
    setResults([]);
    setUploadError(null);
    setActiveTab('upload');
  };

  const handleLoadBlindValidationSample = (targetIndustry = industry) => {
    const nextRows = buildBlindValidationRows(targetIndustry);
    const nextResults = auditRecords(nextRows, targetIndustry);
    setIndustry(targetIndustry);
    setRows(nextRows as Array<Record<string, string>>);
    setResults(nextResults);
    setFileName(`hfcd_${targetIndustry}_blind_validation_example.csv`);
    setProjectName(`${HFCD_INDUSTRIES[targetIndustry].title} 盲测验证示例`);
    setUploadError(null);
    setActiveTab('blind');
  };

  const downloadCurrentCsv = () => {
    if (!flatResults.length) return;
    downloadText(`${projectName || 'hfcd_audit'}_results.csv`, toCsv(flatResults), 'text/csv;charset=utf-8');
  };

  const downloadCurrentMarkdown = () => {
    if (!results.length) return;
    downloadText(`${projectName || 'hfcd_audit'}_report.md`, markdownReport, 'text/markdown;charset=utf-8');
  };

  const downloadCurrentHtml = () => {
    if (!results.length) return;
    const html = buildClientHtmlReport({ projectName, industry, results });
    downloadText(`${projectName || 'hfcd_audit'}_report.html`, html, 'text/html;charset=utf-8');
  };

  const openPrintablePdf = (reportProjectName = projectName, reportIndustry = industry, reportResults = results) => {
    if (!reportResults.length) return;
    const html = buildClientHtmlReport({ projectName: reportProjectName, industry: reportIndustry, results: reportResults });
    const win = window.open('', '_blank', 'noopener,noreferrer');
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    window.setTimeout(() => win.print(), 300);
  };

  const handleCreateProject = () => {
    const nextProject: HFCDProjectRecord = {
      id: createId('project'),
      name: projectName || `HFCD 项目 ${projects.length + 1}`,
      organization: '客户企业空间',
      owner: 'Food and Life',
      status: 'active',
      createdAt: Date.now(),
      members: [
        { name: 'Food and Life', role: 'owner' },
        { name: '研发负责人', role: 'research' },
        { name: '客户观察员', role: 'viewer' },
      ],
    };
    setProjects((current) => [nextProject, ...current]);
    setActiveProjectId(nextProject.id);
    setActiveTab('projects');
  };

  const handleGenerateApiKey = () => {
    setApiKeys((current) => [createApiKey(`HFCD API Key ${current.length + 1}`), ...current].slice(0, 20));
  };

  const apiExample = `curl -X POST https://longone.ai/api/hfcd/audit \\
  -H "content-type: application/json" \\
  -H "x-api-key: ${apiKeys[0]?.key || 'hfcd_live_xxx'}" \\
  -d '{"model":"hfcd-field-v1","mode":"field","industry":"quantum","rows":[{"sample_id":"qpu_cal_001","T1_us":82,"T2_us":71,"gate2q_error":0.009,"assignment_fidelity":0.94,"job_success_rate":0.94,"actual_failure":0}],"fieldSimulation":{"physical":{"qIdentityRigidity":0.74,"coherenceRetention":0.72,"fieldCoupling":0.62,"thermalLoad":0.34,"entropyPressure":0.28},"process":{"controlGain":0.68,"processDrift":0.22,"repairIntensity":0.58,"measurementNoise":0.08,"materialSupport":0.66},"boundary":{"boundaryTightness":0.64,"externalShock":0.18,"safetyReserve":0.72,"timeHorizon":120,"gridResolution":48},"digitalTwin":{"coverage":0.7,"fidelity":0.68,"parameterCompleteness":0.76,"historicalDepth":0.62},"scan":{"candidateCount":6,"scanDepth":0.72,"stepSize":0.08}}}'`;

  const handleTestApiCall = async () => {
    setApiTestResult('调用中...');
    setApiResponsePreview(null);
    const rowsForApi = rows.length ? rows : parseCsv(templateToCsv(industry));
    try {
      const response = await fetch('/api/hfcd/audit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKeys[0]?.key ? { 'x-api-key': apiKeys[0].key } : {}),
        },
        body: JSON.stringify({ model: 'hfcd-field-v1', mode: 'field', industry, rows: rowsForApi, fieldSimulation: fieldInput }),
      });
      const payload = await response.json();
      setApiResponsePreview(JSON.stringify(payload, null, 2));
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('API 鉴权失败：生产环境已启用 HFCD_API_KEYS，请使用 Worker 后台配置过的密钥。');
        }
        throw new Error(payload?.error || 'API call failed.');
      }
      const fieldNote = payload.fieldSimulation?.recommendedCandidateId
        ? `完整场仿真推荐 ${payload.fieldSimulation.recommendedCandidateId}。`
        : '';
      setApiTestResult(`调用成功：${payload.summary.sampleCount} 个样本，${payload.summary.highRiskCount} 个高风险，主要风险 ${compactFailureMode(payload.summary.primaryFailureMode)}。${fieldNote}`);
      if (apiKeys[0]) {
        setApiKeys((current) =>
          current.map((item, index) =>
            index === 0 ? { ...item, callCount: item.callCount + 1, lastUsedAt: Date.now() } : item,
          ),
        );
      }
    } catch (error) {
      setApiTestResult(error instanceof Error ? error.message : 'API 调用失败。');
    }
  };

  const submitResearchJob = async (request: HFCDResearchJobRequest) => {
    const createdAt = Date.now();
    const fallbackId = createId('research');
    const projectTitle = request.projectName || 'HFCD 云端长程仿真';
    setResearchJobs((current) => [
      {
        id: fallbackId,
        projectName: projectTitle,
        preset: request.preset || 'v12_38_me28800',
        status: 'queued',
        createdAt,
        message: '正在提交到 Cloud Run...',
      },
      ...current,
    ]);

    try {
      const response = await fetch('/api/hfcd/research-jobs/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKeys[0]?.key ? { 'x-api-key': apiKeys[0].key } : {}),
        },
        body: JSON.stringify(request),
      });
      const payload = await response.json();
      const jobId = payload?.plan?.jobId || fallbackId;
      const status = (payload?.status || (response.ok ? 'queued' : 'failed')) as HFCDResearchJobStatus;
      setResearchJobs((current) =>
        current.map((job) =>
          job.id === fallbackId
            ? {
                ...job,
                id: jobId,
                projectName: payload?.plan?.projectName || projectTitle,
                preset: payload?.plan?.preset || job.preset,
                status,
                operationName: payload?.operationName,
                artifactPrefix: payload?.plan?.artifactPrefix,
                message: payload?.message || payload?.error || (response.ok ? '已提交 Cloud Run。' : '提交失败。'),
                plan: payload?.plan,
              }
            : job,
        ),
      );
    } catch (error) {
      setResearchJobs((current) =>
        current.map((job) =>
          job.id === fallbackId
            ? {
                ...job,
                status: 'failed',
                message: error instanceof Error ? error.message : '提交云端长程仿真失败。',
              }
            : job,
        ),
      );
    }
  };

  const handleSubmitResearchJob = async () => {
    await submitResearchJob(researchRequest);
  };

  const handleRefreshResearchJob = async (job: HFCDResearchJobRecord) => {
    if (!job.operationName && !job.artifactPrefix) {
      setResearchJobs((current) =>
        current.map((item) =>
          item.id === job.id ? { ...item, message: '缺少 operationName 或 artifactPrefix，无法查询。' } : item,
        ),
      );
      return;
    }

    const params = new URLSearchParams();
    if (job.operationName) params.set('operationName', job.operationName);
    if (job.artifactPrefix) params.set('artifactPrefix', job.artifactPrefix);
    try {
      const response = await fetch(`/api/hfcd/research-jobs/status?${params.toString()}`, {
        headers: apiKeys[0]?.key ? { 'x-api-key': apiKeys[0].key } : undefined,
      });
      const payload = await response.json();
      setResearchJobs((current) =>
        current.map((item) =>
          item.id === job.id
            ? {
                ...item,
                status: (payload?.status || (response.ok ? item.status : 'unknown')) as HFCDResearchJobStatus,
                operationName: payload?.operationName || item.operationName,
                artifactPrefix: payload?.artifactPrefix || item.artifactPrefix,
                manifest: payload?.manifest,
                message: payload?.message || payload?.error || (payload?.manifest ? '已读取 GCS 结果清单。' : '已刷新 Cloud Run 状态。'),
              }
            : item,
        ),
      );
    } catch (error) {
      setResearchJobs((current) =>
        current.map((item) =>
          item.id === job.id
            ? { ...item, status: 'unknown', message: error instanceof Error ? error.message : '查询云端长程仿真状态失败。' }
            : item,
        ),
      );
    }
  };

  const renderResultsTable = (tableResults: HFCDAuditResult[]) => {
    if (!tableResults.length) {
      return <div className="rounded-[24px] border border-white/8 bg-black/10 p-6 text-sm text-slate-500">还没有分析结果。上传 CSV 后点击“运行 HFCD 分析”。</div>;
    }
    return (
      <div className="overflow-x-auto rounded-[24px] border border-white/8">
        <table className="min-w-[1180px] w-full border-collapse text-left text-sm">
          <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-4 py-3">样本</th>
              {gateLabels.map((gate) => (
                <th key={gate} className="px-4 py-3">{compactGateLabel(gate)}</th>
              ))}
              <th className="px-4 py-3">全部达标</th>
              <th className="px-4 py-3">核心达标</th>
              <th className="px-4 py-3">风险类型</th>
              <th className="px-4 py-3">风险分</th>
            </tr>
          </thead>
          <tbody>
            {tableResults.slice(0, 80).map((result) => (
              <tr key={result.sample_id} className="border-t border-white/8 text-slate-300">
                <td className="px-4 py-3 font-semibold text-white">{result.sample_id}</td>
                {gateLabels.map((gate) => (
                  <td key={gate} className="px-4 py-3 font-mono text-xs">{result.gates[gate]}</td>
                ))}
                <td className="px-4 py-3">{result.strict_stable ? '是' : '否'}</td>
                <td className="px-4 py-3">{result.loose_stable ? '是' : '否'}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${result.failure_mode === 'stable' ? 'bg-[#52DBA9]/14 text-[#9df4d7]' : 'bg-amber-500/12 text-amber-200'}`}>
                    {compactFailureMode(result.failure_mode)}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{result.risk_score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0f1117] text-slate-100">
      <div className="mx-auto w-full max-w-7xl px-4 pb-20 pt-6 md:px-8">
        <section className="overflow-hidden rounded-[34px] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(82,219,169,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(99,125,255,0.18),transparent_24%),linear-gradient(180deg,#171a24_0%,#10131b_100%)] p-6 shadow-[0_30px_120px_rgba(0,0,0,0.35)] md:p-8">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_360px] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-[#7ef8d2]/20 bg-[#52DBA9]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-[#91ffe1]">
                <Activity className="h-3.5 w-3.5" />
                HFCD R&D Risk Validation
              </div>
              <h1 className="mt-5 text-4xl font-black tracking-tight text-white md:text-5xl">HFCD 研发风险验证与云端真实仿真</h1>
              <p className="mt-4 max-w-4xl text-base leading-8 text-slate-300 md:text-lg">
                上传历史实验、生产或质检数据，先验证系统能不能提前发现高风险样本、主要失效原因和修复方向；需要深度验证时，再把 HFCD V12.x 长程脚本提交到云端真实运行，产出报告、图表、CSV、summary、checkpoint 和日志。
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  onClick={() => setActiveTab('blind')}
                  className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
                >
                  做一次盲测验证
                </button>
                <button
                  onClick={() => setActiveTab('research')}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-bold text-slate-100 transition-colors hover:bg-white/[0.08]"
                >
                  云端真实跑模型
                </button>
              </div>
            </div>
            <div className="rounded-[28px] border border-white/8 bg-black/15 p-5">
              <div className="text-xs font-bold uppercase tracking-[0.24em] text-slate-500">产品价值</div>
              <div className="mt-4 space-y-4">
                {[
                  ['先证明有效', '用客户历史失效标签做盲测，直接看命中率、提升幅度和提前预警。'],
                  ['再真实运行', 'Cloud Run 执行原始 HFCD Python 长程脚本，不只是在网页里做演示。'],
                  ['最后拿结果', '输出可下载报告、风险样本、研发修复建议、图表、CSV 与 checkpoint。'],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
                    <div className="font-bold text-white">{title}</div>
                    <p className="mt-1 text-sm leading-6 text-slate-400">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="mt-8 flex flex-wrap gap-3">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                  active
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

        {activeTab === 'dashboard' ? (
          <section className="mt-8">
            <SectionTitle
              title="一页讲清楚：它有什么价值、怎么用、结果在哪里"
              description="HFCD 当前产品只保留两条主线：盲测验证用于证明能不能发现风险；云端真实跑模型用于把原始长程实验搬到云端执行。其它能力都收进结果中心和高级入口，不再打断用户。"
            />
            <div className="grid gap-5 lg:grid-cols-2">
              <WorkflowCard
                badge="Core Flow 01"
                title="盲测验证：证明它有没有用"
                description="上传带真实失效标签的历史数据，系统先不看答案调参，而是直接排序高风险样本，验证它能不能比客户现有方法更早发现问题。"
                points={[
                  '输入：历史实验/生产/质检数据 + actual_failure 真实失效标签。',
                  '输出：高风险样本、主要失效原因、Top10 命中率、AUC、提前预警天数。',
                  '用途：快速证明 HFCD 是否值得进入客户试点。',
                ]}
                action="进入盲测验证"
                onClick={() => setActiveTab('blind')}
              />
              <WorkflowCard
                badge="Core Flow 02"
                title="云端真实跑模型：跑原始长程脚本"
                description="当客户需要更深验证时，把 HFCD V12.x Python 长程实验提交到 Cloud Run，真实消耗 CPU、写 checkpoint、产出完整证据链。"
                points={[
                  '输入：实验版本、checkpoint、运行规模和云端任务参数。',
                  '输出：Markdown 报告、PNG 图表、CSV、summary、checkpoint、运行日志。',
                  '用途：从快速验证升级到研究级复核和联合研发。',
                ]}
                action="提交云端真实任务"
                onClick={() => setActiveTab('research')}
              />
            </div>

            <div className="mt-6">
              <ExperimentEvidencePanel />
            </div>

            <div className="mt-6 rounded-[30px] border border-white/8 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-black text-white">快速上手：先选行业，再加载示例或上传 CSV</h3>
                  <p className="mt-2 max-w-4xl text-sm leading-7 text-slate-400">
                    用户不需要理解内部变量。页面会把芯片、材料、能源、生命科学数据自动转成稳定性检查项，并给出业务语言解释。
                  </p>
                </div>
                <button
                  onClick={() => setActiveTab('upload')}
                  className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b]"
                >
                  开始上传数据
                </button>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {(Object.keys(HFCD_INDUSTRIES) as HFCDIndustry[]).map((item) => (
                  <button
                    key={item}
                    onClick={() => {
                      setIndustry(item);
                      setActiveTab('upload');
                    }}
                    className="rounded-[24px] border border-white/8 bg-black/10 p-4 text-left transition-colors hover:border-[#52DBA9]/28 hover:bg-[#52DBA9]/8"
                  >
                    <div className="text-lg font-black text-white">{HFCD_INDUSTRIES[item].title}</div>
                    <p className="mt-2 text-xs leading-6 text-slate-500">{HFCD_INDUSTRIES[item].description}</p>
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'upload' ? (
          <section className="mt-8">
            <SectionTitle title="上传数据：不用懂内部术语，也能快速跑起来" description="选择行业后，页面会告诉你该上传哪些字段。可以先加载示例数据看完整流程，再换成客户自己的历史实验、生产、校准、寿命或质检 CSV。" />
            <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
              <div className="space-y-5">
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <label className="block">
                    <div className="text-sm font-semibold text-white">项目名称</div>
                    <input
                      value={projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      className="mt-3 h-12 w-full rounded-2xl border border-white/10 bg-[#141821] px-4 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                    />
                  </label>
                  <label className="mt-5 block">
                    <div className="text-sm font-semibold text-white">项目空间</div>
                    <select
                      value={activeProjectId}
                      onChange={(event) => setActiveProjectId(event.target.value)}
                      className="mt-3 h-12 w-full rounded-2xl border border-white/10 bg-[#141821] px-4 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>{project.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-5 block">
                    <div className="text-sm font-semibold text-white">行业</div>
                    <select
                      value={industry}
                      onChange={(event) => setIndustry(event.target.value as HFCDIndustry)}
                      className="mt-3 h-12 w-full rounded-2xl border border-white/10 bg-[#141821] px-4 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                    >
                      {(Object.keys(HFCD_INDUSTRIES) as HFCDIndustry[]).map((item) => (
                        <option key={item} value={item}>{HFCD_INDUSTRIES[item].title}</option>
                      ))}
                    </select>
                  </label>
                  <div className="mt-5">
                    <IndustryUploadGuide industry={industry} />
                  </div>
                  <label className="mt-5 flex min-h-[150px] cursor-pointer flex-col items-center justify-center rounded-[24px] border border-dashed border-[#52DBA9]/25 bg-[#52DBA9]/6 px-5 py-6 text-center transition-colors hover:bg-[#52DBA9]/10">
                    <Upload className="h-8 w-8 text-[#8dffdf]" />
                    <span className="mt-3 text-sm font-semibold text-white">上传 CSV 数据</span>
                    <span className="mt-2 text-xs leading-6 text-slate-500">当前文件：{fileName || '尚未选择'}</span>
                    <input type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => handleUploadFile(event.target.files?.[0] || null)} />
                  </label>
                  <button
                    onClick={handleRunAudit}
                    className="mt-4 w-full rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] shadow-[0_14px_40px_rgba(82,219,169,0.18)] transition-colors hover:bg-[#67e5b7]"
                  >
                    运行 HFCD 分析
                  </button>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      onClick={() => handleDownloadTemplate(industry)}
                      className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-white/[0.08]"
                    >
                      下载当前模板
                    </button>
                    <button
                      onClick={() => handleLoadSample(industry)}
                      className="rounded-full border border-[#52DBA9]/20 bg-[#52DBA9]/10 px-4 py-2 text-xs font-semibold text-[#9df4d7] hover:bg-[#52DBA9]/16"
                    >
                      加载示例数据
                    </button>
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <CheckCircle2 className="h-4 w-4 text-[#7ef8d2]" />
                    字段完整性检查
                  </div>
                  <div className="mt-4 space-y-3 text-sm leading-7">
                    <div className="text-slate-300">数据行：<span className="font-semibold text-white">{rows.length}</span></div>
                    <div className="text-slate-300">可计算字段：<span className="font-semibold text-white">{validation.computableFields.length}</span></div>
                    <div className="text-slate-300">缺失必填：<span className={validation.missingRequired.length ? 'font-semibold text-red-300' : 'font-semibold text-[#9df4d7]'}>{validation.missingRequired.join(', ') || '无'}</span></div>
                    <div className="text-slate-500">建议补充：{validation.suggestedFields.slice(0, 8).join(', ') || '无'}</div>
                  </div>
                  <FieldHealthPanel fieldHealth={validation.fieldHealth} />
                  {uploadError ? <div className="mt-4 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{uploadError}</div> : null}
                </div>
              </div>

              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-4">
                  <MetricCard label="样本数" value={summary.sampleCount} note="当前分析结果。" />
                  <MetricCard label="全部达标" value={summary.strictStableCount} note="七类关键指标全部通过。" />
                  <MetricCard label="核心达标" value={summary.looseStableCount} note="核心指标通过。" />
                  <MetricCard label="高风险" value={summary.highRiskCount} note="风险分进入高位。" />
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-black tracking-tight text-white">结果表</h3>
                      <p className="mt-1 text-sm text-slate-500">先看样本诊断，再看指标明细。结果按“业务解释 / 关键指标 / 修复方案”三层输出。</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button disabled={!results.length} onClick={downloadCurrentCsv} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">下载 CSV</button>
                      <button disabled={!results.length} onClick={downloadCurrentMarkdown} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">下载 Markdown</button>
                      <button disabled={!results.length} onClick={downloadCurrentHtml} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">下载 HTML</button>
                      <button disabled={!results.length} onClick={() => openPrintablePdf()} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">打印/PDF</button>
                    </div>
                  </div>
                  <div className="mt-5">
                    <ResultDiagnosisPanel results={results} />
                  </div>
                  <div className="mt-5">
                    <ReportAnalyticsPanel industry={industry} results={results} />
                  </div>
                  <div className="mt-5">{renderResultsTable(results)}</div>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black tracking-tight text-white">数据预览</h3>
                  <div className="mt-4 overflow-x-auto rounded-[22px] border border-white/8">
                    <table className="min-w-[760px] w-full border-collapse text-left text-sm">
                      <tbody>
                        {rows.slice(0, 6).map((row, index) => (
                          <tr key={`${row.sample_id || 'row'}-${index}`} className="border-t border-white/8">
                            {Object.entries(row).slice(0, 8).map(([key, value]) => (
                              <td key={key} className="px-3 py-2 text-slate-400">
                                <span className="text-slate-600">{getFieldProfile(industry, key).label}: </span>{value}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!rows.length ? <div className="p-5 text-sm text-slate-500">上传 CSV 后显示数据预览。</div> : null}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'templates' ? (
          <section className="mt-8">
            <SectionTitle title="模板中心" description="用户第一次使用时不需要猜字段。四个行业模板都能直接下载，并提供字段说明与示例数据。" />
            <div className="grid gap-5 lg:grid-cols-2">
              {(Object.keys(HFCD_INDUSTRIES) as HFCDIndustry[]).map((item) => {
                const spec = HFCD_INDUSTRIES[item];
                const fields = getIndustryFieldProfiles(item);
                return (
                  <article key={item} className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-2xl font-black text-white">{spec.title}数据模板</h3>
                        <p className="mt-2 text-sm leading-7 text-slate-400">{spec.description}</p>
                      </div>
                      <button onClick={() => handleDownloadTemplate(item)} className="rounded-full bg-[#52DBA9] px-4 py-2 text-xs font-bold text-[#10131b]">下载 CSV</button>
                    </div>
                    <div className="mt-5 grid gap-2">
                      {fields.map((field) => (
                        <div key={field.key} className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-[#9df4d7]">{field.key}</span>
                            <span className="text-xs font-bold text-white">{field.label}</span>
                            {field.required ? <span className="rounded-full bg-red-500/12 px-2 py-0.5 text-[10px] font-bold text-red-200">required</span> : null}
                            <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-bold text-slate-400">{field.hfcdGate || 'extra'}</span>
                          </div>
                          <p className="mt-2 text-xs leading-6 text-slate-400">{field.plainMeaning || field.description}</p>
                          <div className="mt-2 grid gap-2 text-[11px] leading-5 text-slate-500 md:grid-cols-3">
                            <span>单位：{field.unit || '-'}</span>
                            <span>正常方向：{field.goodRange || '-'}</span>
                            <span>风险信号：{field.riskSignal || '-'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {activeTab === 'reports' ? (
          <section className="mt-8">
            <SectionTitle title="结果中心" description="这里统一保存两类结果：一类是上传 CSV 后生成的风险分析/盲测报告；另一类是云端真实跑模型后的报告、图表、CSV、summary、checkpoint 和日志位置。" />
            <div className="mb-5 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black text-white">风险分析报告</h3>
                  <p className="mt-1 text-sm text-slate-500">当前项目：{activeProject?.name || '未选择'}。按时间线追踪达标样本、高风险样本和平均风险分。</p>
                </div>
                <button onClick={() => setActiveTab('upload')} className="rounded-full border border-[#52DBA9]/20 bg-[#52DBA9]/10 px-4 py-2 text-xs font-semibold text-[#9df4d7]">上传新数据</button>
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                {activeProjectReports.slice(0, 6).map((report) => {
                  const reportSummary = summarizeAudit(report.results);
                  return (
                    <div key={report.id} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                      <div className="truncate text-sm font-bold text-white">{report.projectName}</div>
                      <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">{formatDate(report.createdAt)}</div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                        <div><div className="text-lg font-black text-[#9df4d7]">{reportSummary.strictStableCount}</div><div className="text-slate-500">达标</div></div>
                        <div><div className="text-lg font-black text-red-200">{reportSummary.highRiskCount}</div><div className="text-slate-500">风险</div></div>
                        <div><div className="text-lg font-black text-white">{reportSummary.averageRiskScore}</div><div className="text-slate-500">avg</div></div>
                      </div>
                    </div>
                  );
                })}
                {!activeProjectReports.length ? <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">当前项目还没有历史报告。</div> : null}
              </div>
            </div>
            <div className="mb-5 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black text-white">云端真实跑模型产物</h3>
                  <p className="mt-1 text-sm text-slate-500">Cloud Run 任务完成后，GCS 前缀、运行状态和产物清单会显示在这里。</p>
                </div>
                <button onClick={() => setActiveTab('research')} className="rounded-full bg-[#52DBA9] px-4 py-2 text-xs font-bold text-[#10131b]">提交云端任务</button>
              </div>
              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                {researchJobs.slice(0, 4).map((job) => {
                  const manifest = job.manifest as { artifacts?: string[]; returncode?: number; finished_at?: string } | undefined;
                  return (
                    <article key={job.id} className="rounded-[24px] border border-white/8 bg-black/10 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-black text-white">{job.projectName}</div>
                          <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">{formatDate(job.createdAt)} · {job.preset}</div>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${researchStatusClass(job.status)}`}>
                          {researchStatusLabel(job.status)}
                        </span>
                      </div>
                      <div className="mt-3 break-all font-mono text-xs leading-6 text-slate-400">{job.artifactPrefix || job.operationName || '等待提交或刷新状态'}</div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-2xl bg-white/[0.04] p-3">
                          <div className="text-xl font-black text-white">{manifest?.returncode ?? 'N/A'}</div>
                          <div className="text-slate-500">returncode</div>
                        </div>
                        <div className="rounded-2xl bg-white/[0.04] p-3">
                          <div className="text-xl font-black text-white">{manifest?.artifacts?.length ?? 0}</div>
                          <div className="text-slate-500">产物数</div>
                        </div>
                        <div className="rounded-2xl bg-white/[0.04] p-3">
                          <div className="text-xl font-black text-white">{manifest?.finished_at ? '已完成' : '待刷新'}</div>
                          <div className="text-slate-500">完成状态</div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button onClick={() => handleRefreshResearchJob(job)} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">刷新状态</button>
                        {job.artifactPrefix ? (
                          <button onClick={() => navigator.clipboard?.writeText(job.artifactPrefix || '')} className="rounded-full border border-[#52DBA9]/20 bg-[#52DBA9]/10 px-4 py-2 text-xs font-semibold text-[#9df4d7]">复制 GCS 前缀</button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
                {!researchJobs.length ? (
                  <div className="rounded-[24px] border border-white/8 bg-black/10 p-5 text-sm leading-7 text-slate-500">
                    还没有云端任务。进入“云端真实跑模型”，先提交一次 smoke 任务，确认链路能产出报告、图表和 checkpoint。
                  </div>
                ) : null}
              </div>
            </div>
            <div className="space-y-4">
              {reports.length ? reports.map((report) => {
                const reportSummary = summarizeAudit(report.results);
                const reportMarkdown = generateMarkdownReport({ projectName: report.projectName, industry: report.industry, results: report.results });
                const reportHtml = buildClientHtmlReport({ projectName: report.projectName, industry: report.industry, results: report.results });
                return (
                  <div key={report.id} className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="text-xl font-black text-white">{report.projectName}</div>
                        <div className="mt-2 text-xs uppercase tracking-[0.2em] text-slate-500">{HFCD_INDUSTRIES[report.industry].title} · {formatDate(report.createdAt)} · {report.fileName}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => downloadText(`${report.projectName}_report.md`, reportMarkdown, 'text/markdown;charset=utf-8')} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">Markdown</button>
                        <button onClick={() => downloadText(`${report.projectName}_report.html`, reportHtml, 'text/html;charset=utf-8')} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">HTML</button>
                        <button onClick={() => openPrintablePdf(report.projectName, report.industry, report.results)} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">打印/PDF</button>
                        <button onClick={() => downloadText(`${report.projectName}_results.csv`, toCsv(report.results.map(flattenAuditResult)), 'text/csv;charset=utf-8')} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">CSV</button>
                      </div>
                    </div>
                    <div className="mt-5 grid gap-3 md:grid-cols-5">
                      <MetricCard label="样本" value={reportSummary.sampleCount} note="本报告样本数。" />
                      <MetricCard label="全部达标" value={reportSummary.strictStableCount} note="全部关键指标通过。" />
                      <MetricCard label="高风险" value={reportSummary.highRiskCount} note="风险窗口。" />
                      <MetricCard label="主要风险" value={<span className="text-xl">{compactFailureMode(reportSummary.primaryFailureMode)}</span>} note="最主要的问题类型。" />
                      <MetricCard label="平均风险" value={reportSummary.averageRiskScore} note="整体风险面。" />
                    </div>
                    <div className="mt-5">
                      <ReportAnalyticsPanel industry={report.industry} results={report.results} />
                    </div>
                  </div>
                );
              }) : <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-8 text-sm text-slate-500">还没有报告。先进入“数据上传”跑一次 HFCD 分析。</div>}
            </div>
          </section>
        ) : null}

        {activeTab === 'blind' ? (
          <section className="mt-8">
            <SectionTitle title="盲测验证" description="用客户历史数据验证系统是否真的能提前发现风险。上传包含真实失效标签的 CSV 后，系统会自动对比客户原有模型，输出命中率、提升幅度和提前预警天数。" />
            <div className="mb-6 rounded-[28px] border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-black text-white">怎么让这一页有结果？</h3>
                  <p className="mt-2 max-w-4xl text-sm leading-8 text-slate-300">
                    CSV 至少需要 `actual_failure` 字段：真实失效填 1，未失效填 0。可选补充 `baseline_score` 用于和客户现有模型对比，补充 `lead_time_days` 用于统计提前预警天数。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => handleLoadBlindValidationSample(industry)} className="rounded-full bg-[#52DBA9] px-4 py-2 text-xs font-bold text-[#10131b]">
                    加载盲测示例
                  </button>
                  <button onClick={() => setActiveTab('upload')} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">
                    上传客户数据
                  </button>
                </div>
              </div>
              {!results.length || !blindMetrics.hasActualFailure ? (
                <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-7 text-amber-100">
                  当前没有可验证的真实失效标签，所以 AUC、Top10 命中率、提前预警都会显示 N/A。这不是计算失败，是缺少验证标签。
                </div>
              ) : null}
            </div>
            <div className="grid gap-4 md:grid-cols-4">
              <MetricCard label="标签状态" value={blindMetrics.hasActualFailure ? '已检测' : '未提供'} note="CSV 是否包含 actual_failure。" />
              <MetricCard label="AUC" value={blindMetrics.auc ?? 'N/A'} note="风险分对真实失效排序能力。" />
              <MetricCard label="precision@top10%" value={blindMetrics.precisionTop10 ?? 'N/A'} note="Top risk 样本命中率。" />
              <MetricCard label="高风险数" value={blindMetrics.highRiskCount} note="当前结果中高风险样本。" />
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-4">
              <MetricCard label="客户原模型 AUC" value={blindMetrics.baselineAuc ?? 'N/A'} note="如 CSV 提供 baseline_score，则自动对比。" />
              <MetricCard label="客户原模型 Top10" value={blindMetrics.baselinePrecisionTop10 ?? 'N/A'} note="客户现有模型 Top 风险命中率。" />
              <MetricCard label="命中率提升" value={blindMetrics.precisionLift ?? 'N/A'} note="本系统 Top10 命中率减客户原模型。" />
              <MetricCard label="提前预警" value={blindMetrics.warningLeadTimeAvg ?? 'N/A'} note="高风险且真实失效样本的平均提前天数。" />
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {[
                ['训练集', blindSplits.train.length, '只用于客户理解数据结构；HFCD 参数不在这里回看调参。'],
                ['验证集', blindSplits.validation.length, '用于演示冻结参数后的中间验证。'],
                ['盲测集', blindSplits.blind.length, '用于最终商业证明，严禁用标签反推参数。'],
              ].map(([label, count, note]) => (
                <div key={label} className="rounded-[26px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{label}</div>
                  <div className="mt-3 text-4xl font-black text-white">{count}</div>
                  <p className="mt-2 text-sm leading-7 text-slate-400">{note}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <h3 className="text-xl font-black text-white">验证口径</h3>
              <p className="mt-3 text-sm leading-8 text-slate-400">
                先冻结 HFCD 参数，再对 blind set 预测，最后计算 AUC / precision@top10% / baseline lift / 提前预警窗口。这一页不训练模型，不回看标签调参，避免把商业验证做成自证循环。
              </p>
              <div className="mt-5">
                <ReportAnalyticsPanel industry={industry} results={results} />
              </div>
              <div className="mt-5 overflow-x-auto rounded-[24px] border border-white/8">
                <table className="min-w-[920px] w-full border-collapse text-left text-sm">
                  <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.18em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">样本</th>
                      <th className="px-4 py-3">真实失效</th>
                      <th className="px-4 py-3">风险分</th>
                      <th className="px-4 py-3">客户原模型分</th>
                      <th className="px-4 py-3">提前天数</th>
                      <th className="px-4 py-3">主要风险</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 12).map((result) => (
                      <tr key={result.sample_id} className="border-t border-white/8 text-slate-300">
                        <td className="px-4 py-3 font-semibold text-white">{result.sample_id}</td>
                        <td className="px-4 py-3">{result.actual_failure === null || result.actual_failure === undefined ? '未提供' : result.actual_failure === 1 ? '是' : '否'}</td>
                        <td className="px-4 py-3 font-mono text-xs">{result.risk_score}</td>
                        <td className="px-4 py-3 font-mono text-xs">{result.baseline_score ?? 'N/A'}</td>
                        <td className="px-4 py-3 font-mono text-xs">{result.warning_lead_time ?? 'N/A'}</td>
                        <td className="px-4 py-3">{compactFailureMode(result.failure_mode)}</td>
                      </tr>
                    ))}
                    {!results.length ? (
                      <tr className="border-t border-white/8">
                        <td colSpan={6} className="px-4 py-6 text-slate-500">还没有验证数据。点击“加载盲测示例”或上传带 actual_failure 的 CSV。</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <div className="mt-5">{renderResultsTable([...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 20))}</div>
            </div>
          </section>
        ) : null}

        {activeTab === 'calibration' ? (
          <section className="mt-8">
            <SectionTitle
              title="客户行业参数学习"
              description="把客户历史数据转成行业专属候选安全线。它不是训练大模型，而是根据客户自己的未失效样本、稳定样本和全量分布，自动校准下一轮审计参数。"
            />
            <div className="mb-6 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-black text-white">使用方式</h3>
                  <p className="mt-2 max-w-4xl text-sm leading-8 text-slate-300">
                    最好上传历史数据并包含 actual_failure：未失效样本填 0，已失效样本填 1。系统会优先从未失效样本里学习行业安全线，再用学习后的参数重跑审计和盲测。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => handleLoadBlindValidationSample(industry)} className="rounded-full bg-[#52DBA9] px-4 py-2 text-xs font-bold text-[#10131b]">
                    加载学习示例
                  </button>
                  <button onClick={() => setActiveTab('upload')} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">
                    上传客户数据
                  </button>
                </div>
              </div>
            </div>
            <ParameterLearningPanel profile={parameterProfile} onApply={handleRunLearnedAudit} />
          </section>
        ) : null}

        {activeTab === 'simulation' ? (
          <section className="mt-8">
            <SectionTitle
              title="研发方案仿真与完整场仿真"
              description="先用客户数据快速扫描研发修复路径，再录入物理参数、工艺参数、边界条件和数字孪生输入，运行 hfcd-field-v1 完整场仿真，比较长期轨迹、收敛评分和推荐方案。"
            />
            <div className="mb-6 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-black text-white">两层仿真已经接入</h3>
                  <p className="mt-3 max-w-5xl text-sm leading-8 text-slate-300">
                    第一层直接基于上传数据扫描候选修复路径，适合快速判断哪类研发动作最可能降低风险。第二层接收客户的物理参数、工艺参数、边界条件和数字孪生输入，输出多步场轨迹、候选路线对比、推荐方案、收敛评分和可信度。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setActiveTab('research')} className="rounded-full bg-[#52DBA9] px-4 py-2 text-xs font-bold text-[#10131b]">
                    提交云端长程实验
                  </button>
                  <button onClick={() => handleLoadBlindValidationSample(industry)} className="rounded-full bg-[#52DBA9] px-4 py-2 text-xs font-bold text-[#10131b]">
                    加载仿真示例
                  </button>
                  <button onClick={() => setActiveTab('upload')} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">
                    上传客户数据
                  </button>
                </div>
              </div>
            </div>
            <div className="mb-6 rounded-[28px] border border-[#52DBA9]/20 bg-[#52DBA9]/8 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-black uppercase tracking-[0.24em] text-[#8dffdf]">Cloud Run Real Experiment</div>
                  <h3 className="mt-3 text-2xl font-black text-white">真实云端长程实验入口</h3>
                  <p className="mt-3 max-w-5xl text-sm leading-8 text-slate-300">
                    这里不是页面里的轻量模拟。点击后会进入云端任务页，提交你原来的 HFCD V12.x Python 长程脚本到 Google Cloud Run，
                    从 GCS 拉取脚本和 checkpoint，运行后把 Markdown、PNG、CSV、summary、progress log 和 checkpoint 写回 GCS。
                  </p>
                </div>
                <button
                  onClick={() => setActiveTab('research')}
                  className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] shadow-[0_14px_40px_rgba(82,219,169,0.18)]"
                >
                  去运行云端真实实验
                </button>
              </div>
            </div>
            <SimulationPanel report={simulationReport} />
            <div className="mt-8">
              <FieldSimulationPanel
                industry={industry}
                input={fieldInput}
                report={fieldSimulationReport}
                onInputChange={setFieldInput}
                onNeedData={() => {
                  setUploadError('请先上传 CSV 数据或加载示例数据，再运行完整场仿真。');
                  setActiveTab('upload');
                }}
              />
            </div>
          </section>
        ) : null}

        {activeTab === 'research' ? (
          <section className="mt-8">
            <SectionTitle
              title="云端真实跑模型"
              description="这里跑的是真实云端任务：Cloud Run 执行 HFCD V12.x Python 长程脚本，GCS 保存 CSV、JSON、Markdown、PNG、checkpoint 和运行日志。先用 smoke 验证链路，再扩大运行规模。"
            />
            <div className="mb-6 rounded-[30px] border border-[#52DBA9]/18 bg-[#52DBA9]/8 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-black text-white">最快跑法：先提交 smoke 任务</h3>
                  <p className="mt-2 max-w-4xl text-sm leading-8 text-slate-300">
                    smoke 只跑小规模任务，用来确认云端链路、GCS 写入和结果读取都正常。成功后再把 max variants、checkpoint 数量调大，进入标准长程运行。
                  </p>
                </div>
                <button
                  onClick={() => {
                    const smokeRequest = { ...researchRequest, smoke: true, maxVariants: 1, topCheckpoints: 1 };
                    setResearchRequest(smokeRequest);
                    void submitResearchJob(smokeRequest);
                  }}
                  className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] shadow-[0_14px_40px_rgba(82,219,169,0.18)]"
                >
                  一键提交 smoke
                </button>
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-4">
                <MetricCard label="任务引擎" value={<span className="text-2xl">Cloud Run</span>} note="真实运行 Python 脚本，不是前端假演示。" />
                <MetricCard label="默认模式" value={<span className="text-2xl">smoke</span>} note="先验证链路，再扩大运行规模。" />
                <MetricCard label="输出产物" value="6 类" note="报告、图表、CSV、summary、checkpoint、日志。" />
                <MetricCard label="最新任务" value={researchJobs[0] ? researchStatusLabel(researchJobs[0].status) : '未提交'} note="提交后可在本页和结果中心刷新状态。" />
              </div>
            </div>
            <div className="grid gap-6 xl:grid-cols-[430px_minmax(0,1fr)]">
              <div className="space-y-5">
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">提交长程实验</h3>
                  <p className="mt-2 text-sm leading-7 text-slate-400">
                    这里启动的不是浏览器里的轻量计算，而是 Cloud Run 上的 Python 任务。建议先用 smoke 模式验证链路，再放大 max variants 和 checkpoint 数。
                  </p>
                  <label className="mt-5 block">
                    <div className="text-sm font-semibold text-white">任务名称</div>
                    <input
                      value={researchRequest.projectName || ''}
                      onChange={(event) => setResearchRequest((current) => ({ ...current, projectName: event.target.value }))}
                      className="mt-3 h-12 w-full rounded-2xl border border-white/10 bg-[#141821] px-4 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                    />
                  </label>
                  <label className="mt-5 block">
                    <div className="text-sm font-semibold text-white">实验版本</div>
                    <select
                      value={researchRequest.preset || 'v12_38_me28800'}
                      onChange={(event) => setResearchRequest((current) => ({ ...current, preset: event.target.value as HFCDResearchJobRequest['preset'] }))}
                      className="mt-3 h-12 w-full rounded-2xl border border-white/10 bg-[#141821] px-4 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                    >
                      <option value="v12_38_me28800">V12.38 Post27000 ME28800</option>
                      <option value="v12_37_meprc">V12.37 Post25200 MEPRC</option>
                    </select>
                  </label>
                  <label className="mt-5 block">
                    <div className="text-sm font-semibold text-white">数据源模式</div>
                    <select
                      value={researchRequest.sourceMode || 'best101'}
                      onChange={(event) => setResearchRequest((current) => ({ ...current, sourceMode: event.target.value }))}
                      className="mt-3 h-12 w-full rounded-2xl border border-white/10 bg-[#141821] px-4 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                    >
                      <option value="best101">best101</option>
                      <option value="repair">repair</option>
                      <option value="all">all</option>
                    </select>
                  </label>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <label className="block">
                      <div className="text-xs font-semibold text-slate-400">max variants</div>
                      <input
                        type="number"
                        min={0}
                        max={64}
                        value={researchRequest.maxVariants ?? 1}
                        onChange={(event) => setResearchRequest((current) => ({ ...current, maxVariants: Number(event.target.value) }))}
                        className="mt-2 h-11 w-full rounded-2xl border border-white/10 bg-[#141821] px-3 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                      />
                    </label>
                    <label className="block">
                      <div className="text-xs font-semibold text-slate-400">top checkpoints</div>
                      <input
                        type="number"
                        min={0}
                        max={500}
                        value={researchRequest.topCheckpoints ?? 1}
                        onChange={(event) => setResearchRequest((current) => ({ ...current, topCheckpoints: Number(event.target.value) }))}
                        className="mt-2 h-11 w-full rounded-2xl border border-white/10 bg-[#141821] px-3 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                      />
                    </label>
                    <label className="block">
                      <div className="text-xs font-semibold text-slate-400">log interval</div>
                      <input
                        type="number"
                        min={30}
                        max={7200}
                        value={researchRequest.logInterval ?? 60}
                        onChange={(event) => setResearchRequest((current) => ({ ...current, logInterval: Number(event.target.value) }))}
                        className="mt-2 h-11 w-full rounded-2xl border border-white/10 bg-[#141821] px-3 text-sm text-slate-200 outline-none focus:border-[#52DBA9]/50"
                      />
                    </label>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <label className="flex items-center gap-3 rounded-2xl border border-white/8 bg-black/10 px-4 py-3 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={researchRequest.resume !== false}
                        onChange={(event) => setResearchRequest((current) => ({ ...current, resume: event.target.checked }))}
                        className="accent-[#52DBA9]"
                      />
                      允许从 checkpoint 续跑
                    </label>
                    <label className="flex items-center gap-3 rounded-2xl border border-white/8 bg-black/10 px-4 py-3 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={Boolean(researchRequest.smoke)}
                        onChange={(event) => setResearchRequest((current) => ({ ...current, smoke: event.target.checked }))}
                        className="accent-[#52DBA9]"
                      />
                      smoke 模式先测链路
                    </label>
                  </div>
                  <button
                    onClick={handleSubmitResearchJob}
                    className="mt-5 w-full rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] shadow-[0_14px_40px_rgba(82,219,169,0.18)] transition-colors hover:bg-[#67e5b7]"
                  >
                    提交到云端真实运行
                  </button>
                </div>

                <div className="rounded-[28px] border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-5">
                  <h3 className="text-xl font-black text-white">云端资源要求</h3>
                  <div className="mt-3 space-y-2 text-sm leading-7 text-slate-300">
                    <div>Cloud Run Job：运行 `cloud/hfcd-runner` 容器。</div>
                    <div>GCS Source：保存 `/Users/beijisheng/Desktop/codex_wxl` 的脚本、checkpoint 和历史输出。</div>
                    <div>GCS Artifacts：每个任务独立保存 `cloud_manifest.json`、结果文件和 runner 日志。</div>
                    <div>Worker 凭据：使用服务账号调用 Cloud Run 与读取 GCS。</div>
                  </div>
                </div>
              </div>

              <div className="space-y-5">
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-black text-white">任务队列</h3>
                      <p className="mt-1 text-sm text-slate-500">任务状态来自 Cloud Run operation；完成后再读取 GCS 的 cloud_manifest.json。</p>
                    </div>
                    <button
                      onClick={() => researchJobs[0] && handleRefreshResearchJob(researchJobs[0])}
                      disabled={!researchJobs.length}
                      className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40"
                    >
                      刷新最新任务
                    </button>
                  </div>
                  <div className="mt-5 space-y-4">
                    {researchJobs.map((job) => {
                      const manifest = job.manifest as { artifacts?: string[]; error?: string; returncode?: number; finished_at?: string } | undefined;
                      return (
                        <article key={job.id} className="rounded-[26px] border border-white/8 bg-black/10 p-5">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <div className="text-lg font-black text-white">{job.projectName}</div>
                              <div className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{job.id} · {formatDate(job.createdAt)}</div>
                            </div>
                            <span className={`rounded-full border px-3 py-1 text-xs font-bold ${researchStatusClass(job.status)}`}>
                              {researchStatusLabel(job.status)}
                            </span>
                          </div>
                          <div className="mt-4 grid gap-3 md:grid-cols-2">
                            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
                              <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Cloud Run Operation</div>
                              <div className="mt-2 break-all font-mono text-xs leading-6 text-slate-300">{job.operationName || 'N/A'}</div>
                            </div>
                            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
                              <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">GCS Artifacts</div>
                              <div className="mt-2 break-all font-mono text-xs leading-6 text-slate-300">{job.artifactPrefix || 'N/A'}</div>
                            </div>
                          </div>
                          {job.message ? <p className="mt-4 text-sm leading-7 text-slate-400">{job.message}</p> : null}
                          {manifest ? (
                            <div className="mt-4 rounded-2xl border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-4">
                              <div className="text-sm font-bold text-white">结果清单</div>
                              <div className="mt-2 text-xs leading-6 text-slate-400">
                                returncode：{manifest.returncode ?? 'N/A'} · finished：{manifest.finished_at || 'N/A'} · artifacts：{manifest.artifacts?.length || 0}
                              </div>
                              {manifest.artifacts?.length ? (
                                <div className="mt-3 max-h-[180px] overflow-auto rounded-xl bg-black/20 p-3">
                                  {manifest.artifacts.slice(0, 20).map((artifact) => (
                                    <div key={artifact} className="break-all font-mono text-[11px] leading-5 text-[#9df4d7]">{artifact}</div>
                                  ))}
                                </div>
                              ) : null}
                              {manifest.error ? <pre className="mt-3 max-h-[180px] overflow-auto whitespace-pre-wrap text-xs leading-6 text-red-200">{manifest.error}</pre> : null}
                            </div>
                          ) : null}
                          <div className="mt-4 flex flex-wrap gap-2">
                            <button
                              onClick={() => handleRefreshResearchJob(job)}
                              className="rounded-full bg-[#52DBA9] px-4 py-2 text-xs font-bold text-[#10131b]"
                            >
                              查询状态
                            </button>
                            {job.artifactPrefix ? (
                              <button
                                onClick={() => navigator.clipboard?.writeText(job.artifactPrefix || '')}
                                className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200"
                              >
                                复制 GCS 前缀
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                    {!researchJobs.length ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/10 p-6 text-sm leading-7 text-slate-500">
                        还没有云端长程任务。先用 smoke 模式提交一次，确认 Cloud Run、GCS 和 Worker 凭据都通，再扩大运行规模。
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">这和前面的快速分析有什么区别？</h3>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    {[
                      ['快速审计', '浏览器或 Worker 里对客户 CSV 做稳定性指标映射，秒级返回，适合客户初筛。'],
                      ['参数化仿真', '基于客户数据和手动输入参数生成候选研发路线，多步轨迹是产品级模拟。'],
                      ['研究级长程仿真', '运行原始 V12.x Python 脚本，吃 CPU、checkpoint 和磁盘输出，适合继续推进物质生成实验链。'],
                    ].map(([title, body]) => (
                      <div key={title} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                        <div className="font-bold text-white">{title}</div>
                        <p className="mt-2 text-sm leading-7 text-slate-400">{body}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'projects' ? (
          <section className="mt-8">
            <SectionTitle title="企业项目空间" description="项目空间把客户、数据集、报告、团队权限和多轮趋势放在一起。当前为本地优先实现，后续可以平滑迁移到 Firestore 企业空间。" />
            <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
              <div className="space-y-4">
                <button onClick={handleCreateProject} className="w-full rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]">
                  新建企业项目空间
                </button>
                {projects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => setActiveProjectId(project.id)}
                    className={`w-full rounded-[24px] border p-4 text-left transition-colors ${
                      activeProjectId === project.id
                        ? 'border-[#52DBA9]/30 bg-[#52DBA9]/12'
                        : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06]'
                    }`}
                  >
                    <div className="text-lg font-black text-white">{project.name}</div>
                    <div className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{project.organization} · {project.status}</div>
                    <div className="mt-3 text-sm text-slate-400">{project.members.length} 位成员 · {datasets.filter((dataset) => dataset.projectId === project.id).length} 个数据集</div>
                  </button>
                ))}
              </div>
              <div className="space-y-6">
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-2xl font-black text-white">{activeProject?.name || '未选择项目'}</h3>
                      <p className="mt-2 text-sm leading-7 text-slate-400">
                        {activeProject?.organization || '-'} · Owner {activeProject?.owner || '-'} · 创建于 {activeProject ? formatDate(activeProject.createdAt) : '-'}
                      </p>
                    </div>
                    <button onClick={() => setActiveTab('upload')} className="rounded-full border border-[#52DBA9]/20 bg-[#52DBA9]/10 px-4 py-2 text-xs font-semibold text-[#9df4d7]">上传新数据集</button>
                  </div>
                  <div className="mt-5 grid gap-3 md:grid-cols-3">
                    <MetricCard label="数据集" value={activeProjectDatasets.length} note="当前项目数据集数。" />
                    <MetricCard label="报告" value={activeProjectReports.length} note="当前项目报告数。" />
                    <MetricCard label="成员" value={activeProject?.members.length || 0} note="本地权限台账。" />
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">团队权限</h3>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    {(activeProject?.members || []).map((member) => (
                      <div key={`${member.name}-${member.role}`} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                        <div className="font-bold text-white">{member.name}</div>
                        <div className="mt-1 text-xs uppercase tracking-[0.18em] text-[#9df4d7]">{member.role}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">数据集管理</h3>
                  <div className="mt-4 space-y-3">
                    {activeProjectDatasets.length ? activeProjectDatasets.map((dataset) => (
                      <div key={dataset.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/8 bg-black/10 p-4">
                        <div>
                          <div className="font-semibold text-white">{dataset.fileName}</div>
                          <div className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">{HFCD_INDUSTRIES[dataset.industry].title} · {dataset.rowCount} rows · {formatDate(dataset.createdAt)}</div>
                        </div>
                        <button
                          onClick={() => {
                            const report = reports.find((item) => item.id === dataset.reportId);
                            if (report) {
                              setResults(report.results);
                              setIndustry(report.industry);
                              setProjectName(report.projectName);
                              setActiveTab('reports');
                            }
                          }}
                          className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200"
                        >
                          查看报告
                        </button>
                      </div>
                    )) : <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">当前项目还没有数据集。</div>}
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">多轮趋势</h3>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {activeProjectReports.slice(0, 8).map((report) => {
                      const reportSummary = summarizeAudit(report.results);
                      return (
                        <div key={report.id} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                          <div className="truncate text-sm font-bold text-white">{report.projectName}</div>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-red-500/16">
                            <div
                              className="h-full rounded-full bg-[#52DBA9]"
                              style={{ width: `${reportSummary.sampleCount ? (reportSummary.strictStableCount / reportSummary.sampleCount) * 100 : 0}%` }}
                            />
                          </div>
                          <div className="mt-2 text-xs text-slate-500">达标 {reportSummary.strictStableCount}/{reportSummary.sampleCount} · 高风险 {reportSummary.highRiskCount} · 平均 {reportSummary.averageRiskScore}</div>
                        </div>
                      );
                    })}
                    {!activeProjectReports.length ? <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">跑完一次分析后，这里会出现趋势。</div> : null}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'api' ? (
          <section className="mt-8">
            <SectionTitle title="API 商业版" description="把研发风险诊断接入企业系统。客户可以把实验数据、生产数据或质检数据通过 API 提交，系统返回字段检查、风险排序、修复建议和报告结构。" />
            <div className="mb-6 grid gap-4 md:grid-cols-3">
              {[
                ['1. 提交数据', '通过 POST /api/hfcd/audit 提交行业类型、mode、rows/csv。需要完整场仿真时使用 mode=field，并附带 fieldSimulation 参数。'],
                ['2. 自动计算', '系统完成字段检查、风险评分、参数学习、盲测验证、研发方案扫描和完整场仿真。'],
                ['3. 回写客户系统', '同步返回审计结果、候选方案、场轨迹和推荐路线；后续可扩展 job_id、异步报告、callback_url 和企业账单。'],
              ].map(([title, body]) => (
                <div key={title} className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                  <div className="font-bold text-white">{title}</div>
                  <p className="mt-2 text-sm leading-7 text-slate-400">{body}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
              <div className="space-y-5">
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">API Key</h3>
                  <p className="mt-2 text-sm leading-7 text-slate-400">这里先生成本地商用台账，便于演示调用次数和客户密钥管理。生产环境如需强制鉴权，需要在 Cloudflare Worker 环境变量中配置 `HFCD_API_KEYS`。</p>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <button onClick={handleGenerateApiKey} className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b]">
                      生成 API Key
                    </button>
                    <button onClick={handleTestApiCall} className="rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-slate-200">
                      测试调用
                    </button>
                  </div>
                  {apiTestResult ? <div className="mt-3 rounded-2xl border border-white/8 bg-black/10 px-4 py-3 text-sm text-slate-300">{apiTestResult}</div> : null}
                  {apiResponsePreview ? (
                    <details className="mt-3 rounded-2xl border border-white/8 bg-black/10 p-4">
                      <summary className="cursor-pointer text-sm font-semibold text-white">查看最近一次返回结果</summary>
                      <pre className="mt-3 max-h-[360px] overflow-auto text-xs leading-6 text-slate-300"><code>{apiResponsePreview}</code></pre>
                    </details>
                  ) : null}
                  <div className="mt-4 space-y-3">
                    {apiKeys.map((item) => (
                      <div key={item.id} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="font-bold text-white">{item.name}</div>
                          <span className="rounded-full bg-white/8 px-2 py-1 text-[10px] font-bold text-slate-400">{item.callCount} calls</span>
                        </div>
                        <div className="mt-2 break-all font-mono text-xs text-[#9df4d7]">{item.key}</div>
                        <div className="mt-2 text-[11px] text-slate-500">创建：{formatDate(item.createdAt)} · 最近调用：{item.lastUsedAt ? formatDate(item.lastUsedAt) : 'N/A'}</div>
                      </div>
                    ))}
                    {!apiKeys.length ? <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">还没有 API Key。</div> : null}
                  </div>
                </div>
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">商业化参数</h3>
                  <div className="mt-4 space-y-3 text-sm leading-7 text-slate-300">
                    <div>Endpoint：<span className="font-mono text-[#9df4d7]">POST /api/hfcd/audit</span></div>
                    <div>模型名称：<span className="font-mono text-[#9df4d7]">研发增强模型 v1</span></div>
                    <div>行业参数版本：<span className="font-mono text-[#9df4d7]">quantum/materials/energy/bio@v1.3-advanced</span></div>
                    <div>运行模式：<span className="font-mono text-[#9df4d7]">audit / calibrate / simulate / advanced / field</span></div>
                    <div>回调字段：<span className="font-mono text-[#9df4d7]">callback_url</span> 已预留给异步报告生成。</div>
                  </div>
                </div>
              </div>

              <div className="space-y-5">
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-xl font-black text-white">调用示例</h3>
                    <button onClick={() => navigator.clipboard?.writeText(apiExample)} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">复制</button>
                  </div>
                  <pre className="mt-4 overflow-x-auto rounded-2xl border border-white/8 bg-black/30 p-4 text-xs leading-6 text-slate-300"><code>{apiExample}</code></pre>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">API 输出结构</h3>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {[
                      ['validation', '字段完整性、可计算字段、字段体检。'],
                      ['summary', '样本数、全部达标、核心达标、高风险数、主要风险类型。'],
                      ['gateSafety', '七类指标通过/未通过统计，可直接画图。'],
                      ['blindMetrics', 'AUC、precision@top10%、baseline 对比、提前预警。'],
                      ['parameterProfile', '客户行业参数学习结果：默认安全线、学习后安全线、样本统计和使用建议。'],
                      ['simulation', '研发候选方案仿真：不同修复路径的达标增益、高风险减少和推荐方案。'],
                      ['fieldSimulation', '完整场仿真：客户参数输入、多步轨迹、候选研发路线、推荐方案、收敛评分和可信度。'],
                      ['results', '每个样本的指标数值、通过状态、风险分和可读诊断。'],
                      ['callback', '后续异步报告生成后回调客户系统。'],
                    ].map(([key, body]) => (
                      <div key={key} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                        <div className="font-mono text-xs text-[#9df4d7]">{key}</div>
                        <p className="mt-2 text-sm leading-7 text-slate-400">{body}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[28px] border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-5">
                  <div className="flex items-center gap-3 text-lg font-black text-white">
                    <Download className="h-5 w-5 text-[#8dffdf]" />
                    异步报告流程
                  </div>
                  <p className="mt-3 text-sm leading-8 text-slate-300">
                    当前 API 已支持同步审计、参数学习、候选方案扫描和 hfcd-field-v1 完整场仿真；商业版异步流程为：提交数据 → 返回 job_id → Worker 后台生成 Markdown/HTML/PDF-ready 报告 → callback_url 推送结果 → 调用次数计入企业账单。
                  </p>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'knowledge' ? (
          <section className="mt-8">
            <SectionTitle title="诊断规则库" description="把研发规则沉淀成客户看得懂的风险类型字典。系统不是黑箱分类器，而是能解释原因并给出研发动作的诊断引擎。" />
            <div className="mb-8 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-4 text-xl font-black tracking-tight text-white">七类稳定性指标</h3>
              <GateLegendPanel />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {(Object.keys(FAILURE_MODE_LABELS) as HFCDFailureMode[]).map((mode) => (
                <div key={mode} className="rounded-[26px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#52DBA9]/16 bg-[#52DBA9]/10 text-[#9df4d7]">
                      <Gauge className="h-4 w-4" />
                    </div>
                    <h3 className="text-xl font-black text-white">{compactFailureMode(mode)}</h3>
                  </div>
                  <p className="mt-4 text-sm leading-8 text-slate-300">{BASE_REPAIR_PLANS[mode]}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 rounded-[30px] border border-[#52DBA9]/14 bg-[linear-gradient(180deg,rgba(82,219,169,0.08),rgba(255,255,255,0.02))] p-6">
              <div className="flex items-center gap-3 text-lg font-black text-white">
                <Layers3 className="h-5 w-5 text-[#8dffdf]" />
                三种运行模式
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                {[
                  ['快速审计模式', '默认 SaaS 模式：上传历史实验/生产/寿命/批次数据，输出风险评分、风险类型、稳定状态、修复建议和报告。'],
                  ['冻结参数盲测模式', '客户提供历史数据和 actual_failure 标签，系统冻结 HFCD 参数并输出 AUC、precision@top10% 和提前预警能力。'],
                  ['完整场仿真模式', '客户补充物理参数、工艺参数、边界条件和数字孪生输入后，系统运行 hfcd-field-v1，输出多步场轨迹、候选研发路线、推荐方案、收敛评分和可信度。'],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-[24px] border border-white/8 bg-black/10 p-5">
                    <div className="text-sm font-bold text-white">{title}</div>
                    <p className="mt-3 text-sm leading-7 text-slate-400">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
