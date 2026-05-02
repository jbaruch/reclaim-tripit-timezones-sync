#!/usr/bin/env bash
# Bump the tile's version and propagate the install tarball URL to
# SKILL.md, eval criteria, and research.md so installs pull a tarball
# matching the tile's pinned version. (Only the install URL is rewritten
# — example version strings inside research.md's manifest snippets are
# illustrative templates and stay as-is.)
#
# Usage (from repo root): .tile/scripts/bump-version.sh <new-version>
#   e.g. .tile/scripts/bump-version.sh 0.3.0
#
# The script `cd`s into the .tile directory itself, so it can be invoked
# from anywhere. After running, review the diff, commit, push, and tag
# with v<new-version>.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <new-version>" >&2
  exit 2
fi

NEW="$1"

if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be semver X.Y.Z, got '$NEW'" >&2
  exit 2
fi

# Run from the .tile directory so paths are relative.
cd "$(dirname "$0")/.."

CURRENT=$(node -e "console.log(require('./tile.json').version)")
echo "Bumping $CURRENT → $NEW"

# tile.json
node -e "
  const fs = require('fs');
  const t = JSON.parse(fs.readFileSync('./tile.json', 'utf8'));
  t.version = '$NEW';
  fs.writeFileSync('./tile.json', JSON.stringify(t, null, 2) + '\n');
"

# SKILL.md install URL
sed -i.bak -E "s|archive/refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz|archive/refs/tags/v${NEW}.tar.gz|g" \
  ./skills/sync-tripit/SKILL.md
rm -f ./skills/sync-tripit/SKILL.md.bak

# Eval criteria URL
sed -i.bak -E "s|archive/refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz|archive/refs/tags/v${NEW}.tar.gz|g" \
  ./evals/sync-library-installation-and-execution/criteria.json
rm -f ./evals/sync-library-installation-and-execution/criteria.json.bak

# research.md (illustrative reference; keep consistent for readers)
sed -i.bak -E "s|archive/refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz|archive/refs/tags/v${NEW}.tar.gz|g" \
  ./research.md
rm -f ./research.md.bak

echo
echo "Updated:"
echo "  .tile/tile.json"
echo "  .tile/skills/sync-tripit/SKILL.md"
echo "  .tile/evals/sync-library-installation-and-execution/criteria.json"
echo "  .tile/research.md"
echo
echo "Next steps:"
echo "  1. Add a CHANGELOG entry for $NEW under .tile/CHANGELOG.md"
echo "  2. Review the diff, commit, push the branch, open a PR"
echo "  3. After the PR merges, tag the merge commit on main:"
echo "       git checkout main && git pull --ff-only"
echo "       git tag v$NEW"
echo "       git push origin v$NEW"
echo "     The tag is what the in-skill curl URL resolves to."
echo
echo "Publishing to the Tessl registry happens automatically via"
echo ".github/workflows/publish-tile.yml on push to main — no manual"
echo "'tessl tile publish' needed."
