#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/training/vertex-ai/config/vertex.env"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

: "${VERTEX_PROJECT_ID:?Set VERTEX_PROJECT_ID in training/vertex-ai/config/vertex.env}"
: "${VERTEX_GCS_BUCKET:?Set VERTEX_GCS_BUCKET in training/vertex-ai/config/vertex.env}"

VERTEX_REGION="${VERTEX_REGION:-us-central1}"
VERTEX_GCS_PREFIX="${VERTEX_GCS_PREFIX:-wuxing-training}"

BASE_URI="gs://${VERTEX_GCS_BUCKET}/${VERTEX_GCS_PREFIX}"

gcloud config set project "${VERTEX_PROJECT_ID}" >/dev/null

echo "[vertex-stage] uploading datasets to ${BASE_URI}"
gcloud storage cp "${ROOT_DIR}/training/vertex-ai/datasets/sft-seed.train.jsonl" "${BASE_URI}/sft-seed.train.jsonl"
gcloud storage cp "${ROOT_DIR}/training/vertex-ai/datasets/sft-seed.validation.jsonl" "${BASE_URI}/sft-seed.validation.jsonl"
gcloud storage cp "${ROOT_DIR}/training/vertex-ai/datasets/preference-candidates.train.jsonl" "${BASE_URI}/preference-candidates.train.jsonl"
gcloud storage cp "${ROOT_DIR}/training/vertex-ai/datasets/preference-candidates.validation.jsonl" "${BASE_URI}/preference-candidates.validation.jsonl"
echo "[vertex-stage] done"
