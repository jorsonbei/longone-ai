import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type SymbolMeta = {
  symbol: string;
  name: string;
  asset_class: 'crypto' | 'equity_etf' | 'gold_proxy';
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
  stop_loss_pct: number;
  take_profit_pct: number;
};

type TradeRow = {
  symbol: string;
  asset_class: string;
  entry_ts: string;
  exit_ts: string;
  side: 'long' | 'short';
  score: number;
  entry: number;
  exit: number;
  net_return: number;
  pnl_usd: number;
  correct_direction: boolean;
  brier: number;
};

const VERSION = 'HFCD_Trading_V1_1_MultiMarket_Backtest';
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'outputs', 'hfcd_trading_v1_1');
const MARKET_DATA_DIR = path.join(OUT_DIR, 'market_data');
const CONFIG_PATH = path.join(ROOT, 'src', 'lib', 'generated', 'multiMarketTradingConfig.ts');
const NOTIONAL_USD = 10_000;
const ROUNDTRIP_FEE_RATE = 0.0012;

const SYMBOLS: SymbolMeta[] = [
  { symbol: 'BTC-USD', name: 'Bitcoin', asset_class: 'crypto', session: '24h' },
  { symbol: 'ETH-USD', name: 'Ethereum', asset_class: 'crypto', session: '24h' },
  { symbol: 'SPY', name: 'S&P 500 ETF', asset_class: 'equity_etf', session: 'us_regular' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', asset_class: 'equity_etf', session: 'us_regular' },
  { symbol: 'GLD', name: 'Gold ETF', asset_class: 'gold_proxy', session: 'us_regular' },
];

const GRID: ParamSet[] = [];
for (const fast_bars of [3, 6]) {
  for (const mid_bars of [12, 24]) {
    for (const long_bars of [48, 72]) {
      for (const holding_bars of [3, 6, 12]) {
        for (const min_signal_score of [0.6, 0.75, 0.9]) {
          for (const stop_loss_pct of [0.012, 0.018, 0.025]) {
            for (const take_profit_pct of [0.024, 0.036, 0.05]) {
              GRID.push({ fast_bars, mid_bars, long_bars, holding_bars, min_signal_score, stop_loss_pct, take_profit_pct });
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

function signalAt(rows: PriceRow[], index: number, params: ParamSet) {
  const last = rows[index]?.close;
  const fastBase = rows[index - params.fast_bars]?.close;
  const midBase = rows[index - params.mid_bars]?.close;
  const longBase = rows[index - params.long_bars]?.close;
  if (!last || !fastBase || !midBase || !longBase) return null;
  const returns = rows
    .slice(Math.max(1, index - Math.max(params.long_bars, 36)), index + 1)
    .map((row, rowIndex, arr) => (rowIndex === 0 ? 0 : row.close / arr[rowIndex - 1].close - 1))
    .slice(1);
  const vol = Math.max(std(returns), 0.0008);
  const rFast = last / fastBase - 1;
  const rMid = last / midBase - 1;
  const rLong = last / longBase - 1;
  const rawScore = (0.42 * rFast + 0.36 * rMid + 0.22 * rLong) / vol;
  return clamp(rawScore, -1.4, 1.4);
}

function simulate(meta: SymbolMeta, rows: PriceRow[], params: ParamSet, startMs = -Infinity, endMs = Infinity): TradeRow[] {
  const trades: TradeRow[] = [];
  let index = Math.max(params.long_bars + 1, 80);
  while (index < rows.length - params.holding_bars - 1) {
    const entryTime = new Date(rows[index].ts).getTime();
    if (entryTime < startMs) {
      index += 1;
      continue;
    }
    if (entryTime > endMs) break;
    const score = signalAt(rows, index, params);
    if (score === null || Math.abs(score) < params.min_signal_score) {
      index += 1;
      continue;
    }
    const side = score > 0 ? 'long' : 'short';
    const entry = rows[index].close;
    let exitIndex = index + params.holding_bars;
    let exit = rows[exitIndex].close;
    for (let future = index + 1; future <= index + params.holding_bars; future += 1) {
      const rawReturn = rows[future].close / entry - 1;
      const directionalReturn = side === 'long' ? rawReturn : -rawReturn;
      if (directionalReturn <= -params.stop_loss_pct || directionalReturn >= params.take_profit_pct) {
        exitIndex = future;
        exit = rows[future].close;
        break;
      }
    }
    const rawReturn = exit / entry - 1;
    const directionalReturn = side === 'long' ? rawReturn : -rawReturn;
    const netReturn = directionalReturn - ROUNDTRIP_FEE_RATE;
    const predictedP = clamp(0.5 + (Math.min(Math.abs(score), 1.4) / 1.4) * 0.35, 0.01, 0.99);
    const correct = directionalReturn > 0;
    trades.push({
      symbol: meta.symbol,
      asset_class: meta.asset_class,
      entry_ts: rows[index].ts,
      exit_ts: rows[exitIndex].ts,
      side,
      score,
      entry,
      exit,
      net_return: netReturn,
      pnl_usd: NOTIONAL_USD * netReturn,
      correct_direction: correct,
      brier: (predictedP - (correct ? 1 : 0)) ** 2,
    });
    index = exitIndex + 1;
  }
  return trades;
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
  return {
    trades: trades.length,
    win_rate: trades.length ? trades.filter((trade) => trade.pnl_usd > 0).length / trades.length : 0,
    direction_accuracy: trades.length ? trades.filter((trade) => trade.correct_direction).length / trades.length : 0,
    net_pnl_usd: pnl.reduce((sum, value) => sum + value, 0),
    avg_pnl_usd: mean(pnl),
    max_drawdown_usd: maxDrawdown,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    brier_score: mean(trades.map((trade) => trade.brier)),
  };
}

function scoreSummary(summary: ReturnType<typeof summarizeTrades>) {
  if (summary.trades < 20) return -Infinity;
  return summary.net_pnl_usd + summary.profit_factor * 250 + summary.win_rate * 250 - Math.abs(summary.max_drawdown_usd) * 0.35 - summary.brier_score * 100;
}

function timeBounds(groupRows: PriceRow[][]) {
  const times = groupRows.flatMap((rows) => rows.map((row) => new Date(row.ts).getTime())).sort((a, b) => a - b);
  const boundaries = [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]);
  return boundaries;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

async function main() {
  await mkdir(MARKET_DATA_DIR, { recursive: true });
  const data = new Map<string, PriceRow[]>();
  for (const meta of SYMBOLS) {
    console.log(`[download] ${meta.symbol}`);
    const rows = await fetchYahoo(meta.symbol);
    data.set(meta.symbol, rows);
    await writeFile(
      path.join(MARKET_DATA_DIR, `${meta.symbol.replace(/[^A-Z0-9]/gi, '_')}.csv`),
      toCsv(rows.map((row) => ({ symbol: meta.symbol, ...row }))),
    );
  }

  const marketResults: Record<string, unknown>[] = [];
  const walkForwardRows: Record<string, unknown>[] = [];
  const validationSummary: Record<string, unknown>[] = [];
  const marketHeads: Record<string, any> = {};
  const symbolHeads: Record<string, any> = {};

  const classes = [...new Set(SYMBOLS.map((row) => row.asset_class))];
  for (const assetClass of classes) {
    const metas = SYMBOLS.filter((row) => row.asset_class === assetClass);
    const boundaries = timeBounds(metas.map((meta) => data.get(meta.symbol) || []));
    let selectedParam: ParamSet | null = null;
    let testTradesAll: TradeRow[] = [];

    for (let fold = 1; fold <= 4; fold += 1) {
      const trainStart = boundaries[0];
      const trainEnd = boundaries[fold];
      const testStart = boundaries[fold];
      const testEnd = boundaries[fold + 1];
      let bestParam = GRID[0];
      let bestScore = -Infinity;
      let bestTrain = summarizeTrades([]);
      for (const params of GRID) {
        const trainTrades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], params, trainStart, trainEnd));
        const trainSummary = summarizeTrades(trainTrades);
        const candidateScore = scoreSummary(trainSummary);
        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          bestParam = params;
          bestTrain = trainSummary;
        }
      }
      const testTrades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], bestParam, testStart, testEnd));
      const testSummary = summarizeTrades(testTrades);
      testTradesAll = testTradesAll.concat(testTrades);
      selectedParam = bestParam;
      walkForwardRows.push({
        asset_class: assetClass,
        fold,
        train_start: new Date(trainStart).toISOString(),
        train_end: new Date(trainEnd).toISOString(),
        test_start: new Date(testStart).toISOString(),
        test_end: new Date(testEnd).toISOString(),
        ...bestParam,
        train_trades: bestTrain.trades,
        train_win_rate: bestTrain.win_rate,
        train_net_pnl_usd: bestTrain.net_pnl_usd,
        test_trades: testSummary.trades,
        test_win_rate: testSummary.win_rate,
        test_direction_accuracy: testSummary.direction_accuracy,
        test_net_pnl_usd: testSummary.net_pnl_usd,
        test_max_drawdown_usd: testSummary.max_drawdown_usd,
        test_profit_factor: testSummary.profit_factor,
        test_brier_score: testSummary.brier_score,
      });
    }

    const wfSummary = summarizeTrades(testTradesAll);
    let finalParam = selectedParam || GRID[0];
    let bestFullScore = -Infinity;
    for (const params of GRID) {
      const trades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], params));
      const summary = summarizeTrades(trades);
      const candidateScore = scoreSummary(summary);
      if (candidateScore > bestFullScore) {
        bestFullScore = candidateScore;
        finalParam = params;
      }
    }
    const fullTrades = metas.flatMap((meta) => simulate(meta, data.get(meta.symbol) || [], finalParam));
    const fullSummary = summarizeTrades(fullTrades);
    const status = wfSummary.net_pnl_usd > 0 && wfSummary.win_rate >= 0.52 && wfSummary.profit_factor >= 1.05 && wfSummary.trades >= 20
      ? 'deployable'
      : wfSummary.net_pnl_usd > 0 && wfSummary.trades >= 10
        ? 'watchlist'
        : 'blocked';
    const head = {
      ...finalParam,
      status,
      walk_forward_trades: wfSummary.trades,
      walk_forward_win_rate: Number(wfSummary.win_rate.toFixed(4)),
      walk_forward_net_pnl_usd: Number(wfSummary.net_pnl_usd.toFixed(2)),
      walk_forward_profit_factor: Number(wfSummary.profit_factor.toFixed(4)),
      full_trades: fullSummary.trades,
      full_win_rate: Number(fullSummary.win_rate.toFixed(4)),
      full_net_pnl_usd: Number(fullSummary.net_pnl_usd.toFixed(2)),
    };
    marketHeads[assetClass] = head;
    validationSummary.push({ asset_class: assetClass, ...head });

    for (const meta of metas) {
      const symbolSummary = summarizeTrades(simulate(meta, data.get(meta.symbol) || [], finalParam));
      symbolHeads[meta.symbol] = {
        ...head,
        symbol_status: symbolSummary.net_pnl_usd > 0 && symbolSummary.win_rate >= 0.5 ? status : status === 'deployable' ? 'watchlist' : status,
        symbol_trades: symbolSummary.trades,
        symbol_win_rate: Number(symbolSummary.win_rate.toFixed(4)),
        symbol_net_pnl_usd: Number(symbolSummary.net_pnl_usd.toFixed(2)),
      };
      marketResults.push({
        symbol: meta.symbol,
        asset_class: assetClass,
        ...finalParam,
        status: symbolHeads[meta.symbol].symbol_status,
        trades: symbolSummary.trades,
        win_rate: symbolSummary.win_rate,
        direction_accuracy: symbolSummary.direction_accuracy,
        net_pnl_usd: symbolSummary.net_pnl_usd,
        avg_pnl_usd: symbolSummary.avg_pnl_usd,
        max_drawdown_usd: symbolSummary.max_drawdown_usd,
        profit_factor: symbolSummary.profit_factor,
        brier_score: symbolSummary.brier_score,
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const globalMinSignalScore = Math.min(
    ...Object.values(marketHeads)
      .filter((head: any) => head.status !== 'blocked')
      .map((head: any) => Number(head.min_signal_score)),
    0.72,
  );
  const config = `// Auto-generated by scripts/hfcd-trading-v1-1-multimarket-backtest.ts.
// Do not edit by hand; rerun npm run trading:v1.1:backtest.
export const MULTI_MARKET_TRADING_CONFIG = ${JSON.stringify({
    version: VERSION,
    generated_at: generatedAt,
    bar_interval: '1h',
    global_min_signal_score: Number(globalMinSignalScore.toFixed(4)),
    roundtrip_fee_rate: ROUNDTRIP_FEE_RATE,
    symbols: SYMBOLS,
    market_heads: marketHeads,
    symbol_heads: symbolHeads,
    validation_summary: validationSummary,
  }, null, 2)} as const;
`;

  const summary = {
    version: VERSION,
    generated_at: generatedAt,
    symbols: SYMBOLS.map((row) => row.symbol),
    rows_by_symbol: Object.fromEntries(SYMBOLS.map((meta) => [meta.symbol, data.get(meta.symbol)?.length || 0])),
    validation_summary: validationSummary,
    deployable_heads: validationSummary.filter((row: any) => row.status === 'deployable').length,
    watchlist_heads: validationSummary.filter((row: any) => row.status === 'watchlist').length,
    blocked_heads: validationSummary.filter((row: any) => row.status === 'blocked').length,
  };

  const md = `# ${VERSION}

## 结论

本轮使用 Yahoo Finance 公共历史行情下载 BTC/ETH/GLD/SPY/QQQ 的 1h K 线，按 crypto / gold_proxy / equity_etf 三类 head 做 walk-forward 验证。结果会回写到 Worker 使用的多市场交易配置中；未通过的 head 标记为 blocked，运行时不应作为自动交易主线。

## 数据规模

${SYMBOLS.map((meta) => `- ${meta.symbol}: ${data.get(meta.symbol)?.length || 0} rows`).join('\n')}

## Head 验证

| 市场 | 状态 | Walk-forward 交易数 | 胜率 | 净收益 | Profit Factor | 止损 | 止盈 | 持仓 bars |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${validationSummary.map((row: any) => `| ${row.asset_class} | ${row.status} | ${row.walk_forward_trades} | ${formatPct(Number(row.walk_forward_win_rate || 0))} | $${Number(row.walk_forward_net_pnl_usd || 0).toFixed(0)} | ${Number(row.walk_forward_profit_factor || 0).toFixed(2)} | ${formatPct(Number(row.stop_loss_pct || 0))} | ${formatPct(Number(row.take_profit_pct || 0))} | ${row.holding_bars} |`).join('\n')}

## 使用边界

- 这是历史 paper/backtest，不是真实收益承诺。
- 运行时只使用公开行情快照；真实自动交易仍需要券商/交易所下单 API、风控审批、真实成交回报和合规记录。
- 通过线写入 \`src/lib/generated/multiMarketTradingConfig.ts\`，Worker 会读取每个市场的阈值、止损、止盈和持仓周期。
`;

  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_1_multimarket_backtest_results.csv'), toCsv(marketResults));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_1_walk_forward.csv'), toCsv(walkForwardRows));
  await writeFile(path.join(OUT_DIR, 'hfcd_trading_v1_1_multimarket_backtest_summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'HFCD_Trading_V1_1_MultiMarket_Backtest.md'), md);
  await writeFile(CONFIG_PATH, config);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
