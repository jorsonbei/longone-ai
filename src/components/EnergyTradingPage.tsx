import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '../lib/locale';

type Props = {
  locale: Locale;
};

type EnergyTrade = {
  ts?: string;
  event?: string;
  symbol?: string;
  node?: string;
  horizon?: string;
  signal_source?: string;
  action?: string;
  side?: string;
  entry_action?: string;
  exit_action?: string;
  roundtrip_code?: string;
  price_spread?: number;
  entry_price?: number;
  exit_price?: number;
  quantity?: number;
  entry_spread?: number;
  exit_spread?: number;
  mwh?: number;
  entry_trade_value_usd?: number;
  exit_trade_value_usd?: number;
  net_pnl_usd?: number;
  pnl_pct_of_trade?: number;
  stop_loss_usd?: number;
  take_profit_usd?: number;
  risk_source?: string;
  segment_expectancy_usd?: number;
  segment_profit_factor?: number;
  reason?: string;
};

type EnergyDecision = {
  captured_at?: string;
  symbol?: string;
  name?: string;
  price?: number;
  score?: number;
  side?: string;
  node?: string;
  horizon?: string;
  cadence?: string;
  signal_source?: string;
  source_version?: string;
  lineage_id?: string;
  visible_spread?: number;
  model_prediction_mw?: number;
  paper_action?: string;
  action?: string;
  tier?: string;
  reject_reason?: string;
};

type Dashboard = {
  ok: boolean;
  online_backend: boolean;
  db_status: string;
  version: string;
  updated_at: string;
  ledger?: {
    source?: string;
    api_prefix?: string;
    user_id?: string;
    user_id_suffix?: string;
    dashboard_updated_at?: string;
    account_started_at?: string;
    account_stopped_at?: string;
    account_last_tick_at?: string;
    browser_storage_key?: string;
    note?: string;
  };
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
    settled_equity_usd?: number;
    realized_pnl_usd: number;
    unrealized_pnl_usd?: number;
    open_positions: number;
    max_open_positions: number;
    win_rate: number;
    config?: Record<string, unknown>;
  };
  account?: {
    user_id?: string;
    started_at?: string;
    stopped_at?: string;
    last_tick_at?: string;
  };
  recent_trades: EnergyTrade[];
  risk_optimization?: {
    status?: string;
    message?: string;
    sample_count?: number;
    path_quality?: string;
    recommended?: {
      stop_loss_usd?: number;
      take_profit_usd?: number;
      stop_loss_pct?: number;
      take_profit_pct?: number;
      simulated_net_pnl_usd?: number;
      simulated_win_rate?: number;
      profit_factor?: number;
      max_drawdown_usd?: number;
      path_coverage?: number;
    };
    top_candidates?: Array<{
      stop_loss_usd?: number;
      take_profit_usd?: number;
      stop_loss_pct?: number;
      take_profit_pct?: number;
      simulated_net_pnl_usd?: number;
      simulated_win_rate?: number;
      profit_factor?: number;
      max_drawdown_usd?: number;
    }>;
  };
  win_rate_diagnostics?: {
    sample_count?: number;
    wins?: number;
    losses?: number;
    win_rate?: number;
    net_pnl_usd?: number;
    avg_win_usd?: number;
    avg_loss_usd?: number;
    payoff_ratio?: number;
    profit_factor?: number;
    causes?: string[];
    recommendations?: string[];
    by_horizon?: Array<Record<string, unknown>>;
    by_action?: Array<Record<string, unknown>>;
    by_source?: Array<Record<string, unknown>>;
  };
  routes?: Array<Record<string, unknown>>;
  source_status?: string;
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
  reset: string;
  export: string;
  exportLedgerId: string;
  capital: string;
  fixedTrade: string;
  maxPositions: string;
  stopLoss: string;
  takeProfit: string;
  status: string;
  equity: string;
  pnl: string;
  unrealizedPnl: string;
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
    subtitle: '线上 Worker + D1 模拟 CAISO 风格储能套利；可接入真实交易所/CAISO 快照，但这里只做 paper trading，不会向真实市场下单。',
    model: '模型说明',
    modelText: '当前主线包含 V3.36 一小时执行信号和 V3.28/V3.29 三小时、六小时 roundtrip 稳定门。系统按真实交易所储能套利口径处理行情快照、价差、开平仓和结算；若后端接入 CAISO/OASIS 或交易所 API，则使用真实快照，但本页始终只记录模拟交易，不真实下单。',
    start: '启动 AI 自动交易',
    tick: 'AI 运行一轮',
    stop: '停止并清仓结算',
    reset: '重置商品账本',
    export: '导出记录',
    exportLedgerId: '导出账本 ID',
    capital: '总资金',
    fixedTrade: '单次金额',
    maxPositions: '最大持仓',
    stopLoss: '单笔止损',
    takeProfit: '单笔止盈',
    status: 'AI 状态',
    equity: 'AI 已结算资产',
    pnl: 'AI 已实现收益',
    unrealizedPnl: 'AI 未实现盈亏',
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
    reset: 'Reset Commodity Ledger',
    export: 'Export',
    exportLedgerId: 'Export Ledger ID',
    capital: 'Capital',
    fixedTrade: 'Trade amount',
    maxPositions: 'Max positions',
    stopLoss: 'Stop loss',
    takeProfit: 'Take profit',
    status: 'AI status',
    equity: 'Settled equity',
    pnl: 'Realized PnL',
    unrealizedPnl: 'Unrealized PnL',
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
    reset: 'Dat lai so hang hoa',
    export: 'Xuat du lieu',
    exportLedgerId: 'Xuat Ledger ID',
    capital: 'Tong von',
    fixedTrade: 'So tien moi lenh',
    maxPositions: 'Vi the toi da',
    stopLoss: 'Dung lo',
    takeProfit: 'Chot loi',
    status: 'Trang thai',
    equity: 'Tai san da quyet toan',
    pnl: 'Loi nhuan da thuc hien',
    unrealizedPnl: 'Loi/lỗ chua thuc hien',
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
    reset: '商品台帳をリセット',
    export: 'エクスポート',
    exportLedgerId: 'Ledger IDを出力',
    capital: '資金',
    fixedTrade: '1回金額',
    maxPositions: '最大建玉',
    stopLoss: '損切り',
    takeProfit: '利確',
    status: 'AI状態',
    equity: '確定後資産',
    pnl: '確定損益',
    unrealizedPnl: '未実現損益',
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
  '该信号源历史期望为负': '该信号源历史期望为负',
  '模拟止盈': '模拟止盈',
  '模拟止损': '模拟止损',
  '粗略截断估计': '粗略截断估计',
  'ExactLineage 前向开仓': 'ExactLineage 前向开仓',
  '主血统分数不足': '主血统分数不足',
  '稳定分不足': '稳定分不足',
  '该商品持仓已满': '该商品持仓已满',
};

