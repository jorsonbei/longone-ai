import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AssetClass = 'gold_etf' | 'futures' | 'crypto' | 'equity_etf';
type Side = 1 | -1;

type MarketRow = {
  ts: string;
  close: number;
  volume: number;
};

type EntryTrade = {
  asset_class: AssetClass;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  score: number;
  q_core: number;
  delta_sigma: number;
  c_cavity: number;
  pi_coherence: number;
  sigma_ledger: number;
  eta_freedom: number;
  b_sigma: number;
  r_radius: number;
  tau_time: number;
  omega_coupling: number;
  freshness: number;
  pnl_usd: number;
  exit_reason: string;
};

type RuntimeProperty = {
  q_core: number;
  delta_sigma: number;
  c_cavity: number;
  pi_coherence: number;
  sigma_ledger: number;
  eta_freedom: number;
  b_sigma: number;
  r_radius: number;
  tau_time: number;
  omega_coupling: number;
  freshness: number;
  q_error: number;
  structure_score: number;
  sustain_score: number;
};

type Policy = {
  name: string;
  b_max: number;
  c_min: number;
  q_tolerance: number;
  delta_floor: number;
  profit_lock: number;
  max_hold: Record<AssetClass, number>;
  disaster_stop: Record<AssetClass, number>;
};

type ReplayTrade = EntryTrade & {
  policy: string;
  entry: number;
  exit: number;
  exit_ts: string;
  hold_bars: number;
  dynamic_exit_reason: string;
  dynamic_pnl_usd: number;
  dynamic_correct: boolean;
  final_sustain_score: number;
  final_q_error: number;
  final_b_sigma: number;
  final_c_cavity: number;
};

const VERSION = 'HFCD_Trading_V1_8_DynamicDecoherenceExit';
const ROOT = process.cwd();
const V17_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_7_tnpap_cascade');
const DATA_DIR = path.join(V17_DIR, 'market_data');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_8_dynamic_decoherence_exit');
const ENTRY_FILE = path.join(V17_DIR, 'hfcd_trading_v1_7_property_samples.csv');
const NOTIONAL = 10_000;
const FEE = 0.0014;

const SYMBOL_FILES: Record<string, string> = {
  GLD: 'GLD.csv',
  IAU: 'IAU.csv',
  'GC=F': 'GC_F.csv',
  'CL=F': 'CL_F.csv',
  'BTC-USD': 'BTC_USD.csv',
  'ETH-USD': 'ETH_USD.csv',
  SPY: 'SPY.csv',
  QQQ: 'QQQ.csv',
};

const POLICIES: Policy[] = [
  {
    name: 'dynamic_soft',
    b_max: 0.90,
    c_min: 0.24,
    q_tolerance: 0.42,
    delta_floor: 0.28,
    profit_lock: 0.018,
    max_hold: { gold_etf: 36, futures: 36, crypto: 36, equity_etf: 18 },
    disaster_stop: { gold_etf: 0.038, futures: 0.060, crypto: 0.070, equity_etf: 0.032 },
  },
  {
    name: 'dynamic_mid',
    b_max: 0.84,
    c_min: 0.30,
    q_tolerance: 0.34,
    delta_floor: 0.34,
    profit_lock: 0.012,
    max_hold: { gold_etf: 30, futures: 30, crypto: 30, equity_etf: 16 },
    disaster_stop: { gold_etf: 0.032, futures: 0.052, crypto: 0.060, equity_etf: 0.027 },
  },
  {
    name: 'dynamic_hard',
    b_max: 0.78,
    c_min: 0.36,
    q_tolerance: 0.28,
    delta_floor: 0.40,
    profit_lock: 0.008,
    max_hold: { gold_etf: 24, futures: 24, crypto: 24, equity_etf: 12 },
    disaster_stop: { gold_etf: 0.026, futures: 0.045, crypto: 0.050, equity_etf: 0.023 },
  },
];

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))].join('\n') + '\n';
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.replace(/^"|"$/g, ''));
}

