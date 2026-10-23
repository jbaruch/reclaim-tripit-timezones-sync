import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('install-sync.sh', import.meta.url));
const runner = fileURLToPath(new URL('run-sync.sh', import.meta.url));

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const payload = join(root, 'payload');
  const runtime = join(payload, 'runtime');
  const destination = join(root, 'install with spaces');
  for (const folder of [bin, runtime, destination]) mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(runtime, 'sync.mjs'),
    'console.log(JSON.stringify({mode:process.argv[2], output:process.argv[3],fixture:process.env.FIXTURE_VALUE}));\n'
  );
  writeFileSync(join(runtime, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(runtime, 'package-lock.json'), '{}\n');
  const archive = join(root, 'runtime.tar.gz');
  const packed = spawnSync('tar', ['czf', archive, '-C', payload, 'runtime'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
set -eu
if [ "\${FIXTURE_FAIL_DOWNLOAD:-0}" = 1 ]; then
  echo 'Fixture download failed; retry later.' >&2
  exit 22
fi
case "$2" in
  https://github.com/jbaruch/reclaim-tripit-timezones-sync/archive/refs/tags/v0.3.4.tar.gz) ;;
  *) echo 'Unexpected archive URL' >&2; exit 2 ;;
esac
cp "$FIXTURE_ARCHIVE" "$4"
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh
set -eu
if [ "\${FIXTURE_FAIL_NPM:-0}" = 1 ]; then
  echo 'Fixture npm install failed; retry later.' >&2
  exit 9
fi
mkdir -p node_modules
echo ready > node_modules/fixture-ready
echo 'Fixture npm progress' >&2
`,
    { mode: 0o755 }
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ARCHIVE: archive };
  return { root, bin, destination, env };
}

describe('shipped sync installer and runner', () => {
  it('installs a complete runtime, preserves configuration, and emits JSON only', (t) => {
    const f = fixture(t);
    writeFileSync(join(f.destination, '.env'), 'FIXTURE_VALUE=operator-file\n');
    const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(JSON.parse(installed.stdout), {
      status: 'installed',
      path: f.destination,
      requestedVersion: '0.3.4'
    });
    assert.equal(readFileSync(join(f.destination, '.env'), 'utf8'), 'FIXTURE_VALUE=operator-file\n');
    assert.ok(existsSync(join(f.destination, 'node_modules/fixture-ready')));
    assert.ok(existsSync(join(f.destination, 'sync.mjs')));
    const run = spawnSync('bash', [runner, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { mode: 'sync', output: '--output=json', fixture: 'operator-file' });
  });

  it('keeps an existing runtime without downloading or claiming its version', (t) => {
    const f = fixture(t);
    writeFileSync(join(f.destination, 'sync.mjs'), '// Existing runtime\n');
    const run = spawnSync('bash', [installer, f.destination], {
      env: { ...f.env, FIXTURE_FAIL_DOWNLOAD: '1' },
      encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'present');
    assert.equal(readFileSync(join(f.destination, 'sync.mjs'), 'utf8'), '// Existing runtime\n');
  });

  for (const [failure, expected] of [
    ['FIXTURE_FAIL_DOWNLOAD', 22],
    ['FIXTURE_FAIL_NPM', 9]
  ]) {
    it(`does not publish a ready entrypoint after ${failure}`, (t) => {
      const f = fixture(t);
      const run = spawnSync('bash', [installer, f.destination], {
        env: { ...f.env, [failure]: '1' },
        encoding: 'utf8'
      });
      assert.equal(run.status, expected, run.stderr);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /Fixture.*failed/);
      assert.equal(existsSync(join(f.destination, 'sync.mjs')), false);
      const retry = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(JSON.parse(retry.stdout).status, 'installed');
    });
  }

  it('returns actionable failure when the runtime is absent', (t) => {
    const f = fixture(t);
    const run = spawnSync('bash', [runner, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /run the co-shipped install-sync.sh/);
  });

  it('preserves runtime JSON and its nonzero process status', (t) => {
    const f = fixture(t);
    writeFileSync(
      join(f.destination, 'sync.mjs'),
      'console.log(JSON.stringify({errors:["Fixture failure"]}));process.exitCode=7;\n'
    );
    const run = spawnSync('bash', [runner, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(run.status, 7);
    assert.deepEqual(JSON.parse(run.stdout), { errors: ['Fixture failure'] });
  });

  for (const script of [installer, runner]) {
    it(`sources ${script.split('/').at(-1)} without installing or executing`, (t) => {
      const f = fixture(t);
      const run = spawnSync('bash', ['-c', 'source "$1"', 'fixture', script], { env: f.env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, '');
      assert.equal(existsSync(join(f.destination, 'sync.mjs')), false);
    });
  }
});

describe('release version synchronization', () => {
  it('updates the moved installer pin and archive references from any working directory', (t) => {
    const f = fixture(t);
    const root = join(f.root, 'release-repo');
    const paths = [
      'scripts',
      '.tessl-plugin',
      'skills/sync-tripit/scripts',
      'evals/sync-library-installation-and-execution'
    ];
    for (const name of paths) mkdirSync(join(root, name), { recursive: true });
    const script = join(root, 'scripts/bump-version.sh');
    writeFileSync(script, readFileSync(new URL('../../../scripts/bump-version.sh', import.meta.url)));
    writeFileSync(join(root, '.tessl-plugin/plugin.json'), '{"name":"fixture/plugin","version":"0.3.4"}\n');
    writeFileSync(join(root, 'skills/sync-tripit/scripts/install-sync.sh'), readFileSync(installer));
    const url = 'https://github.com/jbaruch/reclaim-tripit-timezones-sync/archive/refs/tags/v0.3.4.tar.gz';
    writeFileSync(join(root, 'evals/sync-library-installation-and-execution/criteria.json'), JSON.stringify({ url }));
    writeFileSync(join(root, 'research.md'), `Example version 0.3.0\n${url}\n`);
    const invalid = spawnSync('bash', [script, '4.5'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(readFileSync(join(root, '.tessl-plugin/plugin.json'), 'utf8')).version, '0.3.4');
    const run = spawnSync('bash', [script, '4.5.6'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).version, '4.5.6');
    assert.equal(JSON.parse(readFileSync(join(root, '.tessl-plugin/plugin.json'), 'utf8')).version, '4.5.6');
    assert.match(
      readFileSync(join(root, 'skills/sync-tripit/scripts/install-sync.sh'), 'utf8'),
      /local version='4\.5\.6'/
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, 'evals/sync-library-installation-and-execution/criteria.json'), 'utf8')).url,
      url.replace('v0.3.4', 'v4.5.6')
    );
    const research = readFileSync(join(root, 'research.md'), 'utf8');
    assert.ok(research.includes(url.replace('v0.3.4', 'v4.5.6')));
    assert.ok(research.includes('Example version 0.3.0'));
  });

  it('sources the release helper without changing files or producing output', (t) => {
    const f = fixture(t);
    const script = fileURLToPath(new URL('../../../scripts/bump-version.sh', import.meta.url));
    const run = spawnSync('bash', ['-c', 'source "$1"', 'fixture', script], { cwd: f.root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
  });
});
