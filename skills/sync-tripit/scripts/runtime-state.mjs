/**
 * Installer-owned completion snapshot. Schema and recovery contract:
 * ../references/runtime-state.md. No application code or credentials are loaded.
 * CLI: check|seal DIRECTORY VERSION. Stdout: JSON with operation, ready, path,
 * requestedVersion. Exit 0: ready/sealed; 1: incomplete runtime; 2: usage;
 * 3: unexpected operational failure; 4: newer state requires a reader update.
 * The installer consumes this internal result.
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
  function report(ready, reason = 'The runtime is incomplete or does not match the requested release.') {
    if (!ready)
      console.error(
        `${reason} Run install-sync.sh to repair it, or verify the published runtime if installation fails.`
      );
    console.log(JSON.stringify({ operation, ready, path: directory, requestedVersion: version }));
    return ready ? 0 : 1;
  }
  try {
    const previous = operation === 'check' || existsSync(marker) ? readJson(marker) : null;
    if (Number.isInteger(previous?.schema_version) && previous.schema_version > 1) {
      console.error(
        'This runtime uses a newer installer schema. Update the reclaim-tripit-sync plugin before retrying; the existing runtime was left intact.'
      );
      console.log(
        JSON.stringify({
          operation,
          ready: false,
          path: directory,
          requestedVersion: version,
          error: 'newer-runtime-schema'
        })
      );
      return 4;
    }
    if (operation === 'check' && (previous?.schema_version !== 1 || previous.requestedVersion !== version))
      return report(false);
    const files = snapshot(directory);
    if (operation === 'check') return report(JSON.stringify(previous.files) === JSON.stringify(files));
    const pending = `${marker}.pending`;
    writeFileSync(pending, JSON.stringify({ schema_version: 1, requestedVersion: version, files }) + '\n');
    renameSync(pending, marker);
    return report(true);
  } catch (error) {
    if (!(error instanceof IncompleteRuntimeError)) throw error;
    return report(false, error.message);
  }
}

/** Fixed diagnostic vocabulary and an owner-source location, never raw error text. */
export function verificationDiagnostic(error) {
  const types = [SyntaxError, TypeError, RangeError, ReferenceError, URIError, EvalError, Error];
  const failureKind = types.find((type) => error instanceof type)?.name ?? 'non-Error';
  const codes = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EIO', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE'];
  const failureCode =
    error instanceof Error && 'code' in error && codes.includes(String(error.code))
      ? String(error.code)
      : 'unclassified';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const markers = [
    'permission denied',
    'read-only',
    'disk full',
    'no such file',
    'not a directory',
    'invalid json',
    'cannot find module',
    'module not found'
  ];
  const failureMessage =
    markers.filter((marker) => message.includes(marker)).join(', ') ||
    'No recognized operational marker; inspect helper and dependency metadata.';
  const frame = error instanceof Error ? /runtime-state\.mjs:(\d+):(\d+)/.exec(error.stack ?? '') : null;
  return {
    failureKind,
    failureCode,
    failureMessage,
    failureLocation: frame ? `runtime-state.mjs:${frame[1]}:${frame[2]}` : 'unavailable'
  };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
    // outer-boundary-process-contract: install-sync.sh treats exit 1 as an
    // incomplete runtime it may repair. Emit JSON and an actionable diagnostic
    // with exit 3 for unexpected failures; propagation would also exit 1 and
    // incorrectly turn a verification failure into permission to reinstall.
  } catch (error) {
    console.log(
      JSON.stringify({
        operation: process.argv[2],
        path: process.argv[3],
        requestedVersion: process.argv[4],
        ready: false,
        error: 'runtime-verification-failed',
        ...verificationDiagnostic(error)
      })
    );
    const diagnostic = verificationDiagnostic(error);
    console.error(
      `Runtime verification failed unexpectedly (${diagnostic.failureKind}, ${diagnostic.failureCode}, ${diagnostic.failureLocation}: ${diagnostic.failureMessage}); inspect directory permissions and the runtime-state helper before retrying install-sync.sh.`
    );
    process.exitCode = 3;
  }
}
