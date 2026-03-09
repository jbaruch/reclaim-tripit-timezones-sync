import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { entriesChanged, buildMessage } from './notify.mjs';

describe('entriesChanged', () => {
  it('returns false when entries match segments', () => {
    const entries = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
      { startDate: '2026-03-15', endDate: '2026-03-20', timezone: 'America/New_York' },
    ];
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'A' },
      { startDate: '2026-03-15', endDate: '2026-03-20', timezone: 'America/New_York', label: 'B' },
    ];
    assert.equal(entriesChanged(entries, segments), false);
  });

  it('returns true when segment count differs', () => {
    const entries = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
    ];
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'A' },
      { startDate: '2026-03-15', endDate: '2026-03-20', timezone: 'America/New_York', label: 'B' },
    ];
    assert.equal(entriesChanged(entries, segments), true);
  });

  it('returns true when timezone differs', () => {
    const entries = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
    ];
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Denver', label: 'A' },
    ];
    assert.equal(entriesChanged(entries, segments), true);
  });

  it('returns true when dates differ', () => {
    const entries = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
    ];
    const segments = [
      { startDate: '2026-03-08', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'A' },
    ];
    assert.equal(entriesChanged(entries, segments), true);
  });

  it('returns true when going from entries to empty', () => {
    const entries = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
    ];
    assert.equal(entriesChanged(entries, []), true);
  });

  it('returns false when both empty', () => {
    assert.equal(entriesChanged([], []), false);
  });
});

describe('buildMessage', () => {
  it('builds message for new overrides with label', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Atlanta Trip - Flight to ATL' },
    ];
    const msg = buildMessage([], segments);
    assert.ok(msg.includes('Set 1 timezone override'));
    assert.ok(msg.includes('America/Chicago'));
    assert.ok(msg.includes('2026-03-07'));
    assert.ok(msg.includes('Atlanta Trip - Flight to ATL'));
  });

  it('builds message showing previous count', () => {
    const prev = [{ startDate: '2026-01-01', endDate: '2026-01-05', timezone: 'Europe/London' }];
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Trip' },
      { startDate: '2026-03-15', endDate: '2026-03-20', timezone: 'America/New_York', label: 'Trip' },
    ];
    const msg = buildMessage(prev, segments);
    assert.ok(msg.includes('Set 2 timezone overrides'));
    assert.ok(msg.includes('(was 1)'));
  });

  it('builds cleared message', () => {
    const prev = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
      { startDate: '2026-03-15', endDate: '2026-03-20', timezone: 'America/New_York' },
    ];
    const msg = buildMessage(prev, []);
    assert.ok(msg.includes('Cleared 2 timezone overrides'));
    assert.ok(msg.includes('no upcoming travel'));
  });

  it('pluralizes correctly for single entry', () => {
    const msg = buildMessage([{ startDate: 'a', endDate: 'b', timezone: 'c' }], []);
    assert.ok(msg.includes('Cleared 1 timezone override'));
    assert.ok(!msg.includes('overrides'));
  });
});
