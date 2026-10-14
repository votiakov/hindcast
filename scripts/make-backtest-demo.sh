#!/bin/sh
# Assemble the pull-request check demo repository for a reference system.
#   sh scripts/make-backtest-demo.sh <out-dir> [system=hotrod]
# The workflow runs on Linux x86-64: the binary comes from $HINDCAST_LINUX_BIN, or the latest release.
set -e
out=$1; sys=${2:-hotrod}
root=$(cd "$(dirname "$0")/.." && pwd)
[ -n "$out" ] || { echo "usage: make-backtest-demo.sh <out-dir> [system]"; exit 1; }
mkdir -p "$out/.hindcast"
cp -R "$root/examples/backtest-ci/." "$out/"
if [ -n "$HINDCAST_LINUX_BIN" ]; then
  cp "$HINDCAST_LINUX_BIN" "$out/.hindcast/hindcast"
else
  gh release download --repo votiakov/hindcast --pattern hindcast-x86_64-unknown-linux-musl --output "$out/.hindcast/hindcast" --clobber
fi
chmod +x "$out/.hindcast/hindcast"
cp "$root/reference/$sys/model.json" "$root/reference/$sys/dataset.json" "$out/.hindcast/"
echo "demo repository in $out"
