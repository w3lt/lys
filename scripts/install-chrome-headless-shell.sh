#!/usr/bin/env bash
# Installs the Chrome Headless Shell that read_page runs every read in.
#
# Usage: scripts/install-chrome-headless-shell.sh <destination-directory>
#
# The version is the one the backend's installed playwright-core is built
# for, read from its browsers.json, so run `pnpm install` first. The build
# comes from Chrome for Testing over HTTPS only. Its archive must match the
# SHA-256 recorded for that version and platform in
# scripts/chrome-headless-shell-checksums.txt before it is unzipped, and the
# browser it holds must then report that version. A destination that already
# holds that version is left as it is. Otherwise its previous contents are
# replaced, and only after the new browser has been downloaded and checked.
# Afterwards <destination-directory>/chrome-headless-shell is the executable.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <destination-directory>" >&2
  exit 2
fi

DESTINATION_DIR="$1"
REPOSITORY_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLAYWRIGHT_BROWSERS_FILE="$REPOSITORY_ROOT/apps/backend/node_modules/playwright-core/browsers.json"
CHECKSUMS_FILE="$REPOSITORY_ROOT/scripts/chrome-headless-shell-checksums.txt"
EXECUTABLE_NAME="chrome-headless-shell"
# curl --proto value that allows only HTTPS transfers
readonly CURL_HTTPS_ONLY_PROTOCOLS="=https"

if [[ ! -f "$PLAYWRIGHT_BROWSERS_FILE" ]]; then
  echo "playwright-core is not installed; run pnpm install first" >&2
  exit 1
fi

BROWSER_VERSION=$(jq -er '.browsers[] | select(.name == "chromium-headless-shell") | .browserVersion' "$PLAYWRIGHT_BROWSERS_FILE")
EXPECTED_VERSION_TEXT="Google Chrome for Testing $BROWSER_VERSION"

get_browser_platform() {
  case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) echo "mac-arm64" ;;
  Darwin/x86_64) echo "mac-x64" ;;
  Linux/x86_64 | Linux/amd64) echo "linux64" ;;
  *)
    echo "Unsupported platform for Chrome Headless Shell: $(uname -s)/$(uname -m)" >&2
    return 1
    ;;
  esac
}

# Prints the version an executable reports, or nothing when it cannot run.
get_browser_version() {
  local executable_path="$1"
  if [[ -x "$executable_path" ]]; then
    "$executable_path" --version 2>/dev/null || true
  fi
}

# Prints the SHA-256 of a file in hexadecimal.
calculate_file_sha256() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | cut -d ' ' -f 1
  else
    shasum -a 256 "$file_path" | cut -d ' ' -f 1
  fi
}

if [[ "$(get_browser_version "$DESTINATION_DIR/$EXECUTABLE_NAME")" == "$EXPECTED_VERSION_TEXT" ]]; then
  echo "Chrome Headless Shell $BROWSER_VERSION already installed in $DESTINATION_DIR"
  exit 0
fi

BROWSER_PLATFORM=$(get_browser_platform)
EXPECTED_SHA256=$(awk -v version="$BROWSER_VERSION" -v platform="$BROWSER_PLATFORM" \
  '$1 == version && $2 == platform { print $3 }' "$CHECKSUMS_FILE")
if [[ -z "$EXPECTED_SHA256" ]]; then
  echo "No SHA-256 is recorded for Chrome Headless Shell $BROWSER_VERSION on $BROWSER_PLATFORM in $CHECKSUMS_FILE" >&2
  exit 1
fi
ARCHIVE_NAME="chrome-headless-shell-$BROWSER_PLATFORM.zip"
ARCHIVE_URL="https://storage.googleapis.com/chrome-for-testing-public/$BROWSER_VERSION/$BROWSER_PLATFORM/$ARCHIVE_NAME"

mkdir -p "$(dirname "$DESTINATION_DIR")"
TMP_DIR=$(mktemp -d "$(dirname "$DESTINATION_DIR")/.chrome-headless-shell-download.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading Chrome Headless Shell $BROWSER_VERSION for $BROWSER_PLATFORM..."
curl --proto "$CURL_HTTPS_ONLY_PROTOCOLS" -fsSL --retry 3 -o "$TMP_DIR/$ARCHIVE_NAME" "$ARCHIVE_URL"
DOWNLOADED_SHA256=$(calculate_file_sha256 "$TMP_DIR/$ARCHIVE_NAME")
if [[ "$DOWNLOADED_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "The downloaded archive has SHA-256 $DOWNLOADED_SHA256, not the recorded $EXPECTED_SHA256" >&2
  exit 1
fi
unzip -q "$TMP_DIR/$ARCHIVE_NAME" -d "$TMP_DIR/extract"

EXTRACTED_DIR="$TMP_DIR/extract/chrome-headless-shell-$BROWSER_PLATFORM"
DOWNLOADED_VERSION_TEXT=$(get_browser_version "$EXTRACTED_DIR/$EXECUTABLE_NAME")
if [[ "$DOWNLOADED_VERSION_TEXT" != "$EXPECTED_VERSION_TEXT" ]]; then
  echo "The downloaded browser reports \"$DOWNLOADED_VERSION_TEXT\", not \"$EXPECTED_VERSION_TEXT\"" >&2
  exit 1
fi

rm -rf "$DESTINATION_DIR"
mv "$EXTRACTED_DIR" "$DESTINATION_DIR"
echo "Chrome Headless Shell ready: $DOWNLOADED_VERSION_TEXT at $DESTINATION_DIR/$EXECUTABLE_NAME"
