export type HFCDResearchPreset = 'v12_38_me28800' | 'v12_37_meprc' | 'custom';

export type HFCDResearchJobStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'not_configured'
  | 'unknown';

export interface HFCDResearchJobRequest {
  preset?: HFCDResearchPreset;
  projectName?: string;
  sourceMode?: 'best101' | 'repair' | 'all' | string;
  maxVariants?: number;
  topCheckpoints?: number;
  logInterval?: number;
  resume?: boolean;
  smoke?: boolean;
  experimentScript?: string;
  outputGlobs?: string;
  env?: Record<string, string | number | boolean>;
}

export interface HFCDResearchJobPlan {
  jobId: string;
  projectName: string;
  preset: HFCDResearchPreset;
  experimentScript: string;
  artifactPrefix: string;
  sourcePrefix: string;
  outputGlobs: string;
  env: Record<string, string>;
  createdAt: number;
  description: string;
}

export interface HFCDResearchCloudConfig {
  enabled: boolean;
  projectId?: string;
  region?: string;
  cloudRunJob?: string;
  bucket?: string;
  sourcePrefix?: string;
}

export interface HFCDResearchJobSubmission {
  ok: boolean;
  status: HFCDResearchJobStatus;
  plan: HFCDResearchJobPlan;
  cloud: HFCDResearchCloudConfig;
  operationName?: string;
  operation?: unknown;
  message?: string;
}

export interface HFCDResearchJobStatusResponse {
  ok: boolean;
  status: HFCDResearchJobStatus;
  operationName?: string;
  operation?: unknown;
  artifactPrefix?: string;
  manifest?: unknown;
  message?: string;
}

const PRESETS: Record<Exclude<HFCDResearchPreset, 'custom'>, {
  script: string;
  description: string;
  outputGlobs: string;
  env: Record<string, string>;
}> = {
  v12_38_me28800: {
    script: 'wuxing_hfcd_v12_38_post27000_micro_energy_28800.py',
    description: 'V12.38 post-27000 micro-energy 28800 checkpoint continuation.',
    outputGlobs: [
      '物性论_HFCD_V12.38_Post27000_ME28800*',
      'HFCD_V12.38_28800_checkpoints/*.pkl',
    ].join(','),
    env: {
      HFCD_V1238_SOURCE_MODE: 'best101',
      HFCD_V1238_RESUME: '1',
      HFCD_V1238_LOG_INTERVAL: '900',
    },
  },
  v12_37_meprc: {
    script: 'wuxing_hfcd_v12_37_post25200_micro_energy_peak_radius_closure.py',
    description: 'V12.37 post-25200 micro-energy peak-radius closure continuation.',
    outputGlobs: [
      '物性论_HFCD_V12.37_Post25200_MEPRC*',
      'HFCD_V12.37_27000_checkpoints/*.pkl',
    ].join(','),
    env: {
      HFCD_V1237_RESUME: '1',
      HFCD_V1237_LOG_INTERVAL: '900',
    },
  },
};

