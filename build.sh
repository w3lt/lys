#!/usr/bin/env bash
set -euo pipefail

# Only support macOS for now
TARGET_PLATFORM=$(uname -s)
if [[ "$TARGET_PLATFORM" != "Darwin" ]]; then
  echo "Skipping desktop app install (macOS only for now)"
  exit 0
fi

# Step 1: Run pnpm install --frozen-lockfile
pnpm install --frozen-lockfile

# Step 3: Build backend
pnpm run backend:build

# Step 4: Create $LYS_HOME
DEFAULT_LYS_HOME="$HOME/.lys"
LYS_HOME="${LYS_HOME:-$DEFAULT_LYS_HOME}"

mkdir -p "$LYS_HOME"

# Step 5: Create the runtime directory
mkdir -p "$LYS_HOME/runtime"

# Step 6: Detect the target NodeJS version
get_latest_lts_node_version() {
  curl --proto "=https" -fsSL https://nodejs.org/dist/index.json | jq -er '[.[] | select(.lts)][0].version'
}

get_latest_node_major_version() {
  local major="$1"
  curl --proto "=https" -fsSL --retry 3 https://nodejs.org/dist/index.json |
    jq -er --arg prefix "v${major}." \
      '[.[] | select(.version | startswith($prefix))][0].version'
}

TARGET_NODE_VERSION=""
if [[ -f .nvmrc ]]; then
  NVMRC_NODE_VERSION=$(cat .nvmrc)
  TARGET_NODE_VERSION=$(get_latest_node_major_version "${NVMRC_NODE_VERSION}")
fi

if [[ -z "$TARGET_NODE_VERSION" || "$TARGET_NODE_VERSION" == "lts/*" ]]; then
  echo ".nvmrc is missing, empty or lts/*, resolving latest NodeJS LTS..." >&2
  TARGET_NODE_VERSION=$(get_latest_lts_node_version)
fi

# Normalize to the "vX.Y.Z" form used in nodejs.org download URLs
TARGET_NODE_VERSION="v${TARGET_NODE_VERSION#v}"
echo "Using Node.js $TARGET_NODE_VERSION"

# Step 7. Download the target NodeJS version
detect_node_platform() {
  case "$TARGET_PLATFORM" in
  Linux) echo "linux" ;;
  Darwin) echo "darwin" ;;
  *)
    echo "Unsupported OS: $TARGET_PLATFORM" >&2
    return 1
    ;;
  esac
}

detect_node_arch() {
  TARGET_ARCH=$(uname -m)

  case "$TARGET_ARCH" in
  x86_64 | amd64) echo "x64" ;;
  aarch64 | arm64) echo "arm64" ;;
  *)
    echo "Unsupported architecture: $TARGET_ARCH" >&2
    return 1
    ;;
  esac
}

sha256_of() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
  else
    shasum -a 256 "$file_path" | awk '{print $1}'
  fi
}

NODE_PLATFORM=$(detect_node_platform)
NODE_ARCH=$(detect_node_arch)
NODE_DIST="node-${TARGET_NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}"
NODE_TARBALL="${NODE_DIST}.tar.gz"
NODE_BASE_URL="https://nodejs.org/dist/${TARGET_NODE_VERSION}"
NODE_INSTALL_DIR="$LYS_HOME/runtime/node"

if [[ -x "$NODE_INSTALL_DIR/bin/node" ]] && [[ "$("$NODE_INSTALL_DIR/bin/node" --version)" == "$TARGET_NODE_VERSION" ]]; then
  echo "NodeJS $TARGET_NODE_VERSION already installed in $NODE_INSTALL_DIR"
else
  TMP_DIR=$(mktemp -d "$LYS_HOME/runtime/.node-download.XXXXXX")
  trap 'rm -rf "$TMP_DIR"' EXIT

  echo "Downloading $NODE_TARBALL..."
  curl --proto "=https" -fsSL --retry 3 -o "$TMP_DIR/$NODE_TARBALL" "$NODE_BASE_URL/$NODE_TARBALL"
  curl --proto "=https" -fsSL --retry 3 -o "$TMP_DIR/SHASUMS256.txt" "$NODE_BASE_URL/SHASUMS256.txt"

  EXPECTED_SHA=$(awk -v f="$NODE_TARBALL" '$2 == f {print $1}' "$TMP_DIR/SHASUMS256.txt")
  ACTUAL_SHA=$(sha256_of "$TMP_DIR/$NODE_TARBALL")

  if [[ -z "$EXPECTED_SHA" || "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
    echo "Checksum verification failed for $NODE_TARBALL" >&2
    exit 1
  fi

  mkdir -p "$TMP_DIR/extract"
  tar -xzf "$TMP_DIR/$NODE_TARBALL" -C "$TMP_DIR/extract" --strip-components=1

  rm -rf "$NODE_INSTALL_DIR"
  mv "$TMP_DIR/extract" "$NODE_INSTALL_DIR"
fi

echo "NodeJS ready: $("$NODE_INSTALL_DIR/bin/node" --version) at $NODE_INSTALL_DIR/bin/node"

# Step 8. Copy the backend to $LYS_HOME/runtime/backend
BACKEND_DIR="$LYS_HOME/runtime/backend"
mkdir -p "$BACKEND_DIR"

rm -r "$BACKEND_DIR"
mv apps/backend/dist "$BACKEND_DIR"

# Step 8. Build the desktop app
pnpm run desktop:build:ci

# Step 9. Bundle the desktop app
pnpm run desktop:bundle:ci

# Step 10.Install the desktop app
APP_BUNDLE="apps/desktop/src-tauri/target/release/bundle/macos/Lys.app"
[[ -d "$APP_BUNDLE" ]] || {
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
}

APP_PATH="/Applications/$(basename "$APP_BUNDLE")"

# If we dont remove, the old app will be kept
rm -rf "$APP_PATH"
ditto "$APP_BUNDLE" "$APP_PATH"
