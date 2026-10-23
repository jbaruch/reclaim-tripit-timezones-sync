/**
 * Installer-owned completion snapshot. Schema and recovery contract:
 * ../references/runtime-state.md. No application code or credentials are loaded.
 * CLI: check|seal DIRECTORY VERSION. Silent exit 0: ready/sealed; 1: incomplete
 * (check) or invalid staged runtime (seal); 2: usage. Unexpected I/O fails visibly.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const markerName = '.sync-runtime.json';
class IncompleteRuntimeError extends Error {}

function regularFile(path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new IncompleteRuntimeError('Missing runtime file.');
}

function readJson(path) {
  regularFile(path);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new IncompleteRuntimeError('Invalid runtime metadata.');
    throw error;
  }
}

function snapshot(directory) {
  const files = ['sync.mjs', 'package.json', 'package-lock.json', 'node_modules/.package-lock.json'];
  function addLibrary(path) {
    for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) addLibrary(name);
      else if (entry.isFile()) files.push(name);
      else throw new IncompleteRuntimeError('Runtime library contains an unsupported file.');
    }
  }
  if (existsSync(join(directory, 'lib'))) {
    if (!lstatSync(join(directory, 'lib')).isDirectory()) throw new IncompleteRuntimeError('Invalid runtime library.');
    addLibrary('lib');
  }
  const hashes = {};
  for (const file of files.sort()) {
    const path = join(directory, file);
    regularFile(path);
    hashes[file] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  const metadata = readJson(join(directory, 'package.json'));
  const installed = readJson(join(directory, 'node_modules/.package-lock.json'));
  if (!installed || typeof installed.packages !== 'object' || installed.packages === null) {
    throw new IncompleteRuntimeError('Missing npm installation metadata.');
  }
  for (const name of Object.keys(installed.packages)) {
    const path = resolve(directory, name);
    if (!name.startsWith('node_modules/') || isAbsolute(name) || relative(directory, path).startsWith('..')) {
      throw new IncompleteRuntimeError('Invalid installed dependency path.');
    }
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new IncompleteRuntimeError('Missing installed dependency.');
    }
  }
  const require = createRequire(join(directory, 'package.json'));
  const modulesRoot = `${realpathSync(join(directory, 'node_modules'))}/`;
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    let entry;
    try {
      entry = require.resolve(dependency);
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw new IncompleteRuntimeError('Required dependency cannot be resolved.');
      }
      throw error;
    }
    if (!realpathSync(entry).startsWith(modulesRoot)) {
      throw new IncompleteRuntimeError('Required dependency resolves outside this installation.');
    }
  }
  return hashes;
}

export function main(args = process.argv.slice(2)) {
  const [operation, input, version] = args;
  if (args.length !== 3 || !['check', 'seal'].includes(operation) || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: node runtime-state.mjs check|seal DIRECTORY VERSION — use the co-shipped installer.');
    return 2;
  }
  const requested = resolve(input);
  const directory = existsSync(requested) ? realpathSync(requested) : requested;
  if (directory === parse(directory).root) {
    console.error('Choose a dedicated runtime directory, not the filesystem root, then retry install-sync.sh.');
    return 2;
  }
  const marker = join(directory, markerName);
  try {
    const previous = operation === 'check' ? readJson(marker) : null;
    if (operation === 'check' && (previous?.schema_version !== 1 || previous.requestedVersion !== version)) return 1;
    const files = snapshot(directory);
    if (operation === 'check') return JSON.stringify(previous.files) === JSON.stringify(files) ? 0 : 1;
    const pending = `${marker}.pending`;
    writeFileSync(pending, JSON.stringify({ schema_version: 1, requestedVersion: version, files }) + '\n');
    renameSync(pending, marker);
    return 0;
  } catch (error) {
    if (!(error instanceof IncompleteRuntimeError)) throw error;
    if (operation === 'seal') console.error(`${error.message} Retry install-sync.sh or verify the published runtime.`);
    return 1;
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
