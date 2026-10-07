#!/bin/sh
# Record every run of the given reference systems, one after another.
#   sh reference/record-all.sh hotrod:history hotrod:stress …
set -e
cd "$(dirname "$0")/.."
for spec in "$@"; do
  sys=${spec%%:*}; run=${spec#*:}
  echo "=== $sys $run $(date)"
  npx tsx reference/record.ts "$sys" "$run"
done
echo "=== all done $(date)"
