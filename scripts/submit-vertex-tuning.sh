#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ "${MODE}" != "sft" && "${MODE}" != "preference" ]]; then
  echo "Usage: scripts/submit-vertex-tuning.sh [sft|preference]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/training/vertex-ai/config/vertex.env"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

: "${VERTEX_PROJECT_ID:?Set VERTEX_PROJECT_ID in training/vertex-ai/config/vertex.env}"
VERTEX_REGION="${VERTEX_REGION:-us-central1}"

REQUEST_FILE="${ROOT_DIR}/training/vertex-ai/requests/${MODE}.request.json"

if [[ ! -f "${REQUEST_FILE}" ]]; then
  echo "Missing request file: ${REQUEST_FILE}"
  echo "Run: npm run vertex:render-requests"
  exit 1
fi

gcloud config set project "${VERTEX_PROJECT_ID}" >/dev/null

echo "[vertex-submit] submitting ${MODE} tuning job"
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d @"${REQUEST_FILE}" \
  "https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_REGION}/tuningJobs"
echo
