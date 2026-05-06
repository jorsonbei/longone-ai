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
  volume?: number;
};

type HistoricalSensorRecord = {
  asset_class: AssetClass;
  symbol: string;
  sensor_family: string;
  ts: string;
  value: number;
  unit: string;
  source: string;
  replay_ready: boolean;
  history_scope: string;
  note: string;
};

type CoverageRow = {
  asset_class: AssetClass;
  required_sensor: string;
  source: string;
  rows: number;
  first_ts: string;
  latest_ts: string;
  replay_ready: boolean;
  critical: boolean;
  status: string;
};

type SnapshotRow = {
  asset_class: AssetClass;
  sensor_family: string;
  symbol: string;
  source: string;
  snapshot_file: string;
  replay_ready: boolean;
  status: string;
  note: string;
};

const VERSION = 'HFCD_Trading_V1_12_HistoricalSensorLedger';
const ROOT = process.cwd();
const V10_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_10_qcore_state_machine');
const V6_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_6_true_feeds');
const MARKET_DIR = path.join(V6_DIR, 'market_data');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_12_historical_sensor_ledger');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const SNAPSHOT_DIR = path.join(OUT_DIR, 'snapshot_archive');

const CRYPTO_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;

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
    volume: Number(row.volume || 0),
  })).filter((row) => row.ts && Number.isFinite(row.close) && row.close > 0);
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function isoFromMs(ms: number) {
  return new Date(ms).toISOString();
}

function isoFromSeconds(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}

function sanitizeName(value: string) {
  return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function rangeInfo(records: HistoricalSensorRecord[]) {
  const sorted = records.map((row) => row.ts).filter(Boolean).sort();
  return {
    first: sorted[0] || '',
    latest: sorted.at(-1) || '',
  };
}

function coverage(
  assetClass: AssetClass,
  requiredSensor: string,
  source: string,
  records: HistoricalSensorRecord[],
  replayReady: boolean,
  critical: boolean,
  status: string,
): CoverageRow {
  const range = rangeInfo(records);
  return {
    asset_class: assetClass,
    required_sensor: requiredSensor,
    source,
    rows: records.length,
    first_ts: range.first,
    latest_ts: range.latest,
    replay_ready: replayReady,
    critical,
    status,
  };
}

async function fetchText(url: string, label: string, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'hfcd-trading-local-research/1.0' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} ${response.status}: ${text.slice(0, 220)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string, label: string) {
  const text = await fetchText(url, label);
  await writeFile(path.join(RAW_DIR, `${sanitizeName(label)}.json`), text);
  return JSON.parse(text) as any;
}

async function snapshotJson(label: string, data: unknown): Promise<string> {
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${sanitizeName(label)}.json`;
  await writeFile(path.join(SNAPSHOT_DIR, filename), JSON.stringify(data, null, 2));
  return filename;
}

function record(
  assetClass: AssetClass,
  symbol: string,
  sensorFamily: string,
  ts: string,
  value: number,
  unit: string,
  source: string,
  replayReady: boolean,
  historyScope: string,
  note: string,
): HistoricalSensorRecord {
  return {
    asset_class: assetClass,
    symbol,
    sensor_family: sensorFamily,
    ts,
    value,
    unit,
    source,
    replay_ready: replayReady,
    history_scope: historyScope,
    note,
  };
}

async function stablecoinHistory() {
  try {
    const data = await fetchJson('https://stablecoins.llama.fi/stablecoincharts/all', 'defillama_stablecoincharts_all');
    const rows = (Array.isArray(data) ? data : [])
      .map((row: any) =>
        record(
          'crypto',
          'ALL_STABLECOINS',
          'stablecoin_net_mint_burn_history',
          isoFromSeconds(Number(row.date)),
          Number(row?.totalCirculatingUSD?.peggedUSD || row?.totalCirculating?.peggedUSD || 0),
          'usd_circulating',
          'DeFiLlama stablecoincharts/all',
          true,
          'daily_history',
          '可用于稳定币净铸造/销毁的日频回放；净变化需用相邻日差分计算。',
        ),
      )
      .filter((row: HistoricalSensorRecord) => Number.isFinite(row.value) && row.value > 0);
    return rows;
  } catch (error) {
    return [
      record('crypto', 'ALL_STABLECOINS', 'stablecoin_net_mint_burn_history', new Date().toISOString(), 0, 'error', 'DeFiLlama stablecoincharts/all', false, 'missing', String(error)),
    ];
  }
}

async function onchainActiveHistory() {
  try {
    const data = await fetchJson('https://api.blockchain.info/charts/n-unique-addresses?timespan=365days&format=json', 'blockchain_unique_addresses_365d');
    return (Array.isArray(data.values) ? data.values : [])
      .map((row: any) =>
        record(
          'crypto',
          'BTC',
          'onchain_active_address_history',
          isoFromSeconds(Number(row.x)),
          Number(row.y),
          'unique_addresses',
          'Blockchain.com n-unique-addresses',
          true,
          'daily_history',
          'BTC 链上活跃代理；ETH 与稳定币链上活跃仍需独立数据源。',
        ),
      )
      .filter((row: HistoricalSensorRecord) => Number.isFinite(row.value) && row.value > 0);
  } catch (error) {
    return [record('crypto', 'BTC', 'onchain_active_address_history', new Date().toISOString(), 0, 'error', 'Blockchain.com n-unique-addresses', false, 'missing', String(error))];
  }
}

async function binanceFundingHistory(symbol: string) {
  try {
    const data = await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1000`, `binance_funding_history_${symbol}`);
    return (Array.isArray(data) ? data : [])
      .map((row: any) =>
        record(
          'crypto',
          symbol,
          'funding_rate_history',
          isoFromMs(Number(row.fundingTime)),
          Number(row.fundingRate),
          'rate',
          'Binance futures fundingRate',
          true,
          '8h_history_latest_1000',
          '资金费率历史可回放，但不是清算数据。',
        ),
      )
      .filter((row: HistoricalSensorRecord) => Number.isFinite(row.value));
  } catch (error) {
    return [record('crypto', symbol, 'funding_rate_history', new Date().toISOString(), 0, 'error', 'Binance futures fundingRate', false, 'missing', String(error))];
  }
}

