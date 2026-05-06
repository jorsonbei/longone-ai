import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AssetClass = 'gold_etf' | 'futures' | 'crypto' | 'equity_etf';

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

type V17Sample = {
  asset_class: AssetClass;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  background_gate: number;
  execution_gate: number;
  manifest_gate: number;
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
  hold_bars: number;
  dynamic_exit_reason: string;
  dynamic_pnl_usd: number;
  final_sustain_score: number;
  final_q_error: number;
  final_b_sigma: number;
  final_c_cavity: number;
};

type FeedCoverage = {
  symbol: string;
  asset_class: AssetClass;
  avg_recent_feed_quality: number;
  rows: number;
};

type EnrichedTrade = V19Trade & {
  q_entry_score: number;
  entry_coherence: number;
  entry_noise: number;
  entry_radius: number;
  entry_b_sigma: number;
  q_state: string;
  state_action: string;
  state_reason: string;
  final_q_error?: number;
  final_b_sigma?: number;
  final_c_cavity?: number;
  hold_bars?: number;
};

type Metric = {
  trades: number;
  win_rate: number;
  net_pnl_usd: number;
  max_drawdown_usd: number;
  profit_factor: number;
  avg_pnl_usd: number;
};

const VERSION = 'HFCD_Trading_V1_10_QCoreStateMachine';
const ROOT = process.cwd();
const V17_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_7_tnpap_cascade');
const V18_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_8_dynamic_decoherence_exit');
const V19_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_9_asset_heritage_selector');
const V16_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_6_true_feeds');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_10_qcore_state_machine');

const ENTRY_SENSOR_RULES: Record<AssetClass, { etaMax: number; radiusMax: number; bSigmaMax: number; description: string }> = {
  gold_etf: {
    etaMax: 1,
    radiusMax: 1,
    bSigmaMax: 1,
    description: '保留 V1.6/V1.9 黄金血统，不额外覆盖已通过的真实物性入口。',
  },
  equity_etf: {
    etaMax: 1,
    radiusMax: 1,
    bSigmaMax: 1,
    description: '保留 V1.7/V1.8 股票血统，不额外覆盖已通过的低频背景海入口。',
  },
  crypto: {
    etaMax: 0.60,
    radiusMax: 0.25,
    bSigmaMax: 0.35,
    description: '加密只放行低噪声、低半径拥挤、低黑子风险的 V1.9 正收益样本。',
  },
  futures: {
    etaMax: 0.60,
    radiusMax: 0.30,
    bSigmaMax: 0.30,
    description: '期货只放行低噪声、半径未扩张、黑子风险低的 V1.9 正收益样本。',
  },
};

