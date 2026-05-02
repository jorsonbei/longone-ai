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

const HFCD_FOOTBALL_ACCURACY_MODEL = 'HFCD_Football_V9_AccuracyFirstPredictor';

function getWorkerFootballFeed() {
  const feed = FOOTBALL_ACCURACY_FEED as any;
  return {
    ...feed,
    model_version: HFCD_FOOTBALL_ACCURACY_MODEL,
    accuracy_mode: true,
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
