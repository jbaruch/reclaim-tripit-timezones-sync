/** Private configuration and safe dry-run outcomes: ../references/configuration.md. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const required = ['TRIPIT_ICAL_URL', 'RECLAIM_API_TOKEN'];
const allowed = [
  ...required,
  'HOME_TZ',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'TRIPIT_IGNORE_TRIPS',
  'TRIPIT_IGNORE_KEYWORDS',
  'OOO_RETRY_DELAY_MS',
  'ENABLE_OOO'
];
class ConfigurationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.detail = detail;
  }
}
function knownFs(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR', 'ENOSPC', 'EROFS', 'EIO'].includes(String(error.code))
  );
}
function values(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      throw new ConfigurationError('Choose a regular credential file without links, then retry configuration.');
    return parseEnv(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
function existing(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (!knownFs(error) || error.code !== 'ENOENT') throw error;
    return false;
  }
}
function featureFlags(env) {
  const google = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].map((name) => Boolean(env[name]));
  const flag = env.ENABLE_OOO?.trim().toLowerCase();
  const onecli = Boolean(env.ONECLI_URL);
  return {
    onecli,
    homeTimezoneSet: Boolean(env.HOME_TZ),
    googleOoo: onecli
      ? !['0', 'false', 'no', 'off'].includes(flag) &&
        (['1', 'true', 'yes', 'on'].includes(flag) || google.every(Boolean))
      : google.every(Boolean),
    partialGoogleCredentials: !onecli && google.some(Boolean) && !google.every(Boolean),
    tripFiltersSet: Boolean(env.TRIPIT_IGNORE_TRIPS || env.TRIPIT_IGNORE_KEYWORDS)
  };
}
function encoded(name, value) {
  for (const candidate of [`${name}=${value}\n`, `${name}='${value}'\n`, `${name}="${value}"\n`]) {
    let decoded;
    try {
      decoded = parseEnv(candidate);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (Object.keys(decoded).length === 1 && decoded[name] === value) return candidate;
  }
  throw new ConfigurationError('Rewrite the file with valid quoted dotenv values, then retry configuration.');
}
function store(directory, selected) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, '.env');
  if (existing(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new ConfigurationError('Remove linked credential destinations before retrying configuration.');
  }
  const pending = path.join(directory, `.env.pending-${randomUUID()}`);
  try {
    fs.writeFileSync(
      pending,
      Object.entries(selected)
        .map(([name, value]) => encoded(name, value))
        .join(''),
      { mode: 0o600, flag: 'wx' }
    );
    fs.renameSync(pending, target);
  } finally {
    if (existing(pending)) fs.unlinkSync(pending);
  }
}

export function main(args = process.argv.slice(2)) {
  const [operation, first, second] = args;
  if (!['configure', 'verify'].includes(operation) || args.length > (operation === 'configure' ? 3 : 2)) {
    console.log(
      JSON.stringify({
        schema_version: 1,
        ok: false,
        error: 'Use configure [SOURCE_FILE] [INSTALL_DIR] or verify [INSTALL_DIR].'
      })
    );
    return 2;
  }
  try {
    const directory = path.resolve(
      (operation === 'configure' ? second : first) || path.join(os.homedir(), '.tripit-reclaim')
    );
    if (directory === path.parse(directory).root)
      throw new ConfigurationError('Choose a dedicated installation directory, then retry configuration.');
    let selected;
    if (operation === 'configure') {
      const candidates = first
        ? [path.resolve(first)]
        : [
            '/tmp/tripit-creds.txt',
            path.resolve('tripit-creds.txt'),
            path.resolve('.env'),
            path.join(directory, '.env')
          ];
      const source = candidates.find(existing);
      const input = source ? values(source) : {};
      selected = Object.fromEntries(
        allowed.filter((name) => input[name] !== undefined).map((name) => [name, input[name]])
      );
      const effective = { ...selected, ...process.env };
      const missing = required.filter((name) => !effective[name]?.trim());
      if (!source && missing.length)
        throw new ConfigurationError(
          'Provide a credential-file path or configure the required environment variables; never paste values into chat.',
          { missingSource: true, missing }
        );
      if (missing.length)
        throw new ConfigurationError(
          'Set the missing variables privately in the file or environment, then retry configuration.',
          { missing }
        );
      if (source) store(directory, selected);
      console.log(
        JSON.stringify({
          schema_version: 1,
          ok: true,
          operation,
          path: directory,
          variables: Object.keys(selected),
          features: featureFlags(effective)
        })
      );
      return 0;
    }
    const envFile = path.join(directory, '.env');
    const loaded = existing(envFile) ? values(envFile) : {};
    selected = Object.fromEntries(
      allowed.filter((name) => loaded[name] !== undefined).map((name) => [name, loaded[name]])
    );
    const env = { ...selected, ...process.env };
    const missing = required.filter((name) => !env[name]?.trim());
    if (missing.length)
      throw new ConfigurationError('Configure the missing variables privately, then retry the dry-run.', { missing });
    const runtime = path.join(directory, 'sync.mjs');
    if (!existing(runtime))
      throw new ConfigurationError('Run the co-shipped install-sync.sh before retrying the dry-run.');
    const run = spawnSync(process.execPath, [runtime, 'dry-run', '--output=json'], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
    if (run.error || run.status !== 0)
      throw new ConfigurationError(
        'Dry-run failed. Check provider access, configuration and network privately, then retry verification.'
      );
    let result;
    try {
      result = JSON.parse(run.stdout);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ConfigurationError(
        'The runtime returned malformed JSON; repair the installed runtime and retry verification.'
      );
    }
    if (!result || !Array.isArray(result.errors) || result.errors.length)
      throw new ConfigurationError(
        'The runtime reported errors. Check provider access and configuration privately, then retry verification.'
      );
    console.log(
      JSON.stringify({ schema_version: 1, ok: true, operation, path: directory, features: featureFlags(env) })
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ConfigurationError) && !(error instanceof SyntaxError) && !knownFs(error)) throw error;
    const message =
      error instanceof ConfigurationError
        ? error.message
        : 'Cannot read or store the file. Repair dotenv syntax, permissions and disk space, then retry configuration.';
    console.log(
      JSON.stringify({
        schema_version: 1,
        ok: false,
        operation,
        error: message,
        ...(error instanceof ConfigurationError ? error.detail : {})
      })
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = main();
