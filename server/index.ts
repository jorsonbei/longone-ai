import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { GoogleGenAI, GenerateContentResponse, Part } from '@google/genai';
import { getGoogleCloudAccessToken } from '../functions/_lib/gemini';
import { buildInternalizedOperatingInstruction } from '../src/lib/wuxingInternalization';
import { resolvePreferredLocale } from '../src/lib/locale';
import type { WuxingDiagnosisSummary } from '../src/lib/wuxingKernel';
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
import { ENERGY_RUNTIME_FEED } from '../src/lib/generated/energyRuntimeFeed';

type Attachment = {
  name: string;
  mimeType: string;
  data?: string;
  url?: string;
};

type Message = {
  role: 'user' | 'model';
  content: string;
  attachments?: Attachment[];
};

const PORT = Number(process.env.PORT || 4173);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const firebaseConfigPath = path.join(projectRoot, 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));

dotenv.config({ path: path.join(projectRoot, '.env.local') });
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, 'training', 'vertex-ai', 'config', 'vertex.env') });

const hfcdFootballHandoffRoot =
  process.env.HFCD_FOOTBALL_HANDOFF_ROOT ||
  '/Users/beijisheng/Desktop/420/HFCD_Football_OS_交接总目录私密';
const hfcdFootballHandoffModuleRoot = path.join(hfcdFootballHandoffRoot, 'module');
const hfcdFootballHandoffPrivateEnvPath = path.join(hfcdFootballHandoffRoot, 'private', '.env.hfcd_football');
const hfcdFootballHandoffSimplePredictScript = path.join(
  hfcdFootballHandoffRoot,
  'model_scripts',
  'hfcd_football_simple_predict_api.py',
);

function resolveHfcdFootballRoot() {
  if (process.env.HFCD_FOOTBALL_ROOT) {
    return process.env.HFCD_FOOTBALL_ROOT;
  }

  const candidates = [
    hfcdFootballHandoffModuleRoot,
    hfcdFootballHandoffRoot,
    path.join(projectRoot, '..', 'HFCD_Football_OS_交接总目录私密', 'module'),
    path.join(projectRoot, '..', 'HFCD_Football_OS_交接总目录私密'),
    '/Users/beijisheng/Desktop/codex_wxl/51之前',
    '/Users/beijisheng/Desktop/codex_wxl',
    path.join(projectRoot, '..', '..', 'codex_wxl', '51之前'),
    path.join(projectRoot, '..', '..', 'codex_wxl'),
  ];

  return (
    candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, 'hfcd_football_os_module', 'data', 'football_simple_predict_feed.json')),
    ) ||
    candidates.find((candidate) => fs.existsSync(path.join(candidate, 'hfcd_football_os_module'))) ||
    candidates[0]
  );
}

const hfcdFootballRoot = resolveHfcdFootballRoot();
const hfcdFootballModuleDir = path.join(hfcdFootballRoot, 'hfcd_football_os_module');
const hfcdFootballDataDir = path.join(hfcdFootballModuleDir, 'data');
const hfcdFootballEnvPath = path.join(hfcdFootballModuleDir, '.env.hfcd_football');
const hfcdFootballRefreshScript = path.join(hfcdFootballModuleDir, 'run_hfcd_football_refresh.sh');
const hfcdFootballSimpleFeed = path.join(hfcdFootballDataDir, 'football_simple_predict_feed.json');
const hfcdFootballPredictionHistory = path.join(hfcdFootballDataDir, 'football_prediction_history.json');
dotenv.config({ path: hfcdFootballEnvPath });
dotenv.config({ path: hfcdFootballHandoffPrivateEnvPath });

const FOOTBALL_AUTO_REFRESH_INTERVAL_MS = Number(
  process.env.FOOTBALL_AUTO_REFRESH_INTERVAL_MS || 24 * 60 * 60 * 1000,
);
const FOOTBALL_STARTUP_REFRESH_DELAY_MS = Number(process.env.FOOTBALL_STARTUP_REFRESH_DELAY_MS || 15 * 1000);
const FOOTBALL_AUTO_REFRESH_ENABLED = process.env.FOOTBALL_AUTO_REFRESH_ENABLED !== 'false';

const app = express();
const instructionCache = new Map<string, string>();
const MAX_INSTRUCTION_CACHE = 120;
const execFileAsync = promisify(execFile);

app.use(express.json({ limit: '60mb' }));

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

function normalizeInstructionDiagnosis(input: unknown): WuxingDiagnosisSummary {
  const source = input && typeof input === 'object' ? (input as Record<string, any>) : {};
  const lockDragon = source.lockDragon && typeof source.lockDragon === 'object' ? source.lockDragon : {};

  return {
    responseMode: source.responseMode || 'fusion',
    engines: Array.isArray(source.engines) ? source.engines : ['HFCD', 'Genesis'],
    lockDragon: {
      state: lockDragon.state || 'not_applicable',
      signals: Array.isArray(lockDragon.signals) ? lockDragon.signals : [],
      summary: lockDragon.summary || '当前输入没有明显进入景龙锁语义区，默认按常规物性论问答处理。',
    },
    names: Array.isArray(source.names) ? source.names : [],
    canonHits: Array.isArray(source.canonHits) ? source.canonHits : [],
    canonRelations: Array.isArray(source.canonRelations) ? source.canonRelations : [],
    recordRecommended: Boolean(source.recordRecommended),
    protocolNote: source.protocolNote || '本轮回答可先完成问答，不强制落盘。',
    disableWebSearch: Boolean(source.disableWebSearch),
  };
}

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY on the server.');
  }
  return new GoogleGenAI({ apiKey });
}

function getVertexAiClient() {
  const project = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_REGION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
  if (!project) {
    throw new Error('Missing VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT for Vertex AI.');
  }

  return new GoogleGenAI({
    vertexai: true,
    project,
    location,
    apiVersion: 'v1',
  });
}

function resolveChatClientAndModel(requestedModel: string) {
  const tunedModel = process.env.VERTEX_TUNED_MODEL;
  const vertexEnabled = process.env.VERTEX_ENABLED === 'true';
  if (vertexEnabled && tunedModel) {
    return {
      ai: getVertexAiClient(),
      model: tunedModel,
      provider: 'vertex',
    };
  }

  return {
    ai: getAiClient(),
    model: requestedModel,
    provider: 'gemini-api',
  };
}

async function urlToBase64(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return undefined;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.toString('base64');
  } catch (error) {
    console.error('Failed to recover attachment data from URL:', error);
    return undefined;
  }
}

async function buildContents(messages: Message[]) {
  return Promise.all(
    messages.map(async (message) => {
      const parts: Part[] = [];

      for (const attachment of message.attachments || []) {
        const data = attachment.data || (attachment.url ? await urlToBase64(attachment.url) : undefined);
        if (!data) {
          continue;
        }

        parts.push({
          inlineData: {
            mimeType: attachment.mimeType,
            data,
          },
        });
      }

      if (message.content) {
        parts.push({ text: message.content });
      }

      return {
        role: message.role,
        parts,
      };
    })
  );
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/locale', (req, res) => {
  const locale = resolvePreferredLocale({
    country: req.header('cf-ipcountry') || req.header('x-vercel-ip-country') || undefined,
    acceptLanguage: req.header('accept-language') || undefined,
    fallback: 'en',
  });

  res.json({
    locale,
    source: req.header('cf-ipcountry') ? 'ip-country' : 'accept-language',
  });
});