async function binanceOpenInterestHistory(symbol: string) {
  try {
    const data = await fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=500`, `binance_open_interest_history_${symbol}`);
    return (Array.isArray(data) ? data : [])
      .map((row: any) =>
        record(
          'crypto',
          symbol,
          'open_interest_history',
          isoFromMs(Number(row.timestamp)),
          Number(row.sumOpenInterestValue || row.sumOpenInterest),
          row.sumOpenInterestValue ? 'usd_notional' : 'contracts',
          'Binance futures openInterestHist',
          true,
          '1h_history_latest_500',
          '持仓量历史可回放，用于 R 半径和杠杆拥挤代理。',
        ),
      )
      .filter((row: HistoricalSensorRecord) => Number.isFinite(row.value) && row.value > 0);
  } catch (error) {
    return [record('crypto', symbol, 'open_interest_history', new Date().toISOString(), 0, 'error', 'Binance futures openInterestHist', false, 'missing', String(error))];
  }
}

async function binanceDepthSnapshot(symbol: string) {
  try {
    const data = await fetchJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`, `binance_depth_snapshot_${symbol}`);
    const file = await snapshotJson(`binance_depth_snapshot_${symbol}`, data);
    return {
      row: {
        asset_class: 'crypto' as AssetClass,
        sensor_family: 'l2_orderbook_depth_snapshot',
        symbol,
        source: 'Binance futures depth',
        snapshot_file: file,
        replay_ready: false,
        status: 'snapshot_archived_not_historical_l2_replay',
        note: '当前 L2 深度已归档，但没有历史 tick/毫秒级订单簿，不能用于 V1.12 历史回放晋级。',
      },
      coverage: coverage('crypto', `l2_orderbook_depth_history_${symbol}`, 'Binance futures depth websocket/archive required', [], false, true, 'missing_historical_l2_depth'),
    };
  } catch (error) {
    return {
      row: {
        asset_class: 'crypto' as AssetClass,
        sensor_family: 'l2_orderbook_depth_snapshot',
        symbol,
        source: 'Binance futures depth',
        snapshot_file: '',
        replay_ready: false,
        status: 'unavailable',
        note: String(error),
      },
      coverage: coverage('crypto', `l2_orderbook_depth_history_${symbol}`, 'Binance futures depth websocket/archive required', [], false, true, 'missing_historical_l2_depth'),
    };
  }
}

