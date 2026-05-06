import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Group = 'gold_etf' | 'gold_futures' | 'crypto';
type Side = 1 | -1;

type Meta = {
  symbol: string;
  group: Group;
};

type PriceRow = {
  ts: string;
  close: number;
};

type Model = {
  mean: number[];
  scale: number[];
  coeff: number[];
  intercept: number;
};

type Config = {
  hold: number;
  quantile: number;
  qMin: number;
  volQuantile: number;
  stop: number;
  take: number;
};

type Trade = {
  group: Group;
  symbol: string;
  side: 'long' | 'short';
  entry_ts: string;
  exit_ts: string;
  score: number;
  q_gate: number;
  vol: number;
  radius: number;
  pnl_usd: number;
  correct: boolean;
  exit_reason: string;
};

const VERSION = 'HFCD_Trading_V1_4_StabilityDistilledSelector';
const ROOT = process.cwd();
const INPUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_2', 'market_data');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_4');
const NOTIONAL = 10_000;
const FEE = 0.0012;

const SYMBOLS: Meta[] = [
  { symbol: 'GLD', group: 'gold_etf' },
  { symbol: 'IAU', group: 'gold_etf' },
  { symbol: 'GC=F', group: 'gold_futures' },
  { symbol: 'BTC-USD', group: 'crypto' },
  { symbol: 'ETH-USD', group: 'crypto' },
];

