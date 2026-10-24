#!/usr/bin/env bash
# Usage: bash run-sync.sh [installation-directory] (default $HOME/.tripit-reclaim).
# Parse dotenv as data; inherited environment values take precedence.
# Stdout/exit status are the runtime's JSON/process contract; setup errors go to
# stderr, exit 1 (missing install) or 2 (bad arguments). Never print credentials.
set -euo pipefail

run_sync_main() (
  if (( $# > 1 )); then
    echo 'Usage: bash run-sync.sh [installation-directory] — supply at most one directory.' >&2
    return 2
  fi
  local install_dir="${1:-$HOME/.tripit-reclaim}"
  if [[ ! -f "$install_dir/sync.mjs" ]]; then
    echo 'Sync runtime is missing — run the co-shipped install-sync.sh, then retry.' >&2
    return 1
  fi
  if [[ -f "$install_dir/.env" ]]; then
    # Only an inherited Node option is authority to load code at startup.
    # An empty inherited value prevents dotenv from introducing NODE_OPTIONS.
    export NODE_OPTIONS="${NODE_OPTIONS-}"
    exec node --env-file="$install_dir/.env" "$install_dir/sync.mjs" sync --output=json
  fi
  exec node "$install_dir/sync.mjs" sync --output=json
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_sync_main "$@"
fi
