import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type SymbolName = 'BTCUSDT' | 'ETHUSDT';
type Side = 'long' | 'short';
type Action = Side | 'none';

type KlineRow = {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
};

type FundingRow = {
  ts: string;
  funding_rate: number;
};

type OpenInterestRow = {
  ts: string;
  open_interest: number;
};

type FeatureRow = KlineRow & {
  funding_rate: number;
  open_interest: number;
  ret_1: number;
  ret_fast: number;
  ret_mid: number;
  ret_long: number;
  realized_vol: number;
  vol_ratio: number;
  candle_spread: number;
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
  fast_bars: number;
  mid_bars: number;
  long_bars: number;
  holding_bars: number;
  min_score: number;
  min_q: number;
  min_cavity: number;
  max_b_sigma: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  mode: 'trend' | 'trend_cavity' | 'mean_revert_guard';
};

type Signal = {
  action: Action;
  score: number;
  signed_score: number;
  property_score: number;
  q_core: number;
  liquidity_cavity: number;
  pi_coherence: number;
  sigma_ledger: number;
  eta_noise: number;
  b_sigma: number;
  r_radius: number;
  omega_coupling: number;
  failure_mode: string;
};

type Trade = {
  split: 'train' | 'validation' | 'test';
  symbol: SymbolName;
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
  b_sigma: number;
  funding_rate: number;
  open_interest: number;
  exit_reason: string;
  gross_return: number;
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

const VERSION = 'HFCD_Trading_V2_0_CryptoPaperEngine_ModelTrain';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v2_0_crypto_model_train');
const SYMBOLS: SymbolName[] = ['BTCUSDT', 'ETHUSDT'];
const INTERVAL = '5m';
const DAYS = Number(process.env.HFCD_CRYPTO_DAYS || 45);
const NOTIONAL_USD = Number(process.env.HFCD_CRYPTO_NOTIONAL || 1000);
const ROUNDTRIP_COST = Number(process.env.HFCD_CRYPTO_ROUNDTRIP_COST || 0.0012);

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))].join('\n') + '\n';
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

function pct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function number(value: number, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

async function fetchJson(url: string) {
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'HFCD-ThingNature-OS/2.0',
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 400 + attempt * 300));
    }
  }
  throw new Error(`fetch failed: ${url} :: ${lastError}`);
}

async function fetchKlines(symbol: SymbolName, days: number) {
  const rows: KlineRow[] = [];
  const intervalMs = 5 * 60 * 1000;
  let cursor = Date.now() - days * 24 * 60 * 60 * 1000;
  const end = Date.now();
  while (cursor < end) {
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
        ts: new Date(Number(item[0])).toISOString(),
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

async function fetchFunding(symbol: SymbolName, startMs: number, endMs: number) {
  const rows: FundingRow[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = new URL('https://fapi.binance.com/fapi/v1/fundingRate');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endMs));
    const payload = await fetchJson(url.toString()) as any[];
    if (!Array.isArray(payload) || payload.length === 0) break;
    for (const item of payload) {
      rows.push({
        ts: new Date(Number(item.fundingTime)).toISOString(),
        funding_rate: Number(item.fundingRate),
      });
    }
    const last = Number(payload[payload.length - 1]?.fundingTime || cursor);
    cursor = last + 1;
    if (payload.length < 1000) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return rows.sort((a, b) => a.ts.localeCompare(b.ts));
}

async function fetchOpenInterest(symbol: SymbolName, startMs: number, endMs: number) {
  const rows: OpenInterestRow[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = new URL('https://futures.binance.com/futures/data/openInterestHist');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('period', '5m');
    url.searchParams.set('limit', '500');
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endMs));
    try {
      const payload = await fetchJson(url.toString()) as any[];
      if (!Array.isArray(payload) || payload.length === 0) break;
      for (const item of payload) {
        rows.push({
          ts: new Date(Number(item.timestamp)).toISOString(),
          open_interest: Number(item.sumOpenInterest || item.openInterest || 0),
        });
      }
      const last = Number(payload[payload.length - 1]?.timestamp || cursor);
      cursor = last + 5 * 60 * 1000;
      if (payload.length < 500) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    } catch {
      break;
    }
  }
  return rows.filter((row) => Number.isFinite(row.open_interest) && row.open_interest > 0).sort((a, b) => a.ts.localeCompare(b.ts));
}

