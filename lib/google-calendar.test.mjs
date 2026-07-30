import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGCalClient,
  listOooEvents,
  createOooEvent,
  OOO_PREFIX,
  ONECLI_ACCESS_TOKEN,
  isOooOptedIn,
  oooSkipReason,
} from './google-calendar.mjs';

// ── Mock helpers ──

function mockGcal(items = []) {
  const calls = { list: [], insert: [], delete: [] };
  return {
    calls,
    events: {
      list: async (params) => {
        calls.list.push(params);
        return { data: { items } };
      },
      insert: async (params) => {
        calls.insert.push(params);
        return { data: { id: 'new-event-id' } };
      },
      delete: async (params) => {
        calls.delete.push(params);
      },
    },
  };
}

const ONECLI_ENV_KEYS = ['ONECLI_URL', 'ENABLE_OOO', 'HTTPS_PROXY', 'https_proxy'];

function snapshotOneCliEnv() {
  const snap = {};
  for (const k of ONECLI_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreOneCliEnv(snap) {
  for (const k of ONECLI_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// ── createGCalClient ──

describe('createGCalClient', () => {
  let snap;
  beforeEach(() => {
    snap = snapshotOneCliEnv();
    for (const k of ONECLI_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => { restoreOneCliEnv(snap); });

  it('returns null when any credential is missing', () => {
    assert.equal(createGCalClient({ clientId: 'c', clientSecret: 's' }), null);
    assert.equal(createGCalClient({ clientId: 'c', refreshToken: 'r' }), null);
    assert.equal(createGCalClient({ clientSecret: 's', refreshToken: 'r' }), null);
    assert.equal(createGCalClient({ clientId: '', clientSecret: '', refreshToken: '' }), null);
  });

  it('returns a calendar client when all credentials present', () => {
    const result = createGCalClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r' });
    assert.ok(result);
    assert.equal(typeof result.events, 'object');
  });
});

// ── OneCLI mode: static Bearer, no OAuth refresh ──

describe('createGCalClient in OneCLI mode', () => {
  let snap;
  beforeEach(() => {
    snap = snapshotOneCliEnv();
    for (const k of ONECLI_ENV_KEYS) delete process.env[k];
    process.env.ONECLI_URL = 'http://127.0.0.1:9999';
  });
  afterEach(() => { restoreOneCliEnv(snap); });

  it('returns null when OOO is not opted in (no ENABLE_OOO, no Google placeholders)', () => {
    assert.equal(createGCalClient({}), null);
    assert.equal(createGCalClient({ clientId: 'c' }), null);
  });

  it('returns null when ENABLE_OOO is explicitly disabled', () => {
    process.env.ENABLE_OOO = '0';
    assert.equal(
      createGCalClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
      null,
    );
  });

  it('returns a client with ENABLE_OOO=1 even without Google credentials', () => {
    process.env.ENABLE_OOO = '1';
    const result = createGCalClient({});
    assert.ok(result);
    assert.equal(typeof result.events, 'object');
  });

  it('returns a client when Google placeholder env vars are present (opt-in marker)', () => {
    const result = createGCalClient({
      clientId: 'placeholder-id',
      clientSecret: 'placeholder-secret',
      refreshToken: 'placeholder-refresh',
    });
    assert.ok(result);
  });

  it('uses a static access_token and no refresh_token', async () => {
    process.env.ENABLE_OOO = '1';
    const client = createGCalClient({});
    // Reach into the auth client googleapis attached
    const auth = client.context._options.auth;
    assert.ok(auth, 'calendar client must carry an auth object');
    assert.equal(auth.credentials.access_token, ONECLI_ACCESS_TOKEN);
    assert.equal(auth.credentials.refresh_token, undefined);
    assert.ok(auth.credentials.expiry_date > Date.now(), 'expiry must be in the future');

    // getAccessToken must return the static token without network I/O
    const { token } = await auth.getAccessToken();
    assert.equal(token, ONECLI_ACCESS_TOKEN);
  });

  it('never POSTs oauth2.googleapis.com/token when only the static token is set', async () => {
    process.env.ENABLE_OOO = '1';
    const client = createGCalClient({});
    const auth = client.context._options.auth;

    // Intercept any outbound HTTP to catch a refresh attempt
    let tokenEndpointHits = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const href = typeof url === 'string' ? url : url.toString();
      if (href.includes('oauth2.googleapis.com/token')) {
        tokenEndpointHits++;
      }
      throw new Error(`unexpected fetch in unit test: ${href}`);
    };

    try {
      // Force googleapis/google-auth to produce a request header. This is
      // the path that would trigger a refresh if refresh_token were set
      // and the access token were missing/expired. Modern google-auth
      // returns a Fetch API Headers object.
      const headers = await auth.getRequestHeaders('https://www.googleapis.com/');
      const authHeader = typeof headers.get === 'function'
        ? headers.get('authorization')
        : (headers.Authorization || headers.authorization);
      assert.equal(authHeader, `Bearer ${ONECLI_ACCESS_TOKEN}`);
      const { token } = await auth.getAccessToken();
      assert.equal(token, ONECLI_ACCESS_TOKEN);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(tokenEndpointHits, 0, 'oauth2 token endpoint must never be hit');
  });
});

describe('isOooOptedIn', () => {
  let snap;
  beforeEach(() => {
    snap = snapshotOneCliEnv();
    for (const k of ONECLI_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => { restoreOneCliEnv(snap); });

  it('outside OneCLI requires all three Google credentials', () => {
    assert.equal(isOooOptedIn({ clientId: 'c', clientSecret: 's' }), false);
    assert.equal(isOooOptedIn({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }), true);
  });

  it('in OneCLI honors ENABLE_OOO and placeholder presence', () => {
    process.env.ONECLI_URL = 'http://x';
    assert.equal(isOooOptedIn({}), false);
    process.env.ENABLE_OOO = 'true';
    assert.equal(isOooOptedIn({}), true);
    delete process.env.ENABLE_OOO;
    assert.equal(
      isOooOptedIn({ clientId: 'p', clientSecret: 'p', refreshToken: 'p' }),
      true,
    );
  });

  it('ENABLE_OOO is case-insensitive', () => {
    process.env.ONECLI_URL = 'http://x';
    process.env.ENABLE_OOO = 'TRUE';
    assert.equal(isOooOptedIn({}), true);
    process.env.ENABLE_OOO = 'False';
    assert.equal(isOooOptedIn({ clientId: 'p', clientSecret: 'p', refreshToken: 'p' }), false);
  });
});

describe('oooSkipReason', () => {
  let snap;
  beforeEach(() => {
    snap = snapshotOneCliEnv();
    for (const k of ONECLI_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => { restoreOneCliEnv(snap); });

  it('outside OneCLI mentions missing credentials', () => {
    assert.match(oooSkipReason({}), /Google Calendar credentials not configured/);
  });

  it('in OneCLI points at ENABLE_OOO / placeholders, not missing OAuth secrets', () => {
    process.env.ONECLI_URL = 'http://x';
    assert.match(oooSkipReason({}), /ENABLE_OOO=1/);
    assert.doesNotMatch(oooSkipReason({}), /credentials not configured/);
    process.env.ENABLE_OOO = '0';
    assert.match(oooSkipReason({}), /ENABLE_OOO=0/);
  });

  it('reports disabled for ENABLE_OOO=FALSE (case-insensitive)', () => {
    process.env.ONECLI_URL = 'http://x';
    process.env.ENABLE_OOO = 'FALSE';
    assert.match(oooSkipReason({}), /ENABLE_OOO=0/);
  });
});

// ── createOooEvent ──
// These tests would have caught: "OOO event must not be all-day" and "must not have description"

describe('createOooEvent', () => {
  it('uses dateTime not date (GCal API rejects all-day OOO events)', async () => {
    const gcal = mockGcal();
    await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Trip',
      startDate: '2026-03-07',
      endDate: '2026-03-17',
    });

    const body = gcal.calls.insert[0].requestBody;
    assert.ok(body.start.dateTime, 'start must use dateTime');
    assert.ok(body.end.dateTime, 'end must use dateTime');
    assert.equal(body.start.date, undefined, 'start must NOT use date');
    assert.equal(body.end.date, undefined, 'end must NOT use date');
  });

  it('does not include description (GCal API rejects description on OOO events)', async () => {
    const gcal = mockGcal();
    await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Trip',
      startDate: '2026-03-07',
      endDate: '2026-03-17',
    });

    const body = gcal.calls.insert[0].requestBody;
    assert.equal(body.description, undefined, 'description must not be set on OOO events');
  });

  it('sets eventType to outOfOffice with declineNone', async () => {
    const gcal = mockGcal();
    await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Trip',
      startDate: '2026-03-07',
      endDate: '2026-03-17',
    });

    const body = gcal.calls.insert[0].requestBody;
    assert.equal(body.eventType, 'outOfOffice');
    assert.equal(body.outOfOfficeProperties.autoDeclineMode, 'declineNone');
  });

  it('prefixes summary with OOO_PREFIX', async () => {
    const gcal = mockGcal();
    await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Spring Break',
      startDate: '2026-03-07',
      endDate: '2026-03-17',
    });

    const body = gcal.calls.insert[0].requestBody;
    assert.equal(body.summary, '[TripIt OOO] Spring Break');
  });

  it('falls back to midnight UTC dateTime when no home tz is given', async () => {
    const gcal = mockGcal();
    await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Trip',
      startDate: '2026-05-04',
      endDate: '2026-05-09',
    });

    const body = gcal.calls.insert[0].requestBody;
    assert.equal(body.start.dateTime, '2026-05-04T00:00:00Z');
    assert.equal(body.end.dateTime, '2026-05-09T00:00:00Z');
  });

  it('anchors at home-local midnight when a timeZone is given', async () => {
    // A UTC-midnight block renders as the evening before in a behind-UTC home
    // zone (00:00Z → 19:00 the prior day in Chicago). A zone-naive T00:00:00 plus
    // timeZone makes Google place it at local midnight.
    const gcal = mockGcal();
    await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Trip',
      startDate: '2026-08-14',
      endDate: '2026-08-16',
      timeZone: 'America/Chicago',
    });

    const body = gcal.calls.insert[0].requestBody;
    assert.equal(body.start.dateTime, '2026-08-14T00:00:00');
    assert.equal(body.start.timeZone, 'America/Chicago');
    assert.equal(body.end.dateTime, '2026-08-16T00:00:00');
    assert.equal(body.end.timeZone, 'America/Chicago');
    assert.ok(!body.start.dateTime.endsWith('Z'), 'must not pin UTC when a home tz is set');
  });

  it('falls back to UTC midnight when the home tz is invalid (no throw)', async () => {
    // resolveHomeTimezone only trims, so a typo'd HOME_TZ can reach here; an
    // invalid zone must not abort the sync.
    const gcal = mockGcal();
    await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Trip',
      startDate: '2026-08-14',
      endDate: '2026-08-16',
      timeZone: 'Not/AZone',
    });

    const body = gcal.calls.insert[0].requestBody;
    assert.equal(body.start.dateTime, '2026-08-14T00:00:00Z');
    assert.equal(body.start.timeZone, undefined);
    assert.equal(body.end.dateTime, '2026-08-16T00:00:00Z');
  });

  it('returns the created event ID', async () => {
    const gcal = mockGcal();
    const id = await createOooEvent(gcal, 'cal@test.com', {
      summary: 'Trip',
      startDate: '2026-03-07',
      endDate: '2026-03-17',
    });
    assert.equal(id, 'new-event-id');
  });
});

