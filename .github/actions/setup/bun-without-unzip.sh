#!/usr/bin/env bash
# setup-bun unpacks its download with unzip, and keeps a Bun of the pinned version that it finds at ~/.bun/bin/bun.
set -euo pipefail

if command -v unzip > /dev/null; then
  exit 0
fi
if ! command -v npm > /dev/null; then
  echo "::error::setup found no unzip for setup-bun, and no npm to fetch Bun without it"
  exit 1
fi

version="$(< .bun-version)"
prefix="$RUNNER_TEMP/bun-from-npm"
package="$prefix/node_modules/bun"
# npm leaves a placeholder at bin/bun.exe, and an npm that holds install scripts back never swaps the binary in.
npm install --ignore-scripts --prefix "$prefix" "bun@${version#v}"
node "$package/install.js"
install -D "$package/bin/bun.exe" "$HOME/.bun/bin/bun"
"$HOME/.bun/bin/bun" --version
