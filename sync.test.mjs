import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { main } from './sync.mjs';
import ical from 'node-ical';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const output = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request in orchestration test');
  });
  const failWrite = () =>
    t.mock.fn(async () => {
      throw new Error('Unexpected provider write');
    });
  const dependencies = {
    installProxyDispatcher: t.mock.fn(() => null),
    fetchIcalEvents: t.mock.fn(async () => []),
    listEntries: t.mock.fn(async () => ({ entries: [], defaultTimezone: 'America/Chicago' })),
    clearAllEntries: failWrite(),
    createEntry: failWrite(),
    getPrimaryCalendar: failWrite(),
    listReclaimEvents: failWrite(),
    setEventPriority: failWrite(),
    listOooEvents: failWrite(),
    createOooEvent: failWrite(),
    deleteOooEvent: failWrite(),
    sendNotification: failWrite()
  };
  return { output, errors, dependencies, read: () => JSON.parse(output.join('\n')) };
}

describe('CLI orchestration outcomes', () => {
  /** @param {import('node:test').TestContext} t */
  function setup(t) {
    const keys = [
      'TRIPIT_ICAL_URL',
      'RECLAIM_API_TOKEN',
      'HOME_TZ',
      'TRIPIT_IGNORE_TRIPS',
      'TRIPIT_IGNORE_KEYWORDS',
      'ONECLI_URL',
      'ENABLE_OOO',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN'
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.TRIPIT_ICAL_URL = 'https://tripit.example.invalid/fixture.ics';
    process.env.RECLAIM_API_TOKEN = 'fixture-only';
    t.after(() => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-01-01T00:00:00Z') });
  }
  beforeEach(setup);

  it('imports without parsing arguments, producing output or exiting', () => {
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./sync.mjs')"], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, TRIPIT_ICAL_URL: '', RECLAIM_API_TOKEN: '' },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    assert.equal(imported.stderr, '');
  });

  for (const args of [['unknown'], ['--output=xml']]) {
    it(`returns an actionable usage error for ${args.join(' ')}`, async (t) => {
      const f = fixture(t);
      assert.equal(await main(args, f.dependencies), 1);
      assert.equal(f.output.length, 0);
      assert.match(f.errors.join('\n'), /Usage:|Supported:/);
      assert.equal(f.dependencies.fetchIcalEvents.mock.callCount(), 0);
    });
  }

  for (const missing of ['TRIPIT_ICAL_URL', 'RECLAIM_API_TOKEN']) {
    it(`returns JSON errors for missing ${missing} and restores logging`, async (t) => {
      const f = fixture(t);
      const log = console.log;
      delete process.env[missing];
      assert.equal(await main(['sync', '--output=json'], f.dependencies), 1);
      assert.deepEqual(f.read().errors, [`Missing ${missing} environment variable`]);
      assert.match(f.errors.join('\n'), new RegExp(missing));
      assert.equal(console.log, log);
      assert.equal(f.dependencies.fetchIcalEvents.mock.callCount(), 0);
    });
  }

  it('reports a no-change sync without writes or notifications', async (t) => {
    const f = fixture(t);
    const args = ['sync', '--output=json'];
    assert.equal(await main(args, f.dependencies), 0);
    assert.deepEqual(args, ['sync', '--output=json']);
    assert.deepEqual(f.read(), {
      mode: 'sync',
      noChanges: true,
      homeTimezone: 'America/Chicago',
      timezoneChanges: [],
      segments: [],
      ooo: null,
      conflicts: [],
      errors: []
    });
    assert.equal(f.dependencies.clearAllEntries.mock.callCount(), 0);
    assert.equal(f.dependencies.sendNotification.mock.callCount(), 0);
    assert.deepEqual(f.errors, []);
  });

  it('flushes JSON and returns failure when executed with missing configuration', () => {
    const executed = spawnSync(process.execPath, ['sync.mjs', 'sync', '--output=json'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, TRIPIT_ICAL_URL: '', RECLAIM_API_TOKEN: '' },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(executed.status, 1);
    assert.deepEqual(JSON.parse(executed.stdout).errors, ['Missing TRIPIT_ICAL_URL environment variable']);
    assert.match(executed.stderr, /Missing TRIPIT_ICAL_URL/);
  });

  it('executes through a symlink instead of silently exiting successfully', (t) => {
    const temporary = mkdtempSync(join(tmpdir(), 'sync-entrypoint-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const entry = join(temporary, 'sync.mjs');
    symlinkSync(fileURLToPath(new URL('./sync.mjs', import.meta.url)), entry);
    const executed = spawnSync(process.execPath, [entry, 'sync', '--output=json'], {
      env: { ...process.env, TRIPIT_ICAL_URL: '', RECLAIM_API_TOKEN: '' },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(executed.status, 1);
    assert.deepEqual(JSON.parse(executed.stdout).errors, ['Missing TRIPIT_ICAL_URL environment variable']);
    assert.match(executed.stderr, /Missing TRIPIT_ICAL_URL/);
  });

  it('writes the desired timezone segments and reports their actual dates', async (t) => {
    const f = fixture(t);
    const events = Object.values(
      ical.sync.parseICS(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:fixture-paris',
          'DTSTAMP:20240101T000000Z',
          'SUMMARY:Paris trip',
          'LOCATION:Paris',
          'GEO:48.8566;2.3522',
          'DTSTART;VALUE=DATE:20240110',
          'DTEND;VALUE=DATE:20240112',
          'END:VEVENT',
          'END:VCALENDAR'
        ].join('\r\n')
      )
    ).filter((event) => event.type === 'VEVENT');
    /** @type {typeof import('./lib/reclaim.mjs').createEntry} */
    const creationOutcome = async () => ({});
    const create = t.mock.fn(creationOutcome);
    const clear = t.mock.fn(async () => {});
    const notify = t.mock.fn(async () => {});
    assert.equal(
      await main(['sync', '--output=json'], {
        ...f.dependencies,
        fetchIcalEvents: async () => events,
        clearAllEntries: clear,
        createEntry: create,
        sendNotification: notify
      }),
      0
    );
    assert.equal(f.read().noChanges, false);
    assert.deepEqual(f.read().timezoneChanges, [
      { action: 'create', timezone: 'Europe/Paris', from: '2024-01-10', to: '2024-01-12' }
    ]);
    assert.deepEqual(create.mock.calls[0].arguments[1], {
      startDate: '2024-01-10',
      endDate: '2024-01-12',
      timezone: 'Europe/Paris'
    });
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(notify.mock.callCount(), 1);
  });

  it('clears stale overrides and notifies once with the actual changes', async (t) => {
    const f = fixture(t);
    const previous = [{ id: 7, startDate: '2024-01-10', endDate: '2024-01-12', timezone: 'Europe/Paris' }];
    /** @type {typeof import('./lib/reclaim.mjs').clearAllEntries} */
    const clearOutcome = async () => {};
    const clear = t.mock.fn(clearOutcome);
    /** @type {typeof import('./lib/notify.mjs').sendNotification} */
    const notificationOutcome = async () => {};
    const notify = t.mock.fn(notificationOutcome);
    assert.equal(
      await main(['sync', '--output=json'], {
        ...f.dependencies,
        listEntries: async () => ({ entries: previous, defaultTimezone: 'America/Chicago' }),
        clearAllEntries: clear,
        sendNotification: notify
      }),
      0
    );
    const result = f.read();
    assert.equal(result.noChanges, false);
    assert.deepEqual(result.timezoneChanges, [
      { action: 'delete', timezone: 'Europe/Paris', from: '2024-01-10', to: '2024-01-12' }
    ]);
    assert.equal(clear.mock.callCount(), 1);
    assert.deepEqual(clear.mock.calls[0].arguments[1], previous);
    assert.equal(notify.mock.callCount(), 1);
    assert.deepEqual(notify.mock.calls[0].arguments.slice(0, 2), [previous, []]);
    assert.equal(f.dependencies.createEntry.mock.callCount(), 0);
  });

  it('defaults to dry-run and never writes even when overrides differ', async (t) => {
    const f = fixture(t);
    assert.equal(
      await main(['--output=json'], {
        ...f.dependencies,
        listEntries: async () => ({
          entries: [{ startDate: '2024-01-10', endDate: '2024-01-12', timezone: 'Europe/Paris' }],
          defaultTimezone: 'America/Chicago'
        })
      }),
      0
    );
    assert.equal(f.read().mode, 'dry-run');
    assert.equal(f.dependencies.clearAllEntries.mock.callCount(), 0);
    assert.equal(f.dependencies.sendNotification.mock.callCount(), 0);
  });

  for (const failed of ['fetchIcalEvents', 'listEntries']) {
    it(`returns a JSON failure when ${failed} rejects and restores logging`, async (t) => {
      const f = fixture(t);
      const log = console.log;
      assert.equal(
        await main(['sync', '--output=json'], {
          ...f.dependencies,
          [failed]: async () => {
            throw new Error('Fixture provider unavailable');
          }
        }),
        1
      );
      assert.deepEqual(f.read().errors, ['Fixture provider unavailable']);
      assert.match(f.errors.join('\n'), /FATAL ERROR: Fixture provider unavailable/);
      assert.equal(console.log, log);
      assert.equal(f.dependencies.clearAllEntries.mock.callCount(), 0);
    });
  }

  it('syncs OOO changes, sets priority and sends the completed outcome', async (t) => {
    const f = fixture(t);
    process.env.GOOGLE_CLIENT_ID = 'fixture-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'fixture-refresh';
    const events = Object.values(
      ical.sync.parseICS(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:fixture-conference',
          'DTSTAMP:20240101T000000Z',
          'SUMMARY:Conference',
          'DTSTART;VALUE=DATE:20240110',
          'DTEND;VALUE=DATE:20240112',
          'END:VEVENT',
          'END:VCALENDAR'
        ].join('\r\n')
      )
    ).filter((event) => event.type === 'VEVENT');
    /** @type {typeof import('./lib/google-calendar.mjs').createOooEvent} */
    const creationOutcome = async () => 'new-event';
    /** @type {typeof import('./lib/google-calendar.mjs').deleteOooEvent} */
    const deletionOutcome = async () => {};
    const create = t.mock.fn(creationOutcome);
    const remove = t.mock.fn(deletionOutcome);
    const priority = t.mock.fn(async () => {});
    /** @type {typeof import('./lib/notify.mjs').sendNotification} */
    const notificationOutcome = async () => {};
    const notify = t.mock.fn(notificationOutcome);
    assert.equal(
      await main(['sync', '--output=json'], {
        ...f.dependencies,
        fetchIcalEvents: async () => events,
        getPrimaryCalendar: async () => ({ calendarId: 1, googleCalendarId: 'fixture@example.invalid' }),
        listOooEvents: async () => [
          { id: 'old-event', summary: '[TripIt OOO] Old trip', startDate: '2024-01-02', endDate: '2024-01-03' }
        ],
        createOooEvent: create,
        deleteOooEvent: remove,
        listReclaimEvents: async () => [{ eventId: 8, title: '[TripIt OOO] Conference', priority: 'P3' }],
        setEventPriority: priority,
        sendNotification: notify
      }),
      0
    );
    const result = f.read();
    assert.deepEqual(result.ooo, { created: 1, deleted: 1, setToP2: 1 });
    assert.equal(result.noChanges, false);
    assert.deepEqual(create.mock.calls[0].arguments[2], {
      summary: 'Conference',
      startDate: '2024-01-10',
      endDate: '2024-01-12',
      timeZone: 'America/Chicago'
    });
    assert.equal(remove.mock.calls[0].arguments[2], 'old-event');
    assert.deepEqual(priority.mock.calls[0].arguments.slice(1), [1, 8, 'P2']);
    assert.deepEqual(notify.mock.calls[0].arguments[3], {
      created: 1,
      deleted: 1,
      prioritySet: 1,
      createdNames: ['Conference'],
      deletedNames: ['Old trip']
    });
  });
});
