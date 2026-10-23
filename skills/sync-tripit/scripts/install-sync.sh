#!/usr/bin/env bash
# Install the pinned sync runtime if sync.mjs is absent.
# Usage: bash install-sync.sh [installation-directory]
# Default directory: $HOME/.tripit-reclaim. Existing runtimes and .env are kept.
# Stdout: one JSON object {status: installed|present, path, requestedVersion}.
# Exit 0: ready; 2: bad arguments; other nonzero: download/extract/install failed.
# Dependencies: bash, curl, tar, npm, node. No credentials are read or printed.
set -euo pipefail

install_sync_main() (
  if (( $# > 1 )); then
    echo 'Usage: bash install-sync.sh [installation-directory] — supply at most one directory.' >&2
    return 2
  fi
  local install_dir="${1:-$HOME/.tripit-reclaim}"
  local version='0.3.4'
  local tool
  for tool in curl tar npm node; do
    if ! command -v "$tool" >/dev/null; then
      echo "Install $tool and retry install-sync.sh." >&2
      return 1
    fi
  done
  if [[ -f "$install_dir/sync.mjs" ]]; then
    node -e 'console.log(JSON.stringify({status:"present",path:process.argv[1],requestedVersion:process.argv[2]}))' "$install_dir" "$version"
    return 0
  fi

  local staging
  staging=$(mktemp -d)
  local pending_main=''
  # shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
  cleanup_install() {
    if ! rm -rf -- "$staging"; then
      echo 'Could not remove temporary installer files; inspect the system temporary directory.' >&2
    fi
    if [[ -n "$pending_main" ]] && ! rm -f -- "$pending_main"; then
      echo 'Could not remove the temporary sync entrypoint; inspect the installation directory.' >&2
    fi
    return 0
  }
  trap cleanup_install EXIT
  mkdir -p "$staging/runtime"
  curl -fsSL "https://github.com/jbaruch/reclaim-tripit-timezones-sync/archive/refs/tags/v${version}.tar.gz" -o "$staging/runtime.tar.gz"
  tar xzf "$staging/runtime.tar.gz" --strip-components=1 -C "$staging/runtime"
  if [[ ! -f "$staging/runtime/sync.mjs" || ! -f "$staging/runtime/package-lock.json" ]]; then
    echo 'Downloaded runtime is incomplete — retry the download or verify the published release.' >&2
    return 1
  fi
  (cd "$staging/runtime" && npm ci --omit=dev >&2)
  # Publish sync.mjs last: an interrupted copy must not look like a ready install.
  mv "$staging/runtime/sync.mjs" "$staging/sync.mjs"
  mkdir -p -- "$install_dir"
  cp -R "$staging/runtime/." "$install_dir/"
  pending_main=$(mktemp "$install_dir/.sync-main.XXXXXX")
  cp "$staging/sync.mjs" "$pending_main"
  mv "$pending_main" "$install_dir/sync.mjs"
  pending_main=''
  node -e 'console.log(JSON.stringify({status:"installed",path:process.argv[1],requestedVersion:process.argv[2]}))' "$install_dir" "$version"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_sync_main "$@"
fi
