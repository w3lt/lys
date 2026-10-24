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

# dump_dom.py writes to a file of its own rather than a pipe, so its exit code
# ends the script: in a pipeline, parse_dom.py's exit 1 on empty input would
# replace it, and the blocked-address code would never reach vmo.
HTML_FILE="$(mktemp)"
trap 'rm -f "$HTML_FILE"' EXIT

timeout 30s python3 /app/dump_dom.py "$URL" >"$HTML_FILE"
python3 /app/parse_dom.py <"$HTML_FILE"