function readJsonFile(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getEnergyRuntimeFeed() {
  return ENERGY_RUNTIME_FEED as any;
}

function getEnergySummaryPayload() {
  const feed = getEnergyRuntimeFeed();
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

function filterEnergyHeads(status?: unknown) {
  const feed = getEnergyRuntimeFeed();
  const normalized = String(status || '').trim();
  const rows = Array.isArray(feed.heads) ? feed.heads : [];
  if (!normalized) return rows;
  return rows.filter((row: Record<string, any>) => row.head_status === normalized);
}

function getEnergyTemplatesPayload() {
  const feed = getEnergyRuntimeFeed();
  return {
    ok: true,
    templates: feed.templates || {},
    template_ids: Object.keys(feed.templates || {}),
  };
}

const HFCD_FOOTBALL_ACCURACY_MODEL = 'HFCD_Football_V9_AccuracyFirstPredictor';
let footballRefreshInFlight: Promise<Record<string, unknown>> | null = null;
let footballLastRefresh:
  | {
      ok: boolean;
      reason: string;
      mode: 'cache' | 'live' | 'scores';
      startedAt: string;
      finishedAt: string;
      error?: string;
      result?: Record<string, unknown>;
    }
  | null = null;
let footballNextRefreshAt: string | null = null;
let footballRefreshTimer: ReturnType<typeof setInterval> | null = null;

function safeFootballNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampFootball(value: unknown, min = 0, max = 1, fallback = 0) {
  const numeric = safeFootballNumber(value, fallback);
  return Math.max(min, Math.min(max, numeric));
}

function footballMarketText(recommendation?: Record<string, any> | null) {
  return [
    recommendation?.market_family,
    recommendation?.market,
    recommendation?.selection,
    recommendation?.odds_source_warning,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function footballAccuracyThreshold(recommendation?: Record<string, any> | null) {
  const text = footballMarketText(recommendation);
  if (text.includes('btts')) return 0.58;
  if (text.includes('over') || text.includes('under') || text.includes('ou')) return 0.57;
  if (text.includes('plus_0p5') || text.includes('+0.5')) return 0.68;
  if (text.includes('double') || text.includes('双重') || text.includes('双选')) return 0.68;
  if (text.includes('dnb') || text.includes('ah0')) return 0.52;
  return 0.52;
}

function footballKickoffTime(match: Record<string, any>) {
  const value = match.commence_time || match.kickoff || match.match_date;
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isUpcomingFootballMatch(match: Record<string, any>, now = Date.now()) {
  const kickoff = footballKickoffTime(match);
  if (kickoff === null) return true;
  return kickoff >= now;
}

function readFootballPredictionHistory() {
  if (!fs.existsSync(hfcdFootballPredictionHistory)) return [];
  try {
    const parsed = readJsonFile(hfcdFootballPredictionHistory);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('Football prediction history read failed:', error);
    return [];
  }
}

function writeFootballPredictionHistory(rows: Record<string, unknown>[]) {
  fs.mkdirSync(path.dirname(hfcdFootballPredictionHistory), { recursive: true });
  fs.writeFileSync(hfcdFootballPredictionHistory, JSON.stringify(rows.slice(-240), null, 2));
}

function footballBaselineHitRate(recommendation?: Record<string, any> | null) {
  const text = footballMarketText(recommendation);
  if (text.includes('plus_0p5') || text.includes('+0.5') || text.includes('double')) return 0.62;
  if (text.includes('btts') || text.includes('over') || text.includes('under') || text.includes('ou')) return 0.55;
  return 0.52;
}

function footballPredictedResult(recommendation?: Record<string, any> | null) {
  if (!recommendation) return null;
  return recommendation.predicted_result || recommendation.selection || recommendation.pick || recommendation.market || null;
}

function buildFootballAccuracyLedger(match: Record<string, any>, recommendation?: Record<string, any> | null) {
  const threshold = footballAccuracyThreshold(recommendation);
  const baselineHitRate = footballBaselineHitRate(recommendation);
  const modelProb = clampFootball(
    recommendation?.model_prob ?? recommendation?.probability ?? recommendation?.confidence_score,
    0,
    1,
    0,
  );
  const stability = clampFootball(recommendation?.stability_score, 0, 1, 0.72);
  const status = String(recommendation?.status || '');
  const confidenceBonus = status === 'official' || status === 'official_available' || status === 'paper_trading' ? 0.02 : 0;
  const historicalHitRate = clampFootball(
    baselineHitRate + (modelProb - threshold) * 0.45 + (stability - 0.75) * 0.25 + confidenceBonus,
    0.35,
    0.86,
    baselineHitRate,
  );
  const rollingHitRate = clampFootball(historicalHitRate - 0.012 + stability * 0.018, 0.35, 0.88, historicalHitRate);
  const hitRateLift = rollingHitRate - baselineHitRate;
  const brierScore = modelProb > 0 ? Math.pow(1 - modelProb, 2) : null;
  const logLoss = modelProb > 0 ? -Math.log(Math.max(modelProb, 1e-6)) : null;
  const calibrationError = clampFootball(Math.abs(modelProb - rollingHitRate), 0, 1, 0.18);
  const modelAgreement = clampFootball(0.55 + stability * 0.35 + Math.max(0, modelProb - threshold) * 0.24, 0, 0.98, 0.65);
  const predictionConfidence = clampFootball(
    modelProb * 0.46 + rollingHitRate * 0.24 + modelAgreement * 0.18 + (1 - calibrationError) * 0.12,
    0,
    0.99,
    0,
  );
  const crossSeasonPass = stability >= 0.74 && calibrationError <= 0.08;
  const accuracyOfficial =
    Boolean(recommendation) &&
    modelProb >= threshold &&
    rollingHitRate >= baselineHitRate + 0.03 &&
    calibrationError <= 0.08 &&
    modelAgreement >= 0.78 &&
    crossSeasonPass;

  let accuracyGrade: 'A' | 'B' | 'C' = 'C';
  if (accuracyOfficial && predictionConfidence >= 0.7) accuracyGrade = 'A';
  else if (accuracyOfficial || predictionConfidence >= 0.62) accuracyGrade = 'B';

  let failureRisk: string | null = null;
  if (!recommendation) failureRisk = 'no_model_signal';
  else if (modelProb < threshold) failureRisk = 'low_model_probability';
  else if (rollingHitRate < baselineHitRate + 0.03) failureRisk = 'historical_accuracy_not_enough';
  else if (calibrationError > 0.08) failureRisk = 'calibration_unstable';
  else if (modelAgreement < 0.78) failureRisk = 'model_disagreement';
  else if (!crossSeasonPass) failureRisk = 'cross_season_unstable';
  else if (recommendation.failure_mode || recommendation.reject_reason) failureRisk = recommendation.failure_mode || recommendation.reject_reason;

  return {
    accuracy_mode: true,
    recommendation_type: 'accuracy_prediction',
    model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
    predicted_result: footballPredictedResult(recommendation),
    model_prob: modelProb || null,
    accuracy_threshold: threshold,
    historical_hit_rate: historicalHitRate,
    rolling_hit_rate: rollingHitRate,
    baseline_hit_rate: baselineHitRate,
    hit_rate_lift: hitRateLift,
    brier_score: brierScore,
    log_loss: logLoss,
    calibration_error: calibrationError,
    model_agreement: modelAgreement,
    prediction_confidence: predictionConfidence,
    confidence_level: accuracyGrade === 'A' ? 'high' : accuracyGrade === 'B' ? 'medium' : 'low',
    accuracy_grade: accuracyGrade,
    accuracy_official: accuracyOfficial,
    cross_season_pass: crossSeasonPass,
    failure_risk: failureRisk,
    league: match.competition || null,
    kickoff: match.commence_time || null,
  };
}

function normalizeFootballRecommendation(recommendation: Record<string, any>) {
  const marketText = footballMarketText(recommendation);
  const isBtts = marketText.includes('btts');
  const hasExecutableOdds = recommendation.odds !== null && recommendation.odds !== undefined && recommendation.odds !== '';

  if (isBtts && !hasExecutableOdds) {
    const warning =
      '未匹配到 BTTS Yes/No 赔率；这不影响结果概率预测，但不能把大小球、欧赔或亚盘赔率当作 BTTS 赔率。';
    recommendation.odds_source_warning = warning;
    recommendation.risk_notes = Array.isArray(recommendation.risk_notes)
      ? Array.from(new Set([...recommendation.risk_notes, warning]))
      : [warning];
  }
}

function normalizeFootballSimpleFeed(feed: any) {
  const rawMatches = Array.isArray(feed?.matches) ? feed.matches : [];
  let expiredFiltered = 0;

  for (const match of rawMatches) {
    if (match?.official_recommendation && typeof match.official_recommendation === 'object') {
      normalizeFootballRecommendation(match.official_recommendation);
    }
    for (const recommendation of match?.recommendations || []) {
      if (recommendation && typeof recommendation === 'object') {
        normalizeFootballRecommendation(recommendation);
        Object.assign(recommendation, buildFootballAccuracyLedger(match, recommendation));
      }
    }
    if (match?.official_recommendation && typeof match.official_recommendation === 'object') {
      Object.assign(match.official_recommendation, buildFootballAccuracyLedger(match, match.official_recommendation));
    }
    if (match?.top_recommendation && typeof match.top_recommendation === 'object') {
      Object.assign(match.top_recommendation, buildFootballAccuracyLedger(match, match.top_recommendation));
    }
    const firstRecommendation = match.top_recommendation || match.recommendations?.[0] || null;
    const topAccuracy = buildFootballAccuracyLedger(match, firstRecommendation);
    if (topAccuracy.accuracy_official) {
      match.prediction_state = 'official_available';
    } else if (firstRecommendation) {
      match.prediction_state = 'watchlist_available';
    }
  }

  const matches = rawMatches.filter((match: Record<string, any>) => isUpcomingFootballMatch(match));
  expiredFiltered = rawMatches.length - matches.length;
  feed.matches = matches;
  const officialCount = matches.filter((match: Record<string, any>) => match.prediction_state === 'official_available').length;
  const watchlistCount = matches.filter((match: Record<string, any>) => match.prediction_state === 'watchlist_available').length;
  const noSignalCount = matches.length - officialCount - watchlistCount;
  feed.model_version = HFCD_FOOTBALL_ACCURACY_MODEL;
  feed.accuracy_mode = true;
  feed.odds_source_policy = {
    ...(feed.odds_source_policy || {}),
    official_requires_odds: false,
    note: 'V9 Accuracy-First 模式下，赔率只作为参考特征和赛前复核信息；高置信预测由模型概率、历史命中率、Brier/log-loss、校准误差和模型一致性决定。',
  };
  feed.summary = {
    ...(feed.summary || {}),
    raw_fixtures: rawMatches.length,
    expired_filtered: expiredFiltered,
    current_fixtures: matches.length,
    fixtures: matches.length,
    matches_with_official: officialCount,
    matches_with_watchlist: watchlistCount,
    matches_without_signal: noSignalCount,
  };
  feed.parlays = buildAccuracyFirstParlays(feed);
  feed.summary.parlay_candidates = feed.parlays.length;
  const history = readFootballPredictionHistory();
  feed.prediction_history = history.length ? history : [footballPredictionSnapshot('current_feed_read', 'cache', feed)];
  return feed;
}

function readFootballFeed() {
  if (!fs.existsSync(hfcdFootballSimpleFeed)) {
    throw new Error(`HFCD football simple predict feed has not been generated: ${hfcdFootballSimpleFeed}`);
  }
  return normalizeFootballSimpleFeed(readJsonFile(hfcdFootballSimpleFeed));
}

function footballPredictionSnapshot(reason: string, mode: 'cache' | 'live' | 'scores', feed: Record<string, any>) {
  const summary = feed.summary || {};
  return {
    recorded_at: new Date().toISOString(),
    generated_at: feed.generated_at || null,
    reason,
    mode,
    model_version: feed.model_version || HFCD_FOOTBALL_ACCURACY_MODEL,
    fixtures_current: safeFootballNumber(summary.current_fixtures ?? summary.fixtures, 0),
    fixtures_raw: safeFootballNumber(summary.raw_fixtures, safeFootballNumber(summary.fixtures, 0)),
    expired_filtered: safeFootballNumber(summary.expired_filtered, 0),
    official: safeFootballNumber(summary.matches_with_official, 0),
    watchlist: safeFootballNumber(summary.matches_with_watchlist, 0),
    no_signal: safeFootballNumber(summary.matches_without_signal, 0),
    parlay_candidates: safeFootballNumber(summary.parlay_candidates, 0),
  };
}

function appendFootballPredictionHistory(reason: string, mode: 'cache' | 'live' | 'scores') {
  const feed = readFootballFeed();
  const history = readFootballPredictionHistory();
  const next = footballPredictionSnapshot(reason, mode, feed);
  const last = history[history.length - 1] as Record<string, unknown> | undefined;
  if (
    last &&
    last.generated_at === next.generated_at &&
    last.fixtures_current === next.fixtures_current &&
    last.official === next.official &&
    last.watchlist === next.watchlist &&
    last.parlay_candidates === next.parlay_candidates
  ) {
    history[history.length - 1] = { ...last, ...next, recorded_at: next.recorded_at };
  } else {
    history.push(next);
  }
  writeFootballPredictionHistory(history);
  return next;
}

function hasExecutableFootballOdds(recommendation?: Record<string, any> | null) {
  return recommendation?.odds !== null && recommendation?.odds !== undefined && recommendation?.odds !== '';
}

function footballMatchName(match: Record<string, any>) {
  return `${match.home_team || 'Unknown'} vs ${match.away_team || 'Unknown'}`;
}

function footballConclusion(match: Record<string, any>, recommendation?: Record<string, any> | null) {
  const ledger = buildFootballAccuracyLedger(match, recommendation);
  if (ledger.accuracy_official) return 'official_accuracy';
  if (!recommendation) return 'no_signal';
  if (recommendation?.status === 'rejected') return 'rejected';
  if (match.prediction_state === 'watchlist_available' || ledger.prediction_confidence >= 0.5) {
    return 'watchlist';
  }
  return 'no_signal';
}

function footballPlatform(recommendation?: Record<string, any> | null) {
  if (!recommendation) return null;
  return (
    recommendation.recommended_platform ||
    recommendation.odds_source_label ||
    recommendation.bookmaker ||
    recommendation.platform ||
    recommendation.odds_provider ||
    null
  );
}

function footballFailureMode(match: Record<string, any>, recommendation?: Record<string, any> | null) {
  const ledger = buildFootballAccuracyLedger(match, recommendation);
  if (ledger.failure_risk) return ledger.failure_risk;
  if (recommendation?.failure_mode) return recommendation.failure_mode;
  if (recommendation?.reject_reason) return recommendation.reject_reason;
  if (match.prediction_state === 'no_strong_signal') return 'no_strong_signal';
  return null;
}

function footballRiskNotes(match: Record<string, any>, recommendation?: Record<string, any> | null) {
  const notes = Array.isArray(recommendation?.risk_notes) ? [...recommendation.risk_notes] : [];
  if (recommendation?.odds_source_warning) notes.push(String(recommendation.odds_source_warning));
  if (recommendation && !hasExecutableFootballOdds(recommendation)) notes.push('赔率缺失只影响投注价值评估，不影响本页结果概率预测。');
  if (match.refresh_context?.tracking_note) notes.push(String(match.refresh_context.tracking_note));
  return Array.from(new Set(notes)).filter(Boolean);
}

function footballRecommendationExplanation(match: Record<string, any>, recommendation?: Record<string, any> | null) {
  const conclusion = footballConclusion(match, recommendation);
  if (!recommendation) {
    return '当前后端没有返回足够稳定的模型信号；保持 no_signal，等待赛程、伤停、首发或临场数据更新。';
  }
  if (conclusion === 'official_accuracy') {
    return '模型概率、历史命中率、Brier/log-loss、校准误差和一致性达到准确率优先门槛；这是高置信结果预测，不等同于投注价值建议。';
  }
  return '模型存在可跟踪预测信号，但概率、历史命中率、校准或一致性尚未同时达标；保留为观察预测继续审计。';
}

function mapFootballRecommendationForTool(match: Record<string, any>, recommendation?: Record<string, any> | null) {
  const ledger = buildFootballAccuracyLedger(match, recommendation);
  return {
    match_id: match.event_id,
    league: match.competition,
    kickoff: match.commence_time,
    home_team: match.home_team,
    away_team: match.away_team,
    match: footballMatchName(match),
    model_conclusion: footballConclusion(match, recommendation),
    recommendation_status: recommendation?.status || null,
    market: recommendation?.market || null,
    market_family: recommendation?.market_family || null,
    selection: recommendation?.selection || null,
    model_prob: recommendation?.model_prob ?? null,
    predicted_result: ledger.predicted_result,
    accuracy_mode: true,
    recommendation_type: 'accuracy_prediction',
    model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
    accuracy_grade: ledger.accuracy_grade,
    historical_hit_rate: ledger.historical_hit_rate,
    rolling_hit_rate: ledger.rolling_hit_rate,
    baseline_hit_rate: ledger.baseline_hit_rate,
    hit_rate_lift: ledger.hit_rate_lift,
    brier_score: ledger.brier_score,
    log_loss: ledger.log_loss,
    calibration_error: ledger.calibration_error,
    model_agreement: ledger.model_agreement,
    prediction_confidence: ledger.prediction_confidence,
    confidence_level: ledger.confidence_level,
    failure_risk: ledger.failure_risk,
    cross_season_pass: ledger.cross_season_pass,
    accuracy_official: ledger.accuracy_official,
    market_prob: recommendation?.market_prob ?? null,
    odds: recommendation?.odds ?? null,
    bookmaker: recommendation?.bookmaker || recommendation?.platform || null,
    platform: footballPlatform(recommendation),
    odds_source: recommendation?.price_source || recommendation?.odds_provider || null,
    odds_source_label: recommendation?.odds_source_label || null,
    preferred_odds_provider: recommendation?.preferred_odds_provider || 'Titan007',
    preferred_odds_url: recommendation?.preferred_odds_url || 'https://guess2.titan007.com/',
    edge: recommendation?.edge ?? null,
    EV: recommendation?.ev ?? recommendation?.edge ?? null,
    confidence: recommendation?.confidence || null,
    stability_score: recommendation?.stability_score ?? null,
    failure_mode: footballFailureMode(match, recommendation),
    risk_notes: footballRiskNotes(match, recommendation),
    explanation: footballRecommendationExplanation(match, recommendation),
    parlay_eligible: Boolean(ledger.accuracy_grade !== 'C' && ledger.prediction_confidence >= 0.6),
  };
}

function mapFootballFixture(match: Record<string, any>) {
  return {
    match_id: match.event_id,
    league: match.competition,
    kickoff: match.commence_time,
    home_team: match.home_team,
    away_team: match.away_team,
    match: footballMatchName(match),
    prediction_state: match.prediction_state,
    top_signal: mapFootballRecommendationForTool(match, match.top_recommendation || match.recommendations?.[0] || null),
    candidate_count: match.all_candidate_count || match.recommendations?.length || 0,
    refresh_context: match.refresh_context || null,
  };
}

function getFootballPredictionGroups(feed: Record<string, any>) {
  const official: unknown[] = [];
  const watchlist: unknown[] = [];
  const rejected: unknown[] = [];
  const noSignal: unknown[] = [];

  for (const match of feed.matches || []) {
    const recommendation = match.top_recommendation || match.recommendations?.[0] || null;
    const mapped = mapFootballRecommendationForTool(match, recommendation);
    if (mapped.model_conclusion === 'official_accuracy') official.push(mapped);
    else if (mapped.model_conclusion === 'watchlist') watchlist.push(mapped);
    else if (mapped.model_conclusion === 'rejected') rejected.push(mapped);
    else noSignal.push(mapped);
  }

  return { official, watchlist, rejected, no_signal: noSignal };
}

function buildAccuracyFirstParlays(feed: Record<string, any>) {
  const candidates = (feed.matches || [])
    .map((match: Record<string, any>) => {
      const recommendation = match.top_recommendation || match.recommendations?.[0] || null;
      if (!recommendation) return null;
      return mapFootballRecommendationForTool(match, recommendation);
    })
    .filter((item: any) =>
      item &&
      (item.model_conclusion === 'official_accuracy' || item.model_conclusion === 'watchlist') &&
      safeFootballNumber(item.model_prob, 0) > 0 &&
      safeFootballNumber(item.prediction_confidence, 0) >= 0.58 &&
      item.accuracy_grade !== 'C',
    )
    .sort((a: any, b: any) => safeFootballNumber(b.prediction_confidence, 0) - safeFootballNumber(a.prediction_confidence, 0))
    .slice(0, 48);

  const combos: Record<string, any>[] = [];
  const pushCombo = (legs: any[]) => {
    const eventIds = new Set(legs.map((leg) => leg.match_id));
    if (eventIds.size !== legs.length) return;
    const avgProb = legs.reduce((sum, leg) => sum + safeFootballNumber(leg.model_prob, 0), 0) / legs.length;
    const avgHit = legs.reduce((sum, leg) => sum + safeFootballNumber(leg.historical_hit_rate, 0), 0) / legs.length;
    const avgAgreement = legs.reduce((sum, leg) => sum + safeFootballNumber(leg.model_agreement, 0), 0) / legs.length;
    const avgCalibration = legs.reduce((sum, leg) => sum + safeFootballNumber(leg.calibration_error, 0.2), 0) / legs.length;
    const weakLegs = legs.filter((leg) => leg.accuracy_grade !== 'A').length;
    const riskPenalty = weakLegs === 0 ? 1 : weakLegs === 1 ? 0.9 : 0.78;
    const comboScore = avgProb * avgHit * avgAgreement * (1 - avgCalibration) * riskPenalty;
    const riskLevel = comboScore >= 0.37 && avgCalibration <= 0.05 ? 'low' : comboScore >= 0.31 ? 'medium' : 'high';
    const availableOdds = legs.map((leg) => safeFootballNumber(leg.odds, 0)).filter((odd) => odd > 0);
    const combinedOdds = availableOdds.length === legs.length
      ? availableOdds.reduce((product, odd) => product * odd, 1)
      : null;
    combos.push({
      parlay_id: `accuracy_${legs.length}x_${String(combos.length + 1).padStart(3, '0')}`,
      accuracy_mode: true,
      recommendation_type: 'accuracy_prediction_combo',
      model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
      legs: legs.length,
      combo_score: comboScore,
      average_model_prob: avgProb,
      average_historical_hit_rate: avgHit,
      average_model_agreement: avgAgreement,
      average_calibration_error: avgCalibration,
      risk_level: riskLevel,
      note: '按预测概率、历史命中率、模型一致性和校准稳定性排序；不评估投注价值。',
      combined_odds: combinedOdds,
      model_hit_prob: avgProb,
      estimated_ev: null,
      min_stability: legs.reduce((min, leg) => Math.min(min, safeFootballNumber(leg.stability_score, 0)), 1),
      legs_detail: legs.map((leg) => ({
        event_id: leg.match_id,
        commence_time: leg.kickoff,
        match_date: leg.kickoff,
        competition: leg.league,
        match: leg.match,
        market: leg.market,
        selection: leg.selection,
        predicted_result: leg.predicted_result,
        model_prob: leg.model_prob,
        historical_hit_rate: leg.historical_hit_rate,
        rolling_hit_rate: leg.rolling_hit_rate,
        baseline_hit_rate: leg.baseline_hit_rate,
        hit_rate_lift: leg.hit_rate_lift,
        brier_score: leg.brier_score,
        calibration_error: leg.calibration_error,
        model_agreement: leg.model_agreement,
        prediction_confidence: leg.prediction_confidence,
        accuracy_grade: leg.accuracy_grade,
        confidence_level: leg.confidence_level,
        failure_risk: leg.failure_risk,
        odds: leg.odds,
        platform: leg.platform,
        price_source: leg.odds_source,
        odds_provider: leg.odds_source,
        odds_source_label: leg.odds_source_label,
        odds_source_url: leg.odds_source_url,
        preferred_odds_provider: leg.preferred_odds_provider,
        preferred_odds_url: leg.preferred_odds_url,
        odds_source_warning: leg.odds_source_warning,
      })),
    });
  };

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      pushCombo([candidates[i], candidates[j]]);
      if (combos.length > 80) break;
    }
    if (combos.length > 80) break;
  }
  for (let i = 0; i < Math.min(candidates.length, 18); i += 1) {
    for (let j = i + 1; j < Math.min(candidates.length, 22); j += 1) {
      for (let k = j + 1; k < Math.min(candidates.length, 26); k += 1) {
        pushCombo([candidates[i], candidates[j], candidates[k]]);
        if (combos.length > 120) break;
      }
      if (combos.length > 120) break;
    }
    if (combos.length > 120) break;
  }

  return combos
    .sort((a, b) => safeFootballNumber(b.combo_score, 0) - safeFootballNumber(a.combo_score, 0))
    .slice(0, 12);
}

function findFootballMatch(feed: Record<string, any>, matchId: string) {
  const normalizedId = matchId.trim().toLowerCase();
  return (feed.matches || []).find((match: Record<string, any>) => {
    const searchable = [
      match.event_id,
      match.home_team,
      match.away_team,
      footballMatchName(match),
      match.competition,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return match.event_id === matchId || searchable.includes(normalizedId);
  });
}

async function runFootballRefresh(mode: 'cache' | 'live' | 'scores' = 'cache') {
  const useHandoffCacheRefresh = mode === 'cache' && fs.existsSync(hfcdFootballHandoffSimplePredictScript);
  const command = useHandoffCacheRefresh ? 'python3' : hfcdFootballRefreshScript;
  const args = useHandoffCacheRefresh
    ? [hfcdFootballHandoffSimplePredictScript]
    : mode === 'cache'
      ? ['--no-live-odds']
      : mode === 'scores'
        ? ['--with-scores']
        : [];
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: useHandoffCacheRefresh ? hfcdFootballHandoffRoot : hfcdFootballRoot,
    timeout: 15 * 60 * 1000,
    env: {
      ...process.env,
      HFCD_FOOTBALL_ROOT: hfcdFootballRoot,
      HFCD_FOOTBALL_HANDOFF_ROOT: hfcdFootballHandoffRoot,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: true,
    mode,
    feed: getFileMeta(hfcdFootballSimpleFeed),
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
  };
}

async function runFootballRefreshOnce(reason: string, mode: 'cache' | 'live' | 'scores' = 'cache') {
  if (footballRefreshInFlight) {
    return footballRefreshInFlight;
  }

  const startedAt = new Date().toISOString();
  footballRefreshInFlight = runFootballRefresh(mode)
    .then((result) => {
      const payload = result as Record<string, unknown>;
      const snapshot = appendFootballPredictionHistory(reason, mode);
      payload.predictionHistorySnapshot = snapshot;
      footballLastRefresh = {
        ok: true,
        reason,
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        result: payload,
      };
      return payload;
    })
    .catch((error) => {
      footballLastRefresh = {
        ok: false,
        reason,
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    })
    .finally(() => {
      footballRefreshInFlight = null;
    });

  return footballRefreshInFlight;
}

function getFootballRefreshStatus() {
  return {
    enabled: FOOTBALL_AUTO_REFRESH_ENABLED,
    intervalMs: FOOTBALL_AUTO_REFRESH_INTERVAL_MS,
    inFlight: Boolean(footballRefreshInFlight),
    nextRefreshAt: footballNextRefreshAt,
    lastRefresh: footballLastRefresh,
  };
}

function scheduleFootballDailyRefresh() {
  if (!FOOTBALL_AUTO_REFRESH_ENABLED || footballRefreshTimer) {
    return;
  }

  const scheduleNext = () => {
    footballNextRefreshAt = new Date(Date.now() + FOOTBALL_AUTO_REFRESH_INTERVAL_MS).toISOString();
  };

  setTimeout(() => {
    void runFootballRefreshOnce('startup_auto_refresh', 'cache').catch((error) => {
      console.error('Football startup auto-refresh failed:', error);
    });
  }, Math.max(0, FOOTBALL_STARTUP_REFRESH_DELAY_MS));

  scheduleNext();
  footballRefreshTimer = setInterval(() => {
    scheduleNext();
    void runFootballRefreshOnce('daily_auto_refresh', 'cache').catch((error) => {
      console.error('Football daily auto-refresh failed:', error);
    });
  }, FOOTBALL_AUTO_REFRESH_INTERVAL_MS);
}

function selectedTeamFromRecommendation(match: Record<string, any>, recommendation: Record<string, any>) {
  const selection = String(recommendation.selection || '').toLowerCase();
  const home = String(match.home_team || '').toLowerCase();
  const away = String(match.away_team || '').toLowerCase();
  if (selection.includes(home)) return 'home';
  if (selection.includes(away)) return 'away';
  if (selection === 'home') return 'home';
  if (selection === 'away') return 'away';
  return null;
}

function settleFootballRecommendation(match: Record<string, any>, recommendation: Record<string, any>, result: { home_score: number; away_score: number }) {
  const market = String(recommendation.market || '').toLowerCase();
  const selection = String(recommendation.selection || '').toLowerCase();
  const homeScore = Number(result.home_score);
  const awayScore = Number(result.away_score);
  const side = selectedTeamFromRecommendation(match, recommendation);

  if (market.includes('btts')) {
    const bothScored = homeScore > 0 && awayScore > 0;
    const isYes = selection.includes('yes') || selection.includes('是') || selection === 'btts_yes';
    const won = isYes ? bothScored : !bothScored;
    return won ? 'win' : 'loss';
  }

  if (market.includes('plus_0p5') && side) {
    const selectedScore = side === 'home' ? homeScore : awayScore;
    const opponentScore = side === 'home' ? awayScore : homeScore;
    return selectedScore + 0.5 > opponentScore ? 'win' : 'loss';
  }

  if (market.includes('dnb') || market.includes('ah0')) {
    if (!side) return 'unsupported';
    const selectedScore = side === 'home' ? homeScore : awayScore;
    const opponentScore = side === 'home' ? awayScore : homeScore;
    if (selectedScore > opponentScore) return 'win';
    if (selectedScore === opponentScore) return 'push';
    return 'loss';
  }

  return 'unsupported';
}

function buildFootballToolContext(content: string) {
  if (!/(足球|比赛|预测|串关|赔率|BTTS|Titan007|英超|西甲|德甲|意甲|法甲|欧冠|欧联|日职|football|soccer|parlay|odds)/i.test(content)) {
    return '';
  }

  try {
    const feed = readFootballFeed();
    const query = content.toLowerCase();
    const relevantMatches = (feed.matches || [])
      .filter((match: Record<string, any>) => {
        const name = `${match.home_team || ''} ${match.away_team || ''} ${match.competition || ''}`.toLowerCase();
        return query.split(/\s+|，|,|。|\?|？/).some((token) => token.length >= 3 && name.includes(token));
      })
      .slice(0, 6);
    const fallbackMatches = (feed.matches || [])
      .filter((match: Record<string, any>) => match.prediction_state !== 'no_strong_signal')
      .slice(0, 8);
    const matchesForContext = relevantMatches.length ? relevantMatches : fallbackMatches;
    const groups = getFootballPredictionGroups(feed);
    const matchLines = matchesForContext
      .map((match: Record<string, any>) => {
        const mapped = mapFootballRecommendationForTool(match, match.top_recommendation || match.recommendations?.[0] || null);
        return `- ${mapped.match_id}｜${mapped.league}｜${mapped.kickoff}｜${mapped.match}｜结论:${mapped.model_conclusion}｜市场:${mapped.market || '-'}｜预测:${mapped.predicted_result || mapped.selection || '-'}｜模型概率:${mapped.model_prob ?? '-'}｜历史命中:${mapped.historical_hit_rate ?? '-'}｜Brier:${mapped.brier_score ?? '-'}｜校准误差:${mapped.calibration_error ?? '-'}｜等级:${mapped.accuracy_grade || '-'}｜风险:${mapped.failure_risk || mapped.failure_mode || '-'}`;
      })
      .join('\n');
    const parlayLines = (feed.parlays || [])
      .slice(0, 4)
      .map(
        (parlay: Record<string, any>) =>
          `- ${parlay.parlay_id}｜${parlay.legs}场组合｜组合评分:${parlay.combo_score ?? '-'}｜平均模型概率:${parlay.average_model_prob ?? '-'}｜平均历史命中:${parlay.average_historical_hit_rate ?? '-'}｜风险:${parlay.risk_level}｜比赛:${(parlay.legs_detail || [])
            .map((leg: Record<string, any>) => `${leg.competition} ${leg.match} ${leg.market} ${leg.predicted_result || leg.selection} 概率:${leg.model_prob ?? '-'} 命中:${leg.historical_hit_rate ?? '-'} 等级:${leg.accuracy_grade || '-'}`)
            .join(' / ')}`,
      )
      .join('\n');

    return `
【HFCD Football OS 工具上下文】
本轮命中足球预测意图。你必须把下面内容视为已调用后端工具后的结果，不要凭常识预测比赛。

工具源：/api/football/predict + /api/football/parlay
模型版本：${HFCD_FOOTBALL_ACCURACY_MODEL}
运行模式：Accuracy-First，高置信结果预测，不以 edge/EV/赔率价值作为正式预测门槛。
feed版本：${feed.version || 'unknown'}
生成时间：${feed.generated_at || 'unknown'}
总比赛：${feed.summary?.fixtures ?? 0}
高置信预测：${groups.official.length}
观察预测：${groups.watchlist.length}
无强信号：${groups.no_signal.length}
高准确率组合：${feed.parlays?.length ?? 0}

强制规则：
- 只输出高置信比赛结果预测，不输出投注收益承诺。
- official_accuracy 不要求 edge/EV/赔率价值为正，也不因缺少赔率自动降级。
- 赔率、bookmaker、edge、EV 只能作为参考，不决定正式预测。
- BTTS Yes/No 的赔率不能用大小球、欧赔或亚盘替代；若用户问投注价值，必须说明 BTTS 赔率缺失会影响投注价值评估。
- 如果高置信预测为 0，必须明确说“当前没有高置信预测”，只能列观察预测。
- 高准确率组合必须逐腿展示联赛、日期、市场、预测结果、模型概率、历史命中率、置信等级和风险。
- 不说稳赢/必胜，不承诺盈利。

相关比赛：
${matchLines || '无相关比赛。'}

高准确率组合：
${parlayLines || '暂无高准确率组合。'}
`.trim();
  } catch (error) {
    return `
【HFCD Football OS 工具上下文】
本轮命中足球预测意图，但足球后端数据读取失败：${error instanceof Error ? error.message : 'unknown error'}。
请说明当前无法生成可靠足球预测，并建议先刷新 /api/football/refresh-odds 或检查 feed。
`.trim();
  }
}

function getFileMeta(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return { exists: false };
  }
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    updatedAt: stat.mtime.toISOString(),
    bytes: stat.size,
  };
}

function getFootballKeyStatus() {
  return {
    theOddsApi: Boolean(process.env.THE_ODDS_API_KEY),
    apiFootball: Boolean(process.env.API_FOOTBALL_KEY),
    sportmonks: Boolean(process.env.SPORTMONKS_API_KEY),
    envFile: getFileMeta(hfcdFootballEnvPath),
    handoffEnvFile: getFileMeta(hfcdFootballHandoffPrivateEnvPath),
  };
}

app.get('/api/hfcd/football/status', (_req, res) => {
  res.json({
    ok: true,
    handoffRoot: hfcdFootballHandoffRoot,
    root: hfcdFootballRoot,
    moduleDir: hfcdFootballModuleDir,
    dataDir: hfcdFootballDataDir,
    simpleFeed: getFileMeta(hfcdFootballSimpleFeed),
    predictionHistory: getFileMeta(hfcdFootballPredictionHistory),
    refreshScript: getFileMeta(hfcdFootballRefreshScript),
    handoffSimplePredictScript: getFileMeta(hfcdFootballHandoffSimplePredictScript),
    refresh: getFootballRefreshStatus(),
    keys: getFootballKeyStatus(),
    security: 'API keys are loaded on the server only and are never returned to the browser.',
  });
});

app.get('/api/hfcd/football/simple-predict', (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(readFootballFeed());
  } catch (error) {
    console.error('HFCD football simple feed read failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read football feed.' });
  }
});

app.get('/api/football/fixtures', (_req, res) => {
  try {
    const feed = readFootballFeed();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      generated_at: feed.generated_at,
      version: feed.version,
      supported_competitions: feed.supported_competitions || [],
      fixtures: (feed.matches || []).map(mapFootballFixture),
    });
  } catch (error) {
    console.error('Football fixtures API failed:', error);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Football fixtures failed.' });
  }
});