async function binanceLiquidationHistory(symbol: string) {
  try {
    const data = await fetchJson(`https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${symbol}&limit=100`, `binance_liquidation_history_${symbol}`);
    const rows = (Array.isArray(data) ? data : [])
      .map((row: any) =>
        record(
          'crypto',
          symbol,
          'liquidation_history',
          isoFromMs(Number(row.time || row.updateTime || Date.now())),
          Number(row.executedQty || row.origQty || 0),
          'contracts',
          'Binance allForceOrders',
          true,
          'recent_history_if_endpoint_available',
          '清算数据可用时作为 Bσ 黑子爆发代理。',
        ),
      )
      .filter((row: HistoricalSensorRecord) => Number.isFinite(row.value) && row.value >= 0);
    return rows.length ? rows : [record('crypto', symbol, 'liquidation_history', new Date().toISOString(), 0, 'empty', 'Binance allForceOrders', false, 'empty', 'endpoint returned no rows')];
  } catch (error) {
    return [record('crypto', symbol, 'liquidation_history', new Date().toISOString(), 0, 'error', 'Binance allForceOrders', false, 'missing', String(error))];
  }
}

async function readMarket(file: string) {
  return parseMarket(await readFile(path.join(MARKET_DIR, file), 'utf8'));
}

function alignedBasisHistory(futureRows: MarketRow[], proxyRows: MarketRow[], symbol: string, proxySymbol: string, family: string) {
  const proxySorted = [...proxyRows].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  let pointer = 0;
  const records: HistoricalSensorRecord[] = [];
  for (const row of [...futureRows].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())) {
    const t = new Date(row.ts).getTime();
    while (pointer + 1 < proxySorted.length && new Date(proxySorted[pointer + 1].ts).getTime() <= t) pointer += 1;
    const proxy = proxySorted[pointer];
    const ageHours = proxy ? Math.abs(t - new Date(proxy.ts).getTime()) / 3_600_000 : Infinity;
    if (proxy && ageHours <= 96) {
      records.push(
        record(
          'futures',
          symbol,
          family,
          row.ts,
          row.close / proxy.close,
          `${symbol}_per_${proxySymbol}`,
          'cached continuous future / ETF proxy',
          true,
          'hourly_history_proxy',
          '这是可回放 basis proxy，不是完整期货合约链期限结构。',
        ),
      );
    }
  }
  return records;
}

function rollProxyFromBasis(basisRows: HistoricalSensorRecord[]) {
  const sorted = [...basisRows].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const values = sorted.map((row) => row.value);
  const windowStd = Math.max(std(values.slice(-252)), 1e-9);
  const rows: HistoricalSensorRecord[] = [];
  for (let i = 24; i < sorted.length; i += 1) {
    const family = sorted[i].sensor_family.startsWith('gold_') ? 'gold_roll_proxy_history' : 'oil_roll_proxy_history';
    rows.push(
      record(
        'futures',
        sorted[i].symbol,
        family,
        sorted[i].ts,
        (sorted[i].value - sorted[i - 24].value) / windowStd,
        'basis_delta_z_proxy',
        'derived from cached basis proxy',
        true,
        'hourly_history_proxy',
        '这是 roll pressure 代理，不是 CME 合约链 roll yield。',
      ),
    );
  }
  return rows;
}