const deskCopy = {
  power: {
    label: '电力价差交易',
    subtitle: 'CAISO 风格储能套利 · 电力/价差 paper engine',
    title: 'AI 模拟交易沙盒',
    description: '当前主线包含 V3.36 一小时执行信号和 V3.28/V3.29 三小时、六小时 roundtrip 稳定门。系统按真实交易所储能套利口径处理行情快照、价差、开平仓和结算。',
    note: '说明：这是线上模拟账户；行情快照按真实交易所/CAISO 储能套利口径处理，当前页面不向真实交易所下单。',
  },
  commodity: {
    label: '能源商品期货',
    subtitle: 'CL=F 原油 3h + HO=F 取暖油 2h · V5.18 ExactLineage 前向账本',
    title: '能源商品 AI 模拟交易',
    description: '只接入 V5.17 已通过的两条血统路线：CL=F 继承 V5.4 3h 强收益路线，HO=F 继承 V5.9 2h 高命中路线。1m/5m 只做执行检查、跳过原因和 paper PnL 记录，不重新生成主信号。',
    note: '说明：这是能源商品期货 paper trading；使用公开 5m 行情做前向模拟，不向真实期货账户下单。通过前向账本后再考虑真实接口。',
  },
} as const;

function money(value?: number) {
  const n = Number(value || 0);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function moneyOrDash(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '-';
  return money(Number(value));
}

function num(value?: number, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function pct(value?: number) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
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
  const [activeDesk, setActiveDesk] = useState<'power' | 'commodity'>('power');
  const [config, setConfig] = useState({
    capital_usd: 1_000_000,
    fixed_trade_usd: 10_000,
    max_open_positions: 10,
    max_symbol_positions: 1,
    stop_loss_usd: 450,
    take_profit_usd: 900,
    stop_loss_pct: 0.018,
    take_profit_pct: 0.036,
    min_signal_score: 0.66,
  });
  const desk = deskCopy[activeDesk];
  const apiPrefix = activeDesk === 'commodity' ? '/api/commodity-energy-trading' : '/api/energy-trading';

  const userId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_energy_user_id') : '';
    if (stored) return stored;
    const id = `os_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_energy_user_id', id);
    return id;
  }, []);

  const loadDashboard = useCallback(async () => {
    const res = await fetch(`${apiPrefix}/dashboard?user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' });
    const data = await res.json() as Dashboard;
    setDashboard(data);
  }, [apiPrefix, userId]);

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

  const resetCommodityLedger = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/commodity-energy-trading/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: userId, ...config }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'reset failed');
      setMessage('能源商品线上账本已重置。');
      await loadDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重置失败。');
    } finally {
      setLoading(false);
    }
  }, [config, loadDashboard, userId]);

  const exportLedgerId = useCallback(() => {
    const payload = {
      active_desk: activeDesk,
      browser_storage_key: 'hfcd_energy_user_id',
      browser_user_id: userId,
      api_prefix: apiPrefix,
      online_ledger_user_id: dashboard?.ledger?.user_id || dashboard?.account?.user_id || (activeDesk === 'commodity' ? `commodity_${userId}`.slice(0, 80) : userId),
      online_ledger_user_id_suffix: dashboard?.ledger?.user_id_suffix || (dashboard?.ledger?.user_id || dashboard?.account?.user_id || userId).slice(-10),
      source: dashboard?.ledger?.source || (dashboard?.online_backend ? 'longone_worker_d1' : 'worker_default_no_d1'),
      dashboard_updated_at: dashboard?.updated_at || '',
      account_last_tick_at: dashboard?.ledger?.account_last_tick_at || dashboard?.account?.last_tick_at || '',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `hfcd-${activeDesk}-ledger-id-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(href);
    setMessage(`已导出当前浏览器账本 ID：${payload.online_ledger_user_id_suffix}`);
  }, [activeDesk, apiPrefix, dashboard, userId]);

  useEffect(() => {
    let cancelled = false;
    setDashboard(null);
    setLoading(true);
    fetch(`${apiPrefix}/dashboard?user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' })
      .then((res) => res.json() as Promise<Dashboard>)
      .then((data) => {
        if (!cancelled) setDashboard(data);
      })
      .catch(() => {
        if (!cancelled) setMessage('读取线上交易引擎失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiPrefix, userId]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (dashboard?.summary?.mode === 'running') {
        await postAction(`${apiPrefix}/tick`);
      } else {
        await loadDashboard().catch(() => undefined);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [apiPrefix, dashboard?.summary?.mode, loadDashboard, postAction]);

  const trades = dashboard?.recent_trades || [];
  const decisions = dashboard?.decisions || [];
  const risk = dashboard?.risk_optimization;
  const diag = dashboard?.win_rate_diagnostics;
  const ledgerUserId = dashboard?.ledger?.user_id || dashboard?.account?.user_id || (activeDesk === 'commodity' ? `commodity_${userId}`.slice(0, 80) : userId);
  const ledgerSuffix = dashboard?.ledger?.user_id_suffix || ledgerUserId.slice(-10);
  const ledgerSource = dashboard?.ledger?.source || (dashboard?.online_backend ? 'longone_worker_d1' : 'worker_default_no_d1');
  const ledgerUpdatedAt = dashboard?.ledger?.account_last_tick_at || dashboard?.ledger?.dashboard_updated_at || dashboard?.updated_at || '-';

  return (
    <div className="min-h-full bg-[#0b1512] px-5 py-6 pb-14 text-slate-100">
      <div className="rounded-[28px] border border-emerald-200/15 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.18),transparent_32rem),linear-gradient(180deg,#10211c_0%,#0b1512_100%)] p-6">
        <h1 className="text-3xl font-black tracking-tight text-white">{desk.title}</h1>
        <p className="mt-2 max-w-5xl text-sm leading-6 text-emerald-50/62">{desk.subtitle}</p>
      </div>

      <section className="mt-5 grid gap-3 md:grid-cols-2">
        {(['power', 'commodity'] as const).map((key) => (
          <button
            key={key}
            onClick={() => {
              if (key !== activeDesk) {
                setDashboard(null);
                setLoading(true);
              }
              setActiveDesk(key);
              setMessage('');
            }}
            className={`rounded-[24px] border px-5 py-4 text-left transition ${
              activeDesk === key
                ? 'border-emerald-200/35 bg-emerald-300/16 shadow-[0_0_0_1px_rgba(167,243,208,0.15)]'
                : 'border-emerald-200/10 bg-white/[0.03] hover:bg-white/[0.06]'
            }`}
          >
            <p className="text-base font-black text-white">{deskCopy[key].label}</p>
            <p className="mt-1 text-sm text-emerald-50/58">{deskCopy[key].subtitle}</p>
          </button>
        ))}
      </section>

      <section className="mt-5 rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
        <h2 className="text-xl font-black text-white">{copy.model}</h2>
        <p className="mt-2 text-sm leading-6 text-emerald-50/62">{desk.description}</p>
        <p className="mt-2 text-xs text-amber-200/80">{desk.note}</p>
      </section>

      <section className="mt-5 rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
        <div className="grid gap-3 md:grid-cols-5">
          {(activeDesk === 'commodity'
            ? [
                ['capital_usd', copy.capital],
                ['fixed_trade_usd', copy.fixedTrade],
                ['max_open_positions', copy.maxPositions],
                ['max_symbol_positions', '单品最大持仓'],
                ['stop_loss_pct', '止损比例'],
                ['take_profit_pct', '止盈比例'],
                ['min_signal_score', '最低稳定分'],
              ]
            : [
                ['capital_usd', copy.capital],
                ['fixed_trade_usd', copy.fixedTrade],
                ['max_open_positions', copy.maxPositions],
                ['stop_loss_usd', copy.stopLoss],
                ['take_profit_usd', copy.takeProfit],
              ]).map(([key, label]) => (
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
          <button disabled={loading || dashboard?.summary?.mode === 'running'} onClick={() => postAction(`${apiPrefix}/start`, config)} className="rounded-2xl bg-emerald-300 px-5 py-3 text-sm font-black text-emerald-950 disabled:opacity-45">
            {copy.start}
          </button>
          <button disabled={loading} onClick={() => postAction(`${apiPrefix}/tick`)} className="rounded-2xl border border-emerald-200/15 bg-emerald-300/12 px-5 py-3 text-sm font-black text-emerald-100">
            {copy.tick}
          </button>
          <button disabled={loading} onClick={() => postAction(`${apiPrefix}/stop`, { liquidate: true })} className="rounded-2xl border border-red-300/30 bg-red-400/18 px-5 py-3 text-sm font-black text-red-100">
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
          <button onClick={exportLedgerId} className="rounded-2xl border border-emerald-200/15 bg-white/[0.05] px-5 py-3 text-sm font-black text-emerald-100">
            {copy.exportLedgerId}
          </button>
          {activeDesk === 'commodity' ? (
            <button disabled={loading} onClick={resetCommodityLedger} className="rounded-2xl border border-amber-200/30 bg-amber-300/14 px-5 py-3 text-sm font-black text-amber-100">
              {copy.reset}
            </button>
          ) : null}
        </div>
        {message ? <div className="mt-4 rounded-2xl border border-emerald-200/15 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">{message}</div> : null}
      </section>

      <section className="mt-5 grid gap-4 md:grid-cols-5">
        {[
          [copy.status, dashboard?.summary?.mode || 'loading'],
          [copy.equity, moneyOrDash(dashboard?.summary?.settled_equity_usd ?? dashboard?.summary?.cash_usd)],
          [copy.pnl, moneyOrDash(dashboard?.summary?.realized_pnl_usd)],
          [copy.unrealizedPnl, moneyOrDash(dashboard?.summary?.unrealized_pnl_usd)],
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
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-emerald-200/10 bg-black/20 px-4 py-3">
            <p className="text-xs font-black text-emerald-50/45">账本来源</p>
            <p className="mt-1 break-all text-sm font-bold text-emerald-100">{ledgerSource}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200/10 bg-black/20 px-4 py-3">
            <p className="text-xs font-black text-emerald-50/45">线上账本 ID 后缀</p>
            <p className="mt-1 break-all text-sm font-bold text-emerald-100">{ledgerSuffix}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200/10 bg-black/20 px-4 py-3">
            <p className="text-xs font-black text-emerald-50/45">账本更新时间</p>
            <p className="mt-1 break-all text-sm font-bold text-emerald-100">{ledgerUpdatedAt}</p>
          </div>
        </div>
        {activeDesk === 'commodity' ? (
          <p className="mt-3 text-xs leading-5 text-amber-200/75">
            当前页面显示的是 longone 线上 Worker/D1 账本；本地 heartbeat 的 outputs/ 文件账本不会自动等同于这个浏览器用户账本。
          </p>
        ) : null}
        {activeDesk === 'commodity' && dashboard?.routes?.length ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {dashboard.routes.map((route) => (
              <div key={String(route.lineage_id)} className="rounded-2xl border border-emerald-200/10 bg-black/20 p-4">
                <p className="text-sm font-black text-white">{String(route.symbol)} · {String(route.cadence)} · {String(route.source_version)}</p>
                <p className="mt-1 text-xs text-emerald-50/58">
                  盲测命中 {(Number(route.blind_hit_rate || 0) * 100).toFixed(1)}% · PF {Number(route.blind_profit_factor || 0).toFixed(2)} · 动作/天 {Number(route.actions_per_day || 0).toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="mt-5 rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-white">止盈/止损优化与胜率归因</h2>
            <p className="mt-2 text-sm leading-6 text-emerald-50/60">
              系统会记录开仓、跳过、逐轮浮盈路径和平仓结果；有足够样本后，用真实结算路径扫描每笔交易金额对应的最佳止损/止盈。
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-200/12 bg-black/20 px-4 py-3 text-xs text-emerald-50/70">
            样本：{risk?.sample_count ?? 0} · 路径质量：{risk?.path_quality || '-'}
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-emerald-200/10 bg-black/25 p-4">
            <p className="text-xs font-bold text-emerald-50/45">推荐单笔止损</p>
            <p className="mt-2 text-2xl font-black text-white">{money(risk?.recommended?.stop_loss_usd)}</p>
            <p className="mt-1 text-xs text-emerald-50/50">约 {pct(risk?.recommended?.stop_loss_pct)} / 单次金额</p>
          </div>
          <div className="rounded-2xl border border-emerald-200/10 bg-black/25 p-4">
            <p className="text-xs font-bold text-emerald-50/45">推荐单笔止盈</p>
            <p className="mt-2 text-2xl font-black text-white">{money(risk?.recommended?.take_profit_usd)}</p>
            <p className="mt-1 text-xs text-emerald-50/50">约 {pct(risk?.recommended?.take_profit_pct)} / 单次金额</p>
          </div>
          <div className="rounded-2xl border border-emerald-200/10 bg-black/25 p-4">
            <p className="text-xs font-bold text-emerald-50/45">扫描后模拟净收益</p>
            <p className={`mt-2 text-2xl font-black ${(risk?.recommended?.simulated_net_pnl_usd || 0) < 0 ? 'text-red-300' : 'text-emerald-200'}`}>
              {money(risk?.recommended?.simulated_net_pnl_usd)}
            </p>
            <p className="mt-1 text-xs text-emerald-50/50">Profit factor {num(risk?.recommended?.profit_factor, 2)}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200/10 bg-black/25 p-4">
            <p className="text-xs font-bold text-emerald-50/45">当前真实胜率 / 盈亏比</p>
            <p className="mt-2 text-2xl font-black text-white">{pct(diag?.win_rate)} / {num(diag?.payoff_ratio, 2)}</p>
            <p className="mt-1 text-xs text-emerald-50/50">胜 {diag?.wins || 0} · 负 {diag?.losses || 0}</p>
          </div>
        </div>
        {risk?.message ? <p className="mt-3 text-sm text-amber-200/80">{risk.message}</p> : null}
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="rounded-2xl border border-emerald-200/10 bg-black/20 p-4">
            <h3 className="text-sm font-black text-white">低胜率可能原因</h3>
            <div className="mt-3 space-y-2 text-sm text-emerald-50/68">
              {(diag?.causes || ['暂无足够样本。']).map((item, index) => <p key={`${item}-${index}`}>· {item}</p>)}
            </div>
          </div>
          <div className="rounded-2xl border border-emerald-200/10 bg-black/20 p-4">
            <h3 className="text-sm font-black text-white">自动优化动作</h3>
            <div className="mt-3 space-y-2 text-sm text-emerald-50/68">
              {(diag?.recommendations || ['继续记录真实模拟交易路径。']).map((item, index) => <p key={`${item}-${index}`}>· {item}</p>)}
              <p>· 若某个信号周期+方向的历史期望转负，后端会自动拦截该类新开仓。</p>
            </div>
          </div>
        </div>
        {(risk?.top_candidates || []).length ? (
          <div className="mt-4 overflow-auto rounded-2xl border border-emerald-200/10 bg-black/20">
            <table className="min-w-[760px] w-full text-left text-xs">
              <thead className="text-emerald-50/45">
                <tr>
                  {['止损', '止盈', '模拟净收益', '模拟胜率', 'Profit factor', '最大回撤'].map((head) => (
                    <th key={head} className="border-b border-emerald-200/10 px-3 py-2 font-black">{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(risk?.top_candidates || []).slice(0, 5).map((row, index) => (
                  <tr key={`${row.stop_loss_usd}-${row.take_profit_usd}-${index}`} className="border-b border-emerald-200/8">
                    <td className="px-3 py-2">{money(row.stop_loss_usd)} ({pct(row.stop_loss_pct)})</td>
                    <td className="px-3 py-2">{money(row.take_profit_usd)} ({pct(row.take_profit_pct)})</td>
                    <td className="px-3 py-2">{money(row.simulated_net_pnl_usd)}</td>
                    <td className="px-3 py-2">{pct(row.simulated_win_rate)}</td>
                    <td className="px-3 py-2">{num(row.profit_factor, 2)}</td>
                    <td className="px-3 py-2">{money(row.max_drawdown_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.6fr]">
        <div className="rounded-[28px] border border-emerald-200/12 bg-white/[0.03] p-5">
          <h2 className="text-xl font-black text-white">{copy.latestSignals}</h2>
          <div className="mt-4 space-y-3">
            {decisions.map((row) => (
              <div key={`${row.horizon}-${row.captured_at}`} className="rounded-2xl border border-emerald-200/10 bg-black/25 p-4">
                <p className="text-xs font-black text-emerald-200/70">{row.horizon || row.cadence} · {row.signal_source || `${row.source_version || ''} ${row.lineage_id || ''}`}</p>
                <p className="mt-2 text-sm text-emerald-50/65">
                  {row.node || row.name || row.symbol} · {text(row.paper_action || row.action)} ·
                  {activeDesk === 'commodity'
                    ? ` 价格: ${num(row.price, row.symbol === 'HO=F' ? 4 : 2)} · 分数: ${num(row.score, 3)} · ${row.side || '-'}`
                    : ` ${copy.spread}: ${num(row.visible_spread)} · ${copy.mwh}: ${num(row.model_prediction_mw, 1)} · ${row.tier}`}
                </p>
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
                  {[copy.time, copy.event, '标的', copy.horizon, copy.source, copy.node, copy.action, copy.loop, activeDesk === 'commodity' ? '价格' : copy.spread, activeDesk === 'commodity' ? '数量' : copy.mwh, copy.entryAmount, copy.exitAmount, copy.netPnl, '盈亏%', '风险参数', copy.reason].map((head) => (
                    <th key={head} className="border-b border-emerald-200/10 px-3 py-3 font-black">{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((row, index) => (
                  <tr key={`${row.ts}-${index}`} className="border-b border-emerald-200/8 text-emerald-50/86">
                    <td className="px-3 py-3">{row.ts ? new Date(row.ts).toLocaleString() : '-'}</td>
                    <td className="px-3 py-3"><span className="rounded-full bg-emerald-300/12 px-3 py-1 text-xs font-black text-emerald-200">{text(row.event)}</span></td>
                    <td className="px-3 py-3">{row.symbol || '-'}</td>
                    <td className="px-3 py-3">{row.horizon || '-'}</td>
                    <td className="px-3 py-3">{row.signal_source || '-'}</td>
                    <td className="px-3 py-3">{row.node || '-'}</td>
                    <td className="px-3 py-3">{text(row.exit_action || row.entry_action || row.action)}{row.side ? ` / ${row.side}` : ''}</td>
                    <td className="px-3 py-3">{row.roundtrip_code || '-'}</td>
                    <td className="px-3 py-3">{num(row.price_spread ?? row.entry_price ?? row.exit_price ?? row.entry_spread ?? row.exit_spread, row.symbol === 'HO=F' ? 4 : 2)}</td>
                    <td className="px-3 py-3">{num(row.quantity ?? row.mwh, activeDesk === 'commodity' ? 6 : 2)}</td>
                    <td className="px-3 py-3">{money(row.entry_trade_value_usd)}</td>
                    <td className="px-3 py-3">{money(row.exit_trade_value_usd)}</td>
                    <td className={`px-3 py-3 font-black ${(row.net_pnl_usd || 0) < 0 ? 'text-red-300' : 'text-emerald-200'}`}>{money(row.net_pnl_usd)}</td>
                    <td className="px-3 py-3">{pct(row.pnl_pct_of_trade)}</td>
                    <td className="px-3 py-3">止损 {money(row.stop_loss_usd)} / 止盈 {money(row.take_profit_usd)}{row.risk_source ? ` · ${row.risk_source}` : ''}</td>
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
