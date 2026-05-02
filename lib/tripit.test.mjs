import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTrips,
  extractFlights,
  extractLodging,
  buildTimezoneSegments,
  filterFutureSegments,
  filterFutureTrips,
  filterIgnoredTrips,
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

// ── tripId parsing across extractors ──

describe('tripId parsing from event descriptions', () => {
  it('extractTrips parses tripId from query-string URL', () => {
    const trip = makeAllDayEvent('Stockholm Trip', '2026-01-31', '2026-02-08', { location: 'Stockholm' });
    trip.description = 'jbaruch is in Stockholm, Sweden\nView and/or edit details in TripIt : https://www.tripit.com/trip/show?id=371476770\nTripIt - organize your travel';
    const trips = extractTrips([trip]);
    assert.equal(trips.length, 1);
    assert.equal(trips[0].tripId, '371476770');
  });

  it('extractFlights parses tripId from path-segment URL', () => {
    const flight = makeFlightEvent('DL1557', '2026-01-31T20:25:00Z', '5:02 PM', 'EST', 'Detroit', 'DTW');
    flight.description = 'View and/or edit details in TripIt : https://www.tripit.com/trip/show/id/371476770\n\n2:25 PM CST\n[Flight] BNA to DTW\n\n5:02 PM EST\nArrive Detroit (DTW)';
    const flights = extractFlights([flight]);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].tripId, '371476770');
  });

  it('extractLodging parses tripId from path-segment URL', () => {
    const events = [
      makeLodgingCheckin('Radisson Blu Waterfront', '2026-01-31T15:00:00Z', { tzAbbr: 'CET' }),
      makeLodgingCheckout('Radisson Blu Waterfront', '2026-02-03T11:00:00Z', { tzAbbr: 'CET' }),
    ];
    for (const ev of events) {
      ev.description = `View and/or edit details in TripIt : https://www.tripit.com/trip/show/id/371476770\n${ev.description}`;
    }
    const stays = extractLodging(events);
    assert.equal(stays.length, 1);
    assert.equal(stays[0].tripId, '371476770');
  });

  it('extractors return null tripId when description has no TripIt URL', () => {
    const trip = makeAllDayEvent('Mystery', '2026-06-01', '2026-06-05');
    trip.description = 'no URL here';
    const trips = extractTrips([trip]);
    assert.equal(trips[0].tripId, null);
  });
});

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

  it('lodging overrides a stale/companion flight to a different city', () => {
    // Real-world case: TripIt also tracks family flights. User flew LIS→LHR;
    // family flew LIS→BNA. Lodging in London is the source of truth.
    const trips = [{ summary: 'Conference', startDate: new Date('2026-05-31'), endDate: new Date('2026-06-04'), location: 'London', geo: null }];
    const flights = [
      { arrivalDate: new Date('2026-05-31T11:45:00Z'), tzAbbr: 'BST', arrivalCity: 'London' },
      { arrivalDate: new Date('2026-06-01T01:46:00Z'), tzAbbr: 'CDT', arrivalCity: 'Nashville' },
    ];
    const stays = [
      { hotelName: 'Montcalm', checkinDate: new Date('2026-05-31T15:00:00Z'), checkoutDate: new Date('2026-06-03T11:00:00Z'), timezone: 'Europe/London' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    // The Montcalm lodging segment should cover June 1-2
    const lodgingSeg = segments.find(s => s.label.includes('Montcalm'));
    assert.ok(lodgingSeg);
    assert.equal(lodgingSeg.timezone, 'Europe/London');
    assert.equal(lodgingSeg.startDate, '2026-05-31');
    // No segment should claim June 1-2 in Chicago time
    const chicagoCovers = segments.find(s =>
      s.timezone === 'America/Chicago' && s.startDate <= '2026-06-01' && s.endDate >= '2026-06-02'
    );
    assert.equal(chicagoCovers, undefined);
  });

  it('between-stay flight gap-fill: missing hotel in middle of trip', () => {
    // Trip starts with a brief Copenhagen day-room (Europe/Berlin TZ — Copenhagen
    // shares Central European Time), no hotel for the Edinburgh leg, then a London
    // hotel near the end. The Edinburgh flight in the gap should produce a London
    // segment so the Berlin TZ doesn't bleed forward across the missing-hotel days.
    const trips = [{ summary: 'Tour', startDate: new Date('2026-06-26'), endDate: new Date('2026-07-13'), location: 'Edinburgh', geo: null }];
    const flights = [
      { arrivalDate: new Date('2026-06-27T22:20:00Z'), tzAbbr: 'BST', arrivalCity: 'Edinburgh' },
    ];
    const stays = [
      { hotelName: 'Clarion', checkinDate: new Date('2026-06-27T01:00:00Z'), checkoutDate: new Date('2026-06-27T10:00:00Z'), timezone: 'Europe/Berlin' },
      { hotelName: 'Hampton', checkinDate: new Date('2026-07-11T15:00:00Z'), checkoutDate: new Date('2026-07-12T11:00:00Z'), timezone: 'Europe/London' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    // Should have a London segment covering the Edinburgh gap (6/27 → 7/11)
    const ediSeg = segments.find(s => s.label.includes('Edinburgh'));
    assert.ok(ediSeg);
    assert.equal(ediSeg.timezone, 'Europe/London');
    assert.equal(ediSeg.startDate, '2026-06-27');
    assert.equal(ediSeg.endDate, '2026-07-11');
  });

  it('unmatched-checkout first stay: pre-lodging anchored on next check-in', () => {
    // If the earliest stay has only a checkoutDate (TripIt emitted a checkout
    // with no matching check-in), using its checkoutDate as the pre-lodging
    // cutoff would mis-classify flights that occurred during the lodging.
    // The pre-lodging cutoff must come from the earliest known check-in.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: '', geo: null }];
    const flights = [
      // Flight that the bug would mis-cap: with orphan-checkout as cutoff,
      // segEnd would be 06-04 (orphan's checkout). Correct behavior caps
      // at the next REAL check-in (06-05).
      { arrivalDate: new Date('2026-06-03T10:00:00Z'), tzAbbr: 'EDT', arrivalCity: 'New York' },
    ];
    const stays = [
      { hotelName: 'Orphan Hotel', checkinDate: null, checkoutDate: new Date('2026-06-04T11:00:00Z'), timezone: 'America/Chicago' },
      { hotelName: 'Real Hotel', checkinDate: new Date('2026-06-05T15:00:00Z'), checkoutDate: new Date('2026-06-09T11:00:00Z'), timezone: 'America/Denver' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    // The pre-lodging NY segment must end at the next real check-in (06-05),
    // never at the orphan's checkout (06-04). Anchoring on the orphan would
    // misclassify the lodging-coverage window between checkout and real
    // check-in.
    const nySeg = segments.find(s => s.timezone === 'America/New_York');
    assert.ok(nySeg, 'expected a pre-lodging NY segment for the 06-03 flight');
    assert.ok(nySeg.endDate >= '2026-06-05', 'NY segment must extend at least to the real check-in, not be capped by the orphan checkout');
  });

  it('west-of-UTC last-day late-night flight is attributed by tripId', () => {
    // Chicago user; return flight arrives 06-08 03:00 UTC (22:00 CDT 06-07)
    // — past tripEnd UTC but on the user's last local day. With trip IDs,
    // attribution is unambiguous regardless of UTC date arithmetic.
    const trips = [{ summary: 'Chicago Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-08'), location: 'Chicago', geo: null, tripId: '100' }];
    const flights = [
      { arrivalDate: new Date('2026-06-01T14:00:00Z'), tzAbbr: 'CDT', arrivalCity: 'Chicago', tripId: '100' },
      { arrivalDate: new Date('2026-06-08T03:00:00Z'), tzAbbr: 'CDT', arrivalCity: 'Chicago', tripId: '100' },
    ];
    const segments = buildTimezoneSegments(trips, flights);
    const lateNight = segments.find(s => s.startDate >= '2026-06-07' && s.timezone === 'America/Chicago');
    assert.ok(lateNight, 'late-night last-day flight should still be reflected in segments');
  });

  it('east-of-UTC first-day flight is attributed by tripId', () => {
    // Tokyo trip; flight arrives 05-31 22:00 UTC — on the user's first
    // local day (06-01 JST) but before tripStart UTC. Trip ID matching
    // attributes correctly without needing a date-window buffer.
    const trips = [{ summary: 'Tokyo Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-05'), location: 'Tokyo', geo: null, tripId: '200' }];
    const flights = [
      { arrivalDate: new Date('2026-05-31T22:00:00Z'), tzAbbr: 'JST', arrivalCity: 'Tokyo', tripId: '200' },
    ];
    const segments = buildTimezoneSegments(trips, flights);
    const tokyo = segments.find(s => s.timezone === 'Asia/Tokyo');
    assert.ok(tokyo, 'first-day flight before tripStart UTC should still produce a Tokyo segment');
  });

  it('flight from adjacent trip does not bleed (different tripId)', () => {
    // Trip A's outbound flight has Trip A's ID; the next trip's outbound
    // flight has a different ID and lands one day past Trip A's endDate.
    // Trip-ID matching cleanly excludes it.
    const trips = [
      { summary: 'Trip A', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-04'), location: 'Berlin', geo: null, tripId: 'A' },
    ];
    const flights = [
      { arrivalDate: new Date('2026-06-01T14:00:00Z'), tzAbbr: 'CEST', arrivalCity: 'Berlin', tripId: 'A' },
      // Next-trip outbound — different tripId, must NOT attach to Trip A.
      { arrivalDate: new Date('2026-06-05T15:00:00Z'), tzAbbr: 'EDT', arrivalCity: 'New York', tripId: 'B' },
    ];
    const segments = buildTimezoneSegments(trips, flights);
    const stray = segments.find(s => s.timezone === 'America/New_York');
    assert.equal(stray, undefined, 'next-trip flight must not produce a Trip A segment');
    const berlin = segments.find(s => s.timezone === 'Europe/Berlin');
    assert.ok(berlin);
    assert.ok(berlin.endDate <= '2026-06-04', 'Berlin segment must not extend past Trip A endDate');
  });

  it('adjacent-trip stay does not attach (different tripId)', () => {
    const trips = [
      { summary: 'Trip A', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-04'), location: 'Berlin', geo: null, tripId: 'A' },
    ];
    const flights = [
      { arrivalDate: new Date('2026-06-01T14:00:00Z'), tzAbbr: 'CEST', arrivalCity: 'Berlin', tripId: 'A' },
    ];
    const stays = [
      { hotelName: 'Next Trip Hotel', checkinDate: new Date('2026-06-04T14:00:00Z'), checkoutDate: new Date('2026-06-08T11:00:00Z'), timezone: 'America/New_York', tripId: 'B' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    const berlin = segments.find(s => s.timezone === 'Europe/Berlin');
    assert.ok(berlin, "Trip A's flight-derived Berlin segment must survive");
    assert.equal(berlin.label, 'Trip A - Berlin');
    const stray = segments.find(s => s.timezone === 'America/New_York');
    assert.equal(stray, undefined, 'next-trip hotel (different tripId) must not produce a Trip A segment');
  });

  it('timezone-less stay still anchors boundaries (no flight bleed during the stay)', () => {
    // A real stay whose TZ couldn't be resolved must still influence
    // firstCheckinDate. Otherwise a flight arriving during that stay would
    // be classified as pre-lodging and emit a segment over the lodging days.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: '', geo: null }];
    const flights = [
      // Arrives during the timezone-less stay — must NOT be pre-lodging.
      { arrivalDate: new Date('2026-06-04T10:00:00Z'), tzAbbr: 'EDT', arrivalCity: 'New York' },
    ];
    const stays = [
      // Timezone-less stay (resolution failed) covering 06-02 → 06-06.
      { hotelName: 'Mystery Inn', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-06T11:00:00Z'), timezone: null },
      { hotelName: 'Real Hotel', checkinDate: new Date('2026-06-07T15:00:00Z'), checkoutDate: new Date('2026-06-09T11:00:00Z'), timezone: 'America/Denver' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    const nySeg = segments.find(s => s.timezone === 'America/New_York');
    // The 06-04 NY flight is AFTER the (TZ-less) Mystery Inn check-in, so
    // it must NOT be classified as pre-lodging. It also isn't a between-stay
    // flight (next stay has no checkin? it has — Real Hotel checks in 06-07,
    // Mystery Inn checks out 06-06: gap exists 06-06→06-07, but the 06-04
    // flight is BEFORE the gap). So no NY segment should be produced.
    assert.equal(nySeg, undefined, 'flight arriving during a TZ-less stay must not become a pre-lodging segment');
  });

it('carry-over unmatched checkout from previous trip does not bleed', () => {
    // The previous trip's last hotel has a checkout on the morning of THIS
    // trip's start day. extractLodging surfaces it as a checkin-less stay
    // and tags it with the PREVIOUS trip's ID. Trip-ID matching cleanly
    // attributes it to the right trip — no carry-over bleed into the new
    // trip's segments.
    const trips = [{ summary: 'New Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-05'), location: 'Berlin', geo: null, tripId: 'NEW' }];
    const flights = [
      { arrivalDate: new Date('2026-06-01T14:00:00Z'), tzAbbr: 'CEST', arrivalCity: 'Berlin', tripId: 'NEW' },
    ];
    const stays = [
      // Carry-over: previous trip's hotel checkout at 9 AM new-trip-start.
      // Different tripId — TripIt files it under the previous trip.
      { hotelName: 'Previous Hotel', checkinDate: null, checkoutDate: new Date('2026-06-01T09:00:00Z'), timezone: 'America/Chicago', tripId: 'PREV' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    // Berlin flight-derived segment must drive the trip; carry-over Chicago
    // must not appear at all.
    const stray = segments.find(s => s.timezone === 'America/Chicago');
    assert.equal(stray, undefined, 'carry-over hotel checkout must not produce a segment in the new trip');
    const berlin = segments.find(s => s.timezone === 'Europe/Berlin');
    assert.ok(berlin, 'flight-derived Berlin segment must drive the new trip');
  });

  it('legitimate within-trip orphan checkout (well past trip start) is honored', () => {
    // Mid-trip unmatched checkout (TripIt missed the check-in event):
    // checkout falls late on day 4, well past the 12-hour carry-over
    // cutoff. The orphan's TZ should cover its window in the trip.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: '', geo: null }];
    const stays = [
      { hotelName: 'Orphan Mid-Trip', checkinDate: null, checkoutDate: new Date('2026-06-04T14:00:00Z'), timezone: 'America/Chicago' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const chicagoSeg = segments.find(s => s.timezone === 'America/Chicago');
    assert.ok(chicagoSeg, 'legitimate within-trip orphan must produce a segment');
    // Must have positive duration — a zero-length segment would be dropped
    // by the production sync pipeline before reaching Reclaim.
    assert.ok(chicagoSeg.startDate < chicagoSeg.endDate, 'orphan segment must have positive duration');
  });

  it('resolved orphan checkout after a resolved stay still emits a real segment', () => {
    // Stays sequence: a normal resolved stay 06-02→06-04, then an orphan
    // (TZ but no checkin) checking out 06-08. Without trailing-stay
    // handling that stops before resolved orphans, the prior segment
    // would extend to the orphan's checkout and the orphan's own
    // segment would collapse to zero length.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: '', geo: null, tripId: 'X' }];
    const stays = [
      { hotelName: 'First', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-04T11:00:00Z'), timezone: 'America/Chicago', tripId: 'X' },
      { hotelName: 'Resolved Orphan', checkinDate: null, checkoutDate: new Date('2026-06-08T11:00:00Z'), timezone: 'America/Denver', tripId: 'X' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const orphanSeg = segments.find(s => s.timezone === 'America/Denver');
    assert.ok(orphanSeg);
    assert.ok(orphanSeg.startDate < orphanSeg.endDate, 'resolved orphan must have positive duration');
    const firstSeg = segments.find(s => s.timezone === 'America/Chicago');
    assert.ok(firstSeg);
    assert.ok(firstSeg.endDate <= '2026-06-04', 'first stay must not reach into the orphan window');
  });

  it('trailing TZ-less stays still get coverage from the prior resolved TZ', () => {
    // Last resolved stay is followed by TZ-less stays that extend toward
    // trip end. The resolved segment must extend through them rather than
    // ending at its own checkout, otherwise trailing unresolved-hotel days
    // fall back to the default timezone.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-15'), location: '', geo: null }];
    const stays = [
      { hotelName: 'Berlin Hotel', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-05T11:00:00Z'), timezone: 'Europe/Berlin' },
      { hotelName: 'Mystery Late', checkinDate: new Date('2026-06-05T15:00:00Z'), checkoutDate: new Date('2026-06-09T11:00:00Z'), timezone: null },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const berlinSeg = segments.find(s => s.timezone === 'Europe/Berlin');
    assert.ok(berlinSeg);
    assert.equal(berlinSeg.endDate, '2026-06-09', 'Berlin should extend to the trailing TZ-less stay\'s checkout');
  });

  it('orphan checkout does not eclipse an earlier resolved stay back to trip start', () => {
    // Resolved Berlin stay days 2-5, then a mid-trip orphan checkout day 8.
    // Without lastEmittedEnd tracking, the orphan would start at rangeStart
    // (trip.startDate) and emit a segment day 1 → day 8 in its own TZ,
    // eclipsing the Berlin segment after dedup-clip.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-12'), location: '', geo: null }];
    const stays = [
      { hotelName: 'Berlin', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-05T11:00:00Z'), timezone: 'Europe/Berlin' },
      { hotelName: 'Mid-trip Orphan', checkinDate: null, checkoutDate: new Date('2026-06-08T11:00:00Z'), timezone: 'America/Chicago' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const berlinSeg = segments.find(s => s.timezone === 'Europe/Berlin');
    const orphanSeg = segments.find(s => s.timezone === 'America/Chicago');
    assert.ok(berlinSeg);
    assert.ok(orphanSeg);
    // Orphan must not start before the Berlin checkout — otherwise it would
    // eclipse Berlin all the way back to the trip start.
    assert.ok(orphanSeg.startDate >= '2026-06-05', `orphan start ${orphanSeg.startDate} must be at or after the previous resolved stay's checkout`);
  });

  it('TZ-less stay between resolved stays does not leave a gap', () => {
    // A resolved stay (Berlin), followed by a TZ-less stay, followed by
    // another resolved stay (London). The Berlin segment should extend
    // across the TZ-less window to the London check-in, not end at the
    // TZ-less stay's check-in (which would leave the unresolved-hotel
    // days falling back to Reclaim's default timezone).
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-15'), location: '', geo: null }];
    const stays = [
      { hotelName: 'Berlin Hotel', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-05T11:00:00Z'), timezone: 'Europe/Berlin' },
      { hotelName: 'Mystery', checkinDate: new Date('2026-06-05T15:00:00Z'), checkoutDate: new Date('2026-06-08T11:00:00Z'), timezone: null },
      { hotelName: 'London Hotel', checkinDate: new Date('2026-06-08T15:00:00Z'), checkoutDate: new Date('2026-06-12T11:00:00Z'), timezone: 'Europe/London' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const berlinSeg = segments.find(s => s.timezone === 'Europe/Berlin');
    assert.ok(berlinSeg);
    // Berlin extends to London check-in, not Mystery's check-in.
    assert.equal(berlinSeg.endDate, '2026-06-08', 'Berlin segment should extend across TZ-less stay to London check-in');
  });

  it('GEO segment does not eclipse pre-lodging flight at trip edge', () => {
    // Pre-lodging flight starts on the same calendar day as the GEO
    // fallback segment. If GEO covers the whole trip window, dedup
    // (which clips by startDate day) eclipses the flight segment.
    // GEO bounded to the stay window leaves the flight segment alone.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: 'Cancun', geo: { lat: 21.1619, lon: -86.8515 }, tripId: 'X' }];
    const flights = [
      // Pre-lodging arrival on day 1 — must produce a segment that survives
      // through dedup, not be eclipsed by a competing GEO segment at the same
      // start date.
      { arrivalDate: new Date('2026-06-01T14:00:00Z'), tzAbbr: 'EDT', arrivalCity: 'Atlanta', tripId: 'X' },
    ];
    const stays = [
      { hotelName: 'Mystery Resort', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-08T11:00:00Z'), timezone: null, tripId: 'X' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    const dedup = deduplicateSegments(filterFutureSegments(segments));
    // Atlanta segment must exist post-dedup, covering at least one day
    // before the stay check-in — i.e. the pre-lodging flight survived.
    const atl = dedup.find(s => s.timezone === 'America/New_York');
    assert.ok(atl, 'pre-lodging Atlanta segment must survive dedup, not be eclipsed by GEO');
    assert.ok(atl.startDate <= '2026-06-01' && atl.endDate >= '2026-06-02');
  });

  it('GEO covers leading TZ-less stay window when later stay is resolved', () => {
    // Stays: TZ-less leading then resolved trailing. Lodging-primary emits
    // only the resolved segment from its check-in. Days during the leading
    // TZ-less stay are uncovered by lodging; GEO must cover them, bounded
    // to the stay window (earliest checkin to latest checkout).
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-15'), location: 'Cancun', geo: { lat: 21.1619, lon: -86.8515 }, tripId: 'X' }];
    const stays = [
      { hotelName: 'Mystery Leading', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-05T11:00:00Z'), timezone: null, tripId: 'X' },
      { hotelName: 'Real', checkinDate: new Date('2026-06-05T15:00:00Z'), checkoutDate: new Date('2026-06-12T11:00:00Z'), timezone: 'America/Denver', tripId: 'X' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const cancun = segments.find(s => s.timezone === 'America/Cancun');
    assert.ok(cancun, 'GEO fallback must emit when any stay is TZ-less');
    // GEO must start at the earliest check-in (06-02), not at trip start (06-01).
    assert.equal(cancun.startDate, '2026-06-02');
  });

  it('GEO covers single-sided TZ-less stay with positive duration', () => {
    // TZ-less stay with only a checkin (open-ended). Earlier code emitted
    // a zero-length GEO segment that filterFutureSegments dropped.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: 'Cancun', geo: { lat: 21.1619, lon: -86.8515 }, tripId: 'X' }];
    const stays = [
      { hotelName: 'Open-ended Mystery', checkinDate: new Date('2026-06-03T15:00:00Z'), checkoutDate: null, timezone: null, tripId: 'X' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const cancun = segments.find(s => s.timezone === 'America/Cancun');
    assert.ok(cancun, 'partial GEO must fire even when stay has only one boundary');
    assert.ok(cancun.startDate < cancun.endDate, 'partial GEO segment must have positive duration');
  });

  it('partial GEO is clamped to the trip window', () => {
    // Fallback-attributed (no-tripId) stay extends slightly past the trip
    // window via matchesTrip's buffer. The emitted GEO segment must NOT
    // extend past trip.endDate or before trip.startDate.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: 'Cancun', geo: { lat: 21.1619, lon: -86.8515 } }];
    const stays = [
      // No tripId on either side — matchesTrip uses the date-overlap
      // fallback. Checkin within window; checkout 6h past trip end.
      { hotelName: 'Spillover Mystery', checkinDate: new Date('2026-06-09T15:00:00Z'), checkoutDate: new Date('2026-06-10T06:00:00Z'), timezone: null },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const cancun = segments.find(s => s.timezone === 'America/Cancun');
    assert.ok(cancun);
    assert.ok(cancun.endDate <= '2026-06-10', 'GEO endDate must not exceed trip endDate');
    assert.ok(cancun.startDate >= '2026-06-01', 'GEO startDate must not precede trip startDate');
  });

  it('no-checkout prev stay leaves a window for a following resolved orphan', () => {
    // First stay has a checkin but no checkout (data-quality issue), the
    // next stay is a resolved orphan with a known checkout. Without the
    // 1-day reservation, the prev stay extended to rangeEnd and the
    // orphan collapsed to a zero/negative-length segment.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-15'), location: '', geo: null, tripId: 'X' }];
    const stays = [
      { hotelName: 'No-Checkout Prev', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: null, timezone: 'America/Chicago', tripId: 'X' },
      { hotelName: 'Orphan Next', checkinDate: null, checkoutDate: new Date('2026-06-08T11:00:00Z'), timezone: 'America/Denver', tripId: 'X' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const orphan = segments.find(s => s.timezone === 'America/Denver');
    assert.ok(orphan, 'orphan must still emit a segment when prev has no checkout');
    assert.ok(orphan.startDate < orphan.endDate, 'orphan segment must have positive duration');
    const prev = segments.find(s => s.timezone === 'America/Chicago');
    assert.ok(prev);
    // Prev must not extend all the way to trip end.
    assert.ok(prev.endDate < '2026-06-15', `prev must not extend to rangeEnd, got endDate=${prev.endDate}`);
  });

  it('orphan stay segment ends at its own checkout, not at next stay\'s checkin', () => {
    // Orphan checkout 6/4 followed by a real hotel that doesn't check in
    // until 6/10. The only evidence we have for the orphan is that the
    // user was there UNTIL 6/4 — extending its TZ through 6/10 would
    // claim days the user was elsewhere.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-15'), location: '', geo: null, tripId: 'X' }];
    const stays = [
      { hotelName: 'Orphan', checkinDate: null, checkoutDate: new Date('2026-06-04T11:00:00Z'), timezone: 'America/Chicago', tripId: 'X' },
      { hotelName: 'Real', checkinDate: new Date('2026-06-10T15:00:00Z'), checkoutDate: new Date('2026-06-12T11:00:00Z'), timezone: 'America/Denver', tripId: 'X' },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    const orphanSeg = segments.find(s => s.timezone === 'America/Chicago');
    assert.ok(orphanSeg);
    assert.ok(orphanSeg.endDate <= '2026-06-04', `orphan TZ must not extend past its checkout, got endDate=${orphanSeg.endDate}`);
  });

  it('extractLodging does not pair check-in and check-out across different trips', () => {
    // Same hotel name, two trips. The pairing logic was hotel-name +
    // date-proximity only; without the tripId guard, the first trip's
    // check-in could pair with the second trip's check-out.
    const checkin1 = makeLodgingCheckin('Hilton Garden Inn', '2026-06-01T15:00:00Z', { tzAbbr: 'CET', uid: 'ci1' });
    checkin1.description = `https://www.tripit.com/trip/show/id/100\n${checkin1.description}`;
    const checkout1 = makeLodgingCheckout('Hilton Garden Inn', '2026-06-03T11:00:00Z', { tzAbbr: 'CET', uid: 'co1' });
    checkout1.description = `https://www.tripit.com/trip/show/id/100\n${checkout1.description}`;
    const checkin2 = makeLodgingCheckin('Hilton Garden Inn', '2026-06-15T15:00:00Z', { tzAbbr: 'CET', uid: 'ci2' });
    checkin2.description = `https://www.tripit.com/trip/show/id/200\n${checkin2.description}`;
    const checkout2 = makeLodgingCheckout('Hilton Garden Inn', '2026-06-17T11:00:00Z', { tzAbbr: 'CET', uid: 'co2' });
    checkout2.description = `https://www.tripit.com/trip/show/id/200\n${checkout2.description}`;
    const stays = extractLodging([checkin1, checkout1, checkin2, checkout2]);
    assert.equal(stays.length, 2, 'two trips should produce two distinct stays');
    const tripIds = stays.map(s => s.tripId).sort();
    assert.deepEqual(tripIds, ['100', '200']);
    // Each stay's checkout must be on the SAME trip's date, not the other's.
    const trip100 = stays.find(s => s.tripId === '100');
    const trip200 = stays.find(s => s.tripId === '200');
    assert.equal(trip100.checkoutDate.toISOString().slice(0, 10), '2026-06-03');
    assert.equal(trip200.checkoutDate.toISOString().slice(0, 10), '2026-06-17');
  });

  it('extractLodging dedupBy keeps same-hotel-same-time events from different trips', () => {
    // Edge case: two trips' check-ins for the same hotel chain happen at
    // the same UTC timestamp (rare; e.g., a late-night and a same-time
    // booking in different cities). dedupBy keying only on hotelName+time
    // would collapse one and lose its tripId.
    const ci1 = makeLodgingCheckin('Marriott', '2026-06-01T15:00:00Z', { tzAbbr: 'EDT', uid: 'a' });
    ci1.description = `https://www.tripit.com/trip/show/id/300\n${ci1.description}`;
    const co1 = makeLodgingCheckout('Marriott', '2026-06-02T11:00:00Z', { tzAbbr: 'EDT', uid: 'b' });
    co1.description = `https://www.tripit.com/trip/show/id/300\n${co1.description}`;
    const ci2 = makeLodgingCheckin('Marriott', '2026-06-01T15:00:00Z', { tzAbbr: 'CDT', uid: 'c' });
    ci2.description = `https://www.tripit.com/trip/show/id/400\n${ci2.description}`;
    const co2 = makeLodgingCheckout('Marriott', '2026-06-02T11:00:00Z', { tzAbbr: 'CDT', uid: 'd' });
    co2.description = `https://www.tripit.com/trip/show/id/400\n${co2.description}`;
    const stays = extractLodging([ci1, co1, ci2, co2]);
    assert.equal(stays.length, 2, 'same-hotel-same-time events from different trips must not collapse');
    const tripIds = new Set(stays.map(s => s.tripId));
    assert.ok(tripIds.has('300') && tripIds.has('400'));
  });

  it('GEO covers TZ-less stay window even when gap-fill flights exist', () => {
    // Trip with flights AND a single TZ-less stay. Pre-lodging and
    // post-lodging flight gap-fill produce useful segments at the edges,
    // but the stay window itself has no resolvable TZ. The GEO fallback
    // must fire to cover those middle days; without it they fall back
    // to Reclaim's default timezone.
    const trips = [{ summary: 'Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: 'Cancun', geo: { lat: 21.1619, lon: -86.8515 }, tripId: 'X' }];
    const flights = [
      { arrivalDate: new Date('2026-06-01T14:00:00Z'), tzAbbr: 'CST', arrivalCity: 'Cancun', tripId: 'X' },
      { arrivalDate: new Date('2026-06-09T22:00:00Z'), tzAbbr: 'CST', arrivalCity: 'Nashville', tripId: 'X' },
    ];
    const stays = [
      { hotelName: 'Mystery Resort', checkinDate: new Date('2026-06-02T15:00:00Z'), checkoutDate: new Date('2026-06-08T11:00:00Z'), timezone: null, tripId: 'X' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    // Cancun (GEO-derived) must appear so the unresolved-stay window has TZ coverage.
    const cancunSeg = segments.find(s => s.timezone === 'America/Cancun');
    assert.ok(cancunSeg, 'GEO fallback must emit a segment when stay window is unresolved');
  });

  it('GEO fallback fires when lodging-primary produces no segments', () => {
    // Trip has a stay (so it enters the lodging-primary path) but the stay
    // has no resolved timezone and there are no usable flights. The
    // trip-level GEO must still produce a fallback segment instead of the
    // trip ending up with no timezone at all.
    const trips = [{ summary: 'Beach Trip', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-05'), location: 'Cancun', geo: { lat: 21.1619, lon: -86.8515 } }];
    const stays = [
      { hotelName: 'Mystery Resort', checkinDate: new Date('2026-06-01T15:00:00Z'), checkoutDate: new Date('2026-06-04T11:00:00Z'), timezone: null },
    ];
    const segments = buildTimezoneSegments(trips, [], stays);
    assert.ok(segments.length >= 1, 'GEO fallback must produce a segment when lodging-primary emits nothing');
    const geoSeg = segments.find(s => s.timezone === 'America/Cancun');
    assert.ok(geoSeg, 'expected GEO-derived Cancun segment as fallback');
  });

  it('post-lodging gap: return-home flight on last day', () => {
    // Trip ends with a hotel checkout, then a flight home before trip end.
    const trips = [{ summary: 'Conf', startDate: new Date('2026-06-05'), endDate: new Date('2026-06-07'), location: 'London', geo: null }];
    const flights = [
      { arrivalDate: new Date('2026-06-06T22:09:00Z'), tzAbbr: 'CDT', arrivalCity: 'Nashville' },
    ];
    const stays = [
      { hotelName: 'Hilton Heathrow', checkinDate: new Date('2026-06-05T15:00:00Z'), checkoutDate: new Date('2026-06-06T11:00:00Z'), timezone: 'Europe/London' },
    ];
    const segments = buildTimezoneSegments(trips, flights, stays);
    const homeSeg = segments.find(s => s.timezone === 'America/Chicago');
    assert.ok(homeSeg);
    assert.equal(homeSeg.startDate, '2026-06-06');
    assert.equal(homeSeg.endDate, '2026-06-07');
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

  it('clips overlapping segments with different timezones', () => {
    const segments = [
      { startDate: '2026-05-22', endDate: '2026-06-01', timezone: 'America/Chicago', label: 'Home' },
      { startDate: '2026-05-31', endDate: '2026-06-06', timezone: 'Europe/London', label: 'London' },
    ];
    const result = deduplicateSegments(segments);
    assert.equal(result.length, 2);
    assert.equal(result[0].endDate, '2026-05-31', 'first segment should be clipped to start of second');
    assert.equal(result[1].startDate, '2026-05-31');
    assert.equal(result[1].endDate, '2026-06-06');
  });

  it('removes segments fully eclipsed by a later-starting different-timezone segment', () => {
    const segments = [
      { startDate: '2026-05-10', endDate: '2026-05-12', timezone: 'America/Chicago', label: 'Short' },
      { startDate: '2026-05-10', endDate: '2026-05-20', timezone: 'Europe/London', label: 'Long' },
    ];
    const result = deduplicateSegments(segments);
    assert.equal(result.length, 1);
    assert.equal(result[0].timezone, 'Europe/London');
  });
});

// ── filterIgnoredTrips ──

describe('filterIgnoredTrips', () => {
  const trips = [
    { summary: 'Work trip to Berlin', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10') },
    { summary: "Daniel's Trip to London", startDate: new Date('2026-07-01'), endDate: new Date('2026-07-08') },
    { summary: 'Family vacation to Paris', startDate: new Date('2026-08-01'), endDate: new Date('2026-08-15') },
    { summary: "Sarah and Daniel spring break", startDate: new Date('2026-04-01'), endDate: new Date('2026-04-10') },
  ];

  it('returns all trips when no ignore patterns', () => {
    const result = filterIgnoredTrips(trips);
    assert.equal(result.length, 4);
  });

  it('returns all trips when ignore lists are empty', () => {
    const result = filterIgnoredTrips(trips, [], []);
    assert.equal(result.length, 4);
  });

  it('filters by exact trip name (case-insensitive substring)', () => {
    const result = filterIgnoredTrips(trips, ['family vacation to paris'], []);
    assert.equal(result.length, 3);
    assert.ok(result.every(t => t.summary !== 'Family vacation to Paris'));
  });

  it('filters by keyword', () => {
    const result = filterIgnoredTrips(trips, [], ['daniel']);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(t => t.summary), [
      'Work trip to Berlin',
      'Family vacation to Paris',
    ]);
  });

  it('filters by multiple keywords', () => {
    const result = filterIgnoredTrips(trips, [], ['daniel', 'family']);
    assert.equal(result.length, 1);
    assert.equal(result[0].summary, 'Work trip to Berlin');
  });

  it('combines trip names and keywords', () => {
    const result = filterIgnoredTrips(trips, ['work trip to berlin'], ['daniel']);
    assert.equal(result.length, 1);
    assert.equal(result[0].summary, 'Family vacation to Paris');
  });

  it('matching is case-insensitive', () => {
    const result = filterIgnoredTrips(trips, [], ['DANIEL']);
    assert.equal(result.length, 2);
  });

  it('partial substring match works', () => {
    const result = filterIgnoredTrips(trips, ['berlin'], []);
    assert.equal(result.length, 3);
    assert.ok(result.every(t => !t.summary.includes('Berlin')));
  });

  it('non-matching patterns leave all trips intact', () => {
    const result = filterIgnoredTrips(trips, ['nonexistent'], ['nobody']);
    assert.equal(result.length, 4);
  });
});

// ── ignored trips excluded from segments and OOO ──

describe('ignored trips produce no segments or OOO candidates', () => {
  // Two trips: one work, one family. Each has its own flight.
  const workTrip = { summary: 'Work trip to Berlin', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-10'), location: 'Berlin', geo: null };
  const familyTrip = { summary: "Daniel's Trip to London", startDate: new Date('2026-07-01'), endDate: new Date('2026-07-08'), location: 'London', geo: null };
  const allTrips = [workTrip, familyTrip];

  const berlinFlight = { arrivalDate: new Date('2026-06-01T14:00:00Z'), tzAbbr: 'CET', arrivalCity: 'Berlin' };
  const londonFlight = { arrivalDate: new Date('2026-07-01T10:00:00Z'), tzAbbr: 'BST', arrivalCity: 'London' };
  const allFlights = [berlinFlight, londonFlight];

  it('ignored trip flights do not leak into segments', () => {
    const trips = filterIgnoredTrips(allTrips, [], ['daniel']);
    const segments = buildTimezoneSegments(trips, allFlights);
    assert.equal(segments.length, 1);
    assert.ok(segments[0].label.includes('Berlin'));
    assert.equal(segments[0].timezone, 'Europe/Berlin');
  });

  it('ignored trip is excluded from future OOO candidates', () => {
    const trips = filterIgnoredTrips(allTrips, [], ['daniel']);
    const futureTrips = filterFutureTrips(trips);
    assert.equal(futureTrips.length, 1);
    assert.equal(futureTrips[0].summary, 'Work trip to Berlin');
  });

  it('all trips produce segments when nothing is ignored', () => {
    const trips = filterIgnoredTrips(allTrips, [], []);
    const segments = buildTimezoneSegments(trips, allFlights);
    assert.equal(segments.length, 2);
    assert.ok(segments.some(s => s.label.includes('Berlin')));
    assert.ok(segments.some(s => s.label.includes('London')));
  });
});

// ── filterFutureTrips ──

describe('filterFutureTrips', () => {
  it('returns future trips with formatted dates', () => {
    const trips = [
      { summary: 'Future Trip', startDate: new Date('2099-06-01'), endDate: new Date('2099-06-10'), location: 'Paris' },
    ];
    const result = filterFutureTrips(trips);
    assert.equal(result.length, 1);
    assert.equal(result[0].summary, 'Future Trip');
    assert.equal(result[0].startDate, '2099-06-01');
    assert.equal(result[0].endDate, '2099-06-10');
  });

  it('filters out past trips', () => {
    const trips = [
      { summary: 'Past Trip', startDate: new Date('2020-01-01'), endDate: new Date('2020-01-10'), location: 'London' },
      { summary: 'Future Trip', startDate: new Date('2099-06-01'), endDate: new Date('2099-06-10'), location: 'Paris' },
    ];
    const result = filterFutureTrips(trips);
    assert.equal(result.length, 1);
    assert.equal(result[0].summary, 'Future Trip');
  });

  it('returns empty array when no future trips', () => {
    const trips = [
      { summary: 'Old Trip', startDate: new Date('2020-01-01'), endDate: new Date('2020-01-10'), location: 'London' },
    ];
    const result = filterFutureTrips(trips);
    assert.equal(result.length, 0);
  });

  it('includes trips ending today', () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    const trips = [
      { summary: 'Ending Today', startDate: yesterday, endDate: today, location: 'Berlin' },
    ];
    const result = filterFutureTrips(trips);
    assert.equal(result.length, 1);
    assert.equal(result[0].summary, 'Ending Today');
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
