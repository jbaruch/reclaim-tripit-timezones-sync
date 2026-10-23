#!/usr/bin/env bash
# Synchronize a release version across the plugin, installer and archive references.
# Usage: bash scripts/bump-version.sh X.Y.Z (works from any working directory).
# Stdout: JSON {version, updated}; diagnostics/progress: stderr.
# Exit 0: updated; 2: invalid arguments; other nonzero: filesystem/tool failure.
# Only archive URL references and the installer's version are rewritten; unrelated
# illustrative versions in research.md are preserved. The merge publisher owns tags.
set -euo pipefail

bump_version_main() (
  if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo 'Usage: bash scripts/bump-version.sh X.Y.Z — supply one complete release version.' >&2
    return 2
  fi
  local release_version="$1"
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  node -e '
    const fs = require("node:fs");
    const file = ".tessl-plugin/plugin.json";
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.version = process.argv[1];
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  ' "$release_version"
  sed -i.bak -E "s|local version='[0-9]+\.[0-9]+\.[0-9]+'|local version='${release_version}'|" \
    skills/sync-tripit/scripts/install-sync.sh
  rm -f skills/sync-tripit/scripts/install-sync.sh.bak
  local file
  for file in evals/sync-library-installation-and-execution/criteria.json research.md; do
    sed -i.bak -E "s|archive/refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz|archive/refs/tags/v${release_version}.tar.gz|g" "$file"
    rm -f "$file.bak"
  done
  node -e '
    console.log(JSON.stringify({version:process.argv[1],updated:[
      ".tessl-plugin/plugin.json", "skills/sync-tripit/scripts/install-sync.sh",
      "evals/sync-library-installation-and-execution/criteria.json", "research.md"
    ]}));
  ' "$release_version"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  bump_version_main "$@"
fi
