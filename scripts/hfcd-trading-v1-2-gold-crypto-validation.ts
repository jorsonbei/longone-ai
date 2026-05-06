import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AssetClass = 'crypto' | 'gold_proxy';

type SymbolMeta = {
  symbol: string;
  name: string;
  asset_class: AssetClass;
  session: string;
};

type PriceRow = {
  ts: string;
  close: number;
};

type ParamSet = {
  fast_bars: number;
  mid_bars: number;
  long_bars: number;
  holding_bars: number;
  min_signal_score: number;
  q_min: number;
  energy_min: number;
  radius_z_max: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  mode: 'momentum' | 'regime_blend' | 'mean_revert_guard';
};

type SignalPack = {
  action: 'long' | 'short' | 'none';
  score: number;
  q_gate: number;
  energy_gate: number;
  cavity_gate: number;
  radius_gate: number;
  manifest_gate: number;
  failure_mode: string;
};

type TradeRow = {
  asset_class: AssetClass;
  symbol: string;
  mode: string;
  entry_ts: string;
  exit_ts: string;
  side: 'long' | 'short';
  entry: number;
  exit: number;
  score: number;
  q_gate: number;
  energy_gate: number;
  cavity_gate: number;
  radius_gate: number;
  manifest_gate: number;
  exit_reason: string;
  net_return: number;
  pnl_usd: number;
  correct_direction: boolean;
  brier: number;
};

const VERSION = 'HFCD_Trading_V1_2_GoldProxyDeepValidation_CryptoRegimeRepair';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_2');
const MARKET_DATA_DIR = path.join(OUT_DIR, 'market_data');
const NOTIONAL_USD = 10_000;
const ROUNDTRIP_FEE_RATE = 0.0012;

const SYMBOLS: SymbolMeta[] = [
  { symbol: 'GLD', name: 'Gold ETF', asset_class: 'gold_proxy', session: 'us_regular' },
  { symbol: 'IAU', name: 'iShares Gold Trust', asset_class: 'gold_proxy', session: 'us_regular' },
  { symbol: 'GC=F', name: 'COMEX Gold Futures', asset_class: 'gold_proxy', session: 'nearly_24h' },
  { symbol: 'BTC-USD', name: 'Bitcoin', asset_class: 'crypto', session: '24h' },
  { symbol: 'ETH-USD', name: 'Ethereum', asset_class: 'crypto', session: '24h' },
];

