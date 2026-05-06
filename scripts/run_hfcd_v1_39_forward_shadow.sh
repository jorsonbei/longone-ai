#!/bin/zsh
set -u

ROOT="/Users/beijisheng/Desktop/420/物性论os"
OUT_DIR="$ROOT/outputs/hfcd_trading_v1_39_gold_forward_paper_shadow"
LOG_DIR="$OUT_DIR/logs"
LOCK_DIR="$OUT_DIR/.v1_39_shadow.lock"

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] skip: previous V1.39 shadow run still active"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$ROOT" || exit 1

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] start HFCD V1.39 forward paper shadow"
npm run trading:v1.39:gold-forward-shadow
shadow_exit=$?
echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] exit HFCD V1.39 status=$shadow_exit"

audit_exit=0
if [ "$shadow_exit" -eq 0 ]; then
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] start HFCD V1.40 forward ledger audit"
  npm run trading:v1.40:forward-audit
  audit_exit=$?
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] exit HFCD V1.40 status=$audit_exit"
fi

if [ "$shadow_exit" -ne 0 ]; then
  exit "$shadow_exit"
fi
exit "$audit_exit"
