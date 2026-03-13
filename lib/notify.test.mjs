import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { entriesChanged, buildMessage, stripMarkdown, isValidSnsArn, findOverlaps } from './notify.mjs';

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

  it('includes overlap warning when raw segments overlap', () => {
    const deduped = [
      { startDate: '2026-05-22', endDate: '2026-05-31', timezone: 'America/Chicago', label: 'merged' },
      { startDate: '2026-05-31', endDate: '2026-06-06', timezone: 'Europe/London', label: 'merged' },
    ];
    const raw = [
      { startDate: '2026-05-22', endDate: '2026-06-01', timezone: 'America/Chicago', label: 'JNation 2026 - Nashville' },
      { startDate: '2026-05-31', endDate: '2026-06-06', timezone: 'Europe/London', label: 'AI-Native DevCon London 2026 - London' },
    ];
    const msg = buildMessage([], deduped, raw);
    assert.ok(msg.includes('OVERLAPPING TRIPS DETECTED'));
    assert.ok(msg.includes('JNation 2026'));
    assert.ok(msg.includes('AI-Native DevCon London 2026'));
  });

  it('no overlap warning when segments do not overlap', () => {
    const raw = [
      { startDate: '2026-05-22', endDate: '2026-05-31', timezone: 'America/Chicago', label: 'Trip A - Nashville' },
      { startDate: '2026-05-31', endDate: '2026-06-06', timezone: 'Europe/London', label: 'Trip B - London' },
    ];
    const msg = buildMessage([], raw, raw);
    assert.ok(!msg.includes('OVERLAPPING'));
  });
});

describe('buildMessage with OOO stats', () => {
  it('includes OOO section when stats have activity', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Trip - ATL' },
    ];
    const oooStats = { created: 2, deleted: 1, prioritySet: 2, createdNames: ['Spring Break', 'QCon'], deletedNames: ['Old Trip'] };
    const msg = buildMessage([], segments, null, oooStats);
    assert.ok(msg.includes('OOO Calendar Blocks'));
    assert.ok(msg.includes('2 created'));
    assert.ok(msg.includes('1 deleted'));
    assert.ok(msg.includes('2 set to P2'));
    assert.ok(msg.includes('+ Spring Break'));
    assert.ok(msg.includes('+ QCon'));
    assert.ok(msg.includes('− Old Trip'));
  });

  it('omits OOO section when stats are all zeros', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Trip - ATL' },
    ];
    const oooStats = { created: 0, deleted: 0, prioritySet: 0 };
    const msg = buildMessage([], segments, null, oooStats);
    assert.ok(!msg.includes('OOO Calendar Blocks'));
  });

  it('omits OOO section when stats are null', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Trip - ATL' },
    ];
    const msg = buildMessage([], segments, null, null);
    assert.ok(!msg.includes('OOO Calendar Blocks'));
  });

  it('includes OOO section in cleared message too', () => {
    const prev = [{ startDate: 'a', endDate: 'b', timezone: 'c' }];
    const oooStats = { created: 0, deleted: 3, prioritySet: 0 };
    const msg = buildMessage(prev, [], null, oooStats);
    assert.ok(msg.includes('Cleared 1 timezone override'));
    assert.ok(msg.includes('OOO Calendar Blocks'));
    assert.ok(msg.includes('3 deleted'));
  });

  it('only shows non-zero OOO stats', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'Trip - ATL' },
    ];
    const oooStats = { created: 1, deleted: 0, prioritySet: 0, createdNames: ['Devoxx UK'], deletedNames: [] };
    const msg = buildMessage([], segments, null, oooStats);
    assert.ok(msg.includes('1 created'));
    assert.ok(msg.includes('+ Devoxx UK'));
    assert.ok(!msg.includes('deleted'));
    assert.ok(!msg.includes('P2'));
    assert.ok(!msg.includes('−'));
  });
});

describe('findOverlaps', () => {
  it('detects overlapping segments with different timezones', () => {
    const segments = [
      { startDate: '2026-05-22', endDate: '2026-06-01', timezone: 'America/Chicago', label: 'JNation 2026 - Nashville' },
      { startDate: '2026-05-31', endDate: '2026-06-06', timezone: 'Europe/London', label: 'AI-Native DevCon - London' },
    ];
    const overlaps = findOverlaps(segments);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].labelA, 'JNation 2026');
    assert.equal(overlaps[0].labelB, 'AI-Native DevCon');
  });

  it('ignores overlapping segments with same timezone', () => {
    const segments = [
      { startDate: '2026-05-22', endDate: '2026-06-01', timezone: 'America/Chicago', label: 'A - X' },
      { startDate: '2026-05-31', endDate: '2026-06-06', timezone: 'America/Chicago', label: 'B - Y' },
    ];
    assert.equal(findOverlaps(segments).length, 0);
  });

  it('returns empty for non-overlapping segments', () => {
    const segments = [
      { startDate: '2026-05-22', endDate: '2026-05-31', timezone: 'America/Chicago', label: 'A - X' },
      { startDate: '2026-05-31', endDate: '2026-06-06', timezone: 'Europe/London', label: 'B - Y' },
    ];
    assert.equal(findOverlaps(segments).length, 0);
  });

  it('returns empty for null/empty input', () => {
    assert.equal(findOverlaps(null).length, 0);
    assert.equal(findOverlaps([]).length, 0);
  });
});