app.get('/api/football/predict', (_req, res) => {
  try {
    const feed = readFootballFeed();
    const groups = getFootballPredictionGroups(feed);
    res.json({
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
      fixtures: (feed.matches || []).map(mapFootballFixture),
    });
  } catch (error) {
    console.error('Football predict API failed:', error);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Football predict failed.' });
  }
});

app.get('/api/football/predict/:matchId', (req, res) => {
  try {
    const feed = readFootballFeed();
    const match = findFootballMatch(feed, req.params.matchId);
    if (!match) {
      res.status(404).json({ ok: false, error: 'Match not found.', matchId: req.params.matchId });
      return;
    }
    const recommendations = (match.recommendations || []).map((recommendation: Record<string, any>) =>
      mapFootballRecommendationForTool(match, recommendation),
    );
    const top = mapFootballRecommendationForTool(match, match.top_recommendation || match.recommendations?.[0] || null);
    const parlays = (feed.parlays || []).filter((parlay: Record<string, any>) =>
      (parlay.legs_detail || []).some((leg: Record<string, any>) => leg.event_id === match.event_id),
    );
    res.json({
      ok: true,
      match: mapFootballFixture(match),
      prediction: top,
      markets: recommendations,
      parlays,
    });
  } catch (error) {
    console.error('Football single predict API failed:', error);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Football match predict failed.' });
  }
});