async function futuresProxyHistories() {
  const [gc, gld, cl, uso] = await Promise.all([readMarket('GC_F.csv'), readMarket('GLD.csv'), readMarket('CL_F.csv'), readMarket('USO.csv')]);
  const goldBasis = alignedBasisHistory(gc, gld, 'GC_F', 'GLD', 'gold_basis_proxy_history');
  const oilBasis = alignedBasisHistory(cl, uso, 'CL_F', 'USO', 'oil_basis_proxy_history');
  return [...goldBasis, ...oilBasis, ...rollProxyFromBasis(goldBasis), ...rollProxyFromBasis(oilBasis)];
}

async function cftcHistory() {
  try {
    const text = await readFile(path.join(MARKET_DIR, 'cftc_disagg_cot.csv'), 'utf8');
    return text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const cells = parseCsvLine(line);
        return record(
        'futures',
          cells[0] || 'CFTC_DISAGG',
        'cot_positioning_history',
          cells[2] || '',
          Number(cells[7] || 0),
          'open_interest_cross_section',
        'cached CFTC disaggregated COT',
          false,
          'latest_report_cross_section_only',
          '当前缓存是单期 COT 横截面，不是多周历史；不能作为完整 COT 历史回放。',
        );
      })
      .filter((row) => row.ts && Number.isFinite(row.value));
  } catch (error) {
    return [record('futures', 'CFTC_DISAGG', 'cot_positioning_history', new Date().toISOString(), 0, 'error', 'cached CFTC disaggregated COT', false, 'missing', String(error))];
  }
}

function historicalRows(records: HistoricalSensorRecord[], family: string) {
  return records.filter((row) => row.sensor_family === family && row.replay_ready && Number.isFinite(row.value));
}

function sensorCoverageRows(records: HistoricalSensorRecord[], snapshots: SnapshotRow[]) {
  const rows: CoverageRow[] = [];
  for (const family of ['stablecoin_net_mint_burn_history', 'onchain_active_address_history']) {
    const own = historicalRows(records, family);
    rows.push(coverage('crypto', family, own[0]?.source || 'public API', own, own.length >= 180, true, own.length >= 180 ? 'replay_ready' : 'insufficient_history'));
  }
  for (const symbol of CRYPTO_SYMBOLS) {
    for (const family of ['funding_rate_history', 'open_interest_history', 'liquidation_history']) {
      const own = records.filter((row) => row.asset_class === 'crypto' && row.symbol === symbol && row.sensor_family === family && row.replay_ready && Number.isFinite(row.value));
      const minRows = family === 'liquidation_history' ? 50 : 180;
      rows.push(coverage('crypto', `${family}_${symbol}`, own[0]?.source || 'Binance futures API', own, own.length >= minRows, true, own.length >= minRows ? 'replay_ready' : 'missing_or_insufficient_history'));
    }
    const snapshot = snapshots.find((row) => row.symbol === symbol && row.sensor_family === 'l2_orderbook_depth_snapshot');
    rows.push({
      asset_class: 'crypto',
      required_sensor: `l2_orderbook_depth_history_${symbol}`,
      source: snapshot?.source || 'Binance futures depth websocket/archive required',
      rows: snapshot?.snapshot_file ? 1 : 0,
      first_ts: snapshot?.snapshot_file ? new Date().toISOString() : '',
      latest_ts: snapshot?.snapshot_file ? new Date().toISOString() : '',
      replay_ready: false,
      critical: true,
      status: snapshot?.snapshot_file ? 'snapshot_archived_but_not_replay_ready' : 'missing_historical_l2_depth',
    });
  }

  for (const family of ['gold_basis_proxy_history', 'oil_basis_proxy_history', 'gold_roll_proxy_history', 'oil_roll_proxy_history']) {
    const own = historicalRows(records, family);
    rows.push(coverage('futures', family, own[0]?.source || 'local cache/proxy', own, own.length >= 100, family.includes('basis') || family.includes('roll'), own.length >= 100 ? 'proxy_replay_ready' : 'insufficient_history'));
  }
  const cotRows = records.filter((row) => row.asset_class === 'futures' && row.sensor_family === 'cot_positioning_history');
  const cotDates = new Set(cotRows.map((row) => row.ts));
  rows.push(
    coverage(
      'futures',
      'cot_positioning_history',
      'cached CFTC disaggregated COT',
      cotRows,
      cotDates.size >= 26,
      false,
      cotDates.size >= 26 ? 'weekly_history_replay_ready' : 'latest_cross_section_only_not_replay_ready',
    ),
  );
  rows.push(coverage('futures', 'full_term_structure_curve_history', 'CME/contract-chain source required', [], false, true, 'missing_contract_chain'));
  rows.push(coverage('futures', 'true_roll_yield_history', 'CME/contract-chain source required', [], false, true, 'missing_true_roll_yield'));
  rows.push(coverage('futures', 'inventory_history', 'EIA/WGC source required', [], false, true, process.env.EIA_API_KEY ? 'not_implemented_endpoint_review_required' : 'missing_eia_or_inventory_source'));
  rows.push(coverage('futures', 'margin_requirement_history', 'exchange/broker margin feed required', [], false, true, 'missing_margin_feed'));
  return rows;
}

