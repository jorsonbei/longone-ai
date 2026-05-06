import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AssetClass = 'gold_etf' | 'futures' | 'crypto' | 'equity_etf';
type Side = 1 | -1;

type MarketRow = {
  ts: string;
  close: number;
  volume: number;
};

type SymbolMeta = {
  symbol: string;
  name: string;
  asset_class: AssetClass;
};

type PropertyVector = {
  q_core: number;
  emergence: number;
  anti_entropy: number;
  consensus_lock: number;
  liquidity_cavity: number;
  policy_field: number;
  time_phase: number;
  information_phase: number;
  radius_regime: number;
};

type Profile = {
  q_core: number;
  emergence: number;
  anti_entropy: number;
  consensus_lock: number;
  liquidity_cavity: number;
  policy_field: number;
  time_phase: number;
  information_phase: number;
  radius_regime: number;
};

type Config = {
  hold: number;
  threshold: number;
  min_manifest: number;
  stop: number;
  take: number;
  strict_quantile: number;
};

type Trade = {
  asset_class: AssetClass;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  exit_ts: string;
  entry: number;
  exit: number;
  score: number;
  manifest: number;
  q_core: number;
  liquidity_cavity: number;
  policy_field: number;
  radius_regime: number;
  failure_mode: string;
  exit_reason: string;
  pnl_usd: number;
  correct: boolean;
};

const VERSION = 'HFCD_Trading_V1_5_NonlinearPropertyFusionLedger';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_5_nonlinear');
const DATA_DIR = path.join(OUT_DIR, 'market_data');
const NOTIONAL = 10_000;
const FEE = 0.0012;

const SYMBOLS: SymbolMeta[] = [
  { symbol: 'GLD', name: 'SPDR Gold Shares', asset_class: 'gold_etf' },
  { symbol: 'IAU', name: 'iShares Gold Trust', asset_class: 'gold_etf' },
  { symbol: 'GC=F', name: 'Gold Futures', asset_class: 'futures' },
  { symbol: 'CL=F', name: 'Crude Oil Futures', asset_class: 'futures' },
  { symbol: 'BTC-USD', name: 'Bitcoin', asset_class: 'crypto' },
  { symbol: 'ETH-USD', name: 'Ethereum', asset_class: 'crypto' },
  { symbol: 'SPY', name: 'S&P 500 ETF', asset_class: 'equity_etf' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', asset_class: 'equity_etf' },
];

const EXOGENOUS = ['^VIX', '^TNX', 'UUP', 'TLT', 'HYG', 'GLD', 'SPY', 'QQQ', 'BTC-USD', 'ETH-USD'];

const PROFILES: Record<AssetClass, Profile> = {
  gold_etf: {
    q_core: 0.10,
    emergence: 0.02,
    anti_entropy: 0.24,
    consensus_lock: 0.14,
    liquidity_cavity: 0.16,
    policy_field: 0.24,
    time_phase: 0.02,
    information_phase: 0.04,
    radius_regime: 0.04,
  },
  futures: {
    q_core: 0.06,
    emergence: 0.02,
    anti_entropy: 0.08,
    consensus_lock: 0.04,
    liquidity_cavity: 0.18,
    policy_field: 0.12,
    time_phase: 0.30,
    information_phase: 0.08,
    radius_regime: 0.12,
  },
  crypto: {
    q_core: 0.15,
    emergence: 0.08,
    anti_entropy: 0.10,
    consensus_lock: 0.22,
    liquidity_cavity: 0.20,
    policy_field: 0.08,
    time_phase: 0.03,
    information_phase: 0.08,
    radius_regime: 0.06,
  },
  equity_etf: {
    q_core: 0.14,
    emergence: 0.26,
    anti_entropy: 0.04,
    consensus_lock: 0.12,
    liquidity_cavity: 0.14,
    policy_field: 0.18,
    time_phase: 0.02,
    information_phase: 0.04,
    radius_regime: 0.06,
  },
};

const CONFIGS: Config[] = [];
for (const hold of [6, 12]) {
  for (const threshold of [0.12, 0.20]) {
    for (const min_manifest of [0.48, 0.60]) {
      for (const strict_quantile of [0.94, 0.97]) {
        for (const [stop, take] of [[0.012, 0.024], [0.018, 0.04]] as const) {
          CONFIGS.push({ hold, threshold, min_manifest, strict_quantile, stop, take });
        }
      }
    }
  }
}

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))].join('\n') + '\n';
}

