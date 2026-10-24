#!/usr/bin/env bash
# Synchronize a release version across the plugin, installer and archive references.
# Usage: bash scripts/bump-version.sh X.Y.Z (works from any working directory).
# Stdout: JSON {version, updated}; diagnostics: stderr. Exit 0: updated;
# 2: invalid arguments; other nonzero: source validation/filesystem/tool failure.
# Implementation and validation live in the co-shipped bump-version.mjs.
set -euo pipefail

bump_version_main() (
  exec node "$(dirname "${BASH_SOURCE[0]}")/bump-version.mjs" "$@"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  bump_version_main "$@"
fi