// ── listOooEvents ──
// These tests would have caught: q search missing OOO events, and timezone date parsing

describe('listOooEvents', () => {
  it('uses eventTypes filter, not q search (q misses OOO events)', async () => {
    const gcal = mockGcal([]);
    await listOooEvents(gcal, 'cal@test.com');

    const params = gcal.calls.list[0];
    assert.deepEqual(params.eventTypes, ['outOfOffice'], 'must filter by eventTypes');
    assert.equal(params.q, undefined, 'must NOT use q search — it misses OOO events');
  });

  it('normalizes local-timezone dateTime to correct UTC date', async () => {
    // Google returns UTC midnight as local time: 2026-03-06T18:00:00-06:00 (CST)
    // Naive .slice(0,10) gives 2026-03-06 (wrong). Must parse to get 2026-03-07.
    const gcal = mockGcal([{
      id: 'ev1',
      summary: '[TripIt OOO] Spring Break',
      start: { dateTime: '2026-03-06T18:00:00-06:00' },
      end: { dateTime: '2026-03-16T18:00:00-06:00' },
    }]);

    const events = await listOooEvents(gcal, 'cal@test.com');
    assert.equal(events.length, 1);
    assert.equal(events[0].startDate, '2026-03-07', 'must parse dateTime, not just slice');
    assert.equal(events[0].endDate, '2026-03-17');
  });

  it('handles positive UTC offsets the same way', async () => {
    // IST (UTC+5:30): 2026-03-07T05:30:00+05:30 → UTC 2026-03-07T00:00:00Z → 2026-03-07
    const gcal = mockGcal([{
      id: 'ev1',
      summary: '[TripIt OOO] India Trip',
      start: { dateTime: '2026-03-07T05:30:00+05:30' },
      end: { dateTime: '2026-03-10T05:30:00+05:30' },
    }]);

    const events = await listOooEvents(gcal, 'cal@test.com');
    assert.equal(events[0].startDate, '2026-03-07');
    assert.equal(events[0].endDate, '2026-03-10');
  });

  it('handles UTC dateTime directly', async () => {
    const gcal = mockGcal([{
      id: 'ev1',
      summary: '[TripIt OOO] Trip',
      start: { dateTime: '2026-05-04T00:00:00Z' },
      end: { dateTime: '2026-05-09T00:00:00Z' },
    }]);

    const events = await listOooEvents(gcal, 'cal@test.com');
    assert.equal(events[0].startDate, '2026-05-04');
    assert.equal(events[0].endDate, '2026-05-09');
  });

  it('resolves a legacy UTC-midnight block to its prior-day home date (forces migration)', async () => {
    // A UTC-midnight block Google returns rendered in Chicago as 19:00 the
    // evening before. Resolved in the home tz its date is that prior day, so it
    // no longer matches the trip's date and reconciliation migrates it.
    const gcal = mockGcal([{
      id: 'ev1',
      summary: '[TripIt OOO] Israel',
      start: { dateTime: '2026-07-31T19:00:00-05:00' },
      end: { dateTime: '2026-08-07T19:00:00-05:00' },
    }]);

    const events = await listOooEvents(gcal, 'cal@test.com', 'America/Chicago');
    assert.equal(events[0].startDate, '2026-07-31');
    assert.equal(events[0].endDate, '2026-08-07');
  });

  it('resolves a home-midnight block to its own date (stable, no churn)', async () => {
    const gcal = mockGcal([{
      id: 'ev1',
      summary: '[TripIt OOO] Israel',
      start: { dateTime: '2026-08-01T00:00:00-05:00' },
      end: { dateTime: '2026-08-08T00:00:00-05:00' },
    }]);

    const events = await listOooEvents(gcal, 'cal@test.com', 'America/Chicago');
    assert.equal(events[0].startDate, '2026-08-01');
    assert.equal(events[0].endDate, '2026-08-08');
  });

  it('filters out non-TripIt OOO events', async () => {
    const gcal = mockGcal([
      { id: 'ev1', summary: 'Out of office', start: { dateTime: '2026-03-16T00:00:00Z' }, end: { dateTime: '2026-03-20T00:00:00Z' } },
      { id: 'ev2', summary: '[TripIt OOO] Real Trip', start: { dateTime: '2026-04-01T00:00:00Z' }, end: { dateTime: '2026-04-05T00:00:00Z' } },
    ]);

    const events = await listOooEvents(gcal, 'cal@test.com');
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, '[TripIt OOO] Real Trip');
  });

  it('skips events with missing start or end', async () => {
    const gcal = mockGcal([
      { id: 'ev1', summary: '[TripIt OOO] Bad', start: { dateTime: '2026-03-07T00:00:00Z' }, end: {} },
      { id: 'ev2', summary: '[TripIt OOO] Also Bad', start: {}, end: { dateTime: '2026-03-10T00:00:00Z' } },
    ]);

    const events = await listOooEvents(gcal, 'cal@test.com');
    assert.equal(events.length, 0);
  });

  it('follows pagination', async () => {
    let page = 0;
    const gcal = {
      events: {
        list: async (params) => {
          if (page === 0) {
            page++;
            return {
              data: {
                items: [{ id: 'ev1', summary: '[TripIt OOO] A', start: { dateTime: '2026-03-07T00:00:00Z' }, end: { dateTime: '2026-03-10T00:00:00Z' } }],
                nextPageToken: 'page2',
              },
            };
          }
          return {
            data: {
              items: [{ id: 'ev2', summary: '[TripIt OOO] B', start: { dateTime: '2026-04-01T00:00:00Z' }, end: { dateTime: '2026-04-05T00:00:00Z' } }],
            },
          };
        },
      },
    };

    const events = await listOooEvents(gcal, 'cal@test.com');
    assert.equal(events.length, 2);
  });
});
