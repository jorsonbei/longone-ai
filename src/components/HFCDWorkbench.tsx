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
  HFCD_INDUSTRIES,
  HFCDIndustry,
  HFCDAuditResult,
  HFCDFailureMode,
  parseCsv,
  summarizeAudit,
  templateToCsv,
  toCsv,
  validateBlindMetrics,
  validateRows,
} from '../lib/hfcdCore';

type WorkbenchTab = 'dashboard' | 'upload' | 'templates' | 'reports' | 'blind' | 'knowledge';

interface HFCDReportRecord {
  id: string;
  projectName: string;
  industry: HFCDIndustry;
  createdAt: number;
  fileName: string;
  results: HFCDAuditResult[];
}

const REPORT_STORAGE_KEY = 'hfcdAuditReportsV1';

const TABS: Array<{ id: WorkbenchTab; label: string; icon: React.ElementType }> = [
  { id: 'dashboard', label: '仪表盘', icon: BarChart3 },
  { id: 'upload', label: '数据上传', icon: Upload },
  { id: 'templates', label: '模板中心', icon: FileDown },
  { id: 'reports', label: '报告中心', icon: FileText },
  { id: 'blind', label: '盲测验证', icon: ShieldAlert },
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

export function HFCDWorkbench() {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('dashboard');
  const [industry, setIndustry] = useState<HFCDIndustry>('quantum');
  const [projectName, setProjectName] = useState('HFCD 稳定窗审计项目');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [results, setResults] = useState<HFCDAuditResult[]>([]);
  const [reports, setReports] = useState<HFCDReportRecord[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(REPORT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as HFCDReportRecord[];
        setReports(Array.isArray(parsed) ? parsed : []);
      }
    } catch {
      setReports([]);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(reports.slice(0, 40)));
    } catch {
      // Report history is an enhancement; audit execution should never fail because storage is full.
    }
  }, [reports]);

  const validation = useMemo(() => validateRows(rows, industry), [industry, rows]);
  const summary = useMemo(() => summarizeAudit(results), [results]);
  const blindMetrics = useMemo(() => validateBlindMetrics(results), [results]);
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
      projectCount: new Set(reports.map((report) => report.projectName)).size,
      ...allSummary,
    };
  }, [reports]);

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
    const report: HFCDReportRecord = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      projectName,
      industry,
      fileName,
      createdAt: Date.now(),
      results: nextResults,
    };
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
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${projectName}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7;padding:40px;color:#111827}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d5db;padding:8px;text-align:left}code{background:#f3f4f6;padding:2px 4px;border-radius:4px}</style></head><body><pre>${markdownReport.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`;
    downloadText(`${projectName || 'hfcd_audit'}_report.html`, html, 'text/html;charset=utf-8');
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
                  {uploadError ? <div className="mt-4 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{uploadError}</div> : null}
                  <button
                    onClick={handleRunAudit}
                    className="mt-5 w-full rounded-full bg-[#52DBA9] px-5 py-3 text-sm font-bold text-[#10131b] transition-colors hover:bg-[#67e5b7]"
                  >
                    运行 HFCD 分析
                  </button>
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
                      <p className="mt-1 text-sm text-slate-500">输出 HFCD 七门、Gate、strict/loose、FailureMode、risk_score 和 repair_plan。</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button disabled={!results.length} onClick={downloadCurrentCsv} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">下载 CSV</button>
                      <button disabled={!results.length} onClick={downloadCurrentMarkdown} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">下载 Markdown</button>
                      <button disabled={!results.length} onClick={downloadCurrentHtml} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">下载 HTML</button>
                    </div>
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
                                <span className="text-slate-600">{key}: </span>{value}
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
                      {spec.fields.map((field) => (
                        <div key={field.key} className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-[#9df4d7]">{field.key}</span>
                            {field.required ? <span className="rounded-full bg-red-500/12 px-2 py-0.5 text-[10px] font-bold text-red-200">required</span> : null}
                          </div>
                          <p className="mt-1 text-xs leading-6 text-slate-500">{field.description}</p>
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
            <SectionTitle title="报告中心" description="第一期先保存在本机浏览器，适合演示闭环；后续企业空间版再接 Firestore/账号权限和多项目长期趋势。" />
            <div className="space-y-4">
              {reports.length ? reports.map((report) => {
                const reportSummary = summarizeAudit(report.results);
                const reportMarkdown = generateMarkdownReport({ projectName: report.projectName, industry: report.industry, results: report.results });
                return (
                  <div key={report.id} className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="text-xl font-black text-white">{report.projectName}</div>
                        <div className="mt-2 text-xs uppercase tracking-[0.2em] text-slate-500">{HFCD_INDUSTRIES[report.industry].title} · {formatDate(report.createdAt)} · {report.fileName}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => downloadText(`${report.projectName}_report.md`, reportMarkdown, 'text/markdown;charset=utf-8')} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200">Markdown</button>
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
                  </div>
                );
              }) : <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-8 text-sm text-slate-500">还没有报告。先进入“数据上传”跑一次 HFCD 分析。</div>}
            </div>
          </section>
        ) : null}

        {activeTab === 'blind' ? (
          <section className="mt-8">
            <SectionTitle title="盲测验证" description="上传带 actual_failure=0/1 的历史数据后，HFCD 自动输出 AUC、precision@top10% 和高风险样本命中情况。这是商业合作里证明价值的关键页。" />
            <div className="grid gap-4 md:grid-cols-4">
              <MetricCard label="标签状态" value={blindMetrics.hasActualFailure ? '已检测' : '未提供'} note="CSV 是否包含 actual_failure。" />
              <MetricCard label="AUC" value={blindMetrics.auc ?? 'N/A'} note="风险分对真实失效排序能力。" />
              <MetricCard label="precision@top10%" value={blindMetrics.precisionTop10 ?? 'N/A'} note="Top risk 样本命中率。" />
              <MetricCard label="高风险数" value={blindMetrics.highRiskCount} note="当前结果中高风险样本。" />
            </div>
            <div className="mt-6 rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
              <h3 className="text-xl font-black text-white">验证口径</h3>
              <p className="mt-3 text-sm leading-8 text-slate-400">
                先冻结 HFCD 参数，再对 blind set 预测，最后计算 AUC / precision@top10%。这一页不训练模型，不回看标签调参，避免把商业验证做成自证循环。
              </p>
              <div className="mt-5">{renderResultsTable([...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 20))}</div>
            </div>
          </section>
        ) : null}

        {activeTab === 'knowledge' ? (
          <section className="mt-8">
            <SectionTitle title="HFCD 知识库" description="把内部 V12.x 规则沉淀成客户看得懂的 FailureMode 字典。系统不是黑箱分类器，而是有物理机制和研发动作的诊断引擎。" />
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