const SENSOR_CATALOG: Record<AssetClass, { available: string[]; missing: string[] }> = {
  gold_etf: {
    available: ['DXY proxy', '10Y rate proxy', 'TIP proxy', 'VIX', 'CFTC COT', 'ETF/futures basis proxy', 'volume cavity'],
    missing: ['real-time gold ETF flow', 'COMEX open interest history', 'inflation expectation curve'],
  },
  equity_etf: {
    available: ['VIX', 'credit risk proxy', 'sector ETF proxy', 'equal-weight breadth proxy', 'volume cavity'],
    missing: ['advance/decline line', 'new high/new low breadth', 'real sector rotation flow'],
  },
  crypto: {
    available: ['Binance funding', 'open interest proxy', 'long/short account ratio', 'volume cavity'],
    missing: ['stablecoin mint/burn liquidity', 'exchange netflow', 'liquidation feed', 'on-chain active addresses', 'L2 orderbook depth'],
  },
  futures: {
    available: ['CFTC COT', 'ETF/futures basis proxy', 'volume cavity'],
    missing: ['full term-structure curve', 'roll yield history', 'inventory proxy', 'margin requirement', 'calendar roll risk'],
  },
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

function parseV19(text: string): V19Trade[] {
  return parseRows(text, (row) => ({
    asset_class: row.asset_class as AssetClass,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    entry_ts: row.entry_ts,
    exit_ts: row.exit_ts,
    source_version: row.source_version,
    heritage_policy: row.heritage_policy,
    selected_rule: row.selected_rule,
    exit_reason: row.exit_reason,
    pnl_usd: Number(row.pnl_usd),
    baseline_pnl_usd: Number(row.baseline_pnl_usd),
    score: Number(row.score),
    quality_1: Number(row.quality_1),
    quality_2: Number(row.quality_2),
    quality_3: Number(row.quality_3),
  })).filter((row) => row.asset_class && row.symbol && row.entry_ts && Number.isFinite(row.pnl_usd));
}

function parseV17(text: string): V17Sample[] {
  return parseRows(text, (row) => ({
    asset_class: row.asset_class as AssetClass,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    entry_ts: row.entry_ts,
    background_gate: Number(row.background_gate),
    execution_gate: Number(row.execution_gate),
    manifest_gate: Number(row.manifest_gate),
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
  })).filter((row) => row.asset_class && row.symbol && row.entry_ts);
}

function parseV18(text: string): V18Replay[] {
  return parseRows(text, (row) => ({
    policy: row.policy,
    asset_class: row.asset_class as AssetClass,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    entry_ts: row.entry_ts,
    hold_bars: Number(row.hold_bars),
    dynamic_exit_reason: row.dynamic_exit_reason,
    dynamic_pnl_usd: Number(row.dynamic_pnl_usd),
    final_sustain_score: Number(row.final_sustain_score),
    final_q_error: Number(row.final_q_error),
    final_b_sigma: Number(row.final_b_sigma),
    final_c_cavity: Number(row.final_c_cavity),
  })).filter((row) => row.asset_class && row.symbol && row.entry_ts);
}

function parseFeedCoverage(text: string): FeedCoverage[] {
  return parseRows(text, (row) => ({
    symbol: row.symbol,
    asset_class: row.asset_class as AssetClass,
    avg_recent_feed_quality: Number(row.avg_recent_feed_quality),
    rows: Number(row.rows),
  })).filter((row) => row.symbol && row.asset_class);
}

function key(row: { asset_class: AssetClass; symbol: string; side: string; entry_ts: string }) {
  return `${row.asset_class}|${row.symbol}|${row.side}|${row.entry_ts}`;
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function pct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function profitFactor(values: number[]) {
  const grossWin = values.filter((x) => x > 0).reduce((sum, x) => sum + x, 0);
  const grossLoss = Math.abs(values.filter((x) => x < 0).reduce((sum, x) => sum + x, 0));
  return grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
}

function summarize(rows: { entry_ts: string; pnl_usd: number }[]): Metric {
  const sorted = [...rows].sort((a, b) => new Date(a.entry_ts).getTime() - new Date(b.entry_ts).getTime());
  const values = sorted.map((row) => row.pnl_usd);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  return {
    trades: rows.length,
    win_rate: rows.length ? values.filter((x) => x > 0).length / rows.length : 0,
    net_pnl_usd: values.reduce((sum, x) => sum + x, 0),
    max_drawdown_usd: maxDrawdown,
    profit_factor: profitFactor(values),
    avg_pnl_usd: rows.length ? values.reduce((sum, x) => sum + x, 0) / rows.length : 0,
  };
}

function splitRows<T extends { entry_ts: string }>(rows: T[]) {
  const sorted = [...rows].sort((a, b) => new Date(a.entry_ts).getTime() - new Date(b.entry_ts).getTime());
  const cut = Math.floor(sorted.length * 0.70);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

function statusFor(assetClass: AssetClass, all: Metric, test: Metric) {
  if (
    all.trades >= 30 &&
    all.net_pnl_usd > 0 &&
    all.profit_factor >= 1.15 &&
    test.trades >= 8 &&
    test.net_pnl_usd > 0 &&
    test.profit_factor >= 1.05
  ) {
    return assetClass === 'crypto' || assetClass === 'futures' ? 'local_walk_forward_candidate_needs_external_sensor_confirm' : 'qcore_state_machine_pass';
  }
  if (all.trades >= 20 && all.net_pnl_usd > 0 && all.profit_factor >= 1.05) return 'positive_watchlist_split_unstable';
  return 'blocked';
}

function entryQScore(sample?: V17Sample, fallback?: V19Trade) {
  if (!sample) return clamp(fallback?.score || 0);
  return clamp(
    sample.q_core * 0.34 +
      sample.pi_coherence * 0.18 +
      sample.delta_sigma * 0.16 +
      sample.c_cavity * 0.14 +
      sample.sigma_ledger * 0.10 +
      (1 - sample.b_sigma) * 0.08,
  );
}

function entryCoherence(sample?: V17Sample, fallback?: V19Trade) {
  if (!sample) return clamp(fallback?.quality_1 || 0);
  return clamp((sample.background_gate + sample.execution_gate + sample.manifest_gate) / 3);
}

function classifyQState(finalQError?: number, entryNoise = 0, entryRadius = 0, entryBSigma = 0) {
  if (finalQError !== undefined && finalQError >= 0.42) return ['catastrophe', 'Q核已严重背离，属于退出太晚的历史亏损源'] as const;
  if (finalQError !== undefined && finalQError >= 0.30) return ['exit_ready', 'Q核背离已进入退出区'] as const;
  if (finalQError !== undefined && finalQError >= 0.20) return ['decohering', 'Q核开始退相干，应降仓或禁止加仓'] as const;
  if (entryNoise > 0.60 || entryRadius > 0.30 || entryBSigma > 0.35) return ['weakening', '入场噪声、半径或黑子风险偏高'] as const;
  return ['healthy', 'Q核与入场结构仍在安全区'] as const;
}

function rejectReason(assetClass: AssetClass, sample?: V17Sample) {
  if (!sample) return '';
  const rule = ENTRY_SENSOR_RULES[assetClass];
  if (sample.eta_freedom > rule.etaMax) return '波动噪声过高';
  if (sample.r_radius > rule.radiusMax) return '半径/拥挤度过热';
  if (sample.b_sigma > rule.bSigmaMax) return '黑子风险偏高';
  return '';
}

function enrichTrade(trade: V19Trade, v17ByKey: Map<string, V17Sample>, v18ByKey: Map<string, V18Replay>) {
  const k = key(trade);
  const sample = v17ByKey.get(k);
  const replay = v18ByKey.get(k);
  const qEntry = entryQScore(sample, trade);
  const coherence = entryCoherence(sample, trade);
  const entryNoise = sample?.eta_freedom ?? 0;
  const entryRadius = sample?.r_radius ?? 0;
  const entryBSigma = sample?.b_sigma ?? 0;
  const [qState, stateReason] = classifyQState(replay?.final_q_error, entryNoise, entryRadius, entryBSigma);
  const stateAction =
    qState === 'catastrophe' || qState === 'exit_ready'
      ? 'hard_exit'
      : qState === 'decohering'
        ? 'soft_reduce'
        : qState === 'weakening'
          ? 'no_add'
          : 'hold';
  return {
    ...trade,
    q_entry_score: qEntry,
    entry_coherence: coherence,
    entry_noise: entryNoise,
    entry_radius: entryRadius,
    entry_b_sigma: entryBSigma,
    q_state: qState,
    state_action: stateAction,
    state_reason: stateReason,
    final_q_error: replay?.final_q_error,
    final_b_sigma: replay?.final_b_sigma,
    final_c_cavity: replay?.final_c_cavity,
    hold_bars: replay?.hold_bars,
  };
}

function selectV110(trades: EnrichedTrade[]) {
  const selected: EnrichedTrade[] = [];
  const rejected: Record<string, unknown>[] = [];
  for (const trade of trades) {
    const reason = rejectReason(trade.asset_class, {
      asset_class: trade.asset_class,
      symbol: trade.symbol,
      side: trade.side,
      entry_ts: trade.entry_ts,
      background_gate: 0,
      execution_gate: 0,
      manifest_gate: 0,
      q_core: 0,
      delta_sigma: 0,
      c_cavity: 0,
      pi_coherence: 0,
      sigma_ledger: 0,
      eta_freedom: trade.entry_noise,
      b_sigma: trade.entry_b_sigma,
      r_radius: trade.entry_radius,
      tau_time: 0,
      omega_coupling: 0,
      freshness: 0,
    });
    if (!reason) selected.push(trade);
    else {
      rejected.push({
        asset_class: trade.asset_class,
        symbol: trade.symbol,
        side: trade.side,
        entry_ts: trade.entry_ts,
        reason,
        q_entry_score: trade.q_entry_score,
        entry_noise: trade.entry_noise,
        entry_radius: trade.entry_radius,
        entry_b_sigma: trade.entry_b_sigma,
        pnl_usd_would_have_been: trade.pnl_usd,
      });
    }
  }
  return { selected, rejected };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const v19 = parseV19(await readFile(path.join(V19_DIR, 'hfcd_trading_v1_9_selected_trades.csv'), 'utf8'));
  const v17 = parseV17(await readFile(path.join(V17_DIR, 'hfcd_trading_v1_7_property_samples.csv'), 'utf8'));
  const v18 = parseV18(await readFile(path.join(V18_DIR, 'hfcd_trading_v1_8_replay_trades.csv'), 'utf8'));
  const coverage = parseFeedCoverage(await readFile(path.join(V16_DIR, 'hfcd_trading_v1_6_feed_coverage.csv'), 'utf8'));

  const v17ByKey = new Map(v17.map((row) => [key(row), row]));
  const v18ByKey = new Map(
    v18
      .filter((row) => {
        if (row.asset_class === 'futures') return row.policy === 'dynamic_mid';
        if (row.asset_class === 'crypto' || row.asset_class === 'equity_etf') return row.policy === 'dynamic_soft';
        return false;
      })
      .map((row) => [key(row), row]),
  );
  const enriched = v19.map((trade) => enrichTrade(trade, v17ByKey, v18ByKey));
  const { selected, rejected } = selectV110(enriched);

  const summaryRows: Record<string, unknown>[] = [];
  const splitRowsOut: Record<string, unknown>[] = [];
  const compareRows: Record<string, unknown>[] = [];
  for (const assetClass of ['gold_etf', 'equity_etf', 'crypto', 'futures'] as const) {
    const v19Rows = enriched.filter((row) => row.asset_class === assetClass);
    const v110Rows = selected.filter((row) => row.asset_class === assetClass);
    const v19Metric = summarize(v19Rows);
    const v110Metric = summarize(v110Rows);
    const { train, test } = splitRows(v110Rows);
    const trainMetric = summarize(train);
    const testMetric = summarize(test);
    summaryRows.push({
      asset_class: assetClass,
      lineage_preserved: v110Rows[0]?.heritage_policy || v19Rows[0]?.heritage_policy || '-',
      entry_sensor_rule: ENTRY_SENSOR_RULES[assetClass].description,
      trades: v110Metric.trades,
      win_rate: v110Metric.win_rate,
      net_pnl_usd: v110Metric.net_pnl_usd,
      max_drawdown_usd: v110Metric.max_drawdown_usd,
      profit_factor: v110Metric.profit_factor,
      test_trades: testMetric.trades,
      test_win_rate: testMetric.win_rate,
      test_net_pnl_usd: testMetric.net_pnl_usd,
      test_profit_factor: testMetric.profit_factor,
      rejected_count: v19Rows.length - v110Rows.length,
      status: statusFor(assetClass, v110Metric, testMetric),
    });
    compareRows.push({
      asset_class: assetClass,
      v19_trades: v19Metric.trades,
      v19_net_pnl_usd: v19Metric.net_pnl_usd,
      v19_profit_factor: v19Metric.profit_factor,
      v110_trades: v110Metric.trades,
      v110_net_pnl_usd: v110Metric.net_pnl_usd,
      v110_profit_factor: v110Metric.profit_factor,
      delta_pnl_usd: v110Metric.net_pnl_usd - v19Metric.net_pnl_usd,
      delta_profit_factor: v110Metric.profit_factor - v19Metric.profit_factor,
    });
    for (const [fold, metric] of [
      ['train_70pct', trainMetric],
      ['test_30pct', testMetric],
    ] as const) {
      splitRowsOut.push({
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

  const stateRows: Record<string, unknown>[] = [];
  for (const assetClass of ['gold_etf', 'equity_etf', 'crypto', 'futures'] as const) {
    const assetRows = selected.filter((row) => row.asset_class === assetClass);
    for (const state of ['healthy', 'weakening', 'decohering', 'exit_ready', 'catastrophe']) {
      const rows = assetRows.filter((row) => row.q_state === state);
      if (!rows.length) continue;
      const metric = summarize(rows);
      stateRows.push({
        asset_class: assetClass,
        q_state: state,
        count: rows.length,
        state_action: rows[0].state_action,
        net_pnl_usd: metric.net_pnl_usd,
        win_rate: metric.win_rate,
        profit_factor: metric.profit_factor,
      });
    }
  }

  const sensorRows: Record<string, unknown>[] = [];
  for (const assetClass of ['gold_etf', 'equity_etf', 'crypto', 'futures'] as const) {
    const feedQuality = coverage.filter((row) => row.asset_class === assetClass);
    const avgFeedQuality = feedQuality.length
      ? feedQuality.reduce((sum, row) => sum + row.avg_recent_feed_quality, 0) / feedQuality.length
      : 0;
    sensorRows.push({
      asset_class: assetClass,
      avg_v16_feed_quality: avgFeedQuality,
      available_sensor_count: SENSOR_CATALOG[assetClass].available.length,
      missing_sensor_count: SENSOR_CATALOG[assetClass].missing.length,
      available_sensors: SENSOR_CATALOG[assetClass].available.join('; '),
      missing_sensors: SENSOR_CATALOG[assetClass].missing.join('; '),
      v110_sensor_status:
        assetClass === 'crypto' || assetClass === 'futures'
          ? 'needs_real_external_sensor_confirm_before_promotion'
          : 'sufficient_for_current_local_baseline',
    });
  }

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_compare_v19.csv'), toCsv(compareRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_split_validation.csv'), toCsv(splitRowsOut));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_selected_trades.csv'), toCsv(selected as unknown as Record<string, unknown>[]));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_rejected_trades.csv'), toCsv(rejected));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_state_machine.csv'), toCsv(stateRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_sensor_coverage.csv'), toCsv(sensorRows));

  const passCount = summaryRows.filter((row) => String(row.status).includes('pass') || String(row.status).includes('candidate')).length;
  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_walk_forward_research_only_not_deployed',
    no_leak_note:
      'V1.10 selection only uses entry-time V1.7/V1.9 fields for crypto/futures filtering. Final Q/B/C fields are audited as state-machine outcomes, not used as entry filters.',
    thesis:
      'V1.10 freezes V1.9 as the local baseline, preserves proven asset bloodlines, then adds entry-time noise/radius/blackspot guards for crypto and futures plus a five-level Q-core state-machine audit.',
    pass_or_candidate_count: passCount,
    summary: summaryRows,
    sensor_coverage: sensorRows,
  };
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_10_summary.json'), JSON.stringify(summary, null, 2));

  const md = `# ${VERSION}

## 定位

V1.10 不推线上，只做本地 walk-forward 研究。它把 V1.9 固化为当前基线，并吸收新方案里真正可验证的部分：

- Q 核前置过滤：只用入场时已有物性字段做 crypto/futures 的新增过滤。
- 五级状态机：healthy / weakening / decohering / exit_ready / catastrophe。
- 传感器覆盖审计：明确哪些是真实或代理数据，哪些仍缺失。
- 保留血统：黄金继续继承 V1.6，股票继续继承 V1.7/V1.8，避免再次覆盖已通过路线。

Tick 级订单簿沙盒不混入本轮，因为当前没有 L2 历史深度数据；它应进入 V2.0/V2.1。

## V1.10 汇总

| 资产 | 交易数 | 胜率 | 净收益 | 最大回撤 | PF | 测试段净收益 | 拒绝数 | 状态 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
${summaryRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${row.trades} | ${pct(Number(row.win_rate))} | $${Number(row.net_pnl_usd).toFixed(0)} | $${Number(row.max_drawdown_usd).toFixed(0)} | ${Number(row.profit_factor).toFixed(2)} | $${Number(row.test_net_pnl_usd).toFixed(0)} | ${row.rejected_count} | ${row.status} |`,
  )
  .join('\n')}

