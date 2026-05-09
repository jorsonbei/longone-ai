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

function bodyHasValue(body: any, key: string) {
  return body && body[key] !== undefined && body[key] !== null && body[key] !== '';
}

function bodyNumber(
  body: any,
  config: any,
  key: string,
  fallback: number,
  options: { min?: number; max?: number; integer?: boolean } = {},
) {
  const raw = bodyHasValue(body, key) ? body[key] : config?.[key];
  let value = Number(raw);
  if (!Number.isFinite(value)) value = fallback;
  if (options.integer) value = Math.round(value);
  if (options.min !== undefined) value = Math.max(options.min, value);
  if (options.max !== undefined) value = Math.min(options.max, value);
  return value;
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
    last_tick_at: '',
    initial_cash_usd: capital,
    cash_usd: capital,
    settled_equity_usd: capital,
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

async function clearEnergyTrades(env: Env, userId: string) {
  const db = await ensureEnergyTradingDb(env);
  if (!db) return;
  await db.prepare('DELETE FROM energy_trades WHERE user_id = ?').bind(userId).run();
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

function applyEnergyTradingConfig(state: any, body: any = {}, allowCapitalReset = false) {
  const cfg = state.config || {};
  state.config = {
    ...cfg,
    fixed_trade_usd: bodyNumber(body, cfg, 'fixed_trade_usd', 10_000, { min: 1 }),
    max_position_pct: bodyNumber(body, cfg, 'max_position_pct', 0.08, { min: 0.001, max: 1 }),
    max_open_positions: bodyNumber(body, cfg, 'max_open_positions', 10, { min: 1, max: 50, integer: true }),
    max_order_mwh: bodyNumber(body, cfg, 'max_order_mwh', 25, { min: 0.001 }),
    min_abs_spread: bodyNumber(body, cfg, 'min_abs_spread', 4.5, { min: 0 }),
    min_abs_prediction_mw: bodyNumber(body, cfg, 'min_abs_prediction_mw', 100, { min: 0 }),
    min_tier_rank: bodyNumber(body, cfg, 'min_tier_rank', 2, { min: 0, integer: true }),
    stop_loss_usd: bodyNumber(body, cfg, 'stop_loss_usd', 450, { min: 0.01 }),
    take_profit_usd: bodyNumber(body, cfg, 'take_profit_usd', 900, { min: 0.01 }),
    strategy: String(body.strategy || cfg.strategy || 'qhopf_selector'),
    sizing_mode: String(body.sizing_mode || cfg.sizing_mode || 'fixed_usd'),
    updated_at: energyIso(),
  };
  if (allowCapitalReset && bodyHasValue(body, 'capital_usd')) {
    const capital = bodyNumber(body, { capital_usd: state.initial_cash_usd }, 'capital_usd', state.initial_cash_usd || 1_000_000, { min: 1 });
    state.initial_cash_usd = capital;
    state.cash_usd = capital;
    state.settled_equity_usd = capital;
    state.equity_usd = capital;
    state.peak_equity_usd = capital;
  }
  return state.config;
}

async function energyTradingConfig(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = energyUserId(request, url, body);
  const state = await loadEnergyAccount(env, userId);
  applyEnergyTradingConfig(state, body, false);
  state.last_config_updated_at = energyIso();
  await saveEnergyAccount(env, state);
  return json({ ok: true, action: 'config_updated', user_id: userId, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function energyTradingStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = energyUserId(request, url, body);
  const existing = await loadEnergyAccount(env, userId);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultEnergyTradingAccount(userId, body) : existing;
  applyEnergyTradingConfig(state, body, isFresh);
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
  if (Object.keys(body || {}).some((key) => key !== 'user_id' && key !== 'auto_tick_reason')) {
    applyEnergyTradingConfig(state, body, false);
  }
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

const COMMODITY_ENERGY_VERSION = 'HFCD_Commodity_V7_8_V75MinimalStateRepairShadowLedger';
const COMMODITY_ENERGY_FEE_RATE = 0.00055;
const COMMODITY_ENERGY_PROPERTY_DIMS = ['Q', 'DeltaSigma', 'C', 'Pi', 'Sigma', 'Eta', 'BSigma', 'R', 'Tau', 'Omega'];
const FORECAST_EDGE_GATE_PROMOTED = true;
const HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION = 'HFCD_UniversalForecastEdgePositionController_V1';
const HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE =
  '无仓才开仓；同向已有仓位只在预测空间和信号强度继续增强时加仓；同向变弱则持有或减仓；弱反向只减仓/平仓；强反向第一次只平旧仓并排队，下一 tick 第二次确认后才反手；禁止同 tick 反手；所有动作必须通过预测边际门。';
const COMMODITY_ENERGY_TENSOR_GUARD_VERSION = 'V7.8_V75MinimalStateRepairShadow';
const COMMODITY_ENERGY_TENSOR_PARAMS = {
  add_min: 0.34,
  reverse_min: 0.42,
  reduce_hold_min: 0.34,
  tensor_power: 0.50,
};

function hfcdClamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function forecastEdgeGate(input: any) {
  const mode = String(input.mode || 'price');
  const current = Number(input.current_value ?? input.currentPrice ?? 0);
  const expected = Number(input.expected_future_value ?? input.expectedFutureValue ?? current);
  const side = String(input.side || '').toLowerCase();
  const sideSign = side === 'short' ? -1 : side === 'long' ? 1 : 0;
  const denominator = mode === 'spread' ? Math.max(Math.abs(current), 1) : Math.max(Math.abs(current), 1e-9);
  const expectedDeltaPct = sideSign === 0 ? 0 : ((expected - current) / denominator) * sideSign;
  const roundtripFeePct = Math.max(0, Number(input.fee_rate || 0)) * Number(input.fee_sides || 2);
  const spreadPct = Math.max(0, Number(input.spread_bps || 0)) / 10000;
  const slippagePct = Math.max(0, Number(input.slippage_bps || 0)) / 10000;
  const costPct = roundtripFeePct + spreadPct + slippagePct;
  const riskBufferPct = Math.max(
    Math.max(0, Number(input.risk_buffer_pct || 0)),
    Math.max(0, Number(input.realized_vol || 0)) * Math.max(0, Number(input.vol_multiplier || 0)),
  );
  const minEdgePct = Math.max(0, Number(input.min_edge_pct || 0.001));
  const netEdgePct = expectedDeltaPct - costPct - riskBufferPct;
  const ok = sideSign !== 0 && Number.isFinite(netEdgePct) && netEdgePct >= minEdgePct;
  const maxMultiplier = Math.max(0.2, Number(input.max_multiplier || 1.6));
  const positionMultiplier = ok
    ? hfcdClamp(netEdgePct / Math.max(minEdgePct * 3, 0.0001), Number(input.min_multiplier || 0.25), maxMultiplier)
    : 0;
  return {
    ok,
    side: sideSign === 1 ? 'long' : sideSign === -1 ? 'short' : 'flat',
    action: ok ? (sideSign === 1 ? 'LONG' : 'SHORT') : 'FLAT',
    current_value: Number(current.toFixed(8)),
    expected_future_value: Number(expected.toFixed(8)),
    expected_delta_pct: Number(expectedDeltaPct.toFixed(6)),
    cost_pct: Number(costPct.toFixed(6)),
    risk_buffer_pct: Number(riskBufferPct.toFixed(6)),
    min_edge_pct: Number(minEdgePct.toFixed(6)),
    forecast_edge_pct: Number(netEdgePct.toFixed(6)),
    position_multiplier: Number(positionMultiplier.toFixed(4)),
    reason: ok
      ? `预测空间通过：edge=${netEdgePct.toFixed(4)}`
      : `预测空间不足：edge=${netEdgePct.toFixed(4)} < ${minEdgePct.toFixed(4)}`,
  };
}
const COMMODITY_ENERGY_PROPERTY_WEIGHTS: Record<string, Record<string, number>> = {
  'CL=F': { Q: 8, DeltaSigma: 18, C: 11, Pi: 13, Sigma: 17, Eta: 8, BSigma: 8, R: 7, Tau: 13, Omega: 7 },
  'HO=F': { Q: 8, DeltaSigma: 13, C: 12, Pi: 14, Sigma: 16, Eta: 10, BSigma: 7, R: 7, Tau: 13, Omega: 10 },
};
const COMMODITY_ENERGY_PROPERTY_GATES: Record<string, Record<string, number>> = {
  'CL=F': {
    min_property_score: 0.58,
    min_open_add_score: 0.62,
    min_reverse_score: 0.66,
    min_signed_abs: 0.30,
    max_bsigma: 0.70,
    max_reverse_bsigma: 0.66,
    min_c: 0.55,
    min_sigma: 0.60,
    min_tau: 0.50,
    max_eta: 0.90,
  },
  'HO=F': {
    min_property_score: 0.57,
    min_open_add_score: 0.61,
    min_reverse_score: 0.65,
    min_signed_abs: 0.30,
    max_bsigma: 0.72,
    max_reverse_bsigma: 0.67,
    min_c: 0.54,
    min_sigma: 0.60,
    min_tau: 0.50,
    max_eta: 0.92,
  },
};
const COMMODITY_ENERGY_ROUTES = [
  {
    symbol: 'HO=F',
    display_symbol: 'HO=F',
    name: '取暖油期货',
    cadence: '2h',
    lineage_id: 'HO_V5_9_2h',
    source_version: 'V7.8',
    lineage_role: 'candidate_paper_trade_core',
    route_role: 'candidate_paper_trade_core',
    source_rule: 'HO=F_2h_ensemble_ridge_density_rate0.28_q0.00_max1_rw0.65_floor0.2309',
    candidate_rule: 'V7.8：主信号继承 V7.5 HO=F 2h；执行层采用 V7.7 最小状态修复，同 tick 平仓后不重开，反手下一 tick 确认。',
    lookback_minutes: 120,
    max_units: 1,
    min_score: 0.68,
    blind_hit_rate: 0.733333,
    blind_profit_factor: 2.999655,
    blind_pnl_usd: 29.242738,
    blind_actions: 16,
    active_signal_bars: 15,
    duplicate_open_count: 0,
    wrong_reverse_count: 0,
    actions_per_day: 1.142857,
    forward_enabled: true,
    online_trade_allowed: true,
    promotion_status: 'v7_8_minimal_state_repair_shadow_candidate',
  },
  {
    symbol: 'CL=F',
    display_symbol: 'CL=F',
    name: 'WTI 原油期货',
    cadence: '3h',
    lineage_id: 'CL_V5_4_3h',
    source_version: 'V7.8',
    lineage_role: 'candidate_paper_trade_core',
    route_role: 'candidate_paper_trade_core',
    source_rule: 'CL=F_3h_hist_gb_conf0.62_cons1_q0.45_max2',
    candidate_rule: 'V7.8：主信号继承 V7.5 CL=F 3h；执行层采用 V7.7 最小状态修复，同 tick 平仓后不重开，反手下一 tick 确认。',
    lookback_minutes: 180,
    max_units: 2,
    min_score: 0.66,
    blind_hit_rate: 0.642857,
    blind_profit_factor: 2.923563,
    blind_pnl_usd: 59.798494,
    blind_actions: 27,
    active_signal_bars: 28,
    duplicate_open_count: 0,
    wrong_reverse_count: 0,
    actions_per_day: 1.945946,
    forward_enabled: true,
    online_trade_allowed: true,
    promotion_status: 'v7_8_minimal_state_repair_shadow_candidate',
  },
];

function commodityEnergyUserId(request: Request, url: URL, body?: any) {
  const base = energyUserId(request, url, body);
  return `commodity_${base}`.slice(0, 80);
}

function commodityEnergyRoute(symbol: string) {
  return COMMODITY_ENERGY_ROUTES.find((route) => route.symbol === symbol) || COMMODITY_ENERGY_ROUTES[0];
}

function commodityEnergyFallbackSeries(route: any) {
  const base = route.symbol === 'CL=F' ? 96 : 3.9;
  const now = Date.now();
  const rows = Array.from({ length: 360 }, (_, index) => {
    const t = now - (359 - index) * 5 * 60000;
    const wave =
      Math.sin(t / 5400000 + route.symbol.length) * 0.006 +
      Math.sin(t / 43200000 + route.symbol.charCodeAt(0)) * 0.012;
    return {
      ts: new Date(t).toISOString(),
      close: Number((base * (1 + wave)).toFixed(route.symbol === 'HO=F' ? 4 : 2)),
      volume: 1000 + Math.round(Math.abs(Math.sin(t / 3600000)) * 800),
    };
  });
  return {
    ...route,
    source: `fallback_simulated:${route.symbol}:5m`,
    is_real_market_data: false,
    rows,
  };
}

async function fetchCommodityEnergySeries(route: any) {
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(route.symbol)}?range=10d&interval=5m&includePrePost=true`,
      {
        headers: {
          accept: 'application/json',
          'user-agent': 'HFCD-ThingNature-OS/1.0',
        },
      },
    );
    if (!response.ok) throw new Error(`Yahoo ${route.symbol} ${response.status}`);
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
    if (rows.length < 80) throw new Error(`Yahoo ${route.symbol} insufficient rows`);
    return {
      ...route,
      source: `yahoo_chart:${route.symbol}:5m`,
      is_real_market_data: true,
      rows,
    };
  } catch {
    return commodityEnergyFallbackSeries(route);
  }
}

function commodityEnergyStd(values: number[]) {
  return marketStd(values.filter((value) => Number.isFinite(value)));
}

function commodityEnergyClamp01(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function commodityEnergyLogistic(value: number) {
  const clipped = Math.max(-50, Math.min(50, value));
  return 1 / (1 + Math.exp(-clipped));
}

function commodityEnergyReturnOver(closes: number[], idx: number, minutes: number, baseMinutes = 5) {
  const bars = Math.max(1, Math.round(minutes / Math.max(baseMinutes, 1)));
  if (idx - bars < 0) return 0;
  return closes[idx] / Math.max(closes[idx - bars], 1e-9) - 1;
}

function commodityEnergyRollingVol(closes: number[], idx: number, bars: number) {
  const start = Math.max(1, idx - bars);
  const rets: number[] = [];
  for (let i = start + 1; i <= idx; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  return Math.max(commodityEnergyStd(rets), 0.0001);
}

function commodityEnergyWindowEfficiency(closes: number[], idx: number, minutes: number, baseMinutes = 5) {
  const bars = Math.max(2, Math.round(minutes / Math.max(baseMinutes, 1)));
  if (idx - bars < 0) return 0;
  const slice = closes.slice(idx - bars, idx + 1);
  const net = Math.abs(slice[slice.length - 1] - slice[0]);
  let path = 0;
  for (let i = 1; i < slice.length; i += 1) path += Math.abs(slice[i] - slice[i - 1]);
  return path > 0 ? net / path : 0;
}

function commodityEnergyPropertyWeights(symbol: string) {
  return COMMODITY_ENERGY_PROPERTY_WEIGHTS[symbol] || COMMODITY_ENERGY_PROPERTY_WEIGHTS['CL=F'];
}

function commodityEnergyPropertyGates(symbol: string) {
  return COMMODITY_ENERGY_PROPERTY_GATES[symbol] || COMMODITY_ENERGY_PROPERTY_GATES['CL=F'];
}

function commodityEnergyComputeProperties(series: any, closes: number[], volumes: number[]) {
  const idx = closes.length - 1;
  const baseMinutes = 5;
  const ret60 = commodityEnergyReturnOver(closes, idx, 60, baseMinutes);
  const ret120 = commodityEnergyReturnOver(closes, idx, 120, baseMinutes);
  const ret180 = commodityEnergyReturnOver(closes, idx, 180, baseMinutes);
  const ret300 = commodityEnergyReturnOver(closes, idx, 300, baseMinutes);
  const ret1440 = commodityEnergyReturnOver(closes, idx, 1440, baseMinutes);
  const vol1h = commodityEnergyRollingVol(closes, idx, Math.max(10, Math.round(60 / baseMinutes)));
  const vol24h = commodityEnergyRollingVol(closes, idx, Math.max(40, Math.round(1440 / baseMinutes)));
  const shortPressure = (ret60 + ret120) / 2;
  const mediumPressure = (ret180 + ret300) / 2;
  const longPressure = ret1440;
  const close = closes[idx] || 0;
  const window5h = closes.slice(Math.max(0, idx - Math.round(300 / baseMinutes)), idx + 1);
  const high5h = Math.max(...window5h, close);
  const low5h = Math.min(...window5h, close);
  const drawdown = close / Math.max(high5h, 1e-9) - 1;
  const rangePct = (high5h - low5h) / Math.max(close, 1e-9);
  const recentVol = volumes.slice(Math.max(0, idx - Math.round(60 / baseMinutes)), idx + 1).reduce((sum, value) => sum + Number(value || 0), 0);
  const dayVolSlice = volumes.slice(Math.max(0, idx - Math.round(1440 / baseMinutes)), idx + 1);
  const baseVol = dayVolSlice.reduce((sum, value) => sum + Number(value || 0), 0) / Math.max(dayVolSlice.length, 1) * Math.max(1, Math.round(60 / baseMinutes));
  const volumeShock = recentVol / Math.max(baseVol, 1) - 1;
  const eff3h = commodityEnergyWindowEfficiency(closes, idx, 180, baseMinutes);
  const eff5h = commodityEnergyWindowEfficiency(closes, idx, 300, baseMinutes);
  const sameSign = (a: number, b: number) => Math.sign(a) === Math.sign(b) ? 1 : 0;
  const alignment = (sameSign(ret60, ret120) + sameSign(ret120, ret180) + sameSign(ret180, ret300) + sameSign(ret300, ret1440)) / 4;
  const properties: Record<string, number> = {
    Q: commodityEnergyClamp01(0.72 + 0.20 * alignment - 3.5 * Math.abs(drawdown) - 1.6 * rangePct),
    DeltaSigma: commodityEnergyLogistic((0.45 * ret300 + 0.35 * ret180 + 0.20 * ret1440) / Math.max(vol24h, 1e-5)),
    C: commodityEnergyClamp01(0.48 + 0.24 * commodityEnergyLogistic(volumeShock) + 0.20 * (1 - Math.min(rangePct / 0.035, 1)) + 0.08 * alignment),
    Pi: commodityEnergyClamp01(0.20 + 0.35 * eff3h + 0.25 * eff5h + 0.20 * alignment),
    Sigma: commodityEnergyLogistic((0.50 * mediumPressure + 0.25 * longPressure + 0.25 * volumeShock * vol24h) / Math.max(vol24h, 1e-5)),
    Eta: commodityEnergyClamp01(vol1h / Math.max(vol24h, 1e-5) / 2),
    BSigma: commodityEnergyClamp01(0.30 * Math.min(Math.abs(volumeShock), 2) / 2 + 0.45 * Math.min(Math.abs(shortPressure) / Math.max(vol1h * 3, 1e-5), 1) + 0.25 * (1 - alignment)),
    R: commodityEnergyClamp01(0.30 + 0.45 * Math.min(Math.abs(mediumPressure) / Math.max(vol24h * 4, 1e-5), 1) + 0.25 * Math.min(vol1h / Math.max(vol24h, 1e-5), 2) / 2),
    Tau: commodityEnergyClamp01(0.50 + 0.30 * Math.sign(longPressure) * Math.min(Math.abs(longPressure) / Math.max(vol24h * 8, 1e-5), 1) + 0.20 * alignment),
    Omega: commodityEnergyClamp01(0.35 + 0.35 * alignment + 0.30 * Math.min(Math.abs(shortPressure + mediumPressure) / Math.max(vol24h * 5, 1e-5), 1)),
  };
  const weights = commodityEnergyPropertyWeights(series.symbol);
  const weightTotal = COMMODITY_ENERGY_PROPERTY_DIMS.reduce((sum, dim) => sum + Number(weights[dim] || 0), 0) || 1;
  const propertyScore = COMMODITY_ENERGY_PROPERTY_DIMS.reduce((sum, dim) => sum + Number(weights[dim] || 0) / weightTotal * properties[dim], 0);
  const vol = Math.max(commodityEnergyRollingVol(closes, idx, Math.max(20, Math.round(300 / baseMinutes))), 1e-5);
  const trend = Number(weights.Pi || 0) * (0.42 * ret60 + 0.32 * ret120 + 0.26 * ret180);
  const ledger = Number(weights.Sigma || 0) * (0.45 * ret180 + 0.35 * ret300 + 0.20 * ret1440);
  const macro = Number(weights.DeltaSigma || 0) * (0.55 * ret300 + 0.45 * ret1440);
  const tau = Number(weights.Tau || 0) * (ret1440 - ret60 * 0.35);
  const omega = Number(weights.Omega || 0) * (0.50 * ret120 + 0.50 * ret180);
  const riskDrag = Number(weights.BSigma || 0) * (properties.BSigma - 0.5) * vol * 1.8;
  const signedSignal = Math.tanh(((trend + ledger + macro + tau + omega) / Math.max(weightTotal, 1) - riskDrag) / Math.max(vol * 3, 1e-5));
  const propertyDirection = signedSignal > 0 ? 'long' : signedSignal < 0 ? 'short' : 'flat';
  return {
    score: Number(propertyScore.toFixed(4)),
    signed_signal: Number(signedSignal.toFixed(4)),
    direction: propertyDirection,
    dimensions: Object.fromEntries(COMMODITY_ENERGY_PROPERTY_DIMS.map((dim) => [dim, Number(properties[dim].toFixed(4))])),
    lookbacks: {
      ret_1h: Number(ret60.toFixed(6)),
      ret_2h: Number(ret120.toFixed(6)),
      ret_3h: Number(ret180.toFixed(6)),
      ret_5h: Number(ret300.toFixed(6)),
      ret_24h: Number(ret1440.toFixed(6)),
    },
  };
}

function commodityEnergyPropertyConfirms(signal: any, targetSide: string, strict = false) {
  const property = signal.property_vector || {};
  const dims = property.dimensions || {};
  const gates = commodityEnergyPropertyGates(signal.symbol);
  const reasons: string[] = [];
  const minScore = strict ? Number(gates.min_reverse_score || 0.66) : Number(gates.min_open_add_score || 0.62);
  const maxBSigma = strict ? Number(gates.max_reverse_bsigma || 0.66) : Number(gates.max_bsigma || 0.70);
  if (property.direction !== targetSide) reasons.push(`物性方向${property.direction || 'flat'}不确认${targetSide}`);
  if (Number(property.score || 0) < minScore) reasons.push(`物性分${Number(property.score || 0).toFixed(3)}低于${minScore.toFixed(3)}`);
  if (Math.abs(Number(property.signed_signal || 0)) < Number(gates.min_signed_abs || 0.3)) reasons.push('物性势能不足');
  if (Number(dims.C || 0) < Number(gates.min_c || 0.55)) reasons.push('C腔不足');
  if (Number(dims.Sigma || 0) < Number(gates.min_sigma || 0.60)) reasons.push('Σ账本不足');
  if (Number(dims.Tau || 0) < Number(gates.min_tau || 0.50)) reasons.push('τ时间项不足');
  if (Number(dims.BSigma || 0) > maxBSigma) reasons.push('Bσ黑子过高');
  if (Number(dims.Eta || 0) > Number(gates.max_eta || 0.90)) reasons.push('η噪声过高');
  return { ok: reasons.length === 0, reason: reasons.join('；') || 'V7.8稳定窗确认' };
}

function commodityEnergyTensorGuard(signal: any, targetSide: string, intent: 'add' | 'reduce' | 'reverse') {
  const property = signal.property_vector || {};
  const dims = property.dimensions || {};
  const weights = commodityEnergyPropertyWeights(signal.symbol);
  const tensorDims: Record<string, number> = {
    Q: Number(dims.Q || 0),
    DeltaSigma: Number(dims.DeltaSigma || 0),
    C: Number(dims.C || 0),
    Pi: Number(dims.Pi || 0),
    Sigma: targetSide === property.direction ? Number(dims.Sigma || 0) : Number(dims.Sigma || 0) * 0.72,
    Eta: 1 - Number(dims.Eta || 0),
    BSigma: 1 - Number(dims.BSigma || 0),
    R: 1 - Number(dims.BSigma || 0) * 0.75,
    Tau: Number(dims.Tau || 0),
    Omega: Number(dims.Omega || 0),
  };
  const weightTotal = COMMODITY_ENERGY_PROPERTY_DIMS.reduce((sum, dim) => sum + Number(weights[dim] || 0), 0) || 1;
  const linearScore = COMMODITY_ENERGY_PROPERTY_DIMS.reduce(
    (sum, dim) => sum + Number(weights[dim] || 0) / weightTotal * hfcdClamp(tensorDims[dim]),
    0,
  );
  const gateFactor = Math.max(0.05, hfcdClamp(tensorDims.C) * hfcdClamp(tensorDims.Pi));
  const tensorScore = hfcdClamp(linearScore * (gateFactor ** COMMODITY_ENERGY_TENSOR_PARAMS.tensor_power));
  const threshold = intent === 'reverse'
    ? COMMODITY_ENERGY_TENSOR_PARAMS.reverse_min
    : intent === 'reduce'
      ? COMMODITY_ENERGY_TENSOR_PARAMS.reduce_hold_min
      : COMMODITY_ENERGY_TENSOR_PARAMS.add_min;
  const directionAligned = property.direction === targetSide || intent === 'reduce';
  const confirms = intent === 'reduce'
    ? tensorScore < threshold
    : directionAligned && tensorScore >= threshold;
  const reason = intent === 'reduce'
    ? confirms
      ? `张量分${tensorScore.toFixed(3)}低于持仓阈值${threshold.toFixed(2)}，影子确认减仓`
      : `张量分${tensorScore.toFixed(3)}仍高于持仓阈值${threshold.toFixed(2)}，影子拦截减仓`
    : confirms
      ? `张量分${tensorScore.toFixed(3)}通过${intent === 'reverse' ? '反手' : '加仓'}阈值${threshold.toFixed(2)}`
      : `张量分${tensorScore.toFixed(3)}未通过${intent === 'reverse' ? '反手' : '加仓'}阈值${threshold.toFixed(2)}`;
  return {
    version: COMMODITY_ENERGY_TENSOR_GUARD_VERSION,
    mode: 'shadow_only',
    intent,
    target_side: targetSide,
    property_direction: property.direction || 'flat',
    tensor_score: Number(tensorScore.toFixed(4)),
    threshold,
    confirms,
    reason,
    dims: Object.fromEntries(COMMODITY_ENERGY_PROPERTY_DIMS.map((dim) => [dim, Number(hfcdClamp(tensorDims[dim]).toFixed(4))])),
  };
}

function commodityEnergyTensorShadowForSignal(signal: any) {
  const targetSide = signal.side === 'short' || signal.side === 'long' ? signal.side : 'flat';
  if (targetSide === 'flat') {
    return {
      version: COMMODITY_ENERGY_TENSOR_GUARD_VERSION,
      mode: 'shadow_only',
      main_entry_policy: 'bypass_tensor_for_main_entry',
      note: '主血统未触发方向信号，张量层不生成新开仓。',
    };
  }
  return {
    version: COMMODITY_ENERGY_TENSOR_GUARD_VERSION,
    mode: 'shadow_only',
    main_entry_policy: 'bypass_tensor_for_main_entry',
    add: commodityEnergyTensorGuard(signal, targetSide, 'add'),
    reduce: commodityEnergyTensorGuard(signal, targetSide, 'reduce'),
    reverse: commodityEnergyTensorGuard(signal, targetSide, 'reverse'),
    reduce_current_long: commodityEnergyTensorGuard(signal, 'long', 'reduce'),
    reduce_current_short: commodityEnergyTensorGuard(signal, 'short', 'reduce'),
  };
}

function buildCommodityEnergySignal(series: any) {
  const rows = series.rows || [];
  const closes = rows.map((row: any) => Number(row.close)).filter((value: number) => Number.isFinite(value) && value > 0);
  const volumes = rows.map((row: any) => Number(row.volume || 0)).filter((value: number) => Number.isFinite(value));
  const latest = rows[rows.length - 1] || { ts: energyIso(), close: 0 };
  const price = Number(latest.close || closes[closes.length - 1] || 0);
  const barsPerHorizon = Math.max(1, Math.round(Number(series.lookback_minutes || 120) / 5));
  const dayBars = Math.min(288, Math.max(barsPerHorizon * 2, 48));
  const prev = closes[closes.length - 2] || price;
  const horizonBase = closes[Math.max(0, closes.length - 1 - barsPerHorizon)] || prev;
  const dayBase = closes[Math.max(0, closes.length - 1 - dayBars)] || horizonBase;
  const returns = closes.slice(-Math.max(dayBars, 72)).map((value: number, index: number, arr: number[]) =>
    index === 0 ? 0 : value / arr[index - 1] - 1,
  ).slice(1);
  const vol = Math.max(commodityEnergyStd(returns), 0.00035);
  const r1 = price / prev - 1;
  const rHorizon = price / horizonBase - 1;
  const rDay = price / dayBase - 1;
  const recentVol = volumes.slice(-barsPerHorizon).reduce((sum: number, value: number) => sum + value, 0);
  const baseVol = volumes.slice(-dayBars).reduce((sum: number, value: number) => sum + value, 0) / Math.max(dayBars / barsPerHorizon, 1);
  const volumeShock = Math.max(-1, Math.min(1, (recentVol / Math.max(baseVol, 1) - 1) / 2));
  const signedScore = Math.max(-3, Math.min(3, (0.68 * rHorizon + 0.22 * rDay + 0.10 * volumeShock * vol) / vol));
  const score = Math.abs(signedScore);
  const rawAction = score >= Number(series.min_score || 0.66)
    ? signedScore > 0 ? 'BUY_LONG' : 'SELL_SHORT'
    : 'NO_TRADE';
  const rawSide = rawAction === 'BUY_LONG' ? 'long' : rawAction === 'SELL_SHORT' ? 'short' : 'flat';
  const expectedReturn = hfcdClamp(signedScore * vol * 0.85, -0.08, 0.08);
  const expectedFuturePrice = price * (1 + expectedReturn);
  const forecastEdge = rawAction === 'NO_TRADE'
    ? forecastEdgeGate({ side: 'flat', current_value: price, expected_future_value: price })
    : forecastEdgeGate({
      asset: 'commodity_energy',
      mode: 'price',
      current_value: price,
      expected_future_value: expectedFuturePrice,
      side: rawSide,
      fee_rate: COMMODITY_ENERGY_FEE_RATE,
      spread_bps: series.symbol === 'HO=F' ? 3.5 : 2.5,
      slippage_bps: series.symbol === 'HO=F' ? 4.0 : 3.0,
      realized_vol: vol,
      vol_multiplier: series.symbol === 'HO=F' ? 0.28 : 0.24,
      min_edge_pct: series.symbol === 'HO=F' ? 0.0014 : 0.0016,
      max_multiplier: Math.max(1, Number(series.max_units || 1)),
    });
  let action = FORECAST_EDGE_GATE_PROMOTED && rawAction !== 'NO_TRADE' && !forecastEdge.ok ? 'NO_TRADE' : rawAction;
  const routeTradeAllowed = series.forward_enabled !== false && series.online_trade_allowed !== false;
  if (!routeTradeAllowed) action = 'NO_TRADE';
  const capturedAt = latest.ts || energyIso();
  const propertyVector = commodityEnergyComputeProperties(series, closes, volumes);
  const provisionalSignal = {
    symbol: series.symbol,
    side: action === 'BUY_LONG' ? 'long' : action === 'SELL_SHORT' ? 'short' : 'flat',
    property_vector: propertyVector,
  };
  const tensorShadow = commodityEnergyTensorShadowForSignal(provisionalSignal);
  return {
    signal_id: `${series.symbol}-${series.cadence}-${Math.floor(new Date(capturedAt).getTime() / 300000)}-${rawAction}`,
    captured_at: capturedAt,
    symbol: series.symbol,
    display_symbol: series.display_symbol || series.symbol,
    name: series.name,
    cadence: series.cadence,
    lineage_id: series.lineage_id,
    source_version: series.source_version,
    source_rule: series.source_rule,
    lineage_role: series.lineage_role,
    route_role: series.route_role || series.lineage_role,
    candidate_rule: series.candidate_rule || '',
    forward_enabled: routeTradeAllowed,
    online_trade_allowed: routeTradeAllowed,
    promotion_status: series.promotion_status || '',
    scheduler_role: '1m/5m_execution_check_only',
    price: Number(price.toFixed(series.symbol === 'HO=F' ? 4 : 2)),
    raw_action: rawAction,
    action,
    side: action === 'BUY_LONG' ? 'long' : action === 'SELL_SHORT' ? 'short' : 'flat',
    score: Number(score.toFixed(4)),
    signed_score: Number(signedScore.toFixed(4)),
    min_score: Number(series.min_score || 0.66),
    confidence: Number(Math.max(0.4, Math.min(0.98, 0.46 + score * 0.16)).toFixed(4)),
    r1: Number(r1.toFixed(6)),
    r_horizon: Number(rHorizon.toFixed(6)),
    r_day: Number(rDay.toFixed(6)),
    expected_return: Number(expectedReturn.toFixed(6)),
    expected_future_price: Number(expectedFuturePrice.toFixed(series.symbol === 'HO=F' ? 4 : 2)),
    forecast_edge_gate: forecastEdge,
    forecast_edge_mode: FORECAST_EDGE_GATE_PROMOTED ? 'promoted_gate' : 'shadow_audit_only',
    forecast_edge_pct: forecastEdge.forecast_edge_pct,
    position_multiplier: forecastEdge.position_multiplier,
    realized_vol_5m: Number(vol.toFixed(6)),
    volume_shock: Number(volumeShock.toFixed(4)),
    property_vector: propertyVector,
    property_filter_version: 'V7.8_lineage_minimal_state_repair_filter',
    tensor_shadow: tensorShadow,
    max_units: Number(series.max_units || 1),
    blind_hit_rate: Number(series.blind_hit_rate || 0),
    blind_profit_factor: Number(series.blind_profit_factor || 0),
    blind_pnl_usd: Number(series.blind_pnl_usd || 0),
    actions_per_day: Number(series.actions_per_day || 0),
    blind_actions: Number(series.blind_actions || 0),
    active_signal_bars: Number(series.active_signal_bars || 0),
    duplicate_open_count: Number(series.duplicate_open_count || 0),
    wrong_reverse_count: Number(series.wrong_reverse_count || 0),
    holding_minutes: Number(series.lookback_minutes || 120),
    source: series.source,
    is_real_market_data: Boolean(series.is_real_market_data),
    status: routeTradeAllowed ? (action === 'NO_TRADE' ? 'rejected' : 'accepted') : 'observation_only',
    reject_reason: action === 'NO_TRADE'
      ? !routeTradeAllowed
        ? '观察路线：未通过 V7.8 候选门槛，不参与 V7.8 主账本交易'
        : rawAction === 'NO_TRADE' ? 'lineage_score_underthreshold' : FORECAST_EDGE_GATE_PROMOTED ? forecastEdge.reason : 'lineage_score_underthreshold'
      : '',
  };
}

async function buildCommodityEnergySignals() {
  const seriesList = await Promise.all(COMMODITY_ENERGY_ROUTES.map(fetchCommodityEnergySeries));
  const signals = seriesList.map(buildCommodityEnergySignal);
  return {
    generated_at: energyIso(),
    version: COMMODITY_ENERGY_VERSION,
    source_status: signals.every((signal) => signal.is_real_market_data) ? 'live_public_yahoo_5m' : 'mixed_or_fallback',
    signals,
  };
}

function defaultCommodityEnergyAccount(userId: string, body: any = {}) {
  const capital = Number(body.capital_usd || body.capital || 100_000);
  return {
    version: COMMODITY_ENERGY_VERSION,
    user_id: userId,
    mode: 'stopped',
    started_at: '',
    stopped_at: '',
    last_tick_at: '',
    initial_cash_usd: capital,
    cash_usd: capital,
    settled_equity_usd: capital,
    realized_pnl_usd: 0,
    equity_usd: capital,
    peak_equity_usd: capital,
    max_drawdown_usd: 0,
    open_positions: [] as any[],
    closed_trades: [] as any[],
    tensor_shadow_events: [] as any[],
    execution_repair_events: [] as any[],
    pending_reverse_orders: [] as any[],
    state_controller_version: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
    seen_signal_ids: [] as string[],
    seen_audit_signal_ids: [] as string[],
    config: {
      fixed_trade_usd: Number(body.fixed_trade_usd || 1000),
      max_open_positions: Number(body.max_open_positions || 4),
      max_symbol_positions: Number(body.max_symbol_positions || 1),
      stop_loss_pct: Number(body.stop_loss_pct || 0.018),
      take_profit_pct: Number(body.take_profit_pct || 0.036),
      min_signal_score: Number(body.min_signal_score || 0.66),
      fee_rate: COMMODITY_ENERGY_FEE_RATE,
      allow_short: body.allow_short !== false,
      sizing_mode: String(body.sizing_mode || 'score_scaled'),
      position_controller: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
      position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
      forecast_edge_gate: FORECAST_EDGE_GATE_PROMOTED ? 'promoted' : 'shadow',
    },
  };
}

async function loadCommodityEnergyAccount(env: Env, userId: string) {
  const db = await ensureEnergyTradingDb(env);
  if (!db) return defaultCommodityEnergyAccount(userId);
  const row = await db.prepare('SELECT state_json FROM energy_accounts WHERE user_id = ?').bind(userId).first();
  if (!row?.state_json) return defaultCommodityEnergyAccount(userId);
  try {
    const parsed = JSON.parse(String(row.state_json));
    const defaults = defaultCommodityEnergyAccount(userId);
    const normalized = {
      ...defaults,
      ...parsed,
      config: {
        ...defaults.config,
        ...(parsed?.config || {}),
        position_controller: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
        position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
        forecast_edge_gate: FORECAST_EDGE_GATE_PROMOTED ? 'promoted' : 'shadow',
      },
      state_controller_version: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
    };
    if (parsed?.version !== COMMODITY_ENERGY_VERSION) {
      return { ...normalized, version: COMMODITY_ENERGY_VERSION };
    }
    return normalized;
  } catch {
    return defaultCommodityEnergyAccount(userId);
  }
}

async function saveCommodityEnergyAccount(env: Env, state: any) {
  state.version = COMMODITY_ENERGY_VERSION;
  return saveEnergyAccount(env, state);
}

function commodityEnergyPositionPnl(pos: any, currentPrice: number) {
  const side = String(pos.side || '').toLowerCase();
  const qty = Number(pos.quantity || 0);
  const entry = Number(pos.entry_price || 0);
  if (!qty || !entry || !currentPrice) return 0;
  const gross = side === 'short' ? (entry - currentPrice) * qty : (currentPrice - entry) * qty;
  return gross - Number(pos.open_fee_usd || 0);
}

function commodityEnergySettledEquity(state: any) {
  return Number(state.initial_cash_usd || 0) + Number(state.realized_pnl_usd || 0);
}

function commodityEnergyEquity(state: any, signals: any[] = []) {
  const priceBySymbol = new Map(signals.map((signal) => [signal.symbol, Number(signal.price || 0)]));
  let unrealized = 0;
  for (const pos of state.open_positions || []) {
    const current = priceBySymbol.get(pos.symbol) || Number(pos.mark_price || pos.entry_price || 0);
    const pnl = commodityEnergyPositionPnl(pos, current);
    pos.mark_price = current;
    pos.unrealized_pnl_usd = Number(pnl.toFixed(2));
    unrealized += pnl;
  }
  const settledEquity = commodityEnergySettledEquity(state);
  const equity = settledEquity + unrealized;
  state.settled_equity_usd = settledEquity;
  state.cash_usd = settledEquity;
  state.equity_usd = equity;
  state.peak_equity_usd = Math.max(Number(state.peak_equity_usd || equity), equity);
  state.max_drawdown_usd = Math.min(Number(state.max_drawdown_usd || 0), equity - Number(state.peak_equity_usd || equity));
  return unrealized;
}

function commodityEnergyCanOpen(signal: any, state: any) {
  const cfg = state.config || {};
  if (state.mode !== 'running') return 'AI未运行';
  if (signal.forward_enabled === false || signal.online_trade_allowed === false || signal.status === 'observation_only') return '观察路线不参与 V7.8 主账本交易';
  if (signal.action === 'NO_TRADE') return '主血统分数不足';
  if (FORECAST_EDGE_GATE_PROMOTED && (!signal.forecast_edge_gate || signal.forecast_edge_gate.ok !== true)) {
    return signal.forecast_edge_gate?.reason || '缺少预测边际，不能证明未来空间覆盖成本和噪声';
  }
  if (signal.side === 'short' && cfg.allow_short === false) return '做空已关闭';
  if (Number(signal.score || 0) < Math.max(Number(cfg.min_signal_score || 0.66), Number(signal.min_score || 0.66))) return '稳定分不足';
  if ((state.open_positions || []).length >= Number(cfg.max_open_positions || 4)) return '达到最大持仓数';
  const sameSymbol = (state.open_positions || []).filter((pos: any) => pos.symbol === signal.symbol).length;
  if (sameSymbol >= Number(cfg.max_symbol_positions || 1)) return '该商品持仓已满';
  if ((state.seen_signal_ids || []).includes(String(signal.signal_id))) return '本轮信号已处理';
  return '';
}

function commodityEnergyOrderAmount(signal: any, state: any) {
  const cfg = state.config || {};
  const base = Number(cfg.fixed_trade_usd || 1000);
  if (cfg.sizing_mode !== 'score_scaled') return base;
  const edgeMultiplier = FORECAST_EDGE_GATE_PROMOTED ? Number(signal.forecast_edge_gate?.position_multiplier || signal.position_multiplier || 1) : 1;
  const scaled = base * Math.max(
    0.35,
    Math.min(
      Number(signal.max_units || 1),
      (Number(signal.score || 0) / Math.max(Number(signal.min_score || 0.66), 0.1)) * Math.max(edgeMultiplier, 0.25),
    ),
  );
  const cashCap = Number(state.cash_usd || 0) * 0.2;
  return Number(Math.max(0, Math.min(scaled, cashCap)).toFixed(2));
}

async function openCommodityEnergyPosition(env: Env, state: any, signal: any) {
  const amount = commodityEnergyOrderAmount(signal, state);
  const price = Number(signal.price || 0);
  const fee = amount * Number(state.config?.fee_rate || COMMODITY_ENERGY_FEE_RATE);
  const quantity = amount / Math.max(price, 1e-9);
  const now = new Date();
  const pos = {
    position_id: `${signal.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    signal_id: signal.signal_id,
    symbol: signal.symbol,
    name: signal.name,
    side: signal.side,
    action: signal.action,
    cadence: signal.cadence,
    lineage_id: signal.lineage_id,
    source_version: signal.source_version,
    source_rule: signal.source_rule,
    entry_time: energyIso(now),
    target_exit_at: energyIso(new Date(now.getTime() + Number(signal.holding_minutes || 120) * 60000)),
    entry_price: price,
    mark_price: price,
    quantity,
    trade_value_usd: amount,
    open_fee_usd: fee,
    unrealized_pnl_usd: -fee,
    score: signal.score,
    confidence: signal.confidence,
    expected_return: signal.expected_return,
    expected_future_price: signal.expected_future_price,
    forecast_edge_gate: signal.forecast_edge_gate,
    position_multiplier: signal.position_multiplier,
    stop_loss_pct: Number(state.config?.stop_loss_pct || 0.018),
    take_profit_pct: Number(state.config?.take_profit_pct || 0.036),
  };
  state.open_positions = [...(state.open_positions || []), pos];
  state.seen_signal_ids = [...(state.seen_signal_ids || []), String(signal.signal_id)].slice(-500);
  await insertEnergyTrade(env, state.user_id, {
    ts: pos.entry_time,
    event: 'OPEN',
    symbol: pos.symbol,
    node: pos.name,
    horizon: pos.cadence,
    signal_source: `${pos.source_version} ${pos.lineage_id}`,
    action: pos.action,
    side: pos.side,
    entry_price: pos.entry_price,
    price_spread: pos.entry_price,
    quantity: pos.quantity,
    entry_trade_value_usd: amount,
    net_pnl_usd: -fee,
    score: pos.score,
    confidence: pos.confidence,
    reason: `ExactLineage 前向开仓；${signal.forecast_edge_gate?.reason || '预测空间门已通过'}`,
    position_id: pos.position_id,
  });
}

async function closeCommodityEnergyPosition(env: Env, state: any, pos: any, exitPrice: number, reason: string) {
  const amount = Number(pos.trade_value_usd || 0);
  const closeFee = amount * Number(state.config?.fee_rate || COMMODITY_ENERGY_FEE_RATE);
  const pnlBeforeCloseFee = commodityEnergyPositionPnl(pos, exitPrice);
  const netPnl = pnlBeforeCloseFee - closeFee;
  state.cash_usd = Number(state.cash_usd || 0) + netPnl;
  state.realized_pnl_usd = Number(state.realized_pnl_usd || 0) + netPnl;
  const closed = {
    ...pos,
    exit_time: energyIso(),
    exit_price: exitPrice,
    close_fee_usd: closeFee,
    net_pnl_usd: Number(netPnl.toFixed(2)),
    reason,
  };
  state.closed_trades = [...(state.closed_trades || []), closed].slice(-500);
  await insertEnergyTrade(env, state.user_id, {
    ts: closed.exit_time,
    event: 'CLOSE',
    symbol: pos.symbol,
    node: pos.name,
    horizon: pos.cadence,
    signal_source: `${pos.source_version} ${pos.lineage_id}`,
    action: pos.action,
    side: pos.side,
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    price_spread: exitPrice,
    quantity: pos.quantity,
    entry_trade_value_usd: pos.trade_value_usd,
    exit_trade_value_usd: pos.trade_value_usd + netPnl,
    net_pnl_usd: Number(netPnl.toFixed(2)),
    pnl_pct_of_trade: Number((netPnl / Math.max(Number(pos.trade_value_usd || 1), 1)).toFixed(4)),
    score: pos.score,
    reason,
    position_id: pos.position_id,
  });
}

function markCommodityEnergySignalSeen(state: any, signalId: string) {
  if (!signalId) return;
  const seen = new Set((state.seen_signal_ids || []).map((id: any) => String(id)));
  seen.add(String(signalId));
  state.seen_signal_ids = Array.from(seen).slice(-500);
}

function recordCommodityEnergyTensorShadow(state: any, signal: any, intent: string, guard: any, main_action: string, note = '') {
  const event = {
    ts: energyIso(),
    version: COMMODITY_ENERGY_TENSOR_GUARD_VERSION,
    mode: 'shadow_only',
    signal_id: signal.signal_id,
    symbol: signal.symbol,
    cadence: signal.cadence,
    side: signal.side,
    intent,
    tensor_score: guard?.tensor_score ?? null,
    threshold: guard?.threshold ?? null,
    confirms: Boolean(guard?.confirms),
    main_action,
    reason: guard?.reason || note || '张量影子层仅记录，不改变主账本动作',
  };
  state.tensor_shadow_events = [event, ...((state.tensor_shadow_events || []) as any[])].slice(0, 120);
  return event;
}

function recordCommodityEnergyExecutionRepair(state: any, event: any) {
  const next = {
    ts: energyIso(),
    version: 'V7.8_minimal_state_repair',
    ...event,
  };
  state.execution_repair_events = [next, ...((state.execution_repair_events || []) as any[])].slice(0, 120);
  return next;
}

function queueCommodityEnergyPendingReverse(state: any, signal: any, closedPositionIds: string[] = []) {
  const now = new Date();
  const pending = {
    created_at: energyIso(now),
    expires_at: energyIso(new Date(now.getTime() + 45 * 60000)),
    from_signal_id: String(signal.signal_id || ''),
    symbol: signal.symbol,
    side: signal.side,
    action: signal.action,
    cadence: signal.cadence,
    lineage_id: signal.lineage_id,
    price: signal.price,
    score: signal.score,
    closed_position_ids: closedPositionIds,
    status: 'queued_next_tick_confirmation',
  };
  state.pending_reverse_orders = [
    pending,
    ...((state.pending_reverse_orders || []) as any[]).filter((order) => order.symbol !== signal.symbol),
  ].slice(0, 20);
  return recordCommodityEnergyExecutionRepair(state, {
    event: 'PENDING_REVERSE_QUEUED',
    symbol: signal.symbol,
    side: signal.side,
    signal_id: signal.signal_id,
    reason: '反向信号已先平旧仓；V7.8 禁止同 tick 重开，等待下一 tick 重新确认。',
  });
}

async function processCommodityEnergyPendingReverse(
  env: Env,
  state: any,
  signals: any[],
  closedSymbolsThisTick: Set<string>,
) {
  const pendingOrders = (state.pending_reverse_orders || []) as any[];
  if (!pendingOrders.length || state.mode !== 'running') {
    return 0;
  }
  let opened = 0;
  const kept: any[] = [];
  const nowMs = Date.now();
  for (const pending of pendingOrders) {
    const symbol = String(pending.symbol || '');
    const currentSignal = signals.find((signal: any) => signal.symbol === symbol);
    if (!currentSignal) {
      kept.push(pending);
      continue;
    }
    if (new Date(pending.expires_at || 0).getTime() <= nowMs) {
      recordCommodityEnergyExecutionRepair(state, {
        event: 'PENDING_REVERSE_EXPIRED',
        symbol,
        side: pending.side,
        signal_id: pending.from_signal_id,
        reason: '反手等待超时，放弃旧反手意图。',
      });
      continue;
    }
    if (closedSymbolsThisTick.has(symbol)) {
      kept.push(pending);
      continue;
    }
    if (String(currentSignal.signal_id || '') === String(pending.from_signal_id || '')) {
      kept.push(pending);
      continue;
    }
    if (currentSignal.action === 'NO_TRADE' || currentSignal.side !== pending.side) {
      recordCommodityEnergyExecutionRepair(state, {
        event: 'PENDING_REVERSE_CANCELLED',
        symbol,
        side: pending.side,
        signal_id: currentSignal.signal_id,
        reason: '下一 tick 未继续确认同向反手信号，取消反手。',
      });
      continue;
    }
    const propertyReverseGate = commodityEnergyPropertyConfirms(currentSignal, currentSignal.side, true);
    const reason = commodityEnergyCanOpen(currentSignal, state);
    if (reason || !propertyReverseGate.ok) {
      const blockReason = reason || `V7.8稳定窗阻止反手开仓：${propertyReverseGate.reason}`;
      await insertCommodityEnergySkip(env, state, currentSignal, `V7.8反手二次确认失败：${blockReason}`);
      recordCommodityEnergyExecutionRepair(state, {
        event: 'PENDING_REVERSE_BLOCKED',
        symbol,
        side: pending.side,
        signal_id: currentSignal.signal_id,
        reason: blockReason,
      });
      continue;
    }
    await openCommodityEnergyPosition(env, state, currentSignal);
    opened += 1;
    recordCommodityEnergyExecutionRepair(state, {
      event: 'PENDING_REVERSE_EXECUTED',
      symbol,
      side: pending.side,
      signal_id: currentSignal.signal_id,
      reason: '下一 tick 仍确认反手，执行新方向开仓。',
    });
  }
  state.pending_reverse_orders = kept;
  return opened;
}

async function insertCommodityEnergySkip(env: Env, state: any, signal: any, reason: string) {
  await insertEnergyTrade(env, state.user_id, {
    ts: energyIso(),
    event: 'SKIP',
    symbol: signal.symbol,
    node: signal.name,
    horizon: signal.cadence,
    signal_source: `${signal.source_version} ${signal.lineage_id}`,
    action: signal.action,
    side: signal.side,
    price_spread: signal.price,
    entry_trade_value_usd: 0,
    exit_trade_value_usd: 0,
    net_pnl_usd: 0,
    score: signal.score,
    confidence: signal.confidence,
    reason,
    signal_id: signal.signal_id,
  });
  markCommodityEnergySignalSeen(state, String(signal.signal_id || ''));
}

async function commodityEnergyTick(env: Env, state: any, forceSettle = false) {
  const feed = await buildCommodityEnergySignals();
  const signals = feed.signals || [];
  const priceBySymbol = new Map(signals.map((signal: any) => [signal.symbol, Number(signal.price || 0)]));
  const remaining: any[] = [];
  let settled = 0;
  let opened = 0;
  const now = new Date();
  const closedSymbolsThisTick = new Set<string>();

  for (const pos of state.open_positions || []) {
    const price = priceBySymbol.get(pos.symbol) || Number(pos.mark_price || pos.entry_price || 0);
    const pnl = commodityEnergyPositionPnl(pos, price);
    const pctPnl = pnl / Math.max(Number(pos.trade_value_usd || 1), 1);
    const route = commodityEnergyRoute(pos.symbol);
    const retiredRoute = route.forward_enabled === false || route.online_trade_allowed === false;
    if (retiredRoute) {
      await closeCommodityEnergyPosition(env, state, { ...pos, unrealized_pnl_usd: pnl }, price, 'V7.8 下线旧路线，强制结算观察标的');
      closedSymbolsThisTick.add(pos.symbol);
      settled += 1;
      continue;
    }
    const due = forceSettle || new Date(pos.target_exit_at).getTime() <= now.getTime();
    const stopLoss = Number(pos.stop_loss_pct || state.config?.stop_loss_pct || 0.018);
    const takeProfit = Number(pos.take_profit_pct || state.config?.take_profit_pct || 0.036);
    if (due || pctPnl <= -stopLoss || pctPnl >= takeProfit) {
      await closeCommodityEnergyPosition(env, state, { ...pos, unrealized_pnl_usd: pnl }, price, due ? '到期结算' : (pnl > 0 ? '止盈结算' : '止损结算'));
      closedSymbolsThisTick.add(pos.symbol);
      settled += 1;
    } else {
      const currentSignal = signals.find((signal: any) => signal.symbol === pos.symbol);
      if (currentSignal) {
        const tensorReduce = currentSignal.tensor_shadow?.reduce || commodityEnergyTensorGuard(currentSignal, pos.side, 'reduce');
        if (tensorReduce.confirms) {
          recordCommodityEnergyTensorShadow(
            state,
            currentSignal,
            'reduce',
            tensorReduce,
            'SHADOW_REDUCE_ONLY',
            '当前持仓未减仓，仅记录 V7.8 最小状态修复影子信号。',
          );
        }
      }
      remaining.push({ ...pos, mark_price: price, unrealized_pnl_usd: Number(pnl.toFixed(2)) });
    }
  }
  state.open_positions = remaining;
  state.settled_equity_usd = commodityEnergySettledEquity(state);
  state.cash_usd = state.settled_equity_usd;

  if (!forceSettle && state.mode === 'running') {
    opened += await processCommodityEnergyPendingReverse(env, state, signals, closedSymbolsThisTick);
    const candidates = [...signals].sort((a: any, b: any) => Number(b.score || 0) - Number(a.score || 0));
    for (const signal of candidates) {
      if ((state.seen_signal_ids || []).includes(String(signal.signal_id))) continue;
      if (signal.forward_enabled === false || signal.online_trade_allowed === false || signal.status === 'observation_only') {
        await insertCommodityEnergySkip(env, state, signal, '观察路线：不参与 V7.8 前向纸面交易');
        continue;
      }
      if (signal.action === 'NO_TRADE') {
        await insertCommodityEnergySkip(env, state, signal, '主血统分数不足');
        continue;
      }
      if (signal.side === 'short' && state.config?.allow_short === false) {
        await insertCommodityEnergySkip(env, state, signal, '做空已关闭');
        continue;
      }
      if (Number(signal.score || 0) < Math.max(Number(state.config?.min_signal_score || 0.66), Number(signal.min_score || 0.66))) {
        await insertCommodityEnergySkip(env, state, signal, '稳定分不足');
        continue;
      }
      const symbolPositions = (state.open_positions || []).filter((pos: any) => pos.symbol === signal.symbol);
      const sameSidePositions = symbolPositions.filter((pos: any) => pos.side === signal.side);
      const oppositePositions = symbolPositions.filter((pos: any) => pos.side !== signal.side);
      const propertyOpenGate = commodityEnergyPropertyConfirms(signal, signal.side, false);
      const propertyReverseGate = commodityEnergyPropertyConfirms(signal, signal.side, true);

      if (closedSymbolsThisTick.has(signal.symbol)) {
        await insertCommodityEnergySkip(env, state, signal, 'V7.8同 tick 平仓后不重开，等待下一 tick 确认');
        continue;
      }

      if (!symbolPositions.length) {
        const reason = commodityEnergyCanOpen(signal, state);
        if (reason) {
          await insertCommodityEnergySkip(env, state, signal, reason);
        } else if (!propertyOpenGate.ok) {
        await insertCommodityEnergySkip(env, state, signal, `V7.8稳定窗阻止开仓：${propertyOpenGate.reason}`);
        } else {
          recordCommodityEnergyTensorShadow(
            state,
            signal,
            'main_entry_bypass',
            signal.tensor_shadow?.add,
            'OPEN_BY_LINEAGE',
            '主开仓只按 V7.5 HO/CL 强血统执行；V7.8 执行层负责状态修复。',
          );
          await openCommodityEnergyPosition(env, state, signal);
          opened += 1;
        }
        continue;
      }

      if (oppositePositions.length) {
        const tensorReverse = signal.tensor_shadow?.reverse || commodityEnergyTensorGuard(signal, signal.side, 'reverse');
        recordCommodityEnergyTensorShadow(
          state,
          signal,
          'reverse',
          tensorReverse,
          tensorReverse.confirms ? 'MAIN_REVERSE_SHADOW_CONFIRMED' : 'MAIN_REVERSE_SHADOW_BLOCKED',
        );
        if (!propertyReverseGate.ok) {
          await insertCommodityEnergySkip(env, state, signal, `V7.8稳定窗阻止反手：${propertyReverseGate.reason}；张量影子：${tensorReverse.reason}`);
          continue;
        }
        const exitPrice = Number(signal.price || priceBySymbol.get(signal.symbol) || 0);
        const closedPositionIds: string[] = [];
        for (const pos of oppositePositions) {
          await closeCommodityEnergyPosition(env, state, pos, exitPrice, `V7.8最小状态修复：反向信号先平旧仓，下一tick再确认反手；张量影子：${tensorReverse.reason}`);
          closedPositionIds.push(String(pos.position_id || ''));
          settled += 1;
        }
        state.open_positions = (state.open_positions || []).filter((pos: any) => pos.symbol !== signal.symbol || pos.side === signal.side);
        closedSymbolsThisTick.add(signal.symbol);
        queueCommodityEnergyPendingReverse(state, signal, closedPositionIds);
        await insertCommodityEnergySkip(env, state, signal, 'V7.8反手已平旧仓，禁止同tick重开，等待下一tick重新确认');
        continue;
      }

      const maxSymbolPositions = Math.min(
        Number(state.config?.max_symbol_positions || 1),
        Number(signal.max_units || 1),
      );
      if (sameSidePositions.length >= maxSymbolPositions) {
        recordCommodityEnergyTensorShadow(
          state,
          signal,
          'add',
          signal.tensor_shadow?.add || commodityEnergyTensorGuard(signal, signal.side, 'add'),
          'MAIN_BLOCKED_MAX_SYMBOL_POSITION',
          '单品最大持仓已满，张量只记录不放开重复开仓。',
        );
        await insertCommodityEnergySkip(env, state, signal, '同向持仓已存在，V7.8禁止重复开仓');
        continue;
      }
      const tensorAdd = signal.tensor_shadow?.add || commodityEnergyTensorGuard(signal, signal.side, 'add');
      recordCommodityEnergyTensorShadow(
        state,
        signal,
        'add',
        tensorAdd,
        tensorAdd.confirms ? 'MAIN_ADD_SHADOW_CONFIRMED' : 'MAIN_ADD_SHADOW_BLOCKED',
      );
      if (!propertyOpenGate.ok) {
        await insertCommodityEnergySkip(env, state, signal, `V7.8稳定窗阻止加仓：${propertyOpenGate.reason}；张量影子：${tensorAdd.reason}`);
        continue;
      }
      await openCommodityEnergyPosition(env, state, signal);
      opened += 1;
    }
  }
  const unrealized = commodityEnergyEquity(state, signals);
  return { feed, opened, settled, unrealized_pnl_usd: unrealized };
}

async function runCommodityEnergyScheduledTick(env: Env) {
  const db = await ensureEnergyTradingDb(env);
  const startedAt = energyIso();
  if (!db) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: energyIso(),
      checked_accounts: 0,
      ticked_accounts: 0,
      error: 'ENERGY_TRADING_DB is not bound',
    };
  }

  const result = await db
    .prepare(
      "SELECT user_id, state_json FROM energy_accounts WHERE user_id LIKE 'commodity_%' ORDER BY updated_at DESC LIMIT 100",
    )
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const outcomes: any[] = [];
  let ticked = 0;

  for (const row of rows) {
    const userId = String(row.user_id || '');
    try {
      const state = JSON.parse(String(row.state_json || '{}'));
      if (state?.mode !== 'running') {
        outcomes.push({ user_id_suffix: userId.slice(-10), mode: state?.mode || 'unknown', action: 'skip_not_running' });
        continue;
      }
      const normalized = {
        ...defaultCommodityEnergyAccount(userId),
        ...state,
        user_id: userId,
        version: COMMODITY_ENERGY_VERSION,
      };
      const tickResult = await commodityEnergyTick(env, normalized, false);
      normalized.last_tick_at = energyIso();
      normalized.scheduler = {
        ...(normalized.scheduler || {}),
        enabled: true,
        cadence: '*/5 * * * *',
        last_cron_tick_at: normalized.last_tick_at,
        last_cron_opened: tickResult.opened,
        last_cron_settled: tickResult.settled,
        last_cron_market_latest_at: tickResult.feed?.signals?.[0]?.captured_at || '',
      };
      await saveCommodityEnergyAccount(env, normalized);
      ticked += 1;
      outcomes.push({
        user_id_suffix: userId.slice(-10),
        mode: normalized.mode,
        action: 'ticked',
        opened: tickResult.opened,
        settled: tickResult.settled,
        market_latest_at: tickResult.feed?.signals?.[0]?.captured_at || '',
      });
    } catch (error) {
      outcomes.push({
        user_id_suffix: userId.slice(-10),
        action: 'error',
        error: error instanceof Error ? error.message : 'scheduled tick failed',
      });
    }
  }

  return {
    ok: true,
    started_at: startedAt,
    finished_at: energyIso(),
    checked_accounts: rows.length,
    ticked_accounts: ticked,
    outcomes,
  };
}

async function commodityEnergyDashboard(request: Request, env: Env, url: URL) {
  const userId = commodityEnergyUserId(request, url);
  const state = await loadCommodityEnergyAccount(env, userId);
  const feed = await buildCommodityEnergySignals();
  const unrealizedPnl = commodityEnergyEquity(state, feed.signals || []);
  const trades = await recentEnergyTrades(env, userId, 160);
  const updatedAt = energyIso();
  return json({
    ok: true,
    online_backend: Boolean(env.ENERGY_TRADING_DB),
    db_status: env.ENERGY_TRADING_DB ? 'd1_bound' : 'not_configured',
    version: COMMODITY_ENERGY_VERSION,
    updated_at: updatedAt,
    ledger: {
      source: env.ENERGY_TRADING_DB ? 'longone_worker_d1' : 'worker_default_no_d1',
      api_prefix: '/api/commodity-energy-trading',
      user_id: userId,
      user_id_suffix: userId.slice(-10),
      dashboard_updated_at: updatedAt,
      account_started_at: state.started_at || '',
      account_stopped_at: state.stopped_at || '',
      account_last_tick_at: state.last_tick_at || '',
      scheduler_enabled: Boolean(state.scheduler?.enabled),
      scheduler_cadence: state.scheduler?.cadence || '',
      scheduler_last_tick_at: state.scheduler?.last_cron_tick_at || '',
      scheduler_last_market_latest_at: state.scheduler?.last_cron_market_latest_at || '',
      browser_storage_key: 'hfcd_energy_user_id',
      position_controller: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
      position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
      forecast_edge_gate: FORECAST_EDGE_GATE_PROMOTED ? 'promoted_blocking_gate' : 'shadow_audit_only',
      note: 'This is the longone online Worker/D1 ledger for the browser user id, not the local outputs/ heartbeat file ledger.',
    },
    source_status: feed.source_status,
    routes: COMMODITY_ENERGY_ROUTES,
    active_trade_routes: COMMODITY_ENERGY_ROUTES.filter((route) => route.forward_enabled !== false && route.online_trade_allowed !== false),
    watchlist_routes: COMMODITY_ENERGY_ROUTES.filter((route) => route.forward_enabled === false || route.online_trade_allowed === false),
    decisions: feed.signals,
    tensor_shadow: {
      version: COMMODITY_ENERGY_TENSOR_GUARD_VERSION,
      mode: 'shadow_only',
      rule: '主信号仍使用 V7.5 的 HO=F 2h / CL=F 3h 强血统；V7.8 执行层采用最小状态修复：同 tick 平仓后不重开，反手下一 tick 确认。',
      params: COMMODITY_ENERGY_TENSOR_PARAMS,
    },
    tensor_shadow_events: (state.tensor_shadow_events || []).slice(0, 80),
    execution_repair: {
      version: 'V7.8_minimal_state_repair',
      mode: 'shadow_execution_control',
      rule: '无仓才开仓；同向只在确认时加仓；反向信号先平旧仓，再等下一 tick 重新确认反手，否则跳过。',
      universal_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
      pending_reverse_orders: (state.pending_reverse_orders || []).slice(0, 20),
      events: (state.execution_repair_events || []).slice(0, 80),
    },
    market_health: {
      ok: true,
      status: feed.source_status,
      latest_captured_at: feed.signals?.[0]?.captured_at,
      rows: feed.signals?.length || 0,
      note: 'V7.8 最小状态修复影子账本：只允许 HO=F 2h long_short 和 CL=F 3h long_short 进入能源商品纸面交易；主信号继承 V7.5，执行层禁止同 tick 平仓后重开。',
    },
    summary: {
      mode: state.mode,
      equity_usd: state.equity_usd,
      cash_usd: state.cash_usd,
      settled_equity_usd: state.settled_equity_usd ?? commodityEnergySettledEquity(state),
      realized_pnl_usd: state.realized_pnl_usd,
      unrealized_pnl_usd: unrealizedPnl,
      open_positions: (state.open_positions || []).length,
      max_open_positions: state.config?.max_open_positions || 4,
      win_rate: (state.closed_trades || []).length
        ? (state.closed_trades || []).filter((trade: any) => Number(trade.net_pnl_usd || 0) > 0).length / (state.closed_trades || []).length
        : 0,
      config: state.config,
    },
    account: state,
    recent_trades: trades,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

function applyCommodityEnergyConfig(state: any, body: any = {}, allowCapitalReset = false) {
  const cfg = state.config || {};
  state.config = {
    ...cfg,
    fixed_trade_usd: bodyNumber(body, cfg, 'fixed_trade_usd', 1000, { min: 1 }),
    max_open_positions: bodyNumber(body, cfg, 'max_open_positions', 4, { min: 1, max: 50, integer: true }),
    max_symbol_positions: bodyNumber(body, cfg, 'max_symbol_positions', 1, { min: 1, max: 10, integer: true }),
    stop_loss_pct: bodyNumber(body, cfg, 'stop_loss_pct', 0.018, { min: 0.0001, max: 1 }),
    take_profit_pct: bodyNumber(body, cfg, 'take_profit_pct', 0.036, { min: 0.0001, max: 2 }),
    min_signal_score: bodyNumber(body, cfg, 'min_signal_score', 0.66, { min: 0, max: 1 }),
    allow_short: body.allow_short !== undefined ? body.allow_short !== false : cfg.allow_short !== false,
    sizing_mode: String(body.sizing_mode || cfg.sizing_mode || 'score_scaled'),
    position_controller: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
    position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
    forecast_edge_gate: FORECAST_EDGE_GATE_PROMOTED ? 'promoted' : 'shadow',
    updated_at: energyIso(),
  };
  if (allowCapitalReset && bodyHasValue(body, 'capital_usd')) {
    const capital = bodyNumber(body, { capital_usd: state.initial_cash_usd }, 'capital_usd', state.initial_cash_usd || 100_000, { min: 1 });
    state.initial_cash_usd = capital;
    state.cash_usd = capital;
    state.settled_equity_usd = capital;
    state.equity_usd = capital;
    state.peak_equity_usd = capital;
  }
  return state.config;
}

async function commodityEnergyConfig(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = commodityEnergyUserId(request, url, body);
  const state = await loadCommodityEnergyAccount(env, userId);
  applyCommodityEnergyConfig(state, body, false);
  state.last_config_updated_at = energyIso();
  await saveCommodityEnergyAccount(env, state);
  return json({ ok: true, action: 'config_updated', user_id: userId, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function commodityEnergyStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = commodityEnergyUserId(request, url, body);
  const existing = await loadCommodityEnergyAccount(env, userId);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultCommodityEnergyAccount(userId, body) : existing;
  applyCommodityEnergyConfig(state, body, isFresh);
  state.mode = 'running';
  state.started_at = state.started_at || energyIso();
  state.stopped_at = '';
  state.last_tick_at = energyIso();
  await commodityEnergyTick(env, state, false);
  await saveCommodityEnergyAccount(env, state);
  return json({ ok: true, action: 'started', user_id: userId, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function commodityEnergyTickApi(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = commodityEnergyUserId(request, url, body);
  const state = await loadCommodityEnergyAccount(env, userId);
  if (Object.keys(body || {}).some((key) => key !== 'user_id' && key !== 'auto_tick_reason')) {
    applyCommodityEnergyConfig(state, body, false);
  }
  const result = await commodityEnergyTick(env, state, false);
  state.last_tick_at = energyIso();
  await saveCommodityEnergyAccount(env, state);
  return json({ ok: true, user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function commodityEnergyStop(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = commodityEnergyUserId(request, url, body);
  const state = await loadCommodityEnergyAccount(env, userId);
  const result = await commodityEnergyTick(env, state, Boolean(body?.liquidate !== false));
  state.mode = 'stopped';
  state.stopped_at = energyIso();
  state.last_tick_at = energyIso();
  await saveCommodityEnergyAccount(env, state);
  return json({ ok: true, action: 'stopped', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function commodityEnergyReset(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = commodityEnergyUserId(request, url, body);
  const state: any = defaultCommodityEnergyAccount(userId, body);
  state.mode = 'stopped';
  state.stopped_at = energyIso();
  state.last_tick_at = '';
  await clearEnergyTrades(env, userId);
  await saveCommodityEnergyAccount(env, state);
  return json(
    {
      ok: true,
      action: 'reset',
      user_id: userId,
      ledger: {
        source: env.ENERGY_TRADING_DB ? 'longone_worker_d1' : 'worker_default_no_d1',
        user_id: userId,
        user_id_suffix: userId.slice(-10),
      },
      account: state,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const MARKET_TRADING_VERSION = 'HFCD_Trading_V1_MultiMarket_PaperEngine';
const MARKET_SYMBOLS = [...MULTI_MARKET_TRADING_CONFIG.symbols];
const MARKET_FEE_RATE = 0.0006;
const CRYPTO_TESTNET_VERSION = 'HFCD_Stock_V1_4_BigTechLongShortOnlinePaper';
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
  {
    symbol: 'MSFT',
    name: 'Microsoft',
    asset_class: 'single_stock',
    cadence: '1h',
    route: 'msft_stock_v1_3_1h_long_online_paper',
    route_status: 'main',
    side_policy: 'long_only',
    validated_side_policy: 'long_only',
    short_policy_status: 'blocked_no_short_blind_pass',
    market_data_source: 'yahoo_chart',
    exchange_tradeable: false,
    min_signal_score: 0.62,
    long_min_signal_score: 0.62,
    estimated_spread_bps: 2.0,
    default_holding_minutes: 120,
    max_event_risk: 0.55,
    blind_test: {
      version: 'HFCD_Stock_V1_2_DirectionSensorUpgrade',
      policy: 'MSFT 1h long_only',
      train_trades: 7,
      train_net_pnl_usd: 4.4269,
      train_profit_factor: 1.118853,
      validation_trades: 3,
      validation_net_pnl_usd: 4.0898,
      validation_profit_factor: 2.00941,
      test_trades: 11,
      test_net_pnl_usd: 38.3363,
      test_profit_factor: 3.613173,
      test_win_rate: 0.818182,
    },
  },
  {
    symbol: 'TSLA',
    name: 'Tesla',
    asset_class: 'single_stock',
    cadence: '15m',
    route: 'tsla_stock_v1_4_15m_short_online_paper',
    route_status: 'main',
    side_policy: 'short_only',
    validated_side_policy: 'short_only',
    short_policy_status: 'stock_v1_4_online_paper_candidate',
    market_data_source: 'yahoo_chart',
    exchange_tradeable: false,
    min_signal_score: 0.60,
    short_min_signal_score: 0.60,
    estimated_spread_bps: 3.5,
    default_holding_minutes: 45,
    max_event_risk: 0.55,
    sector_symbol: 'QQQ',
    blind_test: {
      version: 'HFCD_Stock_V1_4_BigTechLongShortBlind',
      policy: 'TSLA 15m short_only',
      train_trades: 11,
      train_net_pnl_usd: 49.9608,
      train_profit_factor: 12.240497,
      validation_trades: 4,
      validation_net_pnl_usd: 9.4842,
      validation_profit_factor: 2.353244,
      test_trades: 5,
      test_net_pnl_usd: 9.9383,
      test_profit_factor: 1.541119,
      test_win_rate: 0.6,
    },
  },
  {
    symbol: 'AAPL',
    name: 'Apple',
    asset_class: 'single_stock',
    cadence: '1h',
    route: 'aapl_stock_v1_4_1h_long_online_paper',
    route_status: 'main',
    side_policy: 'long_only',
    validated_side_policy: 'long_only',
    short_policy_status: 'blocked_no_short_blind_pass',
    market_data_source: 'yahoo_chart',
    exchange_tradeable: false,
    min_signal_score: 0.58,
    long_min_signal_score: 0.58,
    estimated_spread_bps: 1.8,
    default_holding_minutes: 120,
    max_event_risk: 0.55,
    sector_symbol: 'XLK',
    blind_test: {
      version: 'HFCD_Stock_V1_4_BigTechLongShortBlind',
      policy: 'AAPL 1h long_only',
      train_trades: 6,
      train_net_pnl_usd: 45.86,
      train_profit_factor: 9.555228,
      validation_trades: 3,
      validation_net_pnl_usd: 5.9475,
      validation_profit_factor: 3.433136,
      test_trades: 3,
      test_net_pnl_usd: 15.6213,
      test_profit_factor: 4.994495,
      test_win_rate: 0.666667,
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
    pending_reverse_orders: [] as any[],
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

async function clearMarketTrades(env: Env, userId: string) {
  const db = await ensureMarketTradingDb(env);
  if (!db) return;
  await db.prepare('DELETE FROM market_trades WHERE user_id = ?').bind(userId).run();
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
  const sameSideContinued = new Set<string>();
  const sameSideClosedThisTick = new Set<string>();
  let opened = 0;
  let closed = 0;
  for (const pos of state.open_positions || []) {
    const pnl = goldPositionPnl(pos, Number(signal.price || pos.last_price || pos.entry_price)) - Number(pos.estimated_fee_usd || 0);
    const due = forceClose || new Date(pos.target_exit_at).getTime() <= Date.now();
    const takeProfit = pnl >= Number(pos.take_profit_usd || 0);
    const stopLoss = pnl <= -Number(pos.stop_loss_usd || 0);
    const sameSideSignalStillValid = !forceClose
      && due
      && !takeProfit
      && !stopLoss
      && signal?.is_real_market_data
      && signal?.side === pos.side
      && ['BUY_LONG', 'SELL_SHORT'].includes(String(signal?.action || ''))
      && Number(signal?.score || 0) >= Number(state.config?.min_signal_score || 1.1);

    if (sameSideSignalStillValid) {
      const extended = {
        ...pos,
        last_price: signal.price,
        unrealized_pnl_usd: Number(pnl.toFixed(2)),
        target_exit_at: energyIso(new Date(Date.now() + Number(state.config?.max_holding_minutes || 24 * 60) * 60000)),
        last_signal_id: signal.signal_id,
        last_extended_at: energyIso(),
      };
      remaining.push(extended);
      sameSideContinued.add(`${pos.symbol}:${pos.side}`);
      if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
        state.seen_signal_ids.push(String(signal.signal_id));
      }
      await insertGoldTrade(env, state.display_user_id || state.user_id, {
        ts: energyIso(),
        event: 'HOLD_EXTEND',
        position_id: pos.position_id,
        signal_id: signal.signal_id,
        symbol: pos.symbol,
        asset_class: pos.asset_class,
        side: pos.side,
        action: signal.action,
        price: signal.price,
        trade_value_usd: Number(pos.notional_usd || 0),
        net_pnl_usd: 0,
        unrealized_pnl_usd: Number(pnl.toFixed(2)),
        score: signal.score,
        q_core: signal.q_core,
        source: signal.source,
        reason: '同向信号继续有效，延展持仓，避免平仓后同向重开',
      });
    } else if (due || takeProfit || stopLoss) {
      const reason = due ? '到期/停止结算' : pnl > 0 ? '止盈结算' : '止损结算';
      await closeGoldPosition(env, state, pos, signal, reason);
      closed += 1;
      sameSideClosedThisTick.add(`${pos.symbol}:${pos.side}`);
    } else {
      remaining.push({ ...pos, last_price: signal.price, unrealized_pnl_usd: Number(pnl.toFixed(2)) });
    }
  }
  state.open_positions = remaining;
  markGoldEquity(state, signal);
  if (!forceClose && state.mode === 'running') {
    const sameSideKey = `${signal.symbol}:${signal.side}`;
    const reason = sameSideContinued.has(sameSideKey)
      ? '同向持仓已续持，本轮不重复开仓'
      : sameSideClosedThisTick.has(sameSideKey)
        ? '同向持仓刚刚结算，本轮不重复开仓'
        : canOpenGoldPosition(signal, state);
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
    history_policy: {
      user_id: userId,
      storage: 'D1 market_accounts + market_trades',
      scope: 'per_browser_user',
      recent_trade_limit: 160,
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

function applyGoldTradingConfig(state: any, body: any = {}, allowCapitalReset = false) {
  const cfg = state.config || {};
  state.config = {
    ...cfg,
    fixed_trade_usd: bodyNumber(body, cfg, 'fixed_trade_usd', 5_000, { min: 1 }),
    max_open_positions: bodyNumber(body, cfg, 'max_open_positions', 4, { min: 1, max: 50, integer: true }),
    max_symbol_positions: bodyNumber(body, cfg, 'max_symbol_positions', 1, { min: 1, max: 10, integer: true }),
    stop_loss_pct: bodyNumber(body, cfg, 'stop_loss_pct', 0.012, { min: 0.0001, max: 1 }),
    take_profit_pct: bodyNumber(body, cfg, 'take_profit_pct', 0.024, { min: 0.0001, max: 2 }),
    min_signal_score: bodyNumber(body, cfg, 'min_signal_score', 1.1, { min: 0 }),
    max_holding_minutes: bodyNumber(body, cfg, 'max_holding_minutes', 24 * 60, { min: 1, integer: true }),
    strategy: String(body.strategy || cfg.strategy || 'v1_38_real_time_gold_bidirectional_anchor'),
    side_policy: String(body.side_policy || cfg.side_policy || 'both'),
    allow_short: body.allow_short !== undefined ? body.allow_short !== false : cfg.allow_short !== false,
    updated_at: energyIso(),
  };
  if (allowCapitalReset && bodyHasValue(body, 'capital_usd')) {
    const capital = bodyNumber(body, { capital_usd: state.initial_cash_usd }, 'capital_usd', state.initial_cash_usd || 100_000, { min: 1 });
    state.initial_cash_usd = capital;
    state.realized_pnl_usd = 0;
    state.equity_usd = capital;
    state.peak_equity_usd = capital;
  }
  return state.config;
}

async function goldTradingConfig(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = goldUserId(request, url, body);
  const state = await loadGoldAccount(env, userId, body);
  state.display_user_id = userId;
  applyGoldTradingConfig(state, body, false);
  state.last_config_updated_at = energyIso();
  await saveGoldAccount(env, state);
  return json({ ok: true, action: 'config_updated', user_id: userId, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function goldTradingStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = goldUserId(request, url, body);
  const existing = await loadGoldAccount(env, userId, body);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultGoldAccount(userId, body) : existing;
  state.display_user_id = userId;
  applyGoldTradingConfig(state, body, isFresh);
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
  if (Object.keys(body || {}).some((key) => key !== 'user_id' && key !== 'auto_tick_reason')) {
    applyGoldTradingConfig(state, body, false);
  }
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

function applyMarketTradingConfig(state: any, body: any = {}, allowCapitalReset = false) {
  const cfg = state.config || {};
  state.config = {
    ...cfg,
    fixed_trade_usd: bodyNumber(body, cfg, 'fixed_trade_usd', 1_000, { min: 1 }),
    max_open_positions: bodyNumber(body, cfg, 'max_open_positions', 8, { min: 1, max: 50, integer: true }),
    max_symbol_positions: bodyNumber(body, cfg, 'max_symbol_positions', 2, { min: 1, max: 10, integer: true }),
    stop_loss_pct: bodyNumber(body, cfg, 'stop_loss_pct', 0.018, { min: 0.0001, max: 1 }),
    take_profit_pct: bodyNumber(body, cfg, 'take_profit_pct', 0.036, { min: 0.0001, max: 2 }),
    min_signal_score: bodyNumber(body, cfg, 'min_signal_score', MULTI_MARKET_TRADING_CONFIG.global_min_signal_score || 0.72, { min: 0, max: 5 }),
    max_holding_minutes: bodyNumber(body, cfg, 'max_holding_minutes', 360, { min: 1, integer: true }),
    strategy: String(body.strategy || cfg.strategy || 'hfcd_stability_momentum'),
    updated_at: energyIso(),
  };
  if (allowCapitalReset && bodyHasValue(body, 'capital_usd')) {
    const capital = bodyNumber(body, { capital_usd: state.initial_cash_usd }, 'capital_usd', state.initial_cash_usd || 100_000, { min: 1 });
    state.initial_cash_usd = capital;
    state.realized_pnl_usd = 0;
    state.equity_usd = capital;
    state.peak_equity_usd = capital;
  }
  return state.config;
}

async function marketTradingConfig(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = marketUserId(request, url, body);
  const state = await loadMarketAccount(env, userId);
  applyMarketTradingConfig(state, body, false);
  state.last_config_updated_at = energyIso();
  await saveMarketAccount(env, state);
  return json({ ok: true, action: 'config_updated', user_id: userId, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function marketTradingStart(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = marketUserId(request, url, body);
  const existing = await loadMarketAccount(env, userId);
  const isFresh = !existing.started_at && !(existing.open_positions || []).length && !(existing.closed_trades || []).length;
  const state = body?.reset_account || isFresh ? defaultMarketAccount(userId, body) : existing;
  applyMarketTradingConfig(state, body, isFresh);
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
  if (Object.keys(body || {}).some((key) => key !== 'user_id' && key !== 'auto_tick_reason')) {
    applyMarketTradingConfig(state, body, false);
  }
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
      adaptive_sizing: body.adaptive_sizing !== false,
      max_position_pct: Number(body.max_position_pct || 0.04),
      max_open_positions: Number(body.max_open_positions || 4),
      max_symbol_positions: Number(body.max_symbol_positions || 1),
      stop_loss_pct: Number(body.stop_loss_pct || 0.018),
      take_profit_pct: Number(body.take_profit_pct || 0.036),
      min_signal_score: Number(body.min_signal_score || 0.66),
      max_holding_minutes: Number(body.max_holding_minutes || 8 * 60),
      side_policy: String(body.side_policy || 'both'),
      allow_short: body.allow_short !== false,
      allow_scale_in: body.allow_scale_in !== false,
      allow_reduce: body.allow_reduce !== false,
      allow_reverse: body.allow_reverse !== false,
      position_controller: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
      position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
      forecast_edge_gate: FORECAST_EDGE_GATE_PROMOTED ? 'promoted' : 'shadow',
      order_execution: String(body.order_execution || 'paper'),
      testnet_close_all_on_stop: body.testnet_close_all_on_stop !== false,
      asset_scope: String(body.asset_scope || 'all'),
      strategy: String(body.strategy || 'v2_23_frequency_router_btc1h_eth2h_bidirectional'),
    },
  };
}

function normalizeCryptoTestnetConfig(config: any = {}) {
  const next = { ...config };
  next.fixed_trade_usd = Math.max(Number(next.fixed_trade_usd || 1_000), 1);
  next.adaptive_sizing = next.adaptive_sizing !== false;
  next.max_position_pct = Math.max(0.001, Math.min(Number(next.max_position_pct || 0.04), 0.2));
  next.max_symbol_positions = Math.max(1, Math.min(Number(next.max_symbol_positions || 1), 10));
  next.max_open_positions = Math.max(1, Math.min(Number(next.max_open_positions || 4), 50));
  next.stop_loss_pct = Math.max(0.001, Math.min(Number(next.stop_loss_pct || 0.018), 0.2));
  next.take_profit_pct = Math.max(0.001, Math.min(Number(next.take_profit_pct || 0.036), 0.4));
  next.min_signal_score = Math.max(0.1, Math.min(Number(next.min_signal_score || 0.66), 5));
  next.max_holding_minutes = Math.max(15, Math.min(Number(next.max_holding_minutes || 8 * 60), 24 * 60));
  next.side_policy = ['long_only', 'short_only', 'both'].includes(String(next.side_policy)) ? String(next.side_policy) : 'both';
  next.allow_short = next.allow_short !== false;
  next.allow_scale_in = next.allow_scale_in !== false;
  next.allow_reduce = next.allow_reduce !== false;
  next.allow_reverse = next.allow_reverse !== false;
  next.position_controller = HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION;
  next.position_controller_rule = HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE;
  next.forecast_edge_gate = FORECAST_EDGE_GATE_PROMOTED ? 'promoted' : 'shadow';
  next.order_execution = String(next.order_execution || 'paper') === 'binance_testnet' ? 'binance_testnet' : 'paper';
  next.testnet_close_all_on_stop = next.testnet_close_all_on_stop !== false;
  next.asset_scope = ['all', 'non_stock', 'stock'].includes(String(next.asset_scope || 'all')) ? String(next.asset_scope || 'all') : 'all';
  const strategy = String(next.strategy || '');
  next.strategy = strategy.startsWith('v3_6_') ? strategy : 'v3_6_property_gated_bidirectional_execution';
  return next;
}

function cryptoScopedRequestBody(url: URL, body: any = {}, currentConfig: any = {}) {
  const requestedScope = String(body.asset_scope || url.searchParams.get('asset_scope') || '');
  if (!requestedScope) return body;
  const scoped: any = {
    ...body,
    asset_scope: requestedScope,
  };
  if (requestedScope === 'stock') {
    return {
      ...scoped,
      order_execution: 'paper',
      side_policy: 'both',
      allow_short: true,
      max_open_positions: scoped.max_open_positions || currentConfig?.max_open_positions || 3,
      max_symbol_positions: scoped.max_symbol_positions || currentConfig?.max_symbol_positions || 1,
      min_signal_score: currentConfig?.min_signal_score || scoped.min_signal_score || 0.60,
      max_holding_minutes: currentConfig?.max_holding_minutes || scoped.max_holding_minutes || 120,
    };
  }
  return scoped;
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
  normalized.version = CRYPTO_TESTNET_VERSION;
  normalized.display_user_id = normalized.display_user_id || userId;
  normalized.user_id = normalized.user_id || cryptoTestnetStorageUserId(userId);
  if (!Array.isArray(normalized.seen_audit_signal_ids)) normalized.seen_audit_signal_ids = [];
  if (!Array.isArray(normalized.pending_reverse_orders)) normalized.pending_reverse_orders = [];
  if (!normalized.config.side_policy) normalized.config.side_policy = 'both';
  if (!normalized.config.order_execution) normalized.config.order_execution = 'paper';
  if (normalized.config.adaptive_sizing === undefined) normalized.config.adaptive_sizing = true;
  if (!Number.isFinite(Number(normalized.config.max_position_pct))) normalized.config.max_position_pct = 0.04;
  if (normalized.config.testnet_close_all_on_stop === undefined) normalized.config.testnet_close_all_on_stop = true;
  if (normalized.config.allow_short === undefined || state?.version !== CRYPTO_TESTNET_VERSION) {
    normalized.config.allow_short = true;
  }
  if (normalized.config.allow_scale_in === undefined) normalized.config.allow_scale_in = true;
  if (normalized.config.allow_reduce === undefined) normalized.config.allow_reduce = true;
  if (normalized.config.allow_reverse === undefined) normalized.config.allow_reverse = true;
  normalized.config = normalizeCryptoTestnetConfig(normalized.config);
  return normalized;
}

function mergeCryptoTestnetConfig(state: any, body: any = {}) {
  const current = state.config || {};
  const has = (key: string) => body && body[key] !== undefined && body[key] !== null && body[key] !== '';
  return normalizeCryptoTestnetConfig({
    ...current,
    fixed_trade_usd: Number(has('fixed_trade_usd') ? body.fixed_trade_usd : has('max_order_usd') ? body.max_order_usd : current.fixed_trade_usd || 1_000),
    adaptive_sizing: has('adaptive_sizing') ? body.adaptive_sizing !== false : current.adaptive_sizing !== false,
    max_position_pct: Number(has('max_position_pct') ? body.max_position_pct : current.max_position_pct || 0.04),
    max_open_positions: Number(has('max_open_positions') ? body.max_open_positions : current.max_open_positions || 4),
    max_symbol_positions: Number(has('max_symbol_positions') ? body.max_symbol_positions : current.max_symbol_positions || 1),
    stop_loss_pct: Number(has('stop_loss_pct') ? body.stop_loss_pct : current.stop_loss_pct || 0.018),
    take_profit_pct: Number(has('take_profit_pct') ? body.take_profit_pct : current.take_profit_pct || 0.036),
    min_signal_score: Number(has('min_signal_score') ? body.min_signal_score : current.min_signal_score || 0.66),
    max_holding_minutes: Number(has('max_holding_minutes') ? body.max_holding_minutes : current.max_holding_minutes || 8 * 60),
    side_policy: String(has('side_policy') ? body.side_policy : current.side_policy || 'both'),
    allow_short: has('allow_short') ? body.allow_short !== false : current.allow_short !== false,
    allow_scale_in: has('allow_scale_in') ? body.allow_scale_in !== false : current.allow_scale_in !== false,
    allow_reduce: has('allow_reduce') ? body.allow_reduce !== false : current.allow_reduce !== false,
    allow_reverse: has('allow_reverse') ? body.allow_reverse !== false : current.allow_reverse !== false,
    order_execution: String(has('order_execution') ? body.order_execution : current.order_execution || 'paper') === 'binance_testnet' ? 'binance_testnet' : 'paper',
    testnet_close_all_on_stop: has('testnet_close_all_on_stop') ? body.testnet_close_all_on_stop !== false : current.testnet_close_all_on_stop !== false,
    asset_scope: String(has('asset_scope') ? body.asset_scope : current.asset_scope || 'all'),
    strategy: String(has('strategy') ? body.strategy : current.strategy || 'v3_1_shortvol_bidirectional_forward_ledger'),
  });
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

function cryptoRoutesForScope(assetScope = 'all') {
  const scope = String(assetScope || 'all');
  if (scope === 'stock') return CRYPTO_TESTNET_SYMBOLS.filter((row) => row.asset_class === 'single_stock');
  if (scope === 'non_stock') return CRYPTO_TESTNET_SYMBOLS.filter((row) => row.asset_class !== 'single_stock');
  return CRYPTO_TESTNET_SYMBOLS;
}

function cryptoRouteSetForScope(assetScope = 'all') {
  const scope = String(assetScope || 'all');
  if (scope === 'stock') return 'stock_v1_4_bigtech_long_short';
  if (scope === 'non_stock') return 'crypto_etf_routes';
  return 'crypto_etf_routes_plus_stock_v1_4_bigtech';
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
  const base = symbol === 'BTCUSDT'
    ? 82_000
    : symbol === 'SOLUSDT'
      ? 145
      : symbol === 'SPY'
        ? 720
        : symbol === 'QQQ'
          ? 680
          : symbol === 'IWM'
            ? 245
            : symbol === 'MSFT'
              ? 520
              : symbol === 'AAPL'
                ? 200
                : symbol === 'TSLA'
                  ? 180
                  : symbol === 'NVDA'
                    ? 120
                    : 2_400;
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

function seriesReturn(series: any, bars = 1) {
  const rows = Array.isArray(series?.rows) ? series.rows : [];
  const closes = rows.map((row: any) => Number(row.close)).filter((value: number) => Number.isFinite(value) && value > 0);
  if (closes.length <= bars) return 0;
  const last = closes[closes.length - 1];
  const base = closes[Math.max(0, closes.length - 1 - bars)];
  return base > 0 ? last / base - 1 : 0;
}

async function fetchStockForwardSensorContext() {
  const sensorMetas = [
    { symbol: 'SPY', name: 'SPY', cadence: '1h', estimated_spread_bps: 1.5, market_data_source: 'yahoo_chart' },
    { symbol: 'QQQ', name: 'QQQ', cadence: '1h', estimated_spread_bps: 1.8, market_data_source: 'yahoo_chart' },
    { symbol: 'XLK', name: 'Technology Sector ETF', cadence: '1h', estimated_spread_bps: 2.0, market_data_source: 'yahoo_chart' },
    { symbol: '^VIX', name: 'VIX', cadence: '1h', estimated_spread_bps: 0.0, market_data_source: 'yahoo_chart' },
  ];
  const rows = await Promise.all(sensorMetas.map((meta) => fetchShortvolYahooSeries(meta).catch(() => null)));
  const bySymbol = Object.fromEntries(rows.filter(Boolean).map((row: any) => [row.symbol, row]));
  return {
    source_status: rows.every((row: any) => row?.is_real_market_data) ? 'stock_sensors_realtime_yahoo' : 'stock_sensors_partial_or_fallback',
    spy_ret_1: seriesReturn(bySymbol.SPY, 1),
    qqq_ret_1: seriesReturn(bySymbol.QQQ, 1),
    xlk_ret_1: seriesReturn(bySymbol.XLK, 1),
    xlk_ret_4: seriesReturn(bySymbol.XLK, 4),
    vix_ret_1: seriesReturn(bySymbol['^VIX'], 1),
    vix_ret_4: seriesReturn(bySymbol['^VIX'], 4),
    sensors: bySymbol,
  };
}

function stockEventRiskFromTimestamp(ts: string, context: any) {
  const date = new Date(ts);
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const minutes = h * 60 + m;
  const openRisk = minutes >= 13 * 60 + 30 && minutes <= 14 * 60 + 30 ? 0.35 : 0;
  const closeRisk = minutes >= 19 * 60 && minutes <= 20 * 60 ? 0.25 : 0;
  const marketShock = Math.abs(Number(context?.spy_ret_1 || 0)) > 0.0045 || Math.abs(Number(context?.qqq_ret_1 || 0)) > 0.0055 ? 0.25 : 0;
  const vixShock = Number(context?.vix_ret_1 || 0) > 0.025 || Number(context?.vix_ret_4 || 0) > 0.05 ? 0.35 : 0;
  return Math.min(1, openRisk + closeRisk + marketShock + vixShock);
}

function buildCryptoTestnetSignal(series: any, minSignalScore = 0.66, stockContext: any = null) {
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
  const isStockForwardRoute = meta.asset_class === 'single_stock';
  const stockSectorSymbol = String(meta.sector_symbol || 'XLK');
  const sectorRet = isStockForwardRoute
    ? Number(stockSectorSymbol === 'QQQ' ? stockContext?.qqq_ret_1 || 0 : stockContext?.xlk_ret_1 || 0)
    : 0;
  const marketRet = isStockForwardRoute ? Number(stockContext?.spy_ret_1 || 0) : 0;
  const vixRet = isStockForwardRoute ? Number(stockContext?.vix_ret_1 || 0) : 0;
  const stockSectorBoost = isStockForwardRoute
    ? Math.max(-0.10, Math.min(0.10, ((sectorRet + marketRet * 0.55) / Math.max(realizedVol, 0.0015)) * 0.035 - Math.max(vixRet, 0) * 0.8))
    : 0;
  const directionalScore = Math.max(0, Math.abs(trendZ) * 0.58 + Math.abs(depthImbalance) * 0.18 + volumePulse + darkForestBoost + stockSectorBoost - spreadPenalty - fundingPenalty);
  const rawAction = trendZ >= 0 ? 'BUY_LONG' : 'SELL_SHORT';
  const longThreshold = Math.max(Number(minSignalScore || 0.66), Number(meta.long_min_signal_score || meta.min_signal_score || 0.66));
  const shortThreshold = Math.max(Number(meta.short_min_signal_score || meta.min_signal_score || minSignalScore || 0.66), 0.0);
  const effectiveThreshold = rawAction === 'SELL_SHORT' ? shortThreshold : longThreshold;
  let action = directionalScore >= effectiveThreshold ? rawAction : 'NO_TRADE';
  let routeRejectReason = '';
  const shortForwardOnly = action === 'SELL_SHORT' && meta.validated_side_policy === 'long_only';
  const latestTs = rows[rows.length - 1]?.ts || energyIso();
  const price = Number((series.sensors?.mark_price || last).toFixed(cryptoRoutePriceDigits(series.symbol)));
  const bestBid = Number(series.sensors?.best_bid || price);
  const bestAsk = Number(series.sensors?.best_ask || price);
  const stockExpectedBoost = isStockForwardRoute ? 0.22 * sectorRet + 0.14 * marketRet - Math.max(vixRet, 0) * 0.10 : 0;
  const expectedReturn = hfcdClamp((0.42 * r3 + 0.36 * r12 + 0.22 * r48) + stockExpectedBoost + depthImbalance * realizedVol * 0.9 - Math.sign(trendZ || 1) * funding * 1.8, -0.08, 0.08);
  const eventRisk = isStockForwardRoute ? stockEventRiskFromTimestamp(latestTs, stockContext) : 0;
  if (action === 'SELL_SHORT' && meta.side_policy === 'long_only') {
    routeRejectReason = `${series.symbol} 股票线上模拟路线当前只允许做多，做空未接入主账本`;
    action = 'NO_TRADE';
  }
  if (action === 'BUY_LONG' && meta.side_policy === 'short_only') {
    routeRejectReason = '该路线当前只允许做空，做多未接入主账本';
    action = 'NO_TRADE';
  }
  if (isStockForwardRoute && action !== 'NO_TRADE' && eventRisk > Number(meta.max_event_risk || 0.55)) {
    routeRejectReason = '股票事件/开收盘/VIX 风险过高，跳过本轮信号';
    action = 'NO_TRADE';
  }
  const expectedFuturePrice = price * (1 + expectedReturn);
  const forecastEdge = action === 'NO_TRADE'
    ? forecastEdgeGate({ side: 'flat', current_value: price, expected_future_value: price })
    : forecastEdgeGate({
      asset: series.symbol,
      mode: 'price',
      current_value: price,
      expected_future_value: expectedFuturePrice,
      side: action === 'BUY_LONG' ? 'long' : 'short',
      fee_rate: CRYPTO_TESTNET_FEE_RATE,
      spread_bps: Number(series.sensors?.spread_bps || 0),
      slippage_bps: meta.asset_class === 'crypto_perp' ? 1.8 : 1.2,
      realized_vol: realizedVol,
      vol_multiplier: meta.asset_class === 'crypto_perp' ? 0.32 : 0.22,
      risk_buffer_pct: Math.abs(funding) * 2.5 + (isStockForwardRoute ? eventRisk * 0.00035 : 0),
      min_edge_pct: meta.asset_class === 'crypto_perp' ? 0.0018 : isStockForwardRoute ? 0.0010 : 0.0012,
      max_multiplier: 1.65,
    });
  if (FORECAST_EDGE_GATE_PROMOTED && action !== 'NO_TRADE' && !forecastEdge.ok) {
    routeRejectReason = forecastEdge.reason;
    action = 'NO_TRADE';
  }
  const side = action === 'BUY_LONG' ? 'long' : action === 'SELL_SHORT' ? 'short' : '-';
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
    raw_action: rawAction,
    action,
    side,
    score: Number(directionalScore.toFixed(4)),
    signed_score: Number(trendZ.toFixed(4)),
    confidence: Number(Math.max(0, Math.min(0.99, 0.5 + directionalScore * 0.22)).toFixed(4)),
    realized_vol: Number(realizedVol.toFixed(6)),
    expected_return: Number(expectedReturn.toFixed(6)),
    expected_future_price: Number(expectedFuturePrice.toFixed(cryptoRoutePriceDigits(series.symbol))),
    forecast_edge_gate: forecastEdge,
    forecast_edge_mode: FORECAST_EDGE_GATE_PROMOTED ? 'promoted_gate' : 'shadow_audit_only',
    forecast_edge_pct: forecastEdge.forecast_edge_pct,
    position_multiplier: forecastEdge.position_multiplier,
    stock_event_risk: Number(eventRisk.toFixed(4)),
    sector_ret_1: Number(sectorRet.toFixed(6)),
    market_ret_1: Number(marketRet.toFixed(6)),
    vix_ret_1: Number(vixRet.toFixed(6)),
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
    reject_reason: action === 'NO_TRADE' ? (routeRejectReason || '线上模拟路线实时信号未达门槛') : '',
  };
}

async function buildCryptoTestnetSnapshot(minSignalScore = 0.66, assetScope = 'all') {
  const routes = cryptoRoutesForScope(assetScope);
  const needsStockSensors = routes.some((row) => row.asset_class === 'single_stock');
  const [seriesList, stockContext] = await Promise.all([
    Promise.all(routes.map((row) => fetchCryptoTestnetSeries(row.symbol))),
    needsStockSensors ? fetchStockForwardSensorContext() : Promise.resolve(null),
  ]);
  const signals = seriesList.map((series) => buildCryptoTestnetSignal(series, minSignalScore, stockContext));
  return {
    generated_at: energyIso(),
    source_status: signals.every((signal) => signal.is_real_market_data) ? 'public_realtime_mixed_binance_yahoo' : 'mixed_or_fallback',
    order_mode: 'online_paper_ledger_with_binance_demo_for_crypto_only',
    main_side_policy: 'route_level_long_short_permission_with_stock_v1_4_bigtech',
    route_set: cryptoRouteSetForScope(assetScope),
    stock_sensor_status: stockContext?.source_status || 'not_required',
    selected_routes: routes.map((row) => ({
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
      forecast_edge_pct: signal.forecast_edge_pct,
      forecast_edge_gate: signal.forecast_edge_gate,
      stock_event_risk: signal.stock_event_risk,
      sector_ret_1: signal.sector_ret_1,
      market_ret_1: signal.market_ret_1,
      vix_ret_1: signal.vix_ret_1,
      volume_recent: signal.volume_recent,
      volume_notional_proxy: signal.volume_notional_proxy,
      source: signal.source,
      is_real_market_data: signal.is_real_market_data,
    })),
  };
}

function cryptoTestnetRouteCards(assetScope = 'all') {
  return cryptoRoutesForScope(assetScope).map((row) => ({
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
  }));
}

function cryptoTestnetDashboardSnapshot(state: any) {
  const cached = state?.last_market_snapshot;
  const expectedRouteSet = cryptoRouteSetForScope(state?.config?.asset_scope || 'all');
  if (cached && cached.route_set === expectedRouteSet && Array.isArray(cached.selected_routes) && Array.isArray(cached.signals) && Array.isArray(cached.sensors)) {
    return {
      ...cached,
      source_status: cached.source_status || 'cached_last_tick_snapshot',
      dashboard_cache: true,
    };
  }
  return {
    generated_at: state?.last_tick_at || energyIso(),
    source_status: 'dashboard_static_routes_no_live_fetch',
    order_mode: 'online_paper_ledger_with_binance_demo_for_crypto_only',
    main_side_policy: 'route_level_long_short_permission_with_msft_v1_3_long_only',
    route_set: expectedRouteSet,
    stock_sensor_status: 'dashboard_cache_not_refreshed',
    selected_routes: cryptoTestnetRouteCards(state?.config?.asset_scope || 'all'),
    signals: [],
    sensors: [],
    dashboard_cache: false,
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

function cryptoClamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function cryptoOpenNotional(state: any, symbol?: string) {
  return (state.open_positions || []).reduce((sum: number, pos: any) => {
    if (symbol && pos.symbol !== symbol) return sum;
    return sum + Math.abs(Number(pos.notional_usd || pos.trade_value_usd || 0));
  }, 0);
}

function cryptoSizingThreshold(signal: any, cfg: any) {
  return Math.max(
    Number(signal?.head_threshold || 0),
    Number(cfg?.min_signal_score || 0),
    Number(signal?.action === 'SELL_SHORT' ? signal?.short_min_signal_score || 0 : signal?.long_min_signal_score || 0),
    0.1,
  );
}

function cryptoShortRouteIsPromoted(signalOrSymbol: any) {
  const signal = typeof signalOrSymbol === 'string' ? null : signalOrSymbol;
  const meta = signal ? cryptoRouteMeta(signal.symbol) : cryptoRouteMeta(signalOrSymbol);
  const validated = String(signal?.validated_side_policy || meta.validated_side_policy || meta.side_policy || '');
  const status = String(signal?.short_policy_status || meta.short_policy_status || '');
  return validated === 'both' && status.includes('blind_promoted');
}

function cryptoPropertyGate(signal: any, state: any, intent: 'open' | 'add' | 'reverse', existing?: any) {
  if (!signal || !['BUY_LONG', 'SELL_SHORT'].includes(String(signal.action || ''))) {
    return { ok: false, reason: '没有可执行的做多/做空信号', property_score: 0 };
  }
  if (signal.action === 'SELL_SHORT' && !cryptoShortRouteIsPromoted(signal)) {
    return {
      ok: false,
      reason: '做空路线仍是 forward shadow，未通过独立盲测，不允许进入主账本',
      property_score: 0,
    };
  }
  const forecastEdge = signal.forecast_edge_gate || null;
  if (FORECAST_EDGE_GATE_PROMOTED && (!forecastEdge || forecastEdge.ok !== true)) {
    return {
      ok: false,
      reason: forecastEdge?.reason || '缺少预测边际，不能证明未来空间覆盖成本和噪声',
      property_score: 0,
    };
  }
  const cfg = state.config || {};
  const threshold = cryptoSizingThreshold(signal, cfg);
  const score = Number(signal.score || 0);
  const edge = cryptoClamp((score - threshold) / Math.max(0.18, threshold), 0, 1.25);
  const forecastQuality = FORECAST_EDGE_GATE_PROMOTED ? cryptoClamp(Number(forecastEdge?.position_multiplier || signal.position_multiplier || 0) / 1.65, 0, 1) : 0;
  const confidence = cryptoClamp(Number(signal.confidence || 0.5), 0, 1);
  const spreadQuality = cryptoClamp(1 - Math.max(Number(signal.spread_bps || 0), 0) / (signal.asset_class === 'crypto_perp' ? 24 : 12), 0, 1);
  const depthUsd = signal.side === 'short' ? Number(signal.bid_depth_usd || 0) : Number(signal.ask_depth_usd || 0);
  const liquidityQuality = depthUsd > 0
    ? cryptoClamp(depthUsd / Math.max(Number(cfg.fixed_trade_usd || 1_000) * 10, 1), 0, 1)
    : signal.asset_class === 'crypto_perp' ? 0.48 : 0.68;
  const directionalOk = signal.action === 'SELL_SHORT'
    ? Number(signal.signed_score || 0) < 0
    : Number(signal.signed_score || 0) > 0;
  const directionQuality = directionalOk ? 1 : 0.25;
  const existingPenalty = existing && Number(existing.unrealized_pnl_usd || 0) < 0 && intent === 'add' ? 0.12 : 0;
  const propertyScore = cryptoClamp(
    FORECAST_EDGE_GATE_PROMOTED
      ? edge * 0.28 + forecastQuality * 0.18 + confidence * 0.20 + spreadQuality * 0.14 + liquidityQuality * 0.12 + directionQuality * 0.08 - existingPenalty
      : edge * 0.34 + confidence * 0.22 + spreadQuality * 0.16 + liquidityQuality * 0.16 + directionQuality * 0.12 - existingPenalty,
    0,
    1.2,
  );
  const required = intent === 'reverse' ? 0.72 : intent === 'add' ? 0.66 : 0.50;
  if (propertyScore < required) {
    return {
      ok: false,
      reason: `物性确认不足：${intent} 需要 ${required.toFixed(2)}，当前 ${propertyScore.toFixed(2)}`,
      property_score: Number(propertyScore.toFixed(4)),
    };
  }
  if (intent === 'add' && existing && Number(signal.score || 0) < Number(existing.score || 0) + 0.10) {
    return {
      ok: false,
      reason: '同向加仓需要显著强于已有仓位的信号',
      property_score: Number(propertyScore.toFixed(4)),
    };
  }
  if (intent === 'add' && existing && FORECAST_EDGE_GATE_PROMOTED) {
    const nextEdgeFactor = Number(forecastEdge?.position_multiplier || signal.position_multiplier || 0);
    const existingEdgeFactor = Number(existing.forecast_edge_factor || 0);
    if (nextEdgeFactor <= existingEdgeFactor + 0.05) {
      return {
        ok: false,
        reason: '同向加仓需要预测边际继续扩大',
        property_score: Number(propertyScore.toFixed(4)),
      };
    }
  }
  if (intent === 'reverse' && existing) {
    const scoreLead = Number(signal.score || 0) - Number(existing.score || 0);
    const nextEdgeFactor = Number(forecastEdge?.position_multiplier || signal.position_multiplier || 0);
    const existingEdgeFactor = Number(existing.forecast_edge_factor || 0);
    const edgeLead = FORECAST_EDGE_GATE_PROMOTED ? nextEdgeFactor - existingEdgeFactor : 0;
    const reverseIsStronger = FORECAST_EDGE_GATE_PROMOTED
      ? scoreLead >= 0.10 || edgeLead >= 0.18
      : scoreLead >= 0.10;
    if (!reverseIsStronger) {
      return {
        ok: false,
        reason: '反向信号没有显著强于已有仓位，不允许反手',
        property_score: Number(propertyScore.toFixed(4)),
      };
    }
  }
  return {
    ok: true,
    reason: `物性确认通过：${intent}=${propertyScore.toFixed(2)}`,
    property_score: Number(propertyScore.toFixed(4)),
  };
}

function cryptoSignalTargetSide(signal: any) {
  if (signal?.action === 'BUY_LONG') return 'long';
  if (signal?.action === 'SELL_SHORT') return 'short';
  return '-';
}

function queueCryptoTestnetPendingReverse(state: any, signal: any, existing: any) {
  const targetSide = cryptoSignalTargetSide(signal);
  if (targetSide === '-') return null;
  const order = {
    order_id: `CRYPTO-REV-${Date.now()}-${signal.symbol}`,
    created_at: energyIso(),
    expires_at: energyIso(new Date(Date.now() + 90 * 60000)),
    status: 'queued_next_tick_confirmation',
    symbol: signal.symbol,
    target_side: targetSide,
    target_action: signal.action,
    from_side: existing?.side || '',
    from_position_id: existing?.position_id || '',
    from_signal_id: signal.signal_id,
    from_route: signal.route,
    from_price: Number(signal.price || 0),
    from_score: Number(signal.score || 0),
    from_confidence: Number(signal.confidence || 0),
    closed_position_score: Number(existing?.score || 0),
    closed_position_forecast_edge_factor: Number(existing?.forecast_edge_factor || 0),
    position_controller_version: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
    rule: '强反向第一次只平旧仓并排队，下一 tick 第二次确认后才允许反手开仓。',
  };
  state.pending_reverse_orders = [
    order,
    ...((state.pending_reverse_orders || []) as any[]).filter((row) => row.symbol !== signal.symbol),
  ].slice(0, 20);
  return order;
}

async function processCryptoTestnetPendingReverse(
  env: Env,
  state: any,
  signals: any[],
  credentials: BinanceTestnetCredentials | null | undefined,
  closedSymbolsThisTick: Set<string>,
) {
  const pendingOrders = (state.pending_reverse_orders || []) as any[];
  if (!pendingOrders.length || state.mode !== 'running') return 0;
  const kept: any[] = [];
  let opened = 0;
  for (const order of pendingOrders) {
    const symbol = String(order.symbol || '');
    if (!symbol) continue;
    if (new Date(String(order.expires_at || 0)).getTime() <= Date.now()) {
      await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
        ts: energyIso(),
        event: 'PENDING_REVERSE_EXPIRED',
        signal_id: order.from_signal_id,
        symbol,
        route: order.from_route,
        side: order.target_side,
        action: order.target_action,
        price: order.from_price,
        trade_value_usd: 0,
        net_pnl_usd: 0,
        score: order.from_score,
        confidence: order.from_confidence,
        source: 'crypto_position_controller',
        reason: '反手等待超时，放弃旧反手意图。',
      });
      continue;
    }
    if (closedSymbolsThisTick.has(symbol)) {
      kept.push(order);
      continue;
    }
    const signal = signals.find((row: any) => row.symbol === symbol);
    if (!signal || signal.action === 'NO_TRADE') {
      kept.push(order);
      continue;
    }
    const targetSide = cryptoSignalTargetSide(signal);
    if (targetSide !== order.target_side) {
      await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
        ts: energyIso(),
        event: 'PENDING_REVERSE_CANCELLED',
        signal_id: signal.signal_id || order.from_signal_id,
        symbol,
        route: signal.route || order.from_route,
        side: order.target_side,
        action: signal.action || order.target_action,
        price: signal.price || order.from_price,
        trade_value_usd: 0,
        net_pnl_usd: 0,
        score: signal.score || order.from_score,
        confidence: signal.confidence || order.from_confidence,
        source: signal.source || 'crypto_position_controller',
        reason: '下一 tick 未继续确认同向反手信号，取消反手。',
      });
      continue;
    }
    if (String(signal.signal_id || '') === String(order.from_signal_id || '')) {
      kept.push(order);
      continue;
    }
    const closedContext = {
      side: order.from_side,
      score: order.closed_position_score,
      forecast_edge_factor: order.closed_position_forecast_edge_factor,
      unrealized_pnl_usd: 0,
    };
    const reverseGate = cryptoPropertyGate(signal, state, 'reverse', closedContext);
    const openReason = canOpenCryptoTestnetPosition(signal, state);
    if (!reverseGate.ok || openReason) {
      await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
        ts: energyIso(),
        event: 'PENDING_REVERSE_BLOCKED',
        signal_id: signal.signal_id,
        symbol,
        asset_class: signal.asset_class,
        route: signal.route,
        side: targetSide,
        action: signal.action,
        price: signal.price,
        trade_value_usd: 0,
        net_pnl_usd: 0,
        score: signal.score,
        confidence: signal.confidence,
        source: signal.source,
        reason: openReason || `反手二次确认未通过：${reverseGate.reason}`,
      });
      continue;
    }
    await openCryptoTestnetPosition(env, state, signal, credentials);
    await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
      ts: energyIso(),
      event: 'PENDING_REVERSE_EXECUTED',
      signal_id: signal.signal_id,
      symbol,
      asset_class: signal.asset_class,
      route: signal.route,
      side: targetSide,
      action: signal.action,
      price: signal.price,
      trade_value_usd: 0,
      net_pnl_usd: 0,
      score: signal.score,
      confidence: signal.confidence,
      source: signal.source,
      reason: '下一 tick 仍确认反手，执行新方向开仓。',
    });
    opened += 1;
  }
  state.pending_reverse_orders = kept;
  return opened;
}

function cryptoPositionPolicyExitReason(pos: any) {
  if (String(pos.side || '') === 'short' && !cryptoShortRouteIsPromoted(String(pos.symbol || ''))) {
    return '做空路线未盲测晋级，V3.6 策略迁移退出主账本持仓';
  }
  return '';
}

function cryptoAdaptiveSizing(signal: any, state: any) {
  const cfg = state.config || {};
  const cap = Math.max(Number(cfg.fixed_trade_usd || 1_000), 1);
  const equity = Math.max(Number(state.equity_usd || state.initial_cash_usd || 0), 0);
  const maxOpen = Math.max(Number(cfg.max_open_positions || 4), 1);
  const maxSymbol = Math.max(Number(cfg.max_symbol_positions || 1), 1);
  const globalBudget = cap * maxOpen;
  const symbolBudget = cap * maxSymbol;
  const remainingGlobal = Math.max(0, globalBudget - cryptoOpenNotional(state));
  const remainingSymbol = Math.max(0, symbolBudget - cryptoOpenNotional(state, signal.symbol));
  const cashBudget = Math.max(0, equity * Number(cfg.max_position_pct || 0.04));
  const hardCap = Math.max(0, Math.min(cap, remainingGlobal, remainingSymbol, cashBudget || cap));

  if (cfg.adaptive_sizing === false) {
    return {
      notional_usd: Number(hardCap.toFixed(2)),
      sizing_mode: 'fixed_cap',
      sizing_reason: '按用户单笔最高金额执行；仍受全局/单币/权益上限约束。',
      score_edge: 0,
      confidence_factor: 1,
      forecast_edge_factor: FORECAST_EDGE_GATE_PROMOTED ? cryptoClamp(Number(signal.forecast_edge_gate?.position_multiplier || signal.position_multiplier || 0), 0, 1.65) : 1,
      liquidity_factor: 1,
      risk_factor: 1,
      remaining_global_usd: Number(remainingGlobal.toFixed(2)),
      remaining_symbol_usd: Number(remainingSymbol.toFixed(2)),
    };
  }

  const threshold = cryptoSizingThreshold(signal, cfg);
  const score = Number(signal.score || 0);
  const edge = cryptoClamp((score - threshold) / Math.max(0.18, threshold), 0, 1.25);
  const confidence = cryptoClamp(Number(signal.confidence || 0.5), 0, 0.99);
  const confidenceFactor = cryptoClamp(0.28 + edge * 0.48 + confidence * 0.28, 0.22, 1);
  const spreadBps = Math.max(Number(signal.spread_bps || 0), 0);
  const spreadFactor = cryptoClamp(1 - spreadBps / 35, 0.35, 1);
  const realizedVol = Math.max(Number(signal.realized_vol || 0.004), 0.0015);
  const riskFactor = cryptoClamp(0.018 / realizedVol, 0.38, 1.15);
  const depthUsd = signal.side === 'short' ? Number(signal.bid_depth_usd || 0) : Number(signal.ask_depth_usd || 0);
  const liquidityFactor = depthUsd > 0
    ? cryptoClamp(depthUsd / Math.max(cap * 12, 1), 0.35, 1)
    : signal.asset_class === 'crypto_perp' ? 0.55 : 0.72;
  const shortFactor = signal.side === 'short' && signal.validated_side_policy !== 'both' ? 0.72 : 1;
  const forecastEdgeFactor = FORECAST_EDGE_GATE_PROMOTED ? cryptoClamp(Number(signal.forecast_edge_gate?.position_multiplier || signal.position_multiplier || 1), 0.25, 1.65) : 1;
  const raw = cap * confidenceFactor * spreadFactor * riskFactor * liquidityFactor * shortFactor * forecastEdgeFactor;
  const minUseful = Math.min(cap, Math.max(25, cap * 0.18));
  const notional = hardCap < minUseful ? 0 : Math.min(hardCap, Math.max(minUseful, raw));
  const reasonParts = [
    `score_edge=${edge.toFixed(2)}`,
    `confidence=${confidenceFactor.toFixed(2)}`,
    `forecast_edge=${forecastEdgeFactor.toFixed(2)}`,
    `liquidity=${liquidityFactor.toFixed(2)}`,
    `risk=${riskFactor.toFixed(2)}`,
  ];
  if (shortFactor < 1) reasonParts.push('short_forward_shadow_discount');
  return {
    notional_usd: Number(notional.toFixed(2)),
    sizing_mode: 'energy_style_adaptive_cap',
    sizing_reason: `能源模型式自适应仓位：${reasonParts.join(' · ')}`,
    score_edge: Number(edge.toFixed(4)),
    confidence_factor: Number(confidenceFactor.toFixed(4)),
    forecast_edge_factor: Number(forecastEdgeFactor.toFixed(4)),
    liquidity_factor: Number(liquidityFactor.toFixed(4)),
    spread_factor: Number(spreadFactor.toFixed(4)),
    risk_factor: Number(riskFactor.toFixed(4)),
    remaining_global_usd: Number(remainingGlobal.toFixed(2)),
    remaining_symbol_usd: Number(remainingSymbol.toFixed(2)),
  };
}

function canOpenCryptoTestnetPosition(signal: any, state: any) {
  const cfg = state.config || {};
  if (state.mode !== 'running') return 'AI未运行';
  if (!signal.is_real_market_data) return '没有真实公共行情，禁止开仓';
  if (signal.route_status && signal.route_status !== 'main') return '该路线仅旁路观察，不接主前向账本';
  if (!['BUY_LONG', 'SELL_SHORT'].includes(String(signal.action || ''))) return '信号未达线上模拟交易标准';
  if (signal.action === 'SELL_SHORT' && (cfg.allow_short === false || cfg.side_policy === 'long_only')) return '加密做空未启用';
  if (signal.action === 'BUY_LONG' && cfg.side_policy === 'short_only') return '加密做多未启用';
  if (Number(signal.score || 0) < Number(cfg.min_signal_score || 0.66)) return '加密稳定分数不足';
  const propertyGate = cryptoPropertyGate(signal, state, 'open');
  if (!propertyGate.ok) return propertyGate.reason;
  if ((state.open_positions || []).length >= Number(cfg.max_open_positions || 4)) return '达到最大持仓数';
  const sameSymbol = (state.open_positions || []).filter((pos: any) => pos.symbol === signal.symbol).length;
  if (sameSymbol >= Number(cfg.max_symbol_positions || 1)) return '单币种持仓数已满';
  const sizing = cryptoAdaptiveSizing(signal, state);
  if (Number(sizing.notional_usd || 0) <= 0) return '自适应仓位预算不足';
  if ((state.seen_signal_ids || []).includes(String(signal.signal_id))) return '本轮加密信号已处理';
  return '';
}

async function openCryptoTestnetPosition(env: Env, state: any, signal: any, credentials?: BinanceTestnetCredentials | null) {
  const cfg = state.config || {};
  const sizing = cryptoAdaptiveSizing(signal, state);
  const notional = Number(sizing.notional_usd || 0);
  if (notional <= 0) throw new Error('自适应仓位预算不足，未开仓');
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
    base_trade_cap_usd: Number(cfg.fixed_trade_usd || 1_000),
    adaptive_sizing: cfg.adaptive_sizing !== false,
    sizing_mode: sizing.sizing_mode,
    sizing_reason: sizing.sizing_reason,
    score_edge: sizing.score_edge,
    confidence_factor: sizing.confidence_factor,
    forecast_edge_factor: sizing.forecast_edge_factor,
    forecast_edge_pct: Number(signal.forecast_edge_gate?.forecast_edge_pct || 0),
    forecast_edge_gate: signal.forecast_edge_gate || null,
    position_controller_version: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
    position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
    liquidity_factor: sizing.liquidity_factor,
    spread_factor: sizing.spread_factor,
    risk_factor: sizing.risk_factor,
    remaining_global_usd_at_entry: sizing.remaining_global_usd,
    remaining_symbol_usd_at_entry: sizing.remaining_symbol_usd,
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
    sizing_mode: sizing.sizing_mode,
    sizing_reason: sizing.sizing_reason,
    score_edge: sizing.score_edge,
    confidence_factor: sizing.confidence_factor,
    forecast_edge_factor: sizing.forecast_edge_factor,
    forecast_edge_pct: Number(signal.forecast_edge_gate?.forecast_edge_pct || 0),
    position_controller_version: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
    liquidity_factor: sizing.liquidity_factor,
    risk_factor: sizing.risk_factor,
    source: signal.source,
    exchange_order_id: exchangeOrder?.orderId || null,
    execution_mode: pos.execution_mode,
    reason: signal.exchange_tradeable
      ? (side === 'short' ? 'V3.1 短波动路线做空前向验证开仓' : 'V3.1 短波动路线按实时行情达标做多开仓')
      : signal.asset_class === 'single_stock'
        ? 'Stock V1.4 股票线上模拟交易按真实行情达标开仓，不发送券商订单'
        : 'ETF 通过路线只写线上模拟账本，不发送交易所订单',
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

async function addCryptoTestnetPosition(env: Env, state: any, pos: any, signal: any, credentials?: BinanceTestnetCredentials | null) {
  const cfg = state.config || {};
  const sizing = cryptoAdaptiveSizing(signal, state);
  const notional = Number(sizing.notional_usd || 0);
  if (notional <= 0) return null;

  const side = signal.action === 'SELL_SHORT' ? 'short' : 'long';
  const fillPrice = side === 'short'
    ? Number(signal.bid_price || signal.price)
    : Number(signal.ask_price || signal.price);
  const addQty = notional / Math.max(fillPrice, 0.0001);
  const oldQty = Math.abs(Number(pos.quantity || 0));
  const oldNotional = Math.abs(Number(pos.notional_usd || pos.trade_value_usd || 0));
  const fee = notional * CRYPTO_TESTNET_FEE_RATE;
  let exchangeOrder: any = null;
  const canSendExchangeOrder = cfg.order_execution === 'binance_testnet' && cryptoRouteIsExchangeTradeable(signal.symbol);
  if (canSendExchangeOrder) {
    exchangeOrder = await binanceTestnetMarketOrder(env, {
      symbol: signal.symbol,
      side: side === 'short' ? 'SELL' : 'BUY',
      quantity: addQty,
      reduceOnly: false,
      clientOrderId: `hfcd_add_${Date.now()}_${signal.symbol}`,
    }, credentials);
  }

  const totalQty = oldQty + addQty;
  const totalNotional = oldNotional + notional;
  pos.quantity = totalQty;
  pos.notional_usd = Number(totalNotional.toFixed(2));
  pos.entry_price = Number(((Number(pos.entry_price || fillPrice) * oldQty + fillPrice * addQty) / Math.max(totalQty, 0.0000001)).toFixed(cryptoRoutePriceDigits(signal.symbol)));
  pos.last_price = signal.price;
  pos.estimated_fee_usd = Number((Number(pos.estimated_fee_usd || 0) + fee).toFixed(4));
  pos.stop_loss_usd = Number((totalNotional * Number(cfg.stop_loss_pct || 0.018)).toFixed(2));
  pos.take_profit_usd = Number((totalNotional * Number(cfg.take_profit_pct || 0.036)).toFixed(2));
  pos.score = Math.max(Number(pos.score || 0), Number(signal.score || 0));
  pos.confidence = Math.max(Number(pos.confidence || 0), Number(signal.confidence || 0));
  pos.forecast_edge_factor = Math.max(Number(pos.forecast_edge_factor || 0), Number(sizing.forecast_edge_factor || 0));
  pos.forecast_edge_pct = Math.max(Number(pos.forecast_edge_pct || 0), Number(signal.forecast_edge_gate?.forecast_edge_pct || 0));
  pos.forecast_edge_gate = signal.forecast_edge_gate || pos.forecast_edge_gate || null;
  pos.position_controller_version = HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION;
  pos.position_controller_rule = HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE;
  pos.last_signal_id = signal.signal_id;
  pos.last_scaled_at = energyIso();
  pos.scale_in_count = Number(pos.scale_in_count || 0) + 1;

  const trade = {
    ts: energyIso(),
    event: 'ADD',
    position_id: pos.position_id,
    signal_id: signal.signal_id,
    symbol: signal.symbol,
    asset_class: signal.asset_class,
    route: signal.route,
    side,
    action: signal.action,
    price: fillPrice,
    quantity: addQty,
    trade_value_usd: notional,
    net_pnl_usd: 0,
    score: signal.score,
    confidence: signal.confidence,
    sizing_mode: sizing.sizing_mode,
    sizing_reason: sizing.sizing_reason,
    score_edge: sizing.score_edge,
    confidence_factor: sizing.confidence_factor,
    forecast_edge_factor: sizing.forecast_edge_factor,
    forecast_edge_pct: Number(signal.forecast_edge_gate?.forecast_edge_pct || 0),
    position_controller_version: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
    liquidity_factor: sizing.liquidity_factor,
    risk_factor: sizing.risk_factor,
    source: signal.source,
    exchange_order_id: exchangeOrder?.orderId || null,
    execution_mode: pos.execution_mode || (canSendExchangeOrder ? 'binance_testnet' : 'paper'),
    reason: '同向信号增强，按能源模型式仓位控制加仓',
  };
  await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, trade);
  return trade;
}

async function reduceCryptoTestnetPosition(env: Env, state: any, pos: any, signal: any, ratio: number, reason: string, credentials?: BinanceTestnetCredentials | null) {
  const currentQty = Math.abs(Number(pos.quantity || 0));
  if (currentQty <= 0) return null;
  const reduceQty = Math.min(currentQty, currentQty * Math.max(0, Math.min(1, ratio)));
  if (reduceQty <= 0) return null;
  const exitPrice = pos.side === 'short'
    ? Number(signal?.ask_price || signal?.price || pos.last_price || pos.entry_price)
    : Number(signal?.bid_price || signal?.price || pos.last_price || pos.entry_price);
  const share = reduceQty / Math.max(currentQty, 0.0000001);
  const gross = cryptoTestnetPositionPnl({ ...pos, quantity: reduceQty }, exitPrice);
  const entryFeeShare = Number(pos.estimated_fee_usd || 0) * share;
  const exitFee = Math.abs(exitPrice * reduceQty) * CRYPTO_TESTNET_FEE_RATE;
  const net = gross - entryFeeShare - exitFee;
  let exchangeOrder: any = null;
  if (pos.execution_mode === 'binance_testnet' && cryptoRouteIsExchangeTradeable(pos.symbol)) {
    exchangeOrder = await binanceTestnetMarketOrder(env, {
      symbol: pos.symbol,
      side: pos.side === 'short' ? 'BUY' : 'SELL',
      quantity: reduceQty,
      reduceOnly: true,
      clientOrderId: `hfcd_reduce_${Date.now()}_${pos.symbol}`,
    }, credentials);
  }

  state.realized_pnl_usd = Number((Number(state.realized_pnl_usd || 0) + net).toFixed(2));
  const remainingQty = currentQty - reduceQty;
  const remainingNotional = Number(pos.notional_usd || 0) * (remainingQty / Math.max(currentQty, 0.0000001));
  pos.quantity = remainingQty;
  pos.notional_usd = Number(remainingNotional.toFixed(2));
  pos.estimated_fee_usd = Number((Number(pos.estimated_fee_usd || 0) - entryFeeShare).toFixed(4));
  pos.stop_loss_usd = Number((remainingNotional * Number(state.config?.stop_loss_pct || 0.018)).toFixed(2));
  pos.take_profit_usd = Number((remainingNotional * Number(state.config?.take_profit_pct || 0.036)).toFixed(2));
  pos.last_price = signal?.price || exitPrice;
  pos.last_reduced_at = energyIso();
  pos.reduce_count = Number(pos.reduce_count || 0) + 1;

  const trade = {
    ts: energyIso(),
    event: 'REDUCE',
    position_id: pos.position_id,
    signal_id: signal?.signal_id || pos.signal_id,
    symbol: pos.symbol,
    asset_class: pos.asset_class,
    route: pos.route,
    side: pos.side,
    action: pos.side === 'short' ? 'BUY_TO_COVER' : 'SELL_TO_CLOSE',
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    quantity: reduceQty,
    trade_value_usd: Math.abs(exitPrice * reduceQty),
    gross_pnl_usd: Number(gross.toFixed(2)),
    cost_usd: Number((entryFeeShare + exitFee).toFixed(2)),
    net_pnl_usd: Number(net.toFixed(2)),
    score: signal?.score ?? pos.score,
    confidence: signal?.confidence ?? pos.confidence,
    source: signal?.source || pos.source,
    exchange_order_id: exchangeOrder?.orderId || null,
    execution_mode: pos.execution_mode || state.config?.order_execution || 'paper',
    reason,
  };
  await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, trade);
  return trade;
}

async function enforceCryptoPositionLimits(env: Env, state: any, signals: any[], credentials?: BinanceTestnetCredentials | null) {
  const maxOpen = Math.max(Number(state.config?.max_open_positions || 4), 0);
  const maxSymbol = Math.max(Number(state.config?.max_symbol_positions || 1), 0);
  const sorted = [...(state.open_positions || [])].sort((a, b) => new Date(String(b.opened_at || 0)).getTime() - new Date(String(a.opened_at || 0)).getTime());
  const keep: any[] = [];
  const symbolCounts = new Map<string, number>();
  let closed = 0;
  for (const pos of sorted) {
    const symbol = String(pos.symbol || '');
    const symbolCount = symbolCounts.get(symbol) || 0;
    const shouldKeep = keep.length < maxOpen && symbolCount < maxSymbol;
    if (shouldKeep) {
      keep.push(pos);
      symbolCounts.set(symbol, symbolCount + 1);
    } else {
      const signal = signals.find((row: any) => row.symbol === pos.symbol);
      await closeCryptoTestnetPosition(env, state, pos, signal, '用户风险上限收缩，超额持仓自动平仓', credentials);
      closed += 1;
    }
  }
  state.open_positions = keep.sort((a, b) => new Date(String(a.opened_at || 0)).getTime() - new Date(String(b.opened_at || 0)).getTime());
  return closed;
}

async function cryptoTestnetTickInternal(env: Env, state: any, forceClose = false, credentials?: BinanceTestnetCredentials | null) {
  const snapshot = await buildCryptoTestnetSnapshot(Number(state.config?.min_signal_score || 0.66), state.config?.asset_scope || 'all');
  state.last_market_snapshot = {
    generated_at: snapshot.generated_at,
    source_status: snapshot.source_status,
    order_mode: snapshot.order_mode,
    main_side_policy: snapshot.main_side_policy,
    route_set: snapshot.route_set,
    stock_sensor_status: snapshot.stock_sensor_status,
    selected_routes: snapshot.selected_routes,
    signals: snapshot.signals,
    sensors: snapshot.sensors,
  };
  const signals = snapshot.signals || [];
  const remaining: any[] = [];
  let opened = 0;
  let closed = 0;
  let adjusted = 0;
  const closedSymbolsThisTick = new Set<string>();
  for (const signal of signals) {
    const auditSignalKey = `${signal.signal_id}:SIGNAL`;
    if (!(state.seen_audit_signal_ids || []).includes(auditSignalKey)) {
      await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
        ts: energyIso(),
        event: 'SIGNAL',
        signal_id: signal.signal_id,
        symbol: signal.symbol,
        asset_class: signal.asset_class,
        route: signal.route,
        side: signal.side,
        action: signal.action,
        price: signal.price,
        trade_value_usd: 0,
        net_pnl_usd: 0,
        score: signal.score,
        confidence: signal.confidence,
        source: signal.source,
        reason: signal.action === 'NO_TRADE' ? (signal.reject_reason || '前向信号未达门槛') : '前向信号快照：等待仓位控制器判定开仓/加仓/减仓/反手',
      });
      state.seen_audit_signal_ids = [...(state.seen_audit_signal_ids || []), auditSignalKey].slice(-500);
    }
  }
  for (const pos of state.open_positions || []) {
    const signal = signals.find((row: any) => row.symbol === pos.symbol);
    const price = Number(signal?.price || pos.last_price || pos.entry_price);
    const pnl = cryptoTestnetPositionPnl(pos, price) - Number(pos.estimated_fee_usd || 0);
    const policyExitReason = cryptoPositionPolicyExitReason(pos);
    if (policyExitReason) {
      try {
        await closeCryptoTestnetPosition(env, state, pos, signal, policyExitReason, credentials);
        closed += 1;
        closedSymbolsThisTick.add(String(pos.symbol || ''));
      } catch (error) {
        remaining.push({
          ...pos,
          last_price: price,
          unrealized_pnl_usd: Number(pnl.toFixed(2)),
          last_error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    const due = forceClose || new Date(pos.target_exit_at).getTime() <= Date.now();
    if (due || pnl >= Number(pos.take_profit_usd || 0) || pnl <= -Number(pos.stop_loss_usd || 0)) {
      const reason = due ? '到期/停止结算' : pnl > 0 ? '止盈结算' : '止损结算';
      try {
        await closeCryptoTestnetPosition(env, state, pos, signal, reason, credentials);
        closed += 1;
        closedSymbolsThisTick.add(String(pos.symbol || ''));
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
  closed += await enforceCryptoPositionLimits(env, state, signals, credentials);
  markCryptoTestnetEquity(state, signals);
  if (!forceClose && state.mode === 'running') {
    opened += await processCryptoTestnetPendingReverse(env, state, signals, credentials, closedSymbolsThisTick);
    const candidates = [...signals].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    for (const signal of candidates) {
      const targetSide = signal.action === 'BUY_LONG' ? 'long' : signal.action === 'SELL_SHORT' ? 'short' : '-';
      if (targetSide !== '-' && closedSymbolsThisTick.has(String(signal.symbol || ''))) {
        await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
          ts: energyIso(),
          event: 'SKIP',
          signal_id: signal.signal_id,
          symbol: signal.symbol,
          asset_class: signal.asset_class,
          route: signal.route,
          side: targetSide,
          action: signal.action,
          price: signal.price,
          trade_value_usd: 0,
          net_pnl_usd: 0,
          score: signal.score,
          confidence: signal.confidence,
          source: signal.source,
          reason: '本 tick 刚平仓，禁止同 tick 重开或反手，等待下一 tick 重新确认。',
        });
        if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
          state.seen_signal_ids.push(String(signal.signal_id));
        }
        continue;
      }
      const existing = (state.open_positions || []).find((pos: any) => pos.symbol === signal.symbol);
      if (existing && targetSide !== '-') {
        if (existing.side === targetSide) {
          const threshold = cryptoSizingThreshold(signal, state.config || {});
          const strongerSignal = Number(signal.score || 0) >= Math.max(threshold + 0.05, Number(existing.score || 0) + 0.08);
          const addGate = cryptoPropertyGate(signal, state, 'add', existing);
          if (state.config?.allow_scale_in !== false && strongerSignal && addGate.ok) {
            try {
              const add = await addCryptoTestnetPosition(env, state, existing, signal, credentials);
              if (add) {
                adjusted += 1;
                if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
                  state.seen_signal_ids.push(String(signal.signal_id));
                }
                continue;
              }
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
                reason: error instanceof Error ? `加仓失败：${error.message}` : '加仓失败',
              });
              state.seen_signal_ids.push(String(signal.signal_id));
              continue;
            }
          }
          await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
            ts: energyIso(),
            event: 'HOLD',
            signal_id: signal.signal_id,
            symbol: signal.symbol,
            asset_class: signal.asset_class,
            route: signal.route,
            side: existing.side,
            action: signal.action,
            price: signal.price,
            trade_value_usd: Number(existing.notional_usd || 0),
            net_pnl_usd: 0,
            paper_pnl_usd: Number(existing.unrealized_pnl_usd || 0),
            score: signal.score,
            confidence: signal.confidence,
            source: signal.source,
            reason: strongerSignal && !addGate.ok
              ? `同向信号增强但未加仓：${addGate.reason}`
              : strongerSignal ? '同向信号增强但剩余仓位预算不足，继续持有' : '同向信号存在，继续持有，不重复开仓',
          });
          if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
            state.seen_signal_ids.push(String(signal.signal_id));
          }
          continue;
        }

        if (state.config?.allow_reverse !== false && ['BUY_LONG', 'SELL_SHORT'].includes(String(signal.action || ''))) {
          const reverseGate = cryptoPropertyGate(signal, state, 'reverse', existing);
          if (!reverseGate.ok) {
            if (state.config?.allow_reduce !== false && Number(existing.unrealized_pnl_usd || 0) < 0 && !String(existing.last_reduced_signal_id || '').includes(String(signal.signal_id))) {
              const reduced = await reduceCryptoTestnetPosition(env, state, existing, signal, 0.35, `反向信号未通过物性确认，仅减仓保护：${reverseGate.reason}`, credentials);
              if (reduced) {
                existing.last_reduced_signal_id = signal.signal_id;
                if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
                  state.seen_signal_ids.push(String(signal.signal_id));
                }
                adjusted += 1;
                continue;
              }
            }
            await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
              ts: energyIso(),
              event: 'SKIP',
              signal_id: signal.signal_id,
              symbol: signal.symbol,
              asset_class: signal.asset_class,
              route: signal.route,
              side: existing.side,
              action: signal.action,
              price: signal.price,
              trade_value_usd: Number(existing.notional_usd || 0),
              net_pnl_usd: 0,
              paper_pnl_usd: Number(existing.unrealized_pnl_usd || 0),
              score: signal.score,
              confidence: signal.confidence,
              source: signal.source,
              reason: `反向信号未通过物性确认，不反手：${reverseGate.reason}`,
            });
            if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
              state.seen_signal_ids.push(String(signal.signal_id));
            }
            continue;
          }
          try {
            await closeCryptoTestnetPosition(env, state, existing, signal, '反向信号确认，平仓准备反手', credentials);
            state.open_positions = (state.open_positions || []).filter((pos: any) => pos.position_id !== existing.position_id);
            closed += 1;
            closedSymbolsThisTick.add(String(existing.symbol || signal.symbol || ''));
            const pendingReverse = queueCryptoTestnetPendingReverse(state, signal, existing);
            await insertCryptoTestnetTrade(env, state.display_user_id || state.user_id, {
              ts: energyIso(),
              event: 'PENDING_REVERSE_QUEUED',
              signal_id: signal.signal_id,
              symbol: signal.symbol,
              asset_class: signal.asset_class,
              route: signal.route,
              side: targetSide,
              action: signal.action,
              price: signal.price,
              trade_value_usd: 0,
              net_pnl_usd: 0,
              score: signal.score,
              confidence: signal.confidence,
              source: signal.source,
              pending_reverse_order_id: pendingReverse?.order_id || '',
              reason: `反向信号触发：${existing.side === 'long' ? '多转空' : '空转多'}；已先平旧仓，禁止同 tick 反手，等待下一 tick 第二次确认。`,
            });
            if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
              state.seen_signal_ids.push(String(signal.signal_id));
            }
            continue;
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
              reason: error instanceof Error ? `反手前平仓失败：${error.message}` : '反手前平仓失败',
            });
            state.seen_signal_ids.push(String(signal.signal_id));
            continue;
          }
        }
      }

      if (existing && signal.action === 'NO_TRADE' && state.config?.allow_reduce !== false) {
        const threshold = cryptoSizingThreshold(signal, state.config || {});
        const weakSignal = Number(signal.score || 0) < threshold * 0.6;
        if (weakSignal && Number(existing.unrealized_pnl_usd || 0) < 0 && !String(existing.last_reduced_signal_id || '').includes(String(signal.signal_id))) {
          const reduced = await reduceCryptoTestnetPosition(env, state, existing, signal, 0.35, '同标的信号弱化且持仓浮亏，减仓保护', credentials);
          if (reduced) {
            existing.last_reduced_signal_id = signal.signal_id;
            if (!(state.seen_signal_ids || []).includes(String(signal.signal_id))) {
              state.seen_signal_ids.push(String(signal.signal_id));
            }
            adjusted += 1;
            continue;
          }
        }
      }

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
  return { snapshot, opened, closed, adjusted };
}

function cryptoTestnetWinRate(state: any) {
  const trades = (state.closed_trades || []).filter((row: any) => Number.isFinite(Number(row.net_pnl_usd)));
  if (!trades.length) return 0;
  return trades.filter((row: any) => Number(row.net_pnl_usd || 0) > 0).length / trades.length;
}

async function cryptoTestnetDashboard(request: Request, env: Env, url: URL) {
  const userId = cryptoTestnetUserId(request, url);
  const state = await loadCryptoTestnetAccount(env, userId);
  const requestedScope = url.searchParams.get('asset_scope');
  if (requestedScope) {
    state.config = normalizeCryptoTestnetConfig({
      ...(state.config || {}),
      asset_scope: requestedScope,
      ...(requestedScope === 'stock' ? {
        order_execution: 'paper',
        side_policy: 'both',
        allow_short: true,
        max_open_positions: 3,
        max_symbol_positions: 1,
        min_signal_score: state.config?.min_signal_score || 0.60,
        max_holding_minutes: state.config?.max_holding_minutes || 120,
      } : {}),
    });
  }
  const snapshot = cryptoTestnetDashboardSnapshot(state);
  markCryptoTestnetEquity(state, snapshot.signals);
  const trades = await recentCryptoTestnetTrades(env, userId, 180);
  const privateControl = hasPrivateTradingControl(request, env);
  const testnetCredentials = binanceTestnetCredentialsForRequest(request, env);
  const dashboardAssetScope = String(state.config?.asset_scope || 'all');
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
      realtime_source: dashboardAssetScope === 'stock' ? 'Yahoo Finance public chart for MSFT/TSLA/AAPL/SPY/QQQ/XLK/VIX' : 'Binance USD-M Futures public endpoints + Yahoo Finance public chart',
      note: dashboardAssetScope === 'stock'
        ? '当前执行模式为股票线上模拟交易：MSFT 1h 做多、AAPL 1h 做多、TSLA 15m 做空，只写 longone D1 模拟账本，不向券商下单。'
        : state.config?.order_execution === 'binance_testnet'
        ? '当前执行模式为 Binance Futures Demo/Testnet；仅 BTCUSDT/SOLUSDT 会向 demo-fapi.binance.com 发测试网订单，SPY/QQQ/IWM/MSFT/AAPL/TSLA 只写线上模拟账本。'
        : '当前执行模式为 longone D1 线上模拟交易，只写模拟账本，不向交易所或券商发真实订单。',
    },
    history_policy: {
      user_id: userId,
      storage_user_id: cryptoTestnetStorageUserId(userId),
      browser_storage_key: 'hfcd_crypto_testnet_user_id',
      ledger_source: 'longone online Worker/D1 market_accounts + market_trades',
      storage: 'D1 market_accounts + market_trades',
      scope: state.config?.asset_scope === 'stock' ? 'per_browser_user_stock_only' : state.config?.asset_scope === 'non_stock' ? 'per_browser_user_crypto_etf_only' : 'per_browser_user',
      recent_trade_limit: 180,
      records: 'signals/skips/open/close/add/reduce/reverse/hold with paper PnL',
      position_controller: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
      position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
      pending_reverse_rule: '强反向先平旧仓并排队；下一 tick 第二次确认仍同向且通过物性/预测边际门，才允许开反向仓。',
      pending_reverse_orders: (state.pending_reverse_orders || []).slice(0, 20),
      forecast_edge_gate: FORECAST_EDGE_GATE_PROMOTED ? 'promoted_blocking_gate' : 'shadow_audit_only',
      stock_route: dashboardAssetScope === 'stock' ? 'MSFT 1h 做多 + AAPL 1h 做多 + TSLA 15m 做空线上模拟交易' : '股票路线在独立股票分区运行',
    },
    ledger: {
      source: 'longone online Worker/D1',
      user_id: userId,
      storage_user_id: cryptoTestnetStorageUserId(userId),
      browser_storage_key: 'hfcd_crypto_testnet_user_id',
      asset_scope: state.config?.asset_scope || 'all',
      scheduler_enabled: Boolean(state.scheduler?.enabled),
      scheduler_cadence: state.scheduler?.cadence || '',
      scheduler_last_tick_at: state.scheduler?.last_cron_tick_at || '',
      scheduler_last_market_latest_at: state.scheduler?.last_cron_market_latest_at || '',
      scheduler_last_stock_action: state.scheduler?.last_cron_stock_action || state.scheduler?.last_cron_msft_action || '',
      stock_online_paper_route: 'MSFT 1h long + AAPL 1h long + TSLA 15m short',
      position_controller: HFCD_UNIVERSAL_POSITION_CONTROLLER_VERSION,
      position_controller_rule: HFCD_UNIVERSAL_POSITION_CONTROLLER_RULE,
      pending_reverse_orders: (state.pending_reverse_orders || []).slice(0, 20),
      forecast_edge_gate: FORECAST_EDGE_GATE_PROMOTED ? 'promoted_blocking_gate' : 'shadow_audit_only',
    },
    market_health: {
      ok: snapshot.source_status === 'public_realtime_mixed_binance_yahoo',
      status: snapshot.source_status,
      latest_captured_at: snapshot.generated_at,
      symbols: CRYPTO_TESTNET_SYMBOLS.map((row) => row.symbol),
      selected_routes: snapshot.selected_routes,
      stock_sensor_status: snapshot.stock_sensor_status,
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
      scheduler: state.scheduler || {},
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
  const scopedBody = cryptoScopedRequestBody(url, body, existing.config || {});
  const state = body?.reset_account || isFresh ? defaultCryptoTestnetAccount(userId, scopedBody) : existing;
  state.display_user_id = userId;
  state.config = mergeCryptoTestnetConfig(state, scopedBody);
  if (state.config.order_execution === 'binance_testnet') {
    if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
    binanceTestnetAssertConfigured(env, binanceTestnetCredentialsForRequest(request, env));
  }
  if (scopedBody.capital_usd && isFresh) {
    state.initial_cash_usd = Number(scopedBody.capital_usd);
    state.realized_pnl_usd = 0;
    state.equity_usd = Number(scopedBody.capital_usd);
    state.peak_equity_usd = Number(scopedBody.capital_usd);
  }
  state.mode = 'running';
  state.started_at = state.started_at || energyIso();
  state.stopped_at = '';
  const result = await cryptoTestnetTickInternal(env, state, false, binanceTestnetCredentialsForRequest(request, env));
  state.last_tick_at = energyIso();
  await saveCryptoTestnetAccount(env, state);
  return json({ ok: true, action: 'started', user_id: userId, result, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cryptoTestnetConfig(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const state = await loadCryptoTestnetAccount(env, userId, body);
  const scopedBody = cryptoScopedRequestBody(url, body, state.config || {});
  state.display_user_id = userId;
  state.config = {
    ...mergeCryptoTestnetConfig(state, scopedBody),
    updated_at: energyIso(),
  };
  if (state.config?.order_execution === 'binance_testnet') {
    if (!hasPrivateTradingControl(request, env)) return privateTradingControlLockedJson();
  }
  state.last_config_updated_at = energyIso();
  await saveCryptoTestnetAccount(env, state);
  return json({ ok: true, action: 'config_updated', user_id: userId, account: state }, { headers: { 'Cache-Control': 'no-store' } });
}

async function cryptoTestnetTick(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const state = await loadCryptoTestnetAccount(env, userId, body);
  const scopedBody = cryptoScopedRequestBody(url, body, state.config || {});
  state.config = mergeCryptoTestnetConfig(state, scopedBody);
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

async function cryptoTestnetReset(request: Request, env: Env, url: URL) {
  const body = await request.json().catch(() => ({}));
  const userId = cryptoTestnetUserId(request, url, body);
  const scopedBody = cryptoScopedRequestBody(url, body, {});
  const state: any = defaultCryptoTestnetAccount(userId, {
    ...scopedBody,
    order_execution: 'paper',
  });
  state.mode = 'stopped';
  state.started_at = '';
  state.stopped_at = energyIso();
  state.last_tick_at = '';
  state.last_market_snapshot = null;
  state.scheduler = {};
  await clearMarketTrades(env, cryptoTestnetStorageUserId(userId));
  await saveCryptoTestnetAccount(env, state);
  return json(
    {
      ok: true,
      action: 'reset',
      user_id: userId,
      ledger: {
        source: env.ENERGY_TRADING_DB ? 'longone_worker_d1' : 'worker_default_no_d1',
        user_id: userId,
        storage_user_id: cryptoTestnetStorageUserId(userId),
        user_id_suffix: userId.slice(-10),
        asset_scope: state.config?.asset_scope || 'all',
      },
      account: state,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function runCryptoTestnetScheduledTick(env: Env) {
  const startedAt = energyIso();
  const db = await ensureMarketTradingDb(env);
  if (!db) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: energyIso(),
      checked_accounts: 0,
      ticked_accounts: 0,
      error: 'market D1 database not configured',
    };
  }

  const result = await db
    .prepare("SELECT user_id, state_json FROM market_accounts WHERE user_id LIKE 'crypto_testnet_%' ORDER BY updated_at DESC LIMIT 160")
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const outcomes: any[] = [];
  let ticked = 0;

  for (const row of rows) {
    const storageId = String(row.user_id || '');
    try {
      const raw = JSON.parse(String(row.state_json || '{}'));
      const displayUserId = String(raw.display_user_id || storageId.replace(/^crypto_testnet_/, '') || storageId);
      const state = normalizeCryptoTestnetAccount(raw, displayUserId);
      if (state.mode !== 'running') {
        outcomes.push({ user_id_suffix: displayUserId.slice(-10), mode: state.mode || 'unknown', action: 'skip_not_running' });
        continue;
      }

      state.config = normalizeCryptoTestnetConfig({
        ...(state.config || {}),
        // Cron is a safe online paper recorder. It never sends signed exchange orders.
        order_execution: 'paper',
      });
      const tick = await cryptoTestnetTickInternal(env, state, false, null);
      const latestState = await loadCryptoTestnetAccount(env, displayUserId, {
        asset_scope: state.config?.asset_scope || 'all',
      });
      if (latestState.mode !== 'running') {
        outcomes.push({
          user_id_suffix: displayUserId.slice(-10),
          asset_scope: state.config?.asset_scope || 'all',
          mode: latestState.mode || 'unknown',
          action: 'skip_stopped_during_scheduled_tick',
        });
        continue;
      }
      state.last_tick_at = energyIso();
      const msftSignal = (tick.snapshot?.signals || []).find((signal: any) => signal.symbol === 'MSFT');
      state.scheduler = {
        ...(state.scheduler || {}),
        enabled: true,
        cadence: '*/5 * * * *',
        mode: 'online_paper_only',
        last_cron_tick_at: state.last_tick_at,
        last_cron_opened: tick.opened,
        last_cron_closed: tick.closed,
        last_cron_adjusted: tick.adjusted,
        last_cron_market_latest_at: tick.snapshot?.generated_at || '',
        last_cron_msft_action: msftSignal?.action || '',
        last_cron_msft_reason: msftSignal?.reject_reason || '',
      };
      await saveCryptoTestnetAccount(env, state);
      ticked += 1;
      outcomes.push({
        user_id_suffix: displayUserId.slice(-10),
        asset_scope: state.config?.asset_scope || 'all',
        mode: state.mode,
        action: 'ticked_online_paper',
        opened: tick.opened,
        closed: tick.closed,
        adjusted: tick.adjusted,
        msft_action: msftSignal?.action || '',
      });
    } catch (error) {
      outcomes.push({
        user_id_suffix: storageId.slice(-10),
        action: 'error',
        error: error instanceof Error ? error.message : 'market scheduled tick failed',
      });
    }
  }

  return {
    ok: true,
    started_at: startedAt,
    finished_at: energyIso(),
    checked_accounts: rows.length,
    ticked_accounts: ticked,
    outcomes,
  };
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

  if (url.pathname === '/api/commodity-energy-trading/dashboard' && request.method === 'GET') {
    try {
      return await commodityEnergyDashboard(request, env, url);
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : 'Commodity energy trading dashboard failed.' },
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

    if (url.pathname === '/api/energy-trading/config') {
      return energyTradingConfig(request, env, url);
    }

    if (url.pathname === '/api/energy-trading/tick') {
      return energyTradingTick(request, env, url);
    }

    if (url.pathname === '/api/energy-trading/stop') {
      return energyTradingStop(request, env, url);
    }

    if (url.pathname === '/api/commodity-energy-trading/start') {
      return commodityEnergyStart(request, env, url);
    }

    if (url.pathname === '/api/commodity-energy-trading/config') {
      return commodityEnergyConfig(request, env, url);
    }

    if (url.pathname === '/api/commodity-energy-trading/tick') {
      return commodityEnergyTickApi(request, env, url);
    }

    if (url.pathname === '/api/commodity-energy-trading/stop') {
      return commodityEnergyStop(request, env, url);
    }

    if (url.pathname === '/api/commodity-energy-trading/reset') {
      return commodityEnergyReset(request, env, url);
    }

    if (url.pathname === '/api/market-trading/start') {
      return marketTradingStart(request, env, url);
    }

    if (url.pathname === '/api/market-trading/config') {
      return marketTradingConfig(request, env, url);
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

    if (url.pathname === '/api/gold-trading/config') {
      return goldTradingConfig(request, env, url);
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

    if (url.pathname === '/api/crypto-testnet/config') {
      return cryptoTestnetConfig(request, env, url);
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

    if (url.pathname === '/api/crypto-testnet/reset') {
      return cryptoTestnetReset(request, env, url);
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

    const assetResponse = await env.ASSETS.fetch(request);
    const accept = request.headers.get('accept') || '';
    const contentType = assetResponse.headers.get('content-type') || '';
    const isHtml =
      accept.includes('text/html') ||
      contentType.includes('text/html') ||
      url.pathname === '/' ||
      url.pathname.endsWith('.html');

    if (!isHtml) return assetResponse;

    const headers = new Headers(assetResponse.headers);
    headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },

  async scheduled(_controller: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil(Promise.allSettled([
      runCommodityEnergyScheduledTick(env),
      runCryptoTestnetScheduledTick(env),
    ]));
  },
};
