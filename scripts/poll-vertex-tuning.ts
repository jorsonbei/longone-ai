import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';

type TuningJob = {
  name: string;
  tunedModelDisplayName?: string;
  state?: string;
  createTime?: string;
  startTime?: string;
  endTime?: string;
  updateTime?: string;
  error?: {
    code?: number;
    message?: string;
  };
  tunedModel?: {
    model?: string;
  };
};

const ROOT = path.join(process.cwd(), 'training', 'vertex-ai');
const CONFIG_DIR = path.join(ROOT, 'config');
const REPORTS_DIR = path.join(ROOT, 'reports');
const ENV_FILE = path.join(CONFIG_DIR, 'vertex.env');
const STATUS_FILE = path.join(REPORTS_DIR, 'tuning-status.json');

dotenv.config({ path: ENV_FILE });

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function gcloud(args: string[]) {
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || '/opt/homebrew/bin/python3.11',
    },
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

async function fetchJobs(projectId: string, region: string): Promise<TuningJob[]> {
  const token = gcloud(['auth', 'print-access-token']);
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/tuningJobs`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Vertex tuning list failed with ${response.status}: ${await response.text()}`);
      }
      const parsed = (await response.json()) as { tuningJobs?: TuningJob[] };
      return parsed.tuningJobs || [];
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Vertex tuning list failed.');
}

async function main() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const projectId = required('VERTEX_PROJECT_ID');
  const region = process.env.VERTEX_REGION || 'us-central1';
  const jobs = await fetchJobs(projectId, region);
  const relevantJobs = jobs
    .filter((job) => job.tunedModelDisplayName?.startsWith(process.env.VERTEX_TUNED_MODEL_PREFIX || 'wuxing-os'))
    .sort((a, b) => (b.createTime || '').localeCompare(a.createTime || ''));

  const status = {
    projectId,
    region,
    generatedAt: new Date().toISOString(),
    jobs: relevantJobs.map((job) => ({
      name: job.name,
      displayName: job.tunedModelDisplayName,
      state: job.state,
      tunedModel: job.tunedModel?.model,
      createTime: job.createTime,
      startTime: job.startTime,
      endTime: job.endTime,
      updateTime: job.updateTime,
      error: job.error,
    })),
  };

  fs.writeFileSync(STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  for (const job of status.jobs) {
    const tunedModel = job.tunedModel ? ` | ${job.tunedModel}` : '';
    const error = job.error?.message ? ` | ERROR: ${job.error.message}` : '';
    console.log(`${job.displayName}: ${job.state}${tunedModel}${error}`);
  }
  console.log(`[vertex-poll] wrote ${STATUS_FILE}`);
}

main();
