#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${HFCD_CLOUD_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-gen-lang-client-0488652785}}"
REGION="${HFCD_CLOUD_REGION:-us-central1}"
BUCKET="${HFCD_GCS_BUCKET:-${PROJECT_ID}-hfcd-research}"
JOB_NAME="${HFCD_CLOUD_RUN_JOB:-hfcd-research-runner}"
SOURCE_PREFIX="${HFCD_SOURCE_GCS_PREFIX:-hfcd/source/current}"
IMAGE="gcr.io/${PROJECT_ID}/${JOB_NAME}:latest"

echo "Configuring project $PROJECT_ID"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "Enabling required Google Cloud APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  containerregistry.googleapis.com \
  artifactregistry.googleapis.com

if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  echo "Creating bucket gs://${BUCKET}"
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION"
fi

echo "Building Cloud Run runner image: $IMAGE"
gcloud builds submit cloud/hfcd-runner --tag "$IMAGE"

COMMON_FLAGS=(
  --image "$IMAGE"
  --region "$REGION"
  --cpu "2"
  --memory "4Gi"
  --task-timeout "3600"
  --max-retries "0"
  --set-env-vars "HFCD_GCS_BUCKET=${BUCKET},HFCD_SOURCE_GCS_PREFIX=${SOURCE_PREFIX}"
)

if gcloud run jobs describe "$JOB_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Updating Cloud Run Job: $JOB_NAME"
  gcloud run jobs update "$JOB_NAME" "${COMMON_FLAGS[@]}"
else
  echo "Creating Cloud Run Job: $JOB_NAME"
  gcloud run jobs create "$JOB_NAME" "${COMMON_FLAGS[@]}"
fi

cat <<EOF

Cloud HFCD runner ready.

Use these Worker vars:
HFCD_CLOUD_PROJECT_ID=${PROJECT_ID}
HFCD_CLOUD_REGION=${REGION}
HFCD_CLOUD_RUN_JOB=${JOB_NAME}
HFCD_GCS_BUCKET=${BUCKET}
HFCD_SOURCE_GCS_PREFIX=${SOURCE_PREFIX}
EOF
