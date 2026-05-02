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

  it('detects cross-trip overlap when a same-trip segment lies between them', () => {
    // Sweep regression: A1 (Trip A, 6/1→6/10) overlaps B (Trip B, 6/5→6/8).
    // A2 (Trip A, 6/2→6/4) sits between them in sort order; an adjacent-pair
    // scan with same-trip suppression would compare A2-vs-B (no overlap) and
    // miss the real A1-vs-B conflict.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-10', timezone: 'America/Chicago', label: 'Trip A - Home' },
      { startDate: '2026-06-02', endDate: '2026-06-04', timezone: 'Europe/London', label: 'Trip A - Layover' },
      { startDate: '2026-06-05', endDate: '2026-06-08', timezone: 'Europe/Berlin', label: 'Trip B - Berlin' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.find(o =>
      (o.labelA === 'Trip A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip A')
    );
    assert.ok(aVsB, 'cross-trip overlap A vs B must be detected');
  });

  it('does not suppress overlaps between two unlabeled segments', () => {
    // Both segments have empty labels → extractTripName returns "Other" for
    // both. Without the "Other" guard, suppression would treat them as one
    // trip and hide a real cross-trip overlap.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-05', timezone: 'America/Chicago', label: '' },
      { startDate: '2026-06-03', endDate: '2026-06-08', timezone: 'Europe/London', label: '' },
    ];
    const overlaps = findOverlaps(segments);
    assert.equal(overlaps.length, 1, 'unlabeled-vs-unlabeled overlap must be reported, not suppressed as same trip');
  });

  it('canonicalizes trip-pair key within a single overlap window', () => {
    // Multiple A segments (lodging + gap-fill) overlap with B segments in
    // ONE date window. Even though the pair appears in multiple raw-segment
    // orderings (A's lodging starts before B; B then overlaps A's gap-fill),
    // the canonical key collapses them within the same curr iteration.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-10', timezone: 'America/Chicago', label: 'Trip A - Lodging' },
      { startDate: '2026-06-02', endDate: '2026-06-08', timezone: 'America/Chicago', label: 'Trip A - GapFill' },
      { startDate: '2026-06-05', endDate: '2026-06-08', timezone: 'Europe/London', label: 'Trip B - London' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.filter(o =>
      (o.labelA === 'Trip A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip A')
    );
    assert.equal(aVsB.length, 1, 'one-window A↔B must dedupe across multiple raw segments');
  });

  it('one continuous overlap window dedupes across multiple raw segments on BOTH sides', () => {
    // Both Trip A and Trip B have multiple raw segments overlapping in
    // the same window. Per-curr dedup alone would still emit duplicates
    // when each B segment iterates over A's actives. Pair-window dedup
    // collapses them to a single warning.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-12', timezone: 'America/Chicago', label: 'Trip A - Lodging' },
      { startDate: '2026-06-02', endDate: '2026-06-09', timezone: 'America/Chicago', label: 'Trip A - GapFill' },
      { startDate: '2026-06-04', endDate: '2026-06-08', timezone: 'Europe/London', label: 'Trip B - Lodging' },
      { startDate: '2026-06-05', endDate: '2026-06-07', timezone: 'Europe/London', label: 'Trip B - GapFill' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.filter(o =>
      (o.labelA === 'Trip A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip A')
    );
    assert.equal(aVsB.length, 1, 'one window must yield exactly one A↔B warning even with multiple segments on each side');
  });

  it('trip name containing pipe character does not corrupt pair-window dedup', () => {
    // Trip summary contains '|'. With a string-pipe delimiter the key
    // would collide. The JSON-array key keeps trip names verbatim so
    // dedup stays correct.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-05', timezone: 'America/Chicago', label: 'Trip|A - X' },
      { startDate: '2026-06-02', endDate: '2026-06-04', timezone: 'America/Chicago', label: 'Trip|A - Y' },
      { startDate: '2026-06-03', endDate: '2026-06-08', timezone: 'Europe/London', label: 'Trip B - Z' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.filter(o =>
      (o.labelA === 'Trip|A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip|A')
    );
    assert.equal(aVsB.length, 1, 'pipe-in-name must not corrupt dedup key (one continuous window → one warning)');
  });

  it('continuous same-trip handoff at end-exclusive boundary stays one window', () => {
    // Trip A has two adjacent segments (end-exclusive: 6/1→6/5 then
    // 6/5→6/10) — Trip A is continuously covered. Trip B overlaps both.
    // Without including curr's trip name in the still-active check,
    // dropping A1 on curr=A2 (same trip handoff) would release the AB
    // pair-window and emit a second duplicate warning.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-05', timezone: 'America/Chicago', label: 'Trip A - First' },
      { startDate: '2026-06-03', endDate: '2026-06-08', timezone: 'Europe/London', label: 'Trip B - London' },
      { startDate: '2026-06-05', endDate: '2026-06-10', timezone: 'America/Chicago', label: 'Trip A - Second' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.filter(o =>
      (o.labelA === 'Trip A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip A')
    );
    assert.equal(aVsB.length, 1, 'continuous same-trip handoff must not split into two warnings');
  });

  it('reports distinct windows separated by a gap on one side, even with continuous opposite side', () => {
    // Trip A has TWO short segments with a gap. Trip B has one LONG
    // segment spanning both. The pair re-overlaps in two distinct
    // windows; pair-window dedup must release the pair when A leaves
    // active set, so the second window is reported.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-03', timezone: 'America/Chicago', label: 'Trip A - First' },
      { startDate: '2026-06-02', endDate: '2026-06-09', timezone: 'Europe/London', label: 'Trip B - Long' },
      { startDate: '2026-06-08', endDate: '2026-06-10', timezone: 'America/Chicago', label: 'Trip A - Second' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.filter(o =>
      (o.labelA === 'Trip A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip A')
    );
    assert.equal(aVsB.length, 2, 'two distinct overlap windows must each emit even when the other side is one continuous segment');
  });

  it('reports distinct overlap windows separately for the same trip pair', () => {
    // Two trips overlap in two SEPARATE date windows. Each window should
    // emit its own warning (the boundary dates differ and are useful).
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-05', timezone: 'America/Chicago', label: 'Trip A - X' },
      { startDate: '2026-06-03', endDate: '2026-06-07', timezone: 'Europe/London', label: 'Trip B - Y' },
      { startDate: '2026-06-10', endDate: '2026-06-15', timezone: 'Europe/London', label: 'Trip B - Z' },
      { startDate: '2026-06-12', endDate: '2026-06-18', timezone: 'America/Chicago', label: 'Trip A - W' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.filter(o =>
      (o.labelA === 'Trip A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip A')
    );
    assert.equal(aVsB.length, 2, 'distinct overlap windows must each be reported');
  });

  it('reports a cross-trip overlap pair only once even with multiple raw segments', () => {
    // Trip A has multiple raw segments (lodging + gap-fill) all in the
    // same trip; Trip B overlaps. Without dedup, the sweep emits A vs B
    // once per A-segment that overlaps B.
    const segments = [
      { startDate: '2026-06-01', endDate: '2026-06-10', timezone: 'America/Chicago', label: 'Trip A - Lodging' },
      { startDate: '2026-06-02', endDate: '2026-06-08', timezone: 'America/Chicago', label: 'Trip A - GapFill' },
      { startDate: '2026-06-05', endDate: '2026-06-08', timezone: 'Europe/London', label: 'Trip B - London' },
    ];
    const overlaps = findOverlaps(segments);
    const aVsB = overlaps.filter(o =>
      (o.labelA === 'Trip A' && o.labelB === 'Trip B') ||
      (o.labelA === 'Trip B' && o.labelB === 'Trip A')
    );
    assert.equal(aVsB.length, 1, 'A vs B must report only once even when A has multiple overlapping raw segments');
  });

  it('suppresses same-trip self-overlaps from raw segments', () => {
    // The lodging-primary algorithm intentionally produces overlapping raw
    // segments within a single trip (lodging segment vs gap-fill flight
    // segment). Dedup later resolves these. We must not warn on them.
    const segments = [
      { startDate: '2026-06-27', endDate: '2026-07-11', timezone: 'Europe/Berlin', label: 'Scotland - Clarion Copenhagen' },
      { startDate: '2026-06-27', endDate: '2026-07-05', timezone: 'Europe/London', label: 'Scotland - Edinburgh' },
    ];
    assert.equal(findOverlaps(segments).length, 0);
  });
});
