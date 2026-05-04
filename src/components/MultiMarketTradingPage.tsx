import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '../lib/locale';

type Props = {
  locale: Locale;
};

type MarketSignal = {
  captured_at?: string;
  symbol: string;
  name?: string;
  asset_class?: string;
  price?: number;
  action?: string;
  score?: number;
  confidence?: number;
  r1?: number;
  r6?: number;
  r24?: number;
  source?: string;
  reject_reason?: string;
};

type MarketTrade = {
  ts?: string;
  event?: string;
  symbol?: string;
  asset_class?: string;
  side?: string;
  action?: string;
  price?: number;
  entry_price?: number;
  exit_price?: number;
  quantity?: number;
  trade_value_usd?: number;
  gross_pnl_usd?: number;
  cost_usd?: number;
  net_pnl_usd?: number;
  score?: number;
  confidence?: number;
  source?: string;
  reason?: string;
};

type Dashboard = {
  ok: boolean;
  online_backend: boolean;
  db_status: string;
  version: string;
  updated_at: string;
  market_health: {
    ok: boolean;
    status: string;
    latest_captured_at?: string;
    symbols?: string[];
    note?: string;
  };
  signals: MarketSignal[];
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
  recent_trades: MarketTrade[];
};

const COPY: Record<string, Record<string, string>> = {
  zh: {
    eyebrow: 'HFCD 多市场交易',
    title: '股票 / 加密货币 / 黄金 AI 模拟交易',
    subtitle: 'V1 先接 BTC、ETH、SPY、QQQ、GLD 的公开真实行情快照，做 paper trading；系统只记录模拟开仓、平仓、盈亏和信号来源，不会真实下单。',
    model: '模型说明',
    modelText: '该模块复用 HFCD 的稳定门思想：只在趋势强度、波动归一化分数和信号置信度达标时开仓；BTC/ETH 适合 24 小时验证，SPY/QQQ/GLD 是股票和黄金代理。期货和真实下单需要后续接券商/交易所 API。',
    capital: '起始资金',
    fixedTrade: '单次金额',
    maxPositions: '最大持仓',
    stopLoss: '止损比例',
    takeProfit: '止盈比例',
    start: '启动 AI 模拟交易',
    tick: 'AI 运行一轮',
    stop: '停止并清仓结算',
    export: '导出记录',
    status: 'AI 状态',
    equity: '总资产',
    pnl: '已实现收益',
    unrealized: '未实现盈亏',
    winOpen: '胜率 / 持仓',
    data: '行情状态',
    signals: '最新多市场信号',
    positions: '当前持仓',
    history: '交易记录',
    time: '时间',
    event: '事件',
    symbol: '标的',
    action: '操作',
    side: '方向',
    price: '价格',
    amount: '交易金额',
    qty: '数量',
    pnlCol: '净收益',
    score: '稳定分',
    source: '行情源',
    reason: '原因',
  },
  en: {
    eyebrow: 'HFCD Multi-Market Trading',
    title: 'AI Paper Trading for Crypto, Stocks, and Gold',
    subtitle: 'V1 uses public snapshots for BTC, ETH, SPY, QQQ, and GLD. It is paper trading only and never sends real orders.',
    model: 'Model',
    modelText: 'The engine applies HFCD-style stability gates: it opens only when normalized trend strength and confidence pass the threshold. BTC/ETH provide 24h validation; SPY/QQQ/GLD are equity and gold proxies.',
    capital: 'Capital',
    fixedTrade: 'Trade amount',
    maxPositions: 'Max positions',
    stopLoss: 'Stop loss %',
    takeProfit: 'Take profit %',
    start: 'Start AI Paper Trading',
    tick: 'Run One AI Tick',
    stop: 'Stop and Liquidate',
    export: 'Export',
    status: 'AI status',
    equity: 'Equity',
    pnl: 'Realized PnL',
    unrealized: 'Unrealized PnL',
    winOpen: 'Win rate / Open',
    data: 'Market status',
    signals: 'Latest Signals',
    positions: 'Open Positions',
    history: 'Trade History',
    time: 'Time',
    event: 'Event',
    symbol: 'Symbol',
    action: 'Action',
    side: 'Side',
    price: 'Price',
    amount: 'Amount',
    qty: 'Qty',
    pnlCol: 'Net PnL',
    score: 'Score',
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
  SKIP: '跳过',
};

const reasonText: Record<string, string> = {
  AI按达标信号开仓: 'AI按达标信号开仓',
  '到期/停止结算': '到期/停止结算',
  止盈结算: '止盈结算',
  止损结算: '止损结算',
  信号未达交易标准: '信号未达交易标准',
  稳定分数不足: '稳定分数不足',
  达到最大持仓数: '达到最大持仓数',
  单标的持仓数已满: '单标的持仓数已满',
  本轮信号已处理: '本轮信号已处理',
  '行情源为回退模拟，暂不交易': '行情源为回退模拟，暂不交易',
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
  return actionText[value] || eventText[value] || reasonText[value] || value;
}

export default function MultiMarketTradingPage({ locale }: Props) {
  const copy = COPY[locale] || COPY.zh;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState({
    capital_usd: 100_000,
    fixed_trade_usd: 1_000,
    max_open_positions: 8,
    stop_loss_pct: 0.018,
    take_profit_pct: 0.036,
    min_signal_score: 0.72,
    max_holding_minutes: 360,
  });

  const userId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_market_user_id') : '';
    if (stored) return stored;
    const id = `market_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_market_user_id', id);
    return id;
  }, []);

  const loadDashboard = useCallback(async () => {
    const res = await fetch(`/api/market-trading/dashboard?user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' });
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
    loadDashboard().catch(() => setMessage('读取多市场交易引擎失败。'));
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (dashboard?.summary?.mode === 'running') {
        await postAction('/api/market-trading/tick');
      } else {
        await loadDashboard().catch(() => undefined);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [dashboard?.summary?.mode, loadDashboard, postAction]);

  const summary = dashboard?.summary;
  const signals = dashboard?.signals || [];
  const trades = dashboard?.recent_trades || [];
  const positions = dashboard?.positions || [];

  return (
    <div className="min-h-full bg-[#0b1118] px-5 py-6 pb-14 text-slate-100">
      <section className="rounded-[30px] border border-cyan-200/15 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_34rem),linear-gradient(180deg,#101d24_0%,#0b1118_100%)] p-6">
        <p className="text-xs font-black uppercase tracking-[0.28em] text-cyan-200/70">{copy.eyebrow}</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-white">{copy.title}</h1>
        <p className="mt-2 max-w-5xl text-sm leading-6 text-cyan-50/62">{copy.subtitle}</p>
      </section>

      <section className="mt-5 rounded-[28px] border border-cyan-200/12 bg-white/[0.03] p-5">
        <h2 className="text-xl font-black text-white">{copy.model}</h2>
        <p className="mt-2 text-sm leading-6 text-cyan-50/62">{copy.modelText}</p>
        <p className="mt-2 text-xs text-amber-200/80">说明：这是研究用模拟账户，不构成投资建议。真实自动交易还需要券商/交易所授权、账户风控、合规审批和人工监控。</p>
      </section>

      <section className="mt-5 rounded-[28px] border border-cyan-200/12 bg-white/[0.03] p-5">
        <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-7">
          {[
            ['capital_usd', copy.capital],
            ['fixed_trade_usd', copy.fixedTrade],
            ['max_open_positions', copy.maxPositions],
            ['stop_loss_pct', copy.stopLoss],
            ['take_profit_pct', copy.takeProfit],
            ['min_signal_score', '最低稳定分'],
            ['max_holding_minutes', '最长持有分钟'],
          ].map(([key, label]) => (
            <label key={key} className="text-xs font-bold text-cyan-50/55">
              {label}
              <input
                className="mt-2 w-full rounded-2xl border border-cyan-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
                type="number"
                step={key.includes('pct') || key.includes('score') ? '0.001' : '1'}
                value={(config as any)[key]}
                onChange={(event) => setConfig((prev) => ({ ...prev, [key]: Number(event.target.value) }))}
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button disabled={loading || summary?.mode === 'running'} onClick={() => postAction('/api/market-trading/start', config)} className="rounded-2xl bg-cyan-300 px-5 py-3 text-sm font-black text-cyan-950 disabled:opacity-45">{copy.start}</button>
          <button disabled={loading} onClick={() => postAction('/api/market-trading/tick')} className="rounded-2xl border border-cyan-200/15 bg-cyan-300/12 px-5 py-3 text-sm font-black text-cyan-100">{copy.tick}</button>
          <button disabled={loading} onClick={() => postAction('/api/market-trading/stop', { liquidate: true })} className="rounded-2xl border border-red-300/30 bg-red-400/18 px-5 py-3 text-sm font-black text-red-100">{copy.stop}</button>
          <button onClick={() => {
            const blob = new Blob([JSON.stringify(dashboard, null, 2)], { type: 'application/json' });
            const href = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = href;
            a.download = `hfcd-multimarket-trading-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(href);
          }} className="rounded-2xl border border-cyan-200/15 bg-white/[0.05] px-5 py-3 text-sm font-black text-cyan-100">{copy.export}</button>
        </div>
        {message ? <div className="mt-4 rounded-2xl border border-cyan-200/15 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-100">{message}</div> : null}
      </section>

      <section className="mt-5 grid gap-4 md:grid-cols-5">
        {[
          [copy.status, summary?.mode || 'loading'],
          [copy.equity, money(summary?.equity_usd)],
          [copy.pnl, money(summary?.realized_pnl_usd)],
          [copy.unrealized, money(summary?.unrealized_pnl_usd)],
          [copy.winOpen, `${((summary?.win_rate || 0) * 100).toFixed(1)}% / ${summary?.open_positions || 0}/${summary?.max_open_positions || 0}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[24px] border border-cyan-200/10 bg-black/20 p-5">
            <p className="text-xs font-bold text-cyan-50/45">{label}</p>
            <p className="mt-3 text-2xl font-black text-white">{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-5 rounded-[28px] border border-cyan-200/12 bg-white/[0.03] p-5">
        <h2 className="text-lg font-black text-white">{copy.data}</h2>
        <div className={`mt-3 rounded-2xl border px-4 py-3 text-sm ${dashboard?.market_health?.ok ? 'border-cyan-200/15 bg-cyan-300/10 text-cyan-100' : 'border-amber-300/30 bg-amber-300/10 text-amber-100'}`}>
          状态：{dashboard?.market_health?.status || '-'} · 标的：{dashboard?.market_health?.symbols?.join(', ') || '-'} · 最新：{dashboard?.market_health?.latest_captured_at || '-'}
          <br />
          {dashboard?.market_health?.note || ''}
        </div>
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[28px] border border-cyan-200/12 bg-white/[0.03] p-5">
          <h2 className="text-xl font-black text-white">{copy.signals}</h2>
          <div className="mt-4 space-y-3">
            {signals.map((row) => (
              <div key={`${row.symbol}-${row.captured_at}`} className="rounded-2xl border border-cyan-200/10 bg-black/25 p-4">
                <p className="text-sm font-black text-white">{row.symbol} · {row.name}</p>
                <p className="mt-2 text-xs text-cyan-50/65">
                  {translate(row.action)} · 价格 {numberText(row.price, row.symbol?.includes('-USD') ? 2 : 4)} · 稳定分 {numberText(row.score, 3)} · 置信度 {pct(row.confidence)} · 源 {row.source}
                </p>
                <p className="mt-1 text-xs text-cyan-50/45">1步 {pct(row.r1)} · 6步 {pct(row.r6)} · 24步 {pct(row.r24)} {row.reject_reason ? `· ${row.reject_reason}` : ''}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[28px] border border-cyan-200/12 bg-white/[0.03] p-5">
          <h2 className="text-xl font-black text-white">{copy.positions}</h2>
          <div className="mt-4 overflow-auto">
            <table className="min-w-[720px] w-full text-left text-sm">
              <thead className="text-xs text-cyan-50/45">
                <tr>{[copy.symbol, copy.side, copy.price, copy.amount, copy.qty, copy.pnlCol, copy.source].map((head) => <th key={head} className="border-b border-cyan-200/10 px-3 py-3 font-black">{head}</th>)}</tr>
              </thead>
              <tbody>
                {positions.length ? positions.map((row: any, index) => (
                  <tr key={`${row.position_id}-${index}`} className="border-b border-cyan-200/8 text-cyan-50/86">
                    <td className="px-3 py-3">{row.symbol}</td>
                    <td className="px-3 py-3">{row.side === 'short' ? '做空' : '做多'}</td>
                    <td className="px-3 py-3">{numberText(row.last_price || row.entry_price, row.symbol?.includes('-USD') ? 2 : 4)}</td>
                    <td className="px-3 py-3">{money(row.notional_usd)}</td>
                    <td className="px-3 py-3">{numberText(row.quantity, 6)}</td>
                    <td className={`px-3 py-3 font-black ${Number(row.unrealized_pnl_usd || 0) < 0 ? 'text-red-300' : 'text-cyan-200'}`}>{money(row.unrealized_pnl_usd as number)}</td>
                    <td className="px-3 py-3">{row.source || '-'}</td>
                  </tr>
                )) : (
                  <tr><td className="px-3 py-6 text-cyan-50/50" colSpan={7}>暂无持仓。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mt-5 overflow-hidden rounded-[28px] border border-cyan-200/12 bg-white/[0.03] p-5">
        <h2 className="text-xl font-black text-white">{copy.history}</h2>
        <div className="mt-4 overflow-auto">
          <table className="min-w-[1180px] w-full text-left text-sm">
            <thead className="text-xs text-cyan-50/45">
              <tr>
                {[copy.time, copy.event, copy.symbol, copy.action, copy.side, copy.price, copy.amount, copy.qty, copy.pnlCol, copy.score, copy.source, copy.reason].map((head) => (
                  <th key={head} className="border-b border-cyan-200/10 px-3 py-3 font-black">{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((row, index) => (
                <tr key={`${row.ts}-${index}`} className="border-b border-cyan-200/8 text-cyan-50/86">
                  <td className="px-3 py-3">{row.ts ? new Date(row.ts).toLocaleString() : '-'}</td>
                  <td className="px-3 py-3"><span className="rounded-full bg-cyan-300/12 px-3 py-1 text-xs font-black text-cyan-200">{translate(row.event)}</span></td>
                  <td className="px-3 py-3">{row.symbol || '-'}</td>
                  <td className="px-3 py-3">{translate(row.action)}</td>
                  <td className="px-3 py-3">{row.side === 'short' ? '做空' : row.side === 'long' ? '做多' : '-'}</td>
                  <td className="px-3 py-3">{numberText(row.exit_price ?? row.entry_price ?? row.price, row.symbol?.includes('-USD') ? 2 : 4)}</td>
                  <td className="px-3 py-3">{money(row.trade_value_usd)}</td>
                  <td className="px-3 py-3">{numberText(row.quantity, 6)}</td>
                  <td className={`px-3 py-3 font-black ${Number(row.net_pnl_usd || 0) < 0 ? 'text-red-300' : 'text-cyan-200'}`}>{money(row.net_pnl_usd)}</td>
                  <td className="px-3 py-3">{numberText(row.score, 3)} / {pct(row.confidence)}</td>
                  <td className="px-3 py-3">{row.source || '-'}</td>
                  <td className="px-3 py-3">{translate(row.reason)}</td>
                </tr>
              ))}
              {!trades.length ? <tr><td className="px-3 py-6 text-cyan-50/50" colSpan={12}>暂无交易记录。</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
