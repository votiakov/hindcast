#!/bin/sh
# Record Kubernetes reference runs one after another (each takes its day's length in real time):
#   BNK8S_KUBECONFIG=… sh reference/k8s/record-all.sh shop history launch normal-2 …
set -e
# a failing recording must stop the chain, not hide behind the log filter
set -o pipefail
sys=$1; shift
dir=$(dirname "$0")
for run in "$@"; do
  echo "=== $sys/$run $(date)"
  npx tsx "$dir/record.ts" "$sys" "$run" 2>&1 | grep -v 'level=warning' > "$dir/$sys/runs/$run.log" || { echo "$run failed"; tail -20 "$dir/$sys/runs/$run.log"; exit 1; }
  tail -2 "$dir/$sys/runs/$run.log"
done
echo "=== all done $(date)"
