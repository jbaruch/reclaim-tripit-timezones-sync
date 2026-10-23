import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class VersionSourceError extends Error {}

/**
 * Validate the complete source set before changing any release version.
 * @param {string[]} [argv]
 * @param {string} [root]
 */
export function main(argv = process.argv.slice(2), root = fileURLToPath(new URL('..', import.meta.url))) {
  const version = argv[0];
  if (argv.length !== 1 || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: bash scripts/bump-version.sh X.Y.Z — supply one complete release version.');
    return 2;
  }
  const manifestPath = '.tessl-plugin/plugin.json';
  const installerPath = 'skills/sync-tripit/scripts/install-sync.sh';
  const archiveFiles = ['evals/sync-library-installation-and-execution/criteria.json', 'research.md'];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
    throw new VersionSourceError(`Restore the version field in ${manifestPath}, then retry the release bump.`);
  }
  const installer = fs.readFileSync(path.join(root, installerPath), 'utf8');
  const versionPattern = /local version='\d+\.\d+\.\d+'/g;
  if ([...installer.matchAll(versionPattern)].length !== 1) {
    throw new VersionSourceError(
      `Restore exactly one pinned local version in ${installerPath}, then retry the release bump.`
    );
  }
  const changes = new Map([[installerPath, installer.replace(versionPattern, `local version='${version}'`)]]);
  for (const file of archiveFiles) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const archivePattern = /archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz/g;
    if (![...text.matchAll(archivePattern)].length) {
      throw new VersionSourceError(`Restore the pinned archive URL in ${file}, then retry the release bump.`);
    }
    changes.set(file, text.replace(archivePattern, `archive/refs/tags/v${version}.tar.gz`));
  }
  manifest.version = version;
  changes.set(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  for (const [file, text] of changes) fs.writeFileSync(path.join(root, file), text);
  console.log(JSON.stringify({ version, updated: [...changes.keys()] }));
  return 0;
}

if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof VersionSourceError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