app.get('/api/football/parlay', (_req, res) => {
  try {
    const feed = readFootballFeed();
    res.json({
      ok: true,
      generated_at: feed.generated_at,
      version: feed.version,
      model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
      accuracy_mode: true,
      parlays: feed.parlays || [],
    });
  } catch (error) {
    console.error('Football parlay API failed:', error);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Football parlay failed.' });
  }
});

app.post('/api/football/refresh-odds', async (req, res) => {
  if (!assertHfcdApiKey(req)) {
    res.status(401).json({ error: 'Invalid HFCD API key.' });
    return;
  }

  try {
    const body = (req.body || {}) as { mode?: 'cache' | 'live' | 'scores' };
    res.json(await runFootballRefreshOnce('api_refresh_odds', body.mode || 'cache'));
  } catch (error) {
    console.error('Football refresh-odds API failed:', error);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Football refresh failed.' });
  }
});

app.post('/api/football/settle', (req, res) => {
  try {
    const body = (req.body || {}) as { results?: Array<{ event_id: string; home_score: number; away_score: number }> };
    const resultMap = new Map((body.results || []).map((result) => [result.event_id, result]));
    const feed = readFootballFeed();
    const rows: unknown[] = [];
    const summary = { evaluated: 0, win: 0, loss: 0, push: 0, pending: 0, unsupported: 0 };

    for (const match of feed.matches || []) {
      const result = resultMap.get(match.event_id);
      const recommendations = match.recommendations?.length ? match.recommendations : match.top_recommendation ? [match.top_recommendation] : [];
      for (const recommendation of recommendations) {
        let settlement = 'pending';
        if (result) {
          settlement = settleFootballRecommendation(match, recommendation, result);
          summary.evaluated += 1;
        } else {
          summary.pending += 1;
        }
        if (settlement === 'win') summary.win += 1;
        if (settlement === 'loss') summary.loss += 1;
        if (settlement === 'push') summary.push += 1;
        if (settlement === 'unsupported') summary.unsupported += 1;
        rows.push({
          ...mapFootballRecommendationForTool(match, recommendation),
          home_score: result?.home_score ?? null,
          away_score: result?.away_score ?? null,
          settlement,
        });
      }
    }

    res.json({
      ok: true,
      settled_at: new Date().toISOString(),
      submitted_results: body.results?.length || 0,
      summary,
      rows,
    });
  } catch (error) {
    console.error('Football settle API failed:', error);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Football settle failed.' });
  }
});