function parseRows<T extends Record<string, unknown>>(text: string, map: (row: Record<string, string>) => T): T[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() || '');
  return lines.filter(Boolean).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] || '';
    });
    return map(row);
  });
}

function parseMarket(text: string): MarketRow[] {
  return parseRows(text, (row) => ({
    ts: row.ts,
    close: Number(row.close),
    volume: Number(row.volume || 0),
  })).filter((row) => row.ts && Number.isFinite(row.close) && row.close > 0);
}

function parseEntries(text: string): EntryTrade[] {
  return parseRows(text, (row) => ({
    asset_class: row.asset_class as AssetClass,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    entry_ts: row.entry_ts,
    score: Number(row.score),
    q_core: Number(row.q_core),
    delta_sigma: Number(row.delta_sigma),
    c_cavity: Number(row.c_cavity),
    pi_coherence: Number(row.pi_coherence),
    sigma_ledger: Number(row.sigma_ledger),
    eta_freedom: Number(row.eta_freedom),
    b_sigma: Number(row.b_sigma),
    r_radius: Number(row.r_radius),
    tau_time: Number(row.tau_time),
    omega_coupling: Number(row.omega_coupling),
    freshness: Number(row.freshness),
    pnl_usd: Number(row.pnl_usd),
    exit_reason: row.exit_reason,
  })).filter((row) => row.symbol && row.entry_ts && Number.isFinite(row.pnl_usd));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function pct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function latestIndex(rows: MarketRow[], ts: string) {
  const target = new Date(ts).getTime();
  let lo = 0;
  let hi = rows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = new Date(rows[mid].ts).getTime();
    if (t <= target) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function ret(rows: MarketRow[], index: number, lag: number) {
  const base = rows[index - lag]?.close;
  return base ? rows[index].close / base - 1 : 0;
}

function rollingReturns(rows: MarketRow[], index: number, lookback: number) {
  return rows
    .slice(Math.max(1, index - lookback), index + 1)
    .map((row, rowIndex, arr) => (rowIndex === 0 ? 0 : row.close / arr[rowIndex - 1].close - 1))
    .slice(1);
}

function stats(rows: MarketRow[], index: number) {
  const rets = rollingReturns(rows, index, 168);
  const vol = Math.max(std(rets), 0.0008);
  const r1 = ret(rows, index, 1);
  const r6 = ret(rows, index, 6);
  const r24 = ret(rows, index, 24);
  const r72 = ret(rows, index, 72);
  const r168 = ret(rows, index, 168);
  const ma72 = mean(rows.slice(Math.max(0, index - 72), index + 1).map((row) => row.close));
  const z72 = ma72 > 0 ? (rows[index].close / ma72 - 1) / vol : 0;
  const volumeWindow = rows.slice(Math.max(0, index - 168), index + 1).map((row) => row.volume || 0).filter((v) => v > 0);
  const volumeZ = volumeWindow.length > 10 ? ((rows[index].volume || 0) - mean(volumeWindow)) / Math.max(std(volumeWindow), 1) : 0;
  return { vol, r1, r6, r24, r72, r168, z72, volumeZ, radius: Math.abs(r1) / vol };
}

function runtimeProperty(entry: EntryTrade, rows: MarketRow[], index: number, side: Side): RuntimeProperty {
  const s = stats(rows, index);
  const trendAligned = [s.r6, s.r24, s.r168].filter((x) => side * x > 0).length;
  const trendAgreement = trendAligned / 3;
  const qCore = clamp(0.18 + trendAgreement * 0.46 + (side * s.r72 > 0 ? 0.12 : 0), 0, 1);
  const cCavity = clamp(0.30 + sigmoid(s.volumeZ) * 0.28 - Math.max(0, s.vol - 0.018) * 6 + entry.freshness * 0.20, 0, 1);
  const rRadius = clamp(sigmoid((s.radius - 2.5) / 1.4), 0, 1);
  const etaFreedom = clamp(sigmoid((s.vol - 0.011) * 95 + Math.abs(s.z72) * 0.12 + Math.abs(s.r1) * 38), 0, 1);
  const piCoherence = clamp(sigmoid(side * (s.r6 * 8 + s.r24 * 12 + s.r72 * 6) + trendAgreement - 0.55), 0, 1);
  const adverseImpulse = clamp(sigmoid(-side * s.r6 * 22 + Math.abs(s.r1) * 28 - 0.35), 0, 1);
  const bSigma = clamp(Math.max(entry.b_sigma * 0.82, etaFreedom * 0.34 + rRadius * 0.32 + adverseImpulse * 0.24), 0, 1);
  const sigmaLedger = clamp(entry.sigma_ledger * 0.70 + piCoherence * 0.18 + sigmoid(s.volumeZ) * 0.12, 0, 1);
  const deltaSigma = clamp(entry.delta_sigma * 0.74 + sigmoid(side * (s.r24 - s.r168) * 12) * 0.16 + piCoherence * 0.10, 0, 1);
  const tauTime = clamp(entry.tau_time * 0.72 + sigmoid(side * (s.r6 - s.r72) * 8) * 0.20 + piCoherence * 0.08, 0, 1);
  const omegaCoupling = clamp(entry.omega_coupling * 0.68 + piCoherence * 0.18 + sigmaLedger * 0.14, 0, 1);
  const qError = clamp(entry.q_core - qCore, 0, 1);
  const structureScore = clamp(
    qCore * 0.20 +
      deltaSigma * 0.20 +
      cCavity * 0.18 +
      piCoherence * 0.15 +
      sigmaLedger * 0.10 +
      (1 - etaFreedom) * 0.06 +
      (1 - bSigma) * 0.06 +
      (1 - rRadius) * 0.05,
    0,
    1,
  );
  const sustainScore = clamp((1 - bSigma) * (cCavity / 0.30) * (deltaSigma >= 0.30 ? 1 : -1) * Math.exp(-qError * 2.2), -2, 2);
  return {
    q_core: qCore,
    delta_sigma: deltaSigma,
    c_cavity: cCavity,
    pi_coherence: piCoherence,
    sigma_ledger: sigmaLedger,
    eta_freedom: etaFreedom,
    b_sigma: bSigma,
    r_radius: rRadius,
    tau_time: tauTime,
    omega_coupling: omegaCoupling,
    freshness: entry.freshness,
    q_error: qError,
    structure_score: structureScore,
    sustain_score: sustainScore,
  };
}

function replayOne(entry: EntryTrade, rows: MarketRow[], policy: Policy): ReplayTrade | null {
  const entryIndex = latestIndex(rows, entry.entry_ts);
  if (entryIndex < 220 || entryIndex >= rows.length - 2) return null;
  const side: Side = entry.side === 'long' ? 1 : -1;
  const entryPrice = rows[entryIndex].close;
  const maxHold = policy.max_hold[entry.asset_class];
  const disasterStop = policy.disaster_stop[entry.asset_class];
  let exitIndex = Math.min(rows.length - 1, entryIndex + maxHold);
  let exitReason = '最大持有期';
  let finalProp = runtimeProperty(entry, rows, exitIndex, side);

  for (let i = entryIndex + 1; i <= Math.min(rows.length - 1, entryIndex + maxHold); i += 1) {
    const prop = runtimeProperty(entry, rows, i, side);
    const directional = side * (rows[i].close / entryPrice - 1);
    const bHot = prop.b_sigma >= policy.b_max && (prop.r_radius >= 0.58 || prop.eta_freedom >= 0.70);
    const cDry = prop.c_cavity <= policy.c_min;
    const qBroken = prop.q_error >= policy.q_tolerance && prop.structure_score < 0.45;
    const deltaExhausted = directional >= policy.profit_lock && prop.delta_sigma <= policy.delta_floor && prop.pi_coherence < 0.50;
    const sustainBroken = prop.sustain_score <= 0;
    if (directional <= -disasterStop) {
      exitIndex = i;
      exitReason = '灾难级亏损保护';
      finalProp = prop;
      break;
    }
    if (bHot) {
      exitIndex = i;
      exitReason = 'Bσ黑子熔断';
      finalProp = prop;
      break;
    }
    if (cDry) {
      exitIndex = i;
      exitReason = 'C腔干涸';
      finalProp = prop;
      break;
    }
    if (qBroken) {
      exitIndex = i;
      exitReason = 'Q核背离';
      finalProp = prop;
      break;
    }
    if (deltaExhausted) {
      exitIndex = i;
      exitReason = 'DeltaSigma势差释尽';
      finalProp = prop;
      break;
    }
    if (i - entryIndex >= 4 && sustainBroken && prop.structure_score < 0.40) {
      exitIndex = i;
      exitReason = '物性退相干';
      finalProp = prop;
      break;
    }
    finalProp = prop;
  }

  const raw = rows[exitIndex].close / entryPrice - 1;
  const directional = side * raw;
  const net = directional - FEE;
  return {
    ...entry,
    policy: policy.name,
    entry: entryPrice,
    exit: rows[exitIndex].close,
    exit_ts: rows[exitIndex].ts,
    hold_bars: exitIndex - entryIndex,
    dynamic_exit_reason: exitReason,
    dynamic_pnl_usd: net * NOTIONAL,
    dynamic_correct: directional > 0,
    final_sustain_score: finalProp.sustain_score,
    final_q_error: finalProp.q_error,
    final_b_sigma: finalProp.b_sigma,
    final_c_cavity: finalProp.c_cavity,
  };
}

function summarize(rows: ReplayTrade[], pnlKey: 'pnl_usd' | 'dynamic_pnl_usd') {
  const pnl = rows.map((row) => Number(row[pnlKey]));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const grossWin = pnl.filter((x) => x > 0).reduce((sum, x) => sum + x, 0);
  const grossLoss = Math.abs(pnl.filter((x) => x < 0).reduce((sum, x) => sum + x, 0));
  return {
    trades: rows.length,
    win_rate: rows.length ? pnl.filter((x) => x > 0).length / rows.length : 0,
    net_pnl_usd: pnl.reduce((sum, x) => sum + x, 0),
    max_drawdown_usd: maxDrawdown,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
  };
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return groups;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const entries = parseEntries(await readFile(ENTRY_FILE, 'utf8'));
  const market = new Map<string, MarketRow[]>();
  for (const [symbol, file] of Object.entries(SYMBOL_FILES)) {
    market.set(symbol, parseMarket(await readFile(path.join(DATA_DIR, file), 'utf8')));
  }

  const replayRows: ReplayTrade[] = [];
  for (const policy of POLICIES) {
    for (const entry of entries) {
      const rows = market.get(entry.symbol);
      if (!rows) continue;
      const replay = replayOne(entry, rows, policy);
      if (replay) replayRows.push(replay);
    }
  }

  const summaryRows: Record<string, unknown>[] = [];
  const exitRows: Record<string, unknown>[] = [];
  for (const [key, rows] of groupBy(replayRows, (row) => `${row.policy}|${row.asset_class}`)) {
    const [policy, assetClass] = key.split('|');
    const baseline = summarize(rows, 'pnl_usd');
    const dynamic = summarize(rows, 'dynamic_pnl_usd');
    summaryRows.push({
      policy,
      asset_class: assetClass,
      trades: rows.length,
      baseline_win_rate: baseline.win_rate,
      baseline_net_pnl_usd: baseline.net_pnl_usd,
      baseline_profit_factor: baseline.profit_factor,
      dynamic_win_rate: dynamic.win_rate,
      dynamic_net_pnl_usd: dynamic.net_pnl_usd,
      dynamic_profit_factor: dynamic.profit_factor,
      dynamic_max_drawdown_usd: dynamic.max_drawdown_usd,
      pnl_delta_usd: dynamic.net_pnl_usd - baseline.net_pnl_usd,
      status:
        dynamic.net_pnl_usd > baseline.net_pnl_usd && dynamic.net_pnl_usd > 0 && dynamic.profit_factor >= 1.12
          ? 'dynamic_exit_pass'
          : dynamic.net_pnl_usd > baseline.net_pnl_usd
            ? 'improved_but_not_pass'
            : 'regressed',
    });
  }
  for (const [key, rows] of groupBy(replayRows, (row) => `${row.policy}|${row.asset_class}|${row.dynamic_exit_reason}`)) {
    const [policy, assetClass, reason] = key.split('|');
    const dynamic = summarize(rows, 'dynamic_pnl_usd');
    exitRows.push({
      policy,
      asset_class: assetClass,
      dynamic_exit_reason: reason,
      count: rows.length,
      net_pnl_usd: dynamic.net_pnl_usd,
      win_rate: dynamic.win_rate,
      profit_factor: dynamic.profit_factor,
    });
  }

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_8_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_8_exit_reasons.csv'), toCsv(exitRows));
  await writeFile(
    path.join(OUT_DIR, 'hfcd_trading_v1_8_replay_trades.csv'),
    toCsv(
      replayRows.map((row) => ({
        policy: row.policy,
        asset_class: row.asset_class,
        symbol: row.symbol,
        side: row.side,
        entry_ts: row.entry_ts,
        exit_ts: row.exit_ts,
        hold_bars: row.hold_bars,
        baseline_exit_reason: row.exit_reason,
        dynamic_exit_reason: row.dynamic_exit_reason,
        baseline_pnl_usd: row.pnl_usd,
        dynamic_pnl_usd: row.dynamic_pnl_usd,
        score: row.score,
        final_sustain_score: row.final_sustain_score,
        final_q_error: row.final_q_error,
        final_b_sigma: row.final_b_sigma,
        final_c_cavity: row.final_c_cavity,
      })),
    ),
  );
  const bestRows = [...summaryRows].sort((a, b) => Number(b.pnl_delta_usd) - Number(a.pnl_delta_usd));
  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_replay_only_not_deployed',
    source: 'V1.7 entry samples; same entry set, dynamic exit replay',
    policies: POLICIES.map((policy) => policy.name),
    summary: summaryRows,
    best_by_delta: bestRows.slice(0, 8),
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_8_summary.json'), JSON.stringify(summary, null, 2));

  const md = `# ${VERSION}

## 目标

本轮不重新挑选入场点，而是读取 V1.7 的实际入场样本，比较固定止损/止盈/持有期与动态物性退场。

## 动态退场门

- Bσ黑子熔断：杠杆、噪声、半径共同过热时退出。
- C腔干涸：流动性腔体跌破安全阈值时退出。
- DeltaSigma势差释尽：有盈利但核心势差和相干性衰退时止盈。
- Q核背离：当前结构相对入场 Q 核明显退化时退出。
- 灾难级亏损保护：只作为极端保护，不作为普通固定止损。

## 结果

| 策略 | 资产类 | 交易数 | V1.7净收益 | 动态净收益 | 增量 | 动态胜率 | 动态PF | 状态 |
|---|---|---:|---:|---:|---:|---:|---:|---|
${summaryRows
  .map(
    (row) =>
      `| ${row.policy} | ${row.asset_class} | ${row.trades} | $${Number(row.baseline_net_pnl_usd).toFixed(0)} | $${Number(row.dynamic_net_pnl_usd).toFixed(0)} | $${Number(row.pnl_delta_usd).toFixed(0)} | ${pct(Number(row.dynamic_win_rate))} | ${Number(row.dynamic_profit_factor).toFixed(2)} | ${row.status} |`,
  )
  .join('\n')}

## 判断

如果动态退场提升明显，说明亏损源确实来自固定价格止损。如果动态退场退化，说明当前 10 维物性的实时更新公式仍不足以判断退出，需要先补真实盘口深度、链上净流入、完整期限结构和事件源。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_8_DynamicDecoherenceExit.md'), md);
  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
