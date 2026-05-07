#!/usr/bin/env zsh
set -euo pipefail

ROOT="/Users/beijisheng/Desktop/420/物性论os"
LABEL="com.longone.hfcd.crypto-testnet-v223"
SRC="$ROOT/ops/launchd/$LABEL.plist"
DST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$ROOT/outputs/hfcd_trading_v2_23_crypto_frequency_router_testnet_mirror"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$DST" >/dev/null 2>&1 || true
fi

cp "$SRC" "$DST"
plutil -lint "$DST"
launchctl bootstrap "gui/$(id -u)" "$DST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "installed: $DST"
echo "status: launchctl print gui/$(id -u)/$LABEL"
echo "logs: $ROOT/outputs/hfcd_trading_v2_23_crypto_frequency_router_testnet_mirror/launchd.out.log"