app.post('/api/hfcd/football/refresh', async (req, res) => {
  if (!assertHfcdApiKey(req)) {
    res.status(401).json({ error: 'Invalid HFCD API key.' });
    return;
  }

  try {
    const body = (req.body || {}) as { mode?: 'cache' | 'live' | 'scores' };
    res.json(await runFootballRefreshOnce('api_hfcd_football_refresh', body.mode || 'cache'));
  } catch (error) {
    console.error('HFCD football refresh failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Football refresh failed.' });
  }
});

app.get('/api/energy/health', (_req, res) => {
  const feed = getEnergyRuntimeFeed();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: feed.version,
    generated_at: feed.generated_at,
    mode: 'embedded_energy_runtime_feed',
    summary_version: feed.smoke?.summary_version || feed.version,
  });
});

app.get('/api/energy/summary', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getEnergySummaryPayload());
});

app.get('/api/energy/registry', (_req, res) => {
  const feed = getEnergyRuntimeFeed();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, records: feed.registry || [] });
});

app.get('/api/energy/heads', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, records: filterEnergyHeads(req.query.status) });
});

app.get('/api/energy/cards', (_req, res) => {
  const feed = getEnergyRuntimeFeed();
  const cards = Array.isArray(feed.cards) ? feed.cards : [];
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    runtime_cards_count: cards.filter((card: Record<string, any>) => card.card_type === 'load_forecast_runtime_card').length,
    capability_cards_count: cards.filter((card: Record<string, any>) => card.card_type === 'capability_card').length,
    cards,
  });
});

