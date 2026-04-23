import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

type TuningConfig = {
  projectId: string;
  region: string;
  bucket: string;
  bucketPrefix: string;
  sftBaseModel: string;
  preferenceBaseModel: string;
  tunedModelDisplayNamePrefix: string;
  sftEpochCount: number;
  sftLearningRateMultiplier: number;
  sftAdapterSize: 'ADAPTER_SIZE_ONE' | 'ADAPTER_SIZE_FOUR' | 'ADAPTER_SIZE_EIGHT' | 'ADAPTER_SIZE_SIXTEEN';
  preferenceEpochCount: number;
  preferenceLearningRateMultiplier: number;
  preferenceAdapterSize: 'ADAPTER_SIZE_ONE' | 'ADAPTER_SIZE_FOUR' | 'ADAPTER_SIZE_EIGHT' | 'ADAPTER_SIZE_SIXTEEN';
  preferenceBeta: number;
  kmsKeyName?: string;
  serviceAccount?: string;
};

const ROOT = path.join(process.cwd(), 'training', 'vertex-ai');
const DATASET_DIR = path.join(ROOT, 'datasets');
const CONFIG_DIR = path.join(ROOT, 'config');
const REQUESTS_DIR = path.join(ROOT, 'requests');
const REPORTS_DIR = path.join(ROOT, 'reports');
const ENV_FILE = path.join(CONFIG_DIR, 'vertex.env');

