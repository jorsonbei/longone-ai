import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AssetClass = 'gold_etf' | 'futures' | 'crypto' | 'equity_etf';

type SummaryRow = {
  asset_class: AssetClass;
  trades: number;
  win_rate: number;
  net_pnl_usd: number;
  max_drawdown_usd: number;
  profit_factor: number;
  test_trades: number;
  test_win_rate: number;
  test_net_pnl_usd: number;
  test_profit_factor: number;
  status: string;
};

type MarketRow = {
  ts: string;
  close: number;
};

type SensorRow = {
  asset_class: AssetClass;
  sensor_family: string;
  source: string;
  coverage: number;
  score: number;
  value: string;
  status: string;
};

const VERSION = 'HFCD_Trading_V1_11_TrueSensorExpansion';
const ROOT = process.cwd();
const V10_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_10_qcore_state_machine');
const V6_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_6_true_feeds');
const MARKET_DIR = path.join(V6_DIR, 'market_data');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_11_true_sensor_expansion');
const RAW_DIR = path.join(OUT_DIR, 'raw');

const BINANCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;

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

function parseSummary(text: string): SummaryRow[] {
  return parseRows(text, (row) => ({
    asset_class: row.asset_class as AssetClass,
    trades: Number(row.trades),
    win_rate: Number(row.win_rate),
    net_pnl_usd: Number(row.net_pnl_usd),
    max_drawdown_usd: Number(row.max_drawdown_usd),
    profit_factor: Number(row.profit_factor),
    test_trades: Number(row.test_trades),
    test_win_rate: Number(row.test_win_rate),
    test_net_pnl_usd: Number(row.test_net_pnl_usd),
    test_profit_factor: Number(row.test_profit_factor),
    status: row.status,
  }));
}

