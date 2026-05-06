import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AssetClass = 'gold_etf' | 'futures' | 'crypto' | 'equity_etf';
type Side = 1 | -1;

type MarketRow = {
  ts: string;
  close: number;
  volume: number;
};

type V16Sample = {
  asset_class: AssetClass;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  score: number;
  manifest: number;
  feed_quality: number;
  q_core: number;
  liquidity_cavity: number;
  leverage_structure: number;
  basis_structure: number;
  breadth_structure: number;
  pnl_usd: number;
  exit_reason: string;
};

type V17Sample = {
  asset_class: AssetClass;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  background_gate: number;
  emergence_gate: number;
  execution_gate: number;
  manifest_gate: number;
  resonance: number;
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
};

type V18Replay = {
  policy: string;
  asset_class: AssetClass;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  exit_ts: string;
  hold_bars: number;
  baseline_exit_reason: string;
  dynamic_exit_reason: string;
  baseline_pnl_usd: number;
  dynamic_pnl_usd: number;
  score: number;
  final_sustain_score: number;
  final_q_error: number;
  final_b_sigma: number;
  final_c_cavity: number;
};

type EntryLike = {
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
  q_error: number;
  structure_score: number;
  sustain_score: number;
  b_sigma: number;
  c_cavity: number;
  r_radius: number;
  eta_freedom: number;
  delta_sigma: number;
  pi_coherence: number;
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

type V19Trade = {
  asset_class: AssetClass;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  exit_ts: string;
  source_version: string;
  heritage_policy: string;
  selected_rule: string;
  exit_reason: string;
  pnl_usd: number;
  baseline_pnl_usd: number;
  score: number;
  quality_1: number;
  quality_2: number;
  quality_3: number;
};

type Metric = {
  trades: number;
  win_rate: number;
  net_pnl_usd: number;
  max_drawdown_usd: number;
  profit_factor: number;
  avg_pnl_usd: number;
};

const VERSION = 'HFCD_Trading_V1_9_AssetHeritageSelector';
const ROOT = process.cwd();
const V16_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_6_true_feeds');
const V17_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_7_tnpap_cascade');
const V18_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_8_dynamic_decoherence_exit');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_9_asset_heritage_selector');
const NOTIONAL = 10_000;
const FEE = 0.0014;

const SYMBOL_FILES: Record<string, string> = {
  GLD: 'GLD.csv',
  IAU: 'IAU.csv',
};

const GOLD_DYNAMIC_HARD: Policy = {
  name: 'dynamic_hard',
  b_max: 0.78,
  c_min: 0.36,
  q_tolerance: 0.28,
  delta_floor: 0.40,
  profit_lock: 0.008,
  max_hold: { gold_etf: 24, futures: 24, crypto: 24, equity_etf: 12 },
  disaster_stop: { gold_etf: 0.026, futures: 0.045, crypto: 0.050, equity_etf: 0.023 },
};

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