dotenv.config({ path: ENV_FILE });

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function env(name: string, fallback = '') {
  return process.env[name] || fallback;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function loadConfig(): TuningConfig {
  return {
    projectId: required('VERTEX_PROJECT_ID'),
    region: env('VERTEX_REGION', 'us-central1'),
    bucket: required('VERTEX_GCS_BUCKET'),
    bucketPrefix: env('VERTEX_GCS_PREFIX', 'wuxing-training'),
    sftBaseModel: env('VERTEX_SFT_BASE_MODEL', 'gemini-2.5-flash'),
    preferenceBaseModel: env('VERTEX_PREFERENCE_BASE_MODEL', 'gemini-2.5-flash'),
    tunedModelDisplayNamePrefix: env('VERTEX_TUNED_MODEL_PREFIX', 'wuxing-os'),
    sftEpochCount: Number(env('VERTEX_SFT_EPOCHS', '3')),
    sftLearningRateMultiplier: Number(env('VERTEX_SFT_LR_MULTIPLIER', '1')),
    sftAdapterSize: (env('VERTEX_SFT_ADAPTER_SIZE', 'ADAPTER_SIZE_FOUR') as TuningConfig['sftAdapterSize']),
    preferenceEpochCount: Number(env('VERTEX_PREFERENCE_EPOCHS', '1')),
    preferenceLearningRateMultiplier: Number(env('VERTEX_PREFERENCE_LR_MULTIPLIER', '1')),
    preferenceAdapterSize: (env('VERTEX_PREFERENCE_ADAPTER_SIZE', 'ADAPTER_SIZE_FOUR') as TuningConfig['preferenceAdapterSize']),
    preferenceBeta: Number(env('VERTEX_PREFERENCE_BETA', '0.1')),
    kmsKeyName: env('VERTEX_KMS_KEY_NAME') || undefined,
    serviceAccount: env('VERTEX_SERVICE_ACCOUNT') || undefined,
  };
}

function gcsUri(config: TuningConfig, fileName: string) {
  return `gs://${config.bucket}/${config.bucketPrefix}/${fileName}`;
}

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function main() {
  ensureDir(REQUESTS_DIR);
  ensureDir(REPORTS_DIR);

  const config = loadConfig();
  if (!fs.existsSync(path.join(DATASET_DIR, 'sft-seed.train.jsonl'))) {
    throw new Error('Missing SFT dataset. Run `npm run vertex:prepare-training` first.');
  }
  if (!fs.existsSync(path.join(DATASET_DIR, 'preference-candidates.train.jsonl'))) {
    throw new Error('Missing preference dataset. Run `npm run vertex:prepare-preferences` first.');
  }

  const sftTrain = 'sft-seed.train.jsonl';
  const sftValidation = 'sft-seed.validation.jsonl';
  const prefTrain = 'preference-candidates.train.jsonl';
  const prefValidation = 'preference-candidates.validation.jsonl';

  const sftRequest = {
    baseModel: config.sftBaseModel,
    supervisedTuningSpec: {
      training_dataset_uri: gcsUri(config, sftTrain),
      validation_dataset_uri: gcsUri(config, sftValidation),
      hyper_parameters: {
        epoch_count: config.sftEpochCount,
        learning_rate_multiplier: config.sftLearningRateMultiplier,
        adapter_size: config.sftAdapterSize,
      },
    },
    tunedModelDisplayName: `${config.tunedModelDisplayNamePrefix}-sft`,
  };
  if (config.kmsKeyName) {
    Object.assign(sftRequest, { encryptionSpec: { kmsKeyName: config.kmsKeyName } });
  }
  if (config.serviceAccount) {
    Object.assign(sftRequest, { serviceAccount: config.serviceAccount });
  }

  const preferenceRequest = {
    baseModel: config.preferenceBaseModel,
    preferenceOptimizationSpec: {
      trainingDatasetUri: gcsUri(config, prefTrain),
      validationDatasetUri: gcsUri(config, prefValidation),
      hyperParameters: {
        epochCount: config.preferenceEpochCount,
        beta: config.preferenceBeta,
        adapterSize: config.preferenceAdapterSize,
        learningRateMultiplier: config.preferenceLearningRateMultiplier,
      },
      exportLastCheckpointOnly: true,
    },
    tunedModelDisplayName: `${config.tunedModelDisplayNamePrefix}-preference`,
  };
  if (config.kmsKeyName) {
    Object.assign(preferenceRequest, { encryptionSpec: { kmsKeyName: config.kmsKeyName } });
  }
  if (config.serviceAccount) {
    Object.assign(preferenceRequest, { serviceAccount: config.serviceAccount });
  }

  writeJson(path.join(REQUESTS_DIR, 'sft.request.json'), sftRequest);
  writeJson(path.join(REQUESTS_DIR, 'preference.request.json'), preferenceRequest);

  const runbook = [
    '# Vertex AI Tuning Runbook',
    '',
    `- Project: \`${config.projectId}\``,
    `- Region: \`${config.region}\``,
    `- Bucket: \`gs://${config.bucket}/${config.bucketPrefix}/\``,
    `- Env file: \`${ENV_FILE}\``,
    '',
    '## 1. Fill env',
    '- Copy `training/vertex-ai/config/vertex.env.example` to `training/vertex-ai/config/vertex.env`',
    '- Fill `VERTEX_PROJECT_ID`, `VERTEX_GCS_BUCKET`, and optional `VERTEX_SERVICE_ACCOUNT` / `VERTEX_KMS_KEY_NAME`',
    '',
    '## 2. Upload datasets',
    `- sft train: \`${gcsUri(config, sftTrain)}\``,
    `- sft validation: \`${gcsUri(config, sftValidation)}\``,
    `- preference train: \`${gcsUri(config, prefTrain)}\``,
    `- preference validation: \`${gcsUri(config, prefValidation)}\``,
    '',
    '```bash',
    'npm run vertex:stage',
    '```',
    '',
    '## 3. Submit supervised fine-tuning job',
    '```bash',
    'npm run vertex:submit:sft',
    '```',
    '',
    `curl -X POST \\`,
    `  -H "Authorization: Bearer $(gcloud auth print-access-token)" \\`,
    `  -H "Content-Type: application/json; charset=utf-8" \\`,
    `  -d @training/vertex-ai/requests/sft.request.json \\`,
    `  "https://${config.region}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.region}/tuningJobs"`,
    '',
    '## 4. Submit preference tuning job',
    '```bash',
    'npm run vertex:submit:preference',
    '```',
    '',
    `curl -X POST \\`,
    `  -H "Authorization: Bearer $(gcloud auth print-access-token)" \\`,
    `  -H "Content-Type: application/json; charset=utf-8" \\`,
    `  -d @training/vertex-ai/requests/preference.request.json \\`,
    `  "https://${config.region}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.region}/tuningJobs"`,
    '',
    '## 5. List tuning jobs',
    `curl -X GET \\`,
    `  -H "Authorization: Bearer $(gcloud auth print-access-token)" \\`,
    `  "https://${config.region}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.region}/tuningJobs"`,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(REPORTS_DIR, 'vertex-runbook.md'), `${runbook}\n`, 'utf8');
  console.log('[vertex-requests] wrote request JSON files and runbook');
}

main();
