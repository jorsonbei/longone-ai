import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '../lib/locale';

type Props = {
  locale: Locale;
};

type EnergyTrade = {
  ts?: string;
  event?: string;
  node?: string;
  horizon?: string;
  signal_source?: string;
  action?: string;
  entry_action?: string;
  exit_action?: string;
  roundtrip_code?: string;
  price_spread?: number;
  entry_spread?: number;
  exit_spread?: number;
  mwh?: number;
  entry_trade_value_usd?: number;
  exit_trade_value_usd?: number;
  net_pnl_usd?: number;
  reason?: string;
};

type EnergyDecision = {
  captured_at?: string;
  node?: string;
  horizon?: string;
  signal_source?: string;
  visible_spread?: number;
  model_prediction_mw?: number;
  paper_action?: string;
  tier?: string;
  reject_reason?: string;
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
    rows: number;
    note?: string;
  };
  decisions: EnergyDecision[];
  summary: {
    mode: string;
    equity_usd: number;
    cash_usd: number;
    realized_pnl_usd: number;
    open_positions: number;
    max_open_positions: number;
    win_rate: number;
    config?: Record<string, unknown>;
  };
  recent_trades: EnergyTrade[];
};

const COPY: Record<Locale, {
  eyebrow: string;
  title: string;
  subtitle: string;
  model: string;
  modelText: string;
  start: string;
  tick: string;
  stop: string;
  export: string;
  capital: string;
  fixedTrade: string;
  maxPositions: string;
  stopLoss: string;
  takeProfit: string;
  status: string;
  equity: string;
  pnl: string;
  winOpen: string;
  market: string;
  latestSignals: string;
  trades: string;
  time: string;
  event: string;
  horizon: string;
  source: string;
  node: string;
  action: string;
  loop: string;
  spread: string;
  mwh: string;
  entryAmount: string;
  exitAmount: string;
  netPnl: string;
  reason: string;
}> = {
  zh: {
    eyebrow: 'HFCD 能源交易',
    title: 'AI 模拟交易沙盒',
    subtitle: '线上 Worker + D1 模拟 CAISO 风格储能套利。它只做 paper trading，不会向真实市场下单。',
    model: '模型说明',
    modelText: '当前主线包含 V3.36 一小时执行信号和 V3.28/V3.29 三小时、六小时 roundtrip 稳定门。AI 只在信号达标时开仓，并记录开仓、平仓、金额、盈亏和信号来源。',
    start: '启动 AI 自动交易',
    tick: 'AI 运行一轮',
    stop: '停止并清仓结算',
    export: '导出记录',
    capital: '总资金',
    fixedTrade: '单次金额',
    maxPositions: '最大持仓',
    stopLoss: '单笔止损',
    takeProfit: '单笔止盈',
    status: 'AI 状态',
    equity: 'AI 总资产',
    pnl: 'AI 已实现收益',
    winOpen: 'AI 胜率 / 持仓',
    market: '数据质量 / 策略锁',
    latestSignals: '最新信号',
    trades: 'AI 交易明细',
    time: '时间',
    event: '事件',
    horizon: '信号周期',
    source: '信号源',
    node: '节点',
    action: '操作',
    loop: '交易回路',
    spread: '价差 ($/MWh)',
    mwh: '本轮电量 (MWh)',
    entryAmount: '开仓金额',
    exitAmount: '平仓金额',
    netPnl: '净收益',
    reason: '原因',
  },
  en: {
    eyebrow: 'HFCD Energy Trading',
    title: 'AI Paper-Trading Sandbox',
    subtitle: 'Online Worker + D1 simulation for CAISO-style storage arbitrage. It is paper trading only and never sends real market orders.',
    model: 'Model',
    modelText: 'The engine combines V3.36 1h execution signals with V3.28/V3.29 3h and 6h roundtrip stability gates. It opens only qualified signals and records entry, exit, amount, PnL, and lineage.',
    start: 'Start AI Trading',
    tick: 'Run One AI Tick',
    stop: 'Stop and Liquidate',
    export: 'Export',
    capital: 'Capital',
    fixedTrade: 'Trade amount',
    maxPositions: 'Max positions',
    stopLoss: 'Stop loss',
    takeProfit: 'Take profit',
    status: 'AI status',
    equity: 'AI equity',
    pnl: 'Realized PnL',
    winOpen: 'Win rate / Open',
    market: 'Data Quality / Strategy Lock',
    latestSignals: 'Latest Signals',
    trades: 'AI Trade Details',
    time: 'Time',
    event: 'Event',
    horizon: 'Horizon',
    source: 'Signal source',
    node: 'Node',
    action: 'Action',
    loop: 'Trade loop',
    spread: 'Spread ($/MWh)',
    mwh: 'MWh',
    entryAmount: 'Entry amount',
    exitAmount: 'Exit amount',
    netPnl: 'Net PnL',
    reason: 'Reason',
  },
  vi: {
    eyebrow: 'HFCD giao dich nang luong',
    title: 'Hop cat giao dich AI',
    subtitle: 'Mo phong paper trading truc tuyen bang Worker + D1; khong gui lenh that.',
    model: 'Mo hinh',
    modelText: 'Ket hop tin hieu 1h V3.36 voi cong on dinh roundtrip 3h/6h V3.28/V3.29.',
    start: 'Bat dau AI',
    tick: 'Chay mot vong',
    stop: 'Dung va tat toan',
    export: 'Xuat du lieu',
    capital: 'Tong von',
    fixedTrade: 'So tien moi lenh',
    maxPositions: 'Vi the toi da',
    stopLoss: 'Dung lo',
    takeProfit: 'Chot loi',
    status: 'Trang thai',
    equity: 'Tai san',
    pnl: 'Loi nhuan da thuc hien',
    winOpen: 'Ty le thang / vi the',
    market: 'Chat luong du lieu',
    latestSignals: 'Tin hieu moi',
    trades: 'Chi tiet giao dich',
    time: 'Thoi gian',
    event: 'Su kien',
    horizon: 'Chu ky',
    source: 'Nguon tin hieu',
    node: 'Nut',
    action: 'Thao tac',
    loop: 'Vong giao dich',
    spread: 'Chenh lech',
    mwh: 'MWh',
    entryAmount: 'Tien mo',
    exitAmount: 'Tien dong',
    netPnl: 'Loi nhuan rong',
    reason: 'Ly do',
  },
  ja: {
    eyebrow: 'HFCDエネルギー取引',
    title: 'AIペーパートレード',
    subtitle: 'Worker + D1 によるオンライン模擬取引。実注文は送信しません。',
    model: 'モデル',
    modelText: 'V3.36の1時間信号とV3.28/V3.29の3時間/6時間roundtrip安定ゲートを組み合わせます。',
    start: 'AI取引開始',
    tick: 'AIを1回実行',
    stop: '停止して清算',
    export: 'エクスポート',
    capital: '資金',
    fixedTrade: '1回金額',
    maxPositions: '最大建玉',
    stopLoss: '損切り',
    takeProfit: '利確',
    status: 'AI状態',
    equity: '総資産',
    pnl: '確定損益',
    winOpen: '勝率 / 建玉',
    market: 'データ品質',
    latestSignals: '最新シグナル',
    trades: '取引明細',
    time: '時刻',
    event: 'イベント',
    horizon: '周期',
    source: '信号源',
    node: 'ノード',
    action: '操作',
    loop: '取引ループ',
    spread: 'スプレッド',
    mwh: 'MWh',
    entryAmount: '建玉金額',
    exitAmount: '決済金額',
    netPnl: '純損益',
    reason: '理由',
  },
  fr: {} as any,
  es: {} as any,
  de: {} as any,
};

