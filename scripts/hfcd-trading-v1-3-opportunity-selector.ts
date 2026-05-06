import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AssetClass = 'gold_spot_etf' | 'gold_futures' | 'crypto';
type Side = 'long' | 'short';
type Policy = 'strict_qtrend' | 'pullback_with_trend' | 'lgw_mean_revert' | 'overextension_revert';

type SymbolMeta = {
  symbol: string;
  asset_class: AssetClass;
};

type PriceRow = {
  ts: string;
  close: number;
};

type ParamSet = {
  policy: Policy;
  fast: number;
  mid: number;
  long: number;
  hold: number;
  threshold: number;
  z_entry: number;
  vol_max: number;
  stop: number;
  take: number;
  q_min: number;
};

type Trade = {
  symbol: string;
  asset_class: AssetClass;
  policy: Policy;
  entry_ts: string;
  exit_ts: string;
  side: Side;
  entry: number;
  exit: number;
  score: number;
  q_gate: number;
  z: number;
  vol: number;
  exit_reason: string;
  pnl_usd: number;
  net_return: number;
  correct: boolean;
};

const VERSION = 'HFCD_Trading_V1_3_OpportunitySelector';
const ROOT = process.cwd();
const INPUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_2', 'market_data');
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_3');
const NOTIONAL = 10_000;
const FEE = 0.0012;

const SYMBOLS: SymbolMeta[] = [
  { symbol: 'GLD', asset_class: 'gold_spot_etf' },
  { symbol: 'IAU', asset_class: 'gold_spot_etf' },
  { symbol: 'GC=F', asset_class: 'gold_futures' },
  { symbol: 'BTC-USD', asset_class: 'crypto' },
  { symbol: 'ETH-USD', asset_class: 'crypto' },
];

