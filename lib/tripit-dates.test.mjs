import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { extractTrips, filterFutureTrips } from './tripit.mjs';

const feed = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:date-only-trip',
  'DTSTAMP:20240101T000000Z',
  'SUMMARY:Paris trip',
  'GEO:48.8566;2.3522',
  'DTSTART;VALUE=DATE:20241004',
  'DTEND;VALUE=DATE:20241009',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:checkin',
  'DTSTAMP:20240101T000000Z',
  'SUMMARY:Check-in: Hotel',
  'DTSTART:20241004T150000Z',
  'DTEND:20241004T160000Z',
  'DESCRIPTION:3:00 PM CEST\\n[Lodging] Arrive Hotel',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:checkout',
  'DTSTAMP:20240101T000000Z',
  'SUMMARY:Check-out: Hotel',
  'DTSTART:20241009T110000Z',
  'DTEND:20241009T120000Z',
  'DESCRIPTION:11:00 AM CEST\\n[Lodging] Depart Hotel',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

describe('all-day trip dates across process timezones', () => {
  for (const zone of ['Europe/Brussels', 'Asia/Jerusalem', 'America/Chicago', 'UTC']) {
    it(`preserves DATE boundaries and timed lodging instants in ${zone}`, () => {
      const code = `
        import ical from 'node-ical';
        import {extractTrips,extractLodging,buildTimezoneSegments,filterFutureTrips} from ${JSON.stringify(new URL('./tripit.mjs', import.meta.url).href)};
        const events=Object.values(ical.sync.parseICS(${JSON.stringify(feed)})).filter(event=>event.type==='VEVENT');
        const trips=extractTrips(events);
        const stays=extractLodging(events);
        console.log(JSON.stringify({
          future:filterFutureTrips(trips,'2024-01-01'),
          segments:buildTimezoneSegments(trips,[]),
          stays:stays.map(stay=>({checkin:stay.checkinDate.toISOString(),checkout:stay.checkoutDate.toISOString()}))
        }));
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, TZ: zone },
        encoding: 'utf8',
        timeout: 10000
      });
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
      assert.equal(result.future[0].startDate, '2024-10-04');
      assert.equal(result.future[0].endDate, '2024-10-09');
      assert.deepEqual(
        result.segments.map(({ startDate, endDate, startDateTime, endDateTime }) => ({
          startDate,
          endDate,
          startDateTime,
          endDateTime
        })),
        [
          {
            startDate: '2024-10-04',
            endDate: '2024-10-09',
            startDateTime: '2024-10-04T00:00:00.000Z',
            endDateTime: '2024-10-09T00:00:00.000Z'
          }
        ]
      );
      assert.deepEqual(result.stays, [{ checkin: '2024-10-04T15:00:00.000Z', checkout: '2024-10-09T11:00:00.000Z' }]);
    });
  }

  it('retains explicit date-string civil dates, including compact iCal dates', () => {
    for (const [start, end] of [
      ['2024-10-04', '2024-10-09'],
      ['20241004', '20241009']
    ]) {
      const trips = extractTrips([{ summary: 'Trip', type: 'VEVENT', start, end }]);
      assert.deepEqual(filterFutureTrips(trips, '2024-01-01'), [
        { summary: 'Trip', startDate: '2024-10-04', endDate: '2024-10-09' }
      ]);
    }
  });

  it('honors node-ical datetype when a Date has no dateOnly property', () => {
    const trips = extractTrips([
      {
        type: 'VEVENT',
        datetype: 'date',
        summary: 'Trip',
        start: new Date(2024, 9, 4),
        end: new Date(2024, 9, 9)
      }
    ]);
    assert.deepEqual(filterFutureTrips(trips, '2024-01-01'), [
      { summary: 'Trip', startDate: '2024-10-04', endDate: '2024-10-09' }
    ]);
  });
});
