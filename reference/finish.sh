#!/bin/sh
# After a system's runs are recorded: re-derive every run's files, import, calibrate, check, bundle.
#   sh reference/finish.sh <system>
set -e
cd "$(dirname "$0")/.."
sys=$1
for d in reference/$sys/runs/*/; do
  run=$(basename "$d")
  [ -f "$d/raw/k6.csv" ] && NODE_OPTIONS=--max-old-space-size=8192 npx tsx reference/regen.ts "$sys" "$run"
done
NODE_OPTIONS=--max-old-space-size=8192 npx tsx reference/bundle.ts "$sys"