function aggregateCoverage(assetClass: AssetClass, rows: CoverageRow[]) {
  const own = rows.filter((row) => row.asset_class === assetClass);
  const critical = own.filter((row) => row.critical);
  const replayReady = own.filter((row) => row.replay_ready);
  const criticalReady = critical.filter((row) => row.replay_ready);
  return {
    required_count: own.length,
    replay_ready_count: replayReady.length,
    replay_ready_coverage: own.length ? replayReady.length / own.length : 0,
    critical_count: critical.length,
    critical_ready_count: criticalReady.length,
    critical_ready_coverage: critical.length ? criticalReady.length / critical.length : 0,
    critical_missing: critical.filter((row) => !row.replay_ready).map((row) => row.required_sensor).join(';'),
  };
}

function statusFor(assetClass: AssetClass, agg: ReturnType<typeof aggregateCoverage>) {
  if (assetClass === 'crypto') {
    if (agg.critical_missing.includes('liquidation') || agg.critical_missing.includes('l2_orderbook')) {
      return 'core_history_ready_but_missing_liquidation_l2_replay';
    }
    if (agg.critical_ready_coverage >= 0.80) return 'historical_sensor_replay_candidate';
    return 'needs_more_crypto_sensor_history';
  }
  if (assetClass === 'futures') {
    if (agg.critical_missing.includes('full_term_structure') || agg.critical_missing.includes('true_roll_yield')) {
      return 'blocked_until_contract_chain_term_structure_roll_yield';
    }
    if (agg.critical_ready_coverage >= 0.70) return 'historical_sensor_replay_candidate';
    return 'needs_more_futures_sensor_history';
  }
  return 'not_changed_in_v1_12';
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(SNAPSHOT_DIR, { recursive: true });

  const baseSummary = parseSummary(await readFile(path.join(V10_DIR, 'hfcd_trading_v1_10_summary.csv'), 'utf8'));
  const records: HistoricalSensorRecord[] = [];
  const snapshots: SnapshotRow[] = [];

  records.push(...(await stablecoinHistory()));
  records.push(...(await onchainActiveHistory()));
  for (const symbol of CRYPTO_SYMBOLS) {
    records.push(...(await binanceFundingHistory(symbol)));
    records.push(...(await binanceOpenInterestHistory(symbol)));
    records.push(...(await binanceLiquidationHistory(symbol)));
    const depth = await binanceDepthSnapshot(symbol);
    snapshots.push(depth.row);
  }
  records.push(...(await futuresProxyHistories()));
  records.push(...(await cftcHistory()));

  const coverageRows = sensorCoverageRows(records, snapshots);
  const summaryRows = baseSummary.map((base) => {
    const agg = aggregateCoverage(base.asset_class, coverageRows);
    return {
      asset_class: base.asset_class,
      v10_status: base.status,
      v10_trades: base.trades,
      v10_win_rate: base.win_rate,
      v10_net_pnl_usd: base.net_pnl_usd,
      v10_profit_factor: base.profit_factor,
      historical_required_count: agg.required_count,
      replay_ready_count: agg.replay_ready_count,
      replay_ready_coverage: agg.replay_ready_coverage,
      critical_ready_coverage: agg.critical_ready_coverage,
      critical_missing: agg.critical_missing,
      v12_status: statusFor(base.asset_class, agg),
    };
  });

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_12_historical_sensor_records.csv'), toCsv(records as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_12_snapshot_manifest.csv'), toCsv(snapshots as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_12_coverage.csv'), toCsv(coverageRows as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_12_summary.csv'), toCsv(summaryRows));

  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_historical_sensor_ledger_not_deployed',
    no_leak_note:
      'V1.12 separates replay-ready historical sensors from current snapshots. Snapshot-only L2 depth and missing liquidation data are not allowed to promote crypto to historical walk-forward.',
    summary: summaryRows,
    coverage: coverageRows,
    snapshot_manifest: snapshots,
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_12_summary.json'), JSON.stringify(summary, null, 2));

  const md = `# ${VERSION}

## 定位

V1.12 做历史化传感器账本，不调阈值，不推线上。

核心原则：能按时间戳形成 CSV 回放的才算历史传感器；只能拿当前值的盘口深度、清算端点或供应商缺口，只能进入快照归档或缺口清单。

## 汇总

| 资产 | V1.10 状态 | V1.10 净收益 | V1.10 PF | 所需传感器 | 可回放数 | 可回放覆盖 | 关键覆盖 | 缺失关键项 | V1.12 判断 |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
${summaryRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${row.v10_status} | $${Number(row.v10_net_pnl_usd).toFixed(0)} | ${Number(row.v10_profit_factor).toFixed(2)} | ${row.historical_required_count} | ${row.replay_ready_count} | ${(Number(row.replay_ready_coverage) * 100).toFixed(1)}% | ${(Number(row.critical_ready_coverage) * 100).toFixed(1)}% | ${row.critical_missing || '-'} | ${row.v12_status} |`,
  )
  .join('\n')}