function parseRows<T>(text: string, map: (row: Record<string, string>) => T): T[] {
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

function parseV16(text: string): V16Sample[] {
  return parseRows(text, (row) => ({
    asset_class: row.asset_class as AssetClass,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    entry_ts: row.entry_ts,
    score: Number(row.score),
    manifest: Number(row.manifest),
    feed_quality: Number(row.feed_quality),
    q_core: Number(row.q_core),
    liquidity_cavity: Number(row.liquidity_cavity),
    leverage_structure: Number(row.leverage_structure),
    basis_structure: Number(row.basis_structure),
    breadth_structure: Number(row.breadth_structure),
    pnl_usd: Number(row.pnl_usd),
    exit_reason: row.exit_reason,
  })).filter((row) => row.symbol && row.entry_ts && Number.isFinite(row.pnl_usd));
}

function parseV17(text: string): V17Sample[] {
  return parseRows(text, (row) => ({
    asset_class: row.asset_class as AssetClass,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    entry_ts: row.entry_ts,
    background_gate: Number(row.background_gate),
    emergence_gate: Number(row.emergence_gate),
    execution_gate: Number(row.execution_gate),
    manifest_gate: Number(row.manifest_gate),
    resonance: Number(row.resonance),
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
  })).filter((row) => row.symbol && row.entry_ts);
}

function parseV18(text: string): V18Replay[] {
  return parseRows(text, (row) => ({
    policy: row.policy,
    asset_class: row.asset_class as AssetClass,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    entry_ts: row.entry_ts,
    exit_ts: row.exit_ts,
    hold_bars: Number(row.hold_bars),
    baseline_exit_reason: row.baseline_exit_reason,
    dynamic_exit_reason: row.dynamic_exit_reason,
    baseline_pnl_usd: Number(row.baseline_pnl_usd),
    dynamic_pnl_usd: Number(row.dynamic_pnl_usd),
    score: Number(row.score),
    final_sustain_score: Number(row.final_sustain_score),
    final_q_error: Number(row.final_q_error),
    final_b_sigma: Number(row.final_b_sigma),
    final_c_cavity: Number(row.final_c_cavity),
  })).filter((row) => row.symbol && row.entry_ts && Number.isFinite(row.dynamic_pnl_usd));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function clamp(value: number, min = 0, max = 1) {
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

function v16ToEntry(entry: V16Sample): EntryLike {
  const delta = clamp(entry.score * 0.60 + entry.manifest * 0.40);
  return {
    asset_class: entry.asset_class,
    symbol: entry.symbol,
    side: entry.side,
    entry_ts: entry.entry_ts,
    score: entry.score,
    q_core: entry.q_core,
    delta_sigma: delta,
    c_cavity: entry.liquidity_cavity,
    pi_coherence: entry.manifest,
    sigma_ledger: entry.breadth_structure,
    eta_freedom: clamp(1 - entry.liquidity_cavity),
    b_sigma: clamp(1 - entry.leverage_structure),
    r_radius: clamp(1 - entry.liquidity_cavity),
    tau_time: entry.basis_structure,
    omega_coupling: entry.breadth_structure,
    freshness: entry.feed_quality,
    pnl_usd: entry.pnl_usd,
    exit_reason: entry.exit_reason,
  };
}

function runtimeProperty(entry: EntryLike, rows: MarketRow[], index: number, side: Side): RuntimeProperty {
  const s = stats(rows, index);
  const trendAligned = [s.r6, s.r24, s.r168].filter((x) => side * x > 0).length;
  const trendAgreement = trendAligned / 3;
  const qCore = clamp(0.18 + trendAgreement * 0.46 + (side * s.r72 > 0 ? 0.12 : 0));
  const cCavity = clamp(0.30 + sigmoid(s.volumeZ) * 0.28 - Math.max(0, s.vol - 0.018) * 6 + entry.freshness * 0.20);
  const rRadius = clamp(sigmoid((s.radius - 2.5) / 1.4));
  const etaFreedom = clamp(sigmoid((s.vol - 0.011) * 95 + Math.abs(s.z72) * 0.12 + Math.abs(s.r1) * 38));
  const piCoherence = clamp(sigmoid(side * (s.r6 * 8 + s.r24 * 12 + s.r72 * 6) + trendAgreement - 0.55));
  const adverseImpulse = clamp(sigmoid(-side * s.r6 * 22 + Math.abs(s.r1) * 28 - 0.35));
  const bSigma = clamp(Math.max(entry.b_sigma * 0.82, etaFreedom * 0.34 + rRadius * 0.32 + adverseImpulse * 0.24));
  const sigmaLedger = clamp(entry.sigma_ledger * 0.70 + piCoherence * 0.18 + sigmoid(s.volumeZ) * 0.12);
  const deltaSigma = clamp(entry.delta_sigma * 0.74 + sigmoid(side * (s.r24 - s.r168) * 12) * 0.16 + piCoherence * 0.10);
  const qError = clamp(entry.q_core - qCore);
  const structureScore = clamp(
    qCore * 0.20 +
      deltaSigma * 0.20 +
      cCavity * 0.18 +
      piCoherence * 0.15 +
      sigmaLedger * 0.10 +
      (1 - etaFreedom) * 0.06 +
      (1 - bSigma) * 0.06 +
      (1 - rRadius) * 0.05,
  );
  const sustainScore = clamp((1 - bSigma) * (cCavity / 0.30) * (deltaSigma >= 0.30 ? 1 : -1) * Math.exp(-qError * 2.2), -2, 2);
  return {
    q_error: qError,
    structure_score: structureScore,
    sustain_score: sustainScore,
    b_sigma: bSigma,
    c_cavity: cCavity,
    r_radius: rRadius,
    eta_freedom: etaFreedom,
    delta_sigma: deltaSigma,
    pi_coherence: piCoherence,
  };
}

function replayGold(entry: V16Sample, rows: MarketRow[], policy: Policy): V19Trade | null {
  const mapped = v16ToEntry(entry);
  const entryIndex = latestIndex(rows, mapped.entry_ts);
  if (entryIndex < 220 || entryIndex >= rows.length - 2) return null;
  const side: Side = mapped.side === 'long' ? 1 : -1;
  const entryPrice = rows[entryIndex].close;
  const maxHold = policy.max_hold[mapped.asset_class];
  const disasterStop = policy.disaster_stop[mapped.asset_class];
  let exitIndex = Math.min(rows.length - 1, entryIndex + maxHold);
  let exitReason = '最大持有期';

  for (let i = entryIndex + 1; i <= Math.min(rows.length - 1, entryIndex + maxHold); i += 1) {
    const prop = runtimeProperty(mapped, rows, i, side);
    const directional = side * (rows[i].close / entryPrice - 1);
    const bHot = prop.b_sigma >= policy.b_max && (prop.r_radius >= 0.58 || prop.eta_freedom >= 0.70);
    const cDry = prop.c_cavity <= policy.c_min;
    const qBroken = prop.q_error >= policy.q_tolerance && prop.structure_score < 0.45;
    const deltaExhausted = directional >= policy.profit_lock && prop.delta_sigma <= policy.delta_floor && prop.pi_coherence < 0.50;
    const sustainBroken = prop.sustain_score <= 0;
    if (directional <= -disasterStop) {
      exitIndex = i;
      exitReason = '灾难级亏损保护';
      break;
    }
    if (bHot) {
      exitIndex = i;
      exitReason = 'Bσ黑子熔断';
      break;
    }
    if (cDry) {
      exitIndex = i;
      exitReason = 'C腔干涸';
      break;
    }
    if (qBroken) {
      exitIndex = i;
      exitReason = 'Q核背离';
      break;
    }
    if (deltaExhausted) {
      exitIndex = i;
      exitReason = 'DeltaSigma势差释尽';
      break;
    }
    if (i - entryIndex >= 4 && sustainBroken && prop.structure_score < 0.40) {
      exitIndex = i;
      exitReason = '物性退相干';
      break;
    }
  }

  const raw = rows[exitIndex].close / entryPrice - 1;
  const pnl = (side * raw - FEE) * NOTIONAL;
  return {
    asset_class: entry.asset_class,
    symbol: entry.symbol,
    side: entry.side,
    entry_ts: entry.entry_ts,
    exit_ts: rows[exitIndex].ts,
    source_version: 'V1.6',
    heritage_policy: 'TruePropertyFeeds + dynamic_hard',
    selected_rule: 'gold_v16_true_feeds_preserved',
    exit_reason: exitReason,
    pnl_usd: pnl,
    baseline_pnl_usd: entry.pnl_usd,
    score: entry.score,
    quality_1: entry.manifest,
    quality_2: entry.feed_quality,
    quality_3: entry.liquidity_cavity,
  };
}

function key(row: { asset_class: AssetClass; symbol: string; side: string; entry_ts: string }) {
  return `${row.asset_class}|${row.symbol}|${row.side}|${row.entry_ts}`;
}

function mergeV18WithV17(v18: V18Replay[], v17: V17Sample[]) {
  const v17ByKey = new Map(v17.map((row) => [key(row), row]));
  return v18.map((row) => ({ replay: row, props: v17ByKey.get(key(row)) })).filter((row): row is { replay: V18Replay; props: V17Sample } => Boolean(row.props));
}

function selectV18Asset(
  merged: { replay: V18Replay; props: V17Sample }[],
  assetClass: AssetClass,
  policy: string,
  ruleName: string,
  predicate: (row: { replay: V18Replay; props: V17Sample }) => boolean,
) {
  return merged
    .filter((row) => row.replay.asset_class === assetClass && row.replay.policy === policy && predicate(row))
    .map(({ replay, props }) => ({
      asset_class: replay.asset_class,
      symbol: replay.symbol,
      side: replay.side,
      entry_ts: replay.entry_ts,
      exit_ts: replay.exit_ts,
      source_version: 'V1.7/V1.8',
      heritage_policy: `${policy} dynamic exit`,
      selected_rule: ruleName,
      exit_reason: replay.dynamic_exit_reason,
      pnl_usd: replay.dynamic_pnl_usd,
      baseline_pnl_usd: replay.baseline_pnl_usd,
      score: replay.score,
      quality_1: props.background_gate,
      quality_2: props.execution_gate,
      quality_3: props.b_sigma,
    }));
}

function summarize(rows: V19Trade[]): Metric {
  const sorted = [...rows].sort((a, b) => new Date(a.entry_ts).getTime() - new Date(b.entry_ts).getTime());
  const pnl = sorted.map((row) => row.pnl_usd);
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
    avg_pnl_usd: rows.length ? pnl.reduce((sum, x) => sum + x, 0) / rows.length : 0,
  };
}

function splitRows(rows: V19Trade[]) {
  const sorted = [...rows].sort((a, b) => new Date(a.entry_ts).getTime() - new Date(b.entry_ts).getTime());
  const cut = Math.floor(sorted.length * 0.70);
  return {
    train: sorted.slice(0, cut),
    test: sorted.slice(cut),
  };
}

function statusFor(all: Metric, test: Metric) {
  if (all.trades >= 30 && all.net_pnl_usd > 0 && all.profit_factor >= 1.15 && test.trades >= 8 && test.net_pnl_usd > 0 && test.profit_factor >= 1.05) {
    return 'asset_heritage_validation_pass';
  }
  if (all.trades >= 20 && all.net_pnl_usd > 0 && all.profit_factor >= 1.05) {
    return 'positive_watchlist_split_unstable';
  }
  return 'blocked';
}

function rejectionReason(assetClass: AssetClass, policy: string, row: { replay: V18Replay; props: V17Sample }) {
  if (assetClass === 'equity_etf') return row.props.background_gate < 0.65 ? '低频背景海不足' : '非目标策略';
  if (assetClass === 'crypto') return row.props.execution_gate < 0.65 ? '高频执行腔不足' : '非目标策略';
  if (assetClass === 'futures') {
    if (row.props.manifest_gate < 0.50) return '显化门不足';
    if (row.props.background_gate < 0.60) return '低频背景海不足';
    if (row.props.b_sigma > 0.35) return '黑子风险偏高';
    return '非目标策略';
  }
  return policy ? '血缘未继承' : '非目标策略';
}

function metricRows(assetRows: Map<AssetClass, V19Trade[]>) {
  const rows: Record<string, unknown>[] = [];
  const splitValidationRows: Record<string, unknown>[] = [];
  for (const [assetClass, trades] of assetRows) {
    const all = summarize(trades);
    const { train, test } = splitRows(trades);
    const trainMetric = summarize(train);
    const testMetric = summarize(test);
    const status = statusFor(all, testMetric);
    rows.push({
      asset_class: assetClass,
      source_lineage: trades[0]?.heritage_policy || '-',
      selected_rule: trades[0]?.selected_rule || '-',
      trades: all.trades,
      win_rate: all.win_rate,
      net_pnl_usd: all.net_pnl_usd,
      max_drawdown_usd: all.max_drawdown_usd,
      profit_factor: all.profit_factor,
      avg_pnl_usd: all.avg_pnl_usd,
      test_trades: testMetric.trades,
      test_win_rate: testMetric.win_rate,
      test_net_pnl_usd: testMetric.net_pnl_usd,
      test_profit_factor: testMetric.profit_factor,
      status,
    });
    for (const [fold, metric] of [
      ['train_70pct', trainMetric],
      ['test_30pct', testMetric],
    ] as const) {
      splitValidationRows.push({
        asset_class: assetClass,
        fold,
        trades: metric.trades,
        win_rate: metric.win_rate,
        net_pnl_usd: metric.net_pnl_usd,
        max_drawdown_usd: metric.max_drawdown_usd,
        profit_factor: metric.profit_factor,
      });
    }
  }
  return { rows, splitValidationRows };
}

function groupFailureRows(rows: Record<string, string | number>[]) {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const k = `${row.asset_class}|${row.reason}`;
    groups.set(k, (groups.get(k) || 0) + Number(row.count || 1));
  }
  return [...groups.entries()].map(([k, count]) => {
    const [asset_class, reason] = k.split('|');
    return { asset_class, reason, count };
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const v16 = parseV16(await readFile(path.join(V16_DIR, 'hfcd_trading_v1_6_property_samples.csv'), 'utf8'));
  const v17 = parseV17(await readFile(path.join(V17_DIR, 'hfcd_trading_v1_7_property_samples.csv'), 'utf8'));
  const v18 = parseV18(await readFile(path.join(V18_DIR, 'hfcd_trading_v1_8_replay_trades.csv'), 'utf8'));
  const market = new Map<string, MarketRow[]>();
  for (const [symbol, file] of Object.entries(SYMBOL_FILES)) {
    market.set(symbol, parseMarket(await readFile(path.join(V16_DIR, 'market_data', file), 'utf8')));
  }

  const selected: V19Trade[] = [];
  const failureRows: Record<string, string | number>[] = [];

  for (const sample of v16.filter((row) => row.asset_class === 'gold_etf')) {
    const rows = market.get(sample.symbol);
    if (!rows) continue;
    const replay = replayGold(sample, rows, GOLD_DYNAMIC_HARD);
    if (replay) selected.push(replay);
  }

  const merged = mergeV18WithV17(v18, v17);
  const equityRows = selectV18Asset(
    merged,
    'equity_etf',
    'dynamic_soft',
    'equity_v17_background_ge_0p65_dynamic_soft',
    (row) => row.props.background_gate >= 0.65,
  );
  const cryptoRows = selectV18Asset(
    merged,
    'crypto',
    'dynamic_soft',
    'crypto_v18_execution_cavity_ge_0p65_dynamic_soft',
    (row) => row.props.execution_gate >= 0.65,
  );
  const futuresRows = selectV18Asset(
    merged,
    'futures',
    'dynamic_mid',
    'futures_v18_manifest_ge_0p50_background_ge_0p60_bsigma_le_0p35_dynamic_mid',
    (row) => row.props.manifest_gate >= 0.50 && row.props.background_gate >= 0.60 && row.props.b_sigma <= 0.35,
  );
  selected.push(...equityRows, ...cryptoRows, ...futuresRows);

  for (const assetClass of ['equity_etf', 'crypto', 'futures'] as const) {
    const targetPolicy = assetClass === 'futures' ? 'dynamic_mid' : 'dynamic_soft';
    for (const row of merged.filter((item) => item.replay.asset_class === assetClass && item.replay.policy === targetPolicy)) {
      const selectedKey = key(row.replay);
      const exists = selected.some((trade) => key(trade) === selectedKey && trade.asset_class === assetClass);
      if (!exists) failureRows.push({ asset_class: assetClass, reason: rejectionReason(assetClass, targetPolicy, row), count: 1 });
    }
  }
  failureRows.push({
    asset_class: 'gold_etf',
    reason: '保留V1.6黄金血统，拒绝V1.7黄金统一门控覆盖',
    count: v17.filter((row) => row.asset_class === 'gold_etf').length,
  });

  const assetRows = new Map<AssetClass, V19Trade[]>();
  for (const assetClass of ['gold_etf', 'equity_etf', 'crypto', 'futures'] as const) {
    assetRows.set(assetClass, selected.filter((row) => row.asset_class === assetClass));
  }
  const { rows: summaryRows, splitValidationRows } = metricRows(assetRows);
  const exitRows: Record<string, unknown>[] = [];
  for (const assetClass of ['gold_etf', 'equity_etf', 'crypto', 'futures'] as const) {
    const byExit = new Map<string, V19Trade[]>();
    for (const row of selected.filter((trade) => trade.asset_class === assetClass)) {
      byExit.set(row.exit_reason, [...(byExit.get(row.exit_reason) || []), row]);
    }
    for (const [reason, rows] of byExit) {
      const metric = summarize(rows);
      exitRows.push({
        asset_class: assetClass,
        exit_reason: reason,
        count: rows.length,
        win_rate: metric.win_rate,
        net_pnl_usd: metric.net_pnl_usd,
        profit_factor: metric.profit_factor,
      });
    }
  }

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_9_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_9_split_validation.csv'), toCsv(splitValidationRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_9_selected_trades.csv'), toCsv(selected as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_9_exit_reasons.csv'), toCsv(exitRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_9_failure_modes.csv'), toCsv(groupFailureRows(failureRows)));

  const passCount = summaryRows.filter((row) => row.status === 'asset_heritage_validation_pass').length;
  const watchlistCount = summaryRows.filter((row) => row.status === 'positive_watchlist_split_unstable').length;
  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_validation_only_not_deployed',
    thesis:
      'V1.9 preserves the best validated bloodline per asset instead of forcing one universal gate: gold keeps V1.6 TruePropertyFeeds, equity keeps V1.7/V1.8, crypto/futures keep V1.8 dynamic exits with extra entry-sensor filters.',
    pass_count: passCount,
    watchlist_count: watchlistCount,
    blocked_count: summaryRows.length - passCount - watchlistCount,
    summary: summaryRows,
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_9_summary.json'), JSON.stringify(summary, null, 2));

  const md = `# ${VERSION}

## 目标

V1.9 不再把所有资产强行塞入同一套门控，而是保留每个资产当前最有效的血统：

- 黄金 ETF：继承 V1.6 TruePropertyFeeds 入场，并固定使用 dynamic_hard 退场复核，避免逐笔事后选择。
- 股票 ETF：继承 V1.7 TNPAP 入场 + V1.8 dynamic_soft，并增加低频背景海筛选。
- 加密货币：继承 V1.8 dynamic_soft，但只放行高频执行腔达标的样本。
- 期货：继承 V1.8 dynamic_mid，但只放行显化门、低频背景海和黑子风险同时达标的样本。

## 汇总

| 资产 | 血统 | 交易数 | 胜率 | 净收益 | 最大回撤 | PF | 测试段净收益 | 状态 |
|---|---|---:|---:|---:|---:|---:|---:|---|
${summaryRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${row.source_lineage} | ${row.trades} | ${pct(Number(row.win_rate))} | $${Number(row.net_pnl_usd).toFixed(0)} | $${Number(row.max_drawdown_usd).toFixed(0)} | ${Number(row.profit_factor).toFixed(2)} | $${Number(row.test_net_pnl_usd).toFixed(0)} | ${row.status} |`,
  )
  .join('\n')}

## 判断

V1.9 的核心修正是血缘继承：黄金不能再被 V1.7 统一 TNPAP 入口覆盖；股票保留已经通过的 TNPAP 路径；加密和期货只把 V1.8 动态退场作为候选，必须继续补真实传感器验证。

如果某资产全样本为正但测试段不稳，状态保留为 watchlist，不进入线上策略。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_9_AssetHeritageSelector.md'), md);
  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