function safeName(symbol: string) {
  return symbol.replace(/[^A-Z0-9]/gi, '_');
}

function parseCsv(text: string): MarketRow[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(',') || [];
  const tsIndex = headers.indexOf('ts');
  const closeIndex = headers.indexOf('close');
  const volumeIndex = headers.indexOf('volume');
  return lines
    .map((line) => {
      const parts = line.split(',');
      return {
        ts: parts[tsIndex],
        close: Number(parts[closeIndex]),
        volume: volumeIndex >= 0 ? Number(parts[volumeIndex]) : 0,
      };
    })
    .filter((row) => row.ts && Number.isFinite(row.close) && row.close > 0);
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
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

async function fetchYahoo(symbol: string): Promise<MarketRow[]> {
  const attempts = ['range=730d&interval=1h', 'range=1y&interval=1h', 'range=6mo&interval=1h'];
  let lastError = '';
  for (const query of attempts) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'HFCD-ThingNature-OS/1.0' },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload: any = await response.json();
      const result = payload?.chart?.result?.[0];
      const timestamps: number[] = result?.timestamp || [];
      const quote = result?.indicators?.quote?.[0] || {};
      const closes: Array<number | null> = quote.close || [];
      const volumes: Array<number | null> = quote.volume || [];
      const rows = timestamps
        .map((ts, index) => ({
          ts: new Date(ts * 1000).toISOString(),
          close: closes[index] === null ? NaN : Number(closes[index]),
          volume: volumes[index] === null ? 0 : Number(volumes[index] || 0),
        }))
        .filter((row) => Number.isFinite(row.close) && row.close > 0);
      if (rows.length >= 400) return rows;
      lastError = `only ${rows.length} rows for ${query}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Yahoo download failed for ${symbol}: ${lastError}`);
}

async function loadOrFetch(symbol: string) {
  await mkdir(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, `${safeName(symbol)}.csv`);
  try {
    const cached = parseCsv(await readFile(target, 'utf8'));
    if (cached.length >= 400) return cached;
  } catch {
    // fetch below
  }
  const rows = await fetchYahoo(symbol);
  await writeFile(target, toCsv(rows as unknown as Record<string, unknown>[]));
  return rows;
}

