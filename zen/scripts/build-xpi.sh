#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",*$/\1/p' "$project_dir/manifest.json")

if [ -z "$version" ]; then
  echo "Could not read the extension version from manifest.json" >&2
  exit 1
fi

output_dir="$project_dir/dist"
filename="discord-direct-zen-$version-unsigned.xpi"
output="$output_dir/$filename"
temporary="$output_dir/.discord-direct-zen-$version.tmp.xpi"

mkdir -p "$output_dir"
rm -f "$temporary"

cd "$project_dir"
zip -X -q "$temporary" \
  manifest.json \
  api/implementation-gecko147.js \
  api/schema.json \
  background.js \
  icons/icon.svg \
  lib/mapping-policy.js \
  lib/turn-codec.js \
  package.json \
  popup/popup.css \
  popup/popup.html \
  popup/popup.js \
  src/bridge.js \
  src/config.js \
  src/page-hook.js \
  src/popup-status.js \
  LICENSE \
  PRIVACY.md \
  README.md

mv "$temporary" "$output"
(cd "$output_dir" && shasum -a 256 "$filename" > "$filename.sha256")
echo "Built $output"
