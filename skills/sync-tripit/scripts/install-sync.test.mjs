import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  realpathSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('install-sync.sh', import.meta.url));
const runner = fileURLToPath(new URL('run-sync.sh', import.meta.url));
const runtimeState = fileURLToPath(new URL('runtime-state.mjs', import.meta.url));
const installedVersion = JSON.parse(
  readFileSync(new URL('../../../.tessl-plugin/plugin.json', import.meta.url), 'utf8')
).version;

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
  writeFileSync(
    join(runtime, 'package.json'),
    '{"name":"fixture","version":"1.0.0","dependencies":{"fixture-dep":"1.0.0"}}\n'
  );
  writeFileSync(join(runtime, 'package-lock.json'), '{}\n');
  mkdirSync(join(runtime, 'lib'));
  writeFileSync(join(runtime, 'lib/helper.mjs'), 'export const ready = true;\n');
  const archive = join(root, 'runtime.tar.gz');
  const packed = spawnSync('tar', ['czf', archive, '-C', payload, 'runtime'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${FIXTURE_FAIL_DOWNLOAD:-0}" = 1 ]; then
  echo 'Fixture download failed; retry later.' >&2
  exit 22
fi
case "$2" in
  https://github.com/jbaruch/reclaim-tripit-timezones-sync/archive/refs/tags/v${installedVersion}.tar.gz) ;;
  *) echo 'Unexpected archive URL' >&2; exit 2 ;;
esac
cp "$FIXTURE_ARCHIVE" "$4"
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${FIXTURE_FAIL_NPM:-0}" = 1 ]; then
  echo 'Fixture npm install failed; retry later.' >&2
  exit 9
fi
mkdir -p node_modules/fixture-dep
echo '{"packages":{"node_modules/fixture-dep":{"version":"1.0.0"}}}' > node_modules/.package-lock.json
echo '{"name":"fixture-dep","version":"1.0.0","main":"index.js"}' > node_modules/fixture-dep/package.json
echo 'module.exports = {};' > node_modules/fixture-dep/index.js
echo ready > node_modules/fixture-ready
echo 'Fixture npm progress' >&2
`,
    { mode: 0o755 }
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ARCHIVE: archive };
  return { root, bin, destination, env };
}

describe('shipped sync installer and runner', () => {
  for (const existing of [false, true]) {
    for (const nodeVersion of ['v20.20.0', 'v22.18.0', 'unknown-version']) {
      it(`refuses ${nodeVersion} before ${existing ? 'reusing' : 'installing'} a runtime`, (t) => {
        const f = fixture(t);
        if (existing) {
          const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
          assert.equal(installed.status, 0, installed.stderr);
        }
        writeFileSync(join(f.destination, '.env'), 'FIXTURE_VALUE=keep-config\n');
        const before = existing ? readFileSync(join(f.destination, '.sync-runtime.json'), 'utf8') : null;
        writeFileSync(
          join(f.bin, 'node'),
          `#!/bin/bash
set -euo pipefail
if [[ "$1" != '--version' ]]; then
  echo 'Unexpected runtime invocation before the Node gate' >&2
  exit 97
fi
printf '%s\\n' '${nodeVersion}'
`,
          { mode: 0o755 }
        );
        const run = spawnSync('/bin/bash', [installer, f.destination], {
          env: { ...f.env, FIXTURE_FAIL_DOWNLOAD: '1' },
          encoding: 'utf8'
        });
        assert.equal(run.status, 1, run.stderr);
        assert.equal(run.stdout, '');
        assert.match(run.stderr, /install Node >=22\.19\.0 and retry install-sync\.sh/);
        assert.equal(readFileSync(join(f.destination, '.env'), 'utf8'), 'FIXTURE_VALUE=keep-config\n');
        if (existing) assert.equal(readFileSync(join(f.destination, '.sync-runtime.json'), 'utf8'), before);
        else assert.equal(existsSync(join(f.destination, 'sync.mjs')), false);
      });
    }
    it(`accepts the minimum Node version before ${existing ? 'reusing' : 'installing'} a runtime`, (t) => {
      const f = fixture(t);
      if (existing) {
        const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
        assert.equal(installed.status, 0, installed.stderr);
      }
      writeFileSync(
        join(f.bin, 'node'),
        `#!/bin/bash
set -euo pipefail
if [[ "$1" == '--version' ]]; then
  printf '%s\\n' 'v22.19.0'
  exit 0
fi
exec '${process.execPath}' "$@"
`,
        { mode: 0o755 }
      );
      const run = spawnSync('/bin/bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).status, existing ? 'present' : 'installed');
    });
  }
  it('runs both declared plugin-mount commands from a consumer workspace', (t) => {
    const f = fixture(t);
    const workspace = join(f.root, 'consumer');
    const relative = '.tessl/plugins/jbaruch/reclaim-tripit-sync/skills/sync-tripit/scripts';
    mkdirSync(join(workspace, relative), { recursive: true });
    writeFileSync(join(workspace, relative, 'install-sync.sh'), readFileSync(installer));
    writeFileSync(join(workspace, relative, 'run-sync.sh'), readFileSync(runner));
    writeFileSync(join(workspace, relative, 'runtime-state.mjs'), readFileSync(runtimeState));
    const installed = spawnSync('bash', [`${relative}/install-sync.sh`, f.destination], {
      cwd: workspace,
      env: f.env,
      encoding: 'utf8'
    });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).status, 'installed');
    const run = spawnSync('bash', [`${relative}/run-sync.sh`, f.destination], {
      cwd: workspace,
      env: f.env,
      encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).mode, 'sync');
  });
  it('installs a complete runtime, preserves configuration, and emits JSON only', (t) => {
    const f = fixture(t);
    writeFileSync(join(f.destination, '.env'), 'FIXTURE_VALUE=operator-file\n');
    const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(JSON.parse(installed.stdout), {
      status: 'installed',
      path: f.destination,
      requestedVersion: installedVersion
    });
    assert.equal(readFileSync(join(f.destination, '.env'), 'utf8'), 'FIXTURE_VALUE=operator-file\n');
    assert.ok(existsSync(join(f.destination, 'node_modules/fixture-ready')));
    assert.ok(existsSync(join(f.destination, 'sync.mjs')));
    const run = spawnSync('bash', [runner, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { mode: 'sync', output: '--output=json', fixture: 'operator-file' });
  });

  it('reuses a complete runtime with only Node available and no installer tools', (t) => {
    const f = fixture(t);
    const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    const onlyNode = join(f.root, 'node-only');
    mkdirSync(onlyNode);
    symlinkSync(process.execPath, join(onlyNode, 'node'));
    const before = readFileSync(join(f.destination, 'sync.mjs'), 'utf8');
    const run = spawnSync('/bin/bash', [installer, f.destination], {
      env: { ...f.env, PATH: onlyNode, FIXTURE_FAIL_DOWNLOAD: '1' },
      encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'present');
    assert.equal(readFileSync(join(f.destination, 'sync.mjs'), 'utf8'), before);
  });

  it('repairs a legacy partial installation and preserves operator configuration', (t) => {
    const f = fixture(t);
    writeFileSync(join(f.destination, 'sync.mjs'), 'throw new Error("Never execute the partial runtime");\n');
    writeFileSync(join(f.destination, '.env'), 'FIXTURE_VALUE=keep-me\n');
    const run = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'installed');
    assert.equal(readFileSync(join(f.destination, '.env'), 'utf8'), 'FIXTURE_VALUE=keep-me\n');
    const executed = spawnSync('bash', [runner, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(JSON.parse(executed.stdout).fixture, 'keep-me');
  });

  for (const damage of [
    'missing dependency',
    'missing dependency entrypoint',
    'missing metadata',
    'changed library',
    'obsolete library',
    'malformed marker',
    'old schema',
    'wrong release'
  ]) {
    it(`repairs ${damage} instead of reporting a ready runtime`, (t) => {
      const f = fixture(t);
      const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
      assert.equal(installed.status, 0, installed.stderr);
      const marker = join(f.destination, '.sync-runtime.json');
      if (damage === 'missing dependency') rmSync(join(f.destination, 'node_modules/fixture-dep'), { recursive: true });
      else if (damage === 'missing dependency entrypoint')
        rmSync(join(f.destination, 'node_modules/fixture-dep/index.js'));
      else if (damage === 'missing metadata') rmSync(join(f.destination, 'node_modules/.package-lock.json'));
      else if (damage === 'changed library') writeFileSync(join(f.destination, 'lib/helper.mjs'), 'broken library\n');
      else if (damage === 'obsolete library') writeFileSync(join(f.destination, 'lib/obsolete.mjs'), 'obsolete file\n');
      else if (damage === 'malformed marker') writeFileSync(marker, 'bad JSON');
      else {
        const state = JSON.parse(readFileSync(marker, 'utf8'));
        if (damage === 'old schema') state.schema_version = 0;
        if (damage === 'wrong release') state.requestedVersion = '0.0.1';
        writeFileSync(marker, JSON.stringify(state));
      }
      const repaired = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(JSON.parse(repaired.stdout).status, 'installed');
      assert.equal(existsSync(join(f.destination, 'lib/obsolete.mjs')), false);
      const present = spawnSync('bash', [installer, f.destination], {
        env: { ...f.env, FIXTURE_FAIL_DOWNLOAD: '1' },
        encoding: 'utf8'
      });
      assert.equal(present.status, 0, present.stderr);
      assert.equal(JSON.parse(present.stdout).status, 'present');
    });
  }

  it('preserves a newer runtime schema and refuses both reinstall and sealing', (t) => {
    const f = fixture(t);
    const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    const marker = join(f.destination, '.sync-runtime.json');
    const state = JSON.parse(readFileSync(marker, 'utf8'));
    state.schema_version = 2;
    writeFileSync(marker, JSON.stringify(state));
    const before = readFileSync(marker, 'utf8');
    const mainBefore = readFileSync(join(f.destination, 'sync.mjs'), 'utf8');
    const reused = spawnSync('bash', [installer, f.destination], {
      env: { ...f.env, FIXTURE_FAIL_DOWNLOAD: '1' },
      encoding: 'utf8'
    });
    assert.equal(reused.status, 4, reused.stderr);
    assert.equal(reused.stdout, '');
    assert.match(reused.stderr, /Update the reclaim-tripit-sync plugin/);
    assert.doesNotMatch(reused.stderr, /Fixture download failed/);
    const sealed = spawnSync(process.execPath, [runtimeState, 'seal', f.destination, installedVersion], {
      encoding: 'utf8'
    });
    assert.equal(sealed.status, 4, sealed.stderr);
    assert.equal(JSON.parse(sealed.stdout).error, 'newer-runtime-schema');
    assert.equal(readFileSync(marker, 'utf8'), before);
    assert.equal(readFileSync(join(f.destination, 'sync.mjs'), 'utf8'), mainBefore);
  });

  it('propagates unexpected verifier failures instead of repairing the runtime', (t) => {
    const f = fixture(t);
    const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    const preload = join(f.root, 'verifier-failure.mjs');
    writeFileSync(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file).endsWith('.sync-runtime.json')) throw new Error('Fixture verifier failure');
  return original.call(this, file, ...args);
};
syncBuiltinESMExports();\n`
    );
    const run = spawnSync('bash', [installer, f.destination], {
      env: { ...f.env, NODE_OPTIONS: `--import=${preload}`, FIXTURE_FAIL_DOWNLOAD: '1' },
      encoding: 'utf8'
    });
    assert.equal(run.status, 3, run.stderr);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Runtime verification failed unexpectedly/);
    assert.doesNotMatch(run.stderr, /Fixture download failed/);
  });

  it('imports runtime-state without inspecting files and rejects invalid CLI usage', (t) => {
    const f = fixture(t);
    const url = new URL('runtime-state.mjs', import.meta.url).href;
    const imported = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
      { cwd: f.root, encoding: 'utf8' }
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    assert.equal(imported.stderr, '');
    const usage = spawnSync(process.execPath, [runtimeState], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/);
    assert.equal(usage.stdout, '');
  });

  it('refuses the filesystem root and a symlink to it before installation', (t) => {
    const f = fixture(t);
    const root = parse(f.root).root;
    const link = join(f.root, 'root-link');
    symlinkSync(root, link);
    for (const path of [root, link]) {
      const check = spawnSync(process.execPath, [runtimeState, 'check', path, installedVersion], { encoding: 'utf8' });
      assert.equal(check.status, 2);
      assert.equal(check.stdout, '');
      assert.match(check.stderr, /Choose a dedicated runtime directory/);
    }
  });

  it('emits structured readiness results for both operations and incomplete installs', (t) => {
    const f = fixture(t);
    const installed = spawnSync('bash', [installer, f.destination], { env: f.env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    for (const operation of ['check', 'seal']) {
      const run = spawnSync(process.execPath, [runtimeState, operation, f.destination, installedVersion], {
        encoding: 'utf8'
      });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), {
        operation,
        ready: true,
        path: realpathSync(f.destination),
        requestedVersion: installedVersion
      });
    }
    rmSync(join(f.destination, 'sync.mjs'));
    const incomplete = spawnSync(process.execPath, [runtimeState, 'check', f.destination, installedVersion], {
      encoding: 'utf8'
    });
    assert.equal(incomplete.status, 1);
    assert.deepEqual(JSON.parse(incomplete.stdout), {
      operation: 'check',
      ready: false,
      path: realpathSync(f.destination),
      requestedVersion: installedVersion
    });
    assert.match(incomplete.stderr, /Run install-sync.sh to repair/);
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

/** @param {import('node:test').TestContext} t */
function releaseFixture(t) {
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
  writeFileSync(
    join(root, 'scripts/bump-version.mjs'),
    readFileSync(new URL('../../../scripts/bump-version.mjs', import.meta.url))
  );
  writeFileSync(join(root, '.tessl-plugin/plugin.json'), '{"name":"fixture/plugin","version":"0.3.4"}\n');
  writeFileSync(join(root, 'skills/sync-tripit/scripts/install-sync.sh'), readFileSync(installer));
  const url = 'https://github.com/jbaruch/reclaim-tripit-timezones-sync/archive/refs/tags/v0.3.4.tar.gz';
  writeFileSync(join(root, 'evals/sync-library-installation-and-execution/criteria.json'), JSON.stringify({ url }));
  writeFileSync(join(root, 'research.md'), `Example version 0.3.0\n${url}\n`);
  return { ...f, releaseRoot: root, script, url };
}

describe('release version synchronization', () => {
  it('reports malformed manifest JSON without changing release sources', (t) => {
    const f = releaseFixture(t);
    const files = [
      '.tessl-plugin/plugin.json',
      'skills/sync-tripit/scripts/install-sync.sh',
      'evals/sync-library-installation-and-execution/criteria.json',
      'research.md'
    ];
    writeFileSync(join(f.releaseRoot, files[0]), '{invalid JSON');
    const before = files.map((file) => readFileSync(join(f.releaseRoot, file), 'utf8'));
    const run = spawnSync('bash', [f.script, '4.5.6'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Restore valid JSON in \.tessl-plugin\/plugin.json, then retry/);
    assert.deepEqual(
      files.map((file) => readFileSync(join(f.releaseRoot, file), 'utf8')),
      before
    );
  });

  for (const damaged of [
    'skills/sync-tripit/scripts/install-sync.sh',
    'evals/sync-library-installation-and-execution/criteria.json',
    'research.md',
    'duplicate installer pin'
  ]) {
    it(`fails without changing any source when ${damaged} has no unique expected pattern`, (t) => {
      const f = releaseFixture(t);
      const files = [
        '.tessl-plugin/plugin.json',
        'skills/sync-tripit/scripts/install-sync.sh',
        'evals/sync-library-installation-and-execution/criteria.json',
        'research.md'
      ];
      if (damaged === 'duplicate installer pin') {
        const file = join(f.releaseRoot, files[1]);
        writeFileSync(file, readFileSync(file, 'utf8') + "\nlocal version='0.3.4'\n");
      } else {
        writeFileSync(join(f.releaseRoot, damaged), 'Expected release pattern removed\n');
      }
      const before = files.map((file) => readFileSync(join(f.releaseRoot, file), 'utf8'));
      const run = spawnSync('bash', [f.script, '4.5.6'], { cwd: f.root, encoding: 'utf8' });
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /Restore.*then retry the release bump/);
      assert.deepEqual(
        files.map((file) => readFileSync(join(f.releaseRoot, file), 'utf8')),
        before
      );
    });
  }

  it('imports the version synchronizer without parsing arguments or writing files', (t) => {
    const f = fixture(t);
    const url = new URL('../../../scripts/bump-version.mjs', import.meta.url).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      cwd: f.root,
      encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
  });
  it('updates the moved installer pin and archive references from any working directory', (t) => {
    const f = releaseFixture(t);
    const { releaseRoot: root, script, url } = f;
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
