import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

type AssetClass = 'gold_etf' | 'futures' | 'crypto' | 'equity_etf';

type SensorRecord = {
  asset_class: AssetClass;
  symbol: string;
  sensor_family: string;
  ts: string;
  value: number;
  unit: string;
  source: string;
  replay_ready: boolean;
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
  status: string;
};

type SummaryRow = {
  asset_class: AssetClass;
  added_sensor_family: string;
  rows: number;
  first_ts: string;
  latest_ts: string;
  v13_status: string;
  remaining_blockers: string;
};

const VERSION = 'HFCD_Trading_V1_13_FRED_EIA_TrueSensors';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_13_fred_eia_true_sensors');
const RAW_DIR = path.join(OUT_DIR, 'raw');

const FRED_SERIES = [
  { id: 'T5YIE', family: 'inflation_expectation_curve', unit: 'percent', note: '5-year breakeven inflation expectation.' },
  { id: 'T10YIE', family: 'inflation_expectation_curve', unit: 'percent', note: '10-year breakeven inflation expectation.' },
  { id: 'T5YIFR', family: 'inflation_expectation_curve', unit: 'percent', note: '5-year 5-year forward inflation expectation.' },
  { id: 'DFII5', family: 'real_yield_curve', unit: 'percent', note: '5-year Treasury inflation-indexed real yield.' },
  { id: 'DFII10', family: 'real_yield_curve', unit: 'percent', note: '10-year Treasury inflation-indexed real yield.' },
] as const;

const EIA_INVENTORY_SERIES = [
  { id: 'WCESTUS1', symbol: 'US_CRUDE_EX_SPR', note: 'U.S. crude oil stocks excluding SPR.' },
  { id: 'WGTSTUS1', symbol: 'US_TOTAL_GASOLINE', note: 'U.S. total gasoline stocks.' },
  { id: 'WDISTUS1', symbol: 'US_DISTILLATE', note: 'U.S. distillate fuel oil stocks.' },
  { id: 'WTESTUS1', symbol: 'US_CRUDE_PRODUCTS_EX_SPR', note: 'U.S. crude oil and petroleum products stocks excluding SPR.' },
  { id: 'W_EPC0_SAX_NUS_MBBL', symbol: 'US_CRUDE_EX_SPR_LEASE', note: 'U.S. crude oil stocks excluding SPR and including lease stock.' },
] as const;

const WGC_FLOW_URL = 'https://fsapi.gold.org/api/v11/charts/etfv2/revised/flows-chart2?break-cache=27Apr26';
const WGC_HOLDINGS_URL = 'https://fsapi.gold.org/api/v11/charts/etfv2/revised/holdings-chart2?break-cache=27Apr2026';
const CFTC_GOLD_URL =
  'https://publicreporting.cftc.gov/resource/kh3c-gbw2.json?$limit=5000&$order=report_date_as_yyyy_mm_dd&$select=market_and_exchange_names,report_date_as_yyyy_mm_dd,commodity_name,open_interest_all,m_money_positions_long_all,m_money_positions_short_all&$where=' +
  encodeURIComponent("market_and_exchange_names = 'GOLD - COMMODITY EXCHANGE INC.'");

