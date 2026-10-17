#!/usr/bin/env bash
# Backtest the pull request's change (used by action.yml; runs in the working-directory input).
# Puts the manifests before (and, with head-ref, after) the change in a temporary directory, runs
# `hindcast verify-change`, and appends its comment to the job summary. Exits 0 on any verdict: the
# action's last step fails the job when the verdict is one fail-on names.
#
# Locally, without GitHub Actions:
#   HINDCAST_BIN=engine-rs/target/release/hindcast INPUT_MODEL=reference/hotrod/model.json \
#   INPUT_DATASET=reference/hotrod/dataset.json INPUT_MANIFESTS=examples/backtest-ci/deploy \
#   INPUT_BASE_REF=HEAD bash action/verify.sh
set -euo pipefail

say() { echo "$@" >&2; }
fail() { echo "::error title=Hindcast::$*" >&2; exit 1; }
unix() { if command -v cygpath > /dev/null 2>&1; then cygpath -u "$1"; else echo "$1"; fi; }

bin="${HINDCAST_BIN:-}"
[ -n "$bin" ] || fail "no hindcast binary (the binary input, or a release download)"
[ -x "$bin" ] || [ -x "$bin.exe" ] || fail "$bin: not found or not executable"
"$bin" verify-change --help > /dev/null 2>&1 || fail "$bin has no verify-change command: it predates it (v1.1.0 and older); use a newer release"
# a baseline needs a binary that knows it: an older one ignores --baseline-head and would judge both changes together
if [ -n "${INPUT_BASELINE_REF:-}${INPUT_BASELINE_MANIFESTS:-}${INPUT_BASELINE_STRATEGY:-}" ]; then
  case "$("$bin" verify-change --help 2>&1 || true)" in
    *--baseline-head*) ;;
    *) fail "$bin predates stacked changes (v1.2.1 and older ignore a baseline and would judge this change and the baseline together): set binary to a build from main, or use a release newer than v1.2.1" ;;
  esac
fi
[ -n "${INPUT_MODEL:-}" ] || fail "the model input is required (a calibrated model.json)"
[ -n "${INPUT_DATASET:-}" ] || fail "the dataset input is required (a recorded dataset.json)"
[ -f "$INPUT_MODEL" ] || fail "model: no file $INPUT_MODEL (in $(pwd))"
[ -f "$INPUT_DATASET" ] || fail "dataset: no file $INPUT_DATASET (in $(pwd))"

tmp_root="$(unix "${RUNNER_TEMP:-${TMPDIR:-/tmp}}")"
mkdir -p "$tmp_root"
out="$(mktemp -d "$tmp_root/hindcast.XXXXXX")"
github_output="${GITHUB_OUTPUT:-$out/outputs.txt}"
step_summary="${GITHUB_STEP_SUMMARY:-$out/step-summary.md}"

# a commit present locally (a shallow checkout lacks the pull request's base)
have() { git cat-file -e "$1^{commit}" 2> /dev/null; }
commit_of() {
  local ref="$1"
  if have "$ref"; then
    git rev-parse "$ref^{commit}"
    return
  fi
  if [ "$ref" = "HEAD^" ] || [ "$ref" = "HEAD~1" ]; then
    git fetch --no-tags --quiet --deepen=1 > /dev/null 2>&1 || true
  else
    git fetch --no-tags --quiet --depth=1 origin "$ref" > /dev/null 2>&1 && ref=FETCH_HEAD
  fi
  have "$ref" || fail "commit $1 is not in this checkout and could not be fetched (actions/checkout with fetch-depth: 0 fetches every commit)"
  git rev-parse "$ref^{commit}"
}

# the manifests at a commit, written under a directory: extract <commit> <path> <dir>
extract() {
  local ref="$1" path="${2%/}" dest="$3" kind f rel
  mkdir -p "$dest"
  kind="$(git cat-file -t "$ref:./$path" 2> /dev/null || echo none)"
  case "$kind" in
    blob) git show "$ref:./$path" > "$dest/$(basename "$path")" ;;
    tree)
      git ls-tree -r --name-only "$ref" -- "$path" | while IFS= read -r f; do
        rel="${f#"$path"/}"
        mkdir -p "$dest/$(dirname "$rel")"
        git show "$ref:./$f" > "$dest/$rel"
      done ;;
    *) say "$path does not exist at ${ref:0:12}: every manifest in it counts as new" ;;
  esac
}

args=(verify-change --model "$INPUT_MODEL" --dataset "$INPUT_DATASET")

