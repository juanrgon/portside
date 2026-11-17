#!/usr/bin/env bash
# Builds the zip to upload to the Chrome Web Store: the extension folder, with
# manifest.json at the top level of the zip.
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(node -p 'require("./extension/manifest.json").version')"
mkdir -p dist
out="$PWD/dist/portside-$version.zip"
rm -f "$out"
(cd extension && zip -r -X -q "$out" . -x '.*' -x '*/.*')
echo "$out"
unzip -l "$out" | tail -1