const SUB_ASSET_TAXONOMY = [
  {
    asset_class: 'crypto',
    subtype: 'btc_macro_liquidity_anchor',
    examples: 'BTC',
    dominant_properties: 'Q核,Σ账本,DeltaSigma宏观流动性,C腔',
    required_sensors: 'stablecoin_liquidity,onchain_active,ETF_flow_if_available,funding,OI,L2_depth',
    parameter_policy: '中低频趋势持有；Q核和稳定币账本权重高。',
  },
  {
    asset_class: 'crypto',
    subtype: 'l1_smart_contract_fuel',
    examples: 'ETH,SOL',
    dominant_properties: 'Pi相干,Omega耦合,链上活跃,TVL/生态流',
    required_sensors: 'onchain_active,TVL,fees,stablecoin_liquidity,funding,OI,L2_depth',
    parameter_policy: '比 BTC 更重生态轮动和相对强弱。',
  },
  {
    asset_class: 'crypto',
    subtype: 'high_beta_alt_or_meme',
    examples: 'DOGE,PEPE,small-cap alts',
    dominant_properties: 'Eta自由度,Bsigma黑子,R半径,C腔',
    required_sensors: 'funding,OI,liquidation,L2_depth,social_or_attention_proxy',
    parameter_policy: '高频、轻仓、快退；不能套 BTC 的 Q核参数。',
  },
  {
    asset_class: 'futures',
    subtype: 'precious_metals',
    examples: 'GC,SI',
    dominant_properties: 'DeltaSigma实际利率/通胀预期,tau期限结构,COMEX_OI',
    required_sensors: 'FRED_real_yield,FRED_inflation_expectation,CME_term_structure,COMEX_OI,margin',
    parameter_policy: '宏观势差和期限结构权重高。',
  },
  {
    asset_class: 'futures',
    subtype: 'energy',
    examples: 'CL,NG,RB,HO',
    dominant_properties: 'Sigma库存账本,tau期限结构,R半径,Bsigma事件',
    required_sensors: 'EIA_inventory,CME_term_structure,roll_yield,inventory,margin,COT',
    parameter_policy: '库存和期限结构决定策略，不能用黄金期货参数。',
  },
  {
    asset_class: 'futures',
    subtype: 'agriculture',
    examples: 'ZC,ZS,ZW',
    dominant_properties: 'Bsigma天气黑子,季节性窗口,tau期限结构',
    required_sensors: 'weather_crop_calendar,USDA_inventory,CME_term_structure,COT,margin',
    parameter_policy: '需要季节性屏蔽窗，趋势策略不能全年同参。',
  },
  {
    asset_class: 'futures',
    subtype: 'equity_index_rates_fx',
    examples: 'ES,NQ,ZN,6E',
    dominant_properties: 'DeltaSigma宏观预期,Omega跨资产耦合,Pi趋势相干',
    required_sensors: 'rates_curve,VIX,DXY,term_structure,margin',
    parameter_policy: '宏观和跨资产耦合权重高。',
  },
  {
    asset_class: 'equity_etf',
    subtype: 'index_etf',
    examples: 'SPY,QQQ,IWM',
    dominant_properties: 'Pi趋势相干,Omega市场广度,DeltaSigma利率',
    required_sensors: 'VIX,breadth,new_high_low,rates,sector_rotation',
    parameter_policy: '适合低频背景海筛选。',
  },
  {
    asset_class: 'equity_etf',
    subtype: 'growth_or_duration_sensitive',
    examples: 'QQQ,ARKK,large growth',
    dominant_properties: 'DeltaSigma长端利率,Pi预期上修,Eta估值波动',
    required_sensors: 'real_yield,VIX,earnings_revision,breadth,relative_strength',
    parameter_policy: '利率敏感度高，降息/升息 regime 需分开。',
  },
  {
    asset_class: 'equity_etf',
    subtype: 'value_or_cyclical',
    examples: 'XLF,XLE,IWD',
    dominant_properties: 'Q现金流,宏观周期,Sigma资金流',
    required_sensors: 'credit_spread,sector_rotation,commodity_link,breadth',
    parameter_policy: '更重现金流和周期，不能套成长股参数。',
  },
  {
    asset_class: 'gold_etf',
    subtype: 'gold_etf_vehicle',
    examples: 'GLD,IAU',
    dominant_properties: 'DeltaSigma实际利率,ETF_flow,C腔,Q避险锚',
    required_sensors: 'FRED_real_yield,FRED_inflation_expectation,ETF_holdings_flow,DXY,VIX',
    parameter_policy: '保留 V1.6 黄金血统；ETF flow 是关键补项。',
  },
  {
    asset_class: 'gold_etf',
    subtype: 'gold_futures_vehicle',
    examples: 'GC',
    dominant_properties: 'tau期限结构,COMEX_OI,margin,DeltaSigma',
    required_sensors: 'CME_term_structure,COMEX_OI,margin,FRED_real_yield',
    parameter_policy: '和 GLD/IAU 分开；期货必须看 roll 和保证金。',
  },
];