function safeToken(input: string) {
  return input
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase() || 'hfcd';
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function stringifyEnvValue(value: string | number | boolean) {
  return String(value);
}

export function buildHFCDResearchCloudConfig(env: Record<string, unknown>): HFCDResearchCloudConfig {
  const projectId = String(env.HFCD_CLOUD_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.VERTEX_PROJECT_ID || '').trim();
  const region = String(env.HFCD_CLOUD_REGION || env.GOOGLE_CLOUD_REGION || env.VERTEX_REGION || 'us-central1').trim();
  const cloudRunJob = String(env.HFCD_CLOUD_RUN_JOB || '').trim();
  const bucket = String(env.HFCD_GCS_BUCKET || '').trim();
  const sourcePrefix = String(env.HFCD_SOURCE_GCS_PREFIX || 'hfcd/source/current').replace(/^\/+|\/+$/g, '');
  return {
    enabled: Boolean(projectId && region && cloudRunJob && bucket),
    projectId,
    region,
    cloudRunJob,
    bucket,
    sourcePrefix,
  };
}

export function buildHFCDResearchJobPlan(
  request: HFCDResearchJobRequest = {},
  env: Record<string, unknown> = {},
  now = Date.now(),
): HFCDResearchJobPlan {
  const preset = request.preset || 'v12_38_me28800';
  const presetConfig = preset === 'custom' ? undefined : PRESETS[preset];
  const projectName = request.projectName?.trim() || 'HFCD 研究级长程仿真';
  const experimentScript =
    request.experimentScript?.trim() ||
    presetConfig?.script ||
    'wuxing_hfcd_v12_38_post27000_micro_energy_28800.py';
  const cloud = buildHFCDResearchCloudConfig(env);
  const jobId = `hfcd-${safeToken(preset)}-${now.toString(36)}`;
  const artifactPrefix = `hfcd/research-jobs/${jobId}`;
  const outputGlobs = request.outputGlobs?.trim() || presetConfig?.outputGlobs || '物性论_HFCD_*,HFCD_*_checkpoints/*.pkl';
  const envVars: Record<string, string> = {
    ...(presetConfig?.env || {}),
    HFCD_SOURCE_MODE: String(request.sourceMode || ''),
    HFCD_JOB_PROJECT_NAME: projectName,
  };

  if (request.sourceMode) {
    if (preset === 'v12_38_me28800') envVars.HFCD_V1238_SOURCE_MODE = String(request.sourceMode);
  }
  if (request.maxVariants !== undefined) {
    const maxVariants = clampInt(request.maxVariants, 0, 0, 64);
    if (preset === 'v12_38_me28800') envVars.HFCD_V1238_MAX_VARIANTS = String(maxVariants);
    if (preset === 'v12_37_meprc') envVars.HFCD_V1237_MAX_VARIANTS = String(maxVariants);
  }
  if (request.topCheckpoints !== undefined) {
    const topCheckpoints = clampInt(request.topCheckpoints, 0, 0, 500);
    if (preset === 'v12_38_me28800') envVars.HFCD_V1238_TOP_CHECKPOINTS = String(topCheckpoints);
    if (preset === 'v12_37_meprc') envVars.HFCD_V1237_TOP_CHECKPOINTS = String(topCheckpoints);
  }
  if (request.logInterval !== undefined) {
    const logInterval = clampInt(request.logInterval, 900, 30, 7200);
    if (preset === 'v12_38_me28800') envVars.HFCD_V1238_LOG_INTERVAL = String(logInterval);
    if (preset === 'v12_37_meprc') envVars.HFCD_V1237_LOG_INTERVAL = String(logInterval);
  }
  if (request.resume !== undefined) {
    const resume = request.resume ? '1' : '0';
    if (preset === 'v12_38_me28800') envVars.HFCD_V1238_RESUME = resume;
    if (preset === 'v12_37_meprc') envVars.HFCD_V1237_RESUME = resume;
  }
  if (request.smoke) {
    if (preset === 'v12_38_me28800') {
      envVars.HFCD_V1238_MAX_VARIANTS = envVars.HFCD_V1238_MAX_VARIANTS || '1';
      envVars.HFCD_V1238_TOP_CHECKPOINTS = envVars.HFCD_V1238_TOP_CHECKPOINTS || '1';
      envVars.HFCD_V1238_LOG_INTERVAL = '60';
    }
    if (preset === 'v12_37_meprc') {
      envVars.HFCD_V1237_MAX_VARIANTS = envVars.HFCD_V1237_MAX_VARIANTS || '1';
      envVars.HFCD_V1237_TOP_CHECKPOINTS = envVars.HFCD_V1237_TOP_CHECKPOINTS || '1';
      envVars.HFCD_V1237_LOG_INTERVAL = '60';
    }
  }
  for (const [key, value] of Object.entries(request.env || {})) {
    if (/^[A-Z0-9_]+$/.test(key)) {
      envVars[key] = stringifyEnvValue(value);
    }
  }

  return {
    jobId,
    projectName,
    preset,
    experimentScript,
    artifactPrefix,
    sourcePrefix: cloud.sourcePrefix || 'hfcd/source/current',
    outputGlobs,
    env: envVars,
    createdAt: now,
    description: presetConfig?.description || 'Custom HFCD long-run Python experiment.',
  };
}