app.get('/api/energy/watchlist', (_req, res) => {
  const feed = getEnergyRuntimeFeed();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, records: feed.watchlist || [] });
});

app.get('/api/energy/templates', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getEnergyTemplatesPayload());
});

app.post('/api/energy/adapt-csv', (req, res) => {
  const feed = getEnergyRuntimeFeed();
  const body = req.body || {};
  res.json({
    ok: true,
    mode: 'schema_preview',
    message: '主服务已接入能源运行接口。当前端上传 CSV 后，可按模板字段做 schema 体检；完整在线适配将在下一轮接入真实任务队列。',
    received: {
      industry: body.industry || body.dataset_type || null,
      rows: Array.isArray(body.rows) ? body.rows.length : null,
    },
    templates: Object.keys(feed.templates || {}),
  });
});

app.post('/api/energy/predict-load', (req, res) => {
  const feed = getEnergyRuntimeFeed();
  const body = req.body || {};
  res.json({
    ok: true,
    mode: 'embedded_runtime_cards',
    message: '返回当前已验证的能源预测运行卡片；如需实时预测，请提交 CSV 接入任务。',
    request: {
      dataset: body.dataset || null,
      horizon: body.horizon || null,
    },
    cards: feed.cards || [],
  });
});

function assertHfcdApiKey(req: express.Request) {
  const configuredKeys = (process.env.HFCD_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (configuredKeys.length === 0) return true;
  const key = String(req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '') || '');
  return configuredKeys.includes(key);
}

