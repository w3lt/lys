#!/bin/sh
set -euo pipefail

URL="${1:?URL is required}"

case "$URL" in
http://* | https://*) ;;
*)
  echo "Error: Only HTTP and HTTPS URLs are supported" >&2
  exit 2
  ;;
esac

timeout 30s chromium-headless-shell \
  --no-sandbox \
  --disable-dev-shm-usage \
  --virtual-time-budget=10000 \
  --dump-dom "$URL" 2>/dev/null |
  python3 /app/parse_dom.py