## 传感器覆盖

| 资产 | 传感器 | 来源 | 行数 | 起始 | 最新 | 可回放 | 关键 | 状态 |
|---|---|---|---:|---|---|---|---|---|
${coverageRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${row.required_sensor} | ${row.source} | ${row.rows} | ${row.first_ts || '-'} | ${row.latest_ts || '-'} | ${row.replay_ready ? '是' : '否'} | ${row.critical ? '是' : '否'} | ${row.status} |`,
  )
  .join('\n')}

## 快照归档

| 资产 | 传感器 | 标的 | 文件 | 状态 |
|---|---|---|---|---|
${snapshots
  .map((row) => `| ${row.asset_class} | ${row.sensor_family} | ${row.symbol} | ${row.snapshot_file || '-'} | ${row.status} |`)
  .join('\n')}

## 结论

- Crypto 已具备稳定币净铸造/销毁、BTC 链上活跃、Binance 资金费率、Binance OI 的历史化回放基础。
- Crypto 仍不能晋级历史化 walk-forward：清算数据不可用或不足，L2 深度只有当前快照，不是历史订单簿。
- Futures 当前只有 COT、basis proxy、roll pressure proxy 的可回放代理；完整期限结构和真实 roll yield 仍缺。
- Futures 的 ETF basis proxy 只能做临时弱传感器，不能替代合约链 term structure。

## 下一步

V1.13 不应继续调交易阈值。应优先做两件事：

1. Crypto：建立定时采集任务，每小时保存 Binance depth、funding、OI、清算替代源与稳定币/on-chain 快照，累积至少 30 天后再做历史回放。
2. Futures：接入真实合约链数据源，输出每个品种的近月/次月/远月曲线、roll yield、换月日历、保证金变化与库存历史。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_12_HistoricalSensorLedger.md'), md);

  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