const GRID: ParamSet[] = [];
for (const fast_bars of [6, 12]) {
  for (const mid_bars of [24, 48]) {
    for (const long_bars of [72, 168]) {
      for (const holding_bars of [6, 12, 24]) {
        for (const min_signal_score of [0.75, 0.9, 1.05]) {
          for (const q_min of [0.58, 0.68, 0.76]) {
            for (const stop_loss_pct of [0.012, 0.018, 0.025]) {
              for (const take_profit_pct of [0.024, 0.04, 0.06]) {
                for (const mode of ['momentum', 'regime_blend', 'mean_revert_guard'] as const) {
                  GRID.push({
                    fast_bars,
                    mid_bars,
                    long_bars,
                    holding_bars,
                    min_signal_score,
                    q_min,
                    energy_min: 0.55,
                    radius_z_max: 3.0,
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function pct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

async function fetchYahoo(symbol: string): Promise<PriceRow[]> {
  const attempts = [
    'range=730d&interval=1h',
    'range=1y&interval=1h',
    'range=6mo&interval=1h',
  ];
  let lastError = '';
  for (const query of attempts) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'HFCD-ThingNature-OS/1.0',
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload: any = await response.json();
      const result = payload?.chart?.result?.[0];
      const timestamps: number[] = result?.timestamp || [];
      const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close || [];
      const rows = timestamps
        .map((ts, index) => ({ ts: new Date(ts * 1000).toISOString(), close: closes[index] === null ? NaN : Number(closes[index]) }))
        .filter((row) => Number.isFinite(row.close) && row.close > 0);
      if (rows.length >= 500) return rows;
      lastError = `only ${rows.length} rows for ${query}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Yahoo download failed for ${symbol}: ${lastError}`);
}

function returnsUntil(rows: PriceRow[], index: number, lookback: number) {
  return rows
    .slice(Math.max(1, index - lookback), index + 1)
    .map((row, rowIndex, arr) => (rowIndex === 0 ? 0 : row.close / arr[rowIndex - 1].close - 1))
    .slice(1);
}

function scoreAt(rows: PriceRow[], index: number, params: ParamSet): SignalPack {
  const last = rows[index]?.close;
  const fastBase = rows[index - params.fast_bars]?.close;
  const midBase = rows[index - params.mid_bars]?.close;
  const longBase = rows[index - params.long_bars]?.close;
  if (!last || !fastBase || !midBase || !longBase) {
    return { action: 'none', score: 0, q_gate: 0, energy_gate: 0, cavity_gate: 0, radius_gate: 0, manifest_gate: 0, failure_mode: 'insufficient_history' };
  }

  const lookbackReturns = returnsUntil(rows, index, Math.max(params.long_bars, 96));
  const vol = Math.max(std(lookbackReturns), 0.0008);
  const lastReturn = rows[index - 1]?.close ? last / rows[index - 1].close - 1 : 0;
  const rFast = last / fastBase - 1;
  const rMid = last / midBase - 1;
  const rLong = last / longBase - 1;
  const ma = mean(rows.slice(Math.max(0, index - params.long_bars), index + 1).map((row) => row.close));
  const priceZ = ma > 0 ? (last / ma - 1) / vol : 0;

  const momentum = (0.44 * rFast + 0.34 * rMid + 0.22 * rLong) / vol;
  const meanRevert = -clamp(priceZ / 2.5, -1.4, 1.4);
  const lowVolCavity = clamp(1 - Math.max(0, vol - 0.012) / 0.02, 0, 1);
  const trendAgreement = [rFast, rMid, rLong].map((value) => Math.sign(value || 0));
  const positive = trendAgreement.filter((value) => value > 0).length;
  const negative = trendAgreement.filter((value) => value < 0).length;
  const qGate = clamp(0.35 + Math.max(positive, negative) * 0.18 + (Math.sign(rMid) === Math.sign(rLong) ? 0.11 : 0), 0, 1);
  const radiusZ = Math.abs(lastReturn) / vol;
  const radiusGate = clamp(1 - Math.max(0, radiusZ - params.radius_z_max) / 2.5, 0, 1);
  const cavityGate = lowVolCavity;
  const blended = params.mode === 'momentum'
    ? momentum
    : params.mode === 'mean_revert_guard'
      ? (qGate > 0.7 && Math.abs(momentum) > 0.4 ? momentum : meanRevert)
      : (0.72 * momentum + 0.28 * meanRevert * cavityGate);
  const rawScore = clamp(blended, -1.4, 1.4);
  const absScore = Math.abs(rawScore);
  const energyGate = clamp(absScore / 1.4, 0, 1);
  const manifestGate = Math.min(qGate, energyGate, cavityGate, radiusGate);

  if (qGate < params.q_min) {
    return { action: 'none', score: absScore, q_gate: qGate, energy_gate: energyGate, cavity_gate: cavityGate, radius_gate: radiusGate, manifest_gate: manifestGate, failure_mode: 'q_coherence_underthreshold' };
  }
  if (energyGate < params.energy_min || absScore < params.min_signal_score) {
    return { action: 'none', score: absScore, q_gate: qGate, energy_gate: energyGate, cavity_gate: cavityGate, radius_gate: radiusGate, manifest_gate: manifestGate, failure_mode: 'energy_edge_underthreshold' };
  }
  if (cavityGate < 0.35) {
    return { action: 'none', score: absScore, q_gate: qGate, energy_gate: energyGate, cavity_gate: cavityGate, radius_gate: radiusGate, manifest_gate: manifestGate, failure_mode: 'cavity_volatility_unsafe' };
  }
  if (radiusGate < 0.35) {
    return { action: 'none', score: absScore, q_gate: qGate, energy_gate: energyGate, cavity_gate: cavityGate, radius_gate: radiusGate, manifest_gate: manifestGate, failure_mode: 'radius_out_of_distribution' };
  }

  return {
    action: rawScore > 0 ? 'long' : 'short',
    score: absScore,
    q_gate: qGate,
    energy_gate: energyGate,
    cavity_gate: cavityGate,
    radius_gate: radiusGate,
    manifest_gate: manifestGate,
    failure_mode: '',
  };
}

function simulate(meta: SymbolMeta, rows: PriceRow[], params: ParamSet, startMs = -Infinity, endMs = Infinity) {
  const trades: TradeRow[] = [];
  const blocked: Record<string, number> = {};
  let index = Math.max(params.long_bars + 2, 180);
  while (index < rows.length - params.holding_bars - 1) {
    const entryMs = new Date(rows[index].ts).getTime();
    if (entryMs < startMs) {
      index += 1;
      continue;
    }
    if (entryMs > endMs) break;
    const signal = scoreAt(rows, index, params);
    if (signal.action === 'none') {
      blocked[signal.failure_mode] = (blocked[signal.failure_mode] || 0) + 1;
      index += 1;
      continue;
    }

    const entry = rows[index].close;
    let exitIndex = index + params.holding_bars;
    let exitReason = 'time_exit';
    for (let future = index + 1; future <= index + params.holding_bars; future += 1) {
      const rawReturn = rows[future].close / entry - 1;
      const directionalReturn = signal.action === 'long' ? rawReturn : -rawReturn;
      if (directionalReturn <= -params.stop_loss_pct) {
        exitIndex = future;
        exitReason = 'stop_loss';
        break;
      }
      if (directionalReturn >= params.take_profit_pct) {
        exitIndex = future;
        exitReason = 'take_profit';
        break;
      }
    }

    const exit = rows[exitIndex].close;
    const rawReturn = exit / entry - 1;
    const directionalReturn = signal.action === 'long' ? rawReturn : -rawReturn;
    const netReturn = directionalReturn - ROUNDTRIP_FEE_RATE;
    const predictedP = clamp(0.5 + (Math.min(signal.score, 1.4) / 1.4) * 0.35, 0.01, 0.99);
    const correct = directionalReturn > 0;
    trades.push({
      asset_class: meta.asset_class,
      symbol: meta.symbol,
      mode: params.mode,
      entry_ts: rows[index].ts,
      exit_ts: rows[exitIndex].ts,
      side: signal.action,
      entry,
      exit,
      score: signal.score,
      q_gate: signal.q_gate,
      energy_gate: signal.energy_gate,
      cavity_gate: signal.cavity_gate,
      radius_gate: signal.radius_gate,
      manifest_gate: signal.manifest_gate,
      exit_reason: exitReason,
      net_return: netReturn,
      pnl_usd: NOTIONAL_USD * netReturn,
      correct_direction: correct,
      brier: (predictedP - (correct ? 1 : 0)) ** 2,
    });
    index = exitIndex + 1;
  }
  return { trades, blocked };
}

function summarizeTrades(trades: TradeRow[]) {
  const pnl = trades.map((trade) => trade.pnl_usd);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const grossWin = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(pnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const exits = trades.reduce<Record<string, number>>((acc, trade) => {
    acc[trade.exit_reason] = (acc[trade.exit_reason] || 0) + 1;
    return acc;
  }, {});
  return {
    trades: trades.length,
    win_rate: trades.length ? trades.filter((trade) => trade.pnl_usd > 0).length / trades.length : 0,
    direction_accuracy: trades.length ? trades.filter((trade) => trade.correct_direction).length / trades.length : 0,
    net_pnl_usd: pnl.reduce((sum, value) => sum + value, 0),
    avg_pnl_usd: mean(pnl),
    max_drawdown_usd: maxDrawdown,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    brier_score: mean(trades.map((trade) => trade.brier)),
    avg_q_gate: mean(trades.map((trade) => trade.q_gate)),
    avg_manifest_gate: mean(trades.map((trade) => trade.manifest_gate)),
    stop_loss_rate: trades.length ? (exits.stop_loss || 0) / trades.length : 0,
    take_profit_rate: trades.length ? (exits.take_profit || 0) / trades.length : 0,
    time_exit_rate: trades.length ? (exits.time_exit || 0) / trades.length : 0,
  };
}

function scoreSummary(summary: ReturnType<typeof summarizeTrades>) {
  if (summary.trades < 25) return -Infinity;
  return summary.net_pnl_usd
    + summary.profit_factor * 350
    + summary.win_rate * 350
    + summary.avg_manifest_gate * 150
    - Math.abs(summary.max_drawdown_usd) * 0.42
    - summary.brier_score * 120;
}

function timeBounds(groupRows: PriceRow[][]) {
  const times = groupRows.flatMap((rows) => rows.map((row) => new Date(row.ts).getTime())).sort((a, b) => a - b);
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]);
}

function mergeBlocked(target: Record<string, number>, source: Record<string, number>) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] || 0) + value;
  }
}

function compactParam(params: ParamSet) {
  return {
    fast_bars: params.fast_bars,
    mid_bars: params.mid_bars,
    long_bars: params.long_bars,
    holding_bars: params.holding_bars,
    min_signal_score: params.min_signal_score,
    q_min: params.q_min,
    stop_loss_pct: params.stop_loss_pct,
    take_profit_pct: params.take_profit_pct,
    mode: params.mode,
  };
}

async function main() {
  await mkdir(MARKET_DATA_DIR, { recursive: true });
  const data = new Map<string, PriceRow[]>();
  for (const meta of SYMBOLS) {
    console.log(`[download] ${meta.symbol}`);
    const rows = await fetchYahoo(meta.symbol);
    data.set(meta.symbol, rows);
    await writeFile(path.join(MARKET_DATA_DIR, `${meta.symbol.replace(/[^A-Z0-9]/gi, '_')}.csv`), toCsv(rows.map((row) => ({ symbol: meta.symbol, ...row }))));
  }

  const walkRows: Record<string, unknown>[] = [];
  const symbolRows: Record<string, unknown>[] = [];
  const failureRows: Record<string, unknown>[] = [];
  const candidateConfig: Record<string, unknown> = {};
  const validationSummary: Record<string, unknown>[] = [];

  for (const assetClass of ['gold_proxy', 'crypto'] as const) {
    const metas = SYMBOLS.filter((meta) => meta.asset_class === assetClass);
    const bounds = timeBounds(metas.map((meta) => data.get(meta.symbol) || []));
    const wfTrades: TradeRow[] = [];
    const wfBlocked: Record<string, number> = {};
    let lastBest = GRID[0];

    for (let fold = 1; fold <= 4; fold += 1) {
      const trainStart = bounds[0];
      const trainEnd = bounds[fold];
      const testStart = bounds[fold];
      const testEnd = bounds[fold + 1];
      let best = GRID[0];
      let bestScore = -Infinity;
      let bestTrainSummary = summarizeTrades([]);
      for (const params of GRID) {
        const trades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], params, trainStart, trainEnd).trades);
        const summary = summarizeTrades(trades);
        const candidateScore = scoreSummary(summary);
        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          best = params;
          bestTrainSummary = summary;
        }
      }
      lastBest = best;
      const testResults = metas.map((meta) => simulate(meta, data.get(meta.symbol) || [], best, testStart, testEnd));
      const testTrades = testResults.flatMap((result) => result.trades);
      const blocked = {};
      testResults.forEach((result) => mergeBlocked(blocked, result.blocked));
      mergeBlocked(wfBlocked, blocked);
      wfTrades.push(...testTrades);
      const testSummary = summarizeTrades(testTrades);
      walkRows.push({
        asset_class: assetClass,
        fold,
        train_start: new Date(trainStart).toISOString(),
        train_end: new Date(trainEnd).toISOString(),
        test_start: new Date(testStart).toISOString(),
        test_end: new Date(testEnd).toISOString(),
        ...compactParam(best),
        train_trades: bestTrainSummary.trades,
        train_win_rate: bestTrainSummary.win_rate,
        train_net_pnl_usd: bestTrainSummary.net_pnl_usd,
        test_trades: testSummary.trades,
        test_win_rate: testSummary.win_rate,
        test_direction_accuracy: testSummary.direction_accuracy,
        test_net_pnl_usd: testSummary.net_pnl_usd,
        test_max_drawdown_usd: testSummary.max_drawdown_usd,
        test_profit_factor: testSummary.profit_factor,
        test_brier_score: testSummary.brier_score,
        test_avg_manifest_gate: testSummary.avg_manifest_gate,
      });
    }

    const wfSummary = summarizeTrades(wfTrades);
    let fullBest = lastBest;
    let fullBestScore = -Infinity;
    for (const params of GRID) {
      const trades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], params).trades);
      const summary = summarizeTrades(trades);
      const candidateScore = scoreSummary(summary);
      if (candidateScore > fullBestScore) {
        fullBestScore = candidateScore;
        fullBest = params;
      }
    }
    const fullTrades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], fullBest).trades);
    const fullSummary = summarizeTrades(fullTrades);
    const status = wfSummary.net_pnl_usd > 0 && wfSummary.win_rate >= 0.53 && wfSummary.profit_factor >= 1.08 && wfSummary.trades >= 40
      ? 'profitable_validation_pass'
      : wfSummary.net_pnl_usd > 0 && wfSummary.profit_factor >= 1.0
        ? 'watchlist_retest'
        : 'blocked';

    candidateConfig[assetClass] = {
      ...compactParam(fullBest),
      status,
      walk_forward_trades: wfSummary.trades,
      walk_forward_win_rate: Number(wfSummary.win_rate.toFixed(4)),
      walk_forward_net_pnl_usd: Number(wfSummary.net_pnl_usd.toFixed(2)),
      walk_forward_profit_factor: Number(wfSummary.profit_factor.toFixed(4)),
      walk_forward_max_drawdown_usd: Number(wfSummary.max_drawdown_usd.toFixed(2)),
      full_trades: fullSummary.trades,
      full_win_rate: Number(fullSummary.win_rate.toFixed(4)),
      full_net_pnl_usd: Number(fullSummary.net_pnl_usd.toFixed(2)),
    };
    validationSummary.push({
      asset_class: assetClass,
      status,
      ...compactParam(fullBest),
      walk_forward_trades: wfSummary.trades,
      walk_forward_win_rate: wfSummary.win_rate,
      walk_forward_net_pnl_usd: wfSummary.net_pnl_usd,
      walk_forward_max_drawdown_usd: wfSummary.max_drawdown_usd,
      walk_forward_profit_factor: wfSummary.profit_factor,
      walk_forward_brier_score: wfSummary.brier_score,
      avg_q_gate: wfSummary.avg_q_gate,
      avg_manifest_gate: wfSummary.avg_manifest_gate,
      full_trades: fullSummary.trades,
      full_win_rate: fullSummary.win_rate,
      full_net_pnl_usd: fullSummary.net_pnl_usd,
      full_profit_factor: fullSummary.profit_factor,
    });
    for (const [failure_mode, count] of Object.entries(wfBlocked)) {
      failureRows.push({ asset_class: assetClass, failure_mode, count });
    }
    for (const meta of metas) {
      const symbolSummary = summarizeTrades(simulate(meta, data.get(meta.symbol) || [], fullBest).trades);
      symbolRows.push({
        symbol: meta.symbol,
        asset_class: assetClass,
        ...compactParam(fullBest),
        trades: symbolSummary.trades,
        win_rate: symbolSummary.win_rate,
        direction_accuracy: symbolSummary.direction_accuracy,
        net_pnl_usd: symbolSummary.net_pnl_usd,
        max_drawdown_usd: symbolSummary.max_drawdown_usd,
        profit_factor: symbolSummary.profit_factor,
        brier_score: symbolSummary.brier_score,
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const summary = {
    version: VERSION,
    generated_at: generatedAt,
    mode: 'local_training_only_not_deployed',
    symbols: SYMBOLS.map((row) => row.symbol),
    rows_by_symbol: Object.fromEntries(SYMBOLS.map((meta) => [meta.symbol, data.get(meta.symbol)?.length || 0])),
    validation_summary: validationSummary,
    candidate_config: candidateConfig,
    deployable_count: validationSummary.filter((row: any) => row.status === 'profitable_validation_pass').length,
    watchlist_count: validationSummary.filter((row: any) => row.status === 'watchlist_retest').length,
    blocked_count: validationSummary.filter((row: any) => row.status === 'blocked').length,
  };

  const md = `# ${VERSION}

## 本地验证结论

本轮只做本地训练/验证，不推送线上，不回写 Worker 执行配置。V1.2 把 HFCD 经验迁移到金融策略验证里：Q 一致性、能量边际、腔体波动支撑、半径局域性和 manifest gate 同时过门才允许交易。

## 数据

${SYMBOLS.map((meta) => `- ${meta.symbol}: ${data.get(meta.symbol)?.length || 0} rows`).join('\n')}

## Walk-forward 结果

| 市场 | 状态 | 交易数 | 胜率 | 净收益 | 最大回撤 | Profit Factor | Brier | 模式 | 止损 | 止盈 |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
${validationSummary.map((row: any) => `| ${row.asset_class} | ${row.status} | ${row.walk_forward_trades} | ${pct(Number(row.walk_forward_win_rate || 0))} | $${Number(row.walk_forward_net_pnl_usd || 0).toFixed(0)} | $${Number(row.walk_forward_max_drawdown_usd || 0).toFixed(0)} | ${Number(row.walk_forward_profit_factor || 0).toFixed(2)} | ${Number(row.walk_forward_brier_score || 0).toFixed(3)} | ${row.mode} | ${pct(Number(row.stop_loss_pct || 0))} | ${pct(Number(row.take_profit_pct || 0))} |`).join('\n')}

## HFCD 迁移点

- Q-center: 用 fast/mid/long 方向一致性约束，避免单一时间窗噪声开仓。
- Energy ledger: 只有标准化 edge 足够大才交易，扣除 roundtrip fee 后审计。
- Cavity support: 过高波动视为腔体不安全，不强行追单。
- Radius localization: 当前跳变偏离历史分布过大时拒绝，降低样本外交易。
- Manifest gate: 以上门同时闭合才产生交易。

## 上线边界

- \`profitable_validation_pass\` 才允许进入下一轮 paper engine 候选。
- \`watchlist_retest\` 只允许继续本地复核。
- \`blocked\` 不进入线上、不自动交易。
`;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_2_walk_forward.csv'), toCsv(walkRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_2_symbol_results.csv'), toCsv(symbolRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_2_failure_modes.csv'), toCsv(failureRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_2_candidate_config.json'), JSON.stringify(candidateConfig, null, 2));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_2_summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_2_GoldCryptoValidation.md'), md);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
