import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type SymbolName = 'BTCUSDT' | 'ETHUSDT';
type SplitName = 'train' | 'validation' | 'test';
type Side = 'long' | 'short';
type Action = Side | 'none';
type FeatureFamily = 'legacy_price_volume' | 'metrics_only' | 'l2_metrics';

type KlineRow = {
  ts: string;
  symbol: SymbolName;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
};

type BookDepthRow = {
  ts: string;
  symbol: SymbolName;
  ask_0p2_notional: number;
  bid_0p2_notional: number;
  ask_1p0_notional: number;
  bid_1p0_notional: number;
  depth_imbalance_0p2: number;
  depth_imbalance_1p0: number;
  liquidity_cavity_0p2_usd: number;
  liquidity_cavity_1p0_usd: number;
};

type MetricsRow = {
  ts: string;
  symbol: SymbolName;
  count_long_short_ratio: number;
  count_toptrader_long_short_ratio: number;
  sum_open_interest: number;
  sum_open_interest_value: number;
  sum_taker_long_short_vol_ratio: number;
  sum_toptrader_long_short_ratio: number;
};

type FeatureRow = KlineRow & {
  ret_1: number;
  ret_fast: number;
  ret_mid: number;
  ret_long: number;
  realized_vol: number;
  vol_ratio: number;
  candle_spread: number;
  volume_ratio: number;
  q_core: number;
  legacy_cavity: number;
  l2_cavity: number;
  l2_cavity_0p2: number;
  l2_cavity_1p0: number;
  depth_imbalance_0p2: number;
  depth_imbalance_1p0: number;
  oi_z: number;
  oi_slope: number;
  taker_pressure: number;
  account_crowding: number;
  top_trader_crowding: number;
  omega_coupling: number;
  has_book_depth: boolean;
  has_metrics: boolean;
};

type PropertyBundle = {
  signed_score: number;
  score: number;
  property_score: number;
  q_core: number;
  liquidity_cavity: number;
  pi_coherence: number;
  sigma_ledger: number;
  eta_noise: number;
  b_sigma: number;
  r_radius: number;
  omega_coupling: number;
};

type ParamSet = {
  symbol: SymbolName;
  feature_family: FeatureFamily;
  policy_name: string;
  source_lineage: string;
  long_bars: number;
  holding_bars: number;
  min_score: number;
  min_property_score: number;
  min_q: number;
  min_cavity: number;
  max_b_sigma: number;
  max_eta: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  trail_activate_pct: number;
  trail_giveback_pct: number;
  cooldown_bars: number;
  side_policy: 'both' | 'long_only' | 'short_only';
  exit_mode: 'fixed' | 'opposite_or_decay' | 'profit_trailing' | 'trailing_with_decay';
  mode: 'trend' | 'trend_l2_pressure' | 'mean_revert_guard';
};

type Signal = PropertyBundle & {
  action: Action;
  failure_mode: string;
};

type Trade = {
  split: SplitName;
  symbol: SymbolName;
  feature_family: FeatureFamily;
  policy_name: string;
  side: Side;
  entry_ts: string;
  exit_ts: string;
  entry_price: number;
  exit_price: number;
  holding_bars: number;
  score: number;
  property_score: number;
  q_core: number;
  liquidity_cavity: number;
  legacy_cavity: number;
  l2_cavity: number;
  depth_imbalance_0p2: number;
  taker_pressure: number;
  oi_z: number;
  b_sigma: number;
  exit_reason: string;
  gross_return: number;
  execution_cost: number;
  net_return: number;
  pnl_usd: number;
};

type Metrics = {
  trades: number;
  win_rate: number;
  net_pnl_usd: number;
  gross_profit_usd: number;
  gross_loss_usd: number;
  profit_factor: number;
  max_drawdown_usd: number;
  avg_pnl_usd: number;
  trades_per_day: number;
};

const VERSION = 'HFCD_Trading_V2_6_CryptoL2MetricsTrain';
const ROOT = process.cwd();
const V25_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v2_5_crypto_binance_vision_l2_metrics');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v2_6_crypto_l2_metrics_train');
const SYMBOLS: SymbolName[] = ['BTCUSDT', 'ETHUSDT'];
const INTERVAL = '5m';
const NOTIONAL_USD = Number(process.env.HFCD_CRYPTO_NOTIONAL || 1000);
const BASE_ROUNDTRIP_COST = Number(process.env.HFCD_CRYPTO_ROUNDTRIP_COST || 0.0012);
const L2_COST_SLOPE = Number(process.env.HFCD_CRYPTO_L2_COST_SLOPE || 0.0002);

const PRIOR_V23 = {
  BTCUSDT: { test_net_pnl_usd: -98.4, test_profit_factor: 0.5821, trades: 75 },
  ETHUSDT: { test_net_pnl_usd: -232.11, test_profit_factor: 0.3681, trades: 67 },
} as const;

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))].join('\n') + '\n';
}

function parseCsv(text: string) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    return row;
  });
}

function normalizeTs(ts: string | number) {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toISOString().replace('.000Z', 'Z');
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function percentile(values: number[], p: number) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const idx = Math.min(clean.length - 1, Math.max(0, Math.floor((clean.length - 1) * p)));
  return clean[idx];
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function number(value: number, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

function pct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

async function fetchJson(url: string) {
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'HFCD-ThingNature-OS/2.6',
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 450 + attempt * 350));
    }
  }
  throw new Error(`fetch failed: ${url} :: ${lastError}`);
}