const CONFIGS: Config[] = [];
for (const hold of [6, 12, 24]) {
  for (const quantile of [0.97, 0.985, 0.995]) {
    for (const qMin of [0.42, 0.55, 0.68]) {
      for (const volQuantile of [0.85, 0.95]) {
        for (const [stop, take] of [[0.008, 0.014], [0.012, 0.024], [0.018, 0.04]] as const) {
          CONFIGS.push({ hold, quantile, qMin, volQuantile, stop, take });
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

function parseCsv(text: string): PriceRow[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(',') || [];
  const tsIndex = headers.indexOf('ts');
  const closeIndex = headers.indexOf('close');
  return lines
    .map((line) => {
      const parts = line.split(',');
      return { ts: parts[tsIndex], close: Number(parts[closeIndex]) };
    })
    .filter((row) => row.ts && Number.isFinite(row.close) && row.close > 0);
}

function safeName(symbol: string) {
  return symbol.replace(/[^A-Z0-9]/gi, '_');
}

async function loadRows(symbol: string) {
  return parseCsv(await readFile(path.join(INPUT_DIR, `${safeName(symbol)}.csv`), 'utf8'));
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

function pct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function ret(rows: PriceRow[], i: number, lag: number) {
  const base = rows[i - lag]?.close;
  return base ? rows[i].close / base - 1 : 0;
}

function baseStats(rows: PriceRow[], i: number) {
  const rets = rows.slice(Math.max(1, i - 96), i + 1).map((row, idx, arr) => (idx === 0 ? 0 : row.close / arr[idx - 1].close - 1)).slice(1);
  const vol = Math.max(std(rets), 0.0008);
  const r1 = ret(rows, i, 1);
  const r3 = ret(rows, i, 3);
  const r6 = ret(rows, i, 6);
  const r12 = ret(rows, i, 12);
  const r24 = ret(rows, i, 24);
  const r48 = ret(rows, i, 48);
  const r168 = ret(rows, i, 168);
  const ma72 = mean(rows.slice(Math.max(0, i - 72), i + 1).map((row) => row.close));
  const ma168 = mean(rows.slice(Math.max(0, i - 168), i + 1).map((row) => row.close));
  const z72 = ma72 ? (rows[i].close / ma72 - 1) / vol : 0;
  const z168 = ma168 ? (rows[i].close / ma168 - 1) / vol : 0;
  const radius = Math.abs(r1) / vol;
  const date = new Date(rows[i].ts);
  const hour = date.getUTCHours();
  const day = date.getUTCDay();
  return { vol, radius, r1, r3, r6, r12, r24, r48, r168, z72, z168, hour, day };
}

function features(rows: PriceRow[], i: number, side: Side) {
  const s = baseStats(rows, i);
  const trendAligned = [s.r6, s.r24, s.r168].filter((x) => side * x > 0).length;
  const qGate = clamp(0.28 + trendAligned * 0.18 + (side * s.r24 > 0 && side * s.r168 > 0 ? 0.18 : 0), 0, 1);
  const twoPi = Math.PI * 2;
  return {
    qGate,
    vol: s.vol,
    radius: s.radius,
    x: [
      side * s.r1 / s.vol,
      side * s.r3 / s.vol,
      side * s.r6 / s.vol,
      side * s.r12 / s.vol,
      side * s.r24 / s.vol,
      side * s.r48 / s.vol,
      side * s.r168 / s.vol,
      -side * s.z72,
      -side * s.z168,
      s.vol * 100,
      qGate,
      s.radius,
      Math.sin((hourToUnit(s.hour)) * twoPi),
      Math.cos((hourToUnit(s.hour)) * twoPi),
      Math.sin((s.day / 7) * twoPi),
      Math.cos((s.day / 7) * twoPi),
    ],
  };
}

function hourToUnit(hour: number) {
  return hour / 24;
}

function timeBounds(groupRows: PriceRow[][]) {
  const times = groupRows.flatMap((rows) => rows.map((row) => new Date(row.ts).getTime())).sort((a, b) => a - b);
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]);
}

function buildExamples(rows: PriceRow[], hold: number, start: number, end: number) {
  const examples: { x: number[]; y: number }[] = [];
  for (let i = 200; i < rows.length - hold - 1; i += 1) {
    const t = new Date(rows[i].ts).getTime();
    if (t < start || t > end) continue;
    const future = rows[i + hold].close / rows[i].close - 1;
    for (const side of [1, -1] as const) {
      const f = features(rows, i, side);
      examples.push({ x: f.x, y: side * future - FEE });
    }
  }
  return examples;
}

function trainModel(examples: { x: number[]; y: number }[]): Model {
  const n = examples[0]?.x.length || 0;
  const meanX = Array.from({ length: n }, (_, j) => mean(examples.map((e) => e.x[j])));
  const scale = Array.from({ length: n }, (_, j) => Math.max(std(examples.map((e) => e.x[j])), 1e-6));
  const yMean = mean(examples.map((e) => e.y));
  const coeff = Array.from({ length: n }, (_, j) => {
    const cov = mean(examples.map((e) => ((e.x[j] - meanX[j]) / scale[j]) * (e.y - yMean)));
    return clamp(cov * 7.5, -0.55, 0.55);
  });
  return { mean: meanX, scale, coeff, intercept: yMean };
}

function score(model: Model, x: number[]) {
  return model.intercept + x.reduce((sum, value, j) => sum + ((value - model.mean[j]) / model.scale[j]) * model.coeff[j], 0);
}

function candidateScores(rows: PriceRow[], model: Model, cfg: Config, start: number, end: number, volCap: number) {
  const out: number[] = [];
  for (let i = 200; i < rows.length - cfg.hold - 1; i += 1) {
    const t = new Date(rows[i].ts).getTime();
    if (t < start || t > end) continue;
    for (const side of [1, -1] as const) {
      const f = features(rows, i, side);
      if (f.qGate >= cfg.qMin && f.vol <= volCap && f.radius <= 4.2) out.push(score(model, f.x));
    }
  }
  return out;
}

function simulate(meta: Meta, rows: PriceRow[], model: Model, cfg: Config, threshold: number, start: number, end: number, volCap: number) {
  const trades: Trade[] = [];
  const failures: Record<string, number> = {};
  let i = 200;
  while (i < rows.length - cfg.hold - 1) {
    const t = new Date(rows[i].ts).getTime();
    if (t < start) {
      i += 1;
      continue;
    }
    if (t > end) break;
    const longF = features(rows, i, 1);
    const shortF = features(rows, i, -1);
    const longScore = score(model, longF.x);
    const shortScore = score(model, shortF.x);
    const side: Side = longScore >= shortScore ? 1 : -1;
    const chosen = side === 1 ? longF : shortF;
    const chosenScore = Math.max(longScore, shortScore);
    if (chosen.qGate < cfg.qMin) failures.q_underthreshold = (failures.q_underthreshold || 0) + 1;
    else if (chosen.vol > volCap) failures.cavity_volatility_unsafe = (failures.cavity_volatility_unsafe || 0) + 1;
    else if (chosen.radius > 4.2) failures.radius_out_of_distribution = (failures.radius_out_of_distribution || 0) + 1;
    else if (chosenScore < threshold) failures.energy_score_underthreshold = (failures.energy_score_underthreshold || 0) + 1;
    else {
      const entry = rows[i].close;
      let exitIndex = i + cfg.hold;
      let exitReason = 'time_exit';
      for (let j = i + 1; j <= i + cfg.hold; j += 1) {
        const raw = rows[j].close / entry - 1;
        const directional = side * raw;
        if (directional <= -cfg.stop) {
          exitIndex = j;
          exitReason = 'stop_loss';
          break;
        }
        if (directional >= cfg.take) {
          exitIndex = j;
          exitReason = 'take_profit';
          break;
        }
      }
      const raw = rows[exitIndex].close / entry - 1;
      const directional = side * raw;
      const net = directional - FEE;
      trades.push({
        group: meta.group,
        symbol: meta.symbol,
        side: side === 1 ? 'long' : 'short',
        entry_ts: rows[i].ts,
        exit_ts: rows[exitIndex].ts,
        score: chosenScore,
        q_gate: chosen.qGate,
        vol: chosen.vol,
        radius: chosen.radius,
        pnl_usd: net * NOTIONAL,
        correct: directional > 0,
        exit_reason: exitReason,
      });
      i = exitIndex + 1;
      continue;
    }
    i += 1;
  }
  return { trades, failures };
}

function summarize(trades: Trade[]) {
  const pnl = trades.map((trade) => trade.pnl_usd);
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    dd = Math.min(dd, equity - peak);
  }
  const grossWin = pnl.filter((x) => x > 0).reduce((sum, x) => sum + x, 0);
  const grossLoss = Math.abs(pnl.filter((x) => x < 0).reduce((sum, x) => sum + x, 0));
  return {
    trades: trades.length,
    win_rate: trades.length ? trades.filter((trade) => trade.pnl_usd > 0).length / trades.length : 0,
    direction_accuracy: trades.length ? trades.filter((trade) => trade.correct).length / trades.length : 0,
    net_pnl_usd: pnl.reduce((sum, x) => sum + x, 0),
    max_drawdown_usd: dd,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    avg_q_gate: mean(trades.map((trade) => trade.q_gate)),
  };
}

function objective(s: ReturnType<typeof summarize>) {
  if (s.trades < 6) return -Infinity;
  return s.net_pnl_usd + s.profit_factor * 600 + s.win_rate * 400 - Math.abs(s.max_drawdown_usd) * 0.45;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const data = new Map<string, PriceRow[]>();
  for (const meta of SYMBOLS) data.set(meta.symbol, await loadRows(meta.symbol));

  const walkRows: Record<string, unknown>[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  const failureRows: Record<string, unknown>[] = [];
  const configs: Record<string, unknown> = {};

  console.log(`[${VERSION}] configs=${CONFIGS.length}`);

  for (const group of ['gold_etf', 'gold_futures', 'crypto'] as const) {
    const metas = SYMBOLS.filter((meta) => meta.group === group);
    const b = timeBounds(metas.map((meta) => data.get(meta.symbol) || []));
    const wfTrades: Trade[] = [];
    let lastCfg = CONFIGS[0];
    let lastThreshold = 0;
    let lastVolCap = 0.02;
    for (let fold = 1; fold <= 4; fold += 1) {
      let best: { cfg: Config; threshold: number; volCap: number; train: ReturnType<typeof summarize>; score: number; model: Model } | null = null;
      for (const cfg of CONFIGS) {
        const trainExamples = metas.flatMap((meta) => buildExamples(data.get(meta.symbol) || [], cfg.hold, b[0], b[fold]));
        if (trainExamples.length < 200) continue;
        const model = trainModel(trainExamples);
        const trainVols = metas.flatMap((meta) => (data.get(meta.symbol) || []).map((_, i, rows) => (i > 200 ? baseStats(rows, i).vol : 0)).filter(Boolean));
        const volCap = quantile(trainVols, cfg.volQuantile);
        const scores = metas.flatMap((meta) => candidateScores(data.get(meta.symbol) || [], model, cfg, b[0], b[fold], volCap));
        const threshold = quantile(scores, cfg.quantile);
        const trainTrades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], model, cfg, threshold, b[0], b[fold], volCap).trades);
        const train = summarize(trainTrades);
        const obj = objective(train);
        if (!best || obj > best.score) best = { cfg, threshold, volCap, train, score: obj, model };
      }
      if (!best) continue;
      lastCfg = best.cfg;
      lastThreshold = best.threshold;
      lastVolCap = best.volCap;
      const testTrades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], best.model, best.cfg, best.threshold, b[fold], b[fold + 1], best.volCap).trades);
      const test = summarize(testTrades);
      wfTrades.push(...testTrades);
      console.log(`[${group}] fold=${fold} test_trades=${test.trades} pnl=${test.net_pnl_usd.toFixed(0)} pf=${test.profit_factor.toFixed(2)} win=${pct(test.win_rate)} hold=${best.cfg.hold} q=${best.cfg.quantile}`);
      walkRows.push({
        group,
        fold,
        config: JSON.stringify(best.cfg),
        threshold: best.threshold,
        vol_cap: best.volCap,
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
    const failures: Record<string, number> = {};
    for (const meta of metas) {
      const examples = buildExamples(data.get(meta.symbol) || [], lastCfg.hold, b[0], b[4]);
      const model = trainModel(examples);
      const result = simulate(meta, data.get(meta.symbol) || [], model, lastCfg, lastThreshold, b[0], b[4], lastVolCap);
      for (const [reason, count] of Object.entries(result.failures)) failures[reason] = (failures[reason] || 0) + count;
    }
    for (const [reason, count] of Object.entries(failures).sort((a, b) => b[1] - a[1])) failureRows.push({ group, reason, count });
    const status = wf.net_pnl_usd > 0 && wf.win_rate >= 0.54 && wf.profit_factor >= 1.12 && wf.trades >= 20
      ? 'profitable_validation_pass'
      : wf.net_pnl_usd > 0 && wf.profit_factor >= 1.02
        ? 'watchlist_retest'
        : 'blocked';
    configs[group] = {
      ...lastCfg,
      threshold: Number(lastThreshold.toFixed(6)),
      vol_cap: Number(lastVolCap.toFixed(6)),
      status,
      walk_forward_trades: wf.trades,
      walk_forward_win_rate: Number(wf.win_rate.toFixed(4)),
      walk_forward_net_pnl_usd: Number(wf.net_pnl_usd.toFixed(2)),
      walk_forward_profit_factor: Number(wf.profit_factor.toFixed(4)),
    };
    summaryRows.push({
      group,
      status,
      walk_forward_trades: wf.trades,
      walk_forward_win_rate: wf.win_rate,
      walk_forward_direction_accuracy: wf.direction_accuracy,
      walk_forward_net_pnl_usd: wf.net_pnl_usd,
      walk_forward_max_drawdown_usd: wf.max_drawdown_usd,
      walk_forward_profit_factor: wf.profit_factor,
      avg_q_gate: wf.avg_q_gate,
    });
  }

  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_training_only_not_deployed',
    design: 'HFCD feature distillation: Q-center, energy score, cavity volatility, radius localization, manifest low-coverage selection.',
    summary: summaryRows,
    candidate_config: configs,
    deployable_count: summaryRows.filter((row: any) => row.status === 'profitable_validation_pass').length,
    watchlist_count: summaryRows.filter((row: any) => row.status === 'watchlist_retest').length,
    blocked_count: summaryRows.filter((row: any) => row.status === 'blocked').length,
  };

  const md = `# ${VERSION}

## 设计

V1.4 不再直接套规则交易，而是把 HFCD 经验变成可训练特征：

- Q-center：多周期方向一致性。
- Energy ledger：模型评分必须覆盖费用和机会阈值。
- Cavity support：只在波动腔体安全时交易。
- Radius localization：排除异常跳变样本。
- Manifest gate：只取训练期最强低覆盖率窗口。

## 结果

| 市场 | 状态 | 交易数 | 胜率 | 方向命中 | 净收益 | 最大回撤 | Profit Factor |
|---|---:|---:|---:|---:|---:|---:|---:|
${summaryRows.map((row: any) => `| ${row.group} | ${row.status} | ${row.walk_forward_trades} | ${pct(Number(row.walk_forward_win_rate || 0))} | ${pct(Number(row.walk_forward_direction_accuracy || 0))} | $${Number(row.walk_forward_net_pnl_usd || 0).toFixed(0)} | $${Number(row.walk_forward_max_drawdown_usd || 0).toFixed(0)} | ${Number(row.walk_forward_profit_factor || 0).toFixed(2)} |`).join('\n')}

## 上线纪律

这是本地训练验证，不推线上。只有 \`profitable_validation_pass\` 且通过下一轮 paper replay 的市场，才允许写回线上策略配置。
`;

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_4_walk_forward.csv'), toCsv(walkRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_4_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_4_failure_modes.csv'), toCsv(failureRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_4_candidate_config.json'), JSON.stringify(configs, null, 2));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_4_summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_4_StabilityDistilledSelector.md'), md);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
