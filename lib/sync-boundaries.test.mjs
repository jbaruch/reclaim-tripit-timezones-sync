import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterFutureTrips, filterFutureSegments, filterReclaimSegments } from './tripit.mjs';
import { oooDateAt } from './google-calendar.mjs';
import { entriesChanged } from './notify.mjs';

describe('exclusive reconciliation boundaries', () => {
  const ending = { timezone: 'Europe/Paris', startDate: '2024-06-09', endDate: '2024-06-10' };
  const next = { timezone: 'America/New_York', startDate: '2024-06-10', endDate: '2024-06-12' };

  it('does not rewrite a Reclaim schedule that already omits an ending override', () => {
    const schedule = filterFutureSegments([ending, next], '2024-06-10');
    const desired = filterReclaimSegments(schedule, '2024-06-10');
    assert.deepEqual(schedule, [ending, next]);
    assert.deepEqual(desired, [next]);
    assert.equal(entriesChanged([next], desired), false);
    assert.deepEqual(filterReclaimSegments(schedule, '2024-06-09'), [ending, next]);
  });

  it('never recreates a trip at its exclusive OOO end', () => {
    const trip = { summary: 'One night', startDate: new Date('2024-06-09'), endDate: new Date('2024-06-10') };
    assert.equal(filterFutureTrips([trip], '2024-06-09').length, 1);
    assert.deepEqual(filterFutureTrips([trip], '2024-06-10'), []);
  });

  for (const [zone, before, after] of [
    ['America/Chicago', '2024-06-10T04:59:00Z', '2024-06-10T05:00:00Z'],
    ['Europe/Brussels', '2024-06-09T21:59:00Z', '2024-06-09T22:00:00Z']
  ]) {
    it(`expires OOO at home midnight in ${zone}, independently of the UTC date`, () => {
      const trips = [{ summary: 'Trip', startDate: new Date('2024-06-09'), endDate: new Date('2024-06-10') }];
      assert.equal(oooDateAt(zone, new Date(before)), '2024-06-09');
      assert.equal(oooDateAt(zone, new Date(after)), '2024-06-10');
      assert.equal(filterFutureTrips(trips, oooDateAt(zone, new Date(before))).length, 1);
      assert.deepEqual(filterFutureTrips(trips, oooDateAt(zone, new Date(after))), []);
    });
  }

  it('uses UTC when the OOO home timezone is missing or invalid', () => {
    const instant = new Date('2024-06-10T01:00:00Z');
    assert.equal(oooDateAt(null, instant), '2024-06-10');
    assert.equal(oooDateAt('invalid-zone', instant), '2024-06-10');
  });
});