async function fetchKlines(symbol: SymbolName, startDate: string, endDate: string) {
  const rows: KlineRow[] = [];
  const intervalMs = 5 * 60 * 1000;
  let cursor = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T23:59:59Z`).getTime();
  while (cursor <= end) {
    const url = new URL('https://fapi.binance.com/fapi/v1/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', INTERVAL);
    url.searchParams.set('limit', '1500');
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(end));
    const payload = await fetchJson(url.toString()) as any[];
    if (!Array.isArray(payload) || payload.length === 0) break;
    for (const item of payload) {
      rows.push({
        ts: normalizeTs(Number(item[0])),
        symbol,
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5]),
        quote_volume: Number(item[7]),
      });
    }
    const lastOpen = Number(payload[payload.length - 1]?.[0] || cursor);
    cursor = lastOpen + intervalMs;
    if (payload.length < 1500) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const dedup = new Map(rows.map((row) => [row.ts, row]));
  return [...dedup.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

async function loadV25Inputs() {
  const summary = JSON.parse(await readFile(path.join(V25_DIR, 'hfcd_trading_v2_5_summary.json'), 'utf8')) as {
    date_start: string;
    date_end: string;
    counts: Record<string, number>;
  };
  const bookRows = parseCsv(await readFile(path.join(V25_DIR, 'hfcd_trading_v2_5_book_depth_5m.csv'), 'utf8')).map((row): BookDepthRow => ({
    ts: normalizeTs(row.ts),
    symbol: row.symbol as SymbolName,
    ask_0p2_notional: Number(row.ask_0p2_notional || 0),
    bid_0p2_notional: Number(row.bid_0p2_notional || 0),
    ask_1p0_notional: Number(row.ask_1p0_notional || 0),
    bid_1p0_notional: Number(row.bid_1p0_notional || 0),
    depth_imbalance_0p2: Number(row.depth_imbalance_0p2 || 0),
    depth_imbalance_1p0: Number(row.depth_imbalance_1p0 || 0),
    liquidity_cavity_0p2_usd: Number(row.liquidity_cavity_0p2_usd || 0),
    liquidity_cavity_1p0_usd: Number(row.liquidity_cavity_1p0_usd || 0),
  })).filter((row) => SYMBOLS.includes(row.symbol));
  const metricRows = parseCsv(await readFile(path.join(V25_DIR, 'hfcd_trading_v2_5_metrics_5m.csv'), 'utf8')).map((row): MetricsRow => ({
    ts: normalizeTs(row.ts),
    symbol: row.symbol as SymbolName,
    count_long_short_ratio: Number(row.count_long_short_ratio || 0),
    count_toptrader_long_short_ratio: Number(row.count_toptrader_long_short_ratio || 0),
    sum_open_interest: Number(row.sum_open_interest || 0),
    sum_open_interest_value: Number(row.sum_open_interest_value || 0),
    sum_taker_long_short_vol_ratio: Number(row.sum_taker_long_short_vol_ratio || 0),
    sum_toptrader_long_short_ratio: Number(row.sum_toptrader_long_short_ratio || 0),
  })).filter((row) => SYMBOLS.includes(row.symbol));
  return { summary, bookRows, metricRows };
}

function bySymbolTs<T extends { symbol: SymbolName; ts: string }>(rows: T[]) {
  const map = new Map<string, T>();
  for (const row of rows) map.set(`${row.symbol}|${row.ts}`, row);
  return map;
}

function rollingZ(value: number, window: number[]) {
  const s = std(window);
  if (!window.length || s <= 0) return 0;
  return clamp((value - mean(window)) / s, -4, 4);
}

function buildFeatures(symbol: SymbolName, klines: KlineRow[], bookMap: Map<string, BookDepthRow>, metricsMap: Map<string, MetricsRow>) {
  const joined = klines
    .map((row) => ({
      kline: row,
      book: bookMap.get(`${symbol}|${row.ts}`),
      metrics: metricsMap.get(`${symbol}|${row.ts}`),
    }))
    .filter((row) => row.book && row.metrics);

  const l2Values = joined.map((row) => row.book?.liquidity_cavity_1p0_usd || 0);
  const l2p95 = Math.max(percentile(l2Values, 0.95), 1);
  const qvValues = joined.map((row) => row.kline.quote_volume);
  const qvP95 = Math.max(percentile(qvValues, 0.95), 1);
  const rows: FeatureRow[] = [];

  for (let i = 0; i < joined.length; i += 1) {
    const row = joined[i].kline;
    const book = joined[i].book as BookDepthRow;
    const metric = joined[i].metrics as MetricsRow;
    const closes = joined.slice(Math.max(0, i - 288), i + 1).map((x) => x.kline.close);
    const rets = closes.map((value, idx, arr) => idx === 0 ? 0 : value / arr[idx - 1] - 1).slice(1);
    const ret1 = i > 0 ? row.close / joined[i - 1].kline.close - 1 : 0;
    const retFast = row.close / (joined[Math.max(0, i - 6)]?.kline.close || row.close) - 1;
    const retMid = row.close / (joined[Math.max(0, i - 24)]?.kline.close || row.close) - 1;
    const retLong = row.close / (joined[Math.max(0, i - 96)]?.kline.close || row.close) - 1;
    const volShort = Math.max(std(rets.slice(-36)), 0.0008);
    const volLong = Math.max(std(rets.slice(-288)), volShort, 0.0008);
    const volRatio = clamp(volShort / Math.max(volLong, 0.0008), 0, 4);
    const candleSpread = Math.max((row.high - row.low) / row.close, 0);
    const volumeLookback = joined.slice(Math.max(0, i - 288), i + 1).map((x) => x.kline.quote_volume);
    const volumeRatio = mean(volumeLookback) > 0 ? row.quote_volume / mean(volumeLookback) : 1;
    const trendSigns = [retFast, retMid, retLong].map((value) => Math.sign(value || 0));
    const agreement = Math.max(trendSigns.filter((x) => x > 0).length, trendSigns.filter((x) => x < 0).length) / 3;
    const recentMax = Math.max(...closes);
    const drawdown = recentMax > 0 ? row.close / recentMax - 1 : 0;
    const qCore = clamp(0.24 + agreement * 0.44 + clamp(1 + drawdown * 12, 0, 1) * 0.22 + (symbol === 'BTCUSDT' ? 0.04 : 0.02));
    const legacyCavity = clamp(0.18 + Math.log1p(row.quote_volume) / Math.log1p(qvP95) * 0.72 - candleSpread * 12 - Math.max(0, volRatio - 1.6) * 0.08);
    const l2Cavity0p2 = clamp(Math.log1p(book.liquidity_cavity_0p2_usd) / Math.log1p(Math.max(percentile(l2Values, 0.75), 1)));
    const l2Cavity1p0 = clamp(Math.log1p(book.liquidity_cavity_1p0_usd) / Math.log1p(l2p95));
    const l2Cavity = clamp(0.20 + l2Cavity0p2 * 0.38 + l2Cavity1p0 * 0.42 - Math.max(0, Math.abs(book.depth_imbalance_0p2) - 0.55) * 0.18);
    const oiHistory = rows.slice(-288).map((x) => x.oi_z === x.oi_z ? (x as any)._raw_oi as number : 0).filter((x) => x > 0);
    const oiZ = rollingZ(metric.sum_open_interest, oiHistory);
    const prevOi = rows.length ? ((rows[rows.length - 1] as any)._raw_oi as number || metric.sum_open_interest) : metric.sum_open_interest;
    const oiSlope = prevOi > 0 ? clamp((metric.sum_open_interest / prevOi - 1) * 20, -2, 2) : 0;
    const takerPressure = clamp(Math.log(Math.max(metric.sum_taker_long_short_vol_ratio, 0.05)), -2, 2);
    const accountCrowding = clamp(Math.abs(Math.log(Math.max(metric.count_long_short_ratio, 0.05))) / 1.3);
    const topCrowding = clamp(Math.abs(Math.log(Math.max(metric.sum_toptrader_long_short_ratio, 0.05))) / 1.3);
    const feature: FeatureRow = {
      ...row,
      ret_1: ret1,
      ret_fast: retFast,
      ret_mid: retMid,
      ret_long: retLong,
      realized_vol: volShort,
      vol_ratio: volRatio,
      candle_spread: candleSpread,
      volume_ratio: volumeRatio,
      q_core: qCore,
      legacy_cavity: legacyCavity,
      l2_cavity: l2Cavity,
      l2_cavity_0p2: l2Cavity0p2,
      l2_cavity_1p0: l2Cavity1p0,
      depth_imbalance_0p2: clamp(book.depth_imbalance_0p2, -1, 1),
      depth_imbalance_1p0: clamp(book.depth_imbalance_1p0, -1, 1),
      oi_z: oiZ,
      oi_slope: oiSlope,
      taker_pressure: takerPressure,
      account_crowding: accountCrowding,
      top_trader_crowding: topCrowding,
      omega_coupling: 0.5,
      has_book_depth: true,
      has_metrics: true,
    };
    (feature as any)._raw_oi = metric.sum_open_interest;
    rows.push(feature);
  }
  for (const row of rows) delete (row as any)._raw_oi;
  return rows;
}

function correlation(a: number[], b: number[]) {
  if (a.length < 12 || b.length < 12 || a.length !== b.length) return 0;
  const ma = mean(a);
  const mb = mean(b);
  const da = Math.sqrt(a.reduce((sum, value) => sum + (value - ma) ** 2, 0));
  const db = Math.sqrt(b.reduce((sum, value) => sum + (value - mb) ** 2, 0));
  if (!da || !db) return 0;
  return a.reduce((sum, value, index) => sum + (value - ma) * (b[index] - mb), 0) / (da * db);
}

function injectOmega(a: FeatureRow[], b: FeatureRow[]) {
  const byTs = new Map(b.map((row) => [row.ts, row]));
  const aReturns: number[] = [];
  const bReturns: number[] = [];
  for (const row of a) {
    const other = byTs.get(row.ts);
    aReturns.push(row.ret_1);
    bReturns.push(other?.ret_1 || 0);
    const corr = correlation(aReturns.slice(-96), bReturns.slice(-96));
    row.omega_coupling = clamp(0.5 + corr * 0.25);
  }
}

function propertyWeights(symbol: SymbolName, family: FeatureFamily) {
  if (symbol === 'BTCUSDT') {
    if (family === 'l2_metrics') return { q: 0.16, c: 0.21, pi: 0.16, sigma: 0.18, antiB: 0.17, antiR: 0.07, omega: 0.05 };
    if (family === 'metrics_only') return { q: 0.18, c: 0.14, pi: 0.17, sigma: 0.22, antiB: 0.15, antiR: 0.08, omega: 0.06 };
    return { q: 0.20, c: 0.17, pi: 0.18, sigma: 0.16, antiB: 0.15, antiR: 0.08, omega: 0.06 };
  }
  if (family === 'l2_metrics') return { q: 0.12, c: 0.20, pi: 0.20, sigma: 0.16, antiB: 0.15, antiR: 0.09, omega: 0.08 };
  if (family === 'metrics_only') return { q: 0.13, c: 0.13, pi: 0.21, sigma: 0.20, antiB: 0.14, antiR: 0.10, omega: 0.09 };
  return { q: 0.15, c: 0.16, pi: 0.22, sigma: 0.15, antiB: 0.13, antiR: 0.10, omega: 0.09 };
}

function computeBundle(row: FeatureRow, params: ParamSet): PropertyBundle {
  const useL2 = params.feature_family === 'l2_metrics';
  const useMetrics = params.feature_family !== 'legacy_price_volume';
  const liquidityCavity = useL2 ? row.l2_cavity : row.legacy_cavity;
  const l2Pressure = useL2 ? row.depth_imbalance_0p2 * 0.65 + row.depth_imbalance_1p0 * 0.25 : 0;
  const takerPressure = useMetrics ? row.taker_pressure : 0;
  const oiZ = useMetrics ? row.oi_z : 0;
  const rawTrend = (0.44 * row.ret_fast + 0.34 * row.ret_mid + 0.22 * row.ret_long) / Math.max(row.realized_vol, 0.0008);
  const microPressure = takerPressure * 0.55 + l2Pressure * 0.75 + oiZ * 0.05;
  const meanRevert = -clamp((row.ret_long / Math.max(row.realized_vol, 0.0008)) / 2.8, -1.4, 1.4);
  const blended = params.mode === 'trend'
    ? rawTrend
    : params.mode === 'trend_l2_pressure'
      ? rawTrend * (0.68 + liquidityCavity * 0.24) + microPressure * 0.25
      : (row.q_core > 0.68 && Math.abs(rawTrend) > 0.65 ? rawTrend + microPressure * 0.18 : meanRevert * liquidityCavity + microPressure * 0.12);
  const signedScore = clamp(blended, -1.9, 1.9);
  const piCoherence = clamp(0.5 + ((0.45 * row.ret_fast + 0.35 * row.ret_mid + 0.2 * row.ret_long) / Math.max(row.realized_vol, 0.0008)) * 0.10 + microPressure * 0.045);
  const sigmaLedger = clamp(0.45 + Math.log(Math.max(row.volume_ratio, 0.05)) * 0.12 + oiZ * 0.035 + takerPressure * 0.035);
  const etaNoise = clamp((row.vol_ratio - 0.7) / 2.3 + (useL2 ? Math.max(0, 0.52 - liquidityCavity) * 0.35 : 0));
  const bSigma = clamp(
    etaNoise * 0.42 +
    Math.max(0, oiZ) * 0.06 +
    Math.max(0, row.oi_slope) * 0.08 +
    row.account_crowding * (useMetrics ? 0.13 : 0.04) +
    row.top_trader_crowding * (useMetrics ? 0.10 : 0.03) +
    (useL2 ? Math.max(0, Math.abs(row.depth_imbalance_0p2) - 0.45) * 0.18 : 0),
  );
  const rRadius = clamp(Math.max(0, oiZ) * 0.11 + Math.max(0, row.oi_slope) * 0.16 + etaNoise * 0.24 + row.account_crowding * (useMetrics ? 0.10 : 0.03));
  const weights = propertyWeights(params.symbol, params.feature_family);
  const propertyScore =
    weights.q * row.q_core +
    weights.c * liquidityCavity +
    weights.pi * piCoherence +
    weights.sigma * sigmaLedger +
    weights.antiB * (1 - bSigma) +
    weights.antiR * (1 - rRadius) +
    weights.omega * row.omega_coupling;
  return {
    signed_score: signedScore,
    score: Math.abs(signedScore),
    property_score: propertyScore,
    q_core: row.q_core,
    liquidity_cavity: liquidityCavity,
    pi_coherence: piCoherence,
    sigma_ledger: sigmaLedger,
    eta_noise: etaNoise,
    b_sigma: bSigma,
    r_radius: rRadius,
    omega_coupling: row.omega_coupling,
  };
}

function signalAt(rows: FeatureRow[], index: number, params: ParamSet): Signal {
  const row = rows[index];
  if (!row || index < params.long_bars + 2) return emptySignal('insufficient_history');
  const bundle = computeBundle(row, params);
  if (bundle.q_core < params.min_q) return fullSignal(bundle, 'none', 'q_core_underthreshold');
  if (bundle.liquidity_cavity < params.min_cavity) return fullSignal(bundle, 'none', 'liquidity_cavity_underthreshold');
  if (bundle.b_sigma > params.max_b_sigma) return fullSignal(bundle, 'none', 'b_sigma_overheated');
  if (bundle.eta_noise > params.max_eta) return fullSignal(bundle, 'none', 'eta_noise_overheated');
  if (bundle.score < params.min_score || bundle.property_score < params.min_property_score) return fullSignal(bundle, 'none', 'property_score_underthreshold');
  const side = bundle.signed_score >= 0 ? 'long' : 'short';
  if (params.side_policy === 'long_only' && side === 'short') return fullSignal(bundle, 'none', 'side_policy_reject_short');
  if (params.side_policy === 'short_only' && side === 'long') return fullSignal(bundle, 'none', 'side_policy_reject_long');
  return fullSignal(bundle, side, '');
}

function emptySignal(reason: string): Signal {
  return {
    action: 'none',
    failure_mode: reason,
    signed_score: 0,
    score: 0,
    property_score: 0,
    q_core: 0,
    liquidity_cavity: 0,
    pi_coherence: 0,
    sigma_ledger: 0,
    eta_noise: 0,
    b_sigma: 0,
    r_radius: 0,
    omega_coupling: 0,
  };
}

function fullSignal(bundle: PropertyBundle, action: Action, reason: string): Signal {
  return { ...bundle, action, failure_mode: reason };
}

function executionCost(entry: FeatureRow, params: ParamSet) {
  if (params.feature_family !== 'l2_metrics') return BASE_ROUNDTRIP_COST;
  return BASE_ROUNDTRIP_COST + Math.max(0, 1 - entry.l2_cavity) * L2_COST_SLOPE;
}

function simulate(symbol: SymbolName, rows: FeatureRow[], params: ParamSet, split: SplitName, startIndex: number, endIndex: number) {
  const trades: Trade[] = [];
  const failureModes: Record<string, number> = {};
  let index = Math.max(startIndex, params.long_bars + 2);
  while (index < Math.min(endIndex, rows.length - params.holding_bars - 2)) {
    const signal = signalAt(rows, index, params);
    if (signal.action === 'none') {
      failureModes[signal.failure_mode] = (failureModes[signal.failure_mode] || 0) + 1;
      index += 1;
      continue;
    }
    const entryBar = rows[index + 1];
    const entryPrice = entryBar.open || rows[index].close;
    let exitIndex = Math.min(index + 1 + params.holding_bars, rows.length - 1);
    let exitPrice = rows[exitIndex].close;
    let exitReason = 'time_exit';
    let peakPrice = entryPrice;
    let troughPrice = entryPrice;
    let trailingActive = false;

    for (let j = index + 2; j <= Math.min(index + 1 + params.holding_bars, rows.length - 1); j += 1) {
      const bar = rows[j];
      peakPrice = Math.max(peakPrice, bar.high);
      troughPrice = Math.min(troughPrice, bar.low);
      if (signal.action === 'long') {
        const stop = entryPrice * (1 - params.stop_loss_pct);
        const take = entryPrice * (1 + params.take_profit_pct);
        const stopHit = bar.low <= stop;
        const takeHit = bar.high >= take;
        if (stopHit || takeHit) {
          exitIndex = j;
          exitPrice = stopHit ? stop : take;
          exitReason = stopHit ? 'stop_loss' : 'take_profit';
          break;
        }
        const peakReturn = peakPrice / entryPrice - 1;
        if ((params.exit_mode === 'profit_trailing' || params.exit_mode === 'trailing_with_decay') && peakReturn >= params.trail_activate_pct) trailingActive = true;
        if (trailingActive && (peakPrice - bar.close) / peakPrice >= params.trail_giveback_pct) {
          exitIndex = j;
          exitPrice = bar.close;
          exitReason = 'profit_trailing';
          break;
        }
      } else {
        const stop = entryPrice * (1 + params.stop_loss_pct);
        const take = entryPrice * (1 - params.take_profit_pct);
        const stopHit = bar.high >= stop;
        const takeHit = bar.low <= take;
        if (stopHit || takeHit) {
          exitIndex = j;
          exitPrice = stopHit ? stop : take;
          exitReason = stopHit ? 'stop_loss' : 'take_profit';
          break;
        }
        const peakReturn = entryPrice / troughPrice - 1;
        if ((params.exit_mode === 'profit_trailing' || params.exit_mode === 'trailing_with_decay') && peakReturn >= params.trail_activate_pct) trailingActive = true;
        if (trailingActive && (bar.close - troughPrice) / troughPrice >= params.trail_giveback_pct) {
          exitIndex = j;
          exitPrice = bar.close;
          exitReason = 'profit_trailing';
          break;
        }
      }

      if (params.exit_mode === 'opposite_or_decay' || params.exit_mode === 'trailing_with_decay') {
        const live = signalAt(rows, j - 1, params);
        const sameSide = live.action === signal.action;
        const oppositeSide = live.action !== 'none' && live.action !== signal.action;
        const structuralDecay = live.action === 'none' && ['q_core_underthreshold', 'liquidity_cavity_underthreshold', 'b_sigma_overheated', 'eta_noise_overheated', 'property_score_underthreshold'].includes(live.failure_mode);
        if (structuralDecay || (oppositeSide && !sameSide)) {
          exitIndex = j;
          exitPrice = bar.close;
          exitReason = structuralDecay ? `dynamic_${live.failure_mode}` : 'dynamic_opposite_signal';
          break;
        }
      }
    }

    const grossReturn = signal.action === 'long' ? exitPrice / entryPrice - 1 : entryPrice / exitPrice - 1;
    const cost = executionCost(entryBar, params);
    const netReturn = grossReturn - cost;
    trades.push({
      split,
      symbol,
      feature_family: params.feature_family,
      policy_name: params.policy_name,
      side: signal.action,
      entry_ts: entryBar.ts,
      exit_ts: rows[exitIndex].ts,
      entry_price: number(entryPrice, 4),
      exit_price: number(exitPrice, 4),
      holding_bars: exitIndex - index - 1,
      score: number(signal.score, 4),
      property_score: number(signal.property_score, 4),
      q_core: number(signal.q_core, 4),
      liquidity_cavity: number(signal.liquidity_cavity, 4),
      legacy_cavity: number(entryBar.legacy_cavity, 4),
      l2_cavity: number(entryBar.l2_cavity, 4),
      depth_imbalance_0p2: number(entryBar.depth_imbalance_0p2, 4),
      taker_pressure: number(entryBar.taker_pressure, 4),
      oi_z: number(entryBar.oi_z, 4),
      b_sigma: number(signal.b_sigma, 4),
      exit_reason: exitReason,
      gross_return: number(grossReturn, 6),
      execution_cost: number(cost, 6),
      net_return: number(netReturn, 6),
      pnl_usd: number(netReturn * NOTIONAL_USD, 2),
    });
    index = exitIndex + 1 + params.cooldown_bars;
  }
  return { trades, failureModes };
}

function metrics(trades: Trade[]): Metrics {
  const grossProfit = trades.filter((trade) => trade.pnl_usd > 0).reduce((sum, trade) => sum + trade.pnl_usd, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl_usd < 0).reduce((sum, trade) => sum + trade.pnl_usd, 0));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const trade of trades) {
    equity += trade.pnl_usd;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }
  const days = trades.length ? Math.max(1, (new Date(trades[trades.length - 1].exit_ts).getTime() - new Date(trades[0].entry_ts).getTime()) / 86_400_000) : 1;
  return {
    trades: trades.length,
    win_rate: trades.length ? trades.filter((trade) => trade.pnl_usd > 0).length / trades.length : 0,
    net_pnl_usd: number(trades.reduce((sum, trade) => sum + trade.pnl_usd, 0), 2),
    gross_profit_usd: number(grossProfit, 2),
    gross_loss_usd: number(grossLoss, 2),
    profit_factor: grossLoss > 0 ? number(grossProfit / grossLoss, 4) : (grossProfit > 0 ? 99 : 0),
    max_drawdown_usd: number(maxDd, 2),
    avg_pnl_usd: trades.length ? number(mean(trades.map((trade) => trade.pnl_usd)), 2) : 0,
    trades_per_day: number(trades.length / days, 3),
  };
}

function paramGrid(symbol: SymbolName, family: FeatureFamily): ParamSet[] {
  const rows: ParamSet[] = [];
  const base = {
    symbol,
    feature_family: family,
    long_bars: 144,
    stop_loss_pct: 0.024,
    take_profit_pct: 0.034,
    trail_activate_pct: 0.012,
    trail_giveback_pct: 0.0075,
    cooldown_bars: 2,
    source_lineage: family === 'l2_metrics'
      ? 'V2.5 Binance Vision bookDepth + metrics true cavity'
      : family === 'metrics_only'
        ? 'V2.5 Binance Vision metrics only, no bookDepth cavity'
        : 'V2.3-style price/volume cavity baseline',
  };
  for (const minScore of [0.55, 0.8, 1.05]) {
    for (const minPropertyScore of [0.54, 0.60, 0.66]) {
      for (const minCavity of family === 'l2_metrics' ? [0.42, 0.55, 0.68] : [0.45, 0.58, 0.70]) {
        for (const maxBSigma of [0.58, 0.72]) {
          for (const maxEta of [0.78, 0.95]) {
            for (const sidePolicy of ['both', 'long_only'] as const) {
              for (const exitMode of ['fixed', 'profit_trailing', 'trailing_with_decay'] as const) {
                for (const mode of family === 'legacy_price_volume' ? ['trend', 'mean_revert_guard'] as const : ['trend_l2_pressure', 'mean_revert_guard'] as const) {
                  rows.push({
                    ...base,
                    policy_name: `${family}_${mode}_${exitMode}_s${minScore}_p${minPropertyScore}_c${minCavity}`,
                    holding_bars: mode === 'mean_revert_guard' ? 18 : 36,
                    min_score: minScore,
                    min_property_score: minPropertyScore,
                    min_q: mode === 'mean_revert_guard' ? 0.54 : 0.58,
                    min_cavity: minCavity,
                    max_b_sigma: maxBSigma,
                    max_eta: maxEta,
                    side_policy: sidePolicy,
                    exit_mode: exitMode,
                    mode,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return rows;
}

function selectParam(symbol: SymbolName, rows: FeatureRow[], family: FeatureFamily) {
  const trainEnd = Math.floor(rows.length * 0.5);
  const valEnd = Math.floor(rows.length * 0.75);
  const ranked: Array<{ params: ParamSet; train: Metrics; validation: Metrics; score: number }> = [];
  for (const params of paramGrid(symbol, family)) {
    const trainTrades = simulate(symbol, rows, params, 'train', 0, trainEnd).trades;
    const validationTrades = simulate(symbol, rows, params, 'validation', trainEnd, valEnd).trades;
    const train = metrics(trainTrades);
    const validation = metrics(validationTrades);
    if (train.trades < 8 || validation.trades < 3) continue;
    const validationPnlPerTrade = validation.net_pnl_usd / Math.max(validation.trades, 1);
    const pfScore = Math.min(validation.profit_factor, 3.5) + Math.min(train.profit_factor, 2.5) * 0.18;
    const pnlScore = validationPnlPerTrade / 18;
    const ddPenalty = Math.abs(validation.max_drawdown_usd) / 900;
    const overfitPenalty = Math.max(0, train.profit_factor - validation.profit_factor - 1.25) * 0.20;
    const stopLossPenalty = validationTrades.filter((trade) => trade.exit_reason === 'stop_loss').length / Math.max(validationTrades.length, 1) * 0.70;
    ranked.push({ params, train, validation, score: pfScore + pnlScore - ddPenalty - overfitPenalty - stopLossPenalty });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) throw new Error(`No viable parameter set for ${symbol} ${family}`);
  return { best: ranked[0], ranked: ranked.slice(0, 25), trainEnd, valEnd };
}

function equitySvg(trades: Trade[]) {
  const width = 1200;
  const height = 520;
  const pad = 52;
  let equity = 0;
  const points = trades.map((trade, index) => {
    equity += trade.pnl_usd;
    return { x: index, y: equity };
  });
  if (!points.length) return '';
  const minY = Math.min(0, ...points.map((point) => point.y));
  const maxY = Math.max(1, ...points.map((point) => point.y));
  const xMax = Math.max(points.length - 1, 1);
  const d = points.map((point, index) => {
    const x = pad + (point.x / xMax) * (width - pad * 2);
    const y = height - pad - ((point.y - minY) / Math.max(maxY - minY, 1)) * (height - pad * 2);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const zeroY = height - pad - ((0 - minY) / Math.max(maxY - minY, 1)) * (height - pad * 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#06110f"/>
  <text x="${pad}" y="36" fill="#eafff7" font-size="22" font-family="Arial" font-weight="700">${VERSION} test equity curve</text>
  <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${width - pad}" y2="${zeroY.toFixed(1)}" stroke="#365850" stroke-width="1"/>
  <path d="${d}" fill="none" stroke="#78f1c4" stroke-width="3"/>
  <text x="${pad}" y="${height - 16}" fill="#a4bdb6" font-size="14" font-family="Arial">test trades=${trades.length} | final_pnl=${equity.toFixed(2)} | min=${minY.toFixed(2)} | max=${maxY.toFixed(2)}</text>
</svg>`;
}

