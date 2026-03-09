import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTrips,
  extractFlights,
  extractLodging,
  buildTimezoneSegments,
  filterFutureSegments,
  deduplicateSegments,
} from './tripit.mjs';

// ── Helpers to build fake iCal events ──

function makeAllDayEvent(summary, startStr, endStr, { location, geo } = {}) {
  const start = new Date(startStr);
  start.dateOnly = true;
  return {
    type: 'VEVENT',
    summary,
    start,
    end: (() => { const d = new Date(endStr); d.dateOnly = true; return d; })(),
    location: location || '',
    geo: geo || null,
    uid: `trip-${summary}`,
  };
}

function makeFlightEvent(summary, startStr, arrivalTime, tzAbbr, arrivalCity, cityCode) {
  return {
    type: 'VEVENT',
    summary,
    start: new Date(startStr),
    end: new Date(new Date(startStr).getTime() + 3600000),
    description: `8:00 AM EST\n[Flight] SFO to LAX\n\n${arrivalTime} ${tzAbbr}\nArrive ${arrivalCity} (${cityCode})\nTerminal 1`,
    uid: `flight-${summary}`,
  };
}

function makeLodgingCheckin(hotelName, startStr, { tzAbbr, geo, location, uid } = {}) {
  const time = tzAbbr ? `3:00 PM ${tzAbbr}` : '3:00 PM';
  return {
    type: 'VEVENT',
    summary: `Check-in: ${hotelName}`,
    start: new Date(startStr),
    end: new Date(new Date(startStr).getTime() + 3600000),
    description: `${time}\n[Lodging] Arrive ${hotelName}\nCheck-In: 3:00pm`,
    location: location || '',
    geo: geo || undefined,
    uid: uid || `checkin-${hotelName}`,
  };
}

function makeLodgingCheckout(hotelName, startStr, { tzAbbr, geo, location, uid } = {}) {
  const time = tzAbbr ? `12:00 PM ${tzAbbr}` : '12:00 PM';
  return {
    type: 'VEVENT',
    summary: `Check-out: ${hotelName}`,
    start: new Date(startStr),
    end: new Date(new Date(startStr).getTime() + 3600000),
    description: `${time}\n[Lodging] Depart ${hotelName}\nCheck-Out: 12:00pm`,
    location: location || '',
    geo: geo || undefined,
    uid: uid || `checkout-${hotelName}`,
  };
}

// ── extractTrips ──

describe('extractTrips', () => {
  it('extracts all-day trip events', () => {
    const events = [
      makeAllDayEvent('Trip to Paris', '2026-06-01', '2026-06-10', {
        location: 'Paris, France',
        geo: { lat: 48.8566, lon: 2.3522 },
      }),
    ];
    const trips = extractTrips(events);
    assert.equal(trips.length, 1);
    assert.equal(trips[0].summary, 'Trip to Paris');
    assert.equal(trips[0].location, 'Paris, France');
  });

  it('skips non-all-day events', () => {
    const events = [
      makeFlightEvent('UA123', '2026-06-01T10:00:00Z', '1:00 PM', 'CET', 'Paris', 'CDG'),
    ];
    const trips = extractTrips(events);
    assert.equal(trips.length, 0);
  });

  it('skips events with missing start/end', () => {
    const trips = extractTrips([{ type: 'VEVENT', summary: 'Bad' }]);
    assert.equal(trips.length, 0);
  });
});

// ── extractFlights ──

describe('extractFlights', () => {
  it('extracts flights with arrival info', () => {
    const events = [
      makeFlightEvent('DL585', '2026-03-07T22:59:00Z', '8:30 PM', 'CST', 'Mexico City', 'MEX'),
    ];
    const flights = extractFlights(events);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].tzAbbr, 'CST');
    assert.equal(flights[0].arrivalCity, 'Mexico City');
    assert.equal(flights[0].arrivalCityCode, 'MEX');
  });

  it('skips events without Arrive pattern', () => {
    const events = [{
      type: 'VEVENT',
      summary: 'Hotel checkout',
      start: new Date('2026-03-07T12:00:00Z'),
      end: new Date('2026-03-07T13:00:00Z'),
      description: '12:00 PM CST\n[Lodging] Depart Hotel',
    }];
    const flights = extractFlights(events);
    assert.equal(flights.length, 0);
  });

  it('returns flights sorted by arrival date', () => {
    const events = [
      makeFlightEvent('Later', '2026-03-10T10:00:00Z', '2:00 PM', 'EST', 'NYC', 'JFK'),
      makeFlightEvent('Earlier', '2026-03-08T10:00:00Z', '1:00 PM', 'CST', 'Chicago', 'ORD'),
    ];
    const flights = extractFlights(events);
    assert.equal(flights.length, 2);
    assert.equal(flights[0].arrivalCity, 'Chicago');
    assert.equal(flights[1].arrivalCity, 'NYC');
  });
});