## 与 V1.9 对比

| 资产 | V1.9 净收益 | V1.10 净收益 | 净收益变化 | V1.9 PF | V1.10 PF |
|---|---:|---:|---:|---:|---:|
${compareRows
  .map(
    (row) =>
      `| ${row.asset_class} | $${Number(row.v19_net_pnl_usd).toFixed(0)} | $${Number(row.v110_net_pnl_usd).toFixed(0)} | $${Number(row.delta_pnl_usd).toFixed(0)} | ${Number(row.v19_profit_factor).toFixed(2)} | ${Number(row.v110_profit_factor).toFixed(2)} |`,
  )
  .join('\n')}

## 关键判断

V1.10 的新增过滤对 crypto/futures 使用的是入场时已有的噪声、半径和黑子字段，不使用退出后的 Q_error 反推入场，因此比“事后 Q 背离过滤”更干净。

如果 crypto/futures 在 V1.10 变为正向候选，也只能说明：V1.9 的正收益样本里，低噪声、低半径、低黑子窗口更稳定。它仍需要真实传感器确认，例如稳定币流动性、清算、交易所净流入、完整期限结构和真实盘口深度。

## 传感器缺口

| 资产 | 当前平均真实源质量 | 可用传感器数 | 缺失传感器数 | 状态 |
|---|---:|---:|---:|---|
${sensorRows
  .map(
    (row) =>
      `| ${row.asset_class} | ${Number(row.avg_v16_feed_quality).toFixed(3)} | ${row.available_sensor_count} | ${row.missing_sensor_count} | ${row.v110_sensor_status} |`,
  )
  .join('\n')}

## 下一步

如果继续推进，V1.11 应只做真实传感器补齐，不再继续调同一批入场阈值：

- crypto：稳定币净铸造/销毁、交易所净流入、清算、链上活跃、L2 深度。
- futures：完整期限结构、roll yield、库存、保证金、换月风险。
- gold：真实 ETF flow、COMEX open interest、通胀预期曲线。
- equity：真实上涨家数、新高新低、行业轮动资金流。
`;
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_10_QCoreStateMachine.md'), md);

  console.log(`[${VERSION}] wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
