#!/usr/bin/env bash
# One pull-request comment per check, updated in place on later pushes (used by action.yml).
# Finds the comment by the hidden marker hindcast verify-change wrote on its first line; needs
# GH_TOKEN with pull-requests: write, and the gh CLI (on every GitHub-hosted runner).
set -euo pipefail

warn() { echo "::warning title=Hindcast::$*"; exit 0; }

[ -n "${PR:-}" ] || warn "not a pull request: no comment"
[ -f "${SUMMARY:-}" ] || warn "no comment was written"
command -v gh > /dev/null 2>&1 || warn "the gh CLI is not on this runner: the result is in the job summary only"
marker="${MARKER:-<!-- hindcast-verify-change -->}"

id="$(gh api --paginate "repos/$REPO/issues/$PR/comments?per_page=100" --jq ".[] | select(.body | contains(\"$marker\")) | .id" 2> /dev/null | head -n 1 || true)"
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$id" -F "body=@$SUMMARY" --silent \
    || warn "could not update comment $id (the token needs pull-requests: write; pull requests from forks get a read-only token)"
  echo "updated comment $id on #$PR"
else
  gh api -X POST "repos/$REPO/issues/$PR/comments" -F "body=@$SUMMARY" --silent \
    || warn "could not comment on #$PR (the token needs pull-requests: write; pull requests from forks get a read-only token)"
  echo "commented on #$PR"
fi
