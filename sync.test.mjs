import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { main } from './sync.mjs';
import { ReclaimApiError } from './lib/reclaim.mjs';
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

/** @param {Array<{summary: string, start: string, end: string, geo?: string}>} rows */
function tripFeed(rows) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  for (const [index, trip] of rows.entries()) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:fixture-trip-${index}`,
      'DTSTAMP:20240101T000000Z',
      `SUMMARY:${trip.summary}`,
      `DTSTART;VALUE=DATE:${trip.start.replaceAll('-', '')}`,
      `DTEND;VALUE=DATE:${trip.end.replaceAll('-', '')}`
    );
    if (trip.geo) lines.push(`GEO:${trip.geo}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return Object.values(ical.sync.parseICS(lines.join('\r\n'))).filter((event) => event.type === 'VEVENT');
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

  /** @type {Array<[string, string, boolean]>} */
  const reclaimMidnightCases = [
    ['America/Chicago', '2024-06-10T04:59:00Z', true],
    ['America/Chicago', '2024-06-10T05:00:00Z', false],
    ['Europe/Brussels', '2024-06-09T21:59:00Z', true],
    ['Europe/Brussels', '2024-06-09T22:00:00Z', false],
    ['invalid-zone', '2024-06-10T00:00:00Z', false]
  ];
  for (const [zone, now, active] of reclaimMidnightCases) {
    it(`notifies only active segments at the home-date boundary ${now} (${zone})`, async (t) => {
      const f = fixture(t);
      t.mock.timers.setTime(new Date(now).getTime());
      let notified = false;
      const expected = active ? ['Europe/Paris', 'Asia/Tokyo'] : ['Asia/Tokyo'];
      const written = [];
      assert.equal(
        await main(['sync', '--output=json'], {
          ...f.dependencies,
          fetchIcalEvents: async () =>
            tripFeed([
              { summary: 'Paris', start: '2024-06-08', end: '2024-06-10', geo: '48.8566;2.3522' },
              { summary: 'Tokyo', start: '2024-06-12', end: '2024-06-14', geo: '35.6762;139.6503' }
            ]),
          listEntries: async () => ({ entries: [], defaultTimezone: zone }),
          clearAllEntries: async () => {},
          createEntry: async (_client, entry) => {
            written.push(entry);
            return { id: 1 };
          },
          sendNotification: async (_previous, newSegments, rawSegments) => {
            notified = true;
            assert.deepEqual(
              rawSegments.map((segment) => segment.timezone),
              expected
            );
            assert.deepEqual(
              newSegments.map((segment) => segment.timezone),
              expected
            );
          }
        }),
        0,
        JSON.stringify(f.read().errors)
      );
      assert.equal(notified, true);
      assert.equal(written.length, expected.length);
      assert.equal(f.read().noChanges, false);
    });
    it(`reconciles Reclaim using home-local midnight at ${now} (${zone})`, async (t) => {
      const f = fixture(t);
      t.mock.timers.setTime(new Date(now).getTime());
      const events = tripFeed([{ summary: 'Paris', start: '2024-06-08', end: '2024-06-10', geo: '48.8566;2.3522' }]);
      assert.equal(
        await main(['sync', '--output=json'], {
          ...f.dependencies,
          fetchIcalEvents: async () => events,
          listEntries: async () => ({
            entries: active
              ? [{ id: 1, startDate: '2024-06-08', endDate: '2024-06-10', timezone: 'Europe/Paris' }]
              : [],
            defaultTimezone: zone
          })
        }),
        0
      );
      assert.equal(f.read().noChanges, true);
      assert.deepEqual(f.read().timezoneChanges, []);
      assert.equal(f.read().segments.length, 1);
      assert.equal(f.dependencies.clearAllEntries.mock.callCount(), 0);
      assert.equal(f.dependencies.createEntry.mock.callCount(), 0);
    });
  }

  it('keeps an ending segment in JSON without rewriting the matching active Reclaim entries', async (t) => {
    const f = fixture(t);
    t.mock.timers.setTime(new Date('2024-06-10T12:00:00Z').getTime());
    const events = tripFeed([
      { summary: 'Paris', start: '2024-06-09', end: '2024-06-10', geo: '48.8566;2.3522' },
      { summary: 'New York', start: '2024-06-10', end: '2024-06-12', geo: '40.7128;-74.0060' }
    ]);
    assert.equal(
      await main(['sync', '--output=json'], {
        ...f.dependencies,
        fetchIcalEvents: async () => events,
        listEntries: async () => ({
          entries: [{ id: 1, startDate: '2024-06-10', endDate: '2024-06-12', timezone: 'America/New_York' }],
          defaultTimezone: 'America/Chicago'
        })
      }),
      0
    );
    assert.equal(f.read().noChanges, true);
    assert.deepEqual(f.read().timezoneChanges, []);
    assert.deepEqual(
      f.read().segments.map(({ from, to, timezone }) => ({ from, to, timezone })),
      [
        { from: '2024-06-09', to: '2024-06-10', timezone: 'Europe/Paris' },
        { from: '2024-06-10', to: '2024-06-12', timezone: 'America/New_York' }
      ]
    );
    assert.equal(f.dependencies.clearAllEntries.mock.callCount(), 0);
    assert.equal(f.dependencies.createEntry.mock.callCount(), 0);
  });

  for (const failSecond of [false, true]) {
    it(`settles adjacent Reclaim creates in order and reports acknowledged writes (failure=${failSecond})`, async (t) => {
      const f = fixture(t);
      const events = tripFeed([
        { summary: 'Paris', start: '2024-06-10', end: '2024-06-12', geo: '48.8566;2.3522' },
        { summary: 'New York', start: '2024-06-12', end: '2024-06-14', geo: '40.7128;-74.0060' }
      ]);
      const completed = [];
      let inFlight = false;
      const status = await main(['sync', '--output=json'], {
        ...f.dependencies,
        fetchIcalEvents: async () => events,
        clearAllEntries: async () => {},
        createEntry: async (client, entry) => {
          assert.ok(client.headers);
          assert.equal(inFlight, false, 'provider rejects a create while its neighbor is unsettled');
          inFlight = true;
          await new Promise((resolve) => setImmediate(resolve));
          if (failSecond && completed.length === 1) throw new Error('Fixture second create refused');
          completed.push(entry);
          inFlight = false;
          return { id: completed.length };
        },
        sendNotification: async () => {}
      });
      assert.equal(status, failSecond ? 1 : 0);
      assert.deepEqual(completed, [
        { startDate: '2024-06-10', endDate: '2024-06-12', timezone: 'Europe/Paris' },
        ...(!failSecond ? [{ startDate: '2024-06-12', endDate: '2024-06-14', timezone: 'America/New_York' }] : [])
      ]);
      assert.equal(f.read().timezoneChanges.length, completed.length);
      assert.equal(f.read().noChanges, false);
      assert.deepEqual(f.read().errors, failSecond ? ['Fixture second create refused'] : []);
    });
  }

  /** @type {Array<[string, string, boolean]>} */
  const midnightCases = [
    ['America/Chicago', '2024-06-10T04:59:00Z', true],
    ['America/Chicago', '2024-06-10T05:00:00Z', false],
    ['Europe/Brussels', '2024-06-09T22:00:00Z', false]
  ];
  for (const [zone, now, stillActive] of midnightCases) {
    it(`does not recreate an expired OOO at ${now} (${zone})`, async (t) => {
      const f = fixture(t);
      t.mock.timers.setTime(new Date(now).getTime());
      process.env.GOOGLE_CLIENT_ID = 'fixture-client';
      process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
      process.env.GOOGLE_REFRESH_TOKEN = 'fixture-refresh';
      const events = tripFeed([{ summary: 'One night', start: '2024-06-09', end: '2024-06-10' }]);
      assert.equal(
        await main(['sync', '--output=json'], {
          ...f.dependencies,
          fetchIcalEvents: async () => events,
          listEntries: async () => ({ entries: [], defaultTimezone: zone }),
          getPrimaryCalendar: async () => ({ calendarId: 1, googleCalendarId: 'fixture@example.invalid' }),
          listOooEvents: async () =>
            stillActive
              ? [{ id: 'existing', summary: '[TripIt OOO] One night', startDate: '2024-06-09', endDate: '2024-06-10' }]
              : [],
          listReclaimEvents: async () => [{ eventId: 8, title: '[TripIt OOO] One night', priority: 'P2' }]
        }),
        0
      );
      assert.equal(f.read().noChanges, true);
      assert.deepEqual(f.read().ooo, {
        created: 0,
        deleted: 0,
        setToP2: 0,
        prioritySet: 0,
        createdNames: [],
        deletedNames: []
      });
      assert.equal(f.dependencies.createOooEvent.mock.callCount(), 0);
      assert.equal(f.dependencies.deleteOooEvent.mock.callCount(), 0);
    });
  }

  it('reports priority-only OOO changes as a real change with both counter names', async (t) => {
    const f = fixture(t);
    process.env.GOOGLE_CLIENT_ID = 'fixture-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'fixture-refresh';
    const setPriority = t.mock.fn(async () => {});
    const notify = t.mock.fn(async () => {});
    assert.equal(
      await main(['sync', '--output=json'], {
        ...f.dependencies,
        fetchIcalEvents: async () => tripFeed([{ summary: 'Conference', start: '2024-06-10', end: '2024-06-12' }]),
        getPrimaryCalendar: async () => ({ calendarId: 1, googleCalendarId: 'fixture@example.invalid' }),
        listOooEvents: async () => [
          { id: 'existing', summary: '[TripIt OOO] Conference', startDate: '2024-06-10', endDate: '2024-06-12' }
        ],
        listReclaimEvents: async () => [{ eventId: 8, title: '[TripIt OOO] Conference', priority: 'P3' }],
        setEventPriority: setPriority,
        sendNotification: notify
      }),
      0
    );
    assert.equal(f.read().noChanges, false);
    assert.deepEqual(f.read().ooo, {
      created: 0,
      deleted: 0,
      setToP2: 1,
      prioritySet: 1,
      createdNames: [],
      deletedNames: []
    });
    assert.equal(setPriority.mock.callCount(), 1);
    assert.equal(notify.mock.callCount(), 1);
  });

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

  for (const failed of ['listReclaimEvents', 'setEventPriority']) {
    for (const expected of [false, true]) {
      it(`propagates programming faults and warns only for known provider failures: ${failed}/${expected}`, async (t) => {
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
        const error = expected
          ? new ReclaimApiError('Fixture provider unavailable; retry.')
          : new TypeError('Fixture programming fault');
        const status = await main(['sync', '--output=json'], {
          ...f.dependencies,
          fetchIcalEvents: async () => events,
          getPrimaryCalendar: async () => ({ calendarId: 1, googleCalendarId: 'fixture@example.invalid' }),
          listOooEvents: async () => [
            { id: 'existing-event', summary: '[TripIt OOO] Conference', startDate: '2024-01-10', endDate: '2024-01-12' }
          ],
          listReclaimEvents: async () => [
            { eventId: 'existing-event', title: '[TripIt OOO] Conference', priority: 'P3' }
          ],
          setEventPriority: async () => {},
          [failed]: async () => {
            throw error;
          }
        });
        assert.equal(status, expected ? 0 : 1);
        assert.deepEqual(f.read().errors, expected ? [] : ['Fixture programming fault']);
        assert.equal(f.dependencies.createOooEvent.mock.callCount(), 0);
        assert.equal(f.dependencies.deleteOooEvent.mock.callCount(), 0);
      });
    }
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
    assert.deepEqual(result.ooo, {
      created: 1,
      deleted: 1,
      setToP2: 1,
      prioritySet: 1,
      createdNames: ['Conference'],
      deletedNames: ['Old trip']
    });
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
