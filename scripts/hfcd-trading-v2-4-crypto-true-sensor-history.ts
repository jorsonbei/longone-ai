import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type SymbolName = 'BTCUSDT' | 'ETHUSDT';

type OpenInterestRow = {
  ts: string;
  symbol: SymbolName;
  open_interest: number;
  open_interest_value_usd: number;
  circulating_supply: number;
  source: string;
};

type FundingRow = {
  ts: string;
  symbol: SymbolName;
  funding_rate: number;
  source: string;
};

type LongShortRow = {
  ts: string;
  symbol: SymbolName;
  long_short_ratio: number;
  long_account: number;
  short_account: number;
  source: string;
};

type DepthSnapshotRow = {
  ts: string;
  symbol: SymbolName;
  best_bid: number;
  best_ask: number;
  mid_price: number;
  spread: number;
  spread_bps: number;
  bid_notional_10bps: number;
  ask_notional_10bps: number;
  bid_notional_25bps: number;
  ask_notional_25bps: number;
  bid_notional_50bps: number;
  ask_notional_50bps: number;
  bid_notional_100bps: number;
  ask_notional_100bps: number;
  top100_bid_notional: number;
  top100_ask_notional: number;
  depth_imbalance_25bps: number;
  source: string;
  history_mode: string;
};

type StablecoinSupplyRow = {
  date: string;
  asset: 'USDT' | 'USDC';
  supply_usd: number;
  supply_change_1d_usd: number;
  supply_change_7d_usd: number;
  source: string;
};

type LiquidationRow = {
  ts: string;
  symbol: SymbolName;
  side: string;
  price: number;
  qty: number;
  notional_usd: number;
  source: string;
};

type CoverageRow = {
  sensor: string;
  symbol_or_asset: string;
  rows: number;
  start_ts: string;
  end_ts: string;
  replay_ready: boolean;
  history_mode: string;
  notes: string;
};

const VERSION = 'HFCD_Trading_V2_4_CryptoTrueSensorHistory';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v2_4_crypto_true_sensor_history');
const SYMBOLS: SymbolName[] = ['BTCUSDT', 'ETHUSDT'];
const BINANCE_MAX_HIST_DAYS = 29;
const SENSOR_DAYS = Math.min(Number(process.env.HFCD_CRYPTO_SENSOR_DAYS || 29), BINANCE_MAX_HIST_DAYS);
const STABLECOIN_DAYS = Number(process.env.HFCD_STABLECOIN_DAYS || 730);
const REQUEST_DELAY_MS = Number(process.env.HFCD_CRYPTO_SENSOR_DELAY_MS || 140);

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[], headers?: string[]) {
  const keys = headers || (rows.length ? Object.keys(rows[0]) : []);
  if (!keys.length) return '';
  return [keys.join(','), ...rows.map((row) => keys.map((key) => csvEscape(row[key])).join(','))].join('\n') + '\n';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function number(value: number, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function dayIso(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function minTs<T extends { ts?: string; date?: string }>(rows: T[]) {
  return rows.length ? String(rows[0].ts || rows[0].date || '') : '';
}

function maxTs<T extends { ts?: string; date?: string }>(rows: T[]) {
  return rows.length ? String(rows[rows.length - 1].ts || rows[rows.length - 1].date || '') : '';
}

async function fetchText(url: string) {
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          'user-agent': 'HFCD-ThingNature-OS/2.4',
        },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
      if (/^\s*</.test(text)) throw new Error(`html_response: ${text.slice(0, 80)}`);
      return text;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(350 + attempt * 300);
    }
  }
  throw new Error(`fetch failed: ${url} :: ${lastError}`);
}

async function fetchJson(url: string) {
  return JSON.parse(await fetchText(url));
}

