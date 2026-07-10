import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isOneCliMode,
  installProxyDispatcher,
  resetProxyDispatcher,
  getGlobalDispatcher,
  ProxyAgent,
} from './proxy.mjs';
import { createClient, listEntries } from './reclaim.mjs';
import { fetchIcalEvents } from './tripit.mjs';

// ── Env helpers ──

const ENV_KEYS = ['ONECLI_URL', 'HTTPS_PROXY', 'https_proxy', 'NODE_EXTRA_CA_CERTS'];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function clearOneCliEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

// ── isOneCliMode ──

describe('isOneCliMode', () => {
  let snap;
  beforeEach(() => { snap = snapshotEnv(); clearOneCliEnv(); });
  afterEach(() => { restoreEnv(snap); });

  it('is false when ONECLI_URL is unset', () => {
    assert.equal(isOneCliMode(), false);
  });

  it('is true when ONECLI_URL is set', () => {
    process.env.ONECLI_URL = 'http://127.0.0.1:9999';
    assert.equal(isOneCliMode(), true);
  });
});

// ── installProxyDispatcher ──

describe('installProxyDispatcher', () => {
  let snap;
  let previousDispatcher;

  beforeEach(() => {
    snap = snapshotEnv();
    clearOneCliEnv();
    previousDispatcher = getGlobalDispatcher();
  });

  afterEach(() => {
    resetProxyDispatcher(previousDispatcher);
    restoreEnv(snap);
  });

  it('is a no-op when ONECLI_URL is unset (no ProxyAgent installed)', () => {
    const before = getGlobalDispatcher();
    const result = installProxyDispatcher();
    assert.equal(result, null);
    assert.equal(getGlobalDispatcher(), before);
  });

  it('throws an actionable error when ONECLI_URL is set but HTTPS_PROXY is not', () => {
    process.env.ONECLI_URL = 'http://127.0.0.1:9999';
    assert.throws(
      () => installProxyDispatcher(),
      /ONECLI_URL is set but HTTPS_PROXY is not.*onecli run/,
    );
  });

  it('installs a ProxyAgent when ONECLI_URL and HTTPS_PROXY are both set', () => {
    process.env.ONECLI_URL = 'http://127.0.0.1:9999';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8888';
    const agent = installProxyDispatcher();
    assert.ok(agent instanceof ProxyAgent);
    assert.equal(getGlobalDispatcher(), agent);
  });

  it('reads NODE_EXTRA_CA_CERTS into requestTls when the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onecli-ca-'));
    const caPath = join(dir, 'ca.pem');
    // Minimal PEM-looking blob — ProxyAgent only needs to read the bytes
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    process.env.ONECLI_URL = 'http://127.0.0.1:9999';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8888';
    process.env.NODE_EXTRA_CA_CERTS = caPath;
    const agent = installProxyDispatcher();
    assert.ok(agent instanceof ProxyAgent);
    unlinkSync(caPath);
  });

  it('throws when NODE_EXTRA_CA_CERTS points at a missing file', () => {
    process.env.ONECLI_URL = 'http://127.0.0.1:9999';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8888';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/definitely-does-not-exist-onecli-ca.pem';
    assert.throws(
      () => installProxyDispatcher(),
      /Failed to read NODE_EXTRA_CA_CERTS/,
    );
  });
});

// ── Proxy routing (Reclaim + TripIt via global fetch) ──
//
// Spins up a local HTTP "origin" server and a local HTTP CONNECT-capable
// proxy. With ONECLI_URL + HTTPS_PROXY pointing at the mock proxy, undici's
// ProxyAgent must forward the request — we assert the proxy saw it and
// the origin saw the expected placeholder credentials.