async function writeOutputs(payload: {
  summaryRows: Record<string, unknown>[];
  selectedParams: Record<string, unknown>[];
  allTrades: Trade[];
  failureRows: Record<string, unknown>[];
  coverageRows: Record<string, unknown>[];
  topRows: Record<string, unknown>[];
  comparisonRows: Record<string, unknown>[];
  source: Record<string, unknown>;
}) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_summary.csv'), toCsv(payload.summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_selected_params.csv'), toCsv(payload.selectedParams));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_trades.csv'), toCsv(payload.allTrades as any));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_failure_modes.csv'), toCsv(payload.failureRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_sensor_coverage.csv'), toCsv(payload.coverageRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_top_candidates.csv'), toCsv(payload.topRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_family_comparison.csv'), toCsv(payload.comparisonRows));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V2_6_CryptoL2MetricsTrain.svg'), equitySvg(payload.allTrades.filter((trade) => trade.split === 'test' && trade.feature_family === 'l2_metrics')));

  const l2Test = metrics(payload.allTrades.filter((trade) => trade.split === 'test' && trade.feature_family === 'l2_metrics'));
  const legacyTest = metrics(payload.allTrades.filter((trade) => trade.split === 'test' && trade.feature_family === 'legacy_price_volume'));
  const metricsOnlyTest = metrics(payload.allTrades.filter((trade) => trade.split === 'test' && trade.feature_family === 'metrics_only'));
  const l2Passed = l2Test.trades >= 6 && l2Test.net_pnl_usd > 0 && l2Test.profit_factor > 1.05;
  const summaryJson = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    online_page_changed: false,
    source: payload.source,
    cost: {
      notional_usd: NOTIONAL_USD,
      base_roundtrip_cost: BASE_ROUNDTRIP_COST,
      l2_cost_slope: L2_COST_SLOPE,
    },
    decision: {
      l2_metrics_passed_short_window: l2Passed,
      status: l2Passed ? 'local_l2_metrics_short_window_candidate' : 'not_ready_for_online',
      next_step: l2Passed
        ? 'extend Binance Vision L2 window and add liquidation history before online page'
        : 'do not deploy; extend L2 history and add liquidation/stablecoin sensors before further threshold tuning',
    },
    combined_test: {
      legacy_price_volume: legacyTest,
      metrics_only: metricsOnlyTest,
      l2_metrics: l2Test,
    },
    summary: payload.summaryRows,
    selected_params: payload.selectedParams,
    family_comparison: payload.comparisonRows,
    sensor_coverage: payload.coverageRows,
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_6_summary.json'), JSON.stringify(summaryJson, null, 2));

  const md = `# ${VERSION}

## 结论

本轮只做本地训练和样本外对照，没有改线上页面、没有部署。

V2.6 把 V2.5 的 Binance Vision \`bookDepth_5m\` 和 \`metrics_5m\` 接回 BTC/ETH 训练，并做三路对照：

1. \`legacy_price_volume\`：只用价格/成交量腔体，模拟 V2.3 之前的弱传感器。
2. \`metrics_only\`：接 OI、多空比、taker long/short ratio，但不用盘口深度。
3. \`l2_metrics\`：接 OI、多空比、taker long/short ratio 和真实 bookDepth 盘口腔体。

## 样本外合并结果

- legacy_price_volume: trades=${legacyTest.trades}, win=${pct(legacyTest.win_rate)}, pnl=$${legacyTest.net_pnl_usd}, PF=${legacyTest.profit_factor}, DD=$${legacyTest.max_drawdown_usd}
- metrics_only: trades=${metricsOnlyTest.trades}, win=${pct(metricsOnlyTest.win_rate)}, pnl=$${metricsOnlyTest.net_pnl_usd}, PF=${metricsOnlyTest.profit_factor}, DD=$${metricsOnlyTest.max_drawdown_usd}
- l2_metrics: trades=${l2Test.trades}, win=${pct(l2Test.win_rate)}, pnl=$${l2Test.net_pnl_usd}, PF=${l2Test.profit_factor}, DD=$${l2Test.max_drawdown_usd}

## 分标的结果

${payload.summaryRows.filter((row) => row.split === 'test').map((row) => `- ${row.symbol} / ${row.feature_family}: trades=${row.trades}, win=${pct(Number(row.win_rate))}, pnl=$${row.net_pnl_usd}, PF=${row.profit_factor}, DD=$${row.max_drawdown_usd}, status=${row.status}`).join('\n')}

## 与 V2.3 旧结果的关系

旧 V2.3 是 75 天窗口，本轮 V2.6 是 V2.5 的 14 天 L2 窗口，不能直接用绝对收益等同对比；因此本轮更重视同一窗口内的三路 family 对照。

- BTCUSDT V2.3 test: pnl=$${PRIOR_V23.BTCUSDT.test_net_pnl_usd}, PF=${PRIOR_V23.BTCUSDT.test_profit_factor}, trades=${PRIOR_V23.BTCUSDT.trades}
- ETHUSDT V2.3 test: pnl=$${PRIOR_V23.ETHUSDT.test_net_pnl_usd}, PF=${PRIOR_V23.ETHUSDT.test_profit_factor}, trades=${PRIOR_V23.ETHUSDT.trades}

## 判断

通过门槛暂定为：\`l2_metrics\` 样本外合并净收益为正、PF > 1.05、交易数 >= 6。

当前状态：${summaryJson.decision.status}

如果未通过，不应继续上线页面，也不应只调阈值；下一步应扩展更长 L2 历史并补清算历史、稳定币流入/流出。

## 输出文件

- hfcd_trading_v2_6_summary.json
- hfcd_trading_v2_6_summary.csv
- hfcd_trading_v2_6_selected_params.csv
- hfcd_trading_v2_6_trades.csv
- hfcd_trading_v2_6_failure_modes.csv
- hfcd_trading_v2_6_sensor_coverage.csv
- hfcd_trading_v2_6_family_comparison.csv
- hfcd_trading_v2_6_top_candidates.csv
- HFCD_Trading_V2_6_CryptoL2MetricsTrain.svg
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V2_6_CryptoL2MetricsTrain.md'), md);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const { summary, bookRows, metricRows } = await loadV25Inputs();
  const bookMap = bySymbolTs(bookRows);
  const metricsMap = bySymbolTs(metricRows);
  const featureBySymbol = new Map<SymbolName, FeatureRow[]>();
  const coverageRows: Record<string, unknown>[] = [];
  const source = {
    v2_5_dir: V25_DIR,
    date_start: summary.date_start,
    date_end: summary.date_end,
    book_depth_5m_rows: bookRows.length,
    metrics_5m_rows: metricRows.length,
    kline_source: 'Binance USD-M futures public klines',
    l2_source: 'Binance Vision futures um daily bookDepth',
    metrics_source: 'Binance Vision futures um daily metrics',
  };

  for (const symbol of SYMBOLS) {
    console.log(`[${VERSION}] loading ${symbol} ${summary.date_start} -> ${summary.date_end}`);
    const klines = await fetchKlines(symbol, summary.date_start, summary.date_end);
    const features = buildFeatures(symbol, klines, bookMap, metricsMap);
    if (features.length < 1500) throw new Error(`${symbol} insufficient joined feature rows: ${features.length}`);
    featureBySymbol.set(symbol, features);
    coverageRows.push({
      symbol,
      kline_rows: klines.length,
      joined_rows: features.length,
      book_depth_rows_joined: features.filter((row) => row.has_book_depth).length,
      metrics_rows_joined: features.filter((row) => row.has_metrics).length,
      joined_coverage_ratio: number(features.length / Math.max(klines.length, 1), 4),
      first_ts: features[0]?.ts,
      last_ts: features[features.length - 1]?.ts,
      liquidation_history: 'missing_in_v2_6',
      stablecoin_flow_history: 'not_used_in_training_v2_6',
    });
  }

  const btc = featureBySymbol.get('BTCUSDT') || [];
  const eth = featureBySymbol.get('ETHUSDT') || [];
  injectOmega(btc, eth);
  injectOmega(eth, btc);

  const summaryRows: Record<string, unknown>[] = [];
  const selectedParams: Record<string, unknown>[] = [];
  const failureRows: Record<string, unknown>[] = [];
  const topRows: Record<string, unknown>[] = [];
  const comparisonRows: Record<string, unknown>[] = [];
  const allTrades: Trade[] = [];

  for (const symbol of SYMBOLS) {
    const rows = featureBySymbol.get(symbol) || [];
    for (const family of ['legacy_price_volume', 'metrics_only', 'l2_metrics'] as FeatureFamily[]) {
      const selected = selectParam(symbol, rows, family);
      const params = selected.best.params;
      const train = simulate(symbol, rows, params, 'train', 0, selected.trainEnd);
      const validation = simulate(symbol, rows, params, 'validation', selected.trainEnd, selected.valEnd);
      const test = simulate(symbol, rows, params, 'test', selected.valEnd, rows.length - 1);
      const trainMetrics = metrics(train.trades);
      const valMetrics = metrics(validation.trades);
      const testMetrics = metrics(test.trades);
      allTrades.push(...train.trades, ...validation.trades, ...test.trades);
      selectedParams.push({
        symbol,
        feature_family: family,
        ...params,
        train_profit_factor: trainMetrics.profit_factor,
        validation_profit_factor: valMetrics.profit_factor,
        test_profit_factor: testMetrics.profit_factor,
        test_net_pnl_usd: testMetrics.net_pnl_usd,
        test_trades: testMetrics.trades,
        status: testMetrics.net_pnl_usd > 0 && testMetrics.profit_factor > 1.05 && testMetrics.trades >= 4 ? 'short_window_candidate' : 'blocked_or_watchlist',
      });
      for (const [split, metric] of [['train', trainMetrics], ['validation', valMetrics], ['test', testMetrics]] as const) {
        summaryRows.push({
          symbol,
          feature_family: family,
          split,
          selected_policy: params.policy_name,
          source_lineage: params.source_lineage,
          trades: metric.trades,
          win_rate: number(metric.win_rate, 4),
          net_pnl_usd: metric.net_pnl_usd,
          gross_profit_usd: metric.gross_profit_usd,
          gross_loss_usd: metric.gross_loss_usd,
          profit_factor: metric.profit_factor,
          max_drawdown_usd: metric.max_drawdown_usd,
          avg_pnl_usd: metric.avg_pnl_usd,
          trades_per_day: metric.trades_per_day,
          status: split === 'test' && metric.net_pnl_usd > 0 && metric.profit_factor > 1.05 && metric.trades >= 4 ? 'short_window_candidate' : split === 'test' ? 'not_ready_for_online' : 'fit_observation',
        });
      }
      const mergedFailures: Record<string, number> = {};
      for (const sourceFailures of [train.failureModes, validation.failureModes, test.failureModes]) {
        for (const [reason, count] of Object.entries(sourceFailures)) mergedFailures[reason] = (mergedFailures[reason] || 0) + count;
      }
      for (const [reason, count] of Object.entries(mergedFailures).sort((a, b) => b[1] - a[1])) {
        failureRows.push({ symbol, feature_family: family, reason, count });
      }
      for (const row of selected.ranked) {
        topRows.push({
          symbol,
          feature_family: family,
          rank_score: number(row.score, 4),
          policy_name: row.params.policy_name,
          mode: row.params.mode,
          exit_mode: row.params.exit_mode,
          side_policy: row.params.side_policy,
          min_score: row.params.min_score,
          min_property_score: row.params.min_property_score,
          min_cavity: row.params.min_cavity,
          max_b_sigma: row.params.max_b_sigma,
          max_eta: row.params.max_eta,
          train_trades: row.train.trades,
          train_pf: row.train.profit_factor,
          train_pnl: row.train.net_pnl_usd,
          validation_trades: row.validation.trades,
          validation_pf: row.validation.profit_factor,
          validation_pnl: row.validation.net_pnl_usd,
        });
      }
      comparisonRows.push({
        symbol,
        feature_family: family,
        validation_trades: valMetrics.trades,
        validation_net_pnl_usd: valMetrics.net_pnl_usd,
        validation_profit_factor: valMetrics.profit_factor,
        test_trades: testMetrics.trades,
        test_win_rate: testMetrics.win_rate,
        test_net_pnl_usd: testMetrics.net_pnl_usd,
        test_profit_factor: testMetrics.profit_factor,
        test_max_drawdown_usd: testMetrics.max_drawdown_usd,
      });
    }
  }

  allTrades.sort((a, b) => a.entry_ts.localeCompare(b.entry_ts));
  await writeOutputs({ summaryRows, selectedParams, allTrades, failureRows, coverageRows, topRows, comparisonRows, source });
  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
  console.table(summaryRows.filter((row) => row.split === 'test'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
