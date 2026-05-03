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
  return '';
}

function markEnergyEquity(state: any) {
  const unrealized = (state.open_positions || []).reduce((sum: number, pos: any) => sum + Number(pos.unrealized_pnl_usd || 0), 0);
  const equity = Number(state.cash_usd || 0) + unrealized;
  state.equity_usd = equity;
  state.peak_equity_usd = Math.max(Number(state.peak_equity_usd || equity), equity);
  state.max_drawdown_usd = Math.min(Number(state.max_drawdown_usd || 0), equity - Number(state.peak_equity_usd || equity));
}

async function openEnergyPosition(env: Env, state: any, row: any) {
  const mwh = energyOrderSize(row, state);
  const entrySpread = Number(row.visible_spread || 0);
  const now = new Date();
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
    cash_usd: state.cash_usd,
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
  state.cash_usd = Number(state.cash_usd || 0) + net;
  state.realized_pnl_usd = Number(state.realized_pnl_usd || 0) + net;
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
    mwh: pos.mwh,
    entry_trade_value_usd: pos.entry_trade_value_usd || energyTradeAmount(pos.entry_spread, pos.mwh),
    exit_trade_value_usd: energyTradeAmount(exitSpread, pos.mwh),
    gross_pnl_usd: gross,
    cost_usd: cost,
    net_pnl_usd: net,
    cash_usd: state.cash_usd,
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
  let settled = 0;
  let opened = 0;
  for (const pos of state.open_positions || []) {
    const due = forceSettle || new Date(pos.target_exit_at).getTime() <= now.getTime();
    const unrealized = energyGrossPnl(pos.action, Number(pos.entry_spread || 0), currentSpread, Number(pos.mwh || 0)) -
      Number(state.config?.variable_cost_per_mwh || ENERGY_VARIABLE_COST_PER_MWH) * Math.abs(Number(pos.mwh || 0));
    if (due || unrealized >= Number(state.config?.take_profit_usd || 900) || unrealized <= -Number(state.config?.stop_loss_usd || 450)) {
      await settleEnergyPosition(env, state, pos, currentSpread, due ? '到期结算' : (unrealized > 0 ? '止盈结算' : '止损结算'));
      settled += 1;
    } else {
      remaining.push({ ...pos, unrealized_pnl_usd: unrealized });
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
  const trades = await recentEnergyTrades(env, userId, 120);
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
      realized_pnl_usd: state.realized_pnl_usd,
      open_positions: (state.open_positions || []).length,
      max_open_positions: state.config?.max_open_positions || 10,
      win_rate: (state.closed_trades || []).length
        ? (state.closed_trades || []).filter((trade: any) => Number(trade.net_pnl_usd || 0) > 0).length / (state.closed_trades || []).length
        : 0,
      config: state.config,
    },
    account: state,
    recent_trades: trades,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function energyTradingHistory(request: Request, env: Env, url: URL) {
  const userId = energyUserId(request, url);
  const limit = Math.max(10, Math.min(Number(url.searchParams.get('limit') || 200), 500));
  const state = await loadEnergyAccount(env, userId);
  const trades = await recentEnergyTrades(env, userId, limit);
  return json(
    {
      ok: true,
      online_backend: Boolean(env.ENERGY_TRADING_DB),
      user_id: userId,
      summary: {
        mode: state.mode,
        equity_usd: state.equity_usd,
        cash_usd: state.cash_usd,
        realized_pnl_usd: state.realized_pnl_usd,
        open_positions: (state.open_positions || []).length,
        closed_trades: (state.closed_trades || []).length,
      },
      records: trades,
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
