#!/usr/bin/env bash
# The Hindcast binary for this runner, from a GitHub release (used by action.yml).
#   install.sh resolve    which release and asset: writes repo, tag, asset, dir, bin to $GITHUB_OUTPUT
#   install.sh download   fetches the asset into dir (on a cache miss) and checks that it runs
set -euo pipefail

api() {
  # GitHub REST API, authenticated when a token is there (higher rate limit)
  if [ -n "${GH_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/$1"
  else
    curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/$1"
  fi
}

case "${1:-}" in
resolve)
  repo="${ACTION_REPO:-}"
  [ -n "$repo" ] || repo=votiakov/hindcast   # uses: ./ (a checkout of this repository) has no action repository
  case "${RUNNER_OS:-}-${RUNNER_ARCH:-}" in
    Linux-X64) asset=hindcast-x86_64-unknown-linux-musl ;;
    macOS-ARM64) asset=hindcast-aarch64-apple-darwin ;;
    macOS-X64) asset=hindcast-x86_64-apple-darwin ;;
    Windows-X64) asset=hindcast-x86_64-pc-windows-msvc.exe ;;
    *)
      echo "::error title=Hindcast::No Hindcast release binary for ${RUNNER_OS:-?} ${RUNNER_ARCH:-?} (there are Linux x64, macOS arm64 and x64, Windows x64). Build one (cargo build --release --bin hindcast in engine-rs/) and pass it as the binary input."
      exit 1 ;;
  esac
  want="${INPUT_VERSION:-}"
  [ -n "$want" ] || want="${ACTION_REF:-}"
  tag=""
  if [[ "$want" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    tag="$want"                                    # an exact release
  elif [[ "$want" =~ ^v([0-9]+)(\.([0-9]+))?$ ]]; then
    # a major (v1) or minor (v1.2) tag: the newest release under it (the API lists newest first)
    prefix="$want."
    tag=$(api "repos/$repo/releases?per_page=100" | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' | awk -v p="$prefix" 'index($0, p) == 1' | head -n 1 || true)
    [ -n "$tag" ] || echo "::warning title=Hindcast::No release under $want in $repo; using the latest release"
  fi
  if [ -z "$tag" ]; then
    # a branch, a commit, or nothing: the latest release
    tag=$(api "repos/$repo/releases/latest" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
    [ -n "$tag" ] || { echo "::error title=Hindcast::Could not find a release of $repo"; exit 1; }
  fi
  dir="${RUNNER_TOOL_CACHE:-${RUNNER_TEMP:-/tmp}}/hindcast/$tag"
  bin="$dir/hindcast"
  case "$asset" in *.exe) bin="$bin.exe" ;; esac
  echo "Hindcast $tag ($asset) from $repo"
  {
    echo "repo=$repo"
    echo "tag=$tag"
    echo "asset=$asset"
    echo "dir=$dir"
    echo "bin=$bin"
  } >> "$GITHUB_OUTPUT"
  ;;
download)
  mkdir -p "$HINDCAST_DIR"
  bin="$HINDCAST_DIR/hindcast"
  case "$HINDCAST_ASSET" in *.exe) bin="$bin.exe" ;; esac
  url="https://github.com/$HINDCAST_REPO/releases/download/$HINDCAST_TAG/$HINDCAST_ASSET"
  echo "downloading $url"
  if ! curl -fsSL --retry 3 -o "$bin" "$url" 2> /dev/null; then
    # a private repository: through the API, with the token
    rm -f "$bin"
    if command -v gh > /dev/null 2>&1 && [ -n "${GH_TOKEN:-}" ] && gh release download "$HINDCAST_TAG" --repo "$HINDCAST_REPO" --pattern "$HINDCAST_ASSET" --output "$bin" --clobber; then
      :
    else
      echo "::error title=Hindcast::Could not download $url"
      exit 1
    fi
  fi
  chmod +x "$bin"
  if ! "$bin" catalog > /dev/null 2>&1; then
    echo "::error title=Hindcast::$HINDCAST_ASSET from $HINDCAST_TAG does not run on this runner"
    rm -f "$bin"
    exit 1
  fi
  if ! "$bin" verify-change --help > /dev/null 2>&1; then
    echo "::error title=Hindcast::$HINDCAST_TAG has no verify-change command (it came after v1.1.0): set the version input to a newer release"
    rm -f "$bin"
    exit 1
  fi
  ;;
*)
  echo "usage: install.sh resolve|download" >&2
  exit 2 ;;
esac
