import {
  buildContents,
  getGoogleCloudAccessToken,
  geminiGenerateJson,
  normalizeSystemInstruction,
  streamGeminiToNdjson,
  streamVertexToNdjson,
} from '../functions/_lib/gemini';
import { buildInternalizedOperatingInstruction } from '../src/lib/wuxingInternalization';
import { resolvePreferredLocale } from '../src/lib/locale';
import {
  auditRecords,
  HFCDFieldSimulationInput,
  HFCDIndustry,
  HFCDGates,
  learnHFCDParameters,
  normalizeHFCDThresholds,
  parseCsv,
  runHFCDFieldSimulation,
  simulateHFCDScenarios,
  summarizeAudit,
  summarizeGateSafety,
  validateBlindMetrics,
  validateRows,
} from '../src/lib/hfcdCore';
import {
  buildHFCDResearchCloudConfig,
  buildHFCDResearchJobPlan,
  HFCDResearchJobRequest,
} from '../src/lib/hfcdResearchJobs';
import { FOOTBALL_ACCURACY_FEED } from '../src/lib/generated/footballAccuracyFeed';
import { ENERGY_RUNTIME_FEED } from '../src/lib/generated/energyRuntimeFeed';
import { MULTI_MARKET_TRADING_CONFIG } from '../src/lib/generated/multiMarketTradingConfig';

type Env = {
  ASSETS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  ENERGY_TRADING_DB?: any;
  GEMINI_API_KEY?: string;
  VERTEX_ENABLED?: string;
  VERTEX_TUNED_MODEL?: string;
  VERTEX_SERVICE_ACCOUNT_JSON?: string;
  VERTEX_SERVICE_ACCOUNT_JSON_BASE64?: string;
  HFCD_API_KEYS?: string;
  HFCD_CLOUD_PROJECT_ID?: string;
  HFCD_CLOUD_REGION?: string;
  HFCD_CLOUD_RUN_JOB?: string;
  HFCD_GCS_BUCKET?: string;
  HFCD_SOURCE_GCS_PREFIX?: string;
  DATABENTO_API_KEY?: string;
  BINANCE_TESTNET_API_KEY?: string;
  BINANCE_TESTNET_API_SECRET?: string;
  NODE_ENV?: string;
};
const instructionCache = new Map<string, string>();
const MAX_INSTRUCTION_CACHE = 120;

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

function setInstructionCache(key: string, value: string) {
  if (instructionCache.size >= MAX_INSTRUCTION_CACHE) {
    const oldestKey = instructionCache.keys().next().value;
    if (oldestKey) {
      instructionCache.delete(oldestKey);
    }
  }
  instructionCache.set(key, value);
}

function buildInstructionCacheKey(payload: {
  baseInstruction: string;
  systemInstruction: string;
  omegaPrompt: string;
  content: string;
  diagnosis: unknown;
}) {
  return JSON.stringify([
    payload.baseInstruction,
    payload.systemInstruction,
    payload.omegaPrompt,
    payload.content,
    payload.diagnosis,
  ]);
}

