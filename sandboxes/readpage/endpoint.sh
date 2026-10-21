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

timeout 30s python3 /app/dump_dom.py "$URL" |
  python3 /app/parse_dom.py
