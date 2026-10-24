import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listReclaimEvents, setEventPriority, ReclaimApiError } from './reclaim.mjs';

// ── listReclaimEvents ──
// This test would have caught: Reclaim API rejects ISO datetime, wants YYYY-MM-DD

describe('listReclaimEvents', () => {
  it('sends date-only params even when given ISO datetime input', async () => {
    let capturedUrl;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return Response.json([]);
    };

    try {
      const client = { headers: { Authorization: 'Bearer test' } };
      await listReclaimEvents(client, 770606, '2026-03-07T00:00:00Z', '2026-08-03T23:59:59Z');

      const params = new URL(capturedUrl).searchParams;
      assert.equal(params.get('start'), '2026-03-07', 'start must be date-only YYYY-MM-DD');
      assert.equal(params.get('end'), '2026-08-03', 'end must be date-only YYYY-MM-DD');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes date-only strings through unchanged', async () => {
    let capturedUrl;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return Response.json([]);
    };

    try {
      const client = { headers: { Authorization: 'Bearer test' } };
      await listReclaimEvents(client, 770606, '2026-03-07', '2026-08-03');

      const params = new URL(capturedUrl).searchParams;
      assert.equal(params.get('start'), '2026-03-07');
      assert.equal(params.get('end'), '2026-08-03');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes calendarIds in query params', async () => {
    let capturedUrl;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return Response.json([]);
    };

    try {
      const client = { headers: { Authorization: 'Bearer test' } };
      await listReclaimEvents(client, 770606, '2026-03-07', '2026-08-03');

      const params = new URL(capturedUrl).searchParams;
      assert.equal(params.get('calendarIds'), '770606');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('priority provider failures', () => {
  const client = { headers: { Authorization: 'Bearer test' } };
  /** @type {Array<[string, () => Promise<unknown>]>} */
  const calls = [
    ['list', () => listReclaimEvents(client, 1, '2024-01-10', '2024-01-12')],
    ['set', () => setEventPriority(client, 1, 'fixture-event', 'P2')]
  ];
  for (const [name, invoke] of calls) {
    it(`${name} classifies HTTP errors without reading or exposing response content`, async (t) => {
      t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('private provider response fixture', { status: 429 })
      );
      await assert.rejects(
        invoke,
        (error) =>
          error instanceof ReclaimApiError &&
          /HTTP 429/.test(error.message) &&
          !error.message.includes('private provider')
      );
    });
    it(`${name} classifies a known socket failure`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture'), { code: 'ECONNRESET' }) });
      });
      await assert.rejects(invoke, ReclaimApiError);
    });
    it(`${name} propagates unexpected programming failures`, async (t) => {
      const fault = new TypeError('Fixture adapter defect');
      t.mock.method(globalThis, 'fetch', async () => {
        throw fault;
      });
      await assert.rejects(invoke, (error) => error === fault);
    });
  }
  it('classifies malformed provider JSON without hiding unexpected JSON reader faults', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{invalid'));
    await assert.rejects(calls[0][1], ReclaimApiError);
    const fault = new TypeError('Fixture decoder defect');
    t.mock.method(globalThis, 'fetch', async () =>
      Object.assign(Response.json([]), {
        json: async () => {
          throw fault;
        }
      })
    );
    await assert.rejects(calls[0][1], (error) => error === fault);
  });
});
