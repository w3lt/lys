#!/bin/bash
# A failed build or signature ends the script, so a stale vmo never runs.
set -euo pipefail

swift build
codesign --force --sign - --entitlements vmo.entitlements "$(swift build --show-bin-path)/vmo"
# exec, so the process that runs this script, which the Lys desktop owns and
# stops, becomes vmo itself and lives until vmo has deleted its VMs.
exec "$(swift build --show-bin-path)/vmo"
