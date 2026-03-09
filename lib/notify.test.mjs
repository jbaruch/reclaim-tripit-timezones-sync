import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { entriesChanged, buildMessage, stripMarkdown, isValidSnsArn } from './notify.mjs';

describe('isValidSnsArn', () => {
  it('accepts a valid ARN', () => {
    assert.equal(isValidSnsArn('arn:aws:sns:us-west-1:920263652810:reclaim-tripit-sync'), true);
  });

  it('rejects empty string', () => {
    assert.equal(isValidSnsArn(''), false);
  });

  it('rejects missing account ID', () => {
    assert.equal(isValidSnsArn('arn:aws:sns:us-west-1::reclaim-tripit-sync'), false);
  });

  it('rejects non-ARN string', () => {
    assert.equal(isValidSnsArn('not-an-arn'), false);
  });
});

describe('stripMarkdown', () => {
  it('strips bold', () => {
    assert.equal(stripMarkdown('*Reclaim Timezone Sync*'), 'Reclaim Timezone Sync');
  });

  it('strips italic', () => {
    assert.equal(stripMarkdown('_Atlanta Trip_'), 'Atlanta Trip');
  });

  it('strips code', () => {
    assert.equal(stripMarkdown('`America/Chicago`'), 'America/Chicago');
  });

  it('leaves plain text unchanged', () => {
    assert.equal(stripMarkdown('Set 1 timezone override'), 'Set 1 timezone override');
  });
});

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
  it('groups segments by trip name with locations', () => {
    const deduped = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'merged' },
    ];
    const raw = [
      { startDate: '2026-03-07', endDate: '2026-03-10', timezone: 'America/Chicago', label: 'Spring Break - Huatulco' },
      { startDate: '2026-03-10', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Spring Break - Mexico City' },
    ];
    const msg = buildMessage([], deduped, raw);
    assert.ok(msg.includes('Set 1 timezone override'));
    assert.ok(msg.includes('*Spring Break*'));
    assert.ok(msg.includes('Huatulco, Mexico City'));
    assert.ok(msg.includes('2026-03-07'));
    assert.ok(msg.includes('2026-03-15'));
  });

  it('shows multiple trips with multiple timezones', () => {
    const deduped = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
      { startDate: '2026-03-15', endDate: '2026-03-20', timezone: 'Europe/London' },
    ];
    const raw = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Spring Break - Mexico City' },
      { startDate: '2026-03-15', endDate: '2026-03-18', timezone: 'Europe/London', label: 'QCon London - London' },
      { startDate: '2026-03-18', endDate: '2026-03-20', timezone: 'Europe/London', label: 'QCon London - Manchester' },
    ];
    const msg = buildMessage([], deduped, raw);
    assert.ok(msg.includes('Set 2 timezone overrides'));
    assert.ok(msg.includes('*Spring Break*'));
    assert.ok(msg.includes('*QCon London*'));
    assert.ok(msg.includes('London, Manchester'));
  });

  it('falls back to deduped segments when no raw segments provided', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Trip - ATL' },
    ];
    const msg = buildMessage([], segments);
    assert.ok(msg.includes('*Trip*'));
    assert.ok(msg.includes('ATL'));
  });

  it('shows previous count', () => {
    const prev = [{ startDate: '2026-01-01', endDate: '2026-01-05', timezone: 'Europe/London' }];
    const deduped = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
    ];
    const raw = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Trip - Chicago' },
    ];
    const msg = buildMessage(prev, deduped, raw);
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

  it('handles segments without labels', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago' },
    ];
    const msg = buildMessage([], segments);
    assert.ok(msg.includes('*Other*'));
    assert.ok(msg.includes('America/Chicago'));
  });
});