function latestBefore(rows: MarketRow[], ts: number) {
  let lo = 0;
  let hi = rows.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = new Date(rows[mid].ts).getTime();
    if (t <= ts) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
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

function exoRet(exo: Map<string, MarketRow[]>, symbol: string, ts: number, lag: number) {
  const rows = exo.get(symbol);
  if (!rows?.length) return 0;
  const index = latestBefore(rows, ts);
  return ret(rows, index, lag);
}

function exoLevel(exo: Map<string, MarketRow[]>, symbol: string, ts: number) {
  const rows = exo.get(symbol);
  if (!rows?.length) return 0;
  return rows[latestBefore(rows, ts)].close;
}

function propertyVector(meta: SymbolMeta, rows: MarketRow[], index: number, side: Side, exo: Map<string, MarketRow[]>): PropertyVector {
  const ts = new Date(rows[index].ts).getTime();
  const s = stats(rows, index);
  const trendAligned = [s.r6, s.r24, s.r168].filter((x) => side * x > 0).length;
  const q_core = clamp(0.25 + trendAligned * 0.19 + (side * s.r72 > 0 ? 0.12 : 0), 0, 1);
  const liquidity_cavity = clamp(0.45 + sigmoid(s.volumeZ) * 0.35 - Math.max(0, s.vol - 0.018) * 8, 0, 1);
  const radius_regime = clamp(1 - Math.max(0, s.radius - 3.2) / 3.2, 0, 1);
  const vix = exoLevel(exo, '^VIX', ts);
  const vixChange = exoRet(exo, '^VIX', ts, 24);
  const dollar = exoRet(exo, 'UUP', ts, 24);
  const rate = exoRet(exo, '^TNX', ts, 24);
  const bond = exoRet(exo, 'TLT', ts, 24);
  const credit = exoRet(exo, 'HYG', ts, 24);
  const spy = exoRet(exo, 'SPY', ts, 24);
  const qqq = exoRet(exo, 'QQQ', ts, 24);
  const btc = exoRet(exo, 'BTC-USD', ts, 24);
  const eth = exoRet(exo, 'ETH-USD', ts, 24);

  const riskOff = clamp(sigmoid((vix - 18) / 6 + vixChange * 8), 0, 1);
  const policyRelief = clamp(sigmoid((-dollar * 45) + (-rate * 25) + bond * 20), 0, 1);
  const riskAppetite = clamp(sigmoid(spy * 35 + qqq * 25 + credit * 40 - vixChange * 8), 0, 1);
  const cryptoConsensus = clamp(sigmoid((btc + eth) * 20 + s.volumeZ * 0.18), 0, 1);

  if (meta.asset_class === 'gold_etf') {
    return {
      q_core,
      emergence: clamp(sigmoid(side * s.r24 * 18) * 0.35, 0, 1),
      anti_entropy: side === 1 ? clamp(0.45 * riskOff + 0.35 * policyRelief + 0.20 * sigmoid(-dollar * 35), 0, 1) : clamp(1 - riskOff * 0.55 - policyRelief * 0.25, 0, 1),
      consensus_lock: clamp(0.55 + side * s.r168 * 8 + sigmoid(s.volumeZ) * 0.15, 0, 1),
      liquidity_cavity,
      policy_field: side === 1 ? policyRelief : clamp(1 - policyRelief + dollar * 8 + rate * 8, 0, 1),
      time_phase: clamp(0.45 + side * (s.r24 - s.r168) * 8, 0, 1),
      information_phase: side === 1 ? riskOff : riskAppetite,
      radius_regime,
    };
  }

  if (meta.asset_class === 'crypto') {
    return {
      q_core,
      emergence: clamp(cryptoConsensus * 0.65 + riskAppetite * 0.25 + sigmoid(s.volumeZ) * 0.10, 0, 1),
      anti_entropy: side === 1 ? clamp(0.35 + policyRelief * 0.25 + cryptoConsensus * 0.25 - riskOff * 0.15, 0, 1) : clamp(riskOff * 0.45 + (1 - cryptoConsensus) * 0.35, 0, 1),
      consensus_lock: side === 1 ? cryptoConsensus : clamp(1 - cryptoConsensus + riskOff * 0.2, 0, 1),
      liquidity_cavity,
      policy_field: side === 1 ? clamp(riskAppetite * 0.45 + policyRelief * 0.35 - riskOff * 0.2, 0, 1) : clamp(riskOff * 0.55 + (1 - policyRelief) * 0.25, 0, 1),
      time_phase: clamp(0.5 + side * (s.r24 - s.r168) * 5, 0, 1),
      information_phase: side === 1 ? clamp(cryptoConsensus * 0.65 + riskAppetite * 0.25, 0, 1) : clamp(riskOff * 0.55 + (1 - cryptoConsensus) * 0.25, 0, 1),
      radius_regime,
    };
  }

  if (meta.asset_class === 'equity_etf') {
    return {
      q_core,
      emergence: side === 1 ? clamp(riskAppetite * 0.55 + side * s.r168 * 5 + (qqq > spy ? 0.1 : 0), 0, 1) : clamp(riskOff * 0.5 + (spy < 0 ? 0.15 : 0), 0, 1),
      anti_entropy: side === 1 ? clamp(1 - riskOff, 0, 1) : riskOff,
      consensus_lock: clamp(0.5 + side * s.r168 * 6 + riskAppetite * 0.2, 0, 1),
      liquidity_cavity,
      policy_field: side === 1 ? clamp(policyRelief * 0.45 + riskAppetite * 0.35, 0, 1) : clamp(riskOff * 0.55 + (1 - policyRelief) * 0.2, 0, 1),
      time_phase: clamp(0.45 + side * (s.r24 - s.r168) * 5, 0, 1),
      information_phase: side === 1 ? riskAppetite : riskOff,
      radius_regime,
    };
  }

  return {
    q_core,
    emergence: clamp(sigmoid(side * s.r24 * 12), 0, 1),
    anti_entropy: meta.symbol === 'GC=F' ? (side === 1 ? riskOff : 1 - riskOff) : clamp(side === 1 ? riskAppetite : riskOff, 0, 1),
    consensus_lock: clamp(0.5 + side * s.r72 * 6, 0, 1),
    liquidity_cavity,
    policy_field: clamp(meta.symbol === 'GC=F' ? (side === 1 ? policyRelief : 1 - policyRelief) : riskAppetite, 0, 1),
    time_phase: clamp(0.5 + side * (s.r6 - s.r72) * 8 + sigmoid(s.volumeZ) * 0.1, 0, 1),
    information_phase: meta.symbol === 'GC=F' ? (side === 1 ? riskOff : riskAppetite) : riskAppetite,
    radius_regime,
  };
}

function fusionScore(meta: SymbolMeta, pv: PropertyVector) {
  const profile = PROFILES[meta.asset_class];
  const base = Object.entries(profile).reduce((sum, [key, weight]) => sum + pv[key as keyof PropertyVector] * weight, 0);
  const coreResonance = Math.min(pv.q_core, pv.liquidity_cavity, pv.policy_field, pv.radius_regime);
  const assetResonance =
    meta.asset_class === 'crypto'
      ? Math.min(pv.consensus_lock, pv.liquidity_cavity, pv.radius_regime, pv.policy_field)
      : meta.asset_class === 'gold_etf'
        ? Math.min(pv.anti_entropy, pv.policy_field, pv.liquidity_cavity, pv.radius_regime)
        : meta.asset_class === 'equity_etf'
          ? Math.min(pv.emergence, pv.policy_field, pv.liquidity_cavity, pv.radius_regime)
          : Math.min(pv.time_phase, pv.liquidity_cavity, pv.radius_regime, pv.policy_field);
  const resonanceMultiplier = 0.72 + coreResonance * 0.38 + assetResonance * 0.55;
  const cavityGate = pv.liquidity_cavity < 0.35 || pv.radius_regime < 0.35 ? 0 : Math.min(1, 0.55 + pv.liquidity_cavity * 0.28 + pv.radius_regime * 0.22);
  return base * resonanceMultiplier * cavityGate;
}

function failureMode(pv: PropertyVector, score: number, threshold: number, manifest: number) {
  if (pv.liquidity_cavity < 0.35) return '熔断：流动性腔体枯竭';
  if (pv.radius_regime < 0.35) return '熔断：半径越界';
  if (pv.liquidity_cavity < 0.48) return '流动性腔体不足';
  if (pv.policy_field < 0.42) return '政策势场逆风';
  if (pv.radius_regime < 0.46) return '半径越界';
  if (pv.q_core < 0.44) return '身份核不稳';
  if (pv.information_phase < 0.38) return '信息相位不确认';
  if (manifest < 0.48) return '显化门不足';
  if (score < threshold) return '物性融合分数不足';
  return '通过';
}

function scoreSide(meta: SymbolMeta, rows: MarketRow[], index: number, side: Side, exo: Map<string, MarketRow[]>) {
  const pv = propertyVector(meta, rows, index, side, exo);
  const score = fusionScore(meta, pv);
  const manifest = Math.min(pv.q_core, pv.liquidity_cavity, pv.policy_field, pv.radius_regime);
  return { pv, score, manifest, failure: failureMode(pv, score, 0, manifest) };
}

function candidateScores(meta: SymbolMeta, rows: MarketRow[], start: number, end: number, exo: Map<string, MarketRow[]>) {
  const scores: number[] = [];
  for (let i = 200; i < rows.length - 25; i += 1) {
    const ts = new Date(rows[i].ts).getTime();
    if (ts < start || ts > end) continue;
    const long = scoreSide(meta, rows, i, 1, exo);
    const short = scoreSide(meta, rows, i, -1, exo);
    scores.push(Math.max(long.score, short.score));
  }
  return scores;
}

function simulate(meta: SymbolMeta, rows: MarketRow[], cfg: Config, threshold: number, start: number, end: number, exo: Map<string, MarketRow[]>) {
  const trades: Trade[] = [];
  const failures: Record<string, number> = {};
  let i = 200;
  while (i < rows.length - cfg.hold - 1) {
    const ts = new Date(rows[i].ts).getTime();
    if (ts < start) {
      i += 1;
      continue;
    }
    if (ts > end) break;
    const long = scoreSide(meta, rows, i, 1, exo);
    const short = scoreSide(meta, rows, i, -1, exo);
    const side: Side = long.score >= short.score ? 1 : -1;
    const chosen = side === 1 ? long : short;
    const dynamicThreshold = Math.max(cfg.threshold, threshold);
    const mode = failureMode(chosen.pv, chosen.score, dynamicThreshold, chosen.manifest);
    if (chosen.score < dynamicThreshold || chosen.manifest < cfg.min_manifest || mode !== '通过') {
      const reason = chosen.manifest < cfg.min_manifest ? '显化门不足' : mode;
      failures[reason] = (failures[reason] || 0) + 1;
      i += 1;
      continue;
    }
    const entry = rows[i].close;
    let exitIndex = i + cfg.hold;
    let exitReason = '时间到期';
    for (let j = i + 1; j <= i + cfg.hold; j += 1) {
      const directional = side * (rows[j].close / entry - 1);
      if (directional <= -cfg.stop) {
        exitIndex = j;
        exitReason = '止损';
        break;
      }
      if (directional >= cfg.take) {
        exitIndex = j;
        exitReason = '止盈';
        break;
      }
    }
    const raw = rows[exitIndex].close / entry - 1;
    const directional = side * raw;
    const net = directional - FEE;
    trades.push({
      asset_class: meta.asset_class,
      symbol: meta.symbol,
      side: side === 1 ? 'long' : 'short',
      entry_ts: rows[i].ts,
      exit_ts: rows[exitIndex].ts,
      entry,
      exit: rows[exitIndex].close,
      score: chosen.score,
      manifest: chosen.manifest,
      q_core: chosen.pv.q_core,
      liquidity_cavity: chosen.pv.liquidity_cavity,
      policy_field: chosen.pv.policy_field,
      radius_regime: chosen.pv.radius_regime,
      failure_mode: '通过',
      exit_reason: exitReason,
      pnl_usd: net * NOTIONAL,
      correct: directional > 0,
    });
    i = exitIndex + 1;
  }
  return { trades, failures };
}

function summarize(trades: Trade[]) {
  const pnl = trades.map((trade) => trade.pnl_usd);
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
    trades: trades.length,
    win_rate: trades.length ? trades.filter((trade) => trade.pnl_usd > 0).length / trades.length : 0,
    direction_accuracy: trades.length ? trades.filter((trade) => trade.correct).length / trades.length : 0,
    net_pnl_usd: pnl.reduce((sum, x) => sum + x, 0),
    max_drawdown_usd: maxDrawdown,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    avg_manifest: mean(trades.map((trade) => trade.manifest)),
  };
}