if [ -n "${INPUT_MANIFESTS:-}" ]; then
  manifests="${INPUT_MANIFESTS%/}"
  if [ -n "${INPUT_HEAD_REF:-}" ]; then
    head_commit="$(commit_of "$INPUT_HEAD_REF")"
    head="$out/head"
    extract "$head_commit" "$manifests" "$head"
    say "after:  $manifests at ${head_commit:0:12}"
  else
    [ -e "$manifests" ] || fail "manifests: no file or directory $manifests (in $(pwd))"
    head="$manifests"
    say "after:  $manifests (working tree)"
  fi
  if [ -n "${INPUT_BASE_MANIFESTS:-}" ]; then
    [ -e "$INPUT_BASE_MANIFESTS" ] || fail "base-manifests: no file or directory $INPUT_BASE_MANIFESTS (in $(pwd))"
    base="$INPUT_BASE_MANIFESTS"
    say "before: $base"
  else
    ref="${INPUT_BASE_REF:-}"
    [ -n "$ref" ] || ref="${PR_BASE_SHA:-}"
    [ -n "$ref" ] || ref="HEAD^"
    base_commit="$(commit_of "$ref")"
    base="$out/base"
    extract "$base_commit" "$manifests" "$base"
    say "before: $manifests at ${base_commit:0:12} ($ref)"
  fi
  args+=(--base "$base" --head "$head")
  # a stacked pull request: the baseline's manifests, applied to both sides; the change is head over them
  if [ -n "${INPUT_BASELINE_MANIFESTS:-}" ]; then
    [ -e "$INPUT_BASELINE_MANIFESTS" ] || fail "baseline-manifests: no file or directory $INPUT_BASELINE_MANIFESTS (in $(pwd))"
    args+=(--baseline-head "$INPUT_BASELINE_MANIFESTS")
    say "baseline: $INPUT_BASELINE_MANIFESTS"
  elif [ -n "${INPUT_BASELINE_REF:-}" ]; then
    baseline_commit="$(commit_of "$INPUT_BASELINE_REF")"
    extract "$baseline_commit" "$manifests" "$out/baseline"
    args+=(--baseline-head "$out/baseline")
    say "baseline: $manifests at ${baseline_commit:0:12} ($INPUT_BASELINE_REF)"
  fi
elif [ -n "${INPUT_BASELINE_REF:-}${INPUT_BASELINE_MANIFESTS:-}" ]; then
  fail "baseline-ref and baseline-manifests are manifests: set manifests too (or give the baseline as baseline-strategy)"
fi
if [ -n "${INPUT_BASELINE_STRATEGY:-}" ]; then
  [ -z "${INPUT_BASELINE_REF:-}${INPUT_BASELINE_MANIFESTS:-}" ] || fail "one baseline: baseline-ref, baseline-manifests or baseline-strategy"
  [ -f "$INPUT_BASELINE_STRATEGY" ] || fail "baseline-strategy: no file $INPUT_BASELINE_STRATEGY (in $(pwd))"
  args+=(--baseline "$INPUT_BASELINE_STRATEGY")
fi
if [ -n "${INPUT_TERRAFORM_PLAN:-}" ]; then
  [ -f "$INPUT_TERRAFORM_PLAN" ] || fail "terraform-plan: no file $INPUT_TERRAFORM_PLAN (in $(pwd)); write it with terraform show -json plan.out > plan.json"
  args+=(--terraform-plan "$INPUT_TERRAFORM_PLAN")
fi
for s in ${INPUT_STRATEGIES:-}; do
  args+=("$s")
done
if [ -z "${INPUT_MANIFESTS:-}" ] && [ -z "${INPUT_TERRAFORM_PLAN:-}" ] && [ -z "${INPUT_STRATEGIES:-}" ]; then
  fail "nothing to backtest: set manifests (Kubernetes), terraform-plan, or strategies"
fi

[ -z "${INPUT_LAST:-}" ] || args+=(--last "$INPUT_LAST")
[ -z "${INPUT_DRAWS:-}" ] || args+=(--draws "$INPUT_DRAWS")
[ -z "${INPUT_GATE_MINUTES:-}" ] || args+=(--gate-minutes "$INPUT_GATE_MINUTES")
[ -z "${INPUT_SLO_P99_MS:-}" ] || args+=(--p99 "$INPUT_SLO_P99_MS")
[ -z "${INPUT_SLO_ERROR_RATE:-}" ] || args+=(--errors "$INPUT_SLO_ERROR_RATE")
[ -z "${INPUT_COMMENT_KEY:-}" ] || args+=(--comment-key "$INPUT_COMMENT_KEY")
[ -z "${INPUT_TITLE:-}" ] || args+=(--title "$INPUT_TITLE")
[ -z "${RUN_URL:-}" ] || args+=(--run-url "$RUN_URL")
args+=(--fail-on "${INPUT_FAIL_ON:-fail}" --comment "$out/comment.md" --json "$out/result.json" --html "$out/report.html" --md "$out/report.md" --outputs "$github_output")

set +e
"$bin" "${args[@]}"
code=$?
set -e
if [ "$code" != 0 ] && [ "$code" != 2 ]; then
  fail "hindcast verify-change exited with $code"
fi
{
  echo "summary=$out/comment.md"
  echo "result=$out/result.json"
  [ ! -f "$out/report.html" ] || echo "report=$out/report.html"
} >> "$github_output"
cat "$out/comment.md" >> "$step_summary"
say "comment: $out/comment.md"
# run by hand, outside a workflow: say what the action's last step would make of it
if [ -z "${GITHUB_ACTIONS:-}" ]; then
  if [ "$code" = 2 ]; then
    say "gate: failed — in a workflow, the action's last step would fail the check (fail-on: ${INPUT_FAIL_ON:-fail})"
  else
    say "gate: passed — in a workflow, the check would pass"
  fi
fi
