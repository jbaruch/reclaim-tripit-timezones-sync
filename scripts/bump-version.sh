#!/usr/bin/env bash
# Bump the plugin's version and propagate the install tarball URL to
# SKILL.md, eval criteria, and research.md so installs pull a tarball
# matching the plugin's pinned version. (Only the install URL is rewritten
# — example version strings inside research.md's manifest snippets are
# illustrative templates and stay as-is.)
#
# Usage (from repo root): scripts/bump-version.sh <new-version>
#   e.g. scripts/bump-version.sh 0.3.0
#
# The script `cd`s to the repo root itself, so it can be invoked from
# anywhere. After running, review the diff, commit, push, and merge —
# the publish-plugin GitHub Actions workflow handles tagging and registry
# publish on merge to main (see "Next steps" output below).
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

# Run from the repo root (parent of scripts/) so paths are relative.
cd "$(dirname "$0")/.."

CURRENT=$(node -e "console.log(require('./.tessl-plugin/plugin.json').version)")
echo "Bumping $CURRENT → $NEW"

# plugin.json
node -e "
  const fs = require('fs');
  const t = JSON.parse(fs.readFileSync('./.tessl-plugin/plugin.json', 'utf8'));
  t.version = '$NEW';
  fs.writeFileSync('./.tessl-plugin/plugin.json', JSON.stringify(t, null, 2) + '\n');
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
echo "  .tessl-plugin/plugin.json"
echo "  skills/sync-tripit/SKILL.md"
echo "  evals/sync-library-installation-and-execution/criteria.json"
echo "  research.md"
echo
echo "Next steps:"
echo "  1. Add a CHANGELOG entry for $NEW under CHANGELOG.md"
echo "  2. Review the diff, commit, push the branch, open a PR"
echo "  3. After the PR merges, the publish-plugin workflow runs automatically."
echo "     It pushes the v$NEW tag (so the in-skill curl URL resolves) and"
echo "     publishes the plugin to the Tessl registry. No manual 'git tag'"
echo "     or 'tessl plugin publish' is needed."
echo
echo "     The publish step requires a TESSL_TOKEN repo secret with"
echo "     publisher role under Settings → Secrets and variables →"
echo "     Actions. Without it, the workflow run fails at the publish step"
echo "     (the tag step still succeeds)."
