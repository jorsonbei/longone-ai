#!/usr/bin/env zsh
set -euo pipefail

LABEL="com.longone.hfcd.crypto-testnet-v223"
DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$DST" >/dev/null 2>&1 || true
fi

rm -f "$DST"
echo "uninstalled: $LABEL"
