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
    subtitle: '这是多市场总入口：BTC、ETH、SPY、QQQ、GLD 使用公开真实行情快照做 paper trading；GLD 是黄金 ETF 代理。若要测试黄金期货/现货代理的专属策略，请进入下方“黄金专属交易”。',
    model: '模型说明',
    modelText: '该模块复用 HFCD 的稳定门思想：只在趋势强度、波动归一化分数和信号置信度达标时开仓；BTC/ETH 适合 24 小时验证，SPY/QQQ 是股票代理，GLD 是黄金 ETF 代理。黄金专属策略使用 GC=F/GLD 实时行情优先级，并单独记录黄金交易账本。',
    goldEntry: '进入黄金专属交易',
    goldEntryHint: '使用 GC=F 优先、GLD 备用的黄金专属实时模拟交易，不会真实下单。',
    cryptoPanel: '加密 Testnet 镜像',
    cryptoHint: 'BTC/ETH 使用 Binance U本位合约公开实时数据，支持做多/做空、单笔最高金额、最大持仓和单币持仓限制；当前只写模拟/Testnet 镜像账本，不会真实下单。',
    maxSymbolPositions: '单币最大持仓',
    sidePolicy: '多空策略',
    both: '做多 + 做空',
    longOnly: '只做多',
    shortOnly: '只做空',
    cryptoStart: '启动加密模拟',
    cryptoTick: '加密运行一轮',
    cryptoStop: '停止并清仓',
    cryptoHealth: '加密安全状态',
    sensors: '黑暗森林传感器',
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
    subtitle: 'This is the multi-market entry. BTC, ETH, SPY, QQQ, and GLD use public live snapshots for paper trading; GLD is the gold ETF proxy. Use the dedicated gold entry for GC=F-first gold testing.',
    model: 'Model',
    modelText: 'The engine applies HFCD-style stability gates. BTC/ETH provide 24h validation; SPY/QQQ are equity proxies; GLD is the gold ETF proxy. The dedicated gold strategy uses GC=F first and GLD as fallback with a separate gold ledger.',
    goldEntry: 'Open dedicated gold trading',
    goldEntryHint: 'GC=F-first gold paper trading with GLD fallback. No real orders are sent.',
    cryptoPanel: 'Crypto Testnet Mirror',
    cryptoHint: 'BTC/ETH use Binance USD-M futures public realtime data. Long/short, max order amount, max positions, and per-symbol caps are configurable. This writes a paper/testnet mirror ledger only; no real exchange order is sent.',
    maxSymbolPositions: 'Max per symbol',
    sidePolicy: 'Side policy',
    both: 'Long + Short',
    longOnly: 'Long only',
    shortOnly: 'Short only',
    cryptoStart: 'Start Crypto Simulation',
    cryptoTick: 'Run Crypto Tick',
    cryptoStop: 'Stop and Liquidate',
    cryptoHealth: 'Crypto safety',
    sensors: 'DarkForest sensors',
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
  const [cryptoDashboard, setCryptoDashboard] = useState<any | null>(null);
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
  const [cryptoConfig, setCryptoConfig] = useState({
    capital_usd: 100_000,
    fixed_trade_usd: 1_000,
    max_open_positions: 4,
    max_symbol_positions: 1,
    stop_loss_pct: 0.018,
    take_profit_pct: 0.036,
    min_signal_score: 0.66,
    max_holding_minutes: 480,
    side_policy: 'both',
  });

  const userId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_market_user_id') : '';
    if (stored) return stored;
    const id = `market_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_market_user_id', id);
    return id;
  }, []);

  const cryptoUserId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_crypto_testnet_user_id') : '';
    if (stored) return stored;
    const id = `crypto_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_crypto_testnet_user_id', id);
    return id;
  }, []);

  const loadDashboard = useCallback(async () => {
    const res = await fetch(`/api/market-trading/dashboard?user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' });
    const data = await res.json() as Dashboard;
    setDashboard(data);
  }, [userId]);

  const loadCryptoDashboard = useCallback(async () => {
    const res = await fetch(`/api/crypto-testnet/dashboard?user_id=${encodeURIComponent(cryptoUserId)}`, { cache: 'no-store' });
    const data = await res.json();
    setCryptoDashboard(data);
  }, [cryptoUserId]);

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

  const postCryptoAction = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: cryptoUserId, ...body }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'request failed');
      setMessage('加密模拟交易操作已完成。');
      await loadCryptoDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加密模拟交易操作失败。');
    } finally {
      setLoading(false);
    }
  }, [cryptoUserId, loadCryptoDashboard]);

  useEffect(() => {
    loadDashboard().catch(() => setMessage('读取多市场交易引擎失败。'));
  }, [loadDashboard]);

  useEffect(() => {
    loadCryptoDashboard().catch(() => setMessage('读取加密 Testnet 镜像失败。'));
  }, [loadCryptoDashboard]);

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

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (cryptoDashboard?.summary?.mode === 'running') {
        await postCryptoAction('/api/crypto-testnet/tick');
      } else {
        await loadCryptoDashboard().catch(() => undefined);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [cryptoDashboard?.summary?.mode, loadCryptoDashboard, postCryptoAction]);

  const summary = dashboard?.summary;
  const signals = dashboard?.signals || [];
  const trades = dashboard?.recent_trades || [];
  const positions = dashboard?.positions || [];
  const cryptoSummary = cryptoDashboard?.summary;
  const cryptoSignals = cryptoDashboard?.signals || [];
  const cryptoTrades = cryptoDashboard?.recent_trades || [];
  const cryptoPositions = cryptoDashboard?.positions || [];
  const cryptoSensors = cryptoDashboard?.sensors || [];

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
        <div className="mt-4 rounded-2xl border border-amber-200/20 bg-amber-300/10 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-black text-amber-100">{copy.goldEntry}</p>
              <p className="mt-1 text-xs leading-5 text-amber-50/65">{copy.goldEntryHint}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                window.history.pushState({}, '', '?view=gold-trading');
                window.dispatchEvent(new PopStateEvent('popstate'));
              }}
              className="rounded-2xl bg-amber-300 px-5 py-3 text-sm font-black text-amber-950 transition hover:bg-amber-200"
            >
              {copy.goldEntry}
            </button>
          </div>
        </div>
      </section>

      <section className="mt-5 rounded-[28px] border border-emerald-200/15 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.16),transparent_30rem),rgba(255,255,255,0.03)] p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.24em] text-emerald-200/70">HFCD V2.23 Binance</p>
            <h2 className="mt-1 text-2xl font-black text-white">{copy.cryptoPanel}</h2>
            <p className="mt-2 max-w-5xl text-sm leading-6 text-emerald-50/65">{copy.cryptoHint}</p>
          </div>
          <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${cryptoDashboard?.market_health?.ok ? 'border-emerald-200/20 bg-emerald-300/10 text-emerald-100' : 'border-amber-300/30 bg-amber-300/10 text-amber-100'}`}>
            {copy.cryptoHealth}：{cryptoDashboard?.market_health?.status || 'loading'} · {cryptoSummary?.mode || 'stopped'}
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-4 xl:grid-cols-8">
          {[
            ['capital_usd', copy.capital],
            ['fixed_trade_usd', '单笔最高金额'],
            ['max_open_positions', copy.maxPositions],
            ['max_symbol_positions', copy.maxSymbolPositions],
            ['stop_loss_pct', copy.stopLoss],
            ['take_profit_pct', copy.takeProfit],
            ['min_signal_score', '最低稳定分'],
            ['max_holding_minutes', '最长持有分钟'],
          ].map(([key, label]) => (
            <label key={key} className="text-xs font-bold text-emerald-50/55">
              {label}
              <input
                className="mt-2 w-full rounded-2xl border border-emerald-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
                type="number"
                step={key.includes('pct') || key.includes('score') ? '0.001' : '1'}
                value={(cryptoConfig as any)[key]}
                onChange={(event) => setCryptoConfig((prev) => ({ ...prev, [key]: Number(event.target.value) }))}
              />
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <label className="w-full text-xs font-bold text-emerald-50/55 md:w-56">
            {copy.sidePolicy}
            <select
              className="mt-2 w-full rounded-2xl border border-emerald-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
              value={cryptoConfig.side_policy}
              onChange={(event) => setCryptoConfig((prev) => ({ ...prev, side_policy: event.target.value }))}
            >
              <option value="both">{copy.both}</option>
              <option value="long_only">{copy.longOnly}</option>
              <option value="short_only">{copy.shortOnly}</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            <button disabled={loading || cryptoSummary?.mode === 'running'} onClick={() => postCryptoAction('/api/crypto-testnet/start', cryptoConfig)} className="rounded-2xl bg-emerald-300 px-5 py-3 text-sm font-black text-emerald-950 disabled:opacity-45">{copy.cryptoStart}</button>
            <button disabled={loading} onClick={() => postCryptoAction('/api/crypto-testnet/tick')} className="rounded-2xl border border-emerald-200/15 bg-emerald-300/12 px-5 py-3 text-sm font-black text-emerald-100">{copy.cryptoTick}</button>
            <button disabled={loading} onClick={() => postCryptoAction('/api/crypto-testnet/stop', { liquidate: true })} className="rounded-2xl border border-red-300/30 bg-red-400/18 px-5 py-3 text-sm font-black text-red-100">{copy.cryptoStop}</button>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-5">
          {[
            [copy.status, cryptoSummary?.mode || 'loading'],
            [copy.equity, money(cryptoSummary?.equity_usd)],
            [copy.pnl, money(cryptoSummary?.realized_pnl_usd)],
            [copy.unrealized, money(cryptoSummary?.unrealized_pnl_usd)],
            [copy.winOpen, `${((cryptoSummary?.win_rate || 0) * 100).toFixed(1)}% / ${cryptoSummary?.open_positions || 0}/${cryptoSummary?.max_open_positions || 0}`],
          ].map(([label, value]) => (
            <div key={`crypto-${label}`} className="rounded-[22px] border border-emerald-200/10 bg-black/22 p-4">
              <p className="text-xs font-bold text-emerald-50/45">{label}</p>
              <p className="mt-2 text-xl font-black text-white">{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <div className="rounded-[24px] border border-emerald-200/10 bg-black/20 p-4">
            <h3 className="text-lg font-black text-white">BTC/ETH 信号</h3>
            <div className="mt-3 space-y-3">
              {cryptoSignals.map((row: any) => (
                <div key={`${row.symbol}-${row.captured_at}`} className="rounded-2xl border border-emerald-200/10 bg-white/[0.03] p-4">
                  <p className="text-sm font-black text-white">{row.symbol} · {row.route}</p>
                  <p className="mt-2 text-xs text-emerald-50/70">
                    {translate(row.action)} · 价格 {numberText(row.price, row.symbol === 'BTCUSDT' ? 2 : 3)} · 稳定分 {numberText(row.score, 3)} · 置信度 {pct(row.confidence)} · 资金费率 {pct(row.funding_rate)}
                  </p>
                  <p className="mt-1 text-xs text-emerald-50/45">深度失衡 {numberText(row.depth_imbalance, 4)} · 点差 {numberText(row.spread_bps, 2)} bps · {row.reject_reason || '信号达标时按配置执行'}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[24px] border border-emerald-200/10 bg-black/20 p-4">
            <h3 className="text-lg font-black text-white">{copy.sensors}</h3>
            <div className="mt-3 overflow-auto">
              <table className="min-w-[720px] w-full text-left text-xs">
                <thead className="text-emerald-50/45">
                  <tr>{['标的', '资金费率', 'OI', '买盘深度', '卖盘深度', '失衡', '点差'].map((head) => <th key={head} className="border-b border-emerald-200/10 px-3 py-3 font-black">{head}</th>)}</tr>
                </thead>
                <tbody>
                  {cryptoSensors.map((row: any) => (
                    <tr key={`sensor-${row.symbol}`} className="border-b border-emerald-200/8 text-emerald-50/80">
                      <td className="px-3 py-3 font-black">{row.symbol}</td>
                      <td className="px-3 py-3">{pct(row.funding_rate)}</td>
                      <td className="px-3 py-3">{numberText(row.open_interest, 0)}</td>
                      <td className="px-3 py-3">{money(row.bid_depth_usd)}</td>
                      <td className="px-3 py-3">{money(row.ask_depth_usd)}</td>
                      <td className="px-3 py-3">{numberText(row.depth_imbalance, 4)}</td>
                      <td className="px-3 py-3">{numberText(row.spread_bps, 2)} bps</td>
                    </tr>
                  ))}
                  {!cryptoSensors.length ? <tr><td className="px-3 py-6 text-emerald-50/50" colSpan={7}>暂无传感器数据。</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <MiniTradeTable title="加密当前持仓" rows={cryptoPositions} type="positions" />
          <MiniTradeTable title="加密交易记录" rows={cryptoTrades} type="history" />
        </div>
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

function MiniTradeTable({ title, rows, type }: { title: string; rows: any[]; type: 'positions' | 'history' }) {
  return (
    <div className="rounded-[24px] border border-emerald-200/10 bg-black/20 p-4">
      <h3 className="text-lg font-black text-white">{title}</h3>
      <div className="mt-3 overflow-auto">
        <table className="min-w-[760px] w-full text-left text-xs">
          <thead className="text-emerald-50/45">
            <tr>
              {['时间', '事件', '标的', '方向', '价格', '金额', '数量', '净收益', '原因'].map((head) => (
                <th key={head} className="border-b border-emerald-200/10 px-3 py-3 font-black">{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.position_id || row.ts || row.symbol}-${index}`} className="border-b border-emerald-200/8 text-emerald-50/80">
                <td className="px-3 py-3">{row.ts || row.opened_at ? new Date(row.ts || row.opened_at).toLocaleString() : '-'}</td>
                <td className="px-3 py-3"><span className="rounded-full bg-emerald-300/12 px-3 py-1 font-black text-emerald-200">{type === 'positions' ? '持仓' : translate(row.event)}</span></td>
                <td className="px-3 py-3 font-black">{row.symbol || '-'}</td>
                <td className="px-3 py-3">{row.side === 'short' ? '做空' : row.side === 'long' ? '做多' : '-'}</td>
                <td className="px-3 py-3">{numberText(row.exit_price ?? row.entry_price ?? row.price ?? row.last_price, row.symbol === 'BTCUSDT' ? 2 : 3)}</td>
                <td className="px-3 py-3">{money(row.trade_value_usd ?? row.notional_usd)}</td>
                <td className="px-3 py-3">{numberText(row.quantity, 6)}</td>
                <td className={`px-3 py-3 font-black ${Number(row.net_pnl_usd ?? row.unrealized_pnl_usd ?? 0) < 0 ? 'text-red-300' : 'text-emerald-200'}`}>{money(row.net_pnl_usd ?? row.unrealized_pnl_usd)}</td>
                <td className="px-3 py-3">{translate(row.reason)}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td className="px-3 py-6 text-emerald-50/50" colSpan={9}>暂无记录。</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