function lookupForward<T extends { ts: string }>(rows: T[], ts: string, cursor: { index: number }) {
  while (cursor.index + 1 < rows.length && rows[cursor.index + 1].ts <= ts) cursor.index += 1;
  return rows[cursor.index];
}

function buildFeatures(symbol: SymbolName, klines: KlineRow[], funding: FundingRow[], oi: OpenInterestRow[]) {
  const fCursor = { index: 0 };
  const oiCursor = { index: 0 };
  const rows: FeatureRow[] = [];
  for (let i = 0; i < klines.length; i += 1) {
    const row = klines[i];
    const closes = klines.slice(Math.max(0, i - 288), i + 1).map((x) => x.close);
    const rets = closes.map((value, idx, arr) => idx === 0 ? 0 : value / arr[idx - 1] - 1).slice(1);
    const ret1 = i > 0 ? row.close / klines[i - 1].close - 1 : 0;
    const baseFast = klines[Math.max(0, i - 6)]?.close || row.close;
    const baseMid = klines[Math.max(0, i - 24)]?.close || row.close;
    const baseLong = klines[Math.max(0, i - 96)]?.close || row.close;
    const retFast = row.close / baseFast - 1;
    const retMid = row.close / baseMid - 1;
    const retLong = row.close / baseLong - 1;
    const volShort = Math.max(std(rets.slice(-36)), 0.0008);
    const volLong = Math.max(std(rets.slice(-288)), volShort, 0.0008);
    const volRatio = clamp(volShort / Math.max(volLong, 0.0008), 0, 4);
    const candleSpread = Math.max((row.high - row.low) / row.close, 0);
    const fundingRow = funding.length ? lookupForward(funding, row.ts, fCursor) : undefined;
    const oiRow = oi.length ? lookupForward(oi, row.ts, oiCursor) : undefined;
    const openInterest = Number(oiRow?.open_interest || 0);
    const oiLookback = oi.length ? rows.slice(-96).map((x) => x.open_interest).filter((x) => x > 0) : [];
    const oiStd = std(oiLookback);
    const oiMean = mean(oiLookback);
    const oiZ = oiLookback.length && oiStd > 0 ? clamp((openInterest - oiMean) / oiStd, -4, 4) : 0;
    const volumeLookback = klines.slice(Math.max(0, i - 288), i + 1).map((x) => x.quote_volume);
    const volMean = mean(volumeLookback);
    const volumeRatio = volMean > 0 ? row.quote_volume / volMean : 1;
    const trendSigns = [retFast, retMid, retLong].map((value) => Math.sign(value || 0));
    const agreement = Math.max(trendSigns.filter((x) => x > 0).length, trendSigns.filter((x) => x < 0).length) / 3;
    const recentMax = Math.max(...closes);
    const drawdown = recentMax > 0 ? row.close / recentMax - 1 : 0;
    const qCore = clamp(0.24 + agreement * 0.44 + clamp(1 + drawdown * 12, 0, 1) * 0.22 + (symbol === 'BTCUSDT' ? 0.04 : 0.02));
    const liquidityCavity = clamp(0.22 + Math.log1p(row.quote_volume / 1_000_000) / 7 - candleSpread * 12 - Math.max(0, volRatio - 1.6) * 0.08);
    const piCoherence = clamp(0.5 + ((0.45 * retFast + 0.35 * retMid + 0.2 * retLong) / volShort) * 0.12);
    const sigmaLedger = clamp(0.45 + Math.log(Math.max(volumeRatio, 0.05)) * 0.14 + oiZ * 0.035);
    const etaNoise = clamp((volRatio - 0.7) / 2.3);
    const fundingRate = Number(fundingRow?.funding_rate || 0);
    const bSigma = clamp(Math.abs(fundingRate) * 850 + etaNoise * 0.45 + Math.max(0, oiZ) * 0.08 + Math.max(0, candleSpread - 0.003) * 60);
    const rRadius = clamp(Math.abs(fundingRate) * 550 + Math.max(0, oiZ) * 0.12 + etaNoise * 0.28);
    rows.push({
      ...row,
      funding_rate: fundingRate,
      open_interest: openInterest,
      ret_1: ret1,
      ret_fast: retFast,
      ret_mid: retMid,
      ret_long: retLong,
      realized_vol: volShort,
      vol_ratio: volRatio,
      candle_spread: candleSpread,
      q_core: qCore,
      liquidity_cavity: liquidityCavity,
      pi_coherence: piCoherence,
      sigma_ledger: sigmaLedger,
      eta_noise: etaNoise,
      b_sigma: bSigma,
      r_radius: rRadius,
      omega_coupling: 0.5,
    });
  }
  return rows;
}

