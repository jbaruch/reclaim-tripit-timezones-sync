#!/usr/bin/env bash
# Install or repair the pinned runtime; reuse a verified complete installation.
# Usage: bash install-sync.sh [installation-directory]
# Default directory: $HOME/.tripit-reclaim. Operator-owned .env is kept.
# Stdout: one JSON object {status: installed|present, path, requestedVersion}.
# Exit 0: ready; 2: bad arguments; other nonzero: download/extract/install failed.
# Dependencies: bash, Node >=22.19.0; curl, tar, npm only for installation/repair.
# No credentials are read or printed.
set -euo pipefail

install_sync_main() (
  if (( $# > 1 )); then
    echo 'Usage: bash install-sync.sh [installation-directory] — supply at most one directory.' >&2
    return 2
  fi
  local install_dir="${1:-$HOME/.tripit-reclaim}"
  local version='0.3.5'
  if ! command -v node >/dev/null; then
    echo 'Install Node >=22.19.0 and retry install-sync.sh.' >&2
    return 1
  fi
  local node_version
  if ! node_version=$(node --version); then
    echo 'Cannot query Node — install Node >=22.19.0 and retry install-sync.sh.' >&2
    return 1
  fi
  # Keep this minimum aligned with package.json engines.node when changing it.
  if [[ ! "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo 'Cannot identify a stable Node version — install Node >=22.19.0 and retry install-sync.sh.' >&2
    return 1
  fi
  if (( 10#${BASH_REMATCH[1]} < 22 || (10#${BASH_REMATCH[1]} == 22 && 10#${BASH_REMATCH[2]} < 19) )); then
    echo "Node $node_version is unsupported — install Node >=22.19.0 and retry install-sync.sh." >&2
    return 1
  fi
  local script_dir="${BASH_SOURCE[0]%/*}"
  if [[ "$script_dir" == "${BASH_SOURCE[0]}" ]]; then script_dir='.'; fi
  if node "$script_dir/runtime-state.mjs" check "$install_dir" "$version" >/dev/null; then
    node -e 'console.log(JSON.stringify({status:"present",path:process.argv[1],requestedVersion:process.argv[2]}))' "$install_dir" "$version"
    return 0
  else
    local readiness_status=$?
    if (( readiness_status != 1 )); then return "$readiness_status"; fi
  fi
  local tool
  for tool in curl tar npm; do
    if ! command -v "$tool" >/dev/null; then
      echo "Install $tool and retry install-sync.sh." >&2
      return 1
    fi
  done

  local staging
  staging=$(mktemp -d)
  local pending_main=''
  # shellcheck disable=SC2329,SC2317 # EXIT-only callback; ShellCheck 0.10 misses the indirect invocation below.
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
  node "$script_dir/runtime-state.mjs" seal "$staging/runtime" "$version" >/dev/null
  # Publish sync.mjs last: an interrupted copy must not look like a ready install.
  mv "$staging/runtime/sync.mjs" "$staging/sync.mjs"
  mkdir -p -- "$install_dir"
  # Replace owned trees so removed files from an older release cannot survive.
  rm -rf -- "${install_dir:?}/lib" "${install_dir:?}/node_modules"
  cp -R "$staging/runtime/." "$install_dir/"
  pending_main=$(mktemp "$install_dir/.sync-main.XXXXXX")
  cp "$staging/sync.mjs" "$pending_main"
  mv "$pending_main" "$install_dir/sync.mjs"
  pending_main=''
  node "$script_dir/runtime-state.mjs" check "$install_dir" "$version" >/dev/null
  node -e 'console.log(JSON.stringify({status:"installed",path:process.argv[1],requestedVersion:process.argv[2]}))' "$install_dir" "$version"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_sync_main "$@"
fi