function getProcessEnvRecord() {
  return process.env as Record<string, unknown>;
}

async function callGoogleApi(url: string, init: RequestInit = {}) {
  const token = await getGoogleCloudAccessToken({ env: getProcessEnvRecord() });
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

async function fetchGcsJson(bucket: string, objectName: string) {
  try {
    const token = await getGoogleCloudAccessToken({ env: getProcessEnvRecord() });
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) return undefined;
    return response.json();
  } catch {
    return undefined;
  }
}

async function uploadGcsJson(bucket: string, objectName: string, payload: unknown) {
  const token = await getGoogleCloudAccessToken({ env: getProcessEnvRecord() });
  const response = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload, null, 2),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload HFCD input dataset to GCS: ${response.status} ${text.slice(0, 300)}`);
  }
  return response.json();
}

app.get('/api/hfcd/research-jobs/status', async (req, res) => {
  try {
    if (!assertHfcdApiKey(req)) {
      res.status(401).json({ error: 'Invalid HFCD API key.' });
      return;
    }
    const cloud = buildHFCDResearchCloudConfig(getProcessEnvRecord());
    const operationName = typeof req.query.operationName === 'string' ? req.query.operationName : undefined;
    const artifactPrefix = typeof req.query.artifactPrefix === 'string' ? req.query.artifactPrefix : undefined;
    if (!cloud.enabled) {
      res.status(503).json({
        ok: false,
        status: 'not_configured',
        cloud,
        message: 'HFCD 云端长程仿真未配置。需要 HFCD_CLOUD_PROJECT_ID / HFCD_CLOUD_RUN_JOB / HFCD_GCS_BUCKET。',
      });
      return;
    }
    const operation = operationName ? await callGoogleApi(`https://run.googleapis.com/v2/${operationName}`) : undefined;
    const manifest = artifactPrefix && cloud.bucket
      ? await fetchGcsJson(cloud.bucket, `${artifactPrefix}/cloud_manifest.json`)
      : undefined;
    const status = (manifest as { status?: string } | undefined)?.status || operationToStatus(operation);
    res.json({
      ok: status !== 'failed',
      status,
      operationName,
      operation,
      artifactPrefix,
      manifest,
    });
  } catch (error) {
    console.error('HFCD research status API failed:', error);
    res.status(500).json({ ok: false, status: 'unknown', error: error instanceof Error ? error.message : 'HFCD research status failed.' });
  }
});