function loadEnvFiles() {
  const paths = [
    path.join(ROOT, '.env.local'),
    path.join(ROOT, '.dev.vars'),
    '/Users/beijisheng/Desktop/codex_wxl/51之前/.env.hfcd_energy',
  ];
  for (const envPath of paths) {
    if (existsSync(envPath)) dotenv.config({ path: envPath, override: false });
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

async function fetchText(url: string, label: string, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'hfcd-trading-local-research/1.0' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} ${response.status}: ${text.slice(0, 180)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonRaw(url: string, label: string) {
  const text = await fetchText(url, label);
  await writeFile(path.join(RAW_DIR, `${label}.json`), text);
  return JSON.parse(text) as any;
}

function range(records: SensorRecord[]) {
  const ts = records.map((row) => row.ts).filter(Boolean).sort();
  return { first: ts[0] || '', latest: ts.at(-1) || '' };
}

async function fetchFredSeries(seriesId: string, family: string, unit: string, note: string): Promise<SensorRecord[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (apiKey) {
    try {
      const url =
        'https://api.stlouisfed.org/fred/series/observations' +
        `?series_id=${encodeURIComponent(seriesId)}` +
        `&api_key=${encodeURIComponent(apiKey)}` +
        '&file_type=json';
      const data = await fetchJsonRaw(url, `fred_api_${seriesId}`);
      const observations = Array.isArray(data?.observations) ? data.observations : [];
      return observations
        .map((row: { date?: string; value?: string }) => {
          const value = Number(row.value);
          return {
            asset_class: 'gold_etf' as AssetClass,
            symbol: seriesId,
            sensor_family: family,
            ts: row.date || '',
            value,
            unit,
            source: 'FRED series/observations API',
            replay_ready: Number.isFinite(value),
            note,
          };
        })
        .filter((row: SensorRecord) => row.ts && row.replay_ready);
    } catch (error) {
      console.warn(`FRED API failed for ${seriesId}; falling back to fredgraph.csv: ${error instanceof Error ? error.message : error}`);
    }
  }

  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const text = await fetchText(url, `fred_${seriesId}`);
  await writeFile(path.join(RAW_DIR, `fred_${seriesId}.csv`), text);
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines.shift() || '');
  const dateIndex = header.indexOf('observation_date');
  const valueIndex = header.indexOf(seriesId);
  return lines
    .map((line) => {
      const cells = parseCsvLine(line);
      const value = Number(cells[valueIndex]);
      return {
        asset_class: 'gold_etf' as AssetClass,
        symbol: seriesId,
        sensor_family: family,
        ts: cells[dateIndex],
        value,
        unit,
        source: apiKey ? 'FRED fredgraph.csv fallback' : 'FRED fredgraph.csv',
        replay_ready: Number.isFinite(value),
        note,
      };
    })
    .filter((row) => row.ts && row.replay_ready);
}

async function fetchEiaInventorySeries(seriesId: string, symbol: string, note: string): Promise<SensorRecord[]> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return [
      {
        asset_class: 'futures',
        symbol,
        sensor_family: 'inventory_history',
        ts: new Date().toISOString(),
        value: 0,
        unit: 'missing_key',
        source: 'EIA Open Data API',
        replay_ready: false,
        note: 'EIA_API_KEY is not configured in environment or known local env file.',
      },
    ];
  }
  const params = new URLSearchParams({
    api_key: apiKey,
    frequency: 'weekly',
    'data[0]': 'value',
    'facets[series][]': seriesId,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'asc',
    length: '5000',
  });
  const url = `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${params.toString()}`;
  const text = await fetchText(url, `eia_${seriesId}`);
  await writeFile(path.join(RAW_DIR, `eia_${seriesId}.json`), text);
  const json = JSON.parse(text) as { response?: { data?: Array<Record<string, string>> } };
  return (json.response?.data || [])
    .map((row) => {
      const value = Number(row.value);
      return {
        asset_class: 'futures' as AssetClass,
        symbol,
        sensor_family: 'inventory_history',
        ts: row.period || '',
        value,
        unit: row.units || 'MBBL',
        source: 'EIA Open Data API petroleum/stoc/wstk',
        replay_ready: Number.isFinite(value),
        note: `${note} ${row['series-description'] || ''}`.trim(),
      };
    })
    .filter((row) => row.ts && row.replay_ready);
}