// ── extractLodging ──

describe('extractLodging', () => {
  it('pairs check-in and check-out by hotel name', () => {
    const events = [
      makeLodgingCheckin('Hilton', '2026-03-07T21:00:00Z', { tzAbbr: 'CST' }),
      makeLodgingCheckout('Hilton', '2026-03-09T18:00:00Z', { tzAbbr: 'CST' }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].hotelName, 'Hilton');
    assert.equal(stays[0].timezone, 'America/Chicago');
    assert.ok(stays[0].checkinDate);
    assert.ok(stays[0].checkoutDate);
  });

  it('handles check-out only (no matching check-in)', () => {
    const events = [
      makeLodgingCheckout('Orphan Hotel', '2026-03-09T18:00:00Z', { tzAbbr: 'EST' }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].hotelName, 'Orphan Hotel');
    assert.equal(stays[0].checkinDate, null);
    assert.equal(stays[0].timezone, 'America/New_York');
  });

  it('resolves timezone from GEO when no TZ abbreviation', () => {
    const events = [
      makeLodgingCheckin('Boulder Marriott', '2026-03-18T21:00:00Z', {
        geo: { lat: 40.0163, lon: -105.2601 },
      }),
      makeLodgingCheckout('Boulder Marriott', '2026-03-21T17:00:00Z', {
        geo: { lat: 40.0163, lon: -105.2601 },
      }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].timezone, 'America/Denver');
  });

  it('deduplicates multiple-room bookings (same hotel, same time)', () => {
    const events = [
      makeLodgingCheckin('Hyatt Regency', '2026-03-07T21:00:00Z', { tzAbbr: 'CST', uid: 'ci-room1' }),
      makeLodgingCheckin('Hyatt Regency', '2026-03-07T21:00:00Z', { tzAbbr: 'CST', uid: 'ci-room2' }),
      makeLodgingCheckout('Hyatt Regency', '2026-03-10T18:00:00Z', { tzAbbr: 'CST', uid: 'co-room1' }),
      makeLodgingCheckout('Hyatt Regency', '2026-03-10T18:00:00Z', { tzAbbr: 'CST', uid: 'co-room2' }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].hotelName, 'Hyatt Regency');
  });

  it('pairs same hotel different dates by proximity (two stays at same hotel)', () => {
    const events = [
      makeLodgingCheckin('Courtyard Marriott', '2026-12-20T21:00:00Z', { tzAbbr: 'CST' }),
      makeLodgingCheckout('Courtyard Marriott', '2026-12-21T18:00:00Z', { tzAbbr: 'CST' }),
      makeLodgingCheckin('Courtyard Marriott', '2026-12-28T21:00:00Z', { tzAbbr: 'CST' }),
      makeLodgingCheckout('Courtyard Marriott', '2026-12-29T18:00:00Z', { tzAbbr: 'CST' }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 2);
    // First stay: Dec 20 check-in paired with Dec 21 checkout
    assert.equal(stays[0].checkinDate.toISOString(), '2026-12-20T21:00:00.000Z');
    assert.equal(stays[0].checkoutDate.toISOString(), '2026-12-21T18:00:00.000Z');
    // Second stay: Dec 28 check-in paired with Dec 29 checkout
    assert.equal(stays[1].checkinDate.toISOString(), '2026-12-28T21:00:00.000Z');
    assert.equal(stays[1].checkoutDate.toISOString(), '2026-12-29T18:00:00.000Z');
  });

  it('disambiguates CST to Costa Rica timezone using location', () => {
    const events = [
      makeLodgingCheckin('Courtyard by Marriott', '2026-12-20T21:00:00Z', {
        tzAbbr: 'CST',
        location: 'Radial Francisco J. Orlich, Plaza Los Mangos Alajuela 20109 Costa Rica',
      }),
      makeLodgingCheckout('Courtyard by Marriott', '2026-12-21T18:00:00Z', {
        tzAbbr: 'CST',
        location: 'Radial Francisco J. Orlich, Plaza Los Mangos Alajuela 20109 Costa Rica',
      }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].timezone, 'America/Costa_Rica');
  });

  it('disambiguates CST to Mexico timezone using location', () => {
    const events = [
      makeLodgingCheckin('Hilton Mexico City Airport', '2026-03-07T21:00:00Z', {
        tzAbbr: 'CST',
        location: 'Mexico City 15620 MX',
      }),
      makeLodgingCheckout('Hilton Mexico City Airport', '2026-03-08T17:00:00Z', {
        tzAbbr: 'CST',
        location: 'Mexico City 15620 MX',
      }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].timezone, 'America/Mexico_City');
  });

  it('falls back to default CST mapping when location has no country hint', () => {
    const events = [
      makeLodgingCheckin('Some Hotel', '2026-03-07T21:00:00Z', {
        tzAbbr: 'CST',
        location: 'Primary guest:',
      }),
      makeLodgingCheckout('Some Hotel', '2026-03-09T17:00:00Z', {
        tzAbbr: 'CST',
        location: 'Primary guest:',
      }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].timezone, 'America/Chicago');
  });

  it('disambiguates EST to Panama timezone using location', () => {
    const events = [
      makeLodgingCheckin('Bristol Panama', '2026-01-01T20:00:00Z', {
        tzAbbr: 'EST',
        location: 'Avenida Aquilino de La Guardia Panama City PA',
      }),
      makeLodgingCheckout('Bristol Panama', '2026-01-03T17:00:00Z', {
        tzAbbr: 'EST',
        location: 'Avenida Aquilino de La Guardia Panama City PA',
      }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].timezone, 'America/Panama');
  });

  it('returns stays sorted by date', () => {
    const events = [
      makeLodgingCheckin('Hotel B', '2026-03-10T21:00:00Z', { tzAbbr: 'EST' }),
      makeLodgingCheckout('Hotel B', '2026-03-12T18:00:00Z', { tzAbbr: 'EST' }),
      makeLodgingCheckin('Hotel A', '2026-03-05T21:00:00Z', { tzAbbr: 'CST' }),
      makeLodgingCheckout('Hotel A', '2026-03-07T18:00:00Z', { tzAbbr: 'CST' }),
    ];
    const stays = extractLodging(events);
    assert.equal(stays.length, 2);
    assert.equal(stays[0].hotelName, 'Hotel A');
    assert.equal(stays[1].hotelName, 'Hotel B');
  });
});

// ── buildTimezoneSegments ──

describe('buildTimezoneSegments', () => {
  it('builds segments from flights only', () => {
    const trips = [{ summary: 'Trip', startDate: new Date('2026-03-07'), endDate: new Date('2026-03-15'), location: '', geo: null }];
    const flights = [
      { arrivalDate: new Date('2026-03-07T22:00:00Z'), tzAbbr: 'CST', arrivalCity: 'Mexico City' },
      { arrivalDate: new Date('2026-03-14T20:00:00Z'), tzAbbr: 'EST', arrivalCity: 'Atlanta' },
    ];
    const segments = buildTimezoneSegments(trips, flights);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].timezone, 'America/Chicago');
    assert.equal(segments[1].timezone, 'America/New_York');
  });

  it('builds segments from lodging when no flights', () => {
    const trips = [{ summary: 'Road Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: '', geo: null }];
    const stays = [
      { hotelName: 'Denver Hotel', checkinDate: new Date('2026-06-01T21:00:00Z'), checkoutDate: new Date('2026-06-04T17:00:00Z'), timezone: 'America/Denver' },
      { hotelName: 'Chicago Hotel', checkinDate: new Date('2026-06-04T21:00:00Z'), checkoutDate: new Date('2026-06-09T17:00:00Z'), timezone: 'America/Chicago' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].timezone, 'America/Denver');
    assert.equal(segments[0].label, 'Road Trip - Denver Hotel');
    assert.equal(segments[1].timezone, 'America/Chicago');
  });

  it('lodging fills gap after last flight', () => {
    const trips = [{ summary: 'Trip', startDate: new Date('2026-03-07'), endDate: new Date('2026-03-22'), location: '', geo: null }];
    const flights = [
      { arrivalDate: new Date('2026-03-07T22:00:00Z'), tzAbbr: 'CST', arrivalCity: 'Mexico City' },
      { arrivalDate: new Date('2026-03-15T20:00:00Z'), tzAbbr: 'EDT', arrivalCity: 'Atlanta' },
    ];
    const stays = [
      { hotelName: 'Boulder Marriott', checkinDate: new Date('2026-03-18T21:00:00Z'), checkoutDate: new Date('2026-03-21T17:00:00Z'), timezone: 'America/Denver' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].timezone, 'America/Chicago');
    assert.equal(segments[1].timezone, 'America/New_York');
    assert.equal(segments[1].endDate, '2026-03-18'); // ends at Boulder check-in
    assert.equal(segments[2].timezone, 'America/Denver');
    assert.equal(segments[2].startDate, '2026-03-18');
    assert.equal(segments[2].endDate, '2026-03-21');
  });

  it('handles hotel check-in on same day as last flight (date-based comparison)', () => {
    const trips = [{ summary: 'Trip', startDate: new Date('2026-03-07'), endDate: new Date('2026-03-22'), location: '', geo: null }];
    const flights = [
      { arrivalDate: new Date('2026-03-07T22:00:00Z'), tzAbbr: 'CST', arrivalCity: 'Mexico City' },
      { arrivalDate: new Date('2026-03-15T20:00:00Z'), tzAbbr: 'EDT', arrivalCity: 'Atlanta' },
    ];
    // Hotel check-in timestamp is before flight arrival but same calendar day
    const stays = [
      { hotelName: 'Nashville Stay', checkinDate: new Date('2026-03-15T05:00:00Z'), checkoutDate: new Date('2026-03-17T15:00:00Z'), timezone: 'America/Chicago' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    // Nashville check-in is same day as ATL flight, so it should be picked up
    const nashville = segments.find(s => s.label.includes('Nashville'));
    assert.ok(nashville, 'Nashville stay should produce a segment');
    assert.equal(nashville.timezone, 'America/Chicago');
  });

  it('falls back to trip GEO when no flights or lodging', () => {
    const trips = [{ summary: 'Beach Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-05'), location: 'Cancun', geo: { lat: 21.1619, lon: -86.8515 } }];
    const segments = buildTimezoneSegments(trips, []);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].timezone, 'America/Cancun');
  });
});

