import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '../lib/locale';

type Props = {
  locale: Locale;
};

type GoldSignal = {
  captured_at?: string;
  symbol: string;
  name?: string;
  price?: number;
  bid_price?: number;
  ask_price?: number;
  spread_bps?: number;
  action?: string;
  score?: number;
  q_core?: number;
  source?: string;
  is_real_market_data?: boolean;
  reject_reason?: string;
};

type GoldTrade = {
  ts?: string;
  event?: string;
  symbol?: string;
  side?: string;
  action?: string;
  entry_price?: number;
  exit_price?: number;
  price?: number;
  quantity?: number;
  trade_value_usd?: number;
  gross_pnl_usd?: number;
  cost_usd?: number;
  net_pnl_usd?: number;
  unrealized_pnl_usd?: number;
  score?: number;
  q_core?: number;
  source?: string;
  reason?: string;
};

type Dashboard = {
  ok: boolean;
  online_backend: boolean;
  version: string;
  updated_at: string;
  data_policy: {
    live_required_for_trade: boolean;
    realtime_source: string;
    realtime_status: string;
    note: string;
    databento_ready?: boolean;
  };
  baseline: {
    lineage: string;
    net_pnl_usd: number;
    profit_factor: number;
    max_drawdown_usd: number;
    trades: number;
    note: string;
  };
  opportunity_roadmap: Array<{ market: string; cadence: string; status: string; next: string }>;
  quote: {
    symbol: string;
    price: number;
    bid_price: number;
    ask_price: number;
    spread_bps: number;
    captured_at: string;
    source: string;
    is_real_market_data: boolean;
  };
  signals: GoldSignal[];
  summary: {
    mode: string;
    initial_cash_usd: number;
    equity_usd: number;
    realized_pnl_usd: number;
    unrealized_pnl_usd: number;
    open_positions: number;
    max_open_positions: number;
    closed_trades: number;
    win_rate: number;
    max_drawdown_usd: number;
    config?: Record<string, unknown>;
  };
  positions: Array<Record<string, unknown>>;
  recent_trades: GoldTrade[];
};

const COPY: Record<string, Record<string, string>> = {
  zh: {
    eyebrow: 'HFCD 黄金交易',
    title: '黄金 AI 模拟交易沙盒',
    subtitle: '线上 Worker 直接拉取黄金实时/准实时行情生成 paper-trading 信号，默认支持买入做多和卖出做空。只做模拟开仓和平仓，不会向真实交易所下单。',
    model: '模型说明',
    modelText: '当前黄金主线继承 V1.38 的 roll-aware 执行锚和 1.10 显化门，并已改为双向信号：趋势共振向上时买入做多，趋势共振向下时卖出做空。V1.40 前向账本继续自动积累；Q-Drift 和追踪止盈仍处于旁路审计，不作为主交易规则。',
    realData: '真实行情状态',
    baseline: '离线验证基线',
    capital: '起始资金',
    fixedTrade: '单次金额',
    maxPositions: '最大持仓',
    stopLoss: '止损比例',
    takeProfit: '止盈比例',
    minScore: '最低分数',
    start: '启动黄金 AI 模拟交易',
    tick: 'AI 运行一轮',
    stop: '停止并清仓结算',
    export: '导出记录',
    status: 'AI 状态',
    equity: 'AI 总资产',
    pnl: 'AI 已实现收益',
    unrealized: 'AI 未实现盈亏',
    winOpen: '胜率 / 持仓',
    latestSignal: '最新黄金信号',
    positions: '当前黄金持仓',
    history: '黄金交易记录',
    roadmap: '下一阶段机会池',
    time: '时间',
    event: '事件',
    symbol: '标的',
    action: '操作',
    price: '价格',
    amount: '交易金额',
    pnlCol: '净收益',
    score: '分数',
    q: 'Q核',
    source: '行情源',
    reason: '原因',
  },
  en: {
    eyebrow: 'HFCD Gold Trading',
    title: 'AI Gold Paper-Trading Sandbox',
    subtitle: 'The online Worker pulls real-time or delayed gold market data for paper trading, with long and short signals enabled by default. It never sends real exchange orders.',
    model: 'Model',
    modelText: 'The gold line inherits the V1.38 roll-aware execution anchor and 1.10 manifestation gate. It now supports bidirectional signals: buy long on upward resonance and sell short on downward resonance. V1.40 forward ledger keeps running; Q-Drift and trailing remain shadow-only.',
    realData: 'Live Data Status',
    baseline: 'Offline Baseline',
    capital: 'Capital',
    fixedTrade: 'Trade amount',
    maxPositions: 'Max positions',
    stopLoss: 'Stop loss %',
    takeProfit: 'Take profit %',
    minScore: 'Min score',
    start: 'Start Gold AI Paper Trading',
    tick: 'Run One AI Tick',
    stop: 'Stop and Liquidate',
    export: 'Export',
    status: 'AI status',
    equity: 'AI equity',
    pnl: 'Realized PnL',
    unrealized: 'Unrealized PnL',
    winOpen: 'Win rate / Open',
    latestSignal: 'Latest Gold Signal',
    positions: 'Open Gold Positions',
    history: 'Gold Trade History',
    roadmap: 'Next Opportunity Pools',
    time: 'Time',
    event: 'Event',
    symbol: 'Symbol',
    action: 'Action',
    price: 'Price',
    amount: 'Amount',
    pnlCol: 'Net PnL',
    score: 'Score',
    q: 'Q core',
    source: 'Source',
    reason: 'Reason',
  },
};