function objective(s: ReturnType<typeof summarize>) {
  if (s.trades < 8) return -Infinity;
  return s.net_pnl_usd + s.profit_factor * 700 + s.win_rate * 500 - Math.abs(s.max_drawdown_usd) * 0.45 + s.avg_manifest * 300;
}

function timeBounds(rowsList: MarketRow[][]) {
  const times = rowsList.flatMap((rows) => rows.map((row) => new Date(row.ts).getTime())).sort((a, b) => a - b);
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const data = new Map<string, MarketRow[]>();
  const exo = new Map<string, MarketRow[]>();
  const allSymbols = [...new Set([...SYMBOLS.map((meta) => meta.symbol), ...EXOGENOUS])];
  for (const symbol of allSymbols) {
    try {
      const rows = await loadOrFetch(symbol);
      data.set(symbol, rows);
      exo.set(symbol, rows);
      console.log(`[data] ${symbol} rows=${rows.length}`);
    } catch (error) {
      console.warn(`[data] ${symbol} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const available = SYMBOLS.filter((meta) => (data.get(meta.symbol)?.length || 0) >= 500);
  const walkRows: Record<string, unknown>[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  const failureRows: Record<string, unknown>[] = [];
  const propertyRows: Record<string, unknown>[] = [];
  const configs: Record<string, unknown> = {};

  console.log(`[${VERSION}] symbols=${available.length}; configs=${CONFIGS.length}`);

  for (const assetClass of ['gold_etf', 'futures', 'crypto', 'equity_etf'] as const) {
    const metas = available.filter((meta) => meta.asset_class === assetClass);
    if (!metas.length) continue;
    const bounds = timeBounds(metas.map((meta) => data.get(meta.symbol) || []));
    const wfTrades: Trade[] = [];
    const wfFailures: Record<string, number> = {};
    let lastBest = { cfg: CONFIGS[0], threshold: 0 };
    for (let fold = 1; fold <= 4; fold += 1) {
      let best: { cfg: Config; threshold: number; train: ReturnType<typeof summarize>; score: number } | null = null;
      for (const cfg of CONFIGS) {
        const thresholds = metas.map((meta) => quantile(candidateScores(meta, data.get(meta.symbol) || [], bounds[0], bounds[fold], exo), cfg.strict_quantile));
        const threshold = Math.max(cfg.threshold, mean(thresholds));
        const trades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], cfg, threshold, bounds[0], bounds[fold], exo).trades);
        const train = summarize(trades);
        const score = objective(train);
        if (!best || score > best.score) best = { cfg, threshold, train, score };
      }
      if (!best) continue;
      lastBest = { cfg: best.cfg, threshold: best.threshold };
      const testResults = metas.map((meta) => simulate(meta, data.get(meta.symbol) || [], best.cfg, best.threshold, bounds[fold], bounds[fold + 1], exo));
      const testTrades = testResults.flatMap((result) => result.trades);
      for (const result of testResults) {
        for (const [reason, count] of Object.entries(result.failures)) wfFailures[reason] = (wfFailures[reason] || 0) + count;
      }
      const test = summarize(testTrades);
      wfTrades.push(...testTrades);
      console.log(`[${assetClass}] fold=${fold} trades=${test.trades} pnl=${test.net_pnl_usd.toFixed(0)} pf=${test.profit_factor.toFixed(2)} win=${pct(test.win_rate)} threshold=${best.threshold.toFixed(3)}`);
      walkRows.push({
        asset_class: assetClass,
        fold,
        config: JSON.stringify(best.cfg),
        threshold: best.threshold,
        train_trades: best.train.trades,
        train_win_rate: best.train.win_rate,
        train_net_pnl_usd: best.train.net_pnl_usd,
        train_profit_factor: best.train.profit_factor,
        test_trades: test.trades,
        test_win_rate: test.win_rate,
        test_net_pnl_usd: test.net_pnl_usd,
        test_max_drawdown_usd: test.max_drawdown_usd,
        test_profit_factor: test.profit_factor,
      });
    }
    const wf = summarize(wfTrades);
    for (const [reason, count] of Object.entries(wfFailures).sort((a, b) => b[1] - a[1])) failureRows.push({ asset_class: assetClass, reason, count });
    for (const trade of wfTrades.slice(0, 1500)) {
      propertyRows.push({
        asset_class: trade.asset_class,
        symbol: trade.symbol,
        side: trade.side,
        entry_ts: trade.entry_ts,
        score: trade.score,
        manifest: trade.manifest,
        q_core: trade.q_core,
        liquidity_cavity: trade.liquidity_cavity,
        policy_field: trade.policy_field,
        radius_regime: trade.radius_regime,
        pnl_usd: trade.pnl_usd,
        exit_reason: trade.exit_reason,
      });
    }
    const status = wf.net_pnl_usd > 0 && wf.win_rate >= 0.54 && wf.profit_factor >= 1.15 && wf.trades >= 20
      ? 'property_validation_pass'
      : wf.net_pnl_usd > 0 && wf.profit_factor >= 1.03
        ? 'watchlist_retest'
        : 'blocked';
    configs[assetClass] = {
      ...lastBest.cfg,
      threshold: Number(lastBest.threshold.toFixed(6)),
      status,
      walk_forward_trades: wf.trades,
      walk_forward_win_rate: Number(wf.win_rate.toFixed(4)),
      walk_forward_net_pnl_usd: Number(wf.net_pnl_usd.toFixed(2)),
      walk_forward_profit_factor: Number(wf.profit_factor.toFixed(4)),
    };
    summaryRows.push({
      asset_class: assetClass,
      status,
      symbols: metas.map((meta) => meta.symbol).join('|'),
      walk_forward_trades: wf.trades,
      walk_forward_win_rate: wf.win_rate,
      walk_forward_direction_accuracy: wf.direction_accuracy,
      walk_forward_net_pnl_usd: wf.net_pnl_usd,
      walk_forward_max_drawdown_usd: wf.max_drawdown_usd,
      walk_forward_profit_factor: wf.profit_factor,
      avg_manifest: wf.avg_manifest,
    });
  }

  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_training_only_not_deployed',
    design: 'PropertyVector -> AssetPropertyProfile -> nonlinear resonance multiplier -> cavity/radius hard gate -> FailureMode -> walk-forward validation.',
    property_names_cn: ['身份核稳定度', '涌现增长力', '抗熵避险力', '共识锁强度', '流动性腔体', '政策势场', '时间相位', '信息情绪相位', '半径/市场状态'],
    summary: summaryRows,
    candidate_config: configs,
    deployable_count: summaryRows.filter((row: any) => row.status === 'property_validation_pass').length,
    watchlist_count: summaryRows.filter((row: any) => row.status === 'watchlist_retest').length,
    blocked_count: summaryRows.filter((row: any) => row.status === 'blocked').length,
  };

  const md = `# ${VERSION}

## 核心设计

V1.5 非线性版不再直接用价格序列交易，而是先为每个资产计算 9 个金融物性：

1. 身份核稳定度
2. 涌现增长力
3. 抗熵避险力
4. 共识锁强度
5. 流动性腔体
6. 政策势场
7. 时间相位
8. 信息情绪相位
9. 半径/市场状态

每类资产使用不同物性权重，再融合成多头/空头分数。融合公式不再是线性加分，而是：

\`\`\`text
物性融合分数 = 资产专属基础分 × 共振乘数 × 腔体/半径熔断门
\`\`\`

如果流动性腔体或半径/市场状态低于硬阈值，直接熔断拒绝交易。

## 物性论映射

| 物性论核心 | 金融映射 |
|---|---|
| Q中心守恒 | 身份核稳定度 |
| Hopfion拓扑保护 | 共识锁强度、抗熵避险力 |
| 空化强度 | 信息情绪相位、短期波动 |
| 腔体调和 | 流动性腔体 |
| Regime切换 | 政策势场、时间相位 |
| 能量中性核提升 | 半径/市场状态 |
| 金融衍生物性 | 持仓/杠杆结构、基差/期限结构、市场上涨广度 |

## 结果

| 资产类 | 状态 | 标的 | 交易数 | 胜率 | 方向命中 | 净收益 | 最大回撤 | Profit Factor | 平均显化门 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
${summaryRows.map((row: any) => `| ${row.asset_class} | ${row.status} | ${row.symbols} | ${row.walk_forward_trades} | ${pct(Number(row.walk_forward_win_rate || 0))} | ${pct(Number(row.walk_forward_direction_accuracy || 0))} | $${Number(row.walk_forward_net_pnl_usd || 0).toFixed(0)} | $${Number(row.walk_forward_max_drawdown_usd || 0).toFixed(0)} | ${Number(row.walk_forward_profit_factor || 0).toFixed(2)} | ${Number(row.avg_manifest || 0).toFixed(3)} |`).join('\n')}

## 上线纪律

本轮是本地训练验证，不推线上。只有 \`property_validation_pass\` 且下一轮 paper replay 继续为正，才允许写入线上交易配置。
`;

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_5_walk_forward.csv'), toCsv(walkRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_5_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_5_failure_modes.csv'), toCsv(failureRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_5_property_samples.csv'), toCsv(propertyRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_5_candidate_config.json'), JSON.stringify(configs, null, 2));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_5_summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_5_PropertyFusionLedger.md'), md);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