async function fetchPagedBinanceData<T>(
  baseUrl: string,
  symbol: SymbolName,
  period: string,
  startMs: number,
  endMs: number,
  limit: number,
  mapRow: (item: any) => T | null,
  timestampOf: (item: any) => number,
) {
  const rows: T[] = [];
  let cursor = startMs;
  const intervalMs = period === '5m' ? 5 * 60 * 1000 : 60 * 60 * 1000;
  while (cursor < endMs) {
    const pageEnd = Math.min(cursor + limit * intervalMs - 1, endMs);
    const url = new URL(baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('period', period);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(pageEnd));
    const payload = await fetchJson(url.toString()) as any[];
    if (!Array.isArray(payload) || payload.length === 0) {
      cursor = pageEnd + 1;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }
    for (const item of payload) {
      const row = mapRow(item);
      if (row) rows.push(row);
    }
    const lastTs = timestampOf(payload[payload.length - 1]);
    if (!Number.isFinite(lastTs) || lastTs < cursor) {
      cursor = pageEnd + 1;
    } else {
      cursor = Math.max(lastTs + intervalMs, pageEnd + 1);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return rows;
}

async function fetchOpenInterestHistory(symbol: SymbolName, startMs: number, endMs: number) {
  const rows = await fetchPagedBinanceData<OpenInterestRow>(
    'https://fapi.binance.com/futures/data/openInterestHist',
    symbol,
    '5m',
    startMs,
    endMs,
    500,
    (item) => {
      const openInterest = Number(item.sumOpenInterest || 0);
      if (!Number.isFinite(openInterest) || openInterest <= 0) return null;
      return {
        ts: iso(Number(item.timestamp)),
        symbol,
        open_interest: number(openInterest, 6),
        open_interest_value_usd: number(Number(item.sumOpenInterestValue || 0), 2),
        circulating_supply: number(Number(item.CMCCirculatingSupply || 0), 6),
        source: 'binance_futures_openInterestHist',
      };
    },
    (item) => Number(item.timestamp),
  );
  return dedupeByTs(rows);
}

async function fetchFundingHistory(symbol: SymbolName, startMs: number, endMs: number) {
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
        ts: iso(Number(item.fundingTime)),
        symbol,
        funding_rate: number(Number(item.fundingRate), 10),
        source: 'binance_fapi_fundingRate',
      });
    }
    const last = Number(payload[payload.length - 1]?.fundingTime || cursor);
    if (!Number.isFinite(last) || last <= cursor) break;
    cursor = last + 1;
    if (payload.length < 1000) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return dedupeByTs(rows);
}

async function fetchLongShortRatioHistory(symbol: SymbolName, startMs: number, endMs: number) {
  const rows = await fetchPagedBinanceData<LongShortRow>(
    'https://fapi.binance.com/futures/data/globalLongShortAccountRatio',
    symbol,
    '5m',
    startMs,
    endMs,
    500,
    (item) => {
      const ratio = Number(item.longShortRatio);
      if (!Number.isFinite(ratio)) return null;
      return {
        ts: iso(Number(item.timestamp)),
        symbol,
        long_short_ratio: number(ratio, 6),
        long_account: number(Number(item.longAccount), 6),
        short_account: number(Number(item.shortAccount), 6),
        source: 'binance_globalLongShortAccountRatio',
      };
    },
    (item) => Number(item.timestamp),
  );
  return dedupeByTs(rows);
}

