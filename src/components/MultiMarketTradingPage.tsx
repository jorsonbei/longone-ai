import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '../lib/locale';

type Props = {
  locale: Locale;
  canUseExchangeExecution?: boolean;
};

const COPY: Record<string, Record<string, string>> = {
  zh: {
    eyebrow: 'HFCD 多市场交易',
    title: '加密货币 / ETF / 股票 AI 线上模拟交易',
    subtitle: '加密货币、ETF、股票分区运行线上模拟账本。BTC/SOL/DOGE 可走 Binance Demo Testnet；SPY/QQQ/IWM 和股票扩展池只写 longone 线上模拟账本。',
    cryptoPanel: '加密货币 / ETF 线上模拟账本',
    cryptoHint: 'BTCUSDT/SOLUSDT/DOGEUSDT 使用 Binance U本位合约公开实时数据；DOGEUSDT 接入 V3.32 1h 前向模拟路线并记录 aggTrade/L2/Bσ 覆盖；SPY/QQQ/IWM 使用 Yahoo 公共行情。单笔金额是上限，实际仓位会按信号强度、点差、波动和剩余持仓预算自适应计算。',
    stockPanel: '股票 AI 线上模拟交易',
    stockHint: '当前股票分区接入 V1.7 扩展股票池：MSFT/AAPL/CRM/AMD/MU 做多，TSLA/AMZN 做空；读取股票、SPY、QQQ、XLK、SOXX、VIX 公开行情，只写 longone 线上模拟账本，不向券商下单。',
    stockStart: '启动股票线上模拟',
    stockTick: '运行股票一轮',
    stockStop: '停止股票并清仓',
    stockSignals: '股票前向信号',
    stockPositions: '股票当前持仓',
    stockHistory: '股票模拟记录',
    stockScheduler: '股票自动记录',
    stockCopyLedgerId: '复制股票账本 ID',
    stockExportLedgerId: '导出股票账本 JSON',
    stockResetLedger: '重置股票账本',
    maxSymbolPositions: '单币最大持仓',
    adaptiveSizing: '自适应仓位',
    maxPositionPct: '单次权益上限',
    sidePolicy: '多空策略',
    orderExecution: '执行模式',
    paperMode: '本地模拟账本',
    binanceTestnetMode: 'Binance Testnet 下单',
    privateLocked: '管理员私有控制',
    testnetLockedHint: '未填写 Binance Demo API 时只能使用本地模拟账本；填写后可向 demo.binance.com 的 U本位合约测试网下单。',
    testnetApiSetup: 'Binance Demo API',
    testnetApiKey: 'API Key',
    testnetApiSecret: 'Secret Key',
    testnetSaveKeys: '保存到本机浏览器',
    testnetClearKeys: '清除本机密钥',
    testnetKeyHint: '密钥只保存在你当前电脑的当前浏览器 localStorage；刷新页面仍在，但不会上传或保存到 longone 后端、D1 或 Git。只用于本浏览器签名 demo-fapi.binance.com 请求。',
    testnetReady: '已填写 Demo API，可启用 Binance Testnet 下单。订单会出现在 demo.binance.com 的 Futures Order，不是 Spot Order。',
    testnetMissing: '未填写 Demo API，当前只能 paper 模拟。',
    both: '做多 + 做空',
    longOnly: '只做多',
    shortOnly: '只做空',
    cryptoStart: '启动线上模拟交易',
    cryptoTick: '运行一轮线上模拟',
    cryptoStop: '停止并清仓',
    reconcile: '仓位对账',
    closeAll: 'Testnet 全部平仓',
    cryptoHealth: '模拟安全状态',
    testnetAccount: 'Testnet 账户',
    testnetPositions: 'Testnet 持仓',
    testnetOrders: 'Testnet 挂单',
    ledgerBox: '账本来源 / 用户账本',
    browserLedgerId: '浏览器账本 ID',
    backendLedgerId: '后端 D1 账本',
    ledgerSource: '账本来源',
    copyLedgerId: '复制账本 ID',
    exportLedgerId: '导出账本 JSON',
    ledgerExplain: '当前前向持仓来自 longone D1 paper/testnet mirror；不是 Binance Demo Futures 当前持仓。Demo 实际持仓请看上方 Testnet 持仓表。',
    sensors: '黑暗森林传感器',
    capital: '起始资金',
    fixedTrade: '单笔最高金额',
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
    title: 'AI Online Paper Trading for Crypto, ETFs, and Stocks',
    subtitle: 'Crypto, ETF, and stock routes run in separated online paper ledgers. BTC/SOL/DOGE can use Binance Demo Testnet; SPY/QQQ/IWM and the expanded stock pool stay on the longone paper ledger.',
    cryptoPanel: 'Crypto / ETF Online Paper Ledger',
    cryptoHint: 'BTCUSDT/SOLUSDT/DOGEUSDT use Binance USD-M futures public realtime data. DOGEUSDT runs the V3.32 1h online paper route and records aggTrade/L2/B-sigma coverage. SPY/QQQ/IWM use Yahoo public charts. Trade amount is a cap; actual sizing adapts to score, spread, volatility, and remaining risk budget.',
    stockPanel: 'Stock AI Online Paper Trading',
    stockHint: 'The stock section now runs the V1.7 expanded pool: MSFT/AAPL/CRM/AMD/MU long and TSLA/AMZN short with stock, SPY, QQQ, XLK, SOXX, and VIX public data. It writes only to the longone online paper ledger.',
    stockStart: 'Start Stock Paper Trading',
    stockTick: 'Run One Stock Tick',
    stockStop: 'Stop Stock and Liquidate',
    stockSignals: 'Stock Forward Signal',
    stockPositions: 'Stock Open Positions',
    stockHistory: 'Stock Paper Records',
    stockScheduler: 'Stock auto recorder',
    stockCopyLedgerId: 'Copy Stock Ledger ID',
    stockExportLedgerId: 'Export Stock Ledger JSON',
    stockResetLedger: 'Reset Stock Ledger',
    maxSymbolPositions: 'Max per symbol',
    adaptiveSizing: 'Adaptive sizing',
    maxPositionPct: 'Equity cap / trade',
    sidePolicy: 'Side policy',
    orderExecution: 'Execution mode',
    paperMode: 'Local paper ledger',
    binanceTestnetMode: 'Binance Testnet orders',
    privateLocked: 'Admin private control',
    testnetLockedHint: 'Without Binance Demo API keys, only local paper ledger is available. With keys, orders are sent to the USD-M futures demo testnet.',
    testnetApiSetup: 'Binance Demo API',
    testnetApiKey: 'API Key',
    testnetApiSecret: 'Secret Key',
    testnetSaveKeys: 'Save in this browser',
    testnetClearKeys: 'Clear local keys',
    testnetKeyHint: 'Keys stay only in localStorage on this computer and browser. They survive refreshes but are not uploaded or stored on the longone backend, D1, or Git. They are used only by this browser to sign demo-fapi.binance.com requests.',
    testnetReady: 'Demo API keys are present. Binance Testnet orders can be enabled. Orders appear under demo.binance.com Futures Order, not Spot Order.',
    testnetMissing: 'No Demo API keys. Paper ledger only.',
    both: 'Long + Short',
    longOnly: 'Long only',
    shortOnly: 'Short only',
    cryptoStart: 'Start Online Paper Trading',
    cryptoTick: 'Run One Paper Tick',
    cryptoStop: 'Stop and Liquidate',
    reconcile: 'Reconcile',
    closeAll: 'Testnet Close All',
    cryptoHealth: 'Simulation safety',
    testnetAccount: 'Testnet Account',
    testnetPositions: 'Testnet Positions',
    testnetOrders: 'Testnet Orders',
    ledgerBox: 'Ledger source / user ledger',
    browserLedgerId: 'Browser ledger ID',
    backendLedgerId: 'Backend D1 ledger',
    ledgerSource: 'Ledger source',
    copyLedgerId: 'Copy ledger ID',
    exportLedgerId: 'Export ledger JSON',
    ledgerExplain: 'Open forward positions come from the longone D1 paper/testnet mirror, not Binance Demo Futures positions. See the Testnet Positions table above for actual Demo positions.',
    sensors: 'DarkForest sensors',
    capital: 'Capital',
    fixedTrade: 'Max trade amount',
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
  SIGNAL: '信号',
  OPEN: '开仓',
  CLOSE: '平仓',
  ADD: '加仓',
  REDUCE: '减仓',
  REVERSE: '反手',
  HOLD: '持有',
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
  单币种持仓数已满: '单币种持仓数已满',
  本轮信号已处理: '本轮信号已处理',
  '行情源为回退模拟，暂不交易': '行情源为回退模拟，暂不交易',
  自适应仓位预算不足: '自适应仓位预算不足',
  '同向信号存在，继续持有，不重复开仓': '同向信号存在，继续持有，不重复开仓',
  '同向信号增强，按能源模型式仓位控制加仓': '同向信号增强，按能源模型式仓位控制加仓',
  '反向信号确认，平仓准备反手': '反向信号确认，平仓准备反手',
  '同标的信号弱化且持仓浮亏，减仓保护': '同标的信号弱化且持仓浮亏，减仓保护',
  '用户风险上限收缩，超额持仓自动平仓': '用户风险上限收缩，超额持仓自动平仓',
  '股票事件/开收盘/VIX 风险过高，跳过本轮信号': '股票事件/开收盘/VIX 风险过高，跳过本轮信号',
  'Stock V1.7 股票扩展池线上模拟交易按真实行情达标开仓，不发送券商订单': 'Stock V1.7 股票扩展池线上模拟交易按真实行情达标开仓，不发送券商订单',
  '线上模拟路线实时信号未达门槛': '线上模拟路线实时信号未达门槛',
  '信号未达线上模拟交易标准': '信号未达线上模拟交易标准',
  'ETF 通过路线只写线上模拟账本，不发送交易所订单': 'ETF 通过路线只写线上模拟账本，不发送交易所订单',
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

export default function MultiMarketTradingPage({ locale, canUseExchangeExecution = false }: Props) {
  const copy = COPY[locale] || COPY.zh;
  const [cryptoDashboard, setCryptoDashboard] = useState<any | null>(null);
  const [stockDashboard, setStockDashboard] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [stockLoading, setStockLoading] = useState(false);
  const [cryptoAction, setCryptoAction] = useState('');
  const [stockAction, setStockAction] = useState('');
  const [message, setMessage] = useState('');
  const userEditedCryptoConfig = useRef(false);
  const userEditedStockConfig = useRef(false);
  const [cryptoConfigDirty, setCryptoConfigDirty] = useState(false);
  const [stockConfigDirty, setStockConfigDirty] = useState(false);
  const [cryptoConfig, setCryptoConfig] = useState({
    capital_usd: 100_000,
    fixed_trade_usd: 1_000,
    adaptive_sizing: true,
    max_position_pct: 0.04,
    max_open_positions: 4,
    max_symbol_positions: 1,
    stop_loss_pct: 0.018,
    take_profit_pct: 0.036,
    min_signal_score: 0.66,
    max_holding_minutes: 480,
    side_policy: 'both',
    order_execution: 'paper',
    testnet_close_all_on_stop: true,
  });
  const [stockConfig, setStockConfig] = useState({
    capital_usd: 50_000,
    fixed_trade_usd: 1_000,
    adaptive_sizing: true,
    max_position_pct: 0.04,
    max_open_positions: 3,
    max_symbol_positions: 1,
    stop_loss_pct: 0.018,
    take_profit_pct: 0.036,
    min_signal_score: 0.60,
    max_holding_minutes: 120,
    side_policy: 'both',
    order_execution: 'paper',
    asset_scope: 'stock',
    allow_short: true,
    allow_reverse: true,
    testnet_close_all_on_stop: false,
  });
  const [binanceKeys, setBinanceKeys] = useState({ apiKey: '', apiSecret: '' });
  const hasUserTestnetKeys = Boolean(binanceKeys.apiKey.trim() && binanceKeys.apiSecret.trim());
  const canRequestExchangeExecution = canUseExchangeExecution || hasUserTestnetKeys;

  const cryptoUserId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_crypto_testnet_user_id') : '';
    if (stored) return stored;
    const id = `crypto_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_crypto_testnet_user_id', id);
    return id;
  }, []);

  const stockUserId = useMemo(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('hfcd_stock_paper_user_id') : '';
    if (stored) return stored;
    const id = `stock_user_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem('hfcd_stock_paper_user_id', id);
    return id;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setBinanceKeys({
      apiKey: window.localStorage.getItem('hfcd_binance_demo_api_key') || '',
      apiSecret: window.localStorage.getItem('hfcd_binance_demo_api_secret') || '',
    });
  }, []);

  const exchangeHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (hasUserTestnetKeys) {
      headers['x-binance-testnet-api-key'] = binanceKeys.apiKey.trim();
      headers['x-binance-testnet-api-secret'] = binanceKeys.apiSecret.trim();
    }
    if (!canUseExchangeExecution || typeof window === 'undefined') return headers;
    try {
      const raw = window.localStorage.getItem('hfcdApiKeysV1');
      const keys = raw ? JSON.parse(raw) : [];
      const key = Array.isArray(keys) ? keys[0]?.key : '';
      if (key) headers['x-api-key'] = String(key);
    } catch {
      return headers;
    }
    return headers;
  }, [binanceKeys.apiKey, binanceKeys.apiSecret, canUseExchangeExecution, hasUserTestnetKeys]);

  const loadCryptoDashboard = useCallback(async (headersOverride?: Record<string, string>) => {
    const res = await fetch(`/api/crypto-testnet/dashboard?user_id=${encodeURIComponent(cryptoUserId)}&asset_scope=non_stock`, {
      cache: 'no-store',
      headers: headersOverride ?? exchangeHeaders,
    });
    const data = await res.json();
    setCryptoDashboard(data);
    const remoteConfig = data?.summary?.config;
    if (remoteConfig && typeof remoteConfig === 'object' && !userEditedCryptoConfig.current) {
      setCryptoConfig((prev) => ({
        ...prev,
        capital_usd: Number(remoteConfig.capital_usd || data?.summary?.initial_cash_usd || prev.capital_usd),
        fixed_trade_usd: Number(remoteConfig.fixed_trade_usd || prev.fixed_trade_usd),
        adaptive_sizing: remoteConfig.adaptive_sizing !== false,
        max_position_pct: Number(remoteConfig.max_position_pct || prev.max_position_pct),
        max_open_positions: Number(remoteConfig.max_open_positions || prev.max_open_positions),
        max_symbol_positions: Number(remoteConfig.max_symbol_positions || prev.max_symbol_positions),
        stop_loss_pct: Number(remoteConfig.stop_loss_pct || prev.stop_loss_pct),
        take_profit_pct: Number(remoteConfig.take_profit_pct || prev.take_profit_pct),
        min_signal_score: Number(remoteConfig.min_signal_score || prev.min_signal_score),
        max_holding_minutes: Number(remoteConfig.max_holding_minutes || prev.max_holding_minutes),
        side_policy: String(remoteConfig.side_policy || prev.side_policy),
        order_execution: String(remoteConfig.order_execution || prev.order_execution),
        testnet_close_all_on_stop: remoteConfig.testnet_close_all_on_stop !== false,
      }));
      setCryptoConfigDirty(false);
    }
  }, [cryptoUserId, exchangeHeaders]);

  const loadStockDashboard = useCallback(async () => {
    const res = await fetch(`/api/crypto-testnet/dashboard?user_id=${encodeURIComponent(stockUserId)}&asset_scope=stock`, {
      cache: 'no-store',
    });
    const data = await res.json();
    setStockDashboard(data);
    const remoteConfig = data?.summary?.config;
    if (remoteConfig && typeof remoteConfig === 'object' && !userEditedStockConfig.current) {
      setStockConfig((prev) => ({
        ...prev,
        capital_usd: Number(remoteConfig.capital_usd || data?.summary?.initial_cash_usd || prev.capital_usd),
        fixed_trade_usd: Number(remoteConfig.fixed_trade_usd || prev.fixed_trade_usd),
        adaptive_sizing: remoteConfig.adaptive_sizing !== false,
        max_position_pct: Number(remoteConfig.max_position_pct || prev.max_position_pct),
        max_open_positions: Number(remoteConfig.max_open_positions || prev.max_open_positions),
        max_symbol_positions: Number(remoteConfig.max_symbol_positions || prev.max_symbol_positions),
        stop_loss_pct: Number(remoteConfig.stop_loss_pct || prev.stop_loss_pct),
        take_profit_pct: Number(remoteConfig.take_profit_pct || prev.take_profit_pct),
        min_signal_score: Number(remoteConfig.min_signal_score || prev.min_signal_score),
        max_holding_minutes: Number(remoteConfig.max_holding_minutes || prev.max_holding_minutes),
        side_policy: String(remoteConfig.side_policy || 'both'),
        order_execution: 'paper',
        asset_scope: 'stock',
        allow_short: remoteConfig.allow_short !== false,
        allow_reverse: remoteConfig.allow_reverse !== false,
        testnet_close_all_on_stop: false,
      }));
      setStockConfigDirty(false);
    }
  }, [stockUserId]);

  const saveBinanceKeys = useCallback(async () => {
    if (typeof window === 'undefined') return;
    setLoading(true);
    try {
      window.localStorage.setItem('hfcd_binance_demo_api_key', binanceKeys.apiKey.trim());
      window.localStorage.setItem('hfcd_binance_demo_api_secret', binanceKeys.apiSecret.trim());
      setMessage('Binance Demo API 已保存到本机浏览器，正在刷新 Testnet 账户状态。');
      await loadCryptoDashboard();
      setMessage('Binance Demo API 已保存，本机 Testnet 账户状态已刷新。');
    } catch (error) {
      setMessage(error instanceof Error ? `Demo API 已保存，但刷新账户失败：${error.message}` : 'Demo API 已保存，但刷新账户失败。');
    } finally {
      setLoading(false);
    }
  }, [binanceKeys.apiKey, binanceKeys.apiSecret, loadCryptoDashboard]);

  const clearBinanceKeys = useCallback(async () => {
    if (typeof window === 'undefined') return;
    setLoading(true);
    try {
      window.localStorage.removeItem('hfcd_binance_demo_api_key');
      window.localStorage.removeItem('hfcd_binance_demo_api_secret');
      setBinanceKeys({ apiKey: '', apiSecret: '' });
      setCryptoConfig((prev) => ({ ...prev, order_execution: 'paper', testnet_close_all_on_stop: false }));
      await loadCryptoDashboard({});
      setMessage('已清除本机 Binance Demo API，并切回本地模拟账本。');
    } catch (error) {
      setMessage(error instanceof Error ? `已清除本机密钥，但刷新账户失败：${error.message}` : '已清除本机密钥，但刷新账户失败。');
    } finally {
      setLoading(false);
    }
  }, [loadCryptoDashboard]);

  const parseActionResponse = useCallback(async (res: Response) => {
    const text = await res.text();
    try {
      const data = text ? JSON.parse(text) as { ok?: boolean; error?: string; message?: string } : {};
      if (!data.ok) throw new Error(data.error || data.message || `request failed (${res.status})`);
      return data;
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith('Unexpected token')) throw error;
      const preview = text.replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(preview || `request failed (${res.status})`);
    }
  }, []);

  const postCryptoAction = useCallback(async (
    path: string,
    body: Record<string, unknown> = {},
    options: { actionKey?: string; label?: string; clearDirty?: boolean; silent?: boolean } = {},
  ) => {
    const label = options.label || '线上模拟交易操作';
    if (!options.silent) {
      setLoading(true);
      setCryptoAction(options.actionKey || label);
      setMessage(`${label}中...`);
    }
    try {
      const hasOrderExecution = Object.prototype.hasOwnProperty.call(body, 'order_execution');
      if (hasOrderExecution && body.order_execution === 'binance_testnet' && !canRequestExchangeExecution) {
        throw new Error(copy.testnetLockedHint);
      }
      const safeBody: Record<string, unknown> = {
        ...body,
        asset_scope: body.asset_scope || 'non_stock',
      };
      if (hasOrderExecution || path.endsWith('/start') || path.endsWith('/config')) {
        safeBody.order_execution = canRequestExchangeExecution ? (body.order_execution || 'paper') : 'paper';
        safeBody.testnet_close_all_on_stop = canRequestExchangeExecution ? body.testnet_close_all_on_stop !== false : false;
      }
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...exchangeHeaders },
        body: JSON.stringify({ user_id: cryptoUserId, ...safeBody }),
      });
      await parseActionResponse(res);
      if (!options.silent) setMessage(options.clearDirty ? `${label}已生效，运行中的下一轮会使用新参数。` : `${label}已完成。`);
      if (options.clearDirty || path.endsWith('/start')) {
        userEditedCryptoConfig.current = false;
        setCryptoConfigDirty(false);
      }
      await loadCryptoDashboard();
    } catch (error) {
      if (!options.silent) setMessage(error instanceof Error ? error.message : `${label}失败。`);
    } finally {
      if (!options.silent) {
        setLoading(false);
        setCryptoAction('');
      }
    }
  }, [canRequestExchangeExecution, copy.testnetLockedHint, cryptoUserId, exchangeHeaders, loadCryptoDashboard, parseActionResponse]);

  const postStockAction = useCallback(async (
    path: string,
    body: Record<string, unknown> = {},
    options: { actionKey?: string; label?: string; clearDirty?: boolean; silent?: boolean } = {},
  ) => {
    const label = options.label || '股票线上模拟交易操作';
    if (!options.silent) {
      setStockLoading(true);
      setStockAction(options.actionKey || label);
      setMessage(`${label}中...`);
    }
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: stockUserId,
          ...body,
          asset_scope: 'stock',
          side_policy: String((body as any)?.side_policy || stockConfig.side_policy || 'both'),
          order_execution: 'paper',
          allow_short: (body as any)?.allow_short !== undefined ? (body as any).allow_short !== false : stockConfig.allow_short !== false,
          allow_reverse: (body as any)?.allow_reverse !== undefined ? (body as any).allow_reverse !== false : stockConfig.allow_reverse !== false,
          testnet_close_all_on_stop: false,
        }),
      });
      await parseActionResponse(res);
      if (!options.silent) setMessage(options.clearDirty ? `${label}已生效，股票运行中的下一轮会使用新参数。` : `${label}已完成。`);
      if (options.clearDirty || path.endsWith('/start')) {
        userEditedStockConfig.current = false;
        setStockConfigDirty(false);
      }
      await loadStockDashboard();
    } catch (error) {
      if (!options.silent) setMessage(error instanceof Error ? error.message : `${label}失败。`);
    } finally {
      if (!options.silent) {
        setStockLoading(false);
        setStockAction('');
      }
    }
  }, [loadStockDashboard, parseActionResponse, stockConfig.allow_reverse, stockConfig.allow_short, stockConfig.side_policy, stockUserId]);

  useEffect(() => {
    loadCryptoDashboard().catch(() => setMessage('读取线上模拟交易账本失败。'));
    loadStockDashboard().catch(() => setMessage('读取股票线上模拟交易账本失败。'));
  }, [loadCryptoDashboard, loadStockDashboard]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (cryptoDashboard?.summary?.mode === 'running') {
        await postCryptoAction('/api/crypto-testnet/tick', { asset_scope: 'non_stock' }, { silent: true });
      } else {
        await loadCryptoDashboard().catch(() => undefined);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [cryptoDashboard?.summary?.mode, loadCryptoDashboard, postCryptoAction]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (stockDashboard?.summary?.mode === 'running') {
        await postStockAction('/api/crypto-testnet/tick', { asset_scope: 'stock' }, { silent: true });
      } else {
        await loadStockDashboard().catch(() => undefined);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadStockDashboard, postStockAction, stockDashboard?.summary?.mode]);

  const cryptoSummary = cryptoDashboard?.summary;
  const cryptoSignals = cryptoDashboard?.signals || [];
  const cryptoTrades = cryptoDashboard?.recent_trades || [];
  const cryptoPositions = cryptoDashboard?.positions || [];
  const cryptoSensors = cryptoDashboard?.sensors || [];
  const selectedRoutes = cryptoDashboard?.market_health?.selected_routes || [];
  const stockSummary = stockDashboard?.summary;
  const stockSignals = stockDashboard?.signals || [];
  const stockTrades = stockDashboard?.recent_trades || [];
  const stockPositions = stockDashboard?.positions || [];
  const stockSensors = stockDashboard?.sensors || [];
  const stockRoutes = stockDashboard?.market_health?.selected_routes || [];
  const stockSignal = stockSignals.find((row: any) => row.action !== 'NO_TRADE') || stockSignals[0] || null;
  const stockScheduler = stockDashboard?.ledger || {};
  const stockLedgerSource = stockDashboard?.ledger?.source || 'longone online Worker/D1';
  const stockBackendLedgerId = stockDashboard?.ledger?.storage_user_id || `crypto_testnet_${stockUserId.replace(/[^\w.-]/g, '_').slice(0, 64)}`;
  const testnet = cryptoDashboard?.testnet || {};
  const testnetPositions = Array.isArray(testnet.positions) ? testnet.positions : [];
  const testnetOrders = Array.isArray(testnet.open_orders) ? testnet.open_orders : [];
  const testnetAccount = testnet.account || {};
  const historyPolicy = cryptoDashboard?.history_policy || {};
  const ledgerSource = cryptoDashboard?.ledger?.source || historyPolicy.ledger_source || 'longone online Worker/D1';
  const backendLedgerId = cryptoDashboard?.ledger?.storage_user_id || historyPolicy.storage_user_id || `crypto_testnet_${cryptoUserId.replace(/[^\w.-]/g, '_').slice(0, 64)}`;
  const exportCryptoLedgerId = useCallback(() => {
    const payload = {
      browser_ledger_id: cryptoUserId,
      backend_ledger_id: backendLedgerId,
      storage_key: 'hfcd_crypto_testnet_user_id',
      source: ledgerSource,
      dashboard_api: `/api/crypto-testnet/dashboard?user_id=${encodeURIComponent(cryptoUserId)}`,
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hfcd-crypto-ledger-${cryptoUserId}.json`;
    anchor.click();
    window.URL.revokeObjectURL(url);
    setMessage(`已导出加密账本 ID：${cryptoUserId}`);
  }, [backendLedgerId, cryptoUserId, ledgerSource]);
  const copyCryptoLedgerId = useCallback(async () => {
    const text = `${cryptoUserId}\n${backendLedgerId}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setMessage(`已复制加密账本 ID：${cryptoUserId}`);
    } catch {
      setMessage(`复制失败，请手动记录账本 ID：${cryptoUserId}`);
    }
  }, [backendLedgerId, cryptoUserId]);
  const exportStockLedgerId = useCallback(() => {
    const payload = {
      browser_ledger_id: stockUserId,
      backend_ledger_id: stockBackendLedgerId,
      storage_key: 'hfcd_stock_paper_user_id',
      source: stockLedgerSource,
      dashboard_api: `/api/crypto-testnet/dashboard?user_id=${encodeURIComponent(stockUserId)}&asset_scope=stock`,
      route: 'Stock V1.7 扩展股票池线上模拟交易',
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hfcd-stock-ledger-${stockUserId}.json`;
    anchor.click();
    window.URL.revokeObjectURL(url);
    setMessage(`已导出股票账本 ID：${stockUserId}`);
  }, [stockBackendLedgerId, stockLedgerSource, stockUserId]);
  const copyStockLedgerId = useCallback(async () => {
    const text = `${stockUserId}\n${stockBackendLedgerId}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setMessage(`已复制股票账本 ID：${stockUserId}`);
    } catch {
      setMessage(`复制失败，请手动记录股票账本 ID：${stockUserId}`);
    }
  }, [stockBackendLedgerId, stockUserId]);

  return (
    <div className="min-h-full bg-[#0b1118] px-5 py-6 pb-14 text-slate-100">
      <section className="rounded-[30px] border border-cyan-200/15 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_34rem),linear-gradient(180deg,#101d24_0%,#0b1118_100%)] p-6">
        <p className="text-xs font-black uppercase tracking-[0.28em] text-cyan-200/70">{copy.eyebrow}</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-white">{copy.title}</h1>
        <p className="mt-2 max-w-5xl text-sm leading-6 text-cyan-50/62">{copy.subtitle}</p>
      </section>

      <section className="mt-5 rounded-[28px] border border-emerald-200/15 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.16),transparent_30rem),rgba(255,255,255,0.03)] p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.24em] text-emerald-200/70">HFCD V3.32 DOGE FORWARD + SHORTVOL</p>
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
            ['max_position_pct', copy.maxPositionPct],
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
                onChange={(event) => {
                  userEditedCryptoConfig.current = true;
                  setCryptoConfigDirty(true);
                  setCryptoConfig((prev) => ({ ...prev, [key]: Number(event.target.value) }));
                }}
              />
            </label>
          ))}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {selectedRoutes.map((route: any) => (
            <div key={`route-${route.symbol}`} className="rounded-2xl border border-emerald-200/10 bg-black/18 p-3">
              <p className="text-sm font-black text-white">{route.symbol}</p>
              <p className="mt-1 text-[11px] leading-4 text-emerald-50/55">
                {route.cadence} · {route.side_policy === 'both' ? '多空' : route.side_policy === 'long_only' ? '只做多' : route.side_policy} · {route.asset_class === 'single_stock' ? '股票线上模拟' : route.execution_venue === 'paper_only' ? '线上模拟' : 'testnet/线上模拟'}
              </p>
              {route.validated_side_policy === 'long_only' && route.side_policy === 'both' ? (
                <p className="mt-1 text-[11px] leading-4 text-amber-100/70">多头盲测通过；空头仅前向验证</p>
              ) : null}
              {route.validated_side_policy === 'both' ? (
                <p className="mt-1 text-[11px] leading-4 text-emerald-200/75">多空盲测通过{route.short_blind_test ? `；空头 PF ${numberText(route.short_blind_test?.test_profit_factor, 2)} / ${money(route.short_blind_test?.test_net_pnl_usd)}` : ''}</p>
              ) : null}
              <p className="mt-1 text-[11px] text-emerald-200/75">多头 PF {numberText(route.blind_test?.profit_factor, 2)} · 测试 {money(route.blind_test?.test_net_pnl_usd)}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <label className="flex w-full items-center gap-3 rounded-2xl border border-emerald-200/10 bg-black/20 px-4 py-3 text-xs font-bold text-emerald-50/65 md:w-56">
            <input
              type="checkbox"
              checked={cryptoConfig.adaptive_sizing}
              onChange={(event) => {
                userEditedCryptoConfig.current = true;
                setCryptoConfigDirty(true);
                setCryptoConfig((prev) => ({ ...prev, adaptive_sizing: event.target.checked }));
              }}
              className="h-4 w-4 accent-emerald-300"
            />
            {copy.adaptiveSizing}
          </label>
          <label className="w-full text-xs font-bold text-emerald-50/55 md:w-56">
            {copy.sidePolicy}
            <select
              className="mt-2 w-full rounded-2xl border border-emerald-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
              value={cryptoConfig.side_policy}
              onChange={(event) => {
                userEditedCryptoConfig.current = true;
                setCryptoConfigDirty(true);
                setCryptoConfig((prev) => ({ ...prev, side_policy: event.target.value }));
              }}
            >
              <option value="both">{copy.both}</option>
              <option value="long_only">{copy.longOnly}</option>
              <option value="short_only">{copy.shortOnly}</option>
            </select>
          </label>
          <label className="w-full text-xs font-bold text-emerald-50/55 md:w-64">
            {copy.orderExecution}
            <select
              className="mt-2 w-full rounded-2xl border border-emerald-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
              value={cryptoConfig.order_execution}
              onChange={(event) => {
                userEditedCryptoConfig.current = true;
                setCryptoConfigDirty(true);
                setCryptoConfig((prev) => ({ ...prev, order_execution: event.target.value }));
              }}
            >
              <option value="paper">{copy.paperMode}</option>
              <option value="binance_testnet">{copy.binanceTestnetMode}</option>
            </select>
            {!canRequestExchangeExecution ? <p className="mt-2 text-[11px] leading-4 text-amber-100/70">{copy.testnetLockedHint}</p> : null}
          </label>
          {canRequestExchangeExecution ? (
            <label className="flex w-full items-center gap-3 rounded-2xl border border-emerald-200/10 bg-black/20 px-4 py-3 text-xs font-bold text-emerald-50/65 md:w-auto">
              <input
                type="checkbox"
                checked={cryptoConfig.testnet_close_all_on_stop}
                onChange={(event) => {
                  userEditedCryptoConfig.current = true;
                  setCryptoConfigDirty(true);
                  setCryptoConfig((prev) => ({ ...prev, testnet_close_all_on_stop: event.target.checked }));
                }}
                className="h-4 w-4 accent-emerald-300"
              />
              停止时同步 Testnet 平仓
          </label>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              disabled={loading || !cryptoConfigDirty}
              onClick={() => postCryptoAction('/api/crypto-testnet/config', { ...cryptoConfig, asset_scope: 'non_stock' }, { actionKey: 'crypto-config', label: '应用加密参数', clearDirty: true })}
              className="rounded-2xl border border-lime-200/25 bg-lime-300/14 px-5 py-3 text-sm font-black text-lime-100 disabled:opacity-45"
            >
              {cryptoAction === 'crypto-config' ? '应用中...' : cryptoConfigDirty ? '确认应用参数' : '参数已应用'}
            </button>
            <button disabled={loading || cryptoSummary?.mode === 'running'} onClick={() => postCryptoAction('/api/crypto-testnet/start', { ...cryptoConfig, asset_scope: 'non_stock' }, { actionKey: 'crypto-start', label: copy.cryptoStart, clearDirty: true })} className="rounded-2xl bg-emerald-300 px-5 py-3 text-sm font-black text-emerald-950 disabled:opacity-45">{cryptoAction === 'crypto-start' ? '启动中...' : copy.cryptoStart}</button>
            <button disabled={loading} onClick={() => postCryptoAction('/api/crypto-testnet/tick', { asset_scope: 'non_stock' }, { actionKey: 'crypto-tick', label: copy.cryptoTick })} className="rounded-2xl border border-emerald-200/15 bg-emerald-300/12 px-5 py-3 text-sm font-black text-emerald-100 disabled:opacity-45">{cryptoAction === 'crypto-tick' ? '运行中...' : copy.cryptoTick}</button>
            <button disabled={loading} onClick={() => postCryptoAction('/api/crypto-testnet/stop', { liquidate: true, asset_scope: 'non_stock' }, { actionKey: 'crypto-stop', label: copy.cryptoStop })} className="rounded-2xl border border-red-300/30 bg-red-400/18 px-5 py-3 text-sm font-black text-red-100 disabled:opacity-45">{cryptoAction === 'crypto-stop' ? '停止中...' : copy.cryptoStop}</button>
            {canRequestExchangeExecution ? (
              <>
                <button disabled={loading} onClick={() => postCryptoAction('/api/crypto-testnet/reconcile', { asset_scope: 'non_stock' }, { actionKey: 'crypto-reconcile', label: copy.reconcile })} className="rounded-2xl border border-cyan-200/20 bg-cyan-300/10 px-5 py-3 text-sm font-black text-cyan-100 disabled:opacity-45">{cryptoAction === 'crypto-reconcile' ? '对账中...' : copy.reconcile}</button>
                <button disabled={loading} onClick={() => postCryptoAction('/api/crypto-testnet/close-all', { asset_scope: 'non_stock' }, { actionKey: 'crypto-close-all', label: copy.closeAll })} className="rounded-2xl border border-amber-300/30 bg-amber-300/12 px-5 py-3 text-sm font-black text-amber-100 disabled:opacity-45">{cryptoAction === 'crypto-close-all' ? '平仓中...' : copy.closeAll}</button>
              </>
            ) : null}
          </div>
        </div>
        {cryptoConfigDirty ? <p className="mt-2 text-xs font-bold text-amber-100/80">参数已修改但尚未应用；点击“确认应用参数”后，运行中的下一轮扫描立即使用新单笔金额和持仓上限。</p> : null}

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

        <div className="mt-5 rounded-[24px] border border-emerald-200/10 bg-black/20 p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-lg font-black text-white">{copy.ledgerBox}</h3>
              <p className="mt-2 text-xs leading-5 text-emerald-50/58">{copy.ledgerExplain}</p>
              <div className="mt-3 grid gap-2 text-xs text-emerald-50/75 md:grid-cols-3">
                <p><span className="text-emerald-50/42">{copy.browserLedgerId}：</span><span className="font-black text-emerald-100">{cryptoUserId}</span></p>
                <p><span className="text-emerald-50/42">{copy.backendLedgerId}：</span><span className="font-black text-emerald-100">{backendLedgerId}</span></p>
                <p><span className="text-emerald-50/42">{copy.ledgerSource}：</span><span className="font-black text-emerald-100">{ledgerSource}</span></p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={copyCryptoLedgerId}
                className="rounded-2xl border border-emerald-200/15 bg-emerald-300/12 px-4 py-3 text-xs font-black text-emerald-100"
              >
                {copy.copyLedgerId}
              </button>
              <button
                type="button"
                onClick={exportCryptoLedgerId}
                className="rounded-2xl border border-cyan-200/15 bg-cyan-300/10 px-4 py-3 text-xs font-black text-cyan-100"
              >
                {copy.exportLedgerId}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-[24px] border border-cyan-200/10 bg-cyan-300/[0.05] p-4">
          <div className="mb-4 rounded-[20px] border border-cyan-200/10 bg-black/20 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="flex-1">
                <h3 className="text-lg font-black text-white">{copy.testnetApiSetup}</h3>
                <p className="mt-1 text-xs leading-5 text-cyan-50/60">{copy.testnetKeyHint}</p>
                <p className={`mt-2 text-xs font-bold ${hasUserTestnetKeys ? 'text-emerald-200' : 'text-amber-200'}`}>
                  {hasUserTestnetKeys ? copy.testnetReady : copy.testnetMissing}
                </p>
              </div>
              <label className="text-xs font-bold text-cyan-50/55 lg:w-80">
                {copy.testnetApiKey}
                <input
                  className="mt-2 w-full rounded-2xl border border-cyan-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
                  value={binanceKeys.apiKey}
                  onChange={(event) => setBinanceKeys((prev) => ({ ...prev, apiKey: event.target.value }))}
                  placeholder="Binance Demo API key"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="text-xs font-bold text-cyan-50/55 lg:w-80">
                {copy.testnetApiSecret}
                <input
                  className="mt-2 w-full rounded-2xl border border-cyan-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
                  type="password"
                  value={binanceKeys.apiSecret}
                  onChange={(event) => setBinanceKeys((prev) => ({ ...prev, apiSecret: event.target.value }))}
                  placeholder="Binance Demo secret"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={saveBinanceKeys}
                  className="rounded-2xl border border-cyan-200/20 bg-cyan-300/12 px-4 py-3 text-xs font-black text-cyan-100"
                >
                  {copy.testnetSaveKeys}
                </button>
                <button
                  type="button"
                  onClick={clearBinanceKeys}
                  className="rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-xs font-black text-amber-100"
                >
                  {copy.testnetClearKeys}
                </button>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-lg font-black text-white">{copy.testnetAccount}</h3>
              <p className="mt-1 text-xs leading-5 text-cyan-50/60">
                状态：{testnet.status || 'loading'} · 执行：{cryptoDashboard?.data_policy?.order_mode || '-'} · 主网下单：禁止 · Demo 订单页：Futures Order
              </p>
              {testnet.error ? <p className="mt-2 text-xs font-bold text-amber-200">Testnet 提示：{testnet.error}</p> : null}
            </div>
            <div className="grid gap-3 text-xs sm:grid-cols-3">
              <div className="rounded-2xl border border-cyan-200/10 bg-black/20 p-3">
                <p className="text-cyan-50/45">钱包余额</p>
                <p className="mt-1 text-lg font-black text-white">{money(testnetAccount.total_wallet_balance ?? testnetAccount.totalWalletBalance)}</p>
              </div>
              <div className="rounded-2xl border border-cyan-200/10 bg-black/20 p-3">
                <p className="text-cyan-50/45">可用余额</p>
                <p className="mt-1 text-lg font-black text-white">{money(testnetAccount.available_balance ?? testnetAccount.availableBalance)}</p>
              </div>
              <div className="rounded-2xl border border-cyan-200/10 bg-black/20 p-3">
                <p className="text-cyan-50/45">挂单 / 持仓</p>
                <p className="mt-1 text-lg font-black text-white">{testnetOrders.length} / {testnetPositions.length}</p>
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <TestnetTable title={copy.testnetPositions} rows={testnetPositions} type="positions" />
            <TestnetTable title={copy.testnetOrders} rows={testnetOrders} type="orders" />
          </div>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <div className="rounded-[24px] border border-emerald-200/10 bg-black/20 p-4">
            <h3 className="text-lg font-black text-white">线上模拟路线信号</h3>
            <div className="mt-3 space-y-3">
              {cryptoSignals.map((row: any) => (
                <div key={`${row.symbol}-${row.captured_at}`} className="rounded-2xl border border-emerald-200/10 bg-white/[0.03] p-4">
                  <p className="text-sm font-black text-white">{row.symbol} · {row.route} · {row.cadence}</p>
                  <p className="mt-2 text-xs text-emerald-50/70">
                    {translate(row.action)} · 价格 {numberText(row.price, row.symbol === 'BTCUSDT' ? 2 : row.symbol?.endsWith('USDT') ? 3 : 2)} · 稳定分 {numberText(row.score, 3)} · 置信度 {pct(row.confidence)} · 执行 {row.asset_class === 'single_stock' ? '股票线上模拟' : row.execution_venue === 'paper_only' ? '线上模拟' : 'testnet/线上模拟'}
                  </p>
                  <p className="mt-1 text-xs text-emerald-50/45">
                    资金费率 {pct(row.funding_rate)} · 深度失衡 {numberText(row.depth_imbalance, 4)} · 点差 {numberText(row.spread_bps, 2)} bps · {row.reject_reason || '信号达标时按配置执行'}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[24px] border border-emerald-200/10 bg-black/20 p-4">
            <h3 className="text-lg font-black text-white">{copy.sensors}</h3>
            <div className="mt-3 overflow-auto">
              <table className="min-w-[720px] w-full text-left text-xs">
                <thead className="text-emerald-50/45">
                  <tr>{['标的', '路线', '执行', '资金费率', 'OI/成交量', 'aggTrade', 'L2/Bσ', '失衡', '点差'].map((head) => <th key={head} className="border-b border-emerald-200/10 px-3 py-3 font-black">{head}</th>)}</tr>
                </thead>
                <tbody>
                  {cryptoSensors.map((row: any) => (
                    <tr key={`sensor-${row.symbol}`} className="border-b border-emerald-200/8 text-emerald-50/80">
                      <td className="px-3 py-3 font-black">{row.symbol}</td>
                      <td className="px-3 py-3">{row.route}</td>
                      <td className="px-3 py-3">{row.execution_venue === 'paper_only' ? 'paper' : 'testnet/paper'}</td>
                      <td className="px-3 py-3">{pct(row.funding_rate)}</td>
                      <td className="px-3 py-3">{row.open_interest ? numberText(row.open_interest, 0) : numberText(row.volume_recent, 0)}</td>
                      <td className="px-3 py-3">{row.agg_trade_usd ? `${money(row.agg_trade_usd)} · ${numberText(row.agg_imbalance, 3)}` : money(row.volume_notional_proxy)}</td>
                      <td className="px-3 py-3">{row.bid_depth_usd ? `${money(row.bid_depth_usd)} / ${money(row.ask_depth_usd)}` : '-'} · Bσ {row.b_sigma_coverage ? '有' : '缺'}</td>
                      <td className="px-3 py-3">{numberText(row.depth_imbalance, 4)}</td>
                      <td className="px-3 py-3">{numberText(row.spread_bps, 2)} bps</td>
                    </tr>
                  ))}
                  {!cryptoSensors.length ? <tr><td className="px-3 py-6 text-emerald-50/50" colSpan={9}>暂无传感器数据。</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <MiniTradeTable title="当前前向持仓" rows={cryptoPositions} type="positions" />
          <MiniTradeTable title="前向账本记录" rows={cryptoTrades} type="history" />
        </div>
      </section>

      <section className="mt-5 rounded-[28px] border border-sky-200/15 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.16),transparent_32rem),rgba(255,255,255,0.03)] p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.24em] text-sky-200/70">Stock V1.7 · Expanded Pool</p>
            <h2 className="mt-1 text-2xl font-black text-white">{copy.stockPanel}</h2>
            <p className="mt-2 max-w-5xl text-sm leading-6 text-sky-50/65">{copy.stockHint}</p>
          </div>
          <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${stockDashboard?.market_health?.ok ? 'border-sky-200/20 bg-sky-300/10 text-sky-100' : 'border-amber-300/30 bg-amber-300/10 text-amber-100'}`}>
            {copy.stockScheduler}：{stockScheduler.scheduler_enabled ? `已启用 · ${stockScheduler.scheduler_cadence || '每 5 分钟'}` : '启动后自动记录'} · {stockSummary?.mode || 'stopped'}
            <p className="mt-1 text-[11px] text-sky-50/55">最近自动记录：{stockScheduler.scheduler_last_tick_at || '-'}</p>
          </div>
        </div>

        <div className="mt-5 rounded-[22px] border border-sky-200/10 bg-sky-300/[0.06] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-black text-sky-100">{copy.ledgerBox}</p>
              <p className="mt-1 text-xs text-sky-50/60">
                {copy.browserLedgerId}：<span className="font-mono text-sky-100">{stockUserId}</span>
              </p>
              <p className="mt-1 text-xs text-sky-50/60">
                {copy.backendLedgerId}：<span className="font-mono text-sky-100">{stockBackendLedgerId}</span> · {copy.ledgerSource}：{stockLedgerSource}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={copyStockLedgerId} className="rounded-2xl border border-sky-200/15 bg-black/20 px-4 py-2 text-xs font-black text-sky-100">{copy.stockCopyLedgerId}</button>
              <button type="button" onClick={exportStockLedgerId} className="rounded-2xl border border-sky-200/15 bg-black/20 px-4 py-2 text-xs font-black text-sky-100">{copy.stockExportLedgerId}</button>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {stockRoutes.map((route: any) => (
            <div key={`stock-route-${route.symbol}`} className="rounded-2xl border border-sky-200/10 bg-black/20 p-4">
              <p className="text-sm font-black text-white">{route.symbol}</p>
              <p className="mt-1 text-xs leading-5 text-sky-50/60">{route.cadence} · {translate(route.side_policy === 'short_only' ? 'SELL_SHORT' : route.side_policy === 'both' ? 'BUY_LONG' : 'BUY_LONG')}{route.side_policy === 'both' ? ' / 做空' : ''} · 股票线上模拟</p>
              <p className="mt-1 text-xs text-sky-200/80">盲测 PF {numberText(route.blind_test?.test_profit_factor || route.blind_test?.profit_factor, 2)} · 测试 {money(route.blind_test?.test_net_pnl_usd)}</p>
            </div>
          ))}
          <div className="rounded-2xl border border-sky-200/10 bg-black/20 p-4">
            <p className="text-xs font-bold text-sky-50/45">当前信号</p>
            <p className="mt-2 text-lg font-black text-white">{stockSignal ? translate(stockSignal.action) : '-'}</p>
            <p className="mt-1 text-xs text-sky-50/55">{stockSignal ? `价格 ${numberText(stockSignal.price, 2)} · 稳定分 ${numberText(stockSignal.score, 3)}` : '等待行情'}</p>
          </div>
          <div className="rounded-2xl border border-sky-200/10 bg-black/20 p-4">
            <p className="text-xs font-bold text-sky-50/45">已实现收益</p>
            <p className="mt-2 text-lg font-black text-white">{money(stockSummary?.realized_pnl_usd)}</p>
            <p className="mt-1 text-xs text-sky-50/55">未实现 {money(stockSummary?.unrealized_pnl_usd)}</p>
          </div>
          <div className="rounded-2xl border border-sky-200/10 bg-black/20 p-4">
            <p className="text-xs font-bold text-sky-50/45">持仓 / 胜率</p>
            <p className="mt-2 text-lg font-black text-white">{stockSummary?.open_positions || 0}/{stockSummary?.max_open_positions || 1}</p>
            <p className="mt-1 text-xs text-sky-50/55">胜率 {pct(stockSummary?.win_rate)}</p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {[
            ['capital_usd', copy.capital],
            ['fixed_trade_usd', '单笔最高金额'],
            ['max_position_pct', copy.maxPositionPct],
            ['max_open_positions', copy.maxPositions],
            ['max_symbol_positions', copy.maxSymbolPositions],
            ['min_signal_score', '最低稳定分'],
            ['max_holding_minutes', '最长持有分钟'],
          ].map(([key, label]) => (
            <label key={`stock-${key}`} className="text-xs font-bold text-sky-50/55">
              {label}
              <input
                className="mt-2 w-full rounded-2xl border border-sky-200/10 bg-black/35 px-4 py-3 text-sm font-bold text-white outline-none"
                type="number"
                step={key.includes('pct') || key.includes('score') ? '0.001' : '1'}
                value={(stockConfig as any)[key]}
                onChange={(event) => {
                  userEditedStockConfig.current = true;
                  setStockConfigDirty(true);
                  setStockConfig((prev) => ({ ...prev, [key]: Number(event.target.value) }));
                }}
              />
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button disabled={stockLoading || !stockConfigDirty} onClick={() => postStockAction('/api/crypto-testnet/config', stockConfig, { actionKey: 'stock-config', label: '应用股票参数', clearDirty: true })} className="rounded-2xl border border-lime-200/25 bg-lime-300/14 px-5 py-3 text-sm font-black text-lime-100 disabled:opacity-45">
            {stockAction === 'stock-config' ? '应用中...' : stockConfigDirty ? '确认应用参数' : '参数已应用'}
          </button>
          <button disabled={stockLoading || stockSummary?.mode === 'running'} onClick={() => postStockAction('/api/crypto-testnet/start', stockConfig, { actionKey: 'stock-start', label: copy.stockStart, clearDirty: true })} className="rounded-2xl bg-sky-300 px-5 py-3 text-sm font-black text-sky-950 disabled:opacity-45">{stockAction === 'stock-start' ? '启动中...' : copy.stockStart}</button>
          <button disabled={stockLoading} onClick={() => postStockAction('/api/crypto-testnet/tick', { asset_scope: 'stock' }, { actionKey: 'stock-tick', label: copy.stockTick })} className="rounded-2xl border border-sky-200/15 bg-sky-300/12 px-5 py-3 text-sm font-black text-sky-100 disabled:opacity-45">{stockAction === 'stock-tick' ? '运行中...' : copy.stockTick}</button>
          <button disabled={stockLoading} onClick={() => postStockAction('/api/crypto-testnet/stop', { asset_scope: 'stock', liquidate: true }, { actionKey: 'stock-stop', label: copy.stockStop })} className="rounded-2xl border border-red-300/30 bg-red-400/18 px-5 py-3 text-sm font-black text-red-100 disabled:opacity-45">{stockAction === 'stock-stop' ? '停止中...' : copy.stockStop}</button>
          <button disabled={stockLoading} onClick={() => postStockAction('/api/crypto-testnet/reset', stockConfig, { actionKey: 'stock-reset', label: copy.stockResetLedger, clearDirty: true })} className="rounded-2xl border border-sky-200/15 bg-black/25 px-5 py-3 text-sm font-black text-sky-100 disabled:opacity-45">{stockAction === 'stock-reset' ? '重置中...' : copy.stockResetLedger}</button>
        </div>
        {stockConfigDirty ? <p className="mt-2 text-xs font-bold text-amber-100/80">股票参数已修改但尚未应用；确认后运行中的下一轮扫描立即使用新限制。</p> : null}

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <div className="rounded-[24px] border border-sky-200/10 bg-black/20 p-4">
            <h3 className="text-lg font-black text-white">{copy.stockSignals}</h3>
            <div className="mt-3 space-y-3">
              {stockSignals.map((row: any) => (
                <div key={`stock-signal-${row.symbol}-${row.captured_at}`} className="rounded-2xl border border-sky-200/10 bg-white/[0.03] p-4">
                  <p className="text-sm font-black text-white">{row.symbol} · {row.route} · {row.cadence}</p>
                  <p className="mt-2 text-xs text-sky-50/70">
                    {translate(row.action)} · 价格 {numberText(row.price, 2)} · 稳定分 {numberText(row.score, 3)} · 置信度 {pct(row.confidence)} · 股票线上模拟
                  </p>
                  <p className="mt-1 text-xs text-sky-50/45">
                    板块 {pct(row.sector_ret_1)} · 大盘 {pct(row.market_ret_1)} · VIX {pct(row.vix_ret_1)} · {row.reject_reason || '信号达标时按股票账本执行'}
                  </p>
                </div>
              ))}
              {!stockSignals.length ? <p className="rounded-2xl border border-sky-200/10 bg-black/20 p-4 text-xs text-sky-50/50">暂无股票信号。</p> : null}
            </div>
          </div>

          <div className="rounded-[24px] border border-sky-200/10 bg-black/20 p-4">
            <h3 className="text-lg font-black text-white">股票传感器</h3>
            <div className="mt-3 overflow-auto">
              <table className="min-w-[620px] w-full text-left text-xs">
                <thead className="text-sky-50/45">
                  <tr>{['标的', '路线', '板块', '大盘', 'VIX', '事件风险', '点差'].map((head) => <th key={head} className="border-b border-sky-200/10 px-3 py-3 font-black">{head}</th>)}</tr>
                </thead>
                <tbody>
                  {stockSensors.map((row: any) => (
                    <tr key={`stock-sensor-${row.symbol}`} className="border-b border-sky-200/8 text-sky-50/80">
                      <td className="px-3 py-3 font-black">{row.symbol}</td>
                      <td className="px-3 py-3">{row.route}</td>
                      <td className="px-3 py-3">{pct(row.sector_ret_1)}</td>
                      <td className="px-3 py-3">{pct(row.market_ret_1)}</td>
                      <td className="px-3 py-3">{pct(row.vix_ret_1)}</td>
                      <td className="px-3 py-3">{numberText(row.stock_event_risk, 3)}</td>
                      <td className="px-3 py-3">{numberText(row.spread_bps, 2)} bps</td>
                    </tr>
                  ))}
                  {!stockSensors.length ? <tr><td className="px-3 py-6 text-sky-50/50" colSpan={7}>暂无股票传感器数据。</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <MiniTradeTable title={copy.stockPositions} rows={stockPositions} type="positions" />
          <MiniTradeTable title={copy.stockHistory} rows={stockTrades} type="history" />
        </div>
      </section>

      {message ? <div className="mt-5 rounded-2xl border border-emerald-200/15 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">{message}</div> : null}
    </div>
  );
}

function MiniTradeTable({ title, rows, type }: { title: string; rows: any[]; type: 'positions' | 'history' }) {
  return (
    <div className="rounded-[24px] border border-emerald-200/10 bg-black/20 p-4">
      <h3 className="text-lg font-black text-white">{title}</h3>
      <div className="mt-3 overflow-auto">
        <table className="min-w-[980px] w-full text-left text-xs">
          <thead className="text-emerald-50/45">
            <tr>
              {['时间', '事件', '标的', '方向', '价格', '金额', '数量', '净收益', '仓位逻辑', '原因'].map((head) => (
                <th key={head} className="border-b border-emerald-200/10 px-3 py-3 font-black">{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const displayPnl = row.event === 'HOLD' && row.paper_pnl_usd !== undefined
                ? row.paper_pnl_usd
                : row.net_pnl_usd ?? row.paper_pnl_usd ?? row.unrealized_pnl_usd;
              return (
                <tr key={`${row.position_id || row.ts || row.symbol}-${index}`} className="border-b border-emerald-200/8 text-emerald-50/80">
                  <td className="px-3 py-3">{row.ts || row.opened_at ? new Date(row.ts || row.opened_at).toLocaleString() : '-'}</td>
                  <td className="px-3 py-3"><span className="rounded-full bg-emerald-300/12 px-3 py-1 font-black text-emerald-200">{type === 'positions' ? '持仓' : translate(row.event)}</span></td>
                  <td className="px-3 py-3 font-black">{row.symbol || '-'}</td>
                  <td className="px-3 py-3">{row.side === 'short' ? '做空' : row.side === 'long' ? '做多' : '-'}</td>
                  <td className="px-3 py-3">{numberText(row.exit_price ?? row.entry_price ?? row.price ?? row.last_price, row.symbol === 'BTCUSDT' ? 2 : row.symbol?.endsWith('USDT') ? 3 : 2)}</td>
                  <td className="px-3 py-3">{money(row.trade_value_usd ?? row.notional_usd)}</td>
                  <td className="px-3 py-3">{numberText(row.quantity, 6)}</td>
                  <td className={`px-3 py-3 font-black ${Number(displayPnl ?? 0) < 0 ? 'text-red-300' : 'text-emerald-200'}`}>{money(displayPnl)}</td>
                  <td className="px-3 py-3">
                    <span className="block font-bold text-emerald-100/85">{row.sizing_mode === 'energy_style_adaptive_cap' ? '自适应' : row.sizing_mode ? '固定上限' : '-'}</span>
                    {row.sizing_reason ? <span className="mt-1 block max-w-[260px] text-[11px] leading-4 text-emerald-50/45">{row.sizing_reason}</span> : null}
                  </td>
                  <td className="px-3 py-3">{translate(row.reason)}</td>
                </tr>
              );
            })}
            {!rows.length ? <tr><td className="px-3 py-6 text-emerald-50/50" colSpan={10}>暂无记录。</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TestnetTable({ title, rows, type }: { title: string; rows: any[]; type: 'positions' | 'orders' }) {
  const heads = type === 'positions'
    ? ['标的', '方向', '数量', '入场价', '标记价', '未实现盈亏']
    : ['标的', '方向', '类型', '价格', '数量', '状态'];

  return (
    <div className="rounded-[20px] border border-cyan-200/10 bg-black/18 p-4">
      <h4 className="text-sm font-black text-white">{title}</h4>
      <div className="mt-3 overflow-auto">
        <table className="min-w-[560px] w-full text-left text-xs">
          <thead className="text-cyan-50/45">
            <tr>
              {heads.map((head) => (
                <th key={head} className="border-b border-cyan-200/10 px-3 py-3 font-black">{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.symbol || row.order_id || row.orderId || 'row'}-${index}`} className="border-b border-cyan-200/8 text-cyan-50/80">
                {type === 'positions' ? (
                  <>
                    <td className="px-3 py-3 font-black">{row.symbol || '-'}</td>
                    <td className="px-3 py-3">{Number(row.position_amt ?? row.positionAmt ?? 0) < 0 ? '做空' : '做多'}</td>
                    <td className="px-3 py-3">{numberText(Math.abs(Number(row.position_amt ?? row.positionAmt ?? 0)), 6)}</td>
                    <td className="px-3 py-3">{numberText(row.entry_price ?? row.entryPrice, 3)}</td>
                    <td className="px-3 py-3">{numberText(row.mark_price ?? row.markPrice, 3)}</td>
                    <td className={`px-3 py-3 font-black ${Number(row.unrealized_pnl_usd ?? row.unRealizedProfit ?? row.unrealizedProfit ?? 0) < 0 ? 'text-red-300' : 'text-emerald-200'}`}>{money(row.unrealized_pnl_usd ?? row.unRealizedProfit ?? row.unrealizedProfit)}</td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-3 font-black">{row.symbol || '-'}</td>
                    <td className="px-3 py-3">{row.side || '-'}</td>
                    <td className="px-3 py-3">{row.type || '-'}</td>
                    <td className="px-3 py-3">{numberText(row.price, 3)}</td>
                    <td className="px-3 py-3">{numberText(row.orig_qty ?? row.origQty ?? row.executed_qty ?? row.executedQty, 6)}</td>
                    <td className="px-3 py-3">{row.status || '-'}</td>
                  </>
                )}
              </tr>
            ))}
            {!rows.length ? <tr><td className="px-3 py-6 text-cyan-50/50" colSpan={heads.length}>暂无 Testnet 数据。</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