function parseMarket(text: string): MarketRow[] {
  return parseRows(text, (row) => ({
    ts: row.ts,
    close: Number(row.close),
  })).filter((row) => row.ts && Number.isFinite(row.close) && row.close > 0);
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

async function fetchText(url: string, label: string, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'hfcd-trading-local-research/1.0' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} ${response.status}: ${text.slice(0, 160)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string, label: string) {
  const text = await fetchText(url, label);
  await writeFile(path.join(RAW_DIR, `${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.json`), text);
  return JSON.parse(text) as any;
}

function sensor(assetClass: AssetClass, sensorFamily: string, source: string, coverage: number, score: number, value: string, status: string): SensorRow {
  return {
    asset_class: assetClass,
    sensor_family: sensorFamily,
    source,
    coverage: clamp(coverage),
    score: clamp(score),
    value,
    status,
  };
}

async function stablecoinSensor() {
  try {
    const data = await fetchJson('https://stablecoins.llama.fi/stablecoins?includePrices=true', 'defillama_stablecoins');
    const assets = Array.isArray(data.peggedAssets) ? data.peggedAssets : [];
    let current = 0;
    let prevDay = 0;
    let prevWeek = 0;
    let prevMonth = 0;
    for (const asset of assets) {
      current += Number(asset?.circulating?.peggedUSD || 0);
      prevDay += Number(asset?.circulatingPrevDay?.peggedUSD || 0);
      prevWeek += Number(asset?.circulatingPrevWeek?.peggedUSD || 0);
      prevMonth += Number(asset?.circulatingPrevMonth?.peggedUSD || 0);
    }
    const dayChange = prevDay > 0 ? current / prevDay - 1 : 0;
    const weekChange = prevWeek > 0 ? current / prevWeek - 1 : 0;
    const monthChange = prevMonth > 0 ? current / prevMonth - 1 : 0;
    const score = clamp(0.50 + dayChange * 30 + weekChange * 12 + monthChange * 4);
    return sensor(
      'crypto',
      'stablecoin_liquidity',
      'DeFiLlama stablecoins',
      1,
      score,
      `total_usd=${current.toFixed(0)} day=${(dayChange * 100).toFixed(2)}% week=${(weekChange * 100).toFixed(2)}% month=${(monthChange * 100).toFixed(2)}%`,
      'live_snapshot_available_not_historical_walk_forward',
    );
  } catch (error) {
    return sensor('crypto', 'stablecoin_liquidity', 'DeFiLlama stablecoins', 0, 0, String(error), 'unavailable');
  }
}

async function binanceDepthSensor(symbol: string) {
  try {
    const data = await fetchJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`, `binance_depth_${symbol}`);
    const bids = Array.isArray(data.bids) ? data.bids.map((row: string[]) => [Number(row[0]), Number(row[1])]) : [];
    const asks = Array.isArray(data.asks) ? data.asks.map((row: string[]) => [Number(row[0]), Number(row[1])]) : [];
    const bestBid = bids[0]?.[0] || 0;
    const bestAsk = asks[0]?.[0] || 0;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
    const bidDepthUsd = bids.slice(0, 20).reduce((sum: number, [price, qty]: number[]) => sum + price * qty, 0);
    const askDepthUsd = asks.slice(0, 20).reduce((sum: number, [price, qty]: number[]) => sum + price * qty, 0);
    const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 99;
    const imbalance = bidDepthUsd + askDepthUsd > 0 ? (bidDepthUsd - askDepthUsd) / (bidDepthUsd + askDepthUsd) : 0;
    const depthScore = clamp(Math.log10(Math.max(1, bidDepthUsd + askDepthUsd)) / 8.5);
    const spreadScore = clamp(1 - spreadBps / 6);
    const balanceScore = clamp(1 - Math.abs(imbalance));
    const score = clamp(depthScore * 0.45 + spreadScore * 0.35 + balanceScore * 0.20);
    return sensor(
      'crypto',
      `orderbook_depth_${symbol}`,
      'Binance futures depth',
      1,
      score,
      `spread_bps=${spreadBps.toFixed(3)} depth20_usd=${(bidDepthUsd + askDepthUsd).toFixed(0)} imbalance=${imbalance.toFixed(3)}`,
      'live_snapshot_available_not_tick_replay',
    );
  } catch (error) {
    return sensor('crypto', `orderbook_depth_${symbol}`, 'Binance futures depth', 0, 0, String(error), 'unavailable');
  }
}

async function binanceFundingOiSensor(symbol: string) {
  const rows: SensorRow[] = [];
  try {
    const premium = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, `binance_premium_${symbol}`);
    const funding = Number(premium.lastFundingRate || 0);
    rows.push(
      sensor(
        'crypto',
        `funding_safety_${symbol}`,
        'Binance premiumIndex',
        1,
        clamp(1 - Math.abs(funding) * 4000),
        `last_funding_rate=${funding}`,
        'live_snapshot_available',
      ),
    );
  } catch (error) {
    rows.push(sensor('crypto', `funding_safety_${symbol}`, 'Binance premiumIndex', 0, 0, String(error), 'unavailable'));
  }
  try {
    const oi = await fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=30`, `binance_oi_${symbol}`);
    const values = Array.isArray(oi) ? oi.map((row: any) => Number(row.sumOpenInterest)).filter((value: number) => Number.isFinite(value) && value > 0) : [];
    const first = values[0] || 0;
    const last = values.at(-1) || 0;
    const change = first > 0 ? last / first - 1 : 0;
    rows.push(
      sensor(
        'crypto',
        `open_interest_stability_${symbol}`,
        'Binance openInterestHist',
        values.length >= 10 ? 1 : 0,
        clamp(1 - Math.abs(change) * 22),
        `bars=${values.length} change=${(change * 100).toFixed(3)}%`,
        values.length >= 10 ? 'live_recent_window_available' : 'insufficient_recent_window',
      ),
    );
  } catch (error) {
    rows.push(sensor('crypto', `open_interest_stability_${symbol}`, 'Binance openInterestHist', 0, 0, String(error), 'unavailable'));
  }
  return rows;
}

