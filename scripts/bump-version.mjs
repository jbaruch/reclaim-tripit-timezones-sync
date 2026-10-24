import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class VersionSourceError extends Error {}

function knownFileError(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    [
      'ENOENT',
      'ENOTDIR',
      'EACCES',
      'EPERM',
      'EISDIR',
      'ELOOP',
      'ENOSPC',
      'EROFS',
      'EIO',
      'EMFILE',
      'ENFILE',
      'EXDEV'
    ].includes(String(error.code))
  );
}

function readSource(root, file) {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    if (!knownFileError(error)) throw error;
    throw new VersionSourceError(
      `Cannot read ${file}; restore this release source and its read permissions, then retry the release bump.`
    );
  }
}

/** Stage every old/new value before replacement; retain a journal if recovery fails. */
function replaceSourceSet(root, changes, originals) {
  let staging;
  const replaced = [];
  try {
    staging = fs.mkdtempSync(path.join(root, '.release-version-'));
    let index = 0;
    const entries = [];
    for (const [file, text] of changes) {
      const mode = fs.statSync(path.join(root, file)).mode & 0o777;
      fs.writeFileSync(path.join(staging, `next-${index}`), text, { mode });
      fs.writeFileSync(path.join(staging, `original-${index}`), originals.get(file), { mode });
      entries.push({ file, index });
      index++;
    }
    fs.writeFileSync(
      path.join(staging, 'recovery.json'),
      JSON.stringify({ schema_version: 1, files: entries }) + '\n',
      { mode: 0o600 }
    );
    for (const entry of entries) {
      fs.renameSync(path.join(staging, `next-${entry.index}`), path.join(root, entry.file));
      replaced.push(entry);
    }
  } catch (error) {
    if (!knownFileError(error)) throw error;
    let recovered = true;
    for (const { file, index } of replaced.reverse()) {
      try {
        fs.renameSync(path.join(staging, `original-${index}`), path.join(root, file));
      } catch (rollbackError) {
        if (!knownFileError(rollbackError)) throw rollbackError;
        recovered = false;
      }
    }
    if (staging && recovered) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch (cleanupError) {
        if (!knownFileError(cleanupError)) throw cleanupError;
        recovered = false;
      }
    }
    throw new VersionSourceError(
      recovered
        ? 'Cannot update release sources; the original files are preserved. Fix write permissions, free disk space or the read-only filesystem, then retry the release bump.'
        : `Cannot finish release-source recovery. Preserve ${staging}, restore its original files using recovery.json, fix storage permissions or disk space, then retry the release bump.`
    );
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    if (!knownFileError(error)) throw error;
    throw new VersionSourceError(
      `Release versions are updated, but cleanup failed. Remove the recovery directory ${staging} after checking the source set, then retry the release bump.`
    );
  }
}

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
  try {
    const pending = fs.readdirSync(root).find((name) => name.startsWith('.release-version-'));
    if (pending)
      throw new VersionSourceError(
        `A previous release update needs recovery. Preserve ${path.join(root, pending)}, inspect recovery.json and the complete source set, then remove the recovery directory before retrying the release bump.`
      );
  } catch (error) {
    if (!knownFileError(error)) throw error;
    throw new VersionSourceError(
      'Cannot inspect release recovery state; fix directory permissions and retry the release bump.'
    );
  }
  const manifestPath = '.tessl-plugin/plugin.json';
  const installerPath = 'skills/sync-tripit/scripts/install-sync.sh';
  const archiveFiles = ['evals/sync-library-installation-and-execution/criteria.json', 'research.md'];
  let manifest;
  let manifestText;
  try {
    manifestText = readSource(root, manifestPath);
    manifest = JSON.parse(manifestText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new VersionSourceError(`Restore valid JSON in ${manifestPath}, then retry the release bump.`);
  }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
    throw new VersionSourceError(`Restore the version field in ${manifestPath}, then retry the release bump.`);
  }
  const installer = readSource(root, installerPath);
  const versionPattern = /local version='\d+\.\d+\.\d+'/g;
  if ([...installer.matchAll(versionPattern)].length !== 1) {
    throw new VersionSourceError(
      `Restore exactly one pinned local version in ${installerPath}, then retry the release bump.`
    );
  }
  const changes = new Map([[installerPath, installer.replace(versionPattern, `local version='${version}'`)]]);
  const originals = new Map([
    [manifestPath, manifestText],
    [installerPath, installer]
  ]);
  for (const file of archiveFiles) {
    const text = readSource(root, file);
    originals.set(file, text);
    const archivePattern = /archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz/g;
    if (![...text.matchAll(archivePattern)].length) {
      throw new VersionSourceError(`Restore the pinned archive URL in ${file}, then retry the release bump.`);
    }
    changes.set(file, text.replace(archivePattern, `archive/refs/tags/v${version}.tar.gz`));
  }
  manifest.version = version;
  changes.set(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  replaceSourceSet(root, changes, originals);
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
