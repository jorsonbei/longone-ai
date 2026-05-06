import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

type CsvRow = Record<string, string>;

type LedgerRow = {
  layer: string;
  sensor: string;
  property_target: string;
  source: string;
  rows: number;
  first_ts: string;
  latest_ts: string;
  replay_status: string;
  current_status: string;
  model_use: string;
  remaining_gap: string;
};

const VERSION = 'HFCD_Trading_V1_15_GoldSensorFusion';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_15_gold_sensor_fusion');
const V13_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_13_fred_eia_true_sensors');
const V14_DB_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_14_gold_databento_probe');
const V14_VOI_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_14_cme_voi_local_file');

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

async function readCsv(filePath: string): Promise<CsvRow[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, 'utf-8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
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

function numberValue(value: string | number | undefined) {
  const numeric = Number(String(value ?? '').replaceAll(',', ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function latestByFamily(records: CsvRow[], family: string) {
  return records
    .filter((row) => row.asset_class === 'gold_etf' && row.sensor_family === family && row.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .at(-1);
}

function latestAggregateByFamily(records: CsvRow[], family: string, symbol: string, excludeSymbolIncludes: string[] = []) {
  const familyRows = records.filter(
    (row) =>
      row.asset_class === 'gold_etf' &&
      row.sensor_family === family &&
      row.ts &&
      !excludeSymbolIncludes.some((pattern) => row.symbol.includes(pattern)),
  );
  const latestTs = familyRows.map((row) => row.ts).sort().at(-1);
  if (!latestTs) return undefined;
  const rows = familyRows.filter((row) => row.ts === latestTs);
  const value = rows.reduce((sum, row) => sum + numberValue(row.value), 0);
  return {
    sensor_family: family,
    symbol,
    ts: latestTs,
    value: String(Number(value.toFixed(6))),
    unit: rows[0]?.unit || '',
    source: rows[0]?.source || '',
  };
}

function latestBySymbol(records: CsvRow[], family: string, symbol: string) {
  return records
    .filter((row) => row.asset_class === 'gold_etf' && row.sensor_family === family && row.symbol === symbol && row.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .at(-1);
}

function coverageBySensor(coverage: CsvRow[], sensor: string) {
  return coverage.find((row) => row.asset_class === 'gold_etf' && row.required_sensor === sensor);
}

function coverageLedger(
  coverage: CsvRow[],
  sensor: string,
  layer: string,
  propertyTarget: string,
  modelUse: string,
  remainingGap = '',
): LedgerRow {
  const row = coverageBySensor(coverage, sensor);
  return {
    layer,
    sensor,
    property_target: propertyTarget,
    source: row?.source || '',
    rows: numberValue(row?.rows),
    first_ts: row?.first_ts || '',
    latest_ts: row?.latest_ts || '',
    replay_status: row?.replay_ready === 'true' ? 'historical_replay_ready' : row?.status || 'missing',
    current_status: row?.status || 'missing',
    model_use: modelUse,
    remaining_gap: remainingGap,
  };
}

function table(rows: Record<string, unknown>[], columns: string[]) {
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(row[column] ?? '').replaceAll('|', '/')).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const coverage = await readCsv(path.join(V13_DIR, 'hfcd_trading_v1_13_coverage.csv'));
  const sensorRecords = await readCsv(path.join(V13_DIR, 'hfcd_trading_v1_13_sensor_records.csv'));
  const voiFutures = await readCsv(path.join(V14_VOI_DIR, 'hfcd_trading_v1_14_cme_voi_futures.csv'));
  const voiSummary = await readJson<Record<string, any>>(path.join(V14_VOI_DIR, 'hfcd_trading_v1_14_cme_voi_summary.json'), {});
  const databentoProbe = await readJson<Record<string, any>>(
    path.join(V14_DB_DIR, 'hfcd_trading_v1_14_gold_databento_probe.json'),
    {},
  );

  const databentoSchemas = new Set<string>(Array.isArray(databentoProbe.schemas) ? databentoProbe.schemas : []);
  const topVoiMonth = Array.isArray(voiSummary.top_future_months_by_open_interest)
    ? voiSummary.top_future_months_by_open_interest[0]
    : undefined;

  const ledger: LedgerRow[] = [
    coverageLedger(
      coverage,
      'real_yield_curve',
      'macro_delta_sigma',
      'DeltaSigma 实际利率势差',
      '黄金 ETF/期货方向核心输入；利率下行通常支持黄金。',
    ),
    coverageLedger(
      coverage,
      'inflation_expectation_curve',
      'macro_delta_sigma',
      'DeltaSigma 通胀预期曲线',
      '判断实际利率与通胀预期共同方向。',
    ),
    coverageLedger(
      coverage,
      'real_etf_flow',
      'sigma_ledger',
      'Sigma ETF 资金流',
      '黄金 ETF 入场/减仓的真实资金流传感器。',
    ),
    coverageLedger(
      coverage,
      'gold_etf_holdings',
      'q_core',
      'Q核/ETF 持仓锚',
      '判断黄金 ETF 需求是否持续，不只看价格。',
    ),
    coverageLedger(
      coverage,
      'comex_open_interest_weekly_proxy',
      'r_radius',
      'R半径/CFTC 周度持仓代理',
      '可回放，但频率是周度；不能替代每日 COMEX OI。',
      '需要 CME/Databento 每日 OI 校准。',
    ),
    {
      layer: 'cme_gold_voi_snapshot',
      sensor: 'cme_gold_futures_volume_open_interest',
      property_target: 'C腔/R半径/τ时间项',
      source: voiSummary.source_url || 'CME Group Gold Volume & OI',
      rows: numberValue(voiSummary.futures_contract_months),
      first_ts: 'single_snapshot',
      latest_ts: 'Friday 01 May 2026 page snapshot',
      replay_status: 'single_day_snapshot_not_training_history',
      current_status: 'confirmed_cme_gold_current_snapshot',
      model_use: `当前黄金期货成交量 ${numberValue(voiSummary.total_future_volume).toLocaleString()}、OI ${numberValue(
        voiSummary.total_future_open_interest_at_close,
      ).toLocaleString()}；主力 ${topVoiMonth?.month || ''} OI ${numberValue(topVoiMonth?.open_interest_at_close).toLocaleString()}。`,
      remaining_gap: '需要每天归档或用 Databento 拉历史。',
    },
    {
      layer: 'databento_gold_metadata',
      sensor: 'gc_contract_chain',
      property_target: 'τ时间项/真实合约链',
      source: 'Databento GLBX.MDP3 definition + GC.FUT symbology',
      rows: numberValue(databentoProbe.symbology_GC?.resolved_symbol_count),
      first_ts: String(databentoProbe.dataset_range?.start || ''),
      latest_ts: String(databentoProbe.dataset_range?.end || ''),
      replay_status: databentoProbe.metadata_status === 'metadata_probe_pass' ? 'metadata_ready_history_download_needed' : 'not_ready',
      current_status: databentoProbe.metadata_status || 'not_checked',
      model_use: '确认 GC/MGC 合约链可解析，用于期限结构、换月、roll yield。',
      remaining_gap: '尚未下载可训练的合约链历史表。',
    },
    {
      layer: 'databento_gold_metadata',
      sensor: 'gc_daily_ohlcv',
      property_target: '价格/Q核/Π相干/C腔',
      source: 'Databento GLBX.MDP3 ohlcv-1d',
      rows: databentoSchemas.has('ohlcv-1d') ? 1 : 0,
      first_ts: String(databentoProbe.dataset_range?.schema?.['ohlcv-1d']?.start || ''),
      latest_ts: String(databentoProbe.dataset_range?.schema?.['ohlcv-1d']?.end || ''),
      replay_status: databentoSchemas.has('ohlcv-1d') ? 'schema_available_history_download_needed' : 'missing_schema',
      current_status: databentoSchemas.has('ohlcv-1d') ? 'available' : 'missing',
      model_use: '可补黄金期货真实 OHLCV 历史。',
      remaining_gap: '尚未下载训练集；目前只是元数据确认。',
    },
    {
      layer: 'databento_gold_metadata',
      sensor: 'gc_daily_statistics_open_interest',
      property_target: 'R半径/每日 COMEX OI',
      source: 'Databento GLBX.MDP3 statistics',
      rows: databentoSchemas.has('statistics') ? 1 : 0,
      first_ts: String(databentoProbe.dataset_range?.schema?.statistics?.start || ''),
      latest_ts: String(databentoProbe.dataset_range?.schema?.statistics?.end || ''),
      replay_status: databentoSchemas.has('statistics') ? 'schema_available_sample_download_needed' : 'missing_schema',
      current_status: databentoSchemas.has('statistics') ? 'available' : 'missing',
      model_use: '目标是替代 CFTC 周度代理，形成每日 COMEX OI。',
      remaining_gap: '需要小样本下载确认 stat_type 与 open interest 字段映射。',
    },
    {
      layer: 'databento_gold_metadata',
      sensor: 'gc_execution_cavity_l2',
      property_target: 'C腔/真实盘口深度',
      source: 'Databento GLBX.MDP3 bbo-1s/mbp-1/mbp-10',
      rows: ['bbo-1s', 'mbp-1', 'mbp-10'].filter((schema) => databentoSchemas.has(schema)).length,
      first_ts: String(databentoProbe.dataset_range?.schema?.['bbo-1s']?.start || ''),
      latest_ts: String(databentoProbe.dataset_range?.schema?.['bbo-1s']?.end || ''),
      replay_status: databentoSchemas.has('bbo-1s') ? 'schema_available_billable_history_download_needed' : 'missing_schema',
      current_status: databentoSchemas.has('bbo-1s') ? 'available' : 'missing',
      model_use: '执行过滤、滑点和 C腔干涸门。',
      remaining_gap: '没有拉取历史盘口；训练前需限定日期避免大额数据成本。',
    },
  ];

  const gaps: LedgerRow[] = [
    {
      layer: 'missing_macro',
      sensor: 'DXY_and_VIX_gold_context',
      property_target: 'DeltaSigma/Omega',
      source: 'FRED/Yahoo/Stooq or paid macro feed',
      rows: 0,
      first_ts: '',
      latest_ts: '',
      replay_status: 'missing_in_v15_inputs',
      current_status: 'missing',
      model_use: '美元指数和风险偏好是黄金势差的重要外部变量。',
      remaining_gap: 'V1.13 已有利率/通胀，但本融合账本还没有 DXY/VIX 历史。',
    },
    {
      layer: 'missing_gold',
      sensor: 'daily_margin_requirement_history',
      property_target: 'Bσ黑子/R半径',
      source: 'CME CORE/SPAN or broker margin files',
      rows: 0,
      first_ts: '',
      latest_ts: '',
      replay_status: 'missing',
      current_status: 'missing',
      model_use: '保证金变化会改变杠杆约束和强平风险。',
      remaining_gap: '未接 CME CORE/SPAN 历史。',
    },
    {
      layer: 'missing_gold',
      sensor: 'options_voi_strike_history',
      property_target: 'Bσ黑子/极端价位拥挤',
      source: 'CME Gold Options Volume & OI tab or Databento options symbols',
      rows: 0,
      first_ts: '',
      latest_ts: '',
      replay_status: 'missing_for_training',
      current_status: 'not_downloaded',
      model_use: '识别期权行权价拥挤、尾部风险和潜在 pinning。',
      remaining_gap: '当前文件来自 Futures 标签页，Options 数据为 0。',
    },
  ];

  const latestReadings = [
    latestByFamily(sensorRecords, 'real_yield_curve'),
    latestByFamily(sensorRecords, 'inflation_expectation_curve'),
    latestAggregateByFamily(sensorRecords, 'real_etf_flow_history', 'WGC_TOTAL_EX_PRICE_REFERENCE', ['GOLD_PRICE']),
    latestAggregateByFamily(sensorRecords, 'gold_etf_holdings_history', 'WGC_TOTAL_HOLDINGS', []),
    latestBySymbol(sensorRecords, 'real_etf_flow_history', 'WGC_GOLD_PRICE_(RHS)'),
    latestByFamily(sensorRecords, 'comex_open_interest_weekly_proxy'),
    latestByFamily(sensorRecords, 'comex_managed_money_net_weekly'),
  ]
    .filter(Boolean)
    .map((row) => ({
      sensor_family: row!.sensor_family,
      symbol: row!.symbol,
      latest_ts: row!.ts,
      latest_value: row!.value,
      unit: row!.unit,
      source: row!.source,
    }));

  const historicalReadyCount = ledger.filter((row) => row.replay_status.includes('historical_replay_ready')).length;
  const schemaReadyCount = ledger.filter((row) => row.replay_status.includes('schema_available') || row.replay_status.includes('metadata_ready')).length;
  const snapshotCount = ledger.filter((row) => row.replay_status.includes('snapshot')).length;
  const hardMissingCount = gaps.length;

  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_gold_sensor_fusion_not_deployed',
    source_versions: ['V1.13 FRED/EIA TrueSensors', 'V1.14 Databento metadata probe', 'V1.14 CME Gold VOI local parser'],
    gold_data_status:
      hardMissingCount === 0
        ? 'gold_sensor_stack_complete'
        : 'gold_sensor_stack_research_ready_but_not_execution_complete',
    historical_replay_ready_sensors: historicalReadyCount,
    schema_or_metadata_ready_sensors: schemaReadyCount,
    current_snapshot_sensors: snapshotCount,
    hard_missing_sensors: hardMissingCount,
    cme_gold_voi_confirmed: voiSummary.product_identity === 'confirmed_cme_group_gold_futures_volume_open_interest',
    databento_metadata_status: databentoProbe.metadata_status || 'not_checked',
    total_gold_voi_volume: numberValue(voiSummary.total_future_volume),
    total_gold_voi_open_interest: numberValue(voiSummary.total_future_open_interest_at_close),
    top_voi_month: topVoiMonth || null,
    conclusion:
      '黄金数据已经足够做本地研究和下一步回放准备，但还不是完整实盘级数据层；主要缺口是 DXY/VIX、每日 COMEX OI 实下载、合约链/roll yield 历史、保证金历史和期权 VOI 历史。',
  };

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_15_gold_sensor_fusion_ledger.csv'), toCsv(ledger), 'utf-8');
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_15_gold_sensor_fusion_gaps.csv'), toCsv(gaps), 'utf-8');
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_15_gold_latest_readings.csv'), toCsv(latestReadings), 'utf-8');
  await writeFile(
    path.join(OUT_DIR, 'hfcd_trading_v1_15_gold_sensor_fusion_summary.json'),
    JSON.stringify({ ...summary, ledger, gaps, latest_readings: latestReadings }, null, 2),
    'utf-8',
  );

  const md = `# ${VERSION}

## 定位

V1.15 把黄金线已有数据合并成一个专属传感器账本：FRED 宏观、World Gold Council ETF flow/holdings、CFTC 周度 COMEX 代理、Databento 黄金期货元数据、CME Gold Volume & OI 单日快照。

本轮不推线上，不做实盘结论；目标是判断黄金数据是否足够进入下一步本地回放训练。

## 总结

- 黄金数据状态：${summary.gold_data_status}
- 历史可回放传感器：${historicalReadyCount}
- 已确认但仍需下载历史的 Databento schema/元数据：${schemaReadyCount}
- 当前快照传感器：${snapshotCount}
- 硬缺口：${hardMissingCount}
- CME Gold VOI 来源确认：${summary.cme_gold_voi_confirmed ? '是' : '否'}
- Databento 元数据状态：${summary.databento_metadata_status}

## 当前黄金 VOI 快照

- 总成交量：${numberValue(voiSummary.total_future_volume).toLocaleString()}
- 总未平仓量：${numberValue(voiSummary.total_future_open_interest_at_close).toLocaleString()}
- 主力月份：${topVoiMonth?.month || '-'}
- 主力月份 OI：${numberValue(topVoiMonth?.open_interest_at_close).toLocaleString()}
- 主力月份成交量：${numberValue(topVoiMonth?.total_volume).toLocaleString()}

## 黄金传感器账本

${table(ledger, ['layer', 'sensor', 'property_target', 'rows', 'latest_ts', 'replay_status', 'remaining_gap'])}

## 最新读数

${table(latestReadings, ['sensor_family', 'symbol', 'latest_ts', 'latest_value', 'unit'])}

## 仍缺数据

${table(gaps, ['sensor', 'property_target', 'source', 'replay_status', 'remaining_gap'])}

## 回答：黄金交易的数据全不全？

不算全，但已经比前几轮完整很多。

现在已具备：

- FRED 实际利率与通胀预期曲线，可做黄金的宏观势差。
- World Gold Council ETF flow/holdings，可做黄金 ETF 的真实资金流和 Q 核。
- CFTC 周度 COMEX OI/Managed Money 代理，可做拥挤度周度回放。
- CME Gold VOI 单日快照，可补当前成交量、未平仓量和期限分布。
- Databento 已确认 GLBX.MDP3 的 GC/MGC 合约链、OHLCV、statistics、盘口 schema 可用。

还不完整：

- DXY/VIX 还没有并入这张黄金融合账本。
- Databento 只是元数据通过，GC 合约链、每日 OHLCV、每日 OI、期限结构和盘口历史还没有实际下载成训练表。
- CME Gold VOI 目前只有单日快照，不是历史序列。
- 黄金期权 VOI、保证金历史、真实 roll yield 历史还没落地。

结论：V1.15 已经适合进入本地黄金专线回放准备，但还不能说黄金数据层达到完整自动交易级别。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_15_GoldSensorFusion.md'), md, 'utf-8');

  console.log(JSON.stringify(summary, null, 2));
  console.log(`out_dir=${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