COPY.fr = COPY.en;
COPY.es = COPY.en;
COPY.de = COPY.en;

const actionText: Record<string, string> = {
  CHARGE_BUY: '充电买入',
  DISCHARGE_SELL: '放电卖出',
  NO_TRADE: '不交易',
};

const eventText: Record<string, string> = {
  OPEN: '开仓',
  CLOSE: '平仓/结算',
  SKIP: '跳过',
};

const reasonText: Record<string, string> = {
  'AI自动开仓': 'AI自动开仓',
  '到期结算': '到期结算',
  '止盈结算': '止盈结算',
  '止损结算': '止损结算',
  '达到最大持仓数': '达到最大持仓数',
  '信号未达交易标准': '信号未达交易标准',
  '价差未达交易阈值': '价差未达交易阈值',
  '预测功率不足': '预测功率不足',
  '置信等级不足': '置信等级不足',
  '没有可执行方向': '没有可执行方向',
};

function money(value?: number) {
  const n = Number(value || 0);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function num(value?: number, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function text(value?: string) {
  if (!value) return '-';
  return actionText[value] || eventText[value] || reasonText[value] || value;
}

export default function EnergyTradingPage({ locale }: Props) {
  const copy = COPY[locale] || COPY.zh;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState({
    capital_usd: 1_000_000,
    fixed_trade_usd: 10_000,
    max_open_positions: 10,
    stop_loss_usd: 450,
    take_profit_usd: 900,
  });

  const userId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_energy_user_id') : '';
    if (stored) return stored;
    const id = `os_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_energy_user_id', id);
    return id;
  }, []);

  const loadDashboard = useCallback(async () => {
    const res = await fetch(`/api/energy-trading/dashboard?user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' });
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
    loadDashboard().catch(() => setMessage('读取线上交易引擎失败。'));
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (dashboard?.summary?.mode === 'running') {
        await postAction('/api/energy-trading/tick');
      } else {
        await loadDashboard().catch(() => undefined);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [dashboard?.summary?.mode, loadDashboard, postAction]);

  const trades = dashboard?.recent_trades || [];
  const decisions = dashboard?.decisions || [];

  return (
    <div className="min-h-full bg-[#0b1512] px-5 py-6 text-slate-100">
      <div className="rounded-[28px] border border-emerald-200/15 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.18),transparent_32rem),linear-gradient(180deg,#10211c_0%,#0b1512_100%)] p-6">
        <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-200/70">{copy.eyebrow}</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-white">{copy.title}</h1>
        <p className="mt-2 max-w-5xl text-sm leading-6 text-emerald-50/62">{copy.subtitle}</p>
      </div>

      <section className="mt-5 rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
        <h2 className="text-xl font-black text-white">{copy.model}</h2>
        <p className="mt-2 text-sm leading-6 text-emerald-50/62">{copy.modelText}</p>
        <p className="mt-2 text-xs text-amber-200/80">说明：这是线上模拟账户，不连接真实交易所；真实自动交易需要资产方 EMS/BMS、CAISO 参与者接口、报价/成交 API、合规与风控审批。</p>
      </section>

      <section className="mt-5 rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
        <div className="grid gap-3 md:grid-cols-5">
          {[
            ['capital_usd', copy.capital],
            ['fixed_trade_usd', copy.fixedTrade],
            ['max_open_positions', copy.maxPositions],
            ['stop_loss_usd', copy.stopLoss],
            ['take_profit_usd', copy.takeProfit],
          ].map(([key, label]) => (
            <label key={key} className="text-xs font-bold text-emerald-50/55">
              {label}
              <input
                className="mt-2 w-full rounded-2xl border border-emerald-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
                type="number"
                value={(config as any)[key]}
                onChange={(event) => setConfig((prev) => ({ ...prev, [key]: Number(event.target.value) }))}
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button disabled={loading || dashboard?.summary?.mode === 'running'} onClick={() => postAction('/api/energy-trading/start', config)} className="rounded-2xl bg-emerald-300 px-5 py-3 text-sm font-black text-emerald-950 disabled:opacity-45">
            {copy.start}
          </button>
          <button disabled={loading} onClick={() => postAction('/api/energy-trading/tick')} className="rounded-2xl border border-emerald-200/15 bg-emerald-300/12 px-5 py-3 text-sm font-black text-emerald-100">
            {copy.tick}
          </button>
          <button disabled={loading} onClick={() => postAction('/api/energy-trading/stop', { liquidate: true })} className="rounded-2xl border border-red-300/30 bg-red-400/18 px-5 py-3 text-sm font-black text-red-100">
            {copy.stop}
          </button>
          <button onClick={() => {
            const blob = new Blob([JSON.stringify(dashboard, null, 2)], { type: 'application/json' });
            const href = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = href;
            a.download = `hfcd-energy-trading-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(href);
          }} className="rounded-2xl border border-emerald-200/15 bg-white/[0.05] px-5 py-3 text-sm font-black text-emerald-100">
            {copy.export}
          </button>
        </div>
        {message ? <div className="mt-4 rounded-2xl border border-emerald-200/15 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">{message}</div> : null}
      </section>

      <section className="mt-5 grid gap-4 md:grid-cols-4">
        {[
          [copy.status, dashboard?.summary?.mode || 'loading'],
          [copy.equity, money(dashboard?.summary?.equity_usd)],
          [copy.pnl, money(dashboard?.summary?.realized_pnl_usd)],
          [copy.winOpen, `${((dashboard?.summary?.win_rate || 0) * 100).toFixed(1)}% / ${dashboard?.summary?.open_positions || 0}/${dashboard?.summary?.max_open_positions || 0}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[24px] border border-emerald-200/10 bg-black/20 p-5">
            <p className="text-xs font-bold text-emerald-50/45">{label}</p>
            <p className="mt-3 text-2xl font-black text-white">{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-5 rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
        <h2 className="text-lg font-black text-white">{copy.market}</h2>
        <div className="mt-3 rounded-2xl border border-emerald-200/15 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">
          状态：{dashboard?.market_health?.status || '-'} · D1：{dashboard?.db_status || '-'} · 最新：{dashboard?.market_health?.latest_captured_at || '-'} · 行数：{dashboard?.market_health?.rows || 0}
        </div>
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.6fr]">
        <div className="rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
          <h2 className="text-xl font-black text-white">{copy.latestSignals}</h2>
          <div className="mt-4 space-y-3">
            {decisions.map((row) => (
              <div key={`${row.horizon}-${row.captured_at}`} className="rounded-2xl border border-emerald-200/10 bg-black/25 p-4">
                <p className="text-xs font-black text-emerald-200/70">{row.horizon} · {row.signal_source}</p>
                <p className="mt-2 text-sm text-emerald-50/65">{row.node} · {text(row.paper_action)} · {copy.spread}: {num(row.visible_spread)} · {copy.mwh}: {num(row.model_prediction_mw, 1)} · {row.tier}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
          <h2 className="text-xl font-black text-white">{copy.trades}</h2>
          <div className="mt-4 overflow-auto">
            <table className="min-w-[1280px] w-full text-left text-sm">
              <thead className="text-xs text-emerald-50/45">
                <tr>
                  {[copy.time, copy.event, copy.horizon, copy.source, copy.node, copy.action, copy.loop, copy.spread, copy.mwh, copy.entryAmount, copy.exitAmount, copy.netPnl, copy.reason].map((head) => (
                    <th key={head} className="border-b border-emerald-200/10 px-3 py-3 font-black">{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((row, index) => (
                  <tr key={`${row.ts}-${index}`} className="border-b border-emerald-200/8 text-emerald-50/86">
                    <td className="px-3 py-3">{row.ts ? new Date(row.ts).toLocaleString() : '-'}</td>
                    <td className="px-3 py-3"><span className="rounded-full bg-emerald-300/12 px-3 py-1 text-xs font-black text-emerald-200">{text(row.event)}</span></td>
                    <td className="px-3 py-3">{row.horizon || '-'}</td>
                    <td className="px-3 py-3">{row.signal_source || '-'}</td>
                    <td className="px-3 py-3">{row.node || '-'}</td>
                    <td className="px-3 py-3">{text(row.exit_action || row.entry_action || row.action)}</td>
                    <td className="px-3 py-3">{row.roundtrip_code || '-'}</td>
                    <td className="px-3 py-3">{num(row.price_spread ?? row.entry_spread ?? row.exit_spread)}</td>
                    <td className="px-3 py-3">{num(row.mwh)}</td>
                    <td className="px-3 py-3">{money(row.entry_trade_value_usd)}</td>
                    <td className="px-3 py-3">{money(row.exit_trade_value_usd)}</td>
                    <td className={`px-3 py-3 font-black ${(row.net_pnl_usd || 0) < 0 ? 'text-red-300' : 'text-emerald-200'}`}>{money(row.net_pnl_usd)}</td>
                    <td className="px-3 py-3">{text(row.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
