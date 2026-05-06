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
  feed_key?: string;
};

type TimedMetric = {
  ts: string;
  value: number;
};

type TrueFeedPoint = {
  funding: number;
  open_interest_change: number;
  long_short_bias: number;
  cot_net: number;
  basis: number;
  breadth: number;
  real_rate_pressure: number;
  dollar_pressure: number;
  feed_quality: number;
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
  leverage_structure: number;
  basis_structure: number;
  breadth_structure: number;
  feed_quality: number;
};

type Profile = Omit<PropertyVector, 'feed_quality'>;

type Config = {
  hold: number;
  threshold: number;
  min_manifest: number;
  strict_quantile: number;
  stop: number;
  take: number;
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
  feed_quality: number;
  q_core: number;
  liquidity_cavity: number;
  leverage_structure: number;
  basis_structure: number;
  breadth_structure: number;
  failure_mode: string;
  exit_reason: string;
  pnl_usd: number;
  correct: boolean;
};

const VERSION = 'HFCD_Trading_V1_6_TruePropertyFeeds';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_6_true_feeds');
const DATA_DIR = path.join(OUT_DIR, 'market_data');
const NOTIONAL = 10_000;
const FEE = 0.0014;

const SYMBOLS: SymbolMeta[] = [
  { symbol: 'GLD', name: 'SPDR Gold Shares', asset_class: 'gold_etf' },
  { symbol: 'IAU', name: 'iShares Gold Trust', asset_class: 'gold_etf' },
  { symbol: 'GC=F', name: 'Gold Futures', asset_class: 'futures', feed_key: 'gold' },
  { symbol: 'CL=F', name: 'Crude Oil Futures', asset_class: 'futures', feed_key: 'crude' },
  { symbol: 'BTC-USD', name: 'Bitcoin', asset_class: 'crypto', feed_key: 'BTCUSDT' },
  { symbol: 'ETH-USD', name: 'Ethereum', asset_class: 'crypto', feed_key: 'ETHUSDT' },
  { symbol: 'SPY', name: 'S&P 500 ETF', asset_class: 'equity_etf' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', asset_class: 'equity_etf' },
];

const EXOGENOUS = [
  '^VIX',
  '^TNX',
  'DX-Y.NYB',
  'UUP',
  'TLT',
  'HYG',
  'TIP',
  'RSP',
  'SPY',
  'QQQ',
  'GLD',
  'USO',
  'XLF',
  'XLK',
  'XLE',
  'XLV',
  'XLI',
  'XLY',
  'XLP',
  'XLU',
  'BTC-USD',
  'ETH-USD',
];

const PROFILES: Record<AssetClass, Profile> = {
  gold_etf: {
    q_core: 0.08,
    emergence: 0.01,
    anti_entropy: 0.22,
    consensus_lock: 0.08,
    liquidity_cavity: 0.14,
    policy_field: 0.18,
    time_phase: 0.03,
    information_phase: 0.05,
    radius_regime: 0.06,
    leverage_structure: 0.05,
    basis_structure: 0.07,
    breadth_structure: 0.03,
  },
  futures: {
    q_core: 0.05,
    emergence: 0.02,
    anti_entropy: 0.06,
    consensus_lock: 0.03,
    liquidity_cavity: 0.15,
    policy_field: 0.08,
    time_phase: 0.20,
    information_phase: 0.06,
    radius_regime: 0.09,
    leverage_structure: 0.13,
    basis_structure: 0.10,
    breadth_structure: 0.03,
  },
  crypto: {
    q_core: 0.09,
    emergence: 0.06,
    anti_entropy: 0.07,
    consensus_lock: 0.14,
    liquidity_cavity: 0.15,
    policy_field: 0.06,
    time_phase: 0.04,
    information_phase: 0.08,
    radius_regime: 0.07,
    leverage_structure: 0.16,
    basis_structure: 0.03,
    breadth_structure: 0.05,
  },
  equity_etf: {
    q_core: 0.10,
    emergence: 0.18,
    anti_entropy: 0.04,
    consensus_lock: 0.09,
    liquidity_cavity: 0.12,
    policy_field: 0.13,
    time_phase: 0.03,
    information_phase: 0.05,
    radius_regime: 0.07,
    leverage_structure: 0.04,
    basis_structure: 0.02,
    breadth_structure: 0.13,
  },
};

const CONFIGS: Config[] = [];
for (const hold of [6, 12, 24]) {
  for (const threshold of [0.18, 0.28]) {
    for (const min_manifest of [0.46, 0.60]) {
      for (const strict_quantile of [0.92, 0.97]) {
        for (const [stop, take] of [
          [0.012, 0.024],
          [0.02, 0.045],
        ] as const) {
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
      return { ts: parts[tsIndex], close: Number(parts[closeIndex]), volume: Number(parts[volumeIndex] || 0) };
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

async function fetchText(url: string, source: string) {
  const response = await fetch(url, {
    headers: {
      accept: '*/*',
      'user-agent': 'Mozilla/5.0 HFCD-ThingNature-OS/1.0',
    },
  });
  if (!response.ok) throw new Error(`${source} ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson<T>(url: string, source: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 HFCD-ThingNature-OS/1.0',
    },
  });
  if (!response.ok) throw new Error(`${source} ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function fetchYahoo(symbol: string): Promise<MarketRow[]> {
  const attempts = ['range=730d&interval=1h', 'range=1y&interval=1h', 'range=6mo&interval=1h'];
  let lastError = '';
  for (const query of attempts) {
    try {
      const payload: any = await fetchJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`,
        `Yahoo ${symbol}`,
      );
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
      if (rows.length >= 300) return rows;
      lastError = `only ${rows.length} rows for ${query}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Yahoo download failed for ${symbol}: ${lastError}`);
}

async function loadOrFetchYahoo(symbol: string) {
  await mkdir(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, `${safeName(symbol)}.csv`);
  try {
    const cached = parseCsv(await readFile(target, 'utf8'));
    if (cached.length >= 300) return cached;
  } catch {
    // fetch below
  }
  const rows = await fetchYahoo(symbol);
  await writeFile(target, toCsv(rows as unknown as Record<string, unknown>[]));
  return rows;
}

async function loadBinanceMetric(symbol: string, kind: 'funding' | 'oi' | 'longshort'): Promise<TimedMetric[]> {
  await mkdir(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, `binance_${symbol}_${kind}.csv`);
  try {
    const rows = (await readFile(target, 'utf8')).trim().split(/\r?\n/).slice(1).map((line) => {
      const [ts, value] = line.split(',');
      return { ts, value: Number(value) };
    }).filter((row) => row.ts && Number.isFinite(row.value));
    if (rows.length >= 100) return rows;
  } catch {
    // fetch below
  }

  let rows: TimedMetric[] = [];
  if (kind === 'funding') {
    const payload = await fetchJson<Array<{ fundingTime: number; fundingRate: string }>>(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1000`,
      `Binance funding ${symbol}`,
    );
    rows = payload.map((row) => ({ ts: new Date(row.fundingTime).toISOString(), value: Number(row.fundingRate) }));
  } else if (kind === 'oi') {
    const payload = await fetchJson<Array<{ timestamp: number; sumOpenInterestValue: string }>>(
      `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=500`,
      `Binance open interest ${symbol}`,
    );
    rows = payload.map((row) => ({ ts: new Date(row.timestamp).toISOString(), value: Number(row.sumOpenInterestValue) }));
  } else {
    const payload = await fetchJson<Array<{ timestamp: number; longShortRatio: string }>>(
      `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=500`,
      `Binance long short ${symbol}`,
    );
    rows = payload.map((row) => ({ ts: new Date(row.timestamp).toISOString(), value: Number(row.longShortRatio) }));
  }
  await writeFile(target, toCsv(rows as unknown as Record<string, unknown>[]));
  return rows;
}

function parseCftcLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else current += char;
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/^"|"$/g, '').trim());
}

async function loadCftcCot() {
  await mkdir(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, 'cftc_disagg_cot.csv');
  let text = '';
  try {
    text = await readFile(target, 'utf8');
    if (text.length < 1000) throw new Error('short cache');
  } catch {
    text = await fetchText('https://www.cftc.gov/dea/newcot/f_disagg.txt', 'CFTC disaggregated COT');
    await writeFile(target, text);
  }
  const wanted = [
    { key: 'gold', match: 'GOLD - COMMODITY EXCHANGE INC.' },
    { key: 'crude', match: 'CRUDE OIL, LIGHT SWEET - NEW YORK MERCANTILE EXCHANGE' },
  ];
  const out = new Map<string, TimedMetric[]>();
  for (const item of wanted) out.set(item.key, []);
  for (const line of text.split(/\r?\n/)) {
    for (const item of wanted) {
      if (!line.includes(item.match)) continue;
      const cells = parseCftcLine(line);
      const date = cells[2];
      const oi = Number(cells[6]);
      const moneyLong = Number(cells[12]);
      const moneyShort = Number(cells[13]);
      if (date && Number.isFinite(oi) && oi > 0 && Number.isFinite(moneyLong) && Number.isFinite(moneyShort)) {
        out.get(item.key)?.push({ ts: new Date(`${date}T00:00:00Z`).toISOString(), value: (moneyLong - moneyShort) / oi });
      }
    }
  }
  for (const rows of out.values()) rows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return out;
}

function latestIndex<T extends { ts: string }>(rows: T[] | undefined, ts: number) {
  if (!rows?.length) return -1;
  let lo = 0;
  let hi = rows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = new Date(rows[mid].ts).getTime();
    if (t <= ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function latestValue(rows: TimedMetric[] | undefined, ts: number) {
  const index = latestIndex(rows, ts);
  return index >= 0 ? rows![index].value : 0;
}

function metricChange(rows: TimedMetric[] | undefined, ts: number, lag: number) {
  const index = latestIndex(rows, ts);
  if (index < lag || !rows) return 0;
  const now = rows[index].value;
  const prior = rows[index - lag].value;
  return prior ? now / prior - 1 : 0;
}

function priceRet(rows: MarketRow[] | undefined, ts: number, lag: number) {
  const index = latestIndex(rows, ts);
  if (index < lag || !rows) return 0;
  const prior = rows[index - lag].close;
  return prior ? rows[index].close / prior - 1 : 0;
}

function priceLevel(rows: MarketRow[] | undefined, ts: number) {
  const index = latestIndex(rows, ts);
  return index >= 0 ? rows![index].close : 0;
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

function trueFeedPoint(
  meta: SymbolMeta,
  rows: MarketRow[],
  index: number,
  exo: Map<string, MarketRow[]>,
  binance: Map<string, Record<'funding' | 'oi' | 'longshort', TimedMetric[]>>,
  cot: Map<string, TimedMetric[]>,
): TrueFeedPoint {
  const ts = new Date(rows[index].ts).getTime();
  const feed = meta.feed_key ? binance.get(meta.feed_key) : undefined;
  const funding = latestValue(feed?.funding, ts);
  const oiChange = metricChange(feed?.oi, ts, 24);
  const longShort = latestValue(feed?.longshort, ts);
  const cotNet = meta.feed_key ? latestValue(cot.get(meta.feed_key), ts) : 0;
  const goldBasis = priceLevel(exo.get('GC=F'), ts) && priceLevel(exo.get('GLD'), ts)
    ? (priceLevel(exo.get('GC=F'), ts) / Math.max(priceLevel(exo.get('GLD'), ts) * 10, 1) - 1)
    : 0;
  const crudeBasis = priceLevel(exo.get('CL=F'), ts) && priceLevel(exo.get('USO'), ts)
    ? (priceLevel(exo.get('CL=F'), ts) / Math.max(priceLevel(exo.get('USO'), ts), 1) - 1)
    : 0;
  const rsp = priceRet(exo.get('RSP'), ts, 24);
  const spy = priceRet(exo.get('SPY'), ts, 24);
  const sectors = ['XLF', 'XLK', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU'].map((sym) => priceRet(exo.get(sym), ts, 24));
  const breadth = mean([rsp - spy, ...sectors.map((value) => (value > 0 ? 1 : 0))]);
  const nominalRate = priceRet(exo.get('^TNX'), ts, 24);
  const tips = priceRet(exo.get('TIP'), ts, 24);
  const dollar = priceRet(exo.get('DX-Y.NYB'), ts, 24) || priceRet(exo.get('UUP'), ts, 24);
  const qualityParts = [
    meta.asset_class === 'crypto' ? (feed?.funding?.length ? 1 : 0) : 1,
    meta.asset_class === 'crypto' ? (feed?.oi?.length ? 1 : 0) : 1,
    meta.asset_class === 'crypto' ? (feed?.longshort?.length ? 1 : 0) : 1,
    meta.asset_class === 'futures' ? (cot.get(meta.feed_key || '')?.length ? 1 : 0) : 1,
    meta.asset_class === 'equity_etf' ? (sectors.filter((x) => x !== 0).length >= 4 ? 1 : 0) : 1,
  ];
  return {
    funding,
    open_interest_change: oiChange,
    long_short_bias: longShort ? Math.log(longShort) : 0,
    cot_net: cotNet,
    basis: meta.feed_key === 'gold' ? goldBasis : meta.feed_key === 'crude' ? crudeBasis : 0,
    breadth,
    real_rate_pressure: -nominalRate + tips,
    dollar_pressure: dollar,
    feed_quality: mean(qualityParts),
  };
}

function propertyVector(
  meta: SymbolMeta,
  rows: MarketRow[],
  index: number,
  side: Side,
  exo: Map<string, MarketRow[]>,
  binance: Map<string, Record<'funding' | 'oi' | 'longshort', TimedMetric[]>>,
  cot: Map<string, TimedMetric[]>,
): PropertyVector {
  const ts = new Date(rows[index].ts).getTime();
  const s = stats(rows, index);
  const f = trueFeedPoint(meta, rows, index, exo, binance, cot);
  const trendAligned = [s.r6, s.r24, s.r168].filter((x) => side * x > 0).length;
  const q_core = clamp(0.22 + trendAligned * 0.18 + (side * s.r72 > 0 ? 0.12 : 0), 0, 1);
  const liquidity_cavity = clamp(0.36 + sigmoid(s.volumeZ) * 0.30 - Math.max(0, s.vol - 0.018) * 7 + f.feed_quality * 0.18, 0, 1);
  const radius_regime = clamp(1 - Math.max(0, s.radius - 3.0) / 3.2, 0, 1);
  const vix = priceLevel(exo.get('^VIX'), ts);
  const vixChange = priceRet(exo.get('^VIX'), ts, 24);
  const credit = priceRet(exo.get('HYG'), ts, 24);
  const spy = priceRet(exo.get('SPY'), ts, 24);
  const qqq = priceRet(exo.get('QQQ'), ts, 24);
  const btc = priceRet(exo.get('BTC-USD'), ts, 24);
  const eth = priceRet(exo.get('ETH-USD'), ts, 24);
  const riskOff = clamp(sigmoid((vix - 18) / 6 + vixChange * 8), 0, 1);
  const policyRelief = clamp(sigmoid(f.real_rate_pressure * 45 - f.dollar_pressure * 35), 0, 1);
  const riskAppetite = clamp(sigmoid(spy * 35 + qqq * 25 + credit * 40 - vixChange * 8), 0, 1);
  const cryptoConsensus = clamp(sigmoid((btc + eth) * 18 + s.volumeZ * 0.12), 0, 1);
  const leverageSafe = clamp(1 - sigmoid(f.open_interest_change * 16 + Math.abs(f.funding) * 3000 + Math.abs(f.long_short_bias) * 1.8 - 0.4), 0, 1);
  const cotSafe = clamp(1 - Math.abs(f.cot_net) * 2.2, 0, 1);
  const basisStructure = clamp(sigmoid(-side * f.basis * 4), 0, 1);
  const breadthStructure = clamp(sigmoid(side * f.breadth * 2.2 + (side === 1 ? riskAppetite : riskOff) - 0.4), 0, 1);

  if (meta.asset_class === 'crypto') {
    const crowdedLong = f.funding > 0.00025 || f.long_short_bias > 0.22 || f.open_interest_change > 0.08;
    return {
      q_core,
      emergence: side === 1 ? clamp(cryptoConsensus * 0.55 + breadthStructure * 0.20 + leverageSafe * 0.15, 0, 1) : clamp(riskOff * 0.35 + (1 - cryptoConsensus) * 0.25, 0, 1),
      anti_entropy: side === 1 ? clamp(policyRelief * 0.35 + leverageSafe * 0.25 + cryptoConsensus * 0.20, 0, 1) : clamp(riskOff * 0.35 + (crowdedLong ? 0.28 : 0), 0, 1),
      consensus_lock: side === 1 ? clamp(cryptoConsensus * 0.60 + leverageSafe * 0.22 + (f.funding > -0.0002 ? 0.10 : 0), 0, 1) : clamp((1 - cryptoConsensus) * 0.45 + (crowdedLong ? 0.30 : 0), 0, 1),
      liquidity_cavity,
      policy_field: side === 1 ? clamp(riskAppetite * 0.35 + policyRelief * 0.25 + leverageSafe * 0.22, 0, 1) : clamp(riskOff * 0.45 + (1 - leverageSafe) * 0.25, 0, 1),
      time_phase: clamp(0.48 + side * (s.r24 - s.r168) * 5, 0, 1),
      information_phase: side === 1 ? clamp(cryptoConsensus * 0.48 + riskAppetite * 0.25 + leverageSafe * 0.18, 0, 1) : clamp(riskOff * 0.42 + (1 - cryptoConsensus) * 0.22 + (crowdedLong ? 0.18 : 0), 0, 1),
      radius_regime,
      leverage_structure: side === 1 ? leverageSafe : clamp(0.45 + (1 - leverageSafe) * 0.45, 0, 1),
      basis_structure: 0.5,
      breadth_structure: breadthStructure,
      feed_quality: f.feed_quality,
    };
  }

  if (meta.asset_class === 'gold_etf') {
    const antiEntropy = clamp(riskOff * 0.30 + policyRelief * 0.34 + sigmoid(-f.dollar_pressure * 30) * 0.18 + cotSafe * 0.12, 0, 1);
    return {
      q_core,
      emergence: clamp(sigmoid(side * s.r24 * 16) * 0.30, 0, 1),
      anti_entropy: side === 1 ? antiEntropy : clamp(1 - antiEntropy + f.dollar_pressure * 8, 0, 1),
      consensus_lock: clamp(0.50 + side * s.r168 * 7 + cotSafe * 0.16, 0, 1),
      liquidity_cavity,
      policy_field: side === 1 ? policyRelief : clamp(1 - policyRelief + f.dollar_pressure * 10, 0, 1),
      time_phase: clamp(0.45 + side * (s.r24 - s.r168) * 7, 0, 1),
      information_phase: side === 1 ? riskOff : riskAppetite,
      radius_regime,
      leverage_structure: cotSafe,
      basis_structure: 0.55,
      breadth_structure: breadthStructure,
      feed_quality: f.feed_quality,
    };
  }

  if (meta.asset_class === 'equity_etf') {
    return {
      q_core,
      emergence: side === 1 ? clamp(riskAppetite * 0.42 + breadthStructure * 0.32 + side * s.r168 * 4, 0, 1) : clamp(riskOff * 0.45 + (1 - breadthStructure) * 0.25, 0, 1),
      anti_entropy: side === 1 ? clamp(1 - riskOff, 0, 1) : riskOff,
      consensus_lock: clamp(0.46 + side * s.r168 * 5 + breadthStructure * 0.20, 0, 1),
      liquidity_cavity,
      policy_field: side === 1 ? clamp(policyRelief * 0.35 + riskAppetite * 0.30 + breadthStructure * 0.15, 0, 1) : clamp(riskOff * 0.50 + (1 - policyRelief) * 0.18, 0, 1),
      time_phase: clamp(0.45 + side * (s.r24 - s.r168) * 5, 0, 1),
      information_phase: side === 1 ? riskAppetite : riskOff,
      radius_regime,
      leverage_structure: clamp(1 - riskOff * 0.55, 0, 1),
      basis_structure: 0.5,
      breadth_structure: breadthStructure,
      feed_quality: f.feed_quality,
    };
  }

  const cotDirectional = side === 1 ? clamp(0.50 + f.cot_net * 1.6, 0, 1) : clamp(0.50 - f.cot_net * 1.6, 0, 1);
  return {
    q_core,
    emergence: clamp(sigmoid(side * s.r24 * 12), 0, 1),
    anti_entropy: meta.feed_key === 'gold' ? (side === 1 ? riskOff : 1 - riskOff) : clamp(side === 1 ? riskAppetite : riskOff, 0, 1),
    consensus_lock: clamp(0.45 + side * s.r72 * 6 + cotDirectional * 0.20, 0, 1),
    liquidity_cavity,
    policy_field: clamp(meta.feed_key === 'gold' ? (side === 1 ? policyRelief : 1 - policyRelief) : riskAppetite, 0, 1),
    time_phase: clamp(0.46 + side * (s.r6 - s.r72) * 8 + sigmoid(s.volumeZ) * 0.08, 0, 1),
    information_phase: meta.feed_key === 'gold' ? (side === 1 ? riskOff : riskAppetite) : riskAppetite,
    radius_regime,
    leverage_structure: cotDirectional,
    basis_structure: basisStructure,
    breadth_structure: breadthStructure,
    feed_quality: f.feed_quality,
  };
}

function fusionScore(meta: SymbolMeta, pv: PropertyVector) {
  const profile = PROFILES[meta.asset_class];
  const base = Object.entries(profile).reduce((sum, [key, weight]) => sum + pv[key as keyof Profile] * weight, 0);
  const coreResonance = Math.min(pv.q_core, pv.liquidity_cavity, pv.policy_field, pv.radius_regime, pv.feed_quality);
  const assetResonance =
    meta.asset_class === 'crypto'
      ? Math.min(pv.consensus_lock, pv.leverage_structure, pv.liquidity_cavity, pv.radius_regime)
      : meta.asset_class === 'gold_etf'
        ? Math.min(pv.anti_entropy, pv.policy_field, pv.leverage_structure, pv.liquidity_cavity)
        : meta.asset_class === 'equity_etf'
          ? Math.min(pv.emergence, pv.breadth_structure, pv.policy_field, pv.liquidity_cavity)
          : Math.min(pv.time_phase, pv.basis_structure, pv.leverage_structure, pv.liquidity_cavity);
  const resonanceMultiplier = 0.70 + coreResonance * 0.36 + assetResonance * 0.62;
  const hardGate =
    pv.feed_quality < 0.55 || pv.liquidity_cavity < 0.34 || pv.radius_regime < 0.34 || pv.leverage_structure < 0.22
      ? 0
      : Math.min(1, 0.50 + pv.liquidity_cavity * 0.20 + pv.radius_regime * 0.18 + pv.feed_quality * 0.14 + pv.leverage_structure * 0.12);
  return base * resonanceMultiplier * hardGate;
}

function failureMode(pv: PropertyVector, score: number, threshold: number, manifest: number) {
  if (pv.feed_quality < 0.55) return '真实物性数据不足';
  if (pv.liquidity_cavity < 0.34) return '熔断：流动性腔体枯竭';
  if (pv.radius_regime < 0.34) return '熔断：半径越界';
  if (pv.leverage_structure < 0.22) return '杠杆/持仓结构过热';
  if (pv.liquidity_cavity < 0.48) return '流动性腔体不足';
  if (pv.policy_field < 0.42) return '政策势场逆风';
  if (pv.radius_regime < 0.46) return '半径越界';
  if (pv.q_core < 0.42) return '身份核不稳';
  if (pv.information_phase < 0.36) return '信息相位不确认';
  if (manifest < 0.46) return '显化门不足';
  if (score < threshold) return '物性融合分数不足';
  return '通过';
}

function scoreSide(
  meta: SymbolMeta,
  rows: MarketRow[],
  index: number,
  side: Side,
  exo: Map<string, MarketRow[]>,
  binance: Map<string, Record<'funding' | 'oi' | 'longshort', TimedMetric[]>>,
  cot: Map<string, TimedMetric[]>,
) {
  const pv = propertyVector(meta, rows, index, side, exo, binance, cot);
  const score = fusionScore(meta, pv);
  const manifest = Math.min(pv.q_core, pv.liquidity_cavity, pv.policy_field, pv.radius_regime, pv.leverage_structure, pv.feed_quality);
  return { pv, score, manifest };
}

function candidateScores(
  meta: SymbolMeta,
  rows: MarketRow[],
  start: number,
  end: number,
  exo: Map<string, MarketRow[]>,
  binance: Map<string, Record<'funding' | 'oi' | 'longshort', TimedMetric[]>>,
  cot: Map<string, TimedMetric[]>,
) {
  const scores: number[] = [];
  for (let i = 220; i < rows.length - 30; i += 1) {
    const ts = new Date(rows[i].ts).getTime();
    if (ts < start || ts > end) continue;
    const long = scoreSide(meta, rows, i, 1, exo, binance, cot);
    const short = scoreSide(meta, rows, i, -1, exo, binance, cot);
    scores.push(Math.max(long.score, short.score));
  }
  return scores;
}

function simulate(
  meta: SymbolMeta,
  rows: MarketRow[],
  cfg: Config,
  threshold: number,
  start: number,
  end: number,
  exo: Map<string, MarketRow[]>,
  binance: Map<string, Record<'funding' | 'oi' | 'longshort', TimedMetric[]>>,
  cot: Map<string, TimedMetric[]>,
) {
  const trades: Trade[] = [];
  const failures: Record<string, number> = {};
  let i = 220;
  while (i < rows.length - cfg.hold - 1) {
    const ts = new Date(rows[i].ts).getTime();
    if (ts < start) {
      i += 1;
      continue;
    }
    if (ts > end) break;
    const long = scoreSide(meta, rows, i, 1, exo, binance, cot);
    const short = scoreSide(meta, rows, i, -1, exo, binance, cot);
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
      feed_quality: chosen.pv.feed_quality,
      q_core: chosen.pv.q_core,
      liquidity_cavity: chosen.pv.liquidity_cavity,
      leverage_structure: chosen.pv.leverage_structure,
      basis_structure: chosen.pv.basis_structure,
      breadth_structure: chosen.pv.breadth_structure,
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
    avg_feed_quality: mean(trades.map((trade) => trade.feed_quality)),
  };
}

function objective(s: ReturnType<typeof summarize>) {
  if (s.trades < 8) return -Infinity;
  return s.net_pnl_usd + s.profit_factor * 900 + s.win_rate * 650 - Math.abs(s.max_drawdown_usd) * 0.5 + s.avg_feed_quality * 450;
}

function timeBounds(rowsList: MarketRow[][]) {
  const times = rowsList.flatMap((rows) => rows.map((row) => new Date(row.ts).getTime())).sort((a, b) => a - b);
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]);
}

async function loadAllData() {
  const data = new Map<string, MarketRow[]>();
  const exo = new Map<string, MarketRow[]>();
  const allSymbols = [...new Set([...SYMBOLS.map((meta) => meta.symbol), ...EXOGENOUS])];
  for (const symbol of allSymbols) {
    try {
      const rows = await loadOrFetchYahoo(symbol);
      data.set(symbol, rows);
      exo.set(symbol, rows);
      console.log(`[price] ${symbol} rows=${rows.length}`);
    } catch (error) {
      console.warn(`[price] ${symbol} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const binance = new Map<string, Record<'funding' | 'oi' | 'longshort', TimedMetric[]>>();
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    try {
      const funding = await loadBinanceMetric(symbol, 'funding');
      const oi = await loadBinanceMetric(symbol, 'oi');
      const longshort = await loadBinanceMetric(symbol, 'longshort');
      binance.set(symbol, { funding, oi, longshort });
      console.log(`[true-feed] Binance ${symbol} funding=${funding.length} oi=${oi.length} longshort=${longshort.length}`);
    } catch (error) {
      console.warn(`[true-feed] Binance ${symbol} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let cot = new Map<string, TimedMetric[]>();
  try {
    cot = await loadCftcCot();
    console.log(`[true-feed] CFTC gold=${cot.get('gold')?.length || 0} crude=${cot.get('crude')?.length || 0}`);
  } catch (error) {
    console.warn(`[true-feed] CFTC skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { data, exo, binance, cot };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const { data, exo, binance, cot } = await loadAllData();
  const available = SYMBOLS.filter((meta) => (data.get(meta.symbol)?.length || 0) >= 500);
  const walkRows: Record<string, unknown>[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  const failureRows: Record<string, unknown>[] = [];
  const propertyRows: Record<string, unknown>[] = [];
  const feedRows: Record<string, unknown>[] = [];
  const configs: Record<string, unknown> = {};

  for (const meta of available) {
    const rows = data.get(meta.symbol) || [];
    const sample = rows.slice(Math.max(0, rows.length - 300)).map((row, offset) => {
      const index = rows.length - 300 + offset;
      return trueFeedPoint(meta, rows, index, exo, binance, cot).feed_quality;
    });
    feedRows.push({ symbol: meta.symbol, asset_class: meta.asset_class, avg_recent_feed_quality: mean(sample), rows: rows.length });
  }

  console.log(`[${VERSION}] symbols=${available.length}; configs=${CONFIGS.length}`);

  for (const assetClass of ['gold_etf', 'futures', 'crypto', 'equity_etf'] as const) {
    const metas = available.filter((meta) => meta.asset_class === assetClass);
    if (!metas.length) continue;
    const bounds = timeBounds(metas.map((meta) => data.get(meta.symbol) || []));
    const wfTrades: Trade[] = [];
    const wfFailures: Record<string, number> = {};
    for (let fold = 1; fold <= 4; fold += 1) {
      let best: { cfg: Config; threshold: number; train: ReturnType<typeof summarize>; score: number } | null = null;
      for (const cfg of CONFIGS) {
        const thresholds = metas.map((meta) =>
          quantile(candidateScores(meta, data.get(meta.symbol) || [], bounds[0], bounds[fold], exo, binance, cot), cfg.strict_quantile),
        );
        const threshold = Math.max(cfg.threshold, mean(thresholds));
        const trades = metas.flatMap((meta) =>
          simulate(meta, data.get(meta.symbol) || [], cfg, threshold, bounds[0], bounds[fold], exo, binance, cot).trades,
        );
        const train = summarize(trades);
        const score = objective(train);
        if (!best || score > best.score) best = { cfg, threshold, train, score };
      }
      if (!best) continue;
      const testResults = metas.map((meta) =>
        simulate(meta, data.get(meta.symbol) || [], best!.cfg, best!.threshold, bounds[fold], bounds[fold + 1], exo, binance, cot),
      );
      const testTrades = testResults.flatMap((result) => result.trades);
      for (const result of testResults) {
        for (const [reason, count] of Object.entries(result.failures)) wfFailures[reason] = (wfFailures[reason] || 0) + count;
      }
      const test = summarize(testTrades);
      wfTrades.push(...testTrades);
      console.log(
        `[${assetClass}] fold=${fold} trades=${test.trades} pnl=${test.net_pnl_usd.toFixed(0)} pf=${test.profit_factor.toFixed(2)} win=${pct(test.win_rate)} feed=${test.avg_feed_quality.toFixed(2)} threshold=${best.threshold.toFixed(3)}`,
      );
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
        test_avg_feed_quality: test.avg_feed_quality,
      });
    }
    const wf = summarize(wfTrades);
    for (const [reason, count] of Object.entries(wfFailures).sort((a, b) => b[1] - a[1])) {
      failureRows.push({ asset_class: assetClass, reason, count });
    }
    for (const trade of wfTrades.slice(0, 2000)) {
      propertyRows.push({
        asset_class: trade.asset_class,
        symbol: trade.symbol,
        side: trade.side,
        entry_ts: trade.entry_ts,
        score: trade.score,
        manifest: trade.manifest,
        feed_quality: trade.feed_quality,
        q_core: trade.q_core,
        liquidity_cavity: trade.liquidity_cavity,
        leverage_structure: trade.leverage_structure,
        basis_structure: trade.basis_structure,
        breadth_structure: trade.breadth_structure,
        pnl_usd: trade.pnl_usd,
        exit_reason: trade.exit_reason,
      });
    }
    const status =
      wf.trades >= 30 && wf.net_pnl_usd > 0 && wf.profit_factor >= 1.18 && wf.win_rate >= 0.52 && wf.max_drawdown_usd > -2500
        ? 'true_property_validation_pass'
        : wf.trades >= 20 && wf.net_pnl_usd > 0 && wf.profit_factor >= 1.05
          ? 'watchlist_retest'
          : 'blocked';
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
      avg_feed_quality: wf.avg_feed_quality,
    });
    configs[assetClass] = {
      status,
      walk_forward_trades: wf.trades,
      walk_forward_win_rate: Number(wf.win_rate.toFixed(4)),
      walk_forward_net_pnl_usd: Number(wf.net_pnl_usd.toFixed(2)),
      walk_forward_profit_factor: Number(wf.profit_factor.toFixed(4)),
    };
  }

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_6_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_6_walk_forward.csv'), toCsv(walkRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_6_failure_modes.csv'), toCsv(failureRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_6_property_samples.csv'), toCsv(propertyRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_6_feed_coverage.csv'), toCsv(feedRows));
  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_training_only_not_deployed',
    true_feeds: [
      'Binance 永续合约资金费率',
      'Binance 永续合约持仓量',
      'Binance 多空账户比',
      'CFTC COT 管理资金净持仓',
      '美元指数/利率/波动率/信用/行业 ETF',
      '等权指数相对强弱与行业广度',
      '期货-ETF 基差代理',
    ],
    summary: summaryRows,
    feed_coverage: feedRows,
    candidate_config: configs,
    deployable_count: summaryRows.filter((row) => row.status === 'true_property_validation_pass').length,
    watchlist_count: summaryRows.filter((row) => row.status === 'watchlist_retest').length,
    blocked_count: summaryRows.filter((row) => row.status === 'blocked').length,
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_6_summary.json'), JSON.stringify(summary, null, 2));

  const md = `# ${VERSION}

## 目标

V1.6 不再只从价格自身派生物性，而是接入真实外部物性源，测试“物性融合”是否能真正提高盈利能力。

## 新增真实物性源

- 加密货币：Binance 永续合约资金费率、持仓量、多空账户比。
- 黄金/期货：CFTC COT 管理资金净持仓、期货-ETF 基差代理。
- 黄金/股票：美元指数、10年利率代理、TIP、VIX、信用风险、行业 ETF 与等权指数广度。
- 所有资产：成交量腔体、波动半径、趋势相位。

## 交易纪律

本轮只做本地 walk-forward 验证。只有 \`true_property_validation_pass\` 且后续 paper replay 继续为正，才允许写入线上交易配置。

## 结果

| 资产类 | 状态 | 标的 | 交易数 | 胜率 | 方向命中 | 净收益 | 最大回撤 | Profit Factor | 平均真实物性覆盖 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
${summaryRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${row.status} | ${row.symbols} | ${row.walk_forward_trades} | ${pct(Number(row.walk_forward_win_rate))} | ${pct(Number(row.walk_forward_direction_accuracy))} | $${Number(row.walk_forward_net_pnl_usd).toFixed(0)} | $${Number(row.walk_forward_max_drawdown_usd).toFixed(0)} | ${Number(row.walk_forward_profit_factor).toFixed(2)} | ${Number(row.avg_feed_quality).toFixed(3)} |`,
  )
  .join('\n')}

## 判断

如果本轮仍 blocked，说明问题不在权重，而在真实外部物性源仍不够完整或覆盖周期太短。下一步应优先补：真实链上活跃/稳定币流动性、清算数据、完整 COT 历史、股票真实上涨家数/新高新低、期货期限结构曲线。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_6_TruePropertyFeeds.md'), md);
  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