function injectOmega(a: FeatureRow[], b: FeatureRow[]) {
  const byTs = new Map(b.map((row) => [row.ts, row]));
  const aReturns: number[] = [];
  const bReturns: number[] = [];
  for (const row of a) {
    const other = byTs.get(row.ts);
    aReturns.push(row.ret_1);
    bReturns.push(other?.ret_1 || 0);
    const ar = aReturns.slice(-96);
    const br = bReturns.slice(-96);
    const corr = correlation(ar, br);
    row.omega_coupling = clamp(0.5 + corr * 0.25);
  }
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

function propertyWeights(symbol: SymbolName) {
  if (symbol === 'BTCUSDT') {
    return { q: 0.18, c: 0.16, pi: 0.17, sigma: 0.19, antiB: 0.16, antiR: 0.08, omega: 0.06 };
  }
  return { q: 0.13, c: 0.15, pi: 0.21, sigma: 0.17, antiB: 0.15, antiR: 0.10, omega: 0.09 };
}

function signalAt(rows: FeatureRow[], index: number, params: ParamSet): Signal {
  const row = rows[index];
  if (!row || index < params.long_bars + 2) {
    return emptySignal('insufficient_history');
  }
  const rawTrend = (0.44 * row.ret_fast + 0.34 * row.ret_mid + 0.22 * row.ret_long) / Math.max(row.realized_vol, 0.0008);
  const meanRevert = -clamp((row.ret_long / Math.max(row.realized_vol, 0.0008)) / 2.8, -1.4, 1.4);
  const blended = params.mode === 'trend'
    ? rawTrend
    : params.mode === 'trend_cavity'
      ? rawTrend * (0.72 + row.liquidity_cavity * 0.28)
      : (row.q_core > 0.68 && Math.abs(rawTrend) > 0.65 ? rawTrend : meanRevert * row.liquidity_cavity);
  const signedScore = clamp(blended, -1.8, 1.8);
  const weights = propertyWeights(params.symbol);
  const propertyScore =
    weights.q * row.q_core +
    weights.c * row.liquidity_cavity +
    weights.pi * row.pi_coherence +
    weights.sigma * row.sigma_ledger +
    weights.antiB * (1 - row.b_sigma) +
    weights.antiR * (1 - row.r_radius) +
    weights.omega * row.omega_coupling;
  const absScore = Math.abs(signedScore);
  if (row.q_core < params.min_q) return fullSignal(row, 'none', absScore, signedScore, propertyScore, 'q_core_underthreshold');
  if (row.liquidity_cavity < params.min_cavity) return fullSignal(row, 'none', absScore, signedScore, propertyScore, 'liquidity_cavity_underthreshold');
  if (row.b_sigma > params.max_b_sigma) return fullSignal(row, 'none', absScore, signedScore, propertyScore, 'b_sigma_overheated');
  if (absScore < params.min_score || propertyScore < 0.58) return fullSignal(row, 'none', absScore, signedScore, propertyScore, 'property_score_underthreshold');
  return fullSignal(row, signedScore >= 0 ? 'long' : 'short', absScore, signedScore, propertyScore, '');
}

function emptySignal(reason: string): Signal {
  return {
    action: 'none',
    score: 0,
    signed_score: 0,
    property_score: 0,
    q_core: 0,
    liquidity_cavity: 0,
    pi_coherence: 0,
    sigma_ledger: 0,
    eta_noise: 0,
    b_sigma: 0,
    r_radius: 0,
    omega_coupling: 0,
    failure_mode: reason,
  };
}

function fullSignal(row: FeatureRow, action: Action, score: number, signedScore: number, propertyScore: number, reason: string): Signal {
  return {
    action,
    score,
    signed_score: signedScore,
    property_score: propertyScore,
    q_core: row.q_core,
    liquidity_cavity: row.liquidity_cavity,
    pi_coherence: row.pi_coherence,
    sigma_ledger: row.sigma_ledger,
    eta_noise: row.eta_noise,
    b_sigma: row.b_sigma,
    r_radius: row.r_radius,
    omega_coupling: row.omega_coupling,
    failure_mode: reason,
  };
}

function simulate(symbol: SymbolName, rows: FeatureRow[], params: ParamSet, split: 'train' | 'validation' | 'test', startIndex: number, endIndex: number) {
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
    for (let j = index + 2; j <= Math.min(index + 1 + params.holding_bars, rows.length - 1); j += 1) {
      const bar = rows[j];
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
      }
    }

    const grossReturn = signal.action === 'long' ? exitPrice / entryPrice - 1 : entryPrice / exitPrice - 1;
    const netReturn = grossReturn - ROUNDTRIP_COST;
    trades.push({
      split,
      symbol,
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
      b_sigma: number(signal.b_sigma, 4),
      funding_rate: number(entryBar.funding_rate, 8),
      open_interest: number(entryBar.open_interest, 2),
      exit_reason: exitReason,
      gross_return: number(grossReturn, 6),
      net_return: number(netReturn, 6),
      pnl_usd: number(netReturn * NOTIONAL_USD, 2),
    });
    index = exitIndex + 1;
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

function paramGrid(symbol: SymbolName): ParamSet[] {
  const grid: ParamSet[] = [];
  for (const fast_bars of [3, 6]) {
    for (const mid_bars of [18, 36]) {
      for (const long_bars of [72, 144]) {
        for (const holding_bars of [6, 12, 24, 36]) {
          for (const min_score of [0.75, 0.95, 1.15]) {
            for (const min_q of [0.56, 0.68]) {
              for (const min_cavity of [0.38, 0.52]) {
                for (const max_b_sigma of [0.70, 0.88]) {
                  for (const stop_loss_pct of [0.008, 0.014]) {
                    for (const take_profit_pct of [0.012, 0.024]) {
                      for (const mode of ['trend', 'trend_cavity'] as const) {
                        grid.push({
                          symbol,
                          fast_bars,
                          mid_bars,
                          long_bars,
                          holding_bars,
                          min_score,
                          min_q,
                          min_cavity,
                          max_b_sigma,
                          stop_loss_pct,
                          take_profit_pct,
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
      }
    }
  }
  return grid;
}

function selectParam(symbol: SymbolName, rows: FeatureRow[]) {
  const trainEnd = Math.floor(rows.length * 0.6);
  const valEnd = Math.floor(rows.length * 0.8);
  const ranked: Array<{ params: ParamSet; train: Metrics; validation: Metrics; score: number }> = [];
  for (const params of paramGrid(symbol)) {
    const trainTrades = simulate(symbol, rows, params, 'train', 0, trainEnd).trades;
    const validationTrades = simulate(symbol, rows, params, 'validation', trainEnd, valEnd).trades;
    const train = metrics(trainTrades);
    const validation = metrics(validationTrades);
    if (train.trades < 18 || validation.trades < 6) continue;
    const stabilityPenalty = Math.max(0, train.profit_factor - 3) * 0.25;
    const pfScore = Math.min(validation.profit_factor, 3) + Math.min(train.profit_factor, 2.5) * 0.25;
    const pnlScore = validation.net_pnl_usd / Math.max(validation.trades, 1) / 25;
    const ddPenalty = Math.abs(validation.max_drawdown_usd) / 1500;
    ranked.push({ params, train, validation, score: pfScore + pnlScore - ddPenalty - stabilityPenalty });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) throw new Error(`No viable parameter set for ${symbol}`);
  return { best: ranked[0], ranked: ranked.slice(0, 20), trainEnd, valEnd };
}

function equitySvg(trades: Trade[]) {
  const width = 1200;
  const height = 520;
  const pad = 48;
  let equity = 0;
  const points = trades.map((trade, index) => {
    equity += trade.pnl_usd;
    return { x: index, y: equity };
  });
  if (!points.length) return '';
  const minY = Math.min(0, ...points.map((p) => p.y));
  const maxY = Math.max(1, ...points.map((p) => p.y));
  const xMax = Math.max(points.length - 1, 1);
  const d = points.map((p, index) => {
    const x = pad + (p.x / xMax) * (width - pad * 2);
    const y = height - pad - ((p.y - minY) / Math.max(maxY - minY, 1)) * (height - pad * 2);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const zeroY = height - pad - ((0 - minY) / Math.max(maxY - minY, 1)) * (height - pad * 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#07110f"/>
  <text x="${pad}" y="34" fill="#eafff7" font-size="22" font-family="Arial" font-weight="700">HFCD Trading V2.0 BTC/ETH Equity Curve</text>
  <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${width - pad}" y2="${zeroY.toFixed(1)}" stroke="#34534d" stroke-width="1"/>
  <path d="${d}" fill="none" stroke="#73f4c3" stroke-width="3"/>
  <text x="${pad}" y="${height - 14}" fill="#9dbab1" font-size="14" font-family="Arial">trades=${trades.length} | final_pnl=${equity.toFixed(2)} | min=${minY.toFixed(2)} | max=${maxY.toFixed(2)}</text>
</svg>`;
}

async function writeOutputs(summaryRows: Record<string, unknown>[], selectedParams: Record<string, unknown>[], allTrades: Trade[], failureRows: Record<string, unknown>[], coverageRows: Record<string, unknown>[], topRows: Record<string, unknown>[]) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_0_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_0_selected_params.csv'), toCsv(selectedParams));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_0_trades.csv'), toCsv(allTrades as any));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_0_failure_modes.csv'), toCsv(failureRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_0_sensor_coverage.csv'), toCsv(coverageRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_0_top_candidates.csv'), toCsv(topRows));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V2_0_CryptoPaperEngine_ModelTrain.svg'), equitySvg(allTrades));
  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    data: {
      symbols: SYMBOLS,
      interval: INTERVAL,
      days_requested: DAYS,
      roundtrip_cost: ROUNDTRIP_COST,
      notional_usd: NOTIONAL_USD,
      source: 'Binance USD-M Futures public API',
      online_page_changed: false,
    },
    summary: summaryRows,
    selected_params: selectedParams,
    sensor_coverage: coverageRows,
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_0_summary.json'), JSON.stringify(summary, null, 2));
  const combinedTest = metrics(allTrades.filter((trade) => trade.split === 'test'));
  const md = `# ${VERSION}

## 结论

本轮只做本地训练和样本外验证，没有改线上页面、没有改 Worker 路由、没有部署。

## 数据

- 数据源：Binance USD-M Futures public API
- 标的：BTCUSDT、ETHUSDT
- K线：${INTERVAL}
- 请求窗口：${DAYS} 天
- 成本：roundtrip ${(ROUNDTRIP_COST * 100).toFixed(3)}%
- 单笔名义本金：$${NOTIONAL_USD}

## 样本外合并结果

- test trades：${combinedTest.trades}
- test win rate：${pct(combinedTest.win_rate)}
- test net PnL：$${combinedTest.net_pnl_usd.toLocaleString()}
- test PF：${combinedTest.profit_factor}
- test max DD：$${combinedTest.max_drawdown_usd.toLocaleString()}
- test trades/day：${combinedTest.trades_per_day}

## 分标的结果

${summaryRows.map((row) => `- ${row.symbol} / ${row.split}: trades=${row.trades}, win=${pct(Number(row.win_rate))}, pnl=$${row.net_pnl_usd}, PF=${row.profit_factor}, DD=$${row.max_drawdown_usd}, status=${row.status}`).join('\n')}

## 训练判断

通过条件暂定为：样本外 PF > 1.05、净收益为正、交易数 >= 10、最大回撤不过度放大。

如果 BTC 或 ETH 未通过，不应上线交易，只能继续补清算、稳定币、L2 历史盘口和更长样本。

## 输出文件

- hfcd_trading_v2_0_summary.json
- hfcd_trading_v2_0_summary.csv
- hfcd_trading_v2_0_selected_params.csv
- hfcd_trading_v2_0_trades.csv
- hfcd_trading_v2_0_failure_modes.csv
- hfcd_trading_v2_0_sensor_coverage.csv
- hfcd_trading_v2_0_top_candidates.csv
- HFCD_Trading_V2_0_CryptoPaperEngine_ModelTrain.svg
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V2_0_CryptoPaperEngine_ModelTrain.md'), md);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const featureBySymbol = new Map<SymbolName, FeatureRow[]>();
  const coverageRows: Record<string, unknown>[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`[${VERSION}] downloading ${symbol} ${DAYS}d ${INTERVAL}`);
    const klines = await fetchKlines(symbol, DAYS);
    if (klines.length < 1200) throw new Error(`${symbol} insufficient kline rows: ${klines.length}`);
    const startMs = new Date(klines[0].ts).getTime();
    const endMs = new Date(klines[klines.length - 1].ts).getTime();
    const [funding, openInterest] = await Promise.all([
      fetchFunding(symbol, startMs, endMs),
      fetchOpenInterest(symbol, Math.max(startMs, Date.now() - 30 * 24 * 60 * 60 * 1000), endMs),
    ]);
    const features = buildFeatures(symbol, klines, funding, openInterest);
    featureBySymbol.set(symbol, features);
    coverageRows.push({
      symbol,
      kline_rows: klines.length,
      funding_rows: funding.length,
      open_interest_rows: openInterest.length,
      open_interest_coverage_ratio: number(features.filter((row) => row.open_interest > 0).length / features.length, 4),
      depth_history: 'not_available_public_binance_history',
      liquidation_history: 'not_in_v2_0',
      stablecoin_flow_history: 'not_in_v2_0',
      source: 'binance_public_futures',
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
  const allTrades: Trade[] = [];

  for (const symbol of SYMBOLS) {
    const rows = featureBySymbol.get(symbol) || [];
    const selected = selectParam(symbol, rows);
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
      ...params,
      train_profit_factor: trainMetrics.profit_factor,
      validation_profit_factor: valMetrics.profit_factor,
      test_profit_factor: testMetrics.profit_factor,
      test_net_pnl_usd: testMetrics.net_pnl_usd,
      test_trades: testMetrics.trades,
      status: testMetrics.net_pnl_usd > 0 && testMetrics.profit_factor > 1.05 && testMetrics.trades >= 10 ? 'local_validation_pass' : 'blocked_or_watchlist',
    });

    for (const [split, metric] of [['train', trainMetrics], ['validation', valMetrics], ['test', testMetrics]] as const) {
      summaryRows.push({
        symbol,
        split,
        trades: metric.trades,
        win_rate: number(metric.win_rate, 4),
        net_pnl_usd: metric.net_pnl_usd,
        gross_profit_usd: metric.gross_profit_usd,
        gross_loss_usd: metric.gross_loss_usd,
        profit_factor: metric.profit_factor,
        max_drawdown_usd: metric.max_drawdown_usd,
        avg_pnl_usd: metric.avg_pnl_usd,
        trades_per_day: metric.trades_per_day,
        status: split === 'test' && metric.net_pnl_usd > 0 && metric.profit_factor > 1.05 && metric.trades >= 10 ? 'local_validation_pass' : split === 'test' ? 'not_ready_for_online' : 'fit_observation',
      });
    }

    const mergedFailures: Record<string, number> = {};
    for (const source of [train.failureModes, validation.failureModes, test.failureModes]) {
      for (const [reason, count] of Object.entries(source)) mergedFailures[reason] = (mergedFailures[reason] || 0) + count;
    }
    for (const [reason, count] of Object.entries(mergedFailures).sort((a, b) => b[1] - a[1])) {
      failureRows.push({ symbol, reason, count });
    }

    for (const row of selected.ranked) {
      topRows.push({
        symbol,
        rank_score: number(row.score, 4),
        ...row.params,
        train_trades: row.train.trades,
        train_pf: row.train.profit_factor,
        train_pnl: row.train.net_pnl_usd,
        validation_trades: row.validation.trades,
        validation_pf: row.validation.profit_factor,
        validation_pnl: row.validation.net_pnl_usd,
      });
    }
  }

  allTrades.sort((a, b) => a.entry_ts.localeCompare(b.entry_ts));
  await writeOutputs(summaryRows, selectedParams, allTrades, failureRows, coverageRows, topRows);
  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
  console.table(summaryRows.filter((row) => row.split === 'test'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
