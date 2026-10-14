#!/bin/sh
# Assemble the pull-request check demo repository for a reference system.
#   sh scripts/make-backtest-demo.sh <out-dir> [system=hotrod]
set -e
out=$1; sys=${2:-hotrod}
root=$(cd "$(dirname "$0")/.." && pwd)
[ -n "$out" ] || { echo "usage: make-backtest-demo.sh <out-dir> [system]"; exit 1; }
mkdir -p "$out/.hindcast"
cp -R "$root/examples/backtest-ci/." "$out/"
(cd "$root" && npm run -s build:cli)
cp "$root/dist-cli/hindcast.mjs" "$out/.hindcast/"
cp "$root/reference/$sys/model.json" "$root/reference/$sys/dataset.json" "$out/.hindcast/"
echo "demo repository in $out"