// ── deduplicateSegments ──

describe('deduplicateSegments', () => {
  it('merges consecutive segments with same timezone', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-10', timezone: 'America/Chicago', label: 'A' },
      { startDate: '2026-03-10', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'B' },
    ];
    const result = deduplicateSegments(segments);
    assert.equal(result.length, 1);
    assert.equal(result[0].startDate, '2026-03-07');
    assert.equal(result[0].endDate, '2026-03-15');
    assert.ok(result[0].label.includes('A'));
    assert.ok(result[0].label.includes('B'));
  });

  it('keeps segments with different timezones separate', () => {
    const segments = [
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'A' },
      { startDate: '2026-03-15', endDate: '2026-03-18', timezone: 'America/New_York', label: 'B' },
    ];
    const result = deduplicateSegments(segments);
    assert.equal(result.length, 2);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(deduplicateSegments([]), []);
  });

  it('sorts by start date before deduplicating', () => {
    const segments = [
      { startDate: '2026-03-15', endDate: '2026-03-18', timezone: 'America/Chicago', label: 'B' },
      { startDate: '2026-03-07', endDate: '2026-03-15', timezone: 'America/Chicago', label: 'A' },
    ];
    const result = deduplicateSegments(segments);
    assert.equal(result.length, 1);
    assert.equal(result[0].startDate, '2026-03-07');
    assert.equal(result[0].endDate, '2026-03-18');
  });
});

// ── filterFutureSegments ──

describe('filterFutureSegments', () => {
  it('filters out past segments', () => {
    const segments = [
      { startDate: '2020-01-01', endDate: '2020-01-10', timezone: 'America/Chicago', label: 'Past' },
      { startDate: '2099-06-01', endDate: '2099-06-10', timezone: 'America/Denver', label: 'Future' },
    ];
    const result = filterFutureSegments(segments);
    assert.equal(result.length, 1);
    assert.equal(result[0].label, 'Future');
  });

  it('filters out segments shorter than 1 day', () => {
    const segments = [
      { startDate: '2099-06-01', endDate: '2099-06-01', timezone: 'America/Chicago', label: 'Same day' },
    ];
    const result = filterFutureSegments(segments);
    assert.equal(result.length, 0);
  });

  it('keeps segments ending today or later', () => {
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
    const segments = [
      { startDate: tomorrow, endDate: dayAfter, timezone: 'America/Chicago', label: 'Soon' },
    ];
    const result = filterFutureSegments(segments);
    assert.equal(result.length, 1);
  });
});
