import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listReclaimEvents } from './reclaim.mjs';

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