async function onchainSensor() {
  try {
    const data = await fetchJson('https://api.blockchain.info/charts/n-unique-addresses?timespan=30days&format=json', 'blockchain_unique_addresses');
    const values = Array.isArray(data.values) ? data.values.map((row: any) => Number(row.y)).filter((value: number) => Number.isFinite(value)) : [];
    const last = values.at(-1) || 0;
    const recent = values.slice(-7);
    const base = mean(values.slice(0, -7));
    const recentMean = mean(recent);
    const change = base > 0 ? recentMean / base - 1 : 0;
    return sensor(
      'crypto',
      'btc_onchain_active_addresses',
      'Blockchain.com unique addresses',
      values.length >= 20 ? 1 : 0,
      clamp(0.50 + change * 3),
      `last=${last.toFixed(0)} recent_vs_prior=${(change * 100).toFixed(2)}%`,
      'btc_only_proxy_available',
    );
  } catch (error) {
    return sensor('crypto', 'btc_onchain_active_addresses', 'Blockchain.com unique addresses', 0, 0, String(error), 'unavailable');
  }
}

async function liquidationSensor(symbol: string) {
  try {
    const data = await fetchJson(`https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${symbol}&limit=100`, `binance_liquidations_${symbol}`);
    if (!Array.isArray(data)) throw new Error(JSON.stringify(data).slice(0, 160));
    return sensor(
      'crypto',
      `liquidation_feed_${symbol}`,
      'Binance allForceOrders',
      1,
      clamp(1 - data.length / 100),
      `recent_force_orders=${data.length}`,
      'live_recent_window_available',
    );
  } catch (error) {
    return sensor(
      'crypto',
      `liquidation_feed_${symbol}`,
      'Binance allForceOrders',
      0,
      0,
      String(error),
      'unavailable_endpoint_or_exchange_restricted',
    );
  }
}

function readMarket(file: string) {
  return readFile(path.join(MARKET_DIR, file), 'utf8').then(parseMarket);
}

function ratioZScore(a: MarketRow[], b: MarketRow[]) {
  const bSorted = [...b].sort((x, y) => new Date(x.ts).getTime() - new Date(y.ts).getTime());
  let pointer = 0;
  const ratios: number[] = [];
  for (const row of [...a].sort((x, y) => new Date(x.ts).getTime() - new Date(y.ts).getTime())) {
    const t = new Date(row.ts).getTime();
    while (pointer + 1 < bSorted.length && new Date(bSorted[pointer + 1].ts).getTime() <= t) pointer += 1;
    const other = bSorted[pointer];
    const ageHours = other ? Math.abs(t - new Date(other.ts).getTime()) / 3_600_000 : Infinity;
    if (other && ageHours <= 96) ratios.push(row.close / other.close);
  }
  if (ratios.length < 100) return { z: 0, count: ratios.length, latest: 0, score: 0 };
  const latest = ratios.at(-1) || 0;
  const window = ratios.slice(-252);
  const z = (latest - mean(window)) / Math.max(std(window), 1e-9);
  return { z, count: ratios.length, latest, score: clamp(1 - Math.abs(z) / 3) };
}

