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
  HFCD_GATE_EXPLANATIONS,
  HFCD_INDUSTRIES,
  HFCDIndustry,
  HFCDAuditResult,
  HFCDFailureMode,
  parseCsv,
  summarizeAudit,
  summarizeGateSafety,
  templateToCsv,
  toCsv,
  validateBlindMetrics,
  validateRows,
} from '../lib/hfcdCore';

type WorkbenchTab = 'dashboard' | 'upload' | 'templates' | 'reports' | 'blind' | 'projects' | 'api' | 'knowledge';

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

const REPORT_STORAGE_KEY = 'hfcdAuditReportsV1';
const PROJECT_STORAGE_KEY = 'hfcdProjectsV1';
const DATASET_STORAGE_KEY = 'hfcdDatasetsV1';
const API_KEYS_STORAGE_KEY = 'hfcdApiKeysV1';

const TABS: Array<{ id: WorkbenchTab; label: string; icon: React.ElementType }> = [
  { id: 'dashboard', label: '仪表盘', icon: BarChart3 },
  { id: 'upload', label: '数据上传', icon: Upload },
  { id: 'templates', label: '模板中心', icon: FileDown },
  { id: 'reports', label: '报告中心', icon: FileText },
  { id: 'blind', label: '盲测验证', icon: ShieldAlert },
  { id: 'projects', label: '项目空间', icon: Database },
  { id: 'api', label: 'API 商业版', icon: FlaskConical },
  { id: 'knowledge', label: 'HFCD 知识库', icon: BookOpen },
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
      ? `本批数据出现 ${summary.highRiskCount} 个高风险样本，主失效模式为 ${summary.primaryFailureMode}。建议先锁定 Top Risk 样本做研发复盘。`
      : summary.strictStableCount === summary.sampleCount && summary.sampleCount > 0
        ? '本批数据整体处于严格稳定窗，可作为当前阶段的基准窗口。'
        : `本批数据处于临界状态，主失效模式为 ${summary.primaryFailureMode}，建议先修复未通过的稳定门。`;

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
      <div class="metric"><b>${summary.strictStableCount}</b><span>strict stable</span></div>
      <div class="metric"><b>${summary.looseStableCount}</b><span>loose stable</span></div>
      <div class="metric"><b>${summary.highRiskCount}</b><span>高风险样本</span></div>
      <div class="metric"><b>${summary.averageRiskScore}</b><span>平均风险分</span></div>
    </div>
  </section>

  <h2>字段解释</h2>
  <table>
    <thead><tr><th>字段</th><th>业务含义</th><th>影响门</th><th>推荐区间</th><th>风险信号</th></tr></thead>
    <tbody>
      ${fields
        .map(
          (field) =>
            `<tr><td><code>${escapeHtml(field.key)}</code><br />${escapeHtml(field.label)}</td><td>${escapeHtml(field.plainMeaning || field.description)}</td><td>${escapeHtml(field.hfcdGate || '-')}</td><td>${escapeHtml(field.goodRange || '-')}</td><td>${escapeHtml(field.riskSignal || '-')}</td></tr>`,
        )
        .join('')}
    </tbody>
  </table>

  <h2>样本诊断</h2>
  ${topRisk
    .map((result) => {
      const severityClass = result.readable.severity === '高风险' ? 'high' : result.readable.severity === '临界' ? 'risk' : '';
      return `<article class="card">
        <span class="pill ${severityClass}">${escapeHtml(result.readable.severity)} · risk ${result.risk_score}</span>
        <h3>${escapeHtml(result.sample_id)} · ${escapeHtml(result.failure_mode)}</h3>
        <div class="grid cols">
          <div><b>业务解释</b><p class="small">${escapeHtml(result.readable.businessSummary)}</p></div>
          <div><b>HFCD 变量</b><p class="small">${escapeHtml(result.readable.hfcdSummary)}</p></div>
          <div><b>修复方案</b><p class="small">${escapeHtml(result.readable.repairSummary)}</p></div>
        </div>
      </article>`;
    })
    .join('')}

  <h2>盲测指标</h2>
  <div class="card">
    <p>actual_failure 标签：${validation.hasActualFailure ? '已检测' : '未提供'}；AUC：${validation.auc ?? 'N/A'}；precision@top10%：${validation.precisionTop10 ?? 'N/A'}。</p>
    <p class="small">运行边界：当前为 HFCD Stability-Window Audit，不是完整 V12.x 场动力学仿真。深度仿真需要更多物理参数、工艺参数、边界条件和数字孪生输入。</p>
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
      <div className="text-xs font-bold uppercase tracking-[0.28em] text-[#7ef8d2]/75">HFCD Stability-Window Audit</div>
      <h2 className="mt-3 text-3xl font-black tracking-tight text-white">{title}</h2>
      <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-400 md:text-base">{description}</p>
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
  return mode.replace(/_/g, ' ');
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

function FailureModeChart({ results }: { results: HFCDAuditResult[] }) {
  const summary = summarizeAudit(results);
  const entries = Object.entries(summary.failureModeCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">暂无 FailureMode 分布。</div>;

  return (
    <div className="space-y-3">
      {entries.map(([mode, count]) => {
        const width = summary.sampleCount ? Math.max(6, (count / summary.sampleCount) * 100) : 0;
        return (
          <div key={mode}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-mono text-slate-300">{mode}</span>
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
              <div className="truncate font-mono text-xs text-[#9df4d7]" title={gate.gate}>{gate.gate}</div>
              <div className="mt-1 text-sm font-bold leading-6 text-white">{gate.label}</div>
            </div>
          </div>
          <div className="absolute right-4 top-4 rounded-full bg-white/8 px-2.5 py-1 text-sm font-black text-white">
            {Math.round(gate.safeRate * 100)}%
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-red-500/16">
            <div className="h-full rounded-full bg-[#52DBA9]" style={{ width: `${gate.safeRate * 100}%` }} />
          </div>
          <div className="mt-2 text-[11px] text-slate-500">Safe {gate.safeCount} · Fail {gate.failCount}</div>
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
          <div>sample</div>
          {gateLabels.map((gate) => <div key={gate}>{gate}</div>)}
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
                    title={`${gate}: ${result.gates[gate]}`}
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
      '如果主病灶是 energy_surplus_overflow，优先做 pulse/drive 微闭合，不要直接全局重校准。',
      '如果主病灶是 de_localized，先处理 ZZ crosstalk、frequency crowding 和 coupler avoid list。',
    ],
    materials: [
      '先锁定缺陷密度、裂纹长度和应力窗口最高的批次。',
      '如果主病灶是 Q_loss，优先复核相纯度、成分偏析和晶相转变。',
      '如果主病灶是 de_localized，优先压回缺陷扩散和裂纹扩展半径。',
    ],
    energy: [
      '先锁定阻抗增长、热风险和退化扩散最高的电芯/模组。',
      '如果主病灶是 energy_surplus_overflow，优先收敛倍率、热管理和局部电化学过载。',
      '如果主病灶是 buffer_decay，优先扩大 reserve_margin 而不是追求短期输出。',
    ],
    bio: [
      '先锁定 cell identity、viability、metabolic load 和 heterogeneity 的异常批次。',
      '如果主病灶是 cavity_underfill，优先修复培养环境、营养供给和气体交换。',
      '如果主病灶是 de_localized，优先处理细胞状态分叉和亚群漂移。',
    ],
  };

  return (
    <div className="rounded-[24px] border border-[#52DBA9]/14 bg-[#52DBA9]/7 p-5">
      <div className="text-sm font-black text-white">行业化研发建议 · 主病灶 {primary}</div>
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
          <h3 className="text-lg font-black text-white">FailureMode 分布</h3>
          <div className="mt-4"><FailureModeChart results={results} /></div>
        </div>
        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
          <h3 className="text-lg font-black text-white">Gate 安全统计</h3>
          <div className="mt-4"><GateSafetyChart results={results} /></div>
        </div>
      </div>
      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
        <h3 className="text-lg font-black text-white">风险热图</h3>
        <p className="mt-1 text-sm text-slate-500">绿色为通过，红色为失效。按 risk_score 从高到低展示前 24 个样本。</p>
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
              <span className="font-mono text-xs text-[#9df4d7]">{key}</span>
              <span className="text-sm font-bold text-white">{gate.label}</span>
            </div>
            <p className="mt-2 text-xs leading-6 text-slate-500">{gate.businessMeaning}</p>
            <div className="mt-2 text-[11px] font-semibold text-slate-400">安全线：{gate.safeRule}</div>
          </div>
        ),
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
        运行分析后，这里会按“业务解释 / HFCD 变量 / 修复方案”三层展示每个样本。
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
              <span className="rounded-full bg-white/8 px-3 py-1 text-xs font-bold text-slate-300">risk {result.risk_score}</span>
            </div>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">业务解释</div>
              <p className="mt-3 text-sm leading-7 text-slate-300">{result.readable.businessSummary}</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">HFCD 变量</div>
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
  const [activeProjectId, setActiveProjectId] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [apiTestResult, setApiTestResult] = useState<string | null>(null);

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
    } catch {
      setReports([]);
      const fallbackProject = createDefaultProject();
      setProjects([fallbackProject]);
      setActiveProjectId(fallbackProject.id);
      setDatasets([]);
      setApiKeys([]);
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

  const validation = useMemo(() => validateRows(rows, industry), [industry, rows]);
  const summary = useMemo(() => summarizeAudit(results), [results]);
  const blindMetrics = useMemo(() => validateBlindMetrics(results), [results]);
  const blindSplits = useMemo(() => splitBlindSets(results), [results]);
  const flatResults = useMemo(() => results.map(flattenAuditResult), [results]);
  const markdownReport = useMemo(
    () => generateMarkdownReport({ projectName, industry, results }),
    [projectName, industry, results],
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
    if (!validation.isValid) {
      setUploadError(validation.missingRequired.length ? `缺少必填字段：${validation.missingRequired.join(', ')}` : '请先上传 CSV 数据。');
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
    setActiveTab('upload');
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
  -d '{"model":"hfcd-v1","industry":"quantum","rows":[{"sample_id":"qpu_cal_001","T1_us":82,"T2_us":71,"gate2q_error":0.009,"assignment_fidelity":0.94,"job_success_rate":0.94}]}'`;

  const handleTestApiCall = async () => {
    setApiTestResult('调用中...');
    const rowsForApi = rows.length ? rows : parseCsv(templateToCsv(industry));
    try {
      const response = await fetch('/api/hfcd/audit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKeys[0]?.key ? { 'x-api-key': apiKeys[0].key } : {}),
        },
        body: JSON.stringify({ model: 'hfcd-v1', industry, rows: rowsForApi }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || 'API call failed.');
      setApiTestResult(`调用成功：${payload.summary.sampleCount} 个样本，${payload.summary.highRiskCount} 个高风险。`);
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

  const renderResultsTable = (tableResults: HFCDAuditResult[]) => {
    if (!tableResults.length) {
      return <div className="rounded-[24px] border border-white/8 bg-black/10 p-6 text-sm text-slate-500">还没有分析结果。上传 CSV 后点击“运行 HFCD 分析”。</div>;
    }
    return (
      <div className="overflow-x-auto rounded-[24px] border border-white/8">
        <table className="min-w-[1180px] w-full border-collapse text-left text-sm">
          <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-4 py-3">sample</th>
              {gateLabels.map((gate) => (
                <th key={gate} className="px-4 py-3">{gate}</th>
              ))}
              <th className="px-4 py-3">strict</th>
              <th className="px-4 py-3">loose</th>
              <th className="px-4 py-3">FailureMode</th>
              <th className="px-4 py-3">risk</th>
            </tr>
          </thead>
          <tbody>
            {tableResults.slice(0, 80).map((result) => (
              <tr key={result.sample_id} className="border-t border-white/8 text-slate-300">
                <td className="px-4 py-3 font-semibold text-white">{result.sample_id}</td>
                {gateLabels.map((gate) => (
                  <td key={gate} className="px-4 py-3 font-mono text-xs">{result.gates[gate]}</td>
                ))}
                <td className="px-4 py-3">{result.strict_stable ? 'yes' : 'no'}</td>
                <td className="px-4 py-3">{result.loose_stable ? 'yes' : 'no'}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${result.failure_mode === 'stable' ? 'bg-[#52DBA9]/14 text-[#9df4d7]' : 'bg-amber-500/12 text-amber-200'}`}>
                    {result.failure_mode}
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
                HFCD Stability-Window Audit
              </div>
              <h1 className="mt-5 text-4xl font-black tracking-tight text-white md:text-5xl">HFCD 稳定窗审计系统</h1>
              <p className="mt-4 max-w-4xl text-base leading-8 text-slate-300 md:text-lg">
                上传行业数据，系统自动映射 Q 核、能量、腔体、核心峰值、半径局域、显化门与缓冲七个稳定门，识别稳定窗、失效模式、风险样本，并输出研发修复方案。
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  onClick={() => setActiveTab('upload')}
                  className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
                >
                  进入数据上传
                </button>
                <button
                  onClick={() => setActiveTab('templates')}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/[0.08]"
                >
                  下载行业模板
                </button>
                <button
                  onClick={handleCreateProject}
                  className="rounded-full border border-[#52DBA9]/20 bg-[#52DBA9]/10 px-5 py-3 text-sm font-semibold text-[#9df4d7] transition-colors hover:bg-[#52DBA9]/16"
                >
                  创建项目空间
                </button>
              </div>
            </div>
            <div className="rounded-[28px] border border-white/8 bg-black/15 p-5">
              <div className="text-xs font-bold uppercase tracking-[0.24em] text-slate-500">运行边界</div>
              <p className="mt-3 text-sm leading-7 text-slate-300">
                第一阶段运行的是 HFCD Audit Engine，不是完整 V12.x 场仿真。它先把客户数据转成稳定窗审计结果；深度客户再进入 Simulation Mode。
              </p>
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
            <SectionTitle title="产业智能仪表盘" description="把 HFCD 作为 longone.ai 的产业智能入口：先快速审计，再用盲测验证商业价值，最后进入深度仿真合作。" />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="已分析项目数" value={dashboardStats.projectCount} note="本机报告中心记录的项目数。" />
              <MetricCard label="总样本数" value={dashboardStats.sampleCount} note="所有报告累计样本。" />
              <MetricCard label="strict stable" value={dashboardStats.strictStableCount} note="七门全部通过的样本。" />
              <MetricCard label="高风险样本" value={dashboardStats.highRiskCount} note="risk_score >= 0.43。" />
            </div>
            <div className="mt-8 grid gap-5 lg:grid-cols-2">
              {(Object.keys(HFCD_INDUSTRIES) as HFCDIndustry[]).map((item) => (
                <IndustryCard
                  key={item}
                  industry={item}
                  onAnalyze={() => {
                    setIndustry(item);
                    setActiveTab('upload');
                  }}
                  onDownload={() => handleDownloadTemplate(item)}
                />
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === 'upload' ? (
          <section className="mt-8">
            <SectionTitle title="数据上传与 HFCD 分析" description="选择行业、上传 CSV、检查字段完整性，然后运行七门稳定窗审计。第一期重点是可演示、可下载、可交付。" />
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
                  <MetricCard label="strict" value={summary.strictStableCount} note="七门全通过。" />
                  <MetricCard label="loose" value={summary.looseStableCount} note="核心四门通过。" />
                  <MetricCard label="高风险" value={summary.highRiskCount} note="风险分进入高位。" />
                </div>

                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-black tracking-tight text-white">结果表</h3>
                      <p className="mt-1 text-sm text-slate-500">先看样本诊断，再看变量明细。结果按“业务解释 / HFCD 变量 / 修复方案”三层输出。</p>
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
            <SectionTitle title="报告中心" description="报告中心已经进入咨询交付形态：趋势对比、风险热图、Gate 安全统计、FailureMode 分布、HTML 与打印/PDF 都在这里完成。" />
            <div className="mb-5 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black text-white">多轮报告对比</h3>
                  <p className="mt-1 text-sm text-slate-500">当前项目空间：{activeProject?.name || '未选择'}。按时间线追踪 strict stable、高风险样本和平均风险分。</p>
                </div>
                <button onClick={() => setActiveTab('projects')} className="rounded-full border border-[#52DBA9]/20 bg-[#52DBA9]/10 px-4 py-2 text-xs font-semibold text-[#9df4d7]">进入项目空间</button>
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                {activeProjectReports.slice(0, 6).map((report) => {
                  const reportSummary = summarizeAudit(report.results);
                  return (
                    <div key={report.id} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                      <div className="truncate text-sm font-bold text-white">{report.projectName}</div>
                      <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">{formatDate(report.createdAt)}</div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                        <div><div className="text-lg font-black text-[#9df4d7]">{reportSummary.strictStableCount}</div><div className="text-slate-500">strict</div></div>
                        <div><div className="text-lg font-black text-red-200">{reportSummary.highRiskCount}</div><div className="text-slate-500">risk</div></div>
                        <div><div className="text-lg font-black text-white">{reportSummary.averageRiskScore}</div><div className="text-slate-500">avg</div></div>
                      </div>
                    </div>
                  );
                })}
                {!activeProjectReports.length ? <div className="rounded-2xl border border-white/8 bg-black/10 p-4 text-sm text-slate-500">当前项目还没有历史报告。</div> : null}
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
                      <MetricCard label="strict" value={reportSummary.strictStableCount} note="严格稳定。" />
                      <MetricCard label="高风险" value={reportSummary.highRiskCount} note="风险窗口。" />
                      <MetricCard label="主失效" value={<span className="text-xl">{compactFailureMode(reportSummary.primaryFailureMode)}</span>} note="非 stable 第一病灶。" />
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
            <SectionTitle title="盲测验证" description="上传带 actual_failure=0/1、可选 baseline_score、可选 lead_time_days 的历史数据后，系统自动计算 HFCD 相对 baseline 的排序能力、Top 风险命中率和提前预警窗口。" />
            <div className="grid gap-4 md:grid-cols-4">
              <MetricCard label="标签状态" value={blindMetrics.hasActualFailure ? '已检测' : '未提供'} note="CSV 是否包含 actual_failure。" />
              <MetricCard label="AUC" value={blindMetrics.auc ?? 'N/A'} note="风险分对真实失效排序能力。" />
              <MetricCard label="precision@top10%" value={blindMetrics.precisionTop10 ?? 'N/A'} note="Top risk 样本命中率。" />
              <MetricCard label="高风险数" value={blindMetrics.highRiskCount} note="当前结果中高风险样本。" />
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-4">
              <MetricCard label="baseline AUC" value={blindMetrics.baselineAuc ?? 'N/A'} note="如 CSV 提供 baseline_score，则自动对比。" />
              <MetricCard label="baseline top10" value={blindMetrics.baselinePrecisionTop10 ?? 'N/A'} note="客户现有模型 Top 风险命中率。" />
              <MetricCard label="HFCD lift" value={blindMetrics.precisionLift ?? 'N/A'} note="HFCD precision@top10% 减 baseline。" />
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
              <div className="mt-5">{renderResultsTable([...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 20))}</div>
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
                          <div className="mt-2 text-xs text-slate-500">strict {reportSummary.strictStableCount}/{reportSummary.sampleCount} · high risk {reportSummary.highRiskCount} · avg {reportSummary.averageRiskScore}</div>
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
            <SectionTitle title="API 商业版" description="HFCD API 面向企业系统集成：API Key、调用台账、模型名称、行业参数版本、异步报告设计和结果回调口径已经就位。" />
            <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
              <div className="space-y-5">
                <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="text-xl font-black text-white">API Key</h3>
                  <p className="mt-2 text-sm leading-7 text-slate-400">前端生成本地商用台账；生产环境可在 Worker 配置 `HFCD_API_KEYS` 后启用服务端校验。</p>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <button onClick={handleGenerateApiKey} className="rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b]">
                      生成 API Key
                    </button>
                    <button onClick={handleTestApiCall} className="rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-slate-200">
                      测试调用
                    </button>
                  </div>
                  {apiTestResult ? <div className="mt-3 rounded-2xl border border-white/8 bg-black/10 px-4 py-3 text-sm text-slate-300">{apiTestResult}</div> : null}
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
                    <div>模型名称：<span className="font-mono text-[#9df4d7]">hfcd-v1</span></div>
                    <div>行业参数版本：<span className="font-mono text-[#9df4d7]">quantum/materials/energy/bio@v1.2-core</span></div>
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
                      ['summary', '样本数、strict/loose、高风险数、主 FailureMode。'],
                      ['gateSafety', '七门 safe/fail 统计，可直接画图。'],
                      ['blindMetrics', 'AUC、precision@top10%、baseline 对比、提前预警。'],
                      ['results', '每个样本的 gates、gate_status、risk_score、readable diagnosis。'],
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
                    当前 API 已支持同步审计；商业版异步流程为：提交数据 → 返回 job_id → Worker 后台生成 Markdown/HTML/PDF-ready 报告 → callback_url 推送结果 → 调用次数计入企业账单。
                  </p>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === 'knowledge' ? (
          <section className="mt-8">
            <SectionTitle title="HFCD 知识库" description="把内部 V12.x 规则沉淀成客户看得懂的 FailureMode 字典。系统不是黑箱分类器，而是有物理机制和研发动作的诊断引擎。" />
            <div className="mb-8 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-4 text-xl font-black tracking-tight text-white">七门稳定窗</h3>
              <GateLegendPanel />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {(Object.keys(FAILURE_MODE_LABELS) as HFCDFailureMode[]).map((mode) => (
                <div key={mode} className="rounded-[26px] border border-white/8 bg-white/[0.03] p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#52DBA9]/16 bg-[#52DBA9]/10 text-[#9df4d7]">
                      <Gauge className="h-4 w-4" />
                    </div>
                    <h3 className="text-xl font-black text-white">{mode}</h3>
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
                  ['快速审计模式', '默认 SaaS 模式：上传历史实验/生产/寿命/批次数据，输出风险评分、FailureMode、稳定窗、修复建议和报告。'],
                  ['冻结参数盲测模式', '客户提供历史数据和 actual_failure 标签，系统冻结 HFCD 参数并输出 AUC、precision@top10% 和提前预警能力。'],
                  ['深度仿真模式', '高级合作模式：输入物理参数、工艺参数、边界条件和数字孪生空间，生成候选研发路线。'],
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