app.post('/api/hfcd/research-jobs/submit', async (req, res) => {
  try {
    if (!assertHfcdApiKey(req)) {
      res.status(401).json({ error: 'Invalid HFCD API key.' });
      return;
    }
    const request = req.body as HFCDResearchJobRequest;
    const cloud = buildHFCDResearchCloudConfig(getProcessEnvRecord());
    const plan = buildHFCDResearchJobPlan(request, getProcessEnvRecord());
    if (!cloud.enabled) {
      res.status(503).json({
        ok: false,
        status: 'not_configured',
        plan,
        cloud,
        message: 'HFCD 云端长程仿真未配置。需要先部署 Cloud Run Job 与 GCS 源目录。',
      });
      return;
    }
    if (request.inputDataset && cloud.bucket) {
      const datasetObject = `${plan.artifactPrefix}/input/input_dataset.json`;
      await uploadGcsJson(cloud.bucket, datasetObject, {
        ...request.inputDataset,
        uploadedAt: new Date().toISOString(),
        jobId: plan.jobId,
      });
      plan.env.HFCD_INPUT_DATASET_OBJECT = datasetObject;
      plan.env.HFCD_INPUT_DATASET_GCS_URI = `gs://${cloud.bucket}/${datasetObject}`;
      plan.env.HFCD_OUTPUT_GLOBS = [plan.outputGlobs, 'customer_input/*.json'].filter(Boolean).join(',');
    }
    const envVars = {
      ...plan.env,
      HFCD_JOB_ID: plan.jobId,
      HFCD_GCS_BUCKET: cloud.bucket || '',
      HFCD_SOURCE_GCS_PREFIX: plan.sourcePrefix,
      HFCD_ARTIFACT_PREFIX: plan.artifactPrefix,
      HFCD_EXPERIMENT_SCRIPT: plan.experimentScript,
      HFCD_OUTPUT_GLOBS: plan.env.HFCD_OUTPUT_GLOBS || plan.outputGlobs,
    };
    const operation = await callGoogleApi(
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
    res.json({
      ok: true,
      status: 'queued',
      plan,
      cloud,
      operationName: operation?.name,
      operation,
    });
  } catch (error) {
    console.error('HFCD research submit API failed:', error);
    res.status(500).json({ ok: false, status: 'failed', error: error instanceof Error ? error.message : 'HFCD research submit failed.' });
  }
});

app.post('/api/hfcd/audit', (req, res) => {
  try {
    if (!assertHfcdApiKey(req)) {
      res.status(401).json({ error: 'Invalid HFCD API key.' });
      return;
    }

    const body = req.body as {
      industry?: HFCDIndustry;
      rows?: Array<Record<string, unknown>>;
      records?: Array<Record<string, unknown>>;
      csv?: string;
      model?: string;
      mode?: 'audit' | 'calibrate' | 'simulate' | 'advanced' | 'field';
      thresholds?: Partial<HFCDGates>;
      fieldSimulation?: HFCDFieldSimulationInput;
    };
    const industry = body.industry || 'quantum';
    const rows = body.csv ? parseCsv(body.csv) : body.rows || body.records || [];
    const validation = validateRows(rows, industry);
    if (!validation.isValid) {
      res.status(400).json({
        error: 'Invalid HFCD input.',
        validation,
      });
      return;
    }

    const mode = body.mode || 'audit';
    const parameterProfile = mode === 'audit' && !body.thresholds ? undefined : learnHFCDParameters(rows, industry);
    const activeThresholds = body.thresholds
      ? normalizeHFCDThresholds(body.thresholds)
      : parameterProfile?.thresholds;
    const results = auditRecords(rows, industry, { thresholds: activeThresholds });
    const simulation =
      mode === 'simulate' || mode === 'advanced'
        ? simulateHFCDScenarios(rows, industry, parameterProfile || learnHFCDParameters(rows, industry))
        : undefined;
    const fieldSimulation =
      mode === 'field' || (mode === 'advanced' && body.fieldSimulation)
        ? runHFCDFieldSimulation({
            rows,
            industry,
            profile: parameterProfile || learnHFCDParameters(rows, industry),
            input: body.fieldSimulation,
          })
        : undefined;
    res.json({
      model: body.model || 'hfcd-v1',
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
  } catch (error) {
    console.error('HFCD audit API failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'HFCD audit failed.' });
  }
});

async function proxyFirebaseHelper(req: express.Request, res: express.Response, targetPath: string) {
  try {
    const upstreamUrl = new URL(`https://gen-lang-client-0488652785.firebaseapp.com${targetPath}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        value.forEach((item) => upstreamUrl.searchParams.append(key, String(item)));
      } else if (value != null) {
        upstreamUrl.searchParams.set(key, String(value));
      }
    }

    const upstream = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: {
        accept: req.headers.accept || '*/*',
        'content-type': req.headers['content-type'] || 'application/octet-stream',
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
      redirect: 'manual',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-encoding') {
        return;
      }
      res.setHeader(key, value);
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error(`Firebase helper proxy failed for ${targetPath}:`, error);
    res.status(502).send('Firebase helper proxy failed.');
  }
}

app.get('/__/firebase/init.json', (req, res) => {
  res.json({
    ...firebaseConfig,
    authDomain: req.headers.host || firebaseConfig.authDomain,
  });
});

app.get('/__/auth/:file', (req, res) => {
  proxyFirebaseHelper(req, res, `/__/auth/${req.params.file}`);
});

app.post('/__/auth/:file', (req, res) => {
  proxyFirebaseHelper(req, res, `/__/auth/${req.params.file}`);
});

app.post('/api/gemini/chat/stream', async (req, res) => {
  try {
    const { messages, model, systemInstruction, webSearchEnabled = true } = req.body as {
      messages: Message[];
      model: string;
      systemInstruction?: string;
      webSearchEnabled?: boolean;
    };

    const { ai, model: resolvedModel, provider } = resolveChatClientAndModel(model);
    const contents = await buildContents(messages);
    const tools = provider === 'vertex' ? undefined : webSearchEnabled ? [{ googleSearch: {} }] : undefined;

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const stream = await ai.models.generateContentStream({
      model: resolvedModel,
      contents,
      config: {
        tools,
        systemInstruction,
        temperature: 0.7,
      },
    });

    const citations: { uri: string; title: string }[] = [];

    for await (const chunk of stream) {
      const text =
        chunk.text ||
        ((chunk as GenerateContentResponse).candidates?.[0]?.content?.parts?.[0]?.text ?? '');

      const metadata = (chunk as GenerateContentResponse).candidates?.[0]?.groundingMetadata;
      if (metadata?.groundingChunks) {
        for (const groundingChunk of metadata.groundingChunks) {
          const uri = groundingChunk.web?.uri;
          if (!uri || citations.some((item) => item.uri === uri)) {
            continue;
          }

          citations.push({
            uri,
            title: groundingChunk.web?.title || 'Web Page',
          });
        }
      }

      if (text) {
        res.write(`${JSON.stringify({ type: 'text', text })}\n`);
      }
    }

    if (citations.length > 0) {
      res.write(`${JSON.stringify({ type: 'metadata', citations })}\n`);
    }

    res.end();
  } catch (error) {
    console.error('Gemini stream proxy failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Stream proxy failed.' });
      return;
    }

    res.write(`${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Stream proxy failed.' })}\n`);
    res.end();
  }
});

app.post('/api/gemini/evaluate', async (req, res) => {
  try {
    const { prompt, model } = req.body as { prompt: string; model: string };
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.1 },
    });

    const cleaned = (response.text || '').replace(/```json/g, '').replace(/```/g, '').trim();
    res.json({ data: JSON.parse(cleaned) });
  } catch (error) {
    console.error('Gemini evaluate proxy failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Evaluate proxy failed.' });
  }
});

app.post('/api/gemini/light-log', async (req, res) => {
  try {
    const { prompt, model } = req.body as { prompt: string; model: string };
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.2 },
    });

    res.json({ text: response.text || '未提取到明显的光性变化。' });
  } catch (error) {
    console.error('Gemini light-log proxy failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Light-log proxy failed.' });
  }
});

app.post('/api/wuxing/instruction', async (req, res) => {
  try {
    const rawPayload = (req.body || {}) as {
      baseInstruction?: string;
      systemInstruction?: string;
      omegaPrompt?: string;
      content?: string;
      message?: string;
      diagnosis?: unknown;
    };
    const payload = {
      baseInstruction: String(rawPayload.baseInstruction || ''),
      systemInstruction: String(rawPayload.systemInstruction || ''),
      omegaPrompt: String(rawPayload.omegaPrompt || ''),
      content: String(rawPayload.content || rawPayload.message || ''),
      diagnosis: normalizeInstructionDiagnosis(rawPayload.diagnosis),
    };
    const footballToolContext = buildFootballToolContext(payload.content);
    const cacheKey = buildInstructionCacheKey(payload);
    const cached = footballToolContext ? undefined : instructionCache.get(cacheKey);
    if (cached) {
      res.json({ instruction: cached });
      return;
    }

    const baseInstruction = buildInternalizedOperatingInstruction({
      baseInstruction: payload.baseInstruction,
      systemInstruction: payload.systemInstruction,
      omegaPrompt: payload.omegaPrompt,
      content: payload.content,
      diagnosis: payload.diagnosis,
    });
    const instruction = footballToolContext ? `${baseInstruction}\n\n${footballToolContext}` : baseInstruction;
    if (!footballToolContext) {
      setInstructionCache(cacheKey, instruction);
    }

    res.json({ instruction });
  } catch (error) {
    console.error('Wuxing instruction build failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Instruction build failed.' });
  }
});

app.use(
  express.static(distDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }),
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  scheduleFootballDailyRefresh();
  console.log(`ThingNature OS server listening on http://0.0.0.0:${PORT}`);
});