async function futuresBasisSensors() {
  const rows: SensorRow[] = [];
  try {
    const [gc, gld] = await Promise.all([readMarket('GC_F.csv'), readMarket('GLD.csv')]);
    const r = ratioZScore(gc, gld);
    rows.push(
      sensor(
        'futures',
        'gold_futures_etf_basis_proxy',
        'GC=F / GLD cached history',
        r.count >= 100 ? 1 : 0,
        r.score,
        `latest_ratio=${r.latest.toFixed(4)} z=${r.z.toFixed(2)} rows=${r.count}`,
        'historical_proxy_available_not_full_term_structure',
      ),
    );
  } catch (error) {
    rows.push(sensor('futures', 'gold_futures_etf_basis_proxy', 'GC=F / GLD cached history', 0, 0, String(error), 'unavailable'));
  }
  try {
    const [cl, uso] = await Promise.all([readMarket('CL_F.csv'), readMarket('USO.csv')]);
    const r = ratioZScore(cl, uso);
    rows.push(
      sensor(
        'futures',
        'oil_futures_etf_basis_proxy',
        'CL=F / USO cached history',
        r.count >= 100 ? 1 : 0,
        r.score,
        `latest_ratio=${r.latest.toFixed(4)} z=${r.z.toFixed(2)} rows=${r.count}`,
        'historical_proxy_available_not_full_term_structure',
      ),
    );
  } catch (error) {
    rows.push(sensor('futures', 'oil_futures_etf_basis_proxy', 'CL=F / USO cached history', 0, 0, String(error), 'unavailable'));
  }
  return rows;
}

async function cftcSensor() {
  try {
    const text = await readFile(path.join(MARKET_DIR, 'cftc_disagg_cot.csv'), 'utf8');
    const lines = text.trim().split(/\r?\n/);
    return sensor('futures', 'cot_positioning', 'CFTC cached disaggregated COT', lines.length > 20 ? 1 : 0, lines.length > 20 ? 0.80 : 0, `rows=${Math.max(0, lines.length - 1)}`, 'weekly_historical_available');
  } catch (error) {
    return sensor('futures', 'cot_positioning', 'CFTC cached disaggregated COT', 0, 0, String(error), 'unavailable');
  }
}

async function optionalEiaInventorySensor() {
  if (!process.env.EIA_API_KEY) {
    return sensor('futures', 'oil_inventory_proxy', 'EIA API', 0, 0, 'EIA_API_KEY not set', 'not_configured');
  }
  return sensor('futures', 'oil_inventory_proxy', 'EIA API', 0, 0, 'not fetched in V1.11 to avoid unreviewed endpoint assumptions', 'not_configured');
}

function aggregate(assetClass: AssetClass, rows: SensorRow[]) {
  const own = rows.filter((row) => row.asset_class === assetClass);
  const coverage = own.length ? own.reduce((sum, row) => sum + row.coverage, 0) / own.length : 0;
  const score = own.length ? own.reduce((sum, row) => sum + row.score * row.coverage, 0) / Math.max(own.reduce((sum, row) => sum + row.coverage, 0), 1e-9) : 0;
  return { coverage, score, count: own.length };
}