const GRID: ParamSet[] = [];
for (const policy of ['strict_qtrend', 'pullback_with_trend', 'lgw_mean_revert', 'overextension_revert'] as const) {
  for (const fast of [6, 12]) {
    for (const mid of [24, 48]) {
      for (const long of [72, 168]) {
        for (const hold of [6, 12]) {
          for (const threshold of [0.9, 1.2]) {
            for (const z_entry of [1.2, 1.8]) {
              for (const stop of [0.01, 0.018]) {
                for (const take of [0.018, 0.035]) {
                  GRID.push({ policy, fast, mid, long, hold, threshold, z_entry, vol_max: 0.025, stop, take, q_min: 0.68 });
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

function parseCsv(text: string): PriceRow[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(',') || [];
  const tsIndex = headers.indexOf('ts');
  const closeIndex = headers.indexOf('close');
  return lines.map((line) => {
    const parts = line.split(',');
    return { ts: parts[tsIndex], close: Number(parts[closeIndex]) };
  }).filter((row) => row.ts && Number.isFinite(row.close) && row.close > 0);
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

async function loadRows(symbol: string) {
  const file = path.join(INPUT_DIR, `${symbol.replace(/[^A-Z0-9]/gi, '_')}.csv`);
  return parseCsv(await readFile(file, 'utf8'));
}

function feature(rows: PriceRow[], i: number, p: ParamSet) {
  const last = rows[i]?.close;
  const fastBase = rows[i - p.fast]?.close;
  const midBase = rows[i - p.mid]?.close;
  const longBase = rows[i - p.long]?.close;
  if (!last || !fastBase || !midBase || !longBase) return null;
  const window = rows.slice(Math.max(1, i - Math.max(p.long, 96)), i + 1);
  const rets = window.map((row, idx, arr) => (idx === 0 ? 0 : row.close / arr[idx - 1].close - 1)).slice(1);
  const vol = Math.max(std(rets), 0.0008);
  const rFast = last / fastBase - 1;
  const rMid = last / midBase - 1;
  const rLong = last / longBase - 1;
  const ma = mean(rows.slice(Math.max(0, i - p.long), i + 1).map((row) => row.close));
  const z = ma > 0 ? (last / ma - 1) / vol : 0;
  const mom = clamp((0.45 * rFast + 0.34 * rMid + 0.21 * rLong) / vol, -1.8, 1.8);
  const signs = [rFast, rMid, rLong].map((x) => Math.sign(x || 0));
  const same = Math.max(signs.filter((x) => x > 0).length, signs.filter((x) => x < 0).length);
  const q = clamp(0.34 + same * 0.18 + (Math.sign(rMid) === Math.sign(rLong) ? 0.12 : 0), 0, 1);
  return { last, rFast, rMid, rLong, z, mom, vol, q };
}

function actionFor(rows: PriceRow[], i: number, p: ParamSet) {
  const f = feature(rows, i, p);
  if (!f) return null;
  if (f.vol > p.vol_max || f.q < p.q_min) return { side: null, score: Math.abs(f.mom), ...f };
  let side: Side | null = null;
  let score = Math.abs(f.mom);
  if (p.policy === 'strict_qtrend') {
    if (Math.abs(f.mom) >= p.threshold && Math.sign(f.rFast) === Math.sign(f.rMid) && Math.sign(f.rMid) === Math.sign(f.rLong)) {
      side = f.mom > 0 ? 'long' : 'short';
    }
  } else if (p.policy === 'pullback_with_trend') {
    score = Math.abs(f.z) + Math.abs(f.rLong / f.vol) * 0.2;
    if (f.rLong > 0 && f.rMid > 0 && f.z <= -p.z_entry) side = 'long';
    if (f.rLong < 0 && f.rMid < 0 && f.z >= p.z_entry) side = 'short';
  } else if (p.policy === 'lgw_mean_revert') {
    score = Math.abs(f.z);
    if (Math.abs(f.z) >= p.z_entry && Math.abs(f.mom) < 1.4) side = f.z > 0 ? 'short' : 'long';
  } else {
    score = Math.abs(f.z) + Math.abs(f.mom) * 0.2;
    if (Math.abs(f.z) >= p.z_entry && Math.abs(f.mom) >= 0.35) side = f.z > 0 ? 'short' : 'long';
  }
  return { side, score, ...f };
}

function simulate(meta: SymbolMeta, rows: PriceRow[], p: ParamSet, start = -Infinity, end = Infinity) {
  const trades: Trade[] = [];
  const failures: Record<string, number> = {};
  let i = Math.max(p.long + 2, 180);
  while (i < rows.length - p.hold - 1) {
    const time = new Date(rows[i].ts).getTime();
    if (time < start) {
      i += 1;
      continue;
    }
    if (time > end) break;
    const a = actionFor(rows, i, p);
    if (!a || !a.side || a.score < p.threshold) {
      const key = !a ? 'insufficient_history' : a.q < p.q_min ? 'q_underthreshold' : a.vol > p.vol_max ? 'cavity_volatility_unsafe' : 'opportunity_underthreshold';
      failures[key] = (failures[key] || 0) + 1;
      i += 1;
      continue;
    }
    const entry = rows[i].close;
    let exitIndex = i + p.hold;
    let exitReason = 'time_exit';
    for (let j = i + 1; j <= i + p.hold; j += 1) {
      const raw = rows[j].close / entry - 1;
      const dir = a.side === 'long' ? raw : -raw;
      if (dir <= -p.stop) {
        exitIndex = j;
        exitReason = 'stop_loss';
        break;
      }
      if (dir >= p.take) {
        exitIndex = j;
        exitReason = 'take_profit';
        break;
      }
    }
    const exit = rows[exitIndex].close;
    const raw = exit / entry - 1;
    const dir = a.side === 'long' ? raw : -raw;
    const net = dir - FEE;
    trades.push({
      symbol: meta.symbol,
      asset_class: meta.asset_class,
      policy: p.policy,
      entry_ts: rows[i].ts,
      exit_ts: rows[exitIndex].ts,
      side: a.side,
      entry,
      exit,
      score: a.score,
      q_gate: a.q,
      z: a.z,
      vol: a.vol,
      exit_reason: exitReason,
      pnl_usd: net * NOTIONAL,
      net_return: net,
      correct: dir > 0,
    });
    i = exitIndex + 1;
  }
  return { trades, failures };
}

function summarize(trades: Trade[]) {
  const pnl = trades.map((x) => x.pnl_usd);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const value of pnl) {
    eq += value;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
  }
  const wins = pnl.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const losses = Math.abs(pnl.filter((x) => x < 0).reduce((s, x) => s + x, 0));
  return {
    trades: trades.length,
    win_rate: trades.length ? trades.filter((x) => x.pnl_usd > 0).length / trades.length : 0,
    direction_accuracy: trades.length ? trades.filter((x) => x.correct).length / trades.length : 0,
    net_pnl_usd: pnl.reduce((s, x) => s + x, 0),
    avg_pnl_usd: mean(pnl),
    max_drawdown_usd: dd,
    profit_factor: losses > 0 ? wins / losses : wins > 0 ? 99 : 0,
    avg_q_gate: mean(trades.map((x) => x.q_gate)),
  };
}

function objective(s: ReturnType<typeof summarize>) {
  if (s.trades < 8) return -Infinity;
  return s.net_pnl_usd + s.profit_factor * 400 + s.win_rate * 500 - Math.abs(s.max_drawdown_usd) * 0.55;
}

function bounds(groupRows: PriceRow[][]) {
  const times = groupRows.flatMap((rows) => rows.map((row) => new Date(row.ts).getTime())).sort((a, b) => a - b);
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]);
}

function paramJson(p: ParamSet) {
  return JSON.stringify(p);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const data = new Map<string, PriceRow[]>();
  for (const meta of SYMBOLS) {
    data.set(meta.symbol, await loadRows(meta.symbol));
  }

  const walkRows: Record<string, unknown>[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  const failureRows: Record<string, unknown>[] = [];
  const candidateConfig: Record<string, unknown> = {};

  console.log(`[${VERSION}] loaded ${SYMBOLS.length} symbols; grid=${GRID.length}`);

  for (const assetClass of ['gold_spot_etf', 'gold_futures', 'crypto'] as const) {
    const metas = SYMBOLS.filter((x) => x.asset_class === assetClass);
    const b = bounds(metas.map((m) => data.get(m.symbol) || []));
    const wfTrades: Trade[] = [];
    let lastBest = GRID[0];
    for (let fold = 1; fold <= 4; fold += 1) {
      const trainStart = b[0];
      const trainEnd = b[fold];
      const testStart = b[fold];
      const testEnd = b[fold + 1];
      let best = GRID[0];
      let bestScore = -Infinity;
      let bestTrain = summarize([]);
      for (const p of GRID) {
        const trades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], p, trainStart, trainEnd).trades);
        const s = summarize(trades);
        const score = objective(s);
        if (score > bestScore) {
          best = p;
          bestScore = score;
          bestTrain = s;
        }
      }
      lastBest = best;
      const testTrades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], best, testStart, testEnd).trades);
      const test = summarize(testTrades);
      wfTrades.push(...testTrades);
      console.log(`[${assetClass}] fold=${fold} test_trades=${test.trades} pnl=${test.net_pnl_usd.toFixed(0)} pf=${test.profit_factor.toFixed(2)} win=${pct(test.win_rate)} policy=${best.policy}`);
      walkRows.push({
        asset_class: assetClass,
        fold,
        train_start: new Date(trainStart).toISOString(),
        train_end: new Date(trainEnd).toISOString(),
        test_start: new Date(testStart).toISOString(),
        test_end: new Date(testEnd).toISOString(),
        params: paramJson(best),
        train_trades: bestTrain.trades,
        train_win_rate: bestTrain.win_rate,
        train_net_pnl_usd: bestTrain.net_pnl_usd,
        test_trades: test.trades,
        test_win_rate: test.win_rate,
        test_net_pnl_usd: test.net_pnl_usd,
        test_max_drawdown_usd: test.max_drawdown_usd,
        test_profit_factor: test.profit_factor,
      });
    }
    const wf = summarize(wfTrades);
    let fullBest = lastBest;
    let fullBestObj = -Infinity;
    for (const p of GRID) {
      const trades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], p).trades);
      const s = summarize(trades);
      const score = objective(s);
      if (score > fullBestObj) {
        fullBest = p;
        fullBestObj = score;
      }
    }
    const full = summarize(metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], fullBest).trades));
    const selectedFailures: Record<string, number> = {};
    for (const meta of metas) {
      const result = simulate(meta, data.get(meta.symbol) || [], fullBest);
      for (const [reason, count] of Object.entries(result.failures)) {
        selectedFailures[reason] = (selectedFailures[reason] || 0) + count;
      }
    }
    for (const [reason, count] of Object.entries(selectedFailures).sort((a, b) => b[1] - a[1])) {
      failureRows.push({ asset_class: assetClass, reason, count });
    }
    const status = wf.net_pnl_usd > 0 && wf.win_rate >= 0.54 && wf.profit_factor >= 1.12 && wf.trades >= 20
      ? 'profitable_validation_pass'
      : wf.net_pnl_usd > 0
        ? 'watchlist_retest'
        : 'blocked';
    candidateConfig[assetClass] = {
      ...fullBest,
      status,
      walk_forward_trades: wf.trades,
      walk_forward_win_rate: Number(wf.win_rate.toFixed(4)),
      walk_forward_net_pnl_usd: Number(wf.net_pnl_usd.toFixed(2)),
      walk_forward_profit_factor: Number(wf.profit_factor.toFixed(4)),
      full_trades: full.trades,
      full_win_rate: Number(full.win_rate.toFixed(4)),
      full_net_pnl_usd: Number(full.net_pnl_usd.toFixed(2)),
    };
    summaryRows.push({
      asset_class: assetClass,
      status,
      params: paramJson(fullBest),
      walk_forward_trades: wf.trades,
      walk_forward_win_rate: wf.win_rate,
      walk_forward_net_pnl_usd: wf.net_pnl_usd,
      walk_forward_max_drawdown_usd: wf.max_drawdown_usd,
      walk_forward_profit_factor: wf.profit_factor,
      full_trades: full.trades,
      full_win_rate: full.win_rate,
      full_net_pnl_usd: full.net_pnl_usd,
      full_profit_factor: full.profit_factor,
    });
  }

  const summary = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local_training_only_not_deployed',
    summary: summaryRows,
    candidate_config: candidateConfig,
    deployable_count: summaryRows.filter((row: any) => row.status === 'profitable_validation_pass').length,
    watchlist_count: summaryRows.filter((row: any) => row.status === 'watchlist_retest').length,
    blocked_count: summaryRows.filter((row: any) => row.status === 'blocked').length,
  };

  const md = `# ${VERSION}

## 结论

V1.3 改为低覆盖率机会分类器：黄金 ETF、黄金期货、加密分别验证，不混在一起。策略只在 Q 一致、波动腔体安全、价格落入局域窗口且机会分数过门时交易。

| 市场 | 状态 | 交易数 | 胜率 | 净收益 | 最大回撤 | Profit Factor |
|---|---:|---:|---:|---:|---:|---:|
${summaryRows.map((row: any) => `| ${row.asset_class} | ${row.status} | ${row.walk_forward_trades} | ${pct(Number(row.walk_forward_win_rate || 0))} | $${Number(row.walk_forward_net_pnl_usd || 0).toFixed(0)} | $${Number(row.walk_forward_max_drawdown_usd || 0).toFixed(0)} | ${Number(row.walk_forward_profit_factor || 0).toFixed(2)} |`).join('\n')}

## 上线规则

本轮仍是本地训练验证。只有 \`profitable_validation_pass\` 才能进入下一轮 paper engine；其余不推线上。
`;

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_3_walk_forward.csv'), toCsv(walkRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_3_summary.csv'), toCsv(summaryRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_3_failure_modes.csv'), toCsv(failureRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_3_candidate_config.json'), JSON.stringify(candidateConfig, null, 2));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_3_summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_3_OpportunitySelector.md'), md);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