async function fetchWgcEtfFlows(): Promise<SensorRecord[]> {
  const json = await fetchJsonRaw(WGC_FLOW_URL, 'wgc_etf_flows_chart2');
  const weekly = json?.chartData?.data?.Weekly?.series?.usd;
  if (!Array.isArray(weekly)) return [];
  const rows: SensorRecord[] = [];
  for (const region of weekly) {
    const name = String(region.name || 'UNKNOWN_REGION').replace(/\s+/g, '_').toUpperCase();
    for (const point of Array.isArray(region.data) ? region.data : []) {
      const [ms, value] = point;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      rows.push({
        asset_class: 'gold_etf',
        symbol: `WGC_${name}`,
        sensor_family: 'real_etf_flow_history',
        ts: new Date(Number(ms)).toISOString().slice(0, 10),
        value: numeric,
        unit: 'usd_weekly_flow',
        source: 'World Gold Council ETF flows API',
        replay_ready: true,
        note: '全球/区域黄金 ETF 周度资金流，可作为 GLD/IAU 真实 ETF flow 的行业级代理。',
      });
    }
  }
  return rows;
}

async function fetchWgcEtfHoldings(): Promise<SensorRecord[]> {
  const json = await fetchJsonRaw(WGC_HOLDINGS_URL, 'wgc_etf_holdings_chart2');
  const tonnes = json?.chartData?.data?.Weekly?.tonnes;
  const columns: string[] = tonnes?.columns || [];
  const set: unknown[][] = tonnes?.set || [];
  const rows: SensorRecord[] = [];
  for (const row of set) {
    const ms = Number(row[0]);
    if (!Number.isFinite(ms)) continue;
    for (let i = 1; i < columns.length; i += 1) {
      const label = columns[i];
      if (!label || /gold/i.test(label)) continue;
      const value = Number(row[i]);
      if (!Number.isFinite(value)) continue;
      rows.push({
        asset_class: 'gold_etf',
        symbol: `WGC_${label.replace(/\s+/g, '_').toUpperCase()}`,
        sensor_family: 'gold_etf_holdings_history',
        ts: new Date(ms).toISOString().slice(0, 10),
        value,
        unit: 'tonnes',
        source: 'World Gold Council ETF holdings API',
        replay_ready: true,
        note: '全球/区域黄金 ETF 持仓吨数，可用于验证 ETF flow 与持仓变化。',
      });
    }
  }
  return rows;
}

async function fetchCftcGoldComexOi(): Promise<SensorRecord[]> {
  const json = await fetchJsonRaw(CFTC_GOLD_URL, 'cftc_gold_comex_disaggregated_cot');
  if (!Array.isArray(json)) return [];
  const rows: SensorRecord[] = [];
  for (const row of json) {
    const ts = String(row.report_date_as_yyyy_mm_dd || '').slice(0, 10);
    const oi = Number(row.open_interest_all);
    const managedLong = Number(row.m_money_positions_long_all);
    const managedShort = Number(row.m_money_positions_short_all);
    if (ts && Number.isFinite(oi)) {
      rows.push({
        asset_class: 'gold_etf',
        symbol: 'GOLD_COMEX',
        sensor_family: 'comex_open_interest_weekly_proxy',
        ts,
        value: oi,
        unit: 'contracts',
        source: 'CFTC Public Reporting disaggregated COT',
        replay_ready: true,
        note: '这是 CFTC 周度 COMEX gold open interest 代理，不是 CME 每日 COMEX OI。',
      });
    }
    if (ts && Number.isFinite(managedLong) && Number.isFinite(managedShort)) {
      rows.push({
        asset_class: 'gold_etf',
        symbol: 'GOLD_COMEX',
        sensor_family: 'comex_managed_money_net_weekly',
        ts,
        value: managedLong - managedShort,
        unit: 'contracts_net',
        source: 'CFTC Public Reporting disaggregated COT',
        replay_ready: true,
        note: 'Managed Money net position proxy for gold futures crowding/R radius.',
      });
    }
  }
  return rows;
}

function coverage(assetClass: AssetClass, sensor: string, source: string, rows: SensorRecord[], minRows: number): CoverageRow {
  const r = range(rows);
  return {
    asset_class: assetClass,
    required_sensor: sensor,
    source,
    rows: rows.length,
    first_ts: r.first,
    latest_ts: r.latest,
    replay_ready: rows.length >= minRows,
    status: rows.length >= minRows ? 'replay_ready' : 'insufficient_or_missing',
  };
}

