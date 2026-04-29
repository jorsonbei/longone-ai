#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${HFCD_CLOUD_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-gen-lang-client-0488652785}}"
BUCKET="${HFCD_GCS_BUCKET:-${PROJECT_ID}-hfcd-research}"
SOURCE_PREFIX="${HFCD_SOURCE_GCS_PREFIX:-hfcd/source/current}"
LOCAL_SOURCE="${HFCD_LOCAL_SOURCE:-/Users/beijisheng/Desktop/codex_wxl}"

if [[ ! -d "$LOCAL_SOURCE" ]]; then
  echo "HFCD local source directory not found: $LOCAL_SOURCE" >&2
  exit 1
fi

echo "Staging HFCD source:"
echo "  local:  $LOCAL_SOURCE"
echo "  remote: gs://$BUCKET/$SOURCE_PREFIX"

gsutil -m rsync -r \
  -x '(^|/)(__pycache__|node_modules|\.git|\.venv|venv|dist|build)(/|$)' \
  "$LOCAL_SOURCE" \
  "gs://$BUCKET/$SOURCE_PREFIX"

echo "HFCD source staged."