function dedupeByTs<T extends { ts: string }>(rows: T[]) {
  const map = new Map<string, T>();
  for (const row of rows) map.set(row.ts, row);
  return [...map.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

async function fetchDepthSnapshot(symbol: SymbolName) {
  const url = new URL('https://fapi.binance.com/fapi/v1/depth');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('limit', '1000');
  const payload = await fetchJson(url.toString()) as any;
  const eventTs = Number(payload.E || Date.now());
  const bids = (payload.bids || []).map(([price, qty]: [string, string]) => ({ price: Number(price), qty: Number(qty) }));
  const asks = (payload.asks || []).map(([price, qty]: [string, string]) => ({ price: Number(price), qty: Number(qty) }));
  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const mid = (bestBid + bestAsk) / 2;
  const bid25 = notionalWithinBps(bids, mid, 25, 'bid');
  const ask25 = notionalWithinBps(asks, mid, 25, 'ask');
  return {
    ts: iso(eventTs),
    symbol,
    best_bid: number(bestBid, 6),
    best_ask: number(bestAsk, 6),
    mid_price: number(mid, 6),
    spread: number(bestAsk - bestBid, 8),
    spread_bps: mid > 0 ? number(((bestAsk - bestBid) / mid) * 10000, 6) : 0,
    bid_notional_10bps: number(notionalWithinBps(bids, mid, 10, 'bid'), 2),
    ask_notional_10bps: number(notionalWithinBps(asks, mid, 10, 'ask'), 2),
    bid_notional_25bps: number(bid25, 2),
    ask_notional_25bps: number(ask25, 2),
    bid_notional_50bps: number(notionalWithinBps(bids, mid, 50, 'bid'), 2),
    ask_notional_50bps: number(notionalWithinBps(asks, mid, 50, 'ask'), 2),
    bid_notional_100bps: number(notionalWithinBps(bids, mid, 100, 'bid'), 2),
    ask_notional_100bps: number(notionalWithinBps(asks, mid, 100, 'ask'), 2),
    top100_bid_notional: number(totalNotional(bids.slice(0, 100)), 2),
    top100_ask_notional: number(totalNotional(asks.slice(0, 100)), 2),
    depth_imbalance_25bps: bid25 + ask25 > 0 ? number((bid25 - ask25) / (bid25 + ask25), 6) : 0,
    source: 'binance_fapi_depth_current_snapshot',
    history_mode: 'forward_snapshot_only_not_historical_replay',
  };
}

function totalNotional(levels: { price: number; qty: number }[]) {
  return levels.reduce((sum, level) => sum + level.price * level.qty, 0);
}

function notionalWithinBps(levels: { price: number; qty: number }[], mid: number, bps: number, side: 'bid' | 'ask') {
  if (!mid) return 0;
  const bound = side === 'bid' ? mid * (1 - bps / 10000) : mid * (1 + bps / 10000);
  return levels
    .filter((level) => side === 'bid' ? level.price >= bound : level.price <= bound)
    .reduce((sum, level) => sum + level.price * level.qty, 0);
}

async function fetchLiquidations(symbol: SymbolName, startMs: number, endMs: number) {
  const url = new URL('https://fapi.binance.com/fapi/v1/allForceOrders');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('limit', '100');
  url.searchParams.set('startTime', String(startMs));
  url.searchParams.set('endTime', String(endMs));
  try {
    const payload = await fetchJson(url.toString()) as any[];
    if (!Array.isArray(payload)) return { rows: [] as LiquidationRow[], error: 'unexpected_payload' };
    const rows = payload.map((item) => {
      const price = Number(item.price || item.ap || item.o?.ap || 0);
      const qty = Number(item.origQty || item.executedQty || item.o?.q || 0);
      return {
        ts: iso(Number(item.time || item.T || item.o?.T || Date.now())),
        symbol,
        side: String(item.side || item.S || item.o?.S || ''),
        price: number(price, 6),
        qty: number(qty, 8),
        notional_usd: number(price * qty, 2),
        source: 'binance_allForceOrders',
      };
    });
    return { rows, error: '' };
  } catch (error) {
    return {
      rows: [] as LiquidationRow[],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchStablecoinHistory(assetId: '1' | '2', asset: 'USDT' | 'USDC') {
  const payload = await fetchJson(`https://stablecoins.llama.fi/stablecoin/${assetId}`) as any;
  const byDay = new Map<string, number>();
  for (const chain of Object.values(payload.chainBalances || {}) as any[]) {
    for (const token of chain.tokens || []) {
      const date = Number(token.date);
      const value = Number(token.circulating?.peggedUSD || 0);
      if (!date || !Number.isFinite(value)) continue;
      const day = dayIso(date);
      byDay.set(day, (byDay.get(day) || 0) + value);
    }
  }
  const cutoff = new Date(Date.now() - STABLECOIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = [...byDay.entries()]
    .filter(([date]) => date >= cutoff)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, supply], index, arr) => {
      const prev1 = index >= 1 ? arr[index - 1][1] : supply;
      const prev7 = index >= 7 ? arr[index - 7][1] : prev1;
      return {
        date,
        asset,
        supply_usd: number(supply, 2),
        supply_change_1d_usd: number(supply - prev1, 2),
        supply_change_7d_usd: number(supply - prev7, 2),
        source: 'defillama_stablecoins_stablecoin_history',
      };
    });
  return rows;
}

function summarizeCoverage(rows: CoverageRow[]) {
  const replayReady = rows.filter((row) => row.replay_ready).length;
  const partial = rows.filter((row) => !row.replay_ready && row.rows > 0).length;
  const missing = rows.filter((row) => row.rows === 0).length;
  return { replayReady, partial, missing, total: rows.length };
}

function svgReport(coverage: CoverageRow[]) {
  const width = 1100;
  const height = 520;
  const rows = coverage.slice(0, 18);
  const readyColor = '#6ee7b7';
  const partialColor = '#facc15';
  const missingColor = '#fb7185';
  const lines = rows.map((row, index) => {
    const y = 92 + index * 22;
    const color = row.replay_ready ? readyColor : row.rows > 0 ? partialColor : missingColor;
    const label = `${row.sensor} / ${row.symbol_or_asset}`;
    const mode = row.replay_ready ? '可回放' : row.rows > 0 ? '仅前向/部分' : '缺失';
    return `<circle cx="52" cy="${y - 5}" r="6" fill="${color}"/><text x="72" y="${y}" fill="#dbeafe" font-size="14">${escapeXml(label)}</text><text x="420" y="${y}" fill="#a7f3d0" font-size="14">${row.rows}</text><text x="520" y="${y}" fill="${color}" font-size="14">${mode}</text><text x="690" y="${y}" fill="#94a3b8" font-size="13">${escapeXml(row.history_mode)}</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#07130f"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="22" fill="#10231c" stroke="#245a47"/>
  <text x="48" y="58" fill="#f8fafc" font-size="26" font-family="Arial, sans-serif" font-weight="700">${VERSION}</text>
  <text x="48" y="82" fill="#9fb8ad" font-size="14" font-family="Arial, sans-serif">V2.4 真实 crypto 传感器历史覆盖审计：OI / funding / long-short / L2 depth / liquidation / stablecoin</text>
  ${lines}
  <text x="48" y="486" fill="#facc15" font-size="14" font-family="Arial, sans-serif">结论：可历史回放的传感器已落表；L2 深度和清算历史仍需要前向采集或第三方历史源。</text>
</svg>`;
}

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[char] || char));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const endMs = Date.now();
  const startMs = endMs - SENSOR_DAYS * 86_400_000;
  const allOi: OpenInterestRow[] = [];
  const allFunding: FundingRow[] = [];
  const allLongShort: LongShortRow[] = [];
  const allDepth: DepthSnapshotRow[] = [];
  const allLiquidations: LiquidationRow[] = [];
  const coverage: CoverageRow[] = [];
  const errors: Record<string, string> = {};

  for (const symbol of SYMBOLS) {
    const oiRows = await fetchOpenInterestHistory(symbol, startMs, endMs);
    allOi.push(...oiRows);
    coverage.push({
      sensor: 'open_interest',
      symbol_or_asset: symbol,
      rows: oiRows.length,
      start_ts: minTs(oiRows),
      end_ts: maxTs(oiRows),
      replay_ready: oiRows.length > 1000,
      history_mode: `binance_5m_last_${SENSOR_DAYS}d`,
      notes: 'Binance public endpoint only supports recent history; this is enough for local replay but not multi-year validation.',
    });

    const fundingRows = await fetchFundingHistory(symbol, startMs, endMs);
    allFunding.push(...fundingRows);
    coverage.push({
      sensor: 'funding_rate',
      symbol_or_asset: symbol,
      rows: fundingRows.length,
      start_ts: minTs(fundingRows),
      end_ts: maxTs(fundingRows),
      replay_ready: fundingRows.length > 30,
      history_mode: `binance_funding_recent_${SENSOR_DAYS}d`,
      notes: '8h funding, replay-ready as low-frequency leverage/black-spot sensor.',
    });

    const longShortRows = await fetchLongShortRatioHistory(symbol, startMs, endMs);
    allLongShort.push(...longShortRows);
    coverage.push({
      sensor: 'long_short_ratio',
      symbol_or_asset: symbol,
      rows: longShortRows.length,
      start_ts: minTs(longShortRows),
      end_ts: maxTs(longShortRows),
      replay_ready: longShortRows.length > 1000,
      history_mode: `binance_5m_last_${SENSOR_DAYS}d`,
      notes: 'Account ratio proxy for crowded positioning; useful with OI/funding.',
    });

    const depth = await fetchDepthSnapshot(symbol);
    allDepth.push(depth);
    coverage.push({
      sensor: 'l2_depth',
      symbol_or_asset: symbol,
      rows: 1,
      start_ts: depth.ts,
      end_ts: depth.ts,
      replay_ready: false,
      history_mode: 'current_snapshot_forward_only',
      notes: 'Binance REST depth is current snapshot, not historical L2. Use this for forward ledger; use Tardis/CoinGlass for replay.',
    });

    const liquidation = await fetchLiquidations(symbol, startMs, endMs);
    allLiquidations.push(...liquidation.rows);
    if (liquidation.error) errors[`liquidation_${symbol}`] = liquidation.error;
    coverage.push({
      sensor: 'liquidation',
      symbol_or_asset: symbol,
      rows: liquidation.rows.length,
      start_ts: minTs(liquidation.rows),
      end_ts: maxTs(liquidation.rows),
      replay_ready: liquidation.rows.length > 100,
      history_mode: liquidation.rows.length ? `binance_recent_${SENSOR_DAYS}d` : 'unavailable_from_binance_rest_in_this_run',
      notes: liquidation.error ? `Binance allForceOrders unavailable: ${liquidation.error.slice(0, 140)}` : 'Liquidation rows fetched.',
    });

    await sleep(REQUEST_DELAY_MS);
  }

  const stablecoinRows = [
    ...await fetchStablecoinHistory('1', 'USDT'),
    ...await fetchStablecoinHistory('2', 'USDC'),
  ].sort((a, b) => a.asset.localeCompare(b.asset) || a.date.localeCompare(b.date));

  for (const asset of ['USDT', 'USDC'] as const) {
    const rows = stablecoinRows.filter((row) => row.asset === asset);
    coverage.push({
      sensor: 'stablecoin_supply_flow',
      symbol_or_asset: asset,
      rows: rows.length,
      start_ts: minTs(rows),
      end_ts: maxTs(rows),
      replay_ready: rows.length > 180,
      history_mode: `defillama_daily_last_${STABLECOIN_DAYS}d`,
      notes: 'Daily stablecoin supply flow proxy; not exchange-specific inflow/outflow, but useful as market energy ledger.',
    });
  }

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_4_open_interest_history.csv'), toCsv(allOi as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_4_funding_history.csv'), toCsv(allFunding as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_4_long_short_ratio_history.csv'), toCsv(allLongShort as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_4_l2_depth_snapshots.csv'), toCsv(allDepth as unknown as Record<string, unknown>[]));
  await writeFile(
    path.join(OUT_DIR, 'hfcd_trading_v2_4_liquidation_history.csv'),
    toCsv(allLiquidations as unknown as Record<string, unknown>[], ['ts', 'symbol', 'side', 'price', 'qty', 'notional_usd', 'source']),
  );
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_4_stablecoin_supply_history.csv'), toCsv(stablecoinRows as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_4_sensor_coverage.csv'), toCsv(coverage as unknown as Record<string, unknown>[]));

  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    symbols: SYMBOLS,
    requested_sensor_days: Number(process.env.HFCD_CRYPTO_SENSOR_DAYS || 29),
    effective_binance_history_days: SENSOR_DAYS,
    stablecoin_days: STABLECOIN_DAYS,
    output_dir: OUT_DIR,
    counts: {
      open_interest_rows: allOi.length,
      funding_rows: allFunding.length,
      long_short_rows: allLongShort.length,
      l2_depth_snapshot_rows: allDepth.length,
      liquidation_rows: allLiquidations.length,
      stablecoin_supply_rows: stablecoinRows.length,
    },
    coverage: summarizeCoverage(coverage),
    errors,
    decision: {
      oi_history_ready: allOi.length > 2000,
      stablecoin_history_ready: stablecoinRows.length > 180,
      l2_history_ready: false,
      liquidation_history_ready: allLiquidations.length > 100,
      train_crypto_high_frequency_now: false,
      next_step: 'V2.5 forward sensor collector or third-party liquidation/L2 history before retraining BTC/ETH high-frequency model.',
    },
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v2_4_summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V2_4_CryptoTrueSensorHistory.svg'), svgReport(coverage));

  const md = `# ${VERSION}

生成时间：${summary.generated_at}

## 本轮目标

V2.4 不继续调 BTC/ETH 入场阈值，而是先补真实 crypto 传感器历史，解决 V2.0-V2.3 暴露的核心问题：高频模型缺少 OI、清算、L2 深度、稳定币流入/流出等真实物性信息。

## 已落地数据

- Binance 5m OI 历史：${allOi.length} 行。
- Binance funding 历史：${allFunding.length} 行。
- Binance 5m 多空账户比：${allLongShort.length} 行。
- Binance L2 深度当前快照：${allDepth.length} 行，仅前向，不是历史回放。
- DefiLlama USDT/USDC 稳定币供应历史：${stablecoinRows.length} 行。
- Binance 清算历史：${allLiquidations.length} 行；本轮 REST 端点状态见 summary/errors。

## 覆盖结论

${coverage.map((row) => `- ${row.sensor} / ${row.symbol_or_asset}: rows=${row.rows}, mode=${row.history_mode}, replay_ready=${row.replay_ready ? 'yes' : 'no'}`).join('\n')}

## 对模型训练的影响

当前已经能把 OI、资金费率、多空比和稳定币日频账本接入下一轮特征，但还不能宣称 BTC/ETH 高频模型信息完整：

- OI：已可做最近 ${SENSOR_DAYS} 天 5m 回放。
- 稳定币：已可做日频市场能量账本，但不是交易所净流入/流出。
- L2 深度：只有当前快照，可用于 forward paper ledger，不能用于历史训练。
- 清算：本轮 Binance REST 历史不可用；需要 Coinglass/Tardis 或 Binance WebSocket 前向采集。

## 下一步

V2.5 应该做两个分支：

1. 前向传感器采集器：每 5 分钟追加 OI、funding、多空比、L2 depth、force-order websocket 清算、稳定币账本快照。
2. 若要马上做历史训练：接 Tardis.dev 或 CoinGlass 的 liquidation/L2 历史数据，再重跑 V2.2/V2.3。

在 L2 和清算历史补齐前，不建议把 BTC/ETH 高频模型推到线上页面。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V2_4_CryptoTrueSensorHistory.md'), md);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