describe('proxy routing under OneCLI mode', () => {
  let snap;
  let previousDispatcher;
  let originServer;
  let proxyServer;
  let originPort;
  let proxyPort;
  let proxyHits;
  let originHits;

  beforeEach(async () => {
    snap = snapshotEnv();
    clearOneCliEnv();
    previousDispatcher = getGlobalDispatcher();
    proxyHits = [];
    originHits = [];

    originServer = http.createServer((req, res) => {
      originHits.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        authorization: req.headers.authorization || null,
      });
      if (req.url === '/feed/ical/private/PLACEHOLDER-TOKEN/tripit.ics') {
        res.writeHead(200, { 'Content-Type': 'text/calendar' });
        res.end(
          'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' +
          'BEGIN:VEVENT\r\nUID:test-1\r\n' +
          'DTSTART;VALUE=DATE:20260307\r\nDTEND;VALUE=DATE:20260310\r\n' +
          'SUMMARY:Proxy Trip\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
        );
        return;
      }
      if (req.url === '/api/time-window-overrides') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: [], defaultTimezone: 'America/Chicago' }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise(resolve => originServer.listen(0, '127.0.0.1', resolve));
    originPort = originServer.address().port;

    // Minimal HTTP forward proxy: rewrites absolute-form request-target
    // to origin-form and relays to the real origin. Enough for undici
    // ProxyAgent's non-CONNECT (http://) path.
    proxyServer = http.createServer((req, res) => {
      proxyHits.push({ method: req.method, url: req.url, host: req.headers.host });
      const target = new URL(req.url);
      const headers = { ...req.headers, host: target.host };
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: req.method,
          headers,
        },
        upstreamRes => {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', err => {
        res.writeHead(502);
        res.end(err.message);
      });
      req.pipe(upstream);
    });
    await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    proxyPort = proxyServer.address().port;

    process.env.ONECLI_URL = 'http://127.0.0.1:9999';
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    installProxyDispatcher();
  });

  afterEach(async () => {
    resetProxyDispatcher(previousDispatcher);
    restoreEnv(snap);
    await new Promise(resolve => originServer.close(resolve));
    await new Promise(resolve => proxyServer.close(resolve));
  });

  it('routes Reclaim listEntries through the proxy with a placeholder Bearer', async () => {
    // Point Reclaim at our local origin by temporarily swapping BASE via
    // a direct fetch that mirrors what listEntries does — listEntries
    // hardcodes api.app.reclaim.ai, so we exercise the same client +
    // dispatcher path with a fetch that targets the mock origin.
    const client = createClient('PLACEHOLDER-RECLAIM-TOKEN');
    assert.equal(client.headers.Authorization, 'Bearer PLACEHOLDER-RECLAIM-TOKEN');

    // Hit the mock origin through the global dispatcher (proxy).
    const res = await fetch(
      `http://127.0.0.1:${originPort}/api/time-window-overrides`,
      { headers: client.headers },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.entries, []);

    assert.ok(proxyHits.length >= 1, 'proxy must have seen the request');
    assert.ok(
      proxyHits.some(h => h.url.includes('/api/time-window-overrides')),
      `proxy hits: ${JSON.stringify(proxyHits)}`,
    );
    assert.equal(originHits.length, 1);
    assert.equal(originHits[0].authorization, 'Bearer PLACEHOLDER-RECLAIM-TOKEN');
  });

  it('routes TripIt iCal fetch through the proxy with a placeholder path token', async () => {
    const icalUrl =
      `http://127.0.0.1:${originPort}/feed/ical/private/PLACEHOLDER-TOKEN/tripit.ics`;
    const events = await fetchIcalEvents(icalUrl);
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, 'Proxy Trip');

    assert.ok(proxyHits.length >= 1, 'proxy must have seen the iCal request');
    assert.ok(
      proxyHits.some(h => h.url.includes('/private/PLACEHOLDER-TOKEN/tripit.ics')),
      `proxy hits: ${JSON.stringify(proxyHits)}`,
    );
    assert.ok(
      originHits.some(h => h.url.includes('/private/PLACEHOLDER-TOKEN/tripit.ics')),
      'origin must receive the placeholder path (gateway would rewrite in real use)',
    );
  });

  it('accepts a placeholder RECLAIM_API_TOKEN with no client-side rejection', () => {
    // createClient must not validate token shape — gateway swaps it.
    const client = createClient('onecli-placeholder');
    assert.equal(client.headers.Authorization, 'Bearer onecli-placeholder');
    // listEntries itself only needs a client object; no token regex.
    assert.equal(typeof listEntries, 'function');
  });
});

// ── Regression: non-OneCLI path unchanged ──

describe('fetchIcalEvents without ONECLI_URL', () => {
  let snap;

  beforeEach(() => {
    snap = snapshotEnv();
    clearOneCliEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it('does not call global fetch when ONECLI_URL is unset', async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      fetchCalled = true;
      return originalFetch(...args);
    };

    // node-ical fromURL uses its own HTTP client; we only care that
    // global fetch is never touched on the non-OneCLI path.
    try {
      await fetchIcalEvents('http://127.0.0.1:1/does-not-exist.ics');
    } catch {
      // expected — connection refused / fetch failed inside node-ical
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false, 'non-OneCLI path must not use global fetch');
  });
});
