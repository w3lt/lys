#!/bin/bash
# A failed build ends the script, so a stale voice never runs.
set -euo pipefail

swift build
# exec, so the process that runs this script, which the Lys desktop owns and
# stops, becomes voice itself.
exec "$(swift build --show-bin-path)/voice"
