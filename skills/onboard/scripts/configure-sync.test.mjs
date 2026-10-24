import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const helper = fileURLToPath(new URL('configure-sync.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../../sync-tripit/scripts/run-sync.sh', import.meta.url));
const hidden = [
  'TRIPIT_ICAL_URL',
  'RECLAIM_API_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'ONECLI_URL',
  'ENABLE_OOO',
  'HOME_TZ',
  'TRIPIT_IGNORE_TRIPS',
  'TRIPIT_IGNORE_KEYWORDS'
];
let root, install, source, env;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-config-'));
  install = path.join(root, 'runtime with spaces');
  source = path.join(root, 'provided.env');
  env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !hidden.includes(name)));
  env.HOME = root;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function run(...args) {
  return spawnSync(process.execPath, [helper, ...args], { cwd: root, env, encoding: 'utf8' });
}
function input(extra = '') {
  fs.writeFileSync(
    source,
    `TRIPIT_ICAL_URL='https://fixture.invalid/private#feed'\nRECLAIM_API_TOKEN=fixture-private-value\n${extra}`
  );
}
function runtime(code = 'console.log(JSON.stringify({errors:[],mode:process.argv[2]}));') {
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'sync.mjs'), code);
}

describe('private onboarding outcomes', () => {
  it('emits actionable stderr and structured stdout for invalid arguments', () => {
    const result = run('unknown');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Use configure.*verify/);
    assert.equal(JSON.parse(result.stdout).ok, false);
  });
  it('stores only declared fields, preserves values and emits no credentials', () => {
    input('HOME_TZ=America/Chicago\nTELEGRAM_BOT_TOKEN=unrelated-fixture\n');
    const result = run('configure', source, install);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).features.homeTimezoneSet, true);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-value|private#feed|unrelated-fixture/);
    const target = path.join(install, '.env');
    assert.deepEqual(parseEnv(fs.readFileSync(target, 'utf8')), {
      TRIPIT_ICAL_URL: 'https://fixture.invalid/private#feed',
      RECLAIM_API_TOKEN: 'fixture-private-value',
      HOME_TZ: 'America/Chicago'
    });
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(run('configure', target, install).status, 0);
    assert.equal(parseEnv(fs.readFileSync(target, 'utf8')).RECLAIM_API_TOKEN, 'fixture-private-value');
  });
  it('reports missing names without replacing a previous configuration', () => {
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, '.env'), 'PREVIOUS=keep');
    fs.writeFileSync(source, 'TRIPIT_ICAL_URL=private-incomplete-fixture\n');
    const result = run('configure', source, install);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).missing, ['RECLAIM_API_TOKEN']);
    assert.match(result.stderr, /Set the missing variables privately/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-incomplete-fixture/);
    assert.equal(fs.readFileSync(path.join(install, '.env'), 'utf8'), 'PREVIOUS=keep');
  });
  it('uses OneCLI credentials without persisting inherited values or requesting Google OAuth', () => {
    env.ONECLI_URL = 'http://gateway.invalid';
    env.TRIPIT_ICAL_URL = 'gateway-fixture-feed';
    env.RECLAIM_API_TOKEN = 'gateway-fixture-token';
    env.ENABLE_OOO = '1';
    const result = run('configure', path.join(root, 'absent.env'), install);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.features.onecli, true);
    assert.equal(body.features.googleOoo, true);
    assert.doesNotMatch(result.stdout, /gateway-fixture/);
    assert.equal(fs.existsSync(path.join(install, '.env')), false);
  });
  it('asks for a path only after both source and required environment are absent', () => {
    const result = run('configure', path.join(root, 'absent.env'), install);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).missingSource, true);
  });
  it('refuses linked input without replacing its target', () => {
    input();
    const link = path.join(root, 'linked.env');
    fs.symlinkSync(source, link);
    const result = run('configure', link, install);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-value/);
    assert.equal(fs.existsSync(path.join(install, '.env')), false);
  });
  it('verifies through dry-run and preserves literal shell syntax as data', () => {
    const marker = path.join(root, 'must-not-exist');
    fs.writeFileSync(source, `TRIPIT_ICAL_URL='$(touch ${marker})'\nRECLAIM_API_TOKEN=fixture-private-value\n`);
    assert.equal(run('configure', source, install).status, 0);
    runtime(
      'console.log(JSON.stringify({errors:process.env.TRIPIT_ICAL_URL.startsWith("$(")?[]:["missing literal"],mode:process.argv[2]}));'
    );
    const result = run('verify', install);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(fs.existsSync(marker), false);
    const actualRunner = spawnSync('bash', [runner, install], { env, encoding: 'utf8' });
    assert.equal(actualRunner.status, 0, actualRunner.stderr);
    assert.equal(JSON.parse(actualRunner.stdout).mode, 'sync');
    assert.equal(fs.existsSync(marker), false);
  });
  for (const outcome of ['exit', 'provider-error', 'malformed']) {
    it(`reports safe verification failure for ${outcome}`, () => {
      input();
      assert.equal(run('configure', source, install).status, 0);
      runtime(
        outcome === 'exit'
          ? 'console.error("fixture-private-value");process.exitCode=7;'
          : outcome === 'provider-error'
            ? 'console.log(JSON.stringify({errors:["fixture-private-value"]}));'
            : 'console.log("fixture-private-value");'
      );
      const result = run('verify', install);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).ok, false);
      assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-value/);
    });
  }
  it('names installation as the recovery when the runtime is missing', () => {
    input();
    assert.equal(run('configure', source, install).status, 0);
    const result = run('verify', install);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /install-sync.sh/);
  });
  it('does not load Node startup code from a legacy credential file', () => {
    input();
    assert.equal(run('configure', source, install).status, 0);
    fs.appendFileSync(path.join(install, '.env'), 'NODE_OPTIONS=--require=./must-not-load.cjs\n');
    runtime();
    assert.equal(run('verify', install).status, 0);
    const actual = spawnSync('bash', [runner, install], { env, encoding: 'utf8' });
    assert.equal(actual.status, 0, actual.stderr);
  });
  it('preserves stored configuration when inherited credentials accompany an unrelated source file', () => {
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, '.env'), 'HOME_TZ=America/Chicago\n');
    fs.writeFileSync(source, 'UNRELATED_SETTING=fixture\n');
    env.TRIPIT_ICAL_URL = 'inherited-feed-fixture';
    env.RECLAIM_API_TOKEN = 'inherited-token-fixture';
    assert.equal(run('configure', source, install).status, 0);
    assert.equal(fs.readFileSync(path.join(install, '.env'), 'utf8'), 'HOME_TZ=America/Chicago\n');
  });
});