COPY.vi = COPY.en;
COPY.ja = COPY.en;
COPY.fr = COPY.en;
COPY.es = COPY.en;
COPY.de = COPY.en;

const actionText: Record<string, string> = {
  BUY_LONG: '买入做多',
  SELL_SHORT: '卖出做空',
  SELL_TO_CLOSE: '卖出平多',
  BUY_TO_COVER: '买回平空',
  NO_TRADE: '不交易',
};

const eventText: Record<string, string> = {
  OPEN: '开仓',
  CLOSE: '平仓',
  HOLD_EXTEND: '续持',
  SKIP: '跳过',
};

function money(value?: number) {
  const n = Number(value || 0);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function numberText(value?: number, digits = 2) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function pct(value?: number) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function translate(value?: string) {
  if (!value) return '-';
  return actionText[value] || eventText[value] || value;
}

export default function GoldTradingPage({ locale }: Props) {
  const copy = COPY[locale] || COPY.zh;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState({
    capital_usd: 100_000,
    fixed_trade_usd: 5_000,
    max_open_positions: 4,
    stop_loss_pct: 0.012,
    take_profit_pct: 0.024,
    min_signal_score: 1.1,
    max_holding_minutes: 1440,
  });

  const userId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_gold_user_id') : '';
    if (stored) return stored;
    const id = `gold_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_gold_user_id', id);
    return id;
  }, []);

  const loadDashboard = useCallback(async () => {
    const res = await fetch(`/api/gold-trading/dashboard?user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' });
    const data = await res.json() as Dashboard;
    setDashboard(data);
  }, [userId]);

  const postAction = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: userId, ...body }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'request failed');
      setMessage('操作已完成。');
      await loadDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败。');
    } finally {
      setLoading(false);
    }
  }, [loadDashboard, userId]);

  useEffect(() => {
    loadDashboard().catch(() => setMessage('读取黄金交易引擎失败。'));
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (dashboard?.summary?.mode === 'running') {
        await postAction('/api/gold-trading/tick');
      } else {
        await loadDashboard().catch(() => undefined);
      }
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [dashboard?.summary?.mode, loadDashboard, postAction]);

  const summary = dashboard?.summary;
  const quote = dashboard?.quote;
  const signal = dashboard?.signals?.[0];

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_left,rgba(245,197,74,0.16),transparent_34%),linear-gradient(180deg,#111827,#07130f)] px-6 py-8 text-slate-100">
      <section className="mx-auto max-w-7xl space-y-7">
        <div className="rounded-[2rem] border border-amber-200/20 bg-black/25 p-7 shadow-2xl shadow-black/30">
          <div className="text-xs font-black uppercase tracking-[0.42em] text-amber-200/70">{copy.eyebrow}</div>
          <h1 className="mt-3 text-4xl font-black tracking-tight md:text-5xl">{copy.title}</h1>
          <p className="mt-4 max-w-4xl text-base font-semibold leading-8 text-slate-300">{copy.subtitle}</p>
        </div>

        <div className="rounded-[1.5rem] border border-emerald-200/10 bg-emerald-950/20 p-6">
          <h2 className="text-2xl font-black">{copy.model}</h2>
          <p className="mt-3 text-sm font-semibold leading-7 text-slate-300">{copy.modelText}</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
            <div className="text-sm font-black text-slate-400">{copy.realData}</div>
            <div className={`mt-3 rounded-2xl border px-4 py-3 text-sm font-black ${quote?.is_real_market_data ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100' : 'border-red-300/30 bg-red-400/10 text-red-100'}`}>
              {dashboard?.data_policy?.realtime_status || '-'} · {quote?.symbol || '-'} · {quote?.source || '-'}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <Metric label="Last" value={money(quote?.price)} />
              <Metric label="Bid" value={money(quote?.bid_price)} />
              <Metric label="Ask" value={money(quote?.ask_price)} />
              <Metric label="Spread" value={`${numberText(quote?.spread_bps, 1)} bps`} />
            </div>
          </div>
          <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
            <div className="text-sm font-black text-slate-400">{copy.baseline}</div>
            <p className="mt-3 text-sm font-semibold text-slate-300">{dashboard?.baseline?.lineage || '-'}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              <Metric label="Net" value={money(dashboard?.baseline?.net_pnl_usd)} />
              <Metric label="PF" value={numberText(dashboard?.baseline?.profit_factor, 3)} />
              <Metric label="DD" value={money(dashboard?.baseline?.max_drawdown_usd)} />
              <Metric label="Trades" value={String(dashboard?.baseline?.trades || 0)} />
            </div>
          </div>
        </div>

        <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
          <div className="grid gap-4 md:grid-cols-6">
            <Input label={copy.capital} value={config.capital_usd} onChange={(value) => setConfig({ ...config, capital_usd: value })} />
            <Input label={copy.fixedTrade} value={config.fixed_trade_usd} onChange={(value) => setConfig({ ...config, fixed_trade_usd: value })} />
            <Input label={copy.maxPositions} value={config.max_open_positions} onChange={(value) => setConfig({ ...config, max_open_positions: value })} />
            <Input label={copy.stopLoss} value={config.stop_loss_pct} step="0.001" onChange={(value) => setConfig({ ...config, stop_loss_pct: value })} />
            <Input label={copy.takeProfit} value={config.take_profit_pct} step="0.001" onChange={(value) => setConfig({ ...config, take_profit_pct: value })} />
            <Input label={copy.minScore} value={config.min_signal_score} step="0.01" onChange={(value) => setConfig({ ...config, min_signal_score: value })} />
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button disabled={loading || summary?.mode === 'running'} onClick={() => postAction('/api/gold-trading/start', config)} className="rounded-2xl bg-amber-300 px-5 py-3 text-sm font-black text-amber-950 disabled:opacity-45">{copy.start}</button>
            <button disabled={loading} onClick={() => postAction('/api/gold-trading/tick')} className="rounded-2xl border border-amber-200/20 bg-amber-300/10 px-5 py-3 text-sm font-black text-amber-100">{copy.tick}</button>
            <button disabled={loading} onClick={() => postAction('/api/gold-trading/stop', { liquidate: true })} className="rounded-2xl border border-red-300/30 bg-red-400/18 px-5 py-3 text-sm font-black text-red-100">{copy.stop}</button>
            <button disabled={!dashboard} onClick={() => {
              const blob = new Blob([JSON.stringify(dashboard, null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `hfcd-gold-trading-${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(a.href);
            }} className="rounded-2xl border border-white/12 bg-white/[0.06] px-5 py-3 text-sm font-black text-slate-100">{copy.export}</button>
          </div>
          {message ? <div className="mt-4 rounded-2xl border border-emerald-300/25 bg-emerald-300/10 px-4 py-3 text-sm font-bold text-emerald-100">{message}</div> : null}
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label={copy.status} value={summary?.mode || 'loading'} />
          <MetricCard label={copy.equity} value={money(summary?.equity_usd)} />
          <MetricCard label={copy.pnl} value={money(summary?.realized_pnl_usd)} positive={Number(summary?.realized_pnl_usd || 0) >= 0} />
          <MetricCard label={copy.winOpen} value={`${pct(summary?.win_rate)} / ${summary?.open_positions || 0}/${summary?.max_open_positions || 0}`} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-[1.5rem] border border-white/10 bg-black/20 p-5">
            <h2 className="text-2xl font-black">{copy.latestSignal}</h2>
            <div className="mt-4 rounded-2xl bg-white/[0.05] p-4">
              <div className="text-lg font-black">{translate(signal?.action)} · {signal?.symbol || '-'}</div>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                <Metric label={copy.price} value={money(signal?.price)} />
                <Metric label={copy.score} value={numberText(signal?.score, 3)} />
                <Metric label={copy.q} value={numberText(signal?.q_core, 3)} />
                <Metric label={copy.source} value={signal?.source || '-'} />
              </div>
              <p className="mt-3 text-sm font-semibold text-slate-400">{signal?.reject_reason || '达标时 AI 会按真实行情 paper 开仓。'}</p>
            </div>
          </section>
          <section className="rounded-[1.5rem] border border-white/10 bg-black/20 p-5">
            <h2 className="text-2xl font-black">{copy.roadmap}</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {(dashboard?.opportunity_roadmap || []).map((row) => (
                <div key={row.market} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="font-black text-amber-100">{row.market} · {row.cadence}</div>
                  <div className="mt-2 text-sm font-semibold text-slate-400">{row.status}</div>
                  <div className="mt-1 text-sm font-semibold text-slate-300">{row.next}</div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <Table title={copy.positions} rows={dashboard?.positions || []} copy={copy} />
        <TradeTable title={copy.history} rows={dashboard?.recent_trades || []} copy={copy} />
      </section>
    </div>
  );
}

function Input({ label, value, step = '1', onChange }: { label: string; value: number; step?: string; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black text-slate-400">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm font-black text-white outline-none focus:border-amber-200/50"
      />
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-black text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm font-black text-slate-100">{value}</div>
    </div>
  );
}

function MetricCard({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-black/20 p-5">
      <div className="text-sm font-black text-slate-400">{label}</div>
      <div className={`mt-4 text-3xl font-black ${positive === undefined ? 'text-white' : positive ? 'text-emerald-200' : 'text-red-200'}`}>{value}</div>
    </div>
  );
}

function Table({ title, rows, copy }: { title: string; rows: Array<Record<string, unknown>>; copy: Record<string, string> }) {
  return (
    <section className="rounded-[1.5rem] border border-white/10 bg-black/20 p-5">
      <h2 className="text-2xl font-black">{title}</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="px-3 py-3">{copy.time}</th>
              <th className="px-3 py-3">{copy.symbol}</th>
              <th className="px-3 py-3">{copy.action}</th>
              <th className="px-3 py-3">{copy.price}</th>
              <th className="px-3 py-3">{copy.amount}</th>
              <th className="px-3 py-3">{copy.pnlCol}</th>
              <th className="px-3 py-3">{copy.source}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row, index) => (
              <tr key={String(row.position_id || index)} className="border-t border-white/10">
                <td className="px-3 py-3">{String(row.opened_at || '-')}</td>
                <td className="px-3 py-3 font-bold">{String(row.symbol || '-')}</td>
                <td className="px-3 py-3">{translate(String(row.action || ''))}</td>
                <td className="px-3 py-3">{money(Number(row.last_price || row.entry_price || 0))}</td>
                <td className="px-3 py-3">{money(Number(row.notional_usd || 0))}</td>
                <td className="px-3 py-3">{money(Number(row.unrealized_pnl_usd || 0))}</td>
                <td className="px-3 py-3">{String(row.source || '-')}</td>
              </tr>
            )) : (
              <tr><td className="px-3 py-5 text-slate-500" colSpan={7}>-</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TradeTable({ title, rows, copy }: { title: string; rows: GoldTrade[]; copy: Record<string, string> }) {
  return (
    <section className="rounded-[1.5rem] border border-white/10 bg-black/20 p-5">
      <h2 className="text-2xl font-black">{title}</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="px-3 py-3">{copy.time}</th>
              <th className="px-3 py-3">{copy.event}</th>
              <th className="px-3 py-3">{copy.symbol}</th>
              <th className="px-3 py-3">{copy.action}</th>
              <th className="px-3 py-3">{copy.price}</th>
              <th className="px-3 py-3">{copy.amount}</th>
              <th className="px-3 py-3">{copy.pnlCol}</th>
              <th className="px-3 py-3">{copy.score}</th>
              <th className="px-3 py-3">{copy.reason}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row, index) => (
              <tr key={`${row.ts}-${index}`} className="border-t border-white/10">
                <td className="px-3 py-3">{row.ts || '-'}</td>
                <td className="px-3 py-3">{translate(row.event)}</td>
                <td className="px-3 py-3 font-bold">{row.symbol || '-'}</td>
                <td className="px-3 py-3">{translate(row.action)}</td>
                <td className="px-3 py-3">{money(row.exit_price || row.entry_price || row.price)}</td>
                <td className="px-3 py-3">{money(row.trade_value_usd)}</td>
                <td className={`px-3 py-3 font-black ${Number(row.net_pnl_usd || 0) < 0 ? 'text-red-200' : 'text-emerald-200'}`}>{money(row.net_pnl_usd)}</td>
                <td className="px-3 py-3">{numberText(row.score, 3)}</td>
                <td className="px-3 py-3">{row.reason || '-'}</td>
              </tr>
            )) : (
              <tr><td className="px-3 py-5 text-slate-500" colSpan={9}>-</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