function promoteStatus(assetClass: AssetClass, base: SummaryRow, coverage: number, score: number) {
  if (assetClass === 'gold_etf' || assetClass === 'equity_etf') return base.status;
  if (assetClass === 'crypto') {
    if (base.status.includes('candidate') && coverage >= 0.65 && score >= 0.62) return 'sensor_augmented_local_candidate_not_deployed';
    return 'needs_more_crypto_sensor_history';
  }
  if (assetClass === 'futures') {
    if (coverage >= 0.65 && score >= 0.62 && base.profit_factor >= 1.15) return 'sensor_augmented_local_candidate_not_deployed';
    return 'needs_term_structure_roll_inventory_before_promotion';
  }
  return base.status;
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const baseSummary = parseSummary(await readFile(path.join(V10_DIR, 'hfcd_trading_v1_10_summary.csv'), 'utf8'));
  const sensorRows: SensorRow[] = [];

  sensorRows.push(await stablecoinSensor());
  sensorRows.push(await onchainSensor());
  for (const symbol of BINANCE_SYMBOLS) {
    sensorRows.push(await binanceDepthSensor(symbol));
    sensorRows.push(...(await binanceFundingOiSensor(symbol)));
    sensorRows.push(await liquidationSensor(symbol));
  }
  sensorRows.push(await cftcSensor());
  sensorRows.push(...(await futuresBasisSensors()));
  sensorRows.push(await optionalEiaInventorySensor());
  sensorRows.push(sensor('futures', 'full_term_structure_curve', 'Not configured', 0, 0, 'requires contract-chain source', 'missing'));
  sensorRows.push(sensor('futures', 'roll_yield_history', 'Not configured', 0, 0, 'requires dated futures chain', 'missing'));
  sensorRows.push(sensor('futures', 'margin_requirement', 'Not configured', 0, 0, 'requires exchange/broker margin feed', 'missing'));

  const summaryRows = baseSummary.map((base) => {
    const agg = aggregate(base.asset_class, sensorRows);
    return {
      asset_class: base.asset_class,
      v10_status: base.status,
      v10_trades: base.trades,
      v10_win_rate: base.win_rate,
      v10_net_pnl_usd: base.net_pnl_usd,
      v10_profit_factor: base.profit_factor,
      v10_test_net_pnl_usd: base.test_net_pnl_usd,
      sensor_count: agg.count,
      true_sensor_coverage: agg.coverage,
      true_sensor_score: agg.score,
      v11_status: promoteStatus(base.asset_class, base, agg.coverage, agg.score),
    };
  });

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_11_sensor_snapshot.csv'), toCsv(sensorRows as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_11_summary.csv'), toCsv(summaryRows));
  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_sensor_acquisition_only_not_deployed',
    no_leak_note:
      'V1.11 does not backfill current live sensor snapshots into historical walk-forward. It only audits whether V1.10 candidates have enough real external sensor coverage to be promoted later.',
    summary: summaryRows,
    sensors: sensorRows,
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_11_summary.json'), JSON.stringify(summary, null, 2));

  const md = `# ${VERSION}

## 定位

V1.11 只做真实外部传感器扩展与覆盖审计，不推线上，不把当前实时快照倒填进历史回测。

V1.10 已经给出本地交易候选。V1.11 要回答的是：这些候选有没有足够真实传感器支撑升级？

## 汇总

| 资产 | V1.10 状态 | V1.10 净收益 | V1.10 PF | 传感器数 | 覆盖率 | 传感器分 | V1.11 判断 |
|---|---|---:|---:|---:|---:|---:|---|
${summaryRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${row.v10_status} | $${Number(row.v10_net_pnl_usd).toFixed(0)} | ${Number(row.v10_profit_factor).toFixed(2)} | ${row.sensor_count} | ${(Number(row.true_sensor_coverage) * 100).toFixed(1)}% | ${Number(row.true_sensor_score).toFixed(3)} | ${row.v11_status} |`,
  )
  .join('\n')}

## 传感器明细

| 资产 | 传感器 | 来源 | 覆盖 | 分数 | 状态 | 值 |
|---|---|---|---:|---:|---|---|
${sensorRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${row.sensor_family} | ${row.source} | ${(row.coverage * 100).toFixed(0)}% | ${row.score.toFixed(3)} | ${row.status} | ${row.value.replace(/\|/g, '/')} |`,
  )
  .join('\n')}

## 结论

- crypto：如果 Binance 深度、资金费率、持仓量、稳定币和链上活跃都可用，说明 V1.10 的 crypto 候选具备进入下一轮历史化传感器验证的条件；但清算和 L2 历史深度仍是缺口。
- futures：当前只有 COT 与 futures/ETF basis proxy，不足以升级。必须补完整期限结构、roll yield、库存、保证金/换月风险。
- gold/equity：继续保留 V1.10 已通过血统，不在 V1.11 里乱改。

## 下一步

V1.12 应该做历史化传感器，不是继续调阈值：

- crypto：保存每日/每小时 stablecoin、on-chain、Binance depth、OI、funding、liquidation 快照，形成可回放历史。
- futures：接入可历史回放的期货合约链，形成 term structure / roll yield / basis 历史。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_11_TrueSensorExpansion.md'), md);
  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