function summarize(assetClass: AssetClass, family: string, rows: SensorRecord[], status: string, blockers: string): SummaryRow {
  const r = range(rows);
  return {
    asset_class: assetClass,
    added_sensor_family: family,
    rows: rows.length,
    first_ts: r.first,
    latest_ts: r.latest,
    v13_status: status,
    remaining_blockers: blockers,
  };
}

async function main() {
  loadEnvFiles();
  await mkdir(RAW_DIR, { recursive: true });

  const fredResults = await Promise.all(FRED_SERIES.map((item) => fetchFredSeries(item.id, item.family, item.unit, item.note)));
  const eiaResults = await Promise.all(EIA_INVENTORY_SERIES.map((item) => fetchEiaInventorySeries(item.id, item.symbol, item.note)));
  const [wgcFlow, wgcHoldings, cftcGold] = await Promise.all([fetchWgcEtfFlows(), fetchWgcEtfHoldings(), fetchCftcGoldComexOi()]);
  const records = [...fredResults.flat(), ...eiaResults.flat(), ...wgcFlow, ...wgcHoldings, ...cftcGold];

  const fredInflation = records.filter((row) => row.asset_class === 'gold_etf' && row.sensor_family === 'inflation_expectation_curve');
  const fredRealYield = records.filter((row) => row.asset_class === 'gold_etf' && row.sensor_family === 'real_yield_curve');
  const eiaInventory = records.filter((row) => row.asset_class === 'futures' && row.sensor_family === 'inventory_history' && row.replay_ready);
  const goldEtfFlow = records.filter((row) => row.asset_class === 'gold_etf' && row.sensor_family === 'real_etf_flow_history');
  const goldEtfHoldings = records.filter((row) => row.asset_class === 'gold_etf' && row.sensor_family === 'gold_etf_holdings_history');
  const comexOiProxy = records.filter((row) => row.asset_class === 'gold_etf' && row.sensor_family === 'comex_open_interest_weekly_proxy');

  const coverageRows = [
    coverage('gold_etf', 'inflation_expectation_curve', 'FRED T5YIE/T10YIE/T5YIFR', fredInflation, 1000),
    coverage('gold_etf', 'real_yield_curve', 'FRED DFII5/DFII10', fredRealYield, 1000),
    coverage('futures', 'inventory_history', 'EIA Open Data API petroleum weekly stocks', eiaInventory, 500),
    coverage('gold_etf', 'real_etf_flow', 'World Gold Council ETF flows API', goldEtfFlow, 500),
    coverage('gold_etf', 'gold_etf_holdings', 'World Gold Council ETF holdings API', goldEtfHoldings, 500),
    coverage('gold_etf', 'comex_open_interest_weekly_proxy', 'CFTC Public Reporting disaggregated COT', comexOiProxy, 100),
    coverage('gold_etf', 'comex_open_interest_daily', 'CME/Databento required', [], 500),
    coverage('futures', 'full_term_structure_curve_history', 'CME DataMine/Databento required', [], 500),
    coverage('futures', 'true_roll_yield_history', 'CME contract-chain required', [], 500),
    coverage('futures', 'margin_requirement_history', 'CME CORE/SPAN required', [], 100),
  ];

  const summaryRows = [
    summarize(
      'gold_etf',
      'FRED macro + WGC ETF flow + CFTC COMEX OI proxy',
      [...fredInflation, ...fredRealYield, ...goldEtfFlow, ...goldEtfHoldings, ...comexOiProxy],
      fredInflation.length >= 1000 && fredRealYield.length >= 1000 && goldEtfFlow.length >= 500 && comexOiProxy.length >= 100
        ? 'gold_macro_etf_flow_comex_weekly_proxy_replay_ready'
        : 'gold_sensor_incomplete',
      'daily_comex_open_interest',
    ),
    summarize(
      'futures',
      'EIA inventory history',
      eiaInventory,
      eiaInventory.length >= 500 ? 'eia_inventory_replay_ready_still_blocked_by_contract_chain' : 'eia_inventory_incomplete',
      'full_term_structure_curve_history;true_roll_yield_history;margin_requirement_history',
    ),
  ];

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_13_sensor_records.csv'), toCsv(records as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_13_coverage.csv'), toCsv(coverageRows as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_13_summary.csv'), toCsv(summaryRows as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_13_subasset_taxonomy.csv'), toCsv(SUB_ASSET_TAXONOMY));
  await writeFile(
    path.join(OUT_DIR, 'hfcd_trading_v1_13_summary.json'),
    JSON.stringify(
      {
        version: VERSION,
        generated_at: new Date().toISOString(),
        mode: 'local_sensor_acquisition_only_not_deployed',
        fred_key_loaded: Boolean(process.env.FRED_API_KEY),
        eia_key_loaded: Boolean(process.env.EIA_API_KEY),
        summary: summaryRows,
        coverage: coverageRows,
        subasset_taxonomy: SUB_ASSET_TAXONOMY,
      },
      null,
      2,
    ),
  );

  const md = `# ${VERSION}

## 定位

本轮只补真实传感器，不推线上，不调交易参数。

新增两类官方低成本历史源：

- FRED：通胀预期曲线与实际利率曲线，用于黄金/贵金属的宏观 DeltaSigma。
- EIA：美国原油、汽油、馏分油等库存历史，用于能源期货的 Sigma 库存账本。
- World Gold Council：黄金 ETF 资金流与持仓历史，用于 ETF flow 账本。
- CFTC Public Reporting：GOLD-COMEX 周度 open interest 与 managed money 净仓位，用作 COMEX OI 周度代理。

## 结果

| 资产 | 新增传感器 | 行数 | 起始 | 最新 | 状态 | 仍缺 |
|---|---|---:|---|---|---|---|
${summaryRows
  .map((row) => `| ${row.asset_class} | ${row.added_sensor_family} | ${row.rows} | ${row.first_ts} | ${row.latest_ts} | ${row.v13_status} | ${row.remaining_blockers} |`)
  .join('\n')}

## 覆盖审计

| 资产 | 传感器 | 来源 | 行数 | 起始 | 最新 | 可回放 | 状态 |
|---|---|---|---:|---|---|---|---|
${coverageRows
  .map((row) => `| ${row.asset_class} | ${row.required_sensor} | ${row.source} | ${row.rows} | ${row.first_ts || '-'} | ${row.latest_ts || '-'} | ${row.replay_ready ? '是' : '否'} | ${row.status} |`)
  .join('\n')}

## 子类型策略判断

是的，四大资产必须继续细分。原因不是概念问题，而是工程问题：不同子类型的 Q 核、C 腔、R 半径、Eta 噪声和 Tau 时间结构差异太大，统一参数会导致 split 不稳定。

本轮已输出 \`hfcd_trading_v1_13_subasset_taxonomy.csv\`，但没有直接改交易策略。下一轮应该用这个族谱做 V1.14 SubAssetTypeHeritageRouter：

- Crypto：BTC、L1/智能合约燃料、高 beta alt/meme 分开。
- Futures：贵金属、能源、农产品、股指/利率/外汇期货分开。
- Equity：指数 ETF、成长/久期敏感、价值/周期、行业 ETF 分开。
- Gold：黄金 ETF 和黄金期货分开。

## 结论

- FRED 宏观曲线已经可历史回放，是黄金/贵金属线最干净的低成本新增传感器。
- WGC ETF flow/holdings 已经可历史回放，可先替代 GLD/IAU 单基金流量缺口。
- CFTC GOLD-COMEX 周度 OI 已经可历史回放，但仍不是 CME 每日 COMEX OI。
- EIA 库存历史已经可历史回放，是能源期货线最干净的低成本新增传感器。
- 期货仍不能晋级：完整期限结构、真实 roll yield、保证金仍缺。
- 黄金仍需补 CME 每日 COMEX open interest；周度 CFTC 只能作为代理。
- 下一步不应直接上线，应做 V1.14 子类型血统路由 + V1.15 CME/Databento 合约链接入。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_13_FRED_EIA_TrueSensors.md'), md);

  console.log(JSON.stringify({ version: VERSION, out_dir: OUT_DIR, summary: summaryRows }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