function assertHfcdApiKey(request: Request, env: Env) {
  const configuredKeys = (env.HFCD_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (configuredKeys.length === 0) return true;
  const authorization = request.headers.get('authorization') || '';
  const key = request.headers.get('x-api-key') || authorization.replace(/^Bearer\s+/i, '');
  return configuredKeys.includes(key);
}

function configuredHfcdApiKeys(env: Env) {
  return (env.HFCD_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

type BinanceTestnetCredentials = {
  apiKey: string;
  apiSecret: string;
};

function requestBinanceTestnetCredentials(request: Request): BinanceTestnetCredentials | null {
  const apiKey = String(request.headers.get('x-binance-testnet-api-key') || '').trim();
  const apiSecret = String(request.headers.get('x-binance-testnet-api-secret') || '').trim();
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

function hasAdminPrivateTradingControl(request: Request, env: Env) {
  const configuredKeys = configuredHfcdApiKeys(env);
  if (configuredKeys.length === 0) return false;
  const authorization = request.headers.get('authorization') || '';
  const key = request.headers.get('x-api-key') || authorization.replace(/^Bearer\s+/i, '');
  return configuredKeys.includes(key);
}

function hasPrivateTradingControl(request: Request, env: Env) {
  return Boolean(requestBinanceTestnetCredentials(request) || hasAdminPrivateTradingControl(request, env));
}

function assertPrivateTradingControl(request: Request, env: Env) {
  if (!hasPrivateTradingControl(request, env)) {
    throw new Error('Private exchange control is locked. Public users can use paper mode only.');
  }
}

function privateTradingControlLockedJson() {
  return json({
    ok: false,
    error: '请先填写 Binance Demo/Testnet API key 和 secret；没有密钥时只能使用本地 paper 模拟账本。',
  }, {
    status: 403,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function binanceTestnetCredentialsForRequest(request: Request, env: Env): BinanceTestnetCredentials | null {
  const requestCredentials = requestBinanceTestnetCredentials(request);
  if (requestCredentials) return requestCredentials;
  if (hasAdminPrivateTradingControl(request, env) && env.BINANCE_TESTNET_API_KEY && env.BINANCE_TESTNET_API_SECRET) {
    return {
      apiKey: String(env.BINANCE_TESTNET_API_KEY),
      apiSecret: String(env.BINANCE_TESTNET_API_SECRET),
    };
  }
  return null;
}

async function callGoogleApi(env: Env, url: string, init: RequestInit = {}) {
  const token = await getGoogleCloudAccessToken({ env });
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload?.error?.message || text || `Google API failed with status ${response.status}`);
  }
  return payload;
}

function operationToStatus(operation: any) {
  if (!operation) return 'unknown';
  if (operation.error) return 'failed';
  if (operation.done) return 'succeeded';
  return 'running';
}

function getWorkerEnergyFeed() {
  return ENERGY_RUNTIME_FEED as any;
}

function getWorkerEnergySummaryPayload() {
  const feed = getWorkerEnergyFeed();
  return {
    ok: true,
    version: feed.version,
    generated_at: feed.generated_at,
    v3_0: feed.summary,
    smoke: feed.smoke,
    manifest: feed.manifest,
    new_energy_source_types: Object.keys(feed.templates || {}),
    public_new_energy_sources: feed.public_new_energy_sources || [],
  };
}

function filterWorkerEnergyHeads(status?: string | null) {
  const feed = getWorkerEnergyFeed();
  const rows = Array.isArray(feed.heads) ? feed.heads : [];
  const normalized = String(status || '').trim();
  if (!normalized) return rows;
  return rows.filter((row: any) => row.head_status === normalized);
}

const ENERGY_TRADING_VERSION = 'HFCD_EnergyTrading_OnlineD1_V1';
const ENERGY_PRICE_SCALE = 100;
const ENERGY_VARIABLE_COST_PER_MWH = 11.86;

function energyUserId(request: Request, url: URL, body?: any) {
  const raw =
    body?.user_id ||
    url.searchParams.get('user_id') ||
    request.headers.get('x-hfcd-user-id') ||
    'wuxing_os_user';
  return String(raw)
    .trim()
    .replace(/[^\w.-]/g, '_')
    .slice(0, 64) || 'wuxing_os_user';
}

function energyIso(date = new Date()) {
  return date.toISOString();
}

function energyHorizonMinutes(horizon: string) {
  if (horizon === '6h') return 360;
  if (horizon === '3h') return 180;
  return 60;
}

function energyRoundtripCode(action: string, mwh = 0) {
  const text = String(action || '').toUpperCase();
  if (text.includes('CHARGE') || mwh < 0) return 'CHARGE_BUY_TO_DISCHARGE_SELL';
  if (text.includes('DISCHARGE') || mwh > 0) return 'DISCHARGE_SELL_TO_CHARGE_BUY';
  return '';
}

function energyExitAction(action: string, mwh = 0) {
  const code = energyRoundtripCode(action, mwh);
  if (code === 'CHARGE_BUY_TO_DISCHARGE_SELL') return 'DISCHARGE_SELL';
  if (code === 'DISCHARGE_SELL_TO_CHARGE_BUY') return 'CHARGE_BUY';
  return '';
}

function energyTradeAmount(spread: number, mwh: number) {
  return Math.abs(Number(spread || 0)) * Math.abs(Number(mwh || 0)) * ENERGY_PRICE_SCALE;
}

function energyGrossPnl(action: string, entrySpread: number, exitSpread: number, mwh: number) {
  const qty = Math.abs(Number(mwh || 0));
  const code = energyRoundtripCode(action, mwh);
  if (code === 'CHARGE_BUY_TO_DISCHARGE_SELL') {
    return (Number(exitSpread || 0) - Number(entrySpread || 0)) * qty * ENERGY_PRICE_SCALE;
  }
  if (code === 'DISCHARGE_SELL_TO_CHARGE_BUY') {
    return (Number(entrySpread || 0) - Number(exitSpread || 0)) * qty * ENERGY_PRICE_SCALE;
  }
  return 0;
}

function energySpreadAt(date: Date, phaseOffset = 0) {
  const minutes = date.getTime() / 60000;
  const dayCycle = Math.sin((2 * Math.PI * ((minutes / 60 + phaseOffset) % 24)) / 24);
  const fastCycle = Math.sin((2 * Math.PI * ((minutes / 5 + phaseOffset) % 18)) / 18);
  return Number((11.5 * dayCycle + 4.5 * fastCycle).toFixed(2));
}

function buildEnergyMarketRows(now = new Date()) {
  const spread = energySpreadAt(now);
  const predicted1h = energySpreadAt(new Date(now.getTime() + 60 * 60000)) - spread;
  const predicted3h = energySpreadAt(new Date(now.getTime() + 180 * 60000)) - spread;
  const predicted6h = energySpreadAt(new Date(now.getTime() + 360 * 60000)) - spread;
  const rows = [
    { horizon: '1h', delta: predicted1h, signal_source: 'V3.36 1小时执行信号' },
    { horizon: '3h', delta: predicted3h, signal_source: 'V3.28/3.29 3小时回路信号' },
    { horizon: '6h', delta: predicted6h, signal_source: 'V3.28/3.29 6小时回路信号' },
  ];
  return rows.map((row) => {
    const action = spread < -4.5 && row.delta > 1.2 ? 'CHARGE_BUY' : spread > 4.5 && row.delta < -1.2 ? 'DISCHARGE_SELL' : 'NO_TRADE';
    const tierScore = Math.min(Math.abs(spread) / 12 + Math.abs(row.delta) / 8, 1.4);
    const tier = tierScore >= 1.05 ? 'tier_A' : tierScore >= 0.72 ? 'tier_B' : 'tier_C';
    return {
      decision_id: `${row.horizon}-${Math.floor(now.getTime() / 300000)}`,
      captured_at: energyIso(now),
      node: 'TH_SP15_GEN-APND',
      horizon: row.horizon,
      signal_source: row.signal_source,
      visible_spread: spread,
      model_prediction_mw: Number((row.delta * 120).toFixed(1)),
      predicted_spread_delta: Number(row.delta.toFixed(2)),
      soc: 0.55,
      paper_action: action,
      recommendation: action === 'NO_TRADE' ? 'NO_TRADE' : 'TRADE',
      tier,
      reject_reason: action === 'NO_TRADE' ? 'spread_or_delta_underthreshold' : '',
      status: action === 'NO_TRADE' ? 'rejected' : 'accepted',
    };
  });
}

function defaultEnergyTradingAccount(userId: string, body: any = {}) {
  const capital = Number(body.capital_usd || body.capital || 1_000_000);
  return {
    version: ENERGY_TRADING_VERSION,
    user_id: userId,
    mode: 'stopped',
    started_at: '',
    stopped_at: '',
    initial_cash_usd: capital,
    cash_usd: capital,
    realized_pnl_usd: 0,
    equity_usd: capital,
    peak_equity_usd: capital,
    max_drawdown_usd: 0,
    open_positions: [] as any[],
    closed_trades: [] as any[],
    seen_decision_ids: [] as string[],
    config: {
      fixed_trade_usd: Number(body.fixed_trade_usd || 10_000),
      max_position_pct: Number(body.max_position_pct || 0.08),
      max_open_positions: Number(body.max_open_positions || 10),
      max_order_mwh: Number(body.max_order_mwh || 25),
      min_abs_spread: Number(body.min_abs_spread || 4.5),
      min_abs_prediction_mw: Number(body.min_abs_prediction_mw || 100),
      min_tier_rank: Number(body.min_tier_rank || 2),
      variable_cost_per_mwh: ENERGY_VARIABLE_COST_PER_MWH,
      price_to_usd_scale: ENERGY_PRICE_SCALE,
      stop_loss_usd: Number(body.stop_loss_usd || 450),
      take_profit_usd: Number(body.take_profit_usd || 900),
      strategy: String(body.strategy || 'qhopf_selector'),
      sizing_mode: String(body.sizing_mode || 'fixed_usd'),
    },
  };
}

async function ensureEnergyTradingDb(env: Env) {
  const db = env.ENERGY_TRADING_DB;
  if (!db) return null;
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS energy_accounts (user_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)',
  ).run();
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS energy_trades (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ts TEXT NOT NULL, event TEXT NOT NULL, raw_json TEXT NOT NULL)',
  ).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_energy_trades_user_ts ON energy_trades(user_id, ts DESC)',
  ).run();
  return db;
}

async function loadEnergyAccount(env: Env, userId: string) {
  const db = await ensureEnergyTradingDb(env);
  if (!db) return defaultEnergyTradingAccount(userId);
  const row = await db.prepare('SELECT state_json FROM energy_accounts WHERE user_id = ?').bind(userId).first();
  if (!row?.state_json) return defaultEnergyTradingAccount(userId);
  try {
    return JSON.parse(String(row.state_json));
  } catch {
    return defaultEnergyTradingAccount(userId);
  }
}

async function saveEnergyAccount(env: Env, state: any) {
  const db = await ensureEnergyTradingDb(env);
  if (!db) return;
  await db
    .prepare('INSERT OR REPLACE INTO energy_accounts (user_id, state_json, updated_at) VALUES (?, ?, ?)')
    .bind(state.user_id, JSON.stringify(state), energyIso())
    .run();
}

async function insertEnergyTrade(env: Env, userId: string, row: any) {
  const db = await ensureEnergyTradingDb(env);
  if (!db) return;
  const id = row.id || `${userId}-${row.ts}-${row.event}-${row.position_id || row.decision_id || Math.random()}`;
  await db
    .prepare('INSERT OR REPLACE INTO energy_trades (id, user_id, ts, event, raw_json) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, row.ts, row.event, JSON.stringify({ ...row, id }))
    .run();
}

async function recentEnergyTrades(env: Env, userId: string, limit = 80) {
  const db = await ensureEnergyTradingDb(env);
  if (!db) return [];
  const rows = await db
    .prepare('SELECT raw_json FROM energy_trades WHERE user_id = ? ORDER BY ts DESC LIMIT ?')
    .bind(userId, limit)
    .all();
  return (rows.results || []).map((row: any) => {
    try {
      return JSON.parse(String(row.raw_json));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function tierRank(tier: string) {
  const text = String(tier || '').toUpperCase();
  if (text.includes('A')) return 3;
  if (text.includes('B')) return 2;
  if (text.includes('C')) return 1;
  return 0;
}

function energyOrderSize(row: any, state: any) {
  const spread = Math.max(Math.abs(Number(row.visible_spread || 0)), 1);
  const cfg = state.config || {};
  const fixedMwh = Number(cfg.fixed_trade_usd || 10_000) / Math.max(spread * ENERGY_PRICE_SCALE, 1);
  const cashCapMwh = (Number(state.cash_usd || 0) * Number(cfg.max_position_pct || 0.08)) / Math.max(spread * ENERGY_PRICE_SCALE, 1);
  const predictedMwh = Math.abs(Number(row.model_prediction_mw || 0)) / 120;
  const size = Math.max(0, Math.min(Number(cfg.max_order_mwh || 25), fixedMwh, cashCapMwh, predictedMwh));
  if (String(row.paper_action || '').toUpperCase().includes('CHARGE')) return -size;
  return size;
}

function canOpenEnergyPosition(row: any, state: any) {
  const cfg = state.config || {};
  if (state.mode !== 'running') return 'AI未运行';
  if ((state.open_positions || []).length >= Number(cfg.max_open_positions || 10)) return '达到最大持仓数';
  if (String(row.recommendation).toUpperCase() === 'NO_TRADE') return '信号未达交易标准';
  if (Math.abs(Number(row.visible_spread || 0)) < Number(cfg.min_abs_spread || 4.5)) return '价差未达交易阈值';
  if (Math.abs(Number(row.model_prediction_mw || 0)) < Number(cfg.min_abs_prediction_mw || 100)) return '预测功率不足';
  if (tierRank(row.tier) < Number(cfg.min_tier_rank || 2)) return '置信等级不足';
  if (!String(row.paper_action || '').match(/CHARGE|DISCHARGE/i)) return '没有可执行方向';
  const segment = energySegmentStats(state, row);
  if (segment.count >= 8 && segment.expectancy_usd < 0 && segment.profit_factor < 1) {
    return '该信号源历史期望为负';
  }
  return '';
}

function markEnergyEquity(state: any) {
  const unrealized = (state.open_positions || []).reduce((sum: number, pos: any) => sum + Number(pos.unrealized_pnl_usd || 0), 0);
  const equity = Number(state.cash_usd || 0) + unrealized;
  state.equity_usd = equity;
  state.peak_equity_usd = Math.max(Number(state.peak_equity_usd || equity), equity);
  state.max_drawdown_usd = Math.min(Number(state.max_drawdown_usd || 0), equity - Number(state.peak_equity_usd || equity));
}

function energyUnrealizedPnl(state: any) {
  return (state.open_positions || []).reduce((sum: number, pos: any) => sum + Number(pos.unrealized_pnl_usd || 0), 0);
}

function energyTradePct(value: number, stateOrConfig: any) {
  const cfg = stateOrConfig?.config || stateOrConfig || {};
  const base = Math.max(Number(cfg.fixed_trade_usd || 10_000), 1);
  return Number((Number(value || 0) / base).toFixed(4));
}

function energyClosedTrades(state: any) {
  return (state.closed_trades || []).filter((trade: any) => Number.isFinite(Number(trade.net_pnl_usd)));
}

function energyProfitFactor(wins: number, lossesAbs: number) {
  if (lossesAbs <= 0) return wins > 0 ? 99 : 0;
  return wins / lossesAbs;
}

function energyGroupStats(trades: any[], keyFn: (trade: any) => string) {
  const groups: Record<string, any> = {};
  for (const trade of trades) {
    const key = keyFn(trade) || 'unknown';
    const pnl = Number(trade.net_pnl_usd || 0);
    const g = groups[key] || {
      key,
      count: 0,
      wins: 0,
      losses: 0,
      net_pnl_usd: 0,
      gross_win_usd: 0,
      gross_loss_usd: 0,
      avg_pnl_usd: 0,
      win_rate: 0,
      profit_factor: 0,
    };
    g.count += 1;
    g.net_pnl_usd += pnl;
    if (pnl > 0) {
      g.wins += 1;
      g.gross_win_usd += pnl;
    } else if (pnl < 0) {
      g.losses += 1;
      g.gross_loss_usd += Math.abs(pnl);
    }
    groups[key] = g;
  }
  return Object.values(groups).map((g: any) => ({
    ...g,
    net_pnl_usd: Number(g.net_pnl_usd.toFixed(2)),
    gross_win_usd: Number(g.gross_win_usd.toFixed(2)),
    gross_loss_usd: Number(g.gross_loss_usd.toFixed(2)),
    avg_pnl_usd: Number((g.net_pnl_usd / Math.max(g.count, 1)).toFixed(2)),
    win_rate: Number((g.wins / Math.max(g.count, 1)).toFixed(4)),
    profit_factor: Number(energyProfitFactor(g.gross_win_usd, g.gross_loss_usd).toFixed(3)),
  })).sort((a: any, b: any) => b.net_pnl_usd - a.net_pnl_usd);
}

function energySegmentStats(state: any, row: any) {
  const trades = energyClosedTrades(state).filter((trade: any) => {
    const sameHorizon = !row?.horizon || String(trade.horizon || '') === String(row.horizon || '');
    const sameAction = !row?.paper_action || String(trade.entry_action || trade.action || '') === String(row.paper_action || '');
    return sameHorizon && sameAction;
  });
  const total = trades.reduce((sum: number, trade: any) => sum + Number(trade.net_pnl_usd || 0), 0);
  const wins = trades.filter((trade: any) => Number(trade.net_pnl_usd || 0) > 0).length;
  const grossWin = trades.reduce((sum: number, trade: any) => sum + Math.max(Number(trade.net_pnl_usd || 0), 0), 0);
  const grossLoss = trades.reduce((sum: number, trade: any) => sum + Math.max(-Number(trade.net_pnl_usd || 0), 0), 0);
  return {
    count: trades.length,
    win_rate: trades.length ? wins / trades.length : 0,
    net_pnl_usd: total,
    expectancy_usd: trades.length ? total / trades.length : 0,
    profit_factor: energyProfitFactor(grossWin, grossLoss),
  };
}

function energyRiskCandidateValues(base: number, current: number, ratios: number[]) {
  const values = ratios.map((ratio) => Math.round(base * ratio));
  values.push(Math.round(current || 0));
  return Array.from(new Set(values.filter((value) => value > 0))).sort((a, b) => a - b);
}

function energySimulateTradeRisk(trade: any, stopLoss: number, takeProfit: number) {
  const marks = Array.isArray(trade.mtm_path) ? trade.mtm_path : [];
  for (const mark of marks) {
    const unrealized = Number(mark.unrealized_pnl_usd || 0);
    if (unrealized >= takeProfit || unrealized <= -stopLoss) {
      return {
        pnl: unrealized,
        exit_reason: unrealized >= takeProfit ? '模拟止盈' : '模拟止损',
        path_used: true,
      };
    }
  }
  const realized = Number(trade.net_pnl_usd || 0);
  if (!marks.length) {
    return {
      pnl: Math.max(Math.min(realized, takeProfit), -stopLoss),
      exit_reason: '粗略截断估计',
      path_used: false,
    };
  }
  return {
    pnl: realized,
    exit_reason: trade.reason || '实际结算',
    path_used: true,
  };
}

function energyRiskOptimization(state: any) {
  const trades = energyClosedTrades(state);
  const cfg = state.config || {};
  const base = Math.max(Number(cfg.fixed_trade_usd || 10_000), 1);
  if (trades.length < 5) {
    return {
      status: 'collecting_data',
      message: '已结算交易少于 5 笔，先继续积累样本；暂不自动推荐止盈止损。',
      sample_count: trades.length,
      recommended: {
        stop_loss_usd: Number(cfg.stop_loss_usd || 450),
        take_profit_usd: Number(cfg.take_profit_usd || 900),
        stop_loss_pct: energyTradePct(cfg.stop_loss_usd || 450, cfg),
        take_profit_pct: energyTradePct(cfg.take_profit_usd || 900, cfg),
      },
      top_candidates: [],
    };
  }
  const stopValues = energyRiskCandidateValues(base, Number(cfg.stop_loss_usd || 450), [0.015, 0.025, 0.035, 0.045, 0.06, 0.08, 0.1]);
  const takeValues = energyRiskCandidateValues(base, Number(cfg.take_profit_usd || 900), [0.03, 0.05, 0.075, 0.09, 0.12, 0.15, 0.2]);
  const candidates: any[] = [];
  for (const stopLoss of stopValues) {
    for (const takeProfit of takeValues) {
      let net = 0;
      let wins = 0;
      let grossWin = 0;
      let grossLoss = 0;
      let pathUsed = 0;
      let equity = 0;
      let peak = 0;
      let maxDrawdown = 0;
      for (const trade of trades) {
        const simulated = energySimulateTradeRisk(trade, stopLoss, takeProfit);
        const pnl = Number(simulated.pnl || 0);
        if (simulated.path_used) pathUsed += 1;
        net += pnl;
        equity += pnl;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.min(maxDrawdown, equity - peak);
        if (pnl > 0) {
          wins += 1;
          grossWin += pnl;
        } else if (pnl < 0) {
          grossLoss += Math.abs(pnl);
        }
      }
      candidates.push({
        stop_loss_usd: stopLoss,
        take_profit_usd: takeProfit,
        stop_loss_pct: Number((stopLoss / base).toFixed(4)),
        take_profit_pct: Number((takeProfit / base).toFixed(4)),
        simulated_net_pnl_usd: Number(net.toFixed(2)),
        simulated_win_rate: Number((wins / Math.max(trades.length, 1)).toFixed(4)),
        profit_factor: Number(energyProfitFactor(grossWin, grossLoss).toFixed(3)),
        max_drawdown_usd: Number(maxDrawdown.toFixed(2)),
        path_coverage: Number((pathUsed / Math.max(trades.length, 1)).toFixed(4)),
      });
    }
  }
  candidates.sort((a, b) =>
    b.simulated_net_pnl_usd - a.simulated_net_pnl_usd ||
    b.profit_factor - a.profit_factor ||
    b.simulated_win_rate - a.simulated_win_rate,
  );
  const best = candidates[0] || null;
  return {
    status: best ? 'ready' : 'no_candidate',
    sample_count: trades.length,
    path_quality: best?.path_coverage === 1 ? 'exact_mtm_path' : best?.path_coverage > 0 ? 'mixed_mtm_path' : 'coarse_realized_only',
    message: best?.path_coverage === 1
      ? '基于逐轮浮盈路径扫描得到推荐止盈止损。'
      : '部分旧交易缺少逐轮浮盈路径，当前推荐含粗略回放；之后新交易会自动记录路径，推荐会更精确。',
    recommended: best,
    top_candidates: candidates.slice(0, 8),
  };
}

function energyWinRateDiagnostics(state: any) {
  const trades = energyClosedTrades(state);
  const wins = trades.filter((trade: any) => Number(trade.net_pnl_usd || 0) > 0);
  const losses = trades.filter((trade: any) => Number(trade.net_pnl_usd || 0) < 0);
  const grossWin = wins.reduce((sum: number, trade: any) => sum + Number(trade.net_pnl_usd || 0), 0);
  const grossLoss = losses.reduce((sum: number, trade: any) => sum + Math.abs(Number(trade.net_pnl_usd || 0)), 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const byHorizon = energyGroupStats(trades, (trade) => String(trade.horizon || 'unknown'));
  const byAction = energyGroupStats(trades, (trade) => String(trade.entry_action || trade.action || 'unknown'));
  const bySource = energyGroupStats(trades, (trade) => String(trade.signal_source || 'unknown'));
  const causes: string[] = [];
  const recommendations: string[] = [];
  if (trades.length < 10) {
    causes.push('样本仍偏少，胜率波动会很大。');
    recommendations.push('继续记录至少 30 笔已结算交易后再用胜率做强判断。');
  }
  if (winRate < 0.5 && grossWin > grossLoss) {
    causes.push('胜率低但总利润为正，说明当前策略靠较大的盈利单覆盖较多小亏单。');
    recommendations.push('不要只追求胜率；优先看净收益、平均盈亏比和最大回撤。');
  }
  if (avgLoss > avgWin && losses.length >= 3) {
    causes.push('平均亏损大于平均盈利，止损可能偏宽或止盈偏早。');
    recommendations.push('优先采用止盈/止损扫描里利润最高且回撤更低的一组参数。');
  }
  for (const group of byAction) {
    if (group.count >= 5 && group.avg_pnl_usd < 0) {
      causes.push(`${group.key} 历史期望为负。`);
      recommendations.push(`暂时降低或拦截 ${group.key}，直到该方向重新转正。`);
    }
  }
  return {
    sample_count: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: Number(winRate.toFixed(4)),
    net_pnl_usd: Number((grossWin - grossLoss).toFixed(2)),
    avg_win_usd: Number(avgWin.toFixed(2)),
    avg_loss_usd: Number(avgLoss.toFixed(2)),
    payoff_ratio: Number((avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 99 : 0).toFixed(3)),
    profit_factor: Number(energyProfitFactor(grossWin, grossLoss).toFixed(3)),
    by_horizon: byHorizon,
    by_action: byAction,
    by_source: bySource.slice(0, 8),
    causes,
    recommendations,
  };
}

function energyActiveRisk(state: any) {
  const cfg = state.config || {};
  const optimized = energyRiskOptimization(state);
  if (cfg.auto_optimize_risk !== false && optimized.status === 'ready' && optimized.recommended) {
    return {
      stop_loss_usd: Number(optimized.recommended.stop_loss_usd || cfg.stop_loss_usd || 450),
      take_profit_usd: Number(optimized.recommended.take_profit_usd || cfg.take_profit_usd || 900),
      stop_loss_pct: optimized.recommended.stop_loss_pct,
      take_profit_pct: optimized.recommended.take_profit_pct,
      source: 'history_optimized',
      path_quality: optimized.path_quality,
    };
  }
  return {
    stop_loss_usd: Number(cfg.stop_loss_usd || 450),
    take_profit_usd: Number(cfg.take_profit_usd || 900),
    stop_loss_pct: energyTradePct(cfg.stop_loss_usd || 450, state),
    take_profit_pct: energyTradePct(cfg.take_profit_usd || 900, state),
    source: 'user_config',
    path_quality: 'not_enough_data',
  };
}

async function openEnergyPosition(env: Env, state: any, row: any) {
  const mwh = energyOrderSize(row, state);
  const entrySpread = Number(row.visible_spread || 0);
  const now = new Date();
  const openPositionsBefore = (state.open_positions || []).length;
  const activeRisk = energyActiveRisk(state);
  const pos = {
    position_id: `ET-${Date.now()}-${row.horizon}`,
    decision_id: row.decision_id,
    opened_at: energyIso(now),
    target_exit_at: energyIso(new Date(now.getTime() + energyHorizonMinutes(row.horizon) * 60000)),
    node: row.node,
    horizon: row.horizon,
    signal_source: row.signal_source,
    action: row.paper_action,
    entry_action: row.paper_action,
    expected_exit_action: energyExitAction(row.paper_action, mwh),
    roundtrip_code: energyRoundtripCode(row.paper_action, mwh),
    entry_spread: entrySpread,
    entry_trade_value_usd: energyTradeAmount(entrySpread, mwh),
    mwh,
    status: 'open',
    tier: row.tier,
    model_prediction_mw: row.model_prediction_mw,
    soc: row.soc,
    stop_loss_usd: activeRisk.stop_loss_usd,
    take_profit_usd: activeRisk.take_profit_usd,
    stop_loss_pct: activeRisk.stop_loss_pct,
    take_profit_pct: activeRisk.take_profit_pct,
    risk_source: activeRisk.source,
    risk_path_quality: activeRisk.path_quality,
    mtm_path: [] as any[],
  };
  state.open_positions.push(pos);
  state.seen_decision_ids.push(String(row.decision_id));
  const trade = {
    ts: energyIso(now),
    event: 'OPEN',
    position_id: pos.position_id,
    decision_id: pos.decision_id,
    node: pos.node,
    horizon: pos.horizon,
    signal_source: pos.signal_source,
    action: pos.action,
    entry_action: pos.entry_action,
    expected_exit_action: pos.expected_exit_action,
    roundtrip_code: pos.roundtrip_code,
    price_spread: entrySpread,
    entry_spread: entrySpread,
    mwh,
    entry_trade_value_usd: pos.entry_trade_value_usd,
    exit_trade_value_usd: 0,
    gross_pnl_usd: 0,
    cost_usd: 0,
    net_pnl_usd: 0,
    pnl_pct_of_trade: 0,
    cash_usd: state.cash_usd,
    equity_usd: state.equity_usd,
    open_positions_before: openPositionsBefore,
    open_positions_after: state.open_positions.length,
    stop_loss_usd: pos.stop_loss_usd,
    take_profit_usd: pos.take_profit_usd,
    stop_loss_pct: pos.stop_loss_pct,
    take_profit_pct: pos.take_profit_pct,
    risk_source: pos.risk_source,
    risk_path_quality: pos.risk_path_quality,
    reason: 'AI自动开仓',
  };
  await insertEnergyTrade(env, state.user_id, trade);
  return trade;
}

async function settleEnergyPosition(env: Env, state: any, pos: any, exitSpread: number, reason: string) {
  const mwhAbs = Math.abs(Number(pos.mwh || 0));
  const gross = energyGrossPnl(pos.action, Number(pos.entry_spread || 0), exitSpread, Number(pos.mwh || 0));
  const cost = Number(state.config?.variable_cost_per_mwh || ENERGY_VARIABLE_COST_PER_MWH) * mwhAbs;
  const net = gross - cost;
  const cashBefore = Number(state.cash_usd || 0);
  state.cash_usd = Number(state.cash_usd || 0) + net;
  state.realized_pnl_usd = Number(state.realized_pnl_usd || 0) + net;
  const entryValue = pos.entry_trade_value_usd || energyTradeAmount(pos.entry_spread, pos.mwh);
  const trade = {
    ts: energyIso(),
    event: 'CLOSE',
    position_id: pos.position_id,
    decision_id: pos.decision_id,
    node: pos.node,
    horizon: pos.horizon,
    signal_source: pos.signal_source,
    action: pos.action,
    entry_action: pos.entry_action || pos.action,
    exit_action: energyExitAction(pos.action, pos.mwh),
    roundtrip_code: pos.roundtrip_code || energyRoundtripCode(pos.action, pos.mwh),
    price_spread: exitSpread,
    entry_spread: pos.entry_spread,
    exit_spread: exitSpread,
    spread_delta: Number((exitSpread - Number(pos.entry_spread || 0)).toFixed(4)),
    mwh: pos.mwh,
    entry_trade_value_usd: entryValue,
    exit_trade_value_usd: energyTradeAmount(exitSpread, pos.mwh),
    gross_pnl_usd: gross,
    cost_usd: cost,
    net_pnl_usd: net,
    pnl_pct_of_trade: Number((net / Math.max(Number(entryValue || state.config?.fixed_trade_usd || 1), 1)).toFixed(4)),
    cash_before_usd: cashBefore,
    cash_usd: state.cash_usd,
    mtm_path: pos.mtm_path || [],
    stop_loss_usd: pos.stop_loss_usd || state.config?.stop_loss_usd || 450,
    take_profit_usd: pos.take_profit_usd || state.config?.take_profit_usd || 900,
    stop_loss_pct: pos.stop_loss_pct || energyTradePct(state.config?.stop_loss_usd || 450, state),
    take_profit_pct: pos.take_profit_pct || energyTradePct(state.config?.take_profit_usd || 900, state),
    reason,
  };
  state.closed_trades.push({ ...pos, ...trade, status: 'closed' });
  await insertEnergyTrade(env, state.user_id, trade);
  return trade;
}

async function energyTick(env: Env, state: any, forceSettle = false) {
  const now = new Date();
  const rows = buildEnergyMarketRows(now);
  const currentSpread = Number(rows[0]?.visible_spread || 0);
  const remaining: any[] = [];
  const activeRisk = energyActiveRisk(state);
  let settled = 0;
  let opened = 0;
  for (const pos of state.open_positions || []) {
    const due = forceSettle || new Date(pos.target_exit_at).getTime() <= now.getTime();
    const unrealized = energyGrossPnl(pos.action, Number(pos.entry_spread || 0), currentSpread, Number(pos.mwh || 0)) -
      Number(state.config?.variable_cost_per_mwh || ENERGY_VARIABLE_COST_PER_MWH) * Math.abs(Number(pos.mwh || 0));
    const mtmPath = Array.isArray(pos.mtm_path) ? pos.mtm_path : [];
    mtmPath.push({
      ts: energyIso(now),
      price_spread: currentSpread,
      unrealized_pnl_usd: Number(unrealized.toFixed(2)),
      pnl_pct_of_trade: Number((unrealized / Math.max(Number(pos.entry_trade_value_usd || state.config?.fixed_trade_usd || 1), 1)).toFixed(4)),
    });
    const nextPos = { ...pos, mtm_path: mtmPath.slice(-240), unrealized_pnl_usd: unrealized };
    const takeProfit = Number(pos.take_profit_usd || activeRisk.take_profit_usd || state.config?.take_profit_usd || 900);
    const stopLoss = Number(pos.stop_loss_usd || activeRisk.stop_loss_usd || state.config?.stop_loss_usd || 450);
    if (due || unrealized >= takeProfit || unrealized <= -stopLoss) {
      await settleEnergyPosition(env, state, nextPos, currentSpread, due ? '到期结算' : (unrealized > 0 ? '止盈结算' : '止损结算'));
      settled += 1;
    } else {
      remaining.push(nextPos);
    }
  }
  state.open_positions = remaining;
  if (!forceSettle && state.mode === 'running') {
    const candidates = rows
      .filter((row) => !state.seen_decision_ids.includes(String(row.decision_id)))
      .sort((a, b) => Math.abs(Number(b.model_prediction_mw || 0)) - Math.abs(Number(a.model_prediction_mw || 0)));
    for (const row of candidates) {
      const reason = canOpenEnergyPosition(row, state);
      if (!reason) {
        await openEnergyPosition(env, state, row);
        opened += 1;
      } else {
        const segment = energySegmentStats(state, row);
        await insertEnergyTrade(env, state.user_id, {
          ts: energyIso(now),
          event: 'SKIP',
          decision_id: row.decision_id,
          node: row.node,
          horizon: row.horizon,
          signal_source: row.signal_source,
          action: row.paper_action,
          price_spread: row.visible_spread,
          mwh: 0,
          entry_trade_value_usd: 0,
          exit_trade_value_usd: 0,
          net_pnl_usd: 0,
          segment_count: segment.count,
          segment_win_rate: Number(segment.win_rate.toFixed(4)),
          segment_expectancy_usd: Number(segment.expectancy_usd.toFixed(2)),
          segment_profit_factor: Number(segment.profit_factor.toFixed(3)),
          reason,
        });
        state.seen_decision_ids.push(String(row.decision_id));
      }
    }
  }
  markEnergyEquity(state);
  return { rows, opened, settled };
}

async function energyTradingDashboard(request: Request, env: Env, url: URL) {
  const userId = energyUserId(request, url);
  const state = await loadEnergyAccount(env, userId);
  const rows = buildEnergyMarketRows();
  markEnergyEquity(state);
  const unrealizedPnl = energyUnrealizedPnl(state);
  const trades = await recentEnergyTrades(env, userId, 120);
  const riskOptimization = energyRiskOptimization(state);
  const winRateDiagnostics = energyWinRateDiagnostics(state);
  return json({
    ok: true,
    online_backend: Boolean(env.ENERGY_TRADING_DB),
    db_status: env.ENERGY_TRADING_DB ? 'd1_bound' : 'not_configured',
    version: ENERGY_TRADING_VERSION,
    updated_at: energyIso(),
    market_health: {
      ok: true,
      status: 'online_simulated_market',
      latest_captured_at: rows[0]?.captured_at,
      rows: rows.length,
      note: '线上 Worker 生成 CAISO 风格模拟快照；不依赖本地服务。',
    },
    decisions: rows,
    summary: {
      mode: state.mode,
      equity_usd: state.equity_usd,
      cash_usd: state.cash_usd,
      settled_equity_usd: state.cash_usd,
      realized_pnl_usd: state.realized_pnl_usd,
      unrealized_pnl_usd: unrealizedPnl,
      open_positions: (state.open_positions || []).length,
      max_open_positions: state.config?.max_open_positions || 10,
      win_rate: (state.closed_trades || []).length
        ? (state.closed_trades || []).filter((trade: any) => Number(trade.net_pnl_usd || 0) > 0).length / (state.closed_trades || []).length
        : 0,
      config: state.config,
    },
    account: state,
    recent_trades: trades,
    risk_optimization: riskOptimization,
    win_rate_diagnostics: winRateDiagnostics,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function energyTradingHistory(request: Request, env: Env, url: URL) {
  const userId = energyUserId(request, url);
  const limit = Math.max(10, Math.min(Number(url.searchParams.get('limit') || 200), 500));
  const state = await loadEnergyAccount(env, userId);
  markEnergyEquity(state);
  const unrealizedPnl = energyUnrealizedPnl(state);
  const trades = await recentEnergyTrades(env, userId, limit);
  const riskOptimization = energyRiskOptimization(state);
  const winRateDiagnostics = energyWinRateDiagnostics(state);
  return json(
    {
      ok: true,
      online_backend: Boolean(env.ENERGY_TRADING_DB),
      user_id: userId,
      summary: {
        mode: state.mode,
        equity_usd: state.equity_usd,
        cash_usd: state.cash_usd,
        settled_equity_usd: state.cash_usd,
        realized_pnl_usd: state.realized_pnl_usd,
        unrealized_pnl_usd: unrealizedPnl,
        open_positions: (state.open_positions || []).length,
        closed_trades: (state.closed_trades || []).length,
      },
      records: trades,
      risk_optimization: riskOptimization,
      win_rate_diagnostics: winRateDiagnostics,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function energyTradingStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = energyUserId(request, url, body);
  const existing = await loadEnergyAccount(env, userId);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultEnergyTradingAccount(userId, body) : existing;
  const cfg = state.config || {};
  state.config = {
    ...cfg,
    fixed_trade_usd: Number(body.fixed_trade_usd || cfg.fixed_trade_usd || 10_000),
    max_position_pct: Number(body.max_position_pct || cfg.max_position_pct || 0.08),
    max_open_positions: Number(body.max_open_positions || cfg.max_open_positions || 10),
    max_order_mwh: Number(body.max_order_mwh || cfg.max_order_mwh || 25),
    min_abs_spread: Number(body.min_abs_spread || cfg.min_abs_spread || 4.5),
    min_abs_prediction_mw: Number(body.min_abs_prediction_mw || cfg.min_abs_prediction_mw || 100),
    stop_loss_usd: Number(body.stop_loss_usd || cfg.stop_loss_usd || 450),
    take_profit_usd: Number(body.take_profit_usd || cfg.take_profit_usd || 900),
    strategy: String(body.strategy || cfg.strategy || 'qhopf_selector'),
    sizing_mode: String(body.sizing_mode || cfg.sizing_mode || 'fixed_usd'),
  };
  if (body.capital_usd && isFresh) {
    state.initial_cash_usd = Number(body.capital_usd);
    state.cash_usd = Number(body.capital_usd);
    state.equity_usd = Number(body.capital_usd);
    state.peak_equity_usd = Number(body.capital_usd);
  }
  state.mode = 'running';
  state.started_at = state.started_at || energyIso();
  state.stopped_at = '';
  state.last_tick_at = energyIso();
  await energyTick(env, state, false);
  await saveEnergyAccount(env, state);
  return json({ ok: true, action: 'started', user_id: userId, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function energyTradingTick(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = energyUserId(request, url, body);
  const state = await loadEnergyAccount(env, userId);
  const result = await energyTick(env, state, false);
  state.last_tick_at = energyIso();
  await saveEnergyAccount(env, state);
  return json({ ok: true, user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function energyTradingStop(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = energyUserId(request, url, body);
  const state = await loadEnergyAccount(env, userId);
  const result = await energyTick(env, state, Boolean(body?.liquidate !== false));
  state.mode = 'stopped';
  state.stopped_at = energyIso();
  state.last_tick_at = energyIso();
  await saveEnergyAccount(env, state);
  return json({ ok: true, action: 'stopped', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

const MARKET_TRADING_VERSION = 'HFCD_Trading_V1_MultiMarket_PaperEngine';
const MARKET_SYMBOLS = [...MULTI_MARKET_TRADING_CONFIG.symbols];
const MARKET_FEE_RATE = 0.0006;
const CRYPTO_TESTNET_VERSION = 'HFCD_Trading_V3_5_ShortSensorUpgrade';
const CRYPTO_TESTNET_SYMBOLS: any[] = [
  {
    symbol: 'BTCUSDT',
    name: 'Bitcoin USDT Perpetual',
    asset_class: 'crypto_perp',
    cadence: '1h',
    route: 'btc_shortvol_1h_v3_0',
    route_status: 'main',
    side_policy: 'both',
    validated_side_policy: 'long_only',
    short_policy_status: 'forward_shadow_enabled',
    market_data_source: 'binance_futures_public',
    exchange_tradeable: true,
    quantity_precision: 3,
    min_signal_score: 0.66,
    long_min_signal_score: 0.66,
    blind_test: { test_net_pnl_usd: 14.25, profit_factor: 1.64, policy: '1h long_only' },
  },
  {
    symbol: 'SOLUSDT',
    name: 'Solana USDT Perpetual',
    asset_class: 'crypto_perp',
    cadence: '1h',
    route: 'sol_shortvol_1h_v3_0',
    route_status: 'main',
    side_policy: 'both',
    validated_side_policy: 'long_only',
    short_policy_status: 'forward_shadow_enabled',
    market_data_source: 'binance_futures_public',
    exchange_tradeable: true,
    quantity_precision: 1,
    min_signal_score: 0.66,
    long_min_signal_score: 0.66,
    blind_test: { test_net_pnl_usd: 14.68, profit_factor: 1.33, policy: '1h long_only' },
  },
  {
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF',
    asset_class: 'equity_etf',
    cadence: '1h',
    route: 'spy_shortvol_1h_v3_0',
    route_status: 'main',
    side_policy: 'both',
    validated_side_policy: 'long_only',
    short_policy_status: 'forward_shadow_enabled',
    market_data_source: 'yahoo_chart',
    exchange_tradeable: false,
    min_signal_score: 0.66,
    long_min_signal_score: 0.66,
    estimated_spread_bps: 1.5,
    blind_test: { test_net_pnl_usd: 30.89, profit_factor: 6.57, policy: '1h long_only' },
  },
  {
    symbol: 'QQQ',
    name: 'Invesco QQQ ETF',
    asset_class: 'equity_etf',
    cadence: '15m',
    route: 'qqq_shortvol_15m_v3_0',
    route_status: 'main',
    side_policy: 'both',
    validated_side_policy: 'long_only',
    short_policy_status: 'forward_shadow_enabled',
    market_data_source: 'yahoo_chart',
    exchange_tradeable: false,
    min_signal_score: 0.66,
    long_min_signal_score: 0.66,
    estimated_spread_bps: 1.8,
    blind_test: { test_net_pnl_usd: 59.66, profit_factor: 3.70, policy: '15m long_only' },
  },
  {
    symbol: 'IWM',
    name: 'iShares Russell 2000 ETF',
    asset_class: 'equity_etf',
    cadence: '1h',
    route: 'iwm_shortvol_1h_v3_0',
    route_status: 'main',
    side_policy: 'both',
    validated_side_policy: 'both',
    short_policy_status: 'v3_5_short_sensor_blind_promoted',
    market_data_source: 'yahoo_chart',
    exchange_tradeable: false,
    min_signal_score: 0.66,
    long_min_signal_score: 0.66,
    short_min_signal_score: 0.60,
    estimated_spread_bps: 2.5,
    blind_test: { test_net_pnl_usd: 26.57, profit_factor: 4.51, policy: '1h long_only' },
    short_blind_test: {
      version: 'HFCD_Trading_V3_5_ShortSensorUpgrade',
      policy: '1h short_only threshold=0.60 hold=3',
      validation_trades: 60,
      validation_net_pnl_usd: 79.0486,
      validation_profit_factor: 1.435415,
      test_trades: 86,
      test_net_pnl_usd: 95.4233,
      test_profit_factor: 1.341328,
    },
  },
];
const CRYPTO_TESTNET_FEE_RATE = 0.0004;
const BINANCE_TESTNET_BASE_URL = 'https://demo-fapi.binance.com';
const GOLD_TRADING_VERSION = 'HFCD_Trading_V1_1_GoldBidirectionalPaperEngine';
const GOLD_SYMBOL = 'GC=F';
const GOLD_FALLBACK_SYMBOL = 'GLD';
const GOLD_FEE_RATE = 0.00045;
const GOLD_SPREAD_BPS = 4;
const GOLD_BASELINE = {
  lineage: 'V1.38 roll-aware clean BBO/MBP paper baseline',
  net_pnl_usd: 1594.137,
  profit_factor: 1.804,
  max_drawdown_usd: -608.99,
  trades: 58,
  note: '离线基线只用于策略说明和阈值参考；线上 paper tick 必须使用实时/准实时行情。',
};
const GOLD_OPPORTUNITY_ROADMAP = [
  { market: '黄金', cadence: '低中频/盘中巡检', status: 'active_online_paper', next: '继续积累 real-time paper ledger' },
  { market: '加密货币', cadence: '中高频，可做更多笔', status: 'planned', next: '接稳定币、清算、盘口深度后独立验证' },
  { market: '股指/ETF', cadence: '中频', status: 'planned', next: '按 SPY/QQQ/行业 ETF 子类拆权重' },
  { market: '电力/价差', cadence: '高频或小时级', status: 'existing_energy_line', next: '沿用能源 paper engine，接真实快照继续跑' },
  { market: '期货子类', cadence: '按品种拆分后扩大机会池', status: 'planned', next: '贵金属/能源/股指/农产品分别建物性门' },
];

function marketHeadFor(symbol: string, assetClass?: string) {
  const symbolHeads = MULTI_MARKET_TRADING_CONFIG.symbol_heads as Record<string, any>;
  const marketHeads = MULTI_MARKET_TRADING_CONFIG.market_heads as Record<string, any>;
  return symbolHeads[symbol] || marketHeads[String(assetClass || '')] || marketHeads.crypto || {};
}

function marketUserId(request: Request, url: URL, body?: any) {
  return energyUserId(request, url, body).replace(/^energy_/, 'market_') || 'wuxing_market_user';
}

function defaultMarketAccount(userId: string, body: any = {}) {
  const capital = Number(body.capital_usd || body.capital || 100_000);
  return {
    version: MARKET_TRADING_VERSION,
    user_id: userId,
    mode: 'stopped',
    started_at: '',
    stopped_at: '',
    initial_cash_usd: capital,
    realized_pnl_usd: 0,
    equity_usd: capital,
    peak_equity_usd: capital,
    max_drawdown_usd: 0,
    open_positions: [] as any[],
    closed_trades: [] as any[],
    seen_signal_ids: [] as string[],
    config: {
      fixed_trade_usd: Number(body.fixed_trade_usd || 1_000),
      max_open_positions: Number(body.max_open_positions || 8),
      max_symbol_positions: Number(body.max_symbol_positions || 2),
      stop_loss_pct: Number(body.stop_loss_pct || 0.018),
      take_profit_pct: Number(body.take_profit_pct || 0.036),
      min_signal_score: Number(body.min_signal_score || MULTI_MARKET_TRADING_CONFIG.global_min_signal_score || 0.72),
      max_holding_minutes: Number(body.max_holding_minutes || 360),
      strategy: String(body.strategy || 'hfcd_stability_momentum'),
    },
  };
}

async function ensureMarketTradingDb(env: Env) {
  const db = env.ENERGY_TRADING_DB;
  if (!db) return null;
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS market_accounts (user_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)',
  ).run();
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS market_trades (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ts TEXT NOT NULL, event TEXT NOT NULL, raw_json TEXT NOT NULL)',
  ).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_market_trades_user_ts ON market_trades(user_id, ts DESC)').run();
  return db;
}

async function loadMarketAccount(env: Env, userId: string) {
  const db = await ensureMarketTradingDb(env);
  if (!db) return defaultMarketAccount(userId);
  const row = await db.prepare('SELECT state_json FROM market_accounts WHERE user_id = ?').bind(userId).first();
  if (!row?.state_json) return defaultMarketAccount(userId);
  try {
    return JSON.parse(String(row.state_json));
  } catch {
    return defaultMarketAccount(userId);
  }
}

async function saveMarketAccount(env: Env, state: any) {
  const db = await ensureMarketTradingDb(env);
  if (!db) return;
  await db
    .prepare('INSERT OR REPLACE INTO market_accounts (user_id, state_json, updated_at) VALUES (?, ?, ?)')
    .bind(state.user_id, JSON.stringify(state), energyIso())
    .run();
}

async function insertMarketTrade(env: Env, userId: string, row: any) {
  const db = await ensureMarketTradingDb(env);
  if (!db) return;
  const id = row.id || `${userId}-${row.ts}-${row.event}-${row.position_id || row.signal_id || Math.random()}`;
  await db
    .prepare('INSERT OR REPLACE INTO market_trades (id, user_id, ts, event, raw_json) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, row.ts, row.event, JSON.stringify({ ...row, id }))
    .run();
}

async function recentMarketTrades(env: Env, userId: string, limit = 100) {
  const db = await ensureMarketTradingDb(env);
  if (!db) return [];
  const rows = await db
    .prepare('SELECT raw_json FROM market_trades WHERE user_id = ? ORDER BY ts DESC LIMIT ?')
    .bind(userId, limit)
    .all();
  return (rows.results || []).map((row: any) => {
    try {
      return JSON.parse(String(row.raw_json));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function marketStd(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function fallbackMarketSeries(symbol: string) {
  const meta = MARKET_SYMBOLS.find((row) => row.symbol === symbol) || MARKET_SYMBOLS[0];
  const base = symbol === 'BTC-USD' ? 64000 : symbol === 'ETH-USD' ? 3200 : symbol === 'SPY' ? 520 : symbol === 'QQQ' ? 440 : 210;
  const now = Date.now();
  const rows = Array.from({ length: 96 }, (_, index) => {
    const t = now - (95 - index) * 5 * 60000;
    const wave = Math.sin(t / 3600000 + symbol.length) * 0.012 + Math.sin(t / 86400000 + symbol.charCodeAt(0)) * 0.018;
    return { ts: new Date(t).toISOString(), close: Number((base * (1 + wave)).toFixed(4)) };
  });
  return { ...meta, source: 'fallback_simulated', rows };
}

async function fetchYahooMarketSeries(symbol: string) {
  const meta = MARKET_SYMBOLS.find((row) => row.symbol === symbol) || MARKET_SYMBOLS[0];
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=60d&interval=1h`,
      {
        headers: {
          accept: 'application/json',
          'user-agent': 'HFCD-ThingNature-OS/1.0',
        },
      },
    );
    if (!response.ok) throw new Error(`Yahoo ${symbol} ${response.status}`);
    const payload: any = await response.json();
    const result = payload?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close || [];
    const rows = timestamps.map((ts, index) => ({
      ts: new Date(ts * 1000).toISOString(),
      close: closes[index] === null ? NaN : Number(closes[index]),
    })).filter((row) => Number.isFinite(row.close) && row.close > 0);
    if (rows.length < 20) throw new Error(`Yahoo ${symbol} insufficient rows`);
    return { ...meta, source: 'yahoo_chart', rows };
  } catch {
    return fallbackMarketSeries(symbol);
  }
}

function buildMarketSignal(series: any) {
  const head = marketHeadFor(series.symbol, series.asset_class);
  const fastBars = Number(head.fast_bars || 3);
  const midBars = Number(head.mid_bars || 12);
  const longBars = Number(head.long_bars || 48);
  const headThreshold = Number(head.min_signal_score || MULTI_MARKET_TRADING_CONFIG.global_min_signal_score || 0.72);
  const rows = series.rows || [];
  const closes = rows.map((row: any) => Number(row.close)).filter((value: number) => Number.isFinite(value) && value > 0);
  const last = closes[closes.length - 1] || 0;
  const prev = closes[closes.length - 2] || last;
  const fastBase = closes[Math.max(0, closes.length - 1 - fastBars)] || prev;
  const midBase = closes[Math.max(0, closes.length - 1 - midBars)] || fastBase;
  const longBase = closes[Math.max(0, closes.length - 1 - longBars)] || midBase;
  const returns = closes.slice(-Math.max(longBars, 36)).map((value: number, index: number, arr: number[]) => index === 0 ? 0 : value / arr[index - 1] - 1).slice(1);
  const vol = Math.max(marketStd(returns), 0.0008);
  const r1 = last / prev - 1;
  const rFast = last / fastBase - 1;
  const rMid = last / midBase - 1;
  const rLong = last / longBase - 1;
  const trendScore = Math.max(-1.4, Math.min(1.4, (0.42 * rFast + 0.36 * rMid + 0.22 * rLong) / vol));
  const action = trendScore >= headThreshold ? 'BUY_LONG' : trendScore <= -headThreshold ? 'SELL_SHORT' : 'NO_TRADE';
  const absScore = Math.abs(trendScore);
  const confidence = Math.max(0, Math.min(0.99, 0.45 + absScore * 0.25));
  const latestTs = rows[rows.length - 1]?.ts || energyIso();
  return {
    signal_id: `${series.symbol}-${Math.floor(new Date(latestTs).getTime() / 300000)}-${action}`,
    captured_at: latestTs,
    symbol: series.symbol,
    name: series.name,
    asset_class: series.asset_class,
    session: series.session,
    price: Number(last.toFixed(series.symbol.includes('-USD') ? 2 : 4)),
    action,
    score: Number(absScore.toFixed(4)),
    signed_score: Number(trendScore.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    realized_vol_5m: Number(vol.toFixed(6)),
    r1: Number(r1.toFixed(6)),
    r6: Number(rFast.toFixed(6)),
    r24: Number(rMid.toFixed(6)),
    r_long: Number(rLong.toFixed(6)),
    head_version: MULTI_MARKET_TRADING_CONFIG.version,
    head_status: head.symbol_status || head.status || 'unverified',
    head_threshold: Number(headThreshold.toFixed(4)),
    holding_bars: Number(head.holding_bars || 6),
    stop_loss_pct: Number(head.stop_loss_pct || 0.018),
    take_profit_pct: Number(head.take_profit_pct || 0.036),
    source: series.source,
    status: action === 'NO_TRADE' ? 'rejected' : 'accepted',
    reject_reason: action === 'NO_TRADE' ? 'signal_underthreshold' : '',
  };
}

async function buildMarketSignals() {
  const seriesList = await Promise.all(MARKET_SYMBOLS.map((row) => fetchYahooMarketSeries(row.symbol)));
  const signals = seriesList.map(buildMarketSignal);
  return {
    generated_at: energyIso(),
    source_status: signals.every((signal) => signal.source === 'yahoo_chart') ? 'live_public_market_data' : 'mixed_or_fallback',
    signals,
  };
}

function goldUserId(request: Request, url: URL, body?: any) {
  return energyUserId(request, url, body).replace(/^energy_/, 'gold_') || 'wuxing_gold_user';
}

function goldStorageUserId(userId: string) {
  return `gold_${String(userId).replace(/[^\w.-]/g, '_').slice(0, 64)}`;
}

function defaultGoldAccount(userId: string, body: any = {}) {
  const capital = Number(body.capital_usd || body.capital || 100_000);
  return {
    version: GOLD_TRADING_VERSION,
    user_id: goldStorageUserId(userId),
    display_user_id: userId,
    mode: 'stopped',
    started_at: '',
    stopped_at: '',
    initial_cash_usd: capital,
    realized_pnl_usd: 0,
    equity_usd: capital,
    peak_equity_usd: capital,
    max_drawdown_usd: 0,
    open_positions: [] as any[],
    closed_trades: [] as any[],
    seen_signal_ids: [] as string[],
    config: {
      fixed_trade_usd: Number(body.fixed_trade_usd || 5_000),
      max_open_positions: Number(body.max_open_positions || 4),
      max_symbol_positions: Number(body.max_symbol_positions || 1),
      stop_loss_pct: Number(body.stop_loss_pct || 0.012),
      take_profit_pct: Number(body.take_profit_pct || 0.024),
      min_signal_score: Number(body.min_signal_score || 1.1),
      max_holding_minutes: Number(body.max_holding_minutes || 24 * 60),
      strategy: String(body.strategy || 'v1_38_real_time_gold_bidirectional_anchor'),
      side_policy: String(body.side_policy || 'both'),
      allow_short: body.allow_short !== false,
    },
  };
}

function normalizeGoldAccount(state: any, userId: string, body: any = {}) {
  const defaults = defaultGoldAccount(userId, body);
  const normalized = {
    ...defaults,
    ...state,
    config: {
      ...defaults.config,
      ...(state?.config || {}),
    },
  };
  normalized.display_user_id = normalized.display_user_id || userId;
  normalized.user_id = normalized.user_id || goldStorageUserId(userId);
  if (!normalized.config.side_policy) normalized.config.side_policy = 'both';
  if (normalized.config.allow_short === undefined || state?.version !== GOLD_TRADING_VERSION) {
    normalized.config.allow_short = true;
  }
  return normalized;
}

async function loadGoldAccount(env: Env, userId: string, body: any = {}) {
  const storageId = goldStorageUserId(userId);
  const db = await ensureMarketTradingDb(env);
  if (!db) return defaultGoldAccount(userId, body);
  const row = await db.prepare('SELECT state_json FROM market_accounts WHERE user_id = ?').bind(storageId).first();
  if (!row?.state_json) return defaultGoldAccount(userId, body);
  try {
    return normalizeGoldAccount(JSON.parse(String(row.state_json)), userId, body);
  } catch {
    return defaultGoldAccount(userId, body);
  }
}

async function saveGoldAccount(env: Env, state: any) {
  state.version = GOLD_TRADING_VERSION;
  state.user_id = goldStorageUserId(state.display_user_id || state.user_id || 'wuxing_gold_user');
  await saveMarketAccount(env, state);
}

async function recentGoldTrades(env: Env, userId: string, limit = 120) {
  return recentMarketTrades(env, goldStorageUserId(userId), limit);
}

async function insertGoldTrade(env: Env, userId: string, row: any) {
  return insertMarketTrade(env, goldStorageUserId(userId), row);
}

function clampGold(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

async function fetchGoldRealtimeSeries() {
  const fetchSymbol = async (symbol: string, label: string) => {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m`,
      {
        headers: {
          accept: 'application/json',
          'user-agent': 'HFCD-ThingNature-OS/1.0',
        },
      },
    );
    if (!response.ok) throw new Error(`Yahoo ${symbol} ${response.status}`);
    const payload: any = await response.json();
    const result = payload?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const rows = timestamps.map((ts, index) => ({
      ts: new Date(ts * 1000).toISOString(),
      close: quote.close?.[index] === null ? NaN : Number(quote.close?.[index]),
      volume: quote.volume?.[index] === null ? 0 : Number(quote.volume?.[index] || 0),
    })).filter((row) => Number.isFinite(row.close) && row.close > 0);
    if (rows.length < 40) throw new Error(`Yahoo ${symbol} insufficient rows`);
    return {
      symbol,
      name: label,
      asset_class: 'gold_futures',
      source: `yahoo_chart:${symbol}:5m`,
      source_quality: 'public_real_time_or_delayed',
      is_real_market_data: true,
      rows,
    };
  };

  try {
    return await fetchSymbol(GOLD_SYMBOL, 'COMEX Gold Futures');
  } catch {
    try {
      return await fetchSymbol(GOLD_FALLBACK_SYMBOL, 'SPDR Gold ETF');
    } catch {
      const now = Date.now();
      const base = 2350;
      const rows = Array.from({ length: 96 }, (_, index) => {
        const t = now - (95 - index) * 5 * 60000;
        const wave = Math.sin(t / 5400000) * 0.004 + Math.sin(t / 86400000) * 0.006;
        return { ts: new Date(t).toISOString(), close: Number((base * (1 + wave)).toFixed(2)), volume: 0 };
      });
      return {
        symbol: GOLD_SYMBOL,
        name: 'COMEX Gold Futures',
        asset_class: 'gold_futures',
        source: 'fallback_simulated_gold',
        source_quality: 'fallback_not_tradeable',
        is_real_market_data: false,
        rows,
      };
    }
  }
}

function buildGoldSignal(series: any, minSignalScore = 1.1) {
  const rows = series.rows || [];
  const closes = rows.map((row: any) => Number(row.close)).filter((value: number) => Number.isFinite(value) && value > 0);
  const last = closes[closes.length - 1] || 0;
  const prev = closes[closes.length - 2] || last;
  const oneHourBase = closes[Math.max(0, closes.length - 1 - 12)] || prev;
  const sixHourBase = closes[Math.max(0, closes.length - 1 - 72)] || oneHourBase;
  const dayBase = closes[Math.max(0, closes.length - 1 - 288)] || sixHourBase;
  const returns = closes.slice(-288).map((value: number, index: number, arr: number[]) => index === 0 ? 0 : value / arr[index - 1] - 1).slice(1);
  const realizedVol = Math.max(marketStd(returns), 0.0005);
  const r1 = last / prev - 1;
  const r12 = last / oneHourBase - 1;
  const r72 = last / sixHourBase - 1;
  const r288 = last / dayBase - 1;
  const trendZ = (0.46 * r12 + 0.34 * r72 + 0.2 * r288) / realizedVol;
  const maxClose = Math.max(...closes.slice(-288), last);
  const drawdown = maxClose > 0 ? (last / maxClose - 1) : 0;
  const qCore = clampGold(0.72 + Math.max(-0.22, Math.min(0.16, trendZ * 0.04)) + drawdown * 2.5);
  const noisePenalty = clampGold((realizedVol - 0.0012) * 120, 0, 0.35);
  const directionalScore = Math.max(0, Math.abs(trendZ) * (0.72 + 0.28 * qCore) - noisePenalty);
  const action = directionalScore >= minSignalScore ? (trendZ >= 0 ? 'BUY_LONG' : 'SELL_SHORT') : 'NO_TRADE';
  const side = action === 'BUY_LONG' ? 'long' : action === 'SELL_SHORT' ? 'short' : '-';
  const latestTs = rows[rows.length - 1]?.ts || energyIso();
  const spreadBps = series.symbol === GOLD_SYMBOL ? GOLD_SPREAD_BPS : 6;
  const price = Number(last.toFixed(series.symbol === GOLD_SYMBOL ? 1 : 3));
  return {
    signal_id: `GOLD-${series.symbol}-${Math.floor(new Date(latestTs).getTime() / 300000)}-${action}`,
    captured_at: latestTs,
    symbol: series.symbol,
    name: series.name,
    asset_class: series.asset_class,
    price,
    bid_price: Number((price * (1 - spreadBps / 20000)).toFixed(4)),
    ask_price: Number((price * (1 + spreadBps / 20000)).toFixed(4)),
    spread_bps: spreadBps,
    action,
    side,
    score: Number(directionalScore.toFixed(4)),
    signed_score: Number(trendZ.toFixed(4)),
    q_core: Number(qCore.toFixed(4)),
    realized_vol_5m: Number(realizedVol.toFixed(6)),
    r1: Number(r1.toFixed(6)),
    r12: Number(r12.toFixed(6)),
    r72: Number(r72.toFixed(6)),
    r288: Number(r288.toFixed(6)),
    head_version: GOLD_TRADING_VERSION,
    head_status: 'online_paper_candidate',
    head_threshold: Number(minSignalScore.toFixed(4)),
    holding_minutes: 24 * 60,
    stop_loss_pct: 0.012,
    take_profit_pct: 0.024,
    source: series.source,
    source_quality: series.source_quality,
    is_real_market_data: Boolean(series.is_real_market_data),
    status: action === 'NO_TRADE' ? 'rejected' : 'accepted',
    reject_reason: action === 'NO_TRADE' ? '黄金实时多空信号未达 V1.38 门槛' : '',
  };
}

async function buildGoldSnapshot(minSignalScore = 1.1) {
  const series = await fetchGoldRealtimeSeries();
  const signal = buildGoldSignal(series, minSignalScore);
  return {
    generated_at: energyIso(),
    source_status: signal.is_real_market_data ? 'real_public_market_data' : 'fallback_no_trade',
    primary_source: signal.source,
    signal,
    signals: [signal],
    quote: {
      symbol: signal.symbol,
      price: signal.price,
      bid_price: signal.bid_price,
      ask_price: signal.ask_price,
      spread_bps: signal.spread_bps,
      captured_at: signal.captured_at,
      source: signal.source,
      is_real_market_data: signal.is_real_market_data,
    },
  };
}

function goldPositionPnl(pos: any, currentPrice: number) {
  const qty = Math.abs(Number(pos.quantity || 0));
  if (pos.side === 'long') return (currentPrice - Number(pos.entry_price || 0)) * qty;
  if (pos.side === 'short') return (Number(pos.entry_price || 0) - currentPrice) * qty;
  return 0;
}

function markGoldEquity(state: any, signal?: any) {
  let unrealized = 0;
  for (const pos of state.open_positions || []) {
    const price = Number(signal?.price || pos.last_price || pos.entry_price || 0);
    const pnl = goldPositionPnl(pos, price) - Number(pos.estimated_fee_usd || 0);
    pos.last_price = price;
    pos.unrealized_pnl_usd = Number(pnl.toFixed(2));
    unrealized += pnl;
  }
  state.unrealized_pnl_usd = Number(unrealized.toFixed(2));
  state.equity_usd = Number((Number(state.initial_cash_usd || 0) + Number(state.realized_pnl_usd || 0) + unrealized).toFixed(2));
  state.peak_equity_usd = Math.max(Number(state.peak_equity_usd || state.equity_usd), state.equity_usd);
  state.max_drawdown_usd = Math.min(Number(state.max_drawdown_usd || 0), state.equity_usd - Number(state.peak_equity_usd || state.equity_usd));
}

function canOpenGoldPosition(signal: any, state: any) {
  const cfg = state.config || {};
  if (state.mode !== 'running') return 'AI未运行';
  if (!signal.is_real_market_data) return '没有真实实时行情，禁止开仓';
  if (!['BUY_LONG', 'SELL_SHORT'].includes(String(signal.action || ''))) return '信号未达黄金交易标准';
  if (signal.action === 'SELL_SHORT' && (cfg.allow_short === false || cfg.side_policy === 'long_only')) return '黄金做空未启用';
  if (signal.action === 'BUY_LONG' && cfg.side_policy === 'short_only') return '黄金做多未启用';
  if (Number(signal.score || 0) < Number(cfg.min_signal_score || 1.1)) return '黄金融合分数不足';
  if ((state.open_positions || []).length >= Number(cfg.max_open_positions || 4)) return '达到最大持仓数';
  const sameSymbol = (state.open_positions || []).filter((pos: any) => pos.symbol === signal.symbol).length;
  if (sameSymbol >= Number(cfg.max_symbol_positions || 1)) return '黄金单标的持仓已满';
  if ((state.seen_signal_ids || []).includes(String(signal.signal_id))) return '本轮黄金信号已处理';
  return '';
}

async function openGoldPosition(env: Env, state: any, signal: any) {
  const cfg = state.config || {};
  const notional = Math.min(Number(cfg.fixed_trade_usd || 5_000), Number(state.equity_usd || state.initial_cash_usd || 0) * 0.25);
  const side = signal.action === 'SELL_SHORT' ? 'short' : 'long';
  const fillPrice = side === 'short'
    ? Number(signal.bid_price || signal.price)
    : Number(signal.ask_price || signal.price);
  const quantity = notional / Math.max(fillPrice, 0.0001);
  const fee = notional * GOLD_FEE_RATE;
  const pos = {
    position_id: `GOLD-${Date.now()}-${signal.symbol}`,
    signal_id: signal.signal_id,
    opened_at: energyIso(),
    target_exit_at: energyIso(new Date(Date.now() + Number(cfg.max_holding_minutes || 24 * 60) * 60000)),
    symbol: signal.symbol,
    name: signal.name,
    asset_class: signal.asset_class,
    side,
    action: signal.action,
    entry_price: fillPrice,
    last_price: signal.price,
    quantity,
    notional_usd: notional,
    estimated_fee_usd: fee,
    stop_loss_usd: notional * Number(cfg.stop_loss_pct || 0.012),
    take_profit_usd: notional * Number(cfg.take_profit_pct || 0.024),
    score: signal.score,
    q_core: signal.q_core,
    source: signal.source,
    source_quality: signal.source_quality,
    status: 'open',
  };
  state.open_positions.push(pos);
  state.seen_signal_ids.push(String(signal.signal_id));
  const trade = {
    ts: energyIso(),
    event: 'OPEN',
    position_id: pos.position_id,
    signal_id: signal.signal_id,
    symbol: signal.symbol,
    asset_class: signal.asset_class,
    side,
    action: signal.action,
    price: fillPrice,
    quantity,
    trade_value_usd: notional,
    net_pnl_usd: 0,
    score: signal.score,
    q_core: signal.q_core,
    source: signal.source,
    reason: side === 'short' ? '黄金 AI 按真实实时行情达标做空信号开仓' : '黄金 AI 按真实实时行情达标做多信号开仓',
  };
  await insertGoldTrade(env, state.display_user_id || state.user_id, trade);
  return trade;
}

async function closeGoldPosition(env: Env, state: any, pos: any, signal: any, reason: string) {
  const exitPrice = pos.side === 'short'
    ? Number(signal?.ask_price || signal?.price || pos.last_price || pos.entry_price)
    : Number(signal?.bid_price || signal?.price || pos.last_price || pos.entry_price);
  const gross = goldPositionPnl(pos, exitPrice);
  const fee = Number(pos.notional_usd || 0) * GOLD_FEE_RATE;
  const net = gross - Number(pos.estimated_fee_usd || 0) - fee;
  state.realized_pnl_usd = Number((Number(state.realized_pnl_usd || 0) + net).toFixed(2));
  const trade = {
    ts: energyIso(),
    event: 'CLOSE',
    position_id: pos.position_id,
    signal_id: pos.signal_id,
    symbol: pos.symbol,
    asset_class: pos.asset_class,
    side: pos.side,
    action: pos.side === 'short' ? 'BUY_TO_COVER' : 'SELL_TO_CLOSE',
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    quantity: pos.quantity,
    trade_value_usd: Math.abs(exitPrice * Number(pos.quantity || 0)),
    gross_pnl_usd: Number(gross.toFixed(2)),
    cost_usd: Number((Number(pos.estimated_fee_usd || 0) + fee).toFixed(2)),
    net_pnl_usd: Number(net.toFixed(2)),
    score: pos.score,
    q_core: signal?.q_core ?? pos.q_core,
    source: signal?.source || pos.source,
    reason,
  };
  state.closed_trades.push({ ...pos, ...trade, status: 'closed' });
  await insertGoldTrade(env, state.display_user_id || state.user_id, trade);
  return trade;
}

async function goldTradingTickInternal(env: Env, state: any, forceClose = false) {
  const snapshot = await buildGoldSnapshot(Number(state.config?.min_signal_score || 1.1));
  const signal = snapshot.signal;
  const remaining: any[] = [];
  let opened = 0;
  let closed = 0;
  for (const pos of state.open_positions || []) {
    const pnl = goldPositionPnl(pos, Number(signal.price || pos.last_price || pos.entry_price)) - Number(pos.estimated_fee_usd || 0);
    const due = forceClose || new Date(pos.target_exit_at).getTime() <= Date.now();
    if (due || pnl >= Number(pos.take_profit_usd || 0) || pnl <= -Number(pos.stop_loss_usd || 0)) {
      const reason = due ? '到期/停止结算' : pnl > 0 ? '止盈结算' : '止损结算';
      await closeGoldPosition(env, state, pos, signal, reason);
      closed += 1;
    } else {
      remaining.push({ ...pos, last_price: signal.price, unrealized_pnl_usd: Number(pnl.toFixed(2)) });
    }
  }
  state.open_positions = remaining;
  markGoldEquity(state, signal);
  if (!forceClose && state.mode === 'running') {
    const reason = canOpenGoldPosition(signal, state);
    if (!reason) {
      await openGoldPosition(env, state, signal);
      opened += 1;
    } else {
      await insertGoldTrade(env, state.display_user_id || state.user_id, {
        ts: energyIso(),
        event: 'SKIP',
        signal_id: signal.signal_id,
        symbol: signal.symbol,
        asset_class: signal.asset_class,
        action: signal.action,
        price: signal.price,
        trade_value_usd: 0,
        net_pnl_usd: 0,
        score: signal.score,
        q_core: signal.q_core,
        source: signal.source,
        reason,
      });
      state.seen_signal_ids.push(String(signal.signal_id));
    }
  }
  markGoldEquity(state, signal);
  return { snapshot, opened, closed };
}

function goldWinRate(state: any) {
  const trades = (state.closed_trades || []).filter((row: any) => Number.isFinite(Number(row.net_pnl_usd)));
  if (!trades.length) return 0;
  return trades.filter((row: any) => Number(row.net_pnl_usd || 0) > 0).length / trades.length;
}

async function goldTradingDashboard(request: Request, env: Env, url: URL) {
  const userId = goldUserId(request, url);
  const state = await loadGoldAccount(env, userId);
  const snapshot = await buildGoldSnapshot(Number(state.config?.min_signal_score || 1.1));
  markGoldEquity(state, snapshot.signal);
  const trades = await recentGoldTrades(env, userId, 160);
  return json({
    ok: true,
    online_backend: Boolean(env.ENERGY_TRADING_DB),
    db_status: env.ENERGY_TRADING_DB ? 'd1_bound' : 'not_configured',
    version: GOLD_TRADING_VERSION,
    updated_at: energyIso(),
    data_policy: {
      live_required_for_trade: true,
      realtime_source: snapshot.primary_source,
      realtime_status: snapshot.source_status,
      note: '交易 tick 使用线上实时/准实时黄金行情；fallback 模拟行情只展示，不允许开仓。',
      databento_ready: Boolean(env.DATABENTO_API_KEY),
    },
    baseline: GOLD_BASELINE,
    opportunity_roadmap: GOLD_OPPORTUNITY_ROADMAP,
    quote: snapshot.quote,
    signals: snapshot.signals,
    summary: {
      mode: state.mode,
      initial_cash_usd: state.initial_cash_usd,
      equity_usd: state.equity_usd,
      realized_pnl_usd: state.realized_pnl_usd,
      unrealized_pnl_usd: state.unrealized_pnl_usd || 0,
      open_positions: (state.open_positions || []).length,
      max_open_positions: state.config?.max_open_positions || 4,
      closed_trades: (state.closed_trades || []).length,
      win_rate: goldWinRate(state),
      max_drawdown_usd: state.max_drawdown_usd || 0,
      config: state.config,
    },
    positions: state.open_positions || [],
    recent_trades: trades,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function goldTradingStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = goldUserId(request, url, body);
  const existing = await loadGoldAccount(env, userId, body);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultGoldAccount(userId, body) : existing;
  state.display_user_id = userId;
  state.config = {
    ...(state.config || {}),
    fixed_trade_usd: Number(body.fixed_trade_usd || state.config?.fixed_trade_usd || 5_000),
    max_open_positions: Number(body.max_open_positions || state.config?.max_open_positions || 4),
    max_symbol_positions: Number(body.max_symbol_positions || state.config?.max_symbol_positions || 1),
    stop_loss_pct: Number(body.stop_loss_pct || state.config?.stop_loss_pct || 0.012),
    take_profit_pct: Number(body.take_profit_pct || state.config?.take_profit_pct || 0.024),
    min_signal_score: Number(body.min_signal_score || state.config?.min_signal_score || 1.1),
    max_holding_minutes: Number(body.max_holding_minutes || state.config?.max_holding_minutes || 24 * 60),
    strategy: String(body.strategy || state.config?.strategy || 'v1_38_real_time_gold_bidirectional_anchor'),
    side_policy: String(body.side_policy || 'both'),
    allow_short: body.allow_short !== false,
  };
  if (body.capital_usd && isFresh) {
    state.initial_cash_usd = Number(body.capital_usd);
    state.realized_pnl_usd = 0;
    state.equity_usd = Number(body.capital_usd);
    state.peak_equity_usd = Number(body.capital_usd);
  }
  state.mode = 'running';
  state.started_at = state.started_at || energyIso();
  state.stopped_at = '';
  const result = await goldTradingTickInternal(env, state, false);
  state.last_tick_at = energyIso();
  await saveGoldAccount(env, state);
  return json({ ok: true, action: 'started', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function goldTradingTick(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = goldUserId(request, url, body);
  const state = await loadGoldAccount(env, userId, body);
  const result = await goldTradingTickInternal(env, state, false);
  state.last_tick_at = energyIso();
  await saveGoldAccount(env, state);
  return json({ ok: true, user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function goldTradingStop(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = goldUserId(request, url, body);
  const state = await loadGoldAccount(env, userId, body);
  const result = await goldTradingTickInternal(env, state, Boolean(body?.liquidate !== false));
  state.mode = 'stopped';
  state.stopped_at = energyIso();
  state.last_tick_at = energyIso();
  await saveGoldAccount(env, state);
  return json({ ok: true, action: 'stopped', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

function marketPositionPnl(pos: any, currentPrice: number) {
  const qty = Math.abs(Number(pos.quantity || 0));
  if (pos.side === 'long') return (currentPrice - Number(pos.entry_price || 0)) * qty;
  if (pos.side === 'short') return (Number(pos.entry_price || 0) - currentPrice) * qty;
  return 0;
}

function markMarketEquity(state: any, signals: any[] = []) {
  let unrealized = 0;
  for (const pos of state.open_positions || []) {
    const signal = signals.find((row) => row.symbol === pos.symbol);
    const price = Number(signal?.price || pos.last_price || pos.entry_price || 0);
    const pnl = marketPositionPnl(pos, price) - Number(pos.estimated_fee_usd || 0);
    pos.last_price = price;
    pos.unrealized_pnl_usd = Number(pnl.toFixed(2));
    unrealized += pnl;
  }
  state.unrealized_pnl_usd = Number(unrealized.toFixed(2));
  state.equity_usd = Number((Number(state.initial_cash_usd || 0) + Number(state.realized_pnl_usd || 0) + unrealized).toFixed(2));
  state.peak_equity_usd = Math.max(Number(state.peak_equity_usd || state.equity_usd), state.equity_usd);
  state.max_drawdown_usd = Math.min(Number(state.max_drawdown_usd || 0), state.equity_usd - Number(state.peak_equity_usd || state.equity_usd));
}

async function openMarketPosition(env: Env, state: any, signal: any) {
  const notional = Math.min(Number(state.config?.fixed_trade_usd || 1000), Number(state.equity_usd || state.initial_cash_usd || 0) * 0.2);
  const quantity = notional / Math.max(Number(signal.price || 0), 0.0001);
  const side = signal.action === 'SELL_SHORT' ? 'short' : 'long';
  const fee = notional * MARKET_FEE_RATE;
  const pos = {
    position_id: `MT-${Date.now()}-${signal.symbol}`,
    signal_id: signal.signal_id,
    opened_at: energyIso(),
    target_exit_at: energyIso(new Date(Date.now() + Number(signal.holding_bars || 6) * 60 * 60000)),
    symbol: signal.symbol,
    name: signal.name,
    asset_class: signal.asset_class,
    side,
    action: signal.action,
    entry_price: signal.price,
    last_price: signal.price,
    quantity,
    notional_usd: notional,
    estimated_fee_usd: fee,
    stop_loss_usd: notional * Number(signal.stop_loss_pct || state.config?.stop_loss_pct || 0.018),
    take_profit_usd: notional * Number(signal.take_profit_pct || state.config?.take_profit_pct || 0.036),
    score: signal.score,
    confidence: signal.confidence,
    head_version: signal.head_version,
    head_status: signal.head_status,
    holding_bars: signal.holding_bars,
    source: signal.source,
    status: 'open',
  };
  state.open_positions.push(pos);
  state.seen_signal_ids.push(String(signal.signal_id));
  const trade = {
    ts: energyIso(),
    event: 'OPEN',
    position_id: pos.position_id,
    signal_id: signal.signal_id,
    symbol: signal.symbol,
    asset_class: signal.asset_class,
    side,
    action: signal.action,
    price: signal.price,
    quantity,
    trade_value_usd: notional,
    net_pnl_usd: 0,
    score: signal.score,
    confidence: signal.confidence,
    head_version: signal.head_version,
    head_status: signal.head_status,
    holding_bars: signal.holding_bars,
    source: signal.source,
    reason: 'AI按达标信号开仓',
  };
  await insertMarketTrade(env, state.user_id, trade);
  return trade;
}

async function closeMarketPosition(env: Env, state: any, pos: any, exitPrice: number, reason: string) {
  const gross = marketPositionPnl(pos, exitPrice);
  const fee = Number(pos.notional_usd || 0) * MARKET_FEE_RATE;
  const net = gross - Number(pos.estimated_fee_usd || 0) - fee;
  state.realized_pnl_usd = Number((Number(state.realized_pnl_usd || 0) + net).toFixed(2));
  const trade = {
    ts: energyIso(),
    event: 'CLOSE',
    position_id: pos.position_id,
    signal_id: pos.signal_id,
    symbol: pos.symbol,
    asset_class: pos.asset_class,
    side: pos.side,
    action: pos.side === 'long' ? 'SELL_TO_CLOSE' : 'BUY_TO_COVER',
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    quantity: pos.quantity,
    trade_value_usd: Math.abs(exitPrice * Number(pos.quantity || 0)),
    gross_pnl_usd: Number(gross.toFixed(2)),
    cost_usd: Number((Number(pos.estimated_fee_usd || 0) + fee).toFixed(2)),
    net_pnl_usd: Number(net.toFixed(2)),
    score: pos.score,
    confidence: pos.confidence,
    head_version: pos.head_version,
    head_status: pos.head_status,
    holding_bars: pos.holding_bars,
    source: pos.source,
    reason,
  };
  state.closed_trades.push({ ...pos, ...trade, status: 'closed' });
  await insertMarketTrade(env, state.user_id, trade);
  return trade;
}

function canOpenMarketPosition(signal: any, state: any) {
  if (state.mode !== 'running') return 'AI未运行';
  if (signal.action === 'NO_TRADE') return '信号未达交易标准';
  if (signal.head_status === 'blocked') return '该市场历史验证未通过';
  const requiredScore = Math.max(Number(state.config?.min_signal_score || 0.72), Number(signal.head_threshold || 0.72));
  if (Number(signal.score || 0) < requiredScore) return '稳定分数不足';
  if ((state.open_positions || []).length >= Number(state.config?.max_open_positions || 8)) return '达到最大持仓数';
  const sameSymbol = (state.open_positions || []).filter((pos: any) => pos.symbol === signal.symbol).length;
  if (sameSymbol >= Number(state.config?.max_symbol_positions || 2)) return '单标的持仓数已满';
  if ((state.seen_signal_ids || []).includes(String(signal.signal_id))) return '本轮信号已处理';
  if (signal.source !== 'yahoo_chart') return '行情源为回退模拟，暂不交易';
  return '';
}

async function marketTradingTickInternal(env: Env, state: any, forceClose = false) {
  const snapshot = await buildMarketSignals();
  const signals = snapshot.signals || [];
  const remaining: any[] = [];
  let opened = 0;
  let closed = 0;
  for (const pos of state.open_positions || []) {
    const signal = signals.find((row: any) => row.symbol === pos.symbol);
    const price = Number(signal?.price || pos.last_price || pos.entry_price);
    const pnl = marketPositionPnl(pos, price) - Number(pos.estimated_fee_usd || 0);
    const due = forceClose || new Date(pos.target_exit_at).getTime() <= Date.now();
    if (due || pnl >= Number(pos.take_profit_usd || 0) || pnl <= -Number(pos.stop_loss_usd || 0)) {
      const reason = due ? '到期/停止结算' : pnl > 0 ? '止盈结算' : '止损结算';
      await closeMarketPosition(env, state, pos, price, reason);
      closed += 1;
    } else {
      remaining.push({ ...pos, last_price: price, unrealized_pnl_usd: Number(pnl.toFixed(2)) });
    }
  }
  state.open_positions = remaining;
  markMarketEquity(state, signals);
  if (!forceClose && state.mode === 'running') {
    const candidates = [...signals].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    for (const signal of candidates) {
      const reason = canOpenMarketPosition(signal, state);
      if (!reason) {
        await openMarketPosition(env, state, signal);
        opened += 1;
      } else {
        await insertMarketTrade(env, state.user_id, {
          ts: energyIso(),
          event: 'SKIP',
          signal_id: signal.signal_id,
          symbol: signal.symbol,
          asset_class: signal.asset_class,
          action: signal.action,
          price: signal.price,
          trade_value_usd: 0,
          net_pnl_usd: 0,
          score: signal.score,
          confidence: signal.confidence,
          head_version: signal.head_version,
          head_status: signal.head_status,
          holding_bars: signal.holding_bars,
          source: signal.source,
          reason,
        });
        state.seen_signal_ids.push(String(signal.signal_id));
      }
    }
  }
  markMarketEquity(state, signals);
  return { snapshot, opened, closed };
}

function marketWinRate(state: any) {
  const trades = (state.closed_trades || []).filter((row: any) => Number.isFinite(Number(row.net_pnl_usd)));
  if (!trades.length) return 0;
  return trades.filter((row: any) => Number(row.net_pnl_usd || 0) > 0).length / trades.length;
}

async function marketTradingDashboard(request: Request, env: Env, url: URL) {
  const userId = marketUserId(request, url);
  const state = await loadMarketAccount(env, userId);
  const snapshot = await buildMarketSignals();
  markMarketEquity(state, snapshot.signals);
  const trades = await recentMarketTrades(env, userId, 120);
  return json({
    ok: true,
    online_backend: Boolean(env.ENERGY_TRADING_DB),
    db_status: env.ENERGY_TRADING_DB ? 'd1_bound' : 'not_configured',
    version: MARKET_TRADING_VERSION,
    updated_at: energyIso(),
    market_health: {
      ok: snapshot.source_status === 'live_public_market_data',
      status: snapshot.source_status,
      latest_captured_at: snapshot.generated_at,
      symbols: MARKET_SYMBOLS.map((row) => row.symbol),
      note: 'BTC/ETH/SPY/QQQ/GLD 使用 Yahoo Finance 公共行情快照；失败时会标记 fallback，不执行交易。',
    },
    backtest_config: {
      version: MULTI_MARKET_TRADING_CONFIG.version,
      generated_at: MULTI_MARKET_TRADING_CONFIG.generated_at,
      bar_interval: MULTI_MARKET_TRADING_CONFIG.bar_interval,
      validation_summary: MULTI_MARKET_TRADING_CONFIG.validation_summary,
    },
    signals: snapshot.signals,
    summary: {
      mode: state.mode,
      initial_cash_usd: state.initial_cash_usd,
      equity_usd: state.equity_usd,
      realized_pnl_usd: state.realized_pnl_usd,
      unrealized_pnl_usd: state.unrealized_pnl_usd || 0,
      open_positions: (state.open_positions || []).length,
      max_open_positions: state.config?.max_open_positions || 8,
      closed_trades: (state.closed_trades || []).length,
      win_rate: marketWinRate(state),
      max_drawdown_usd: state.max_drawdown_usd || 0,
      config: state.config,
    },
    positions: state.open_positions || [],
    recent_trades: trades,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function marketTradingStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = marketUserId(request, url, body);
  const existing = await loadMarketAccount(env, userId);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultMarketAccount(userId, body) : existing;
  state.config = {
    ...(state.config || {}),
    fixed_trade_usd: Number(body.fixed_trade_usd || state.config?.fixed_trade_usd || 1_000),
    max_open_positions: Number(body.max_open_positions || state.config?.max_open_positions || 8),
    stop_loss_pct: Number(body.stop_loss_pct || state.config?.stop_loss_pct || 0.018),
    take_profit_pct: Number(body.take_profit_pct || state.config?.take_profit_pct || 0.036),
	    min_signal_score: Number(body.min_signal_score || state.config?.min_signal_score || MULTI_MARKET_TRADING_CONFIG.global_min_signal_score || 0.72),
    max_holding_minutes: Number(body.max_holding_minutes || state.config?.max_holding_minutes || 360),
    strategy: String(body.strategy || state.config?.strategy || 'hfcd_stability_momentum'),
  };
  if (body.capital_usd && isFresh) {
    state.initial_cash_usd = Number(body.capital_usd);
    state.realized_pnl_usd = 0;
    state.equity_usd = Number(body.capital_usd);
    state.peak_equity_usd = Number(body.capital_usd);
  }
  state.mode = 'running';
  state.started_at = state.started_at || energyIso();
  state.stopped_at = '';
  const result = await marketTradingTickInternal(env, state, false);
  state.last_tick_at = energyIso();
  await saveMarketAccount(env, state);
  return json({ ok: true, action: 'started', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function marketTradingTick(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = marketUserId(request, url, body);
  const state = await loadMarketAccount(env, userId);
  const result = await marketTradingTickInternal(env, state, false);
  state.last_tick_at = energyIso();
  await saveMarketAccount(env, state);
  return json({ ok: true, user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function marketTradingStop(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = marketUserId(request, url, body);
  const state = await loadMarketAccount(env, userId);
  const result = await marketTradingTickInternal(env, state, Boolean(body?.liquidate !== false));
  state.mode = 'stopped';
  state.stopped_at = energyIso();
  state.last_tick_at = energyIso();
  await saveMarketAccount(env, state);
  return json({ ok: true, action: 'stopped', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

function cryptoTestnetUserId(request: Request, url: URL, body?: any) {
  return energyUserId(request, url, body).replace(/^energy_/, 'crypto_testnet_') || 'wuxing_crypto_testnet_user';
}

function cryptoTestnetStorageUserId(userId: string) {
  return `crypto_testnet_${String(userId).replace(/[^\w.-]/g, '_').slice(0, 64)}`;
}

function binanceTestnetConfigured(env: Env, credentials?: BinanceTestnetCredentials | null) {
  return Boolean((credentials?.apiKey && credentials?.apiSecret) || (env.BINANCE_TESTNET_API_KEY && env.BINANCE_TESTNET_API_SECRET));
}

function binanceTestnetAssertConfigured(env: Env, credentials?: BinanceTestnetCredentials | null) {
  if (!binanceTestnetConfigured(env, credentials)) {
    throw new Error('Binance Demo/Testnet API key/secret not configured.');
  }
}

function cryptoTestnetQuantity(symbol: string, rawQuantity: number) {
  const precision = Number(cryptoRouteMeta(symbol)?.quantity_precision ?? 3);
  const factor = 10 ** precision;
  return Number((Math.floor(Number(rawQuantity || 0) * factor) / factor).toFixed(precision));
}

async function hmacSha256Hex(secret: string, message: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function binanceTestnetSignedRequest(env: Env, method: string, path: string, params: Record<string, string | number | boolean> = {}, credentials?: BinanceTestnetCredentials | null) {
  binanceTestnetAssertConfigured(env, credentials);
  const resolvedCredentials = credentials || {
    apiKey: String(env.BINANCE_TESTNET_API_KEY),
    apiSecret: String(env.BINANCE_TESTNET_API_SECRET),
  };
  const payload: Record<string, string | number | boolean> = {
    recvWindow: 5000,
    ...params,
    timestamp: Date.now(),
  };
  const search = new URLSearchParams();
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  const signature = await hmacSha256Hex(resolvedCredentials.apiSecret, query);
  const url = `${BINANCE_TESTNET_BASE_URL}${path}?${query}&signature=${signature}`;
  const response = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': resolvedCredentials.apiKey,
      accept: 'application/json',
      'user-agent': 'HFCD-ThingNature-OS/1.0',
    },
  });
  const text = await response.text();
  let payloadJson: any = {};
  try {
    payloadJson = text ? JSON.parse(text) : {};
  } catch {
    payloadJson = { message: text };
  }
  if (!response.ok) {
    throw new Error(payloadJson?.msg || payloadJson?.message || `Binance Testnet ${method} ${path} failed with ${response.status}`);
  }
  return payloadJson;
}

async function binanceTestnetMarketOrder(env: Env, params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  reduceOnly?: boolean;
  clientOrderId?: string;
}, credentials?: BinanceTestnetCredentials | null) {
  const quantity = cryptoTestnetQuantity(params.symbol, params.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid Binance Testnet quantity for ${params.symbol}.`);
  const orderParams: Record<string, string | number | boolean> = {
    symbol: params.symbol,
    side: params.side,
    type: 'MARKET',
    quantity,
    newClientOrderId: params.clientOrderId || `hfcd_${Date.now()}_${params.symbol}`,
  };
  if (params.reduceOnly) orderParams.reduceOnly = 'true';
  return binanceTestnetSignedRequest(env, 'POST', '/fapi/v1/order', orderParams, credentials);
}

async function binanceTestnetAccountSnapshot(env: Env, credentials?: BinanceTestnetCredentials | null) {
  if (!binanceTestnetConfigured(env, credentials)) {
    return {
      configured: false,
      mode: 'not_configured',
      status: 'secrets_missing',
      positions: [],
      open_orders: [],
      account: null,
    };
  }
  try {
    const [account, positions, openOrders] = await Promise.all([
      binanceTestnetSignedRequest(env, 'GET', '/fapi/v2/account', {}, credentials),
      binanceTestnetSignedRequest(env, 'GET', '/fapi/v2/positionRisk', {}, credentials),
      binanceTestnetSignedRequest(env, 'GET', '/fapi/v1/openOrders', {}, credentials),
    ]);
    const symbols = new Set(CRYPTO_TESTNET_SYMBOLS.filter((row) => row.exchange_tradeable).map((row) => row.symbol));
    const filteredPositions = (Array.isArray(positions) ? positions : [])
      .filter((row: any) => symbols.has(row.symbol))
      .map((row: any) => ({
        symbol: row.symbol,
        position_amt: Number(row.positionAmt || 0),
        entry_price: Number(row.entryPrice || 0),
        mark_price: Number(row.markPrice || 0),
        unrealized_pnl_usd: Number(row.unRealizedProfit || 0),
        liquidation_price: Number(row.liquidationPrice || 0),
        leverage: Number(row.leverage || 0),
      }))
      .filter((row: any) => Math.abs(row.position_amt) > 0.0000001);
    const filteredOrders = (Array.isArray(openOrders) ? openOrders : [])
      .filter((row: any) => symbols.has(row.symbol))
      .map((row: any) => ({
        symbol: row.symbol,
        order_id: row.orderId,
        client_order_id: row.clientOrderId,
        side: row.side,
        type: row.type,
        price: Number(row.price || 0),
        orig_qty: Number(row.origQty || 0),
        executed_qty: Number(row.executedQty || 0),
        status: row.status,
      }));
    return {
      configured: true,
      mode: 'binance_futures_testnet',
      status: 'connected',
      account: {
        total_wallet_balance: Number(account?.totalWalletBalance || 0),
        available_balance: Number(account?.availableBalance || 0),
        total_unrealized_profit: Number(account?.totalUnrealizedProfit || 0),
      },
      positions: filteredPositions,
      open_orders: filteredOrders,
    };
  } catch (error) {
    return {
      configured: true,
      mode: 'binance_futures_testnet',
      status: 'error',
      error: error instanceof Error ? error.message : 'Binance Testnet account snapshot failed.',
      positions: [],
      open_orders: [],
      account: null,
    };
  }
}

async function binanceTestnetCloseAll(env: Env, credentials?: BinanceTestnetCredentials | null) {
  binanceTestnetAssertConfigured(env, credentials);
  const report: any = { cancelled: [], closed: [], errors: [] };
  for (const symbol of CRYPTO_TESTNET_SYMBOLS.filter((row) => row.exchange_tradeable).map((row) => row.symbol)) {
    try {
      await binanceTestnetSignedRequest(env, 'DELETE', '/fapi/v1/allOpenOrders', { symbol }, credentials);
      report.cancelled.push(symbol);
    } catch (error) {
      report.errors.push({ symbol, action: 'cancel_open_orders', error: error instanceof Error ? error.message : String(error) });
    }
  }
  const positions = await binanceTestnetSignedRequest(env, 'GET', '/fapi/v2/positionRisk', {}, credentials);
  for (const pos of Array.isArray(positions) ? positions : []) {
    if (!CRYPTO_TESTNET_SYMBOLS.some((row) => row.symbol === pos.symbol && row.exchange_tradeable)) continue;
    const amt = Number(pos.positionAmt || 0);
    if (Math.abs(amt) <= 0.0000001) continue;
    try {
      const side = amt > 0 ? 'SELL' : 'BUY';
      const order = await binanceTestnetMarketOrder(env, {
        symbol: pos.symbol,
        side,
        quantity: Math.abs(amt),
        reduceOnly: true,
        clientOrderId: `hfcd_close_${Date.now()}_${pos.symbol}`,
      }, credentials);
      report.closed.push({ symbol: pos.symbol, side, quantity: Math.abs(amt), order_id: order.orderId });
    } catch (error) {
      report.errors.push({ symbol: pos.symbol, action: 'close_position', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

function defaultCryptoTestnetAccount(userId: string, body: any = {}) {
  const capital = Number(body.capital_usd || body.capital || 100_000);
  return {
    version: CRYPTO_TESTNET_VERSION,
    user_id: cryptoTestnetStorageUserId(userId),
    display_user_id: userId,
    mode: 'stopped',
    started_at: '',
    stopped_at: '',
    initial_cash_usd: capital,
    realized_pnl_usd: 0,
    equity_usd: capital,
    peak_equity_usd: capital,
    max_drawdown_usd: 0,
    open_positions: [] as any[],
    closed_trades: [] as any[],
    seen_signal_ids: [] as string[],
    config: {
      fixed_trade_usd: Number(body.fixed_trade_usd || body.max_order_usd || 1_000),
      max_open_positions: Number(body.max_open_positions || 4),
      max_symbol_positions: Number(body.max_symbol_positions || 1),
      stop_loss_pct: Number(body.stop_loss_pct || 0.018),
      take_profit_pct: Number(body.take_profit_pct || 0.036),
      min_signal_score: Number(body.min_signal_score || 0.66),
      max_holding_minutes: Number(body.max_holding_minutes || 8 * 60),
      side_policy: String(body.side_policy || 'both'),
      allow_short: body.allow_short !== false,
      order_execution: String(body.order_execution || 'paper'),
      testnet_close_all_on_stop: body.testnet_close_all_on_stop !== false,
      strategy: String(body.strategy || 'v2_23_frequency_router_btc1h_eth2h_bidirectional'),
    },
  };
}

function normalizeCryptoTestnetAccount(state: any, userId: string, body: any = {}) {
  const defaults = defaultCryptoTestnetAccount(userId, body);
  const normalized = {
    ...defaults,
    ...state,
    config: {
      ...defaults.config,
      ...(state?.config || {}),
    },
  };
  normalized.display_user_id = normalized.display_user_id || userId;
  normalized.user_id = normalized.user_id || cryptoTestnetStorageUserId(userId);
  if (!normalized.config.side_policy) normalized.config.side_policy = 'both';
  if (!normalized.config.order_execution) normalized.config.order_execution = 'paper';
  if (normalized.config.testnet_close_all_on_stop === undefined) normalized.config.testnet_close_all_on_stop = true;
  if (normalized.config.allow_short === undefined || state?.version !== CRYPTO_TESTNET_VERSION) {
    normalized.config.allow_short = true;
  }
  return normalized;
}

function mergeCryptoTestnetConfig(state: any, body: any = {}) {
  const current = state.config || {};
  const has = (key: string) => body && body[key] !== undefined && body[key] !== null && body[key] !== '';
  return {
    ...current,
    fixed_trade_usd: Number(has('fixed_trade_usd') ? body.fixed_trade_usd : has('max_order_usd') ? body.max_order_usd : current.fixed_trade_usd || 1_000),
    max_open_positions: Number(has('max_open_positions') ? body.max_open_positions : current.max_open_positions || 4),
    max_symbol_positions: Number(has('max_symbol_positions') ? body.max_symbol_positions : current.max_symbol_positions || 1),
    stop_loss_pct: Number(has('stop_loss_pct') ? body.stop_loss_pct : current.stop_loss_pct || 0.018),
    take_profit_pct: Number(has('take_profit_pct') ? body.take_profit_pct : current.take_profit_pct || 0.036),
    min_signal_score: Number(has('min_signal_score') ? body.min_signal_score : current.min_signal_score || 0.66),
    max_holding_minutes: Number(has('max_holding_minutes') ? body.max_holding_minutes : current.max_holding_minutes || 8 * 60),
    side_policy: String(has('side_policy') ? body.side_policy : current.side_policy || 'both'),
    allow_short: body.allow_short !== false,
    order_execution: String(has('order_execution') ? body.order_execution : current.order_execution || 'paper') === 'binance_testnet' ? 'binance_testnet' : 'paper',
    testnet_close_all_on_stop: has('testnet_close_all_on_stop') ? body.testnet_close_all_on_stop !== false : current.testnet_close_all_on_stop !== false,
    strategy: String(has('strategy') ? body.strategy : current.strategy || 'v3_1_shortvol_bidirectional_forward_ledger'),
  };
}

async function loadCryptoTestnetAccount(env: Env, userId: string, body: any = {}) {
  const storageId = cryptoTestnetStorageUserId(userId);
  const db = await ensureMarketTradingDb(env);
  if (!db) return defaultCryptoTestnetAccount(userId, body);
  const row = await db.prepare('SELECT state_json FROM market_accounts WHERE user_id = ?').bind(storageId).first();
  if (!row?.state_json) return defaultCryptoTestnetAccount(userId, body);
  try {
    return normalizeCryptoTestnetAccount(JSON.parse(String(row.state_json)), userId, body);
  } catch {
    return defaultCryptoTestnetAccount(userId, body);
  }
}

async function saveCryptoTestnetAccount(env: Env, state: any) {
  state.version = CRYPTO_TESTNET_VERSION;
  state.user_id = cryptoTestnetStorageUserId(state.display_user_id || state.user_id || 'wuxing_crypto_testnet_user');
  await saveMarketAccount(env, state);
}

async function recentCryptoTestnetTrades(env: Env, userId: string, limit = 160) {
  return recentMarketTrades(env, cryptoTestnetStorageUserId(userId), limit);
}

async function insertCryptoTestnetTrade(env: Env, userId: string, row: any) {
  return insertMarketTrade(env, cryptoTestnetStorageUserId(userId), row);
}

function cryptoRouteMeta(symbol: string) {
  return CRYPTO_TESTNET_SYMBOLS.find((row) => row.symbol === symbol) || CRYPTO_TESTNET_SYMBOLS[0];
}

function cryptoRouteIsExchangeTradeable(symbol: string) {
  return Boolean(cryptoRouteMeta(symbol)?.exchange_tradeable);
}

function cryptoRouteCadenceMinutes(cadence?: string) {
  if (cadence === '15m') return 15;
  if (cadence === '30m') return 30;
  if (cadence === '2h') return 120;
  return 60;
}

function cryptoRoutePriceDigits(symbol: string) {
  if (symbol === 'BTCUSDT') return 2;
  if (symbol.endsWith('USDT')) return 3;
  return 4;
}

function fallbackCryptoSeries(symbol: string) {
  const meta = cryptoRouteMeta(symbol);
  const base = symbol === 'BTCUSDT' ? 82_000 : symbol === 'SOLUSDT' ? 145 : symbol === 'SPY' ? 720 : symbol === 'QQQ' ? 680 : symbol === 'IWM' ? 245 : 2_400;
  const now = Date.now();
  const cadenceMs = cryptoRouteCadenceMinutes(meta.cadence) * 60000;
  const rows = Array.from({ length: 160 }, (_, index) => {
    const t = now - (159 - index) * cadenceMs;
    const wave = Math.sin(t / 7200000 + symbol.length) * 0.012 + Math.sin(t / 86400000) * 0.025;
    return { ts: new Date(t).toISOString(), close: Number((base * (1 + wave)).toFixed(cryptoRoutePriceDigits(symbol))), volume: 0 };
  });
  return {
    ...meta,
    source: `fallback_simulated:${symbol}`,
    source_quality: 'fallback_not_tradeable',
    is_real_market_data: false,
    rows,
    sensors: {
      spread_bps: Number(meta.estimated_spread_bps || 0),
      exchange_tradeable: Boolean(meta.exchange_tradeable),
      execution_venue: meta.exchange_tradeable ? 'binance_futures_testnet_or_paper' : 'paper_only',
    },
  };
}

async function fetchBinanceJson(url: string) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'HFCD-ThingNature-OS/1.0',
    },
  });
  if (!response.ok) throw new Error(`Binance ${response.status}`);
  return response.json();
}

async function fetchShortvolYahooSeries(meta: any) {
  const interval = meta.cadence === '15m' ? '15m' : '60m';
  const range = meta.cadence === '15m' ? '60d' : '6mo';
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
      {
        headers: {
          accept: 'application/json',
          'user-agent': 'HFCD-ThingNature-OS/1.0',
        },
      },
    );
    if (!response.ok) throw new Error(`Yahoo ${meta.symbol} ${response.status}`);
    const payload: any = await response.json();
    const result = payload?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const closes: Array<number | null> = quote.close || [];
    const volumes: Array<number | null> = quote.volume || [];
    const rows = timestamps.map((ts, index) => ({
      ts: new Date(ts * 1000).toISOString(),
      close: closes[index] === null ? NaN : Number(closes[index]),
      volume: volumes[index] === null ? 0 : Number(volumes[index] || 0),
    })).filter((row) => Number.isFinite(row.close) && row.close > 0);
    if (rows.length < 40) throw new Error(`Yahoo ${meta.symbol} insufficient rows`);
    const price = rows[rows.length - 1].close;
    const spreadBps = Number(meta.estimated_spread_bps || 2);
    const volumeRecent = rows.slice(-6).reduce((sum, row) => sum + Number(row.volume || 0), 0);
    return {
      ...meta,
      source: `yahoo_chart:${meta.symbol}:${interval}`,
      source_quality: 'public_realtime_yahoo_chart',
      is_real_market_data: true,
      rows,
      sensors: {
        mark_price: price,
        best_bid: Number((price * (1 - spreadBps / 20000)).toFixed(cryptoRoutePriceDigits(meta.symbol))),
        best_ask: Number((price * (1 + spreadBps / 20000)).toFixed(cryptoRoutePriceDigits(meta.symbol))),
        spread_bps: spreadBps,
        funding_rate: 0,
        open_interest: 0,
        bid_depth_usd: 0,
        ask_depth_usd: 0,
        depth_imbalance: 0,
        volume_recent: volumeRecent,
        volume_notional_proxy: Number((volumeRecent * price).toFixed(2)),
        exchange_tradeable: false,
        execution_venue: 'paper_only',
      },
    };
  } catch {
    return fallbackCryptoSeries(meta.symbol);
  }
}

async function fetchCryptoTestnetSeries(symbol: string) {
  const meta = cryptoRouteMeta(symbol);
  if (meta.market_data_source === 'yahoo_chart') return fetchShortvolYahooSeries(meta);
  try {
    const interval = meta.cadence || '1h';
    const [klines, premium, openInterest, depth] = await Promise.all([
      fetchBinanceJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=160`),
      fetchBinanceJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      fetchBinanceJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
      fetchBinanceJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=20`),
    ]);
    const rows = (Array.isArray(klines) ? klines : []).map((row: any[]) => ({
      ts: new Date(Number(row[0])).toISOString(),
      close: Number(row[4]),
      volume: Number(row[5] || 0),
    })).filter((row: any) => Number.isFinite(row.close) && row.close > 0);
    if (rows.length < 40) throw new Error(`Binance ${symbol} insufficient rows`);
    const bidDepth = (depth?.bids || []).reduce((sum: number, row: any[]) => sum + Number(row[0]) * Number(row[1]), 0);
    const askDepth = (depth?.asks || []).reduce((sum: number, row: any[]) => sum + Number(row[0]) * Number(row[1]), 0);
    const bestBid = Number(depth?.bids?.[0]?.[0] || rows[rows.length - 1].close);
    const bestAsk = Number(depth?.asks?.[0]?.[0] || rows[rows.length - 1].close);
    return {
      ...meta,
      source: `binance_futures_public:${symbol}:${interval}`,
      source_quality: 'public_realtime_futures',
      is_real_market_data: true,
      rows,
      sensors: {
        funding_rate: Number(premium?.lastFundingRate || 0),
        mark_price: Number(premium?.markPrice || rows[rows.length - 1].close),
        index_price: Number(premium?.indexPrice || rows[rows.length - 1].close),
        open_interest: Number(openInterest?.openInterest || 0),
        bid_depth_usd: Number(bidDepth.toFixed(2)),
        ask_depth_usd: Number(askDepth.toFixed(2)),
        depth_imbalance: Number(((bidDepth - askDepth) / Math.max(bidDepth + askDepth, 1)).toFixed(6)),
        best_bid: bestBid,
        best_ask: bestAsk,
        spread_bps: Number((((bestAsk - bestBid) / Math.max((bestAsk + bestBid) / 2, 1)) * 10000).toFixed(4)),
        exchange_tradeable: true,
        execution_venue: 'binance_futures_testnet_or_paper',
      },
    };
  } catch {
    return fallbackCryptoSeries(symbol);
  }
}

function buildCryptoTestnetSignal(series: any, minSignalScore = 0.66) {
  const meta = cryptoRouteMeta(series.symbol);
  const rows = series.rows || [];
  const closes = rows.map((row: any) => Number(row.close)).filter((value: number) => Number.isFinite(value) && value > 0);
  const volumes = rows.map((row: any) => Number(row.volume || 0));
  const last = closes[closes.length - 1] || 0;
  const prev = closes[closes.length - 2] || last;
  const fastBase = closes[Math.max(0, closes.length - 1 - 3)] || prev;
  const midBase = closes[Math.max(0, closes.length - 1 - 12)] || fastBase;
  const longBase = closes[Math.max(0, closes.length - 1 - 48)] || midBase;
  const returns = closes.slice(-96).map((value: number, index: number, arr: number[]) => index === 0 ? 0 : value / arr[index - 1] - 1).slice(1);
  const realizedVol = Math.max(marketStd(returns), 0.0015);
  const r1 = last / prev - 1;
  const r3 = last / fastBase - 1;
  const r12 = last / midBase - 1;
  const r48 = last / longBase - 1;
  const trendZ = (0.38 * r3 + 0.38 * r12 + 0.24 * r48) / realizedVol;
  const funding = Number(series.sensors?.funding_rate || 0);
  const depthImbalance = Number(series.sensors?.depth_imbalance || 0);
  const spreadPenalty = Math.min(0.4, Math.max(0, Number(series.sensors?.spread_bps || 0) / 25));
  const fundingPenalty = Math.min(0.35, Math.abs(funding) * 450);
  const volumeRecent = volumes.slice(-6).reduce((sum: number, value: number) => sum + value, 0) / Math.max(volumes.slice(-6).length, 1);
  const volumeBase = volumes.slice(-60).reduce((sum: number, value: number) => sum + value, 0) / Math.max(volumes.slice(-60).length, 1);
  const volumePulse = volumeBase > 0 ? Math.min(0.18, Math.max(-0.08, (volumeRecent / volumeBase - 1) * 0.08)) : 0;
  const darkForestBoost = Math.max(-0.12, Math.min(0.12, depthImbalance * 0.18 - Math.sign(trendZ || 1) * funding * 80));
  const directionalScore = Math.max(0, Math.abs(trendZ) * 0.58 + Math.abs(depthImbalance) * 0.18 + volumePulse + darkForestBoost - spreadPenalty - fundingPenalty);
  const rawAction = trendZ >= 0 ? 'BUY_LONG' : 'SELL_SHORT';
  const longThreshold = Math.max(Number(minSignalScore || 0.66), Number(meta.long_min_signal_score || meta.min_signal_score || 0.66));
  const shortThreshold = Math.max(Number(meta.short_min_signal_score || meta.min_signal_score || minSignalScore || 0.66), 0.0);
  const effectiveThreshold = rawAction === 'SELL_SHORT' ? shortThreshold : longThreshold;
  let action = directionalScore >= effectiveThreshold ? rawAction : 'NO_TRADE';
  let routeRejectReason = '';
  const shortForwardOnly = action === 'SELL_SHORT' && meta.validated_side_policy === 'long_only';
  const side = action === 'BUY_LONG' ? 'long' : action === 'SELL_SHORT' ? 'short' : '-';
  const latestTs = rows[rows.length - 1]?.ts || energyIso();
  const price = Number((series.sensors?.mark_price || last).toFixed(cryptoRoutePriceDigits(series.symbol)));
  const bestBid = Number(series.sensors?.best_bid || price);
  const bestAsk = Number(series.sensors?.best_ask || price);
  return {
    signal_id: `SHORTVOL-${series.symbol}-${Math.floor(new Date(latestTs).getTime() / (cryptoRouteCadenceMinutes(meta.cadence) * 60000))}-${action}`,
    captured_at: latestTs,
    symbol: series.symbol,
    name: series.name,
    asset_class: meta.asset_class || 'crypto_perp',
    route: series.route,
    cadence: series.cadence,
    route_status: meta.route_status || 'main',
    route_side_policy: meta.side_policy || 'long_only',
    validated_side_policy: meta.validated_side_policy || meta.side_policy || 'long_only',
    short_policy_status: meta.short_policy_status || '',
    signal_validation_status: shortForwardOnly ? 'short_forward_shadow_not_blind_promoted' : 'blind_promoted',
    execution_venue: series.sensors?.execution_venue || (meta.exchange_tradeable ? 'binance_futures_testnet_or_paper' : 'paper_only'),
    exchange_tradeable: Boolean(meta.exchange_tradeable),
    blind_test: meta.blind_test || null,
    price,
    bid_price: bestBid,
    ask_price: bestAsk,
    spread_bps: Number(series.sensors?.spread_bps || 0),
    action,
    side,
    score: Number(directionalScore.toFixed(4)),
    signed_score: Number(trendZ.toFixed(4)),
    confidence: Number(Math.max(0, Math.min(0.99, 0.5 + directionalScore * 0.22)).toFixed(4)),
    realized_vol: Number(realizedVol.toFixed(6)),
    r1: Number(r1.toFixed(6)),
    r3: Number(r3.toFixed(6)),
    r12: Number(r12.toFixed(6)),
    r48: Number(r48.toFixed(6)),
    funding_rate: funding,
    open_interest: Number(series.sensors?.open_interest || 0),
    bid_depth_usd: Number(series.sensors?.bid_depth_usd || 0),
    ask_depth_usd: Number(series.sensors?.ask_depth_usd || 0),
    depth_imbalance: depthImbalance,
    volume_recent: Number(series.sensors?.volume_recent || volumeRecent || 0),
    volume_notional_proxy: Number(series.sensors?.volume_notional_proxy || 0),
    head_version: CRYPTO_TESTNET_VERSION,
    head_status: 'shortvol_forward_shadow_candidate',
    head_threshold: Number(effectiveThreshold.toFixed(4)),
    holding_minutes: Number(meta.default_holding_minutes || 8 * 60),
    stop_loss_pct: 0.018,
    take_profit_pct: 0.036,
    source: series.source,
    source_quality: series.source_quality,
    is_real_market_data: Boolean(series.is_real_market_data),
    status: action === 'NO_TRADE' ? 'rejected' : 'accepted',
    reject_reason: action === 'NO_TRADE' ? (routeRejectReason || '短波动路线实时信号未达 V3.1 门槛') : '',
  };
}

async function buildCryptoTestnetSnapshot(minSignalScore = 0.66) {
  const seriesList = await Promise.all(CRYPTO_TESTNET_SYMBOLS.map((row) => fetchCryptoTestnetSeries(row.symbol)));
  const signals = seriesList.map((series) => buildCryptoTestnetSignal(series, minSignalScore));
  return {
    generated_at: energyIso(),
    source_status: signals.every((signal) => signal.is_real_market_data) ? 'public_realtime_mixed_binance_yahoo' : 'mixed_or_fallback',
    order_mode: 'shortvol_forward_ledger_configurable_testnet_mirror',
    main_side_policy: 'route_bidirectional_with_long_blind_validation_and_iwm_short_v3_5',
    route_set: 'v3_1_long_routes_plus_v3_5_iwm_short',
    selected_routes: CRYPTO_TESTNET_SYMBOLS.map((row) => ({
      symbol: row.symbol,
      route: row.route,
      cadence: row.cadence,
      side_policy: row.side_policy,
      validated_side_policy: row.validated_side_policy || row.side_policy,
      short_policy_status: row.short_policy_status || '',
      asset_class: row.asset_class,
      execution_venue: row.exchange_tradeable ? 'binance_testnet_or_paper' : 'paper_only',
      blind_test: row.blind_test || null,
      short_blind_test: row.short_blind_test || null,
    })),
    signals,
    sensors: signals.map((signal) => ({
      symbol: signal.symbol,
      route: signal.route,
      cadence: signal.cadence,
      asset_class: signal.asset_class,
      execution_venue: signal.execution_venue,
      funding_rate: signal.funding_rate,
      open_interest: signal.open_interest,
      bid_depth_usd: signal.bid_depth_usd,
      ask_depth_usd: signal.ask_depth_usd,
      depth_imbalance: signal.depth_imbalance,
      spread_bps: signal.spread_bps,
      volume_recent: signal.volume_recent,
      volume_notional_proxy: signal.volume_notional_proxy,
      source: signal.source,
      is_real_market_data: signal.is_real_market_data,
    })),
  };
}

function cryptoTestnetPositionPnl(pos: any, currentPrice: number) {
  const qty = Math.abs(Number(pos.quantity || 0));
  if (pos.side === 'long') return (currentPrice - Number(pos.entry_price || 0)) * qty;
  if (pos.side === 'short') return (Number(pos.entry_price || 0) - currentPrice) * qty;
  return 0;
}

function markCryptoTestnetEquity(state: any, signals: any[] = []) {
  let unrealized = 0;
  for (const pos of state.open_positions || []) {
    const signal = signals.find((row) => row.symbol === pos.symbol);
    const price = Number(signal?.price || pos.last_price || pos.entry_price || 0);
    const pnl = cryptoTestnetPositionPnl(pos, price) - Number(pos.estimated_fee_usd || 0);
    pos.last_price = price;
    pos.unrealized_pnl_usd = Number(pnl.toFixed(2));
    unrealized += pnl;
  }
  state.unrealized_pnl_usd = Number(unrealized.toFixed(2));
  state.equity_usd = Number((Number(state.initial_cash_usd || 0) + Number(state.realized_pnl_usd || 0) + unrealized).toFixed(2));
  state.peak_equity_usd = Math.max(Number(state.peak_equity_usd || state.equity_usd), state.equity_usd);
  state.max_drawdown_usd = Math.min(Number(state.max_drawdown_usd || 0), state.equity_usd - Number(state.peak_equity_usd || state.equity_usd));
}

function canOpenCryptoTestnetPosition(signal: any, state: any) {
  const cfg = state.config || {};
  if (state.mode !== 'running') return 'AI未运行';
  if (!signal.is_real_market_data) return '没有 Binance 真实公共行情，禁止开仓';
  if (signal.route_status && signal.route_status !== 'main') return '该路线仅旁路观察，不接主前向账本';
  if (!['BUY_LONG', 'SELL_SHORT'].includes(String(signal.action || ''))) return '信号未达加密交易标准';
  if (signal.action === 'SELL_SHORT' && (cfg.allow_short === false || cfg.side_policy === 'long_only')) return '加密做空未启用';
  if (signal.action === 'BUY_LONG' && cfg.side_policy === 'short_only') return '加密做多未启用';
  if (Number(signal.score || 0) < Number(cfg.min_signal_score || 0.66)) return '加密稳定分数不足';
  if ((state.open_positions || []).length >= Number(cfg.max_open_positions || 4)) return '达到最大持仓数';
  const sameSymbol = (state.open_positions || []).filter((pos: any) => pos.symbol === signal.symbol).length;
  if (sameSymbol >= Number(cfg.max_symbol_positions || 1)) return '单币种持仓数已满';
  if ((state.seen_signal_ids || []).includes(String(signal.signal_id))) return '本轮加密信号已处理';
  return '';
}

async function openCryptoTestnetPosition(env: Env, state: any, signal: any, credentials?: BinanceTestnetCredentials | null) {
  const cfg = state.config || {};
  const maxByEquity = Number(state.equity_usd || state.initial_cash_usd || 0) * 0.25;
  const notional = Math.min(Number(cfg.fixed_trade_usd || 1_000), maxByEquity);
  const side = signal.action === 'SELL_SHORT' ? 'short' : 'long';
  const fillPrice = side === 'short'
    ? Number(signal.bid_price || signal.price)
    : Number(signal.ask_price || signal.price);
  const quantity = notional / Math.max(fillPrice, 0.0001);
  const fee = notional * CRYPTO_TESTNET_FEE_RATE;
  let exchangeOrder: any = null;
  const canSendExchangeOrder = cfg.order_execution === 'binance_testnet' && cryptoRouteIsExchangeTradeable(signal.symbol);
  if (canSendExchangeOrder) {
    exchangeOrder = await binanceTestnetMarketOrder(env, {
      symbol: signal.symbol,
      side: side === 'short' ? 'SELL' : 'BUY',
      quantity,
      reduceOnly: false,
      clientOrderId: `hfcd_open_${Date.now()}_${signal.symbol}`,
    }, credentials);
  }
  const pos = {
    position_id: `CT-${Date.now()}-${signal.symbol}`,
    signal_id: signal.signal_id,
    execution_mode: canSendExchangeOrder ? 'binance_testnet' : 'paper',
    exchange_order_id: exchangeOrder?.orderId || null,
    opened_at: energyIso(),
    target_exit_at: energyIso(new Date(Date.now() + Number(cfg.max_holding_minutes || signal.holding_minutes || 480) * 60000)),
    symbol: signal.symbol,
    name: signal.name,
    asset_class: signal.asset_class,
    route: signal.route,
    route_status: signal.route_status,
    execution_venue: signal.execution_venue,
    side,
    action: signal.action,
    entry_price: fillPrice,
    last_price: signal.price,
    quantity,
    notional_usd: notional,
    estimated_fee_usd: fee,
    stop_loss_usd: notional * Number(cfg.stop_loss_pct || 0.018),
    take_profit_usd: notional * Number(cfg.take_profit_pct || 0.036),
    score: signal.score,
    confidence: signal.confidence,
    funding_rate: signal.funding_rate,
    depth_imbalance: signal.depth_imbalance,
    blind_test: signal.blind_test || null,
    source: signal.source,
    source_quality: signal.source_quality,
    status: 'open',
  };
  state.open_positions.push(pos);
  state.seen_signal_ids.push(String(signal.signal_id));
  const trade = {
    ts: energyIso(),
    event: 'OPEN',
    position_id: pos.position_id,
    signal_id: signal.signal_id,
    symbol: signal.symbol,
    asset_class: signal.asset_class,
    route: signal.route,
    side,
    action: signal.action,
    price: fillPrice,
    quantity,
    trade_value_usd: notional,
    net_pnl_usd: 0,
    score: signal.score,
    confidence: signal.confidence,
    source: signal.source,
    exchange_order_id: exchangeOrder?.orderId || null,
    execution_mode: pos.execution_mode,
    reason: signal.exchange_tradeable
      ? (side === 'short' ? 'V3.1 短波动路线做空前向验证开仓' : 'V3.1 短波动路线按实时行情达标做多开仓')
      : 'V3.1 ETF 通过路线只写本地 paper 账本，不发送 Binance 订单',
  };
  await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, trade);
  return trade;
}

async function closeCryptoTestnetPosition(env: Env, state: any, pos: any, signal: any, reason: string, credentials?: BinanceTestnetCredentials | null) {
  const exitPrice = pos.side === 'short'
    ? Number(signal?.ask_price || signal?.price || pos.last_price || pos.entry_price)
    : Number(signal?.bid_price || signal?.price || pos.last_price || pos.entry_price);
  const gross = cryptoTestnetPositionPnl(pos, exitPrice);
  const fee = Number(pos.notional_usd || 0) * CRYPTO_TESTNET_FEE_RATE;
  const net = gross - Number(pos.estimated_fee_usd || 0) - fee;
  let exchangeOrder: any = null;
  if (pos.execution_mode === 'binance_testnet' && reason !== 'shadow_close_only' && cryptoRouteIsExchangeTradeable(pos.symbol)) {
    exchangeOrder = await binanceTestnetMarketOrder(env, {
      symbol: pos.symbol,
      side: pos.side === 'short' ? 'BUY' : 'SELL',
      quantity: Number(pos.quantity || 0),
      reduceOnly: true,
      clientOrderId: `hfcd_close_${Date.now()}_${pos.symbol}`,
    }, credentials);
  }
  state.realized_pnl_usd = Number((Number(state.realized_pnl_usd || 0) + net).toFixed(2));
  const trade = {
    ts: energyIso(),
    event: 'CLOSE',
    position_id: pos.position_id,
    signal_id: pos.signal_id,
    symbol: pos.symbol,
    asset_class: pos.asset_class,
    route: pos.route,
    side: pos.side,
    action: pos.side === 'short' ? 'BUY_TO_COVER' : 'SELL_TO_CLOSE',
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    quantity: pos.quantity,
    trade_value_usd: Math.abs(exitPrice * Number(pos.quantity || 0)),
    gross_pnl_usd: Number(gross.toFixed(2)),
    cost_usd: Number((Number(pos.estimated_fee_usd || 0) + fee).toFixed(2)),
    net_pnl_usd: Number(net.toFixed(2)),
    score: pos.score,
    confidence: pos.confidence,
    source: signal?.source || pos.source,
    exchange_order_id: exchangeOrder?.orderId || null,
    execution_mode: pos.execution_mode || state.config?.order_execution || 'paper',
    reason,
  };
  state.closed_trades.push({ ...pos, ...trade, status: 'closed' });
  await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, trade);
  return trade;
}

async function cryptoTestnetTickInternal(env: Env, state: any, forceClose = false, credentials?: BinanceTestnetCredentials | null) {
  const snapshot = await buildCryptoTestnetSnapshot(Number(state.config?.min_signal_score || 0.66));
  const signals = snapshot.signals || [];
  const remaining: any[] = [];
  let opened = 0;
  let closed = 0;
  for (const pos of state.open_positions || []) {
    const signal = signals.find((row: any) => row.symbol === pos.symbol);
    const price = Number(signal?.price || pos.last_price || pos.entry_price);
    const pnl = cryptoTestnetPositionPnl(pos, price) - Number(pos.estimated_fee_usd || 0);
    const due = forceClose || new Date(pos.target_exit_at).getTime() <= Date.now();
    if (due || pnl >= Number(pos.take_profit_usd || 0) || pnl <= -Number(pos.stop_loss_usd || 0)) {
      const reason = due ? '到期/停止结算' : pnl > 0 ? '止盈结算' : '止损结算';
      try {
        await closeCryptoTestnetPosition(env, state, pos, signal, reason, credentials);
        closed += 1;
      } catch (error) {
        remaining.push({
          ...pos,
          last_price: price,
          unrealized_pnl_usd: Number(pnl.toFixed(2)),
          last_error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      remaining.push({ ...pos, last_price: price, unrealized_pnl_usd: Number(pnl.toFixed(2)) });
    }
  }
  state.open_positions = remaining;
  markCryptoTestnetEquity(state, signals);
  if (!forceClose && state.mode === 'running') {
    const candidates = [...signals].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    for (const signal of candidates) {
      const reason = canOpenCryptoTestnetPosition(signal, state);
      if (!reason) {
        try {
          await openCryptoTestnetPosition(env, state, signal, credentials);
          opened += 1;
        } catch (error) {
          await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
            ts: energyIso(),
            event: 'SKIP',
            signal_id: signal.signal_id,
            symbol: signal.symbol,
            asset_class: signal.asset_class,
            route: signal.route,
            action: signal.action,
            price: signal.price,
            trade_value_usd: 0,
            net_pnl_usd: 0,
            score: signal.score,
            confidence: signal.confidence,
            source: signal.source,
            reason: error instanceof Error ? `Binance Testnet 下单失败：${error.message}` : 'Binance Testnet 下单失败',
          });
          state.seen_signal_ids.push(String(signal.signal_id));
        }
      } else {
        await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
          ts: energyIso(),
          event: 'SKIP',
          signal_id: signal.signal_id,
          symbol: signal.symbol,
          asset_class: signal.asset_class,
          route: signal.route,
          action: signal.action,
          price: signal.price,
          trade_value_usd: 0,
          net_pnl_usd: 0,
          score: signal.score,
          confidence: signal.confidence,
          source: signal.source,
          reason,
        });
        state.seen_signal_ids.push(String(signal.signal_id));
      }
    }
  }
  markCryptoTestnetEquity(state, signals);
  return { snapshot, opened, closed };
}

function cryptoTestnetWinRate(state: any) {
  const trades = (state.closed_trades || []).filter((row: any) => Number.isFinite(Number(row.net_pnl_usd)));
  if (!trades.length) return 0;
  return trades.filter((row: any) => Number(row.net_pnl_usd || 0) > 0).length / trades.length;
}

async function cryptoTestnetDashboard(request: Request, env: Env, url: URL) {
  const userId = cryptoTestnetUserId(request, url);
  const state = await loadCryptoTestnetAccount(env, userId);
  const snapshot = await buildCryptoTestnetSnapshot(Number(state.config?.min_signal_score || 0.66));
  markCryptoTestnetEquity(state, snapshot.signals);
  const trades = await recentCryptoTestnetTrades(env, userId, 180);
  const privateControl = hasPrivateTradingControl(request, env);
  const testnetCredentials = binanceTestnetCredentialsForRequest(request, env);
  const testnet = privateControl
    ? await binanceTestnetAccountSnapshot(env, testnetCredentials)
    : {
        configured: binanceTestnetConfigured(env),
        mode: 'binance_futures_testnet',
        status: binanceTestnetConfigured(env) ? 'private_control_locked' : 'secrets_missing',
        positions: [],
        open_orders: [],
        account: null,
      };
  return json({
    ok: true,
    online_backend: Boolean(env.ENERGY_TRADING_DB),
    db_status: env.ENERGY_TRADING_DB ? 'd1_bound' : 'not_configured',
    version: CRYPTO_TESTNET_VERSION,
    updated_at: energyIso(),
    data_policy: {
      order_mode: state.config?.order_execution === 'binance_testnet' ? 'binance_futures_testnet_signed_orders' : 'paper/testnet-mirror-configurable',
      real_exchange_orders: state.config?.order_execution === 'binance_testnet' && privateControl,
      private_exchange_control: privateControl,
      production_mainnet_orders: false,
      realtime_source: 'Binance USD-M Futures public endpoints + Yahoo Finance public chart',
      note: state.config?.order_execution === 'binance_testnet'
        ? '当前执行模式为 Binance Futures Demo/Testnet；仅 BTCUSDT/SOLUSDT 会向 demo-fapi.binance.com 发测试网订单，SPY/QQQ/IWM 只写 paper 账本。'
        : '当前执行模式为 D1 paper/testnet mirror，只写模拟账本，不向交易所发订单。',
    },
    market_health: {
      ok: snapshot.source_status === 'public_realtime_mixed_binance_yahoo',
      status: snapshot.source_status,
      latest_captured_at: snapshot.generated_at,
      symbols: CRYPTO_TESTNET_SYMBOLS.map((row) => row.symbol),
      selected_routes: snapshot.selected_routes,
    },
    sensors: snapshot.sensors,
    signals: snapshot.signals,
    summary: {
      mode: state.mode,
      initial_cash_usd: state.initial_cash_usd,
      equity_usd: state.equity_usd,
      realized_pnl_usd: state.realized_pnl_usd,
      unrealized_pnl_usd: state.unrealized_pnl_usd || 0,
      open_positions: (state.open_positions || []).length,
      max_open_positions: state.config?.max_open_positions || 4,
      closed_trades: (state.closed_trades || []).length,
      win_rate: cryptoTestnetWinRate(state),
      max_drawdown_usd: state.max_drawdown_usd || 0,
      config: state.config,
    },
    positions: state.open_positions || [],
    recent_trades: trades,
    testnet,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cryptoTestnetStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const existing = await loadCryptoTestnetAccount(env, userId, body);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultCryptoTestnetAccount(userId, body) : existing;
  state.display_user_id = userId;
  state.config = mergeCryptoTestnetConfig(state, body);
  if (state.config.order_execution === 'binance_testnet') {
    if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
    binanceTestnetAssertConfigured(env, binanceTestnetCredentialsForRequest(request, env));
  }
  if (body.capital_usd && isFresh) {
    state.initial_cash_usd = Number(body.capital_usd);
    state.realized_pnl_usd = 0;
    state.equity_usd = Number(body.capital_usd);
    state.peak_equity_usd = Number(body.capital_usd);
  }
  state.mode = 'running';
  state.started_at = state.started_at || energyIso();
  state.stopped_at = '';
  const result = await cryptoTestnetTickInternal(env, state, false, binanceTestnetCredentialsForRequest(request, env));
  state.last_tick_at = energyIso();
  await saveCryptoTestnetAccount(env, state);
  return json({ ok: true, action: 'started', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cryptoTestnetTick(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const state = await loadCryptoTestnetAccount(env, userId, body);
  state.config = mergeCryptoTestnetConfig(state, body);
  if (state.config?.order_execution === 'binance_testnet') {
    if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
  }
  const result = await cryptoTestnetTickInternal(env, state, false, binanceTestnetCredentialsForRequest(request, env));
  state.last_tick_at = energyIso();
  await saveCryptoTestnetAccount(env, state);
  return json({ ok: true, user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cryptoTestnetStop(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const state = await loadCryptoTestnetAccount(env, userId, body);
  if (state.config?.order_execution === 'binance_testnet' || body?.testnet_close_all === true) {
    if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
  }
  const shouldLiquidate = Boolean(body?.liquidate !== false);
  const testnetCredentials = binanceTestnetCredentialsForRequest(request, env);
  const result = await cryptoTestnetTickInternal(env, state, shouldLiquidate, testnetCredentials);
  let testnetCloseAll: any = null;
  if (shouldLiquidate && (state.config?.order_execution === 'binance_testnet' || body?.testnet_close_all === true) && state.config?.testnet_close_all_on_stop !== false) {
    if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
    testnetCloseAll = await binanceTestnetCloseAll(env, testnetCredentials);
  }
  state.mode = 'stopped';
  state.stopped_at = energyIso();
  state.last_tick_at = energyIso();
  await saveCryptoTestnetAccount(env, state);
  return json({ ok: true, action: 'stopped', user_id: userId, result, testnet_close_all: testnetCloseAll, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cryptoTestnetReconcile(request: Request, env: Env, url: URL) {
  if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const state = await loadCryptoTestnetAccount(env, userId, body);
  const testnet = await binanceTestnetAccountSnapshot(env, binanceTestnetCredentialsForRequest(request, env));
  state.last_reconcile_at = energyIso();
  state.last_testnet_status = testnet.status;
  await saveCryptoTestnetAccount(env, state);
  return json({ ok: true, user_id: userId, testnet, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cryptoTestnetCloseAll(request: Request, env: Env, url: URL) {
  if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const state = await loadCryptoTestnetAccount(env, userId, body);
  const testnetCredentials = binanceTestnetCredentialsForRequest(request, env);
  const result = await binanceTestnetCloseAll(env, testnetCredentials);
  const tick = await cryptoTestnetTickInternal(env, state, true, testnetCredentials);
  state.mode = 'stopped';
  state.stopped_at = energyIso();
  state.last_tick_at = energyIso();
  await saveCryptoTestnetAccount(env, state);
  return json({ ok: true, action: 'testnet_close_all', user_id: userId, result, tick, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

const HFCD_FOOTBALL_ACCURACY_MODEL = 'HFCD_Football_V9_AccuracyFirstPredictor';

function workerFootballKickoffTime(match: any) {
  const value = match?.commence_time || match?.kickoff || match?.match_date;
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function workerIsUpcomingFootballMatch(match: any, now = Date.now()) {
  const kickoff = workerFootballKickoffTime(match);
  return kickoff === null || kickoff >= now;
}

function workerFilterFootballParlays(parlays: any[], validIds: Set<string>) {
  return (parlays || []).filter((parlay: any) => {
    const legs = Array.isArray(parlay?.legs_detail) ? parlay.legs_detail : [];
    return legs.length > 0 && legs.every((leg: any) => validIds.has(String(leg.event_id || '')));
  });
}

function getWorkerFootballFeed() {
  const feed = FOOTBALL_ACCURACY_FEED as any;
  const rawMatches = Array.isArray(feed.matches) ? feed.matches : [];
  const matches = rawMatches.filter((match: any) => workerIsUpcomingFootballMatch(match));
  const validIds = new Set<string>(matches.map((match: any) => String(match.event_id || '')));
  const parlays = workerFilterFootballParlays(feed.parlays || [], validIds);
  const officialCount = matches.filter((match: any) => match.prediction_state === 'official_available').length;
  const watchlistCount = matches.filter((match: any) => match.prediction_state === 'watchlist_available').length;
  return {
    ...feed,
    matches,
    parlays,
    model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
    accuracy_mode: true,
    summary: {
      ...(feed.summary || {}),
      raw_fixtures: rawMatches.length,
      expired_filtered: rawMatches.length - matches.length,
      current_fixtures: matches.length,
      fixtures: matches.length,
      matches_with_official: officialCount,
      matches_with_watchlist: watchlistCount,
      matches_without_signal: matches.length - officialCount - watchlistCount,
      parlay_candidates: parlays.length,
    },
    prediction_history: [
      {
        recorded_at: new Date().toISOString(),
        generated_at: feed.generated_at,
        reason: 'worker_runtime_filter',
        mode: 'embedded',
        fixtures_current: matches.length,
        fixtures_raw: rawMatches.length,
        expired_filtered: rawMatches.length - matches.length,
        official: officialCount,
        watchlist: watchlistCount,
        no_signal: matches.length - officialCount - watchlistCount,
        parlay_candidates: parlays.length,
      },
    ],
    odds_source_policy: {
      ...(feed.odds_source_policy || {}),
      official_requires_odds: false,
      note: 'V9 Accuracy-First 模式下，赔率只作为参考特征和赛前复核信息；高置信预测由模型概率、历史命中率、Brier/log-loss、校准误差和模型一致性决定。',
    },
  };
}

function workerFootballMatchName(match: any) {
  return `${match?.home_team || '-'} vs ${match?.away_team || '-'}`;
}

function workerFootballTopSignal(match: any) {
  const recommendation = match?.top_recommendation || match?.recommendations?.[0] || null;
  const predictionState = match?.prediction_state || 'no_strong_signal';
  const modelConclusion = recommendation?.accuracy_official
    ? 'official_accuracy'
    : recommendation
      ? 'watchlist'
      : predictionState === 'rejected'
        ? 'rejected'
        : 'no_signal';

  return {
    match_id: match?.event_id,
    league: match?.competition,
    kickoff: match?.commence_time,
    home_team: match?.home_team,
    away_team: match?.away_team,
    match: workerFootballMatchName(match),
    model_conclusion: modelConclusion,
    recommendation_status: recommendation?.status || null,
    market: recommendation?.market || null,
    market_family: recommendation?.market_family || null,
    selection: recommendation?.selection || null,
    model_prob: recommendation?.model_prob ?? null,
    predicted_result: recommendation?.predicted_result || recommendation?.selection || null,
    accuracy_mode: true,
    recommendation_type: 'accuracy_prediction',
    model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
    accuracy_grade: recommendation?.accuracy_grade || (recommendation ? 'B' : 'C'),
    historical_hit_rate: recommendation?.historical_hit_rate ?? null,
    rolling_hit_rate: recommendation?.rolling_hit_rate ?? null,
    baseline_hit_rate: recommendation?.baseline_hit_rate ?? null,
    hit_rate_lift: recommendation?.hit_rate_lift ?? null,
    brier_score: recommendation?.brier_score ?? null,
    log_loss: recommendation?.log_loss ?? null,
    calibration_error: recommendation?.calibration_error ?? null,
    model_agreement: recommendation?.model_agreement ?? null,
    prediction_confidence: recommendation?.prediction_confidence ?? null,
    confidence_level: recommendation?.confidence_level || null,
    failure_risk: recommendation?.failure_risk || recommendation?.failure_mode || (recommendation ? null : 'no_model_signal'),
    cross_season_pass: Boolean(recommendation?.cross_season_pass),
    accuracy_official: Boolean(recommendation?.accuracy_official),
    market_prob: recommendation?.market_prob ?? null,
    odds: recommendation?.odds ?? null,
    bookmaker: recommendation?.bookmaker || recommendation?.platform || null,
    platform: recommendation?.recommended_platform || recommendation?.bookmaker || null,
    odds_source: recommendation?.price_source || recommendation?.odds_provider || null,
    odds_source_label: recommendation?.odds_source_label || null,
    preferred_odds_provider: recommendation?.preferred_odds_provider || 'Titan007',
    preferred_odds_url: recommendation?.preferred_odds_url || 'https://guess2.titan007.com/',
    edge: recommendation?.edge ?? null,
    EV: recommendation?.ev ?? recommendation?.EV ?? null,
    confidence: recommendation?.confidence || null,
    stability_score: recommendation?.stability_score ?? null,
    failure_mode: recommendation?.failure_risk || recommendation?.failure_mode || (recommendation ? null : 'no_model_signal'),
    risk_notes: recommendation?.risk_notes || (match?.refresh_context?.tracking_note ? [match.refresh_context.tracking_note] : []),
    explanation: recommendation?.accuracy_official
      ? '模型概率、历史命中率、Brier/log-loss、校准误差和一致性达到准确率优先门槛；这是高置信结果预测，不等同于投注价值建议。'
      : recommendation
        ? '模型存在可跟踪预测信号，但概率、历史命中率、校准或一致性尚未同时达标；保留为观察预测继续审计。'
        : '当前后端没有返回足够稳定的模型信号；保持 no_signal，等待赛程、伤停、首发或临场数据更新。',
    parlay_eligible: Boolean(recommendation?.accuracy_grade !== 'C' && (recommendation?.prediction_confidence || 0) >= 0.6),
  };
}

function workerFootballFixture(match: any) {
  return {
    match_id: match?.event_id,
    league: match?.competition,
    kickoff: match?.commence_time,
    home_team: match?.home_team,
    away_team: match?.away_team,
    match: workerFootballMatchName(match),
    prediction_state: match?.prediction_state,
    top_signal: workerFootballTopSignal(match),
    candidate_count: match?.all_candidate_count || match?.recommendations?.length || 0,
    refresh_context: match?.refresh_context || null,
  };
}

function workerFootballGroups(feed: any) {
  const official: unknown[] = [];
  const watchlist: unknown[] = [];
  const rejected: unknown[] = [];
  const noSignal: unknown[] = [];

  for (const match of feed?.matches || []) {
    const mapped = workerFootballTopSignal(match);
    if (mapped.model_conclusion === 'official_accuracy') official.push(mapped);
    else if (mapped.model_conclusion === 'watchlist') watchlist.push(mapped);
    else if (mapped.model_conclusion === 'rejected') rejected.push(mapped);
    else noSignal.push(mapped);
  }

  return { official, watchlist, rejected, no_signal: noSignal };
}

function findWorkerFootballMatch(feed: any, matchId: string) {
  const normalizedId = matchId.trim().toLowerCase();
  return (feed?.matches || []).find((match: any) => {
    const searchable = [
      match.event_id,
      match.home_team,
      match.away_team,
      workerFootballMatchName(match),
      match.competition,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return match.event_id === matchId || searchable.includes(normalizedId);
  });
}

async function fetchGcsJson(env: Env, bucket: string, objectName: string) {
  try {
    const token = await getGoogleCloudAccessToken({ env });
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) return undefined;
    return response.json();
  } catch {
    return undefined;
  }
}

async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true });
  }

  if (url.pathname === '/api/locale' && request.method === 'GET') {
    const country = request.headers.get('cf-ipcountry') || (request as Request & { cf?: { country?: string } }).cf?.country;
    const locale = resolvePreferredLocale({
      country,
      acceptLanguage: request.headers.get('accept-language'),
      fallback: 'en',
    });

    return json({
      locale,
      source: country ? 'ip-country' : 'accept-language',
    });
  }

  if (url.pathname === '/api/hfcd/research-jobs/status' && request.method === 'GET') {
    if (!assertHfcdApiKey(request, env)) {
      return json({ error: 'Invalid HFCD API key.' }, { status: 401 });
    }

    const cloud = buildHFCDResearchCloudConfig(env);
    const operationName = url.searchParams.get('operationName') || undefined;
    const artifactPrefix = url.searchParams.get('artifactPrefix') || undefined;
    if (!cloud.enabled) {
      return json(
        {
          ok: false,
          status: 'not_configured',
          cloud,
          message: 'HFCD 云端长程仿真未配置。需要 HFCD_CLOUD_PROJECT_ID / HFCD_CLOUD_RUN_JOB / HFCD_GCS_BUCKET。',
        },
        { status: 503 },
      );
    }

    try {
      const operation = operationName
        ? await callGoogleApi(env, `https://run.googleapis.com/v2/${operationName}`)
        : undefined;
      const manifest = artifactPrefix && cloud.bucket
        ? await fetchGcsJson(env, cloud.bucket, `${artifactPrefix}/cloud_manifest.json`)
        : undefined;
      const status = (manifest as { status?: string } | undefined)?.status || operationToStatus(operation);
      return json({
        ok: status !== 'failed',
        status,
        operationName,
        operation,
        artifactPrefix,
        manifest,
      });
    } catch (error) {
      return json(
        {
          ok: false,
          status: 'unknown',
          operationName,
          artifactPrefix,
          message: error instanceof Error ? error.message : 'HFCD research status query failed.',
        },
        { status: 500 },
      );
    }
  }

  if (url.pathname === '/api/hfcd/football/status' && request.method === 'GET') {
    const feed = getWorkerFootballFeed();
    return json({
      ok: true,
      mode: 'embedded_accuracy_feed',
      model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
      accuracy_mode: true,
      generated_at: feed.generated_at,
      version: feed.version,
      matches: (feed.matches || []).length,
      parlays: (feed.parlays || []).length,
      note: 'Cloudflare Worker 使用随构建发布的 Accuracy-First feed；实时刷新由后端私有任务更新后再发布。',
    });
  }

  if (url.pathname === '/api/hfcd/football/simple-predict' && request.method === 'GET') {
    return json(getWorkerFootballFeed(), {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }

  if (url.pathname === '/api/football/fixtures' && request.method === 'GET') {
    const feed = getWorkerFootballFeed();
    return json({
      ok: true,
      generated_at: feed.generated_at,
      version: feed.version,
      model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
      accuracy_mode: true,
      supported_competitions: feed.supported_competitions || [],
      fixtures: (feed.matches || []).map(workerFootballFixture),
    });
  }

  if (url.pathname === '/api/football/predict' && request.method === 'GET') {
    const feed = getWorkerFootballFeed();
    const groups = workerFootballGroups(feed);
    return json({
      ok: true,
      generated_at: feed.generated_at,
      version: feed.version,
      model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
      accuracy_mode: true,
      summary: {
        ...(feed.summary || {}),
        official_accuracy: groups.official.length,
        official: groups.official.length,
        watchlist: groups.watchlist.length,
        rejected: groups.rejected.length,
        no_signal: groups.no_signal.length,
        parlay_candidates: (feed.parlays || []).length,
      },
      odds_source_policy: feed.odds_source_policy || null,
      groups,
      parlays: feed.parlays || [],
      fixtures: (feed.matches || []).map(workerFootballFixture),
    });
  }

  if (url.pathname === '/api/football/parlay' && request.method === 'GET') {
    const feed = getWorkerFootballFeed();
    return json({
      ok: true,
      generated_at: feed.generated_at,
      version: feed.version,
      model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
      accuracy_mode: true,
      parlays: feed.parlays || [],
    });
  }

  if (url.pathname === '/api/energy-trading/dashboard' && request.method === 'GET') {
    try {
      return await energyTradingDashboard(request, env, url);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : 'Energy trading dashboard failed.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  if (url.pathname === '/api/energy-trading/history' && request.method === 'GET') {
    try {
      return await energyTradingHistory(request, env, url);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : 'Energy trading history failed.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  if (url.pathname === '/api/market-trading/dashboard' && request.method === 'GET') {
    try {
      return await marketTradingDashboard(request, env, url);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : 'Market trading dashboard failed.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  if (url.pathname === '/api/gold-trading/dashboard' && request.method === 'GET') {
    try {
      return await goldTradingDashboard(request, env, url);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : 'Gold trading dashboard failed.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  if (url.pathname === '/api/crypto-testnet/dashboard' && request.method === 'GET') {
    try {
      return await cryptoTestnetDashboard(request, env, url);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : 'Crypto testnet dashboard failed.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  if (url.pathname.startsWith('/api/football/predict/') && request.method === 'GET') {
    const feed = getWorkerFootballFeed();
    const matchId = decodeURIComponent(url.pathname.replace('/api/football/predict/', ''));
    const match = findWorkerFootballMatch(feed, matchId);
    if (!match) {
      return json({ ok: false, error: 'Match not found.', matchId }, { status: 404 });
    }
    const recommendations = (match.recommendations || []).map((recommendation: any) => ({
      ...workerFootballTopSignal({ ...match, top_recommendation: recommendation }),
      recommendation_status: recommendation?.status || null,
    }));
    const prediction = workerFootballTopSignal(match);
    const parlays = (feed.parlays || []).filter((parlay: any) =>
      (parlay.legs_detail || []).some((leg: any) => leg.event_id === match.event_id),
    );
    return json({
      ok: true,
      match: workerFootballFixture(match),
      prediction,
      markets: recommendations,
      parlays,
    });
  }

  if (url.pathname === '/api/energy/health' && request.method === 'GET') {
    const feed = getWorkerEnergyFeed();
    return json(
      {
        ok: true,
        version: feed.version,
        generated_at: feed.generated_at,
        mode: 'embedded_energy_runtime_feed',
        summary_version: feed.smoke?.summary_version || feed.version,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (url.pathname === '/api/energy/summary' && request.method === 'GET') {
    return json(getWorkerEnergySummaryPayload(), { headers: { 'Cache-Control': 'no-store' } });
  }

  if (url.pathname === '/api/energy/registry' && request.method === 'GET') {
    const feed = getWorkerEnergyFeed();
    return json({ ok: true, records: feed.registry || [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (url.pathname === '/api/energy/heads' && request.method === 'GET') {
    return json(
      { ok: true, records: filterWorkerEnergyHeads(url.searchParams.get('status')) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (url.pathname === '/api/energy/cards' && request.method === 'GET') {
    const feed = getWorkerEnergyFeed();
    const cards = Array.isArray(feed.cards) ? feed.cards : [];
    return json(
      {
        ok: true,
        runtime_cards_count: cards.filter((card: any) => card.card_type === 'load_forecast_runtime_card').length,
        capability_cards_count: cards.filter((card: any) => card.card_type === 'capability_card').length,
        cards,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (url.pathname === '/api/energy/watchlist' && request.method === 'GET') {
    const feed = getWorkerEnergyFeed();
    return json({ ok: true, records: feed.watchlist || [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (url.pathname === '/api/energy/templates' && request.method === 'GET') {
    const feed = getWorkerEnergyFeed();
    return json(
      { ok: true, templates: feed.templates || {}, template_ids: Object.keys(feed.templates || {}) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, { status: 405 });
  }

  try {
    if (url.pathname === '/api/energy-trading/start') {
      return energyTradingStart(request, env, url);
    }

    if (url.pathname === '/api/energy-trading/tick') {
      return energyTradingTick(request, env, url);
    }

    if (url.pathname === '/api/energy-trading/stop') {
      return energyTradingStop(request, env, url);
    }

    if (url.pathname === '/api/market-trading/start') {
      return marketTradingStart(request, env, url);
    }

    if (url.pathname === '/api/market-trading/tick') {
      return marketTradingTick(request, env, url);
    }

    if (url.pathname === '/api/market-trading/stop') {
      return marketTradingStop(request, env, url);
    }

    if (url.pathname === '/api/gold-trading/start') {
      return goldTradingStart(request, env, url);
    }

    if (url.pathname === '/api/gold-trading/tick') {
      return goldTradingTick(request, env, url);
    }

    if (url.pathname === '/api/gold-trading/stop') {
      return goldTradingStop(request, env, url);
    }

    if (url.pathname === '/api/crypto-testnet/start') {
      return cryptoTestnetStart(request, env, url);
    }

    if (url.pathname === '/api/crypto-testnet/tick') {
      return cryptoTestnetTick(request, env, url);
    }

    if (url.pathname === '/api/crypto-testnet/stop') {
      return cryptoTestnetStop(request, env, url);
    }

    if (url.pathname === '/api/crypto-testnet/reconcile') {
      return cryptoTestnetReconcile(request, env, url);
    }

    if (url.pathname === '/api/crypto-testnet/close-all') {
      return cryptoTestnetCloseAll(request, env, url);
    }

    if (url.pathname === '/api/energy/adapt-csv') {
      const feed = getWorkerEnergyFeed();
      const body: any = await request.json().catch(() => ({}));
      return json({
        ok: true,
        mode: 'schema_preview',
        message: '主服务已接入能源运行接口。当前端上传 CSV 后，可按模板字段做 schema 体检；完整在线适配将在下一轮接入真实任务队列。',
        received: {
          industry: body.industry || body.dataset_type || null,
          rows: Array.isArray(body.rows) ? body.rows.length : null,
        },
        templates: Object.keys(feed.templates || {}),
      });
    }

    if (url.pathname === '/api/energy/predict-load') {
      const feed = getWorkerEnergyFeed();
      const body: any = await request.json().catch(() => ({}));
      return json({
        ok: true,
        mode: 'embedded_runtime_cards',
        message: '返回当前已验证的能源预测运行卡片；如需实时预测，请提交 CSV 接入任务。',
        request: {
          dataset: body.dataset || null,
          horizon: body.horizon || null,
        },
        cards: feed.cards || [],
      });
    }

    if (url.pathname === '/api/gemini/chat/stream') {
      const { messages, model, systemInstruction, webSearchEnabled = true } = await request.json();
      const contents = await buildContents(messages || []);
      const vertexEnabled = Boolean(
        env.VERTEX_ENABLED === 'true' &&
          env.VERTEX_TUNED_MODEL &&
          (env.VERTEX_SERVICE_ACCOUNT_JSON_BASE64 || env.VERTEX_SERVICE_ACCOUNT_JSON),
      );
      const body = {
        contents,
        systemInstruction: normalizeSystemInstruction(systemInstruction),
        generationConfig: {
          temperature: 0.7,
        },
        ...(!vertexEnabled && webSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
      };

      if (vertexEnabled) {
        return streamVertexToNdjson({ env }, env.VERTEX_TUNED_MODEL!, body);
      }

      return streamGeminiToNdjson({ env }, model, {
        ...body,
        ...(webSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
      });
    }

    if (url.pathname === '/api/gemini/evaluate') {
      const { prompt, model } = await request.json();
      const response = await geminiGenerateJson({ env }, model, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      });

      const text =
        response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return json({ data: JSON.parse(cleaned) });
    }

    if (url.pathname === '/api/gemini/light-log') {
      const { prompt, model } = await request.json();
      const response = await geminiGenerateJson({ env }, model, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      });

      const text =
        response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
      return json({ text: text || '未提取到明显的光性变化。' });
    }

    if (url.pathname === '/api/wuxing/instruction') {
      const payload = await request.json();
      const cacheKey = buildInstructionCacheKey(payload);
      const cached = instructionCache.get(cacheKey);
      if (cached) {
        return json({ instruction: cached });
      }
      
      const { baseInstruction, systemInstruction, omegaPrompt, content, diagnosis } = payload;
      const instruction = buildInternalizedOperatingInstruction({
        baseInstruction,
        systemInstruction,
        omegaPrompt,
        content,
        diagnosis,
      });
      setInstructionCache(cacheKey, instruction);
      return json({
        instruction,
      });
    }

    if (url.pathname === '/api/hfcd/research-jobs/submit') {
      if (!assertHfcdApiKey(request, env)) {
        return json({ error: 'Invalid HFCD API key.' }, { status: 401 });
      }

      const payload = (await request.json()) as HFCDResearchJobRequest;
      const cloud = buildHFCDResearchCloudConfig(env);
      const plan = buildHFCDResearchJobPlan(payload, env);
      if (!cloud.enabled) {
        return json(
          {
            ok: false,
            status: 'not_configured',
            plan,
            cloud,
            message: 'HFCD 云端长程仿真未配置。需要先部署 Cloud Run Job 与 GCS 源目录。',
          },
          { status: 503 },
        );
      }

      const envVars = {
        ...plan.env,
        HFCD_JOB_ID: plan.jobId,
        HFCD_GCS_BUCKET: cloud.bucket || '',
        HFCD_SOURCE_GCS_PREFIX: plan.sourcePrefix,
        HFCD_ARTIFACT_PREFIX: plan.artifactPrefix,
        HFCD_EXPERIMENT_SCRIPT: plan.experimentScript,
        HFCD_OUTPUT_GLOBS: plan.outputGlobs,
      };
      const operation = await callGoogleApi(
        env,
        `https://run.googleapis.com/v2/projects/${cloud.projectId}/locations/${cloud.region}/jobs/${cloud.cloudRunJob}:run`,
        {
          method: 'POST',
          body: JSON.stringify({
            overrides: {
              taskCount: 1,
              timeout: '3600s',
              containerOverrides: [
                {
                  env: Object.entries(envVars).map(([name, value]) => ({
                    name,
                    value: String(value),
                  })),
                },
              ],
            },
          }),
        },
      );

      return json({
        ok: true,
        status: 'queued',
        plan,
        cloud,
        operationName: operation?.name,
        operation,
      });
    }

    if (url.pathname === '/api/hfcd/audit') {
      if (!assertHfcdApiKey(request, env)) {
        return json({ error: 'Invalid HFCD API key.' }, { status: 401 });
      }

      const payload = (await request.json()) as {
        industry?: HFCDIndustry;
        rows?: Array<Record<string, unknown>>;
        records?: Array<Record<string, unknown>>;
        csv?: string;
        model?: string;
        mode?: 'audit' | 'calibrate' | 'simulate' | 'advanced' | 'field';
        thresholds?: Partial<HFCDGates>;
        fieldSimulation?: HFCDFieldSimulationInput;
      };
      const industry = payload.industry || 'quantum';
      const rows = payload.csv ? parseCsv(payload.csv) : payload.rows || payload.records || [];
      const validation = validateRows(rows, industry);
      if (!validation.isValid) {
        return json({ error: 'Invalid HFCD input.', validation }, { status: 400 });
      }

      const mode = payload.mode || 'audit';
      const parameterProfile = mode === 'audit' && !payload.thresholds ? undefined : learnHFCDParameters(rows, industry);
      const activeThresholds = payload.thresholds
        ? normalizeHFCDThresholds(payload.thresholds)
        : parameterProfile?.thresholds;
      const results = auditRecords(rows, industry, { thresholds: activeThresholds });
      const simulation =
        mode === 'simulate' || mode === 'advanced'
          ? simulateHFCDScenarios(rows, industry, parameterProfile || learnHFCDParameters(rows, industry))
          : undefined;
      const fieldSimulation =
        mode === 'field' || (mode === 'advanced' && payload.fieldSimulation)
          ? runHFCDFieldSimulation({
              rows,
              industry,
              profile: parameterProfile || learnHFCDParameters(rows, industry),
              input: payload.fieldSimulation,
            })
          : undefined;
      return json({
        model: payload.model || 'hfcd-v1',
        mode,
        industry,
        validation,
        parameterProfile,
        thresholds: activeThresholds,
        summary: summarizeAudit(results),
        gateSafety: summarizeGateSafety(results),
        blindMetrics: validateBlindMetrics(results),
        simulation,
        fieldSimulation,
        results,
      });
    }

    return json({ error: 'Not found.' }, { status: 404 });
  } catch (error) {
    console.error('Worker API error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Worker request failed.' },
      { status: 500 },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
