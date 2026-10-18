#!/bin/bash

swift build
codesign --force --sign - --entitlements vmo.entitlements "$(swift build --show-bin-path)/vmo"
"$(swift build --show-bin-path)/vmo"
