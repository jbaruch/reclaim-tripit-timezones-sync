import ical from 'node-ical';
import { find as findTz } from 'geo-tz';

// TZ abbreviation → IANA timezone mapping
// When an abbreviation is ambiguous, we pick the most common traveler destination
const TZ_ABBR_TO_IANA = {
  // North America
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  AST: 'America/Puerto_Rico',

  // Europe
  GMT: 'Europe/London',
  BST: 'Europe/London',
  WET: 'Europe/Lisbon',
  WEST: 'Europe/Lisbon',
  CET: 'Europe/Berlin',
  CEST: 'Europe/Berlin',
  EET: 'Europe/Bucharest',
  EEST: 'Europe/Bucharest',
  IST: 'Europe/Dublin',  // Irish Standard Time (ambiguous with India)
  MSK: 'Europe/Moscow',
  TRT: 'Europe/Istanbul',

  // Asia
  JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul',
  CST_ASIA: 'Asia/Shanghai',  // Chinese Standard Time — handled specially
  HKT: 'Asia/Hong_Kong',
  SGT: 'Asia/Singapore',
  ICT: 'Asia/Bangkok',
  WIB: 'Asia/Jakarta',
  IST_INDIA: 'Asia/Kolkata',  // handled specially
  PKT: 'Asia/Karachi',
  GST: 'Asia/Dubai',
  IRST: 'Asia/Tehran',

  // Oceania
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
  ACST: 'Australia/Adelaide',
  ACDT: 'Australia/Adelaide',
  AWST: 'Australia/Perth',
  NZST: 'Pacific/Auckland',
  NZDT: 'Pacific/Auckland',

  // South America
  BRT: 'America/Sao_Paulo',
  BRST: 'America/Sao_Paulo',
  ART: 'America/Argentina/Buenos_Aires',
  CLT: 'America/Santiago',
  CLST: 'America/Santiago',
  COT: 'America/Bogota',
  PET: 'America/Lima',

  // Africa
  WAT: 'Africa/Lagos',
  CAT: 'Africa/Harare',
  EAT: 'Africa/Nairobi',
  SAST: 'Africa/Johannesburg',
};

/**
 * Fetch and parse the TripIt iCal feed.
 * Returns all VEVENT entries.
 */
export async function fetchIcalEvents(icalUrl) {
  console.log('Fetching TripIt iCal feed...');
  const data = await ical.async.fromURL(icalUrl);
  const events = Object.values(data).filter(e => e.type === 'VEVENT');
  console.log(`  Found ${events.length} VEVENT(s)`);
  return events;
}

/**
 * Identify trip-level events (all-day events with DTSTART as DATE, not DATETIME).
 * These have LOCATION and GEO properties.
 */
export function extractTrips(events) {
  const trips = [];

  for (const ev of events) {
    // All-day trip events have DTSTART as a date string (no time component)
    // node-ical sets dateOnly=true or the value is a bare Date at midnight
    const start = ev.start;
    const end = ev.end;
    if (!start || !end) continue;

    // Check if this is an all-day event (trip-level)
    // node-ical: all-day events have start.dateOnly === true or the ical param VALUE=DATE
    const isAllDay = start.dateOnly === true
      || (ev.datetype === 'date')
      || (typeof start === 'string' && /^\d{4}-?\d{2}-?\d{2}$/.test(start));

    if (!isAllDay) continue;

    const startDate = normalizeDate(start);
    const endDate = normalizeDate(end);

    trips.push({
      summary: ev.summary || '',
      location: ev.location || '',
      geo: ev.geo || null,
      startDate,
      endDate,
      uid: ev.uid || '',
    });
  }

  console.log(`  Identified ${trips.length} trip-level event(s)`);
  return trips;
}

/**
 * Extract lodging (hotel/stay) events from iCal feed.
 * TripIt emits both check-in ("[Lodging] Arrive") and check-out ("[Lodging] Depart") events.
 * We pair them by hotel name to get check-in/check-out date ranges with timezone info.
 * Returns stays sorted by check-in date.
 */
export function extractLodging(events) {
  const checkins = [];
  const checkouts = [];

  for (const ev of events) {
    const start = ev.start;
    if (!start) continue;
    if (start.dateOnly === true || ev.datetype === 'date') continue;

    const desc = ev.description || '';
    const summary = ev.summary || '';

    const isCheckin = desc.includes('[Lodging] Arrive') || summary.startsWith('Check-in:');
    const isCheckout = desc.includes('[Lodging] Depart') || summary.startsWith('Check-out:');
    if (!isCheckin && !isCheckout) continue;

    // Extract hotel name from summary (strip "Check-in: " or "Check-out: " prefix)
    const hotelName = summary.replace(/^Check-(?:in|out):\s*/i, '').trim();

    // Extract timezone abbreviation from description (e.g. "3:00 PM MDT")
    const tzMatch = desc.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s+([A-Z]{2,5})/i);
    const tzAbbr = tzMatch ? tzMatch[2].toUpperCase() : null;

    const entry = {
      hotelName,
      date: new Date(start),
      tzAbbr,
      geo: ev.geo || null,
      location: ev.location || '',
      uid: ev.uid || '',
    };

    if (isCheckin) checkins.push(entry);
    else checkouts.push(entry);
  }

  // Pair check-ins with check-outs by hotel name
  const stays = [];
  for (const ci of checkins) {
    const co = checkouts.find(co => co.hotelName === ci.hotelName);
    const tz = resolveAbbreviation(ci.tzAbbr) || resolveFromGeo(ci.geo)
      || (co && (resolveAbbreviation(co.tzAbbr) || resolveFromGeo(co.geo)));

    stays.push({
      hotelName: ci.hotelName,
      checkinDate: ci.date,
      checkoutDate: co ? co.date : null,
      timezone: tz,
      location: ci.location || (co && co.location) || '',
    });
  }

  // Also capture check-outs that have no matching check-in
  for (const co of checkouts) {
    if (!checkins.some(ci => ci.hotelName === co.hotelName)) {
      const tz = resolveAbbreviation(co.tzAbbr) || resolveFromGeo(co.geo);
      stays.push({
        hotelName: co.hotelName,
        checkinDate: null,
        checkoutDate: co.date,
        timezone: tz,
        location: co.location || '',
      });
    }
  }

  stays.sort((a, b) => (a.checkinDate || a.checkoutDate) - (b.checkinDate || b.checkoutDate));
  console.log(`  Found ${stays.length} lodging stay(s)`);
  return stays;
}

/**
 * Extract flight events (non-all-day events with arrival info in DESCRIPTION).
 * Returns them sorted by start time.
 */
export function extractFlights(events) {
  const flights = [];

  for (const ev of events) {
    const start = ev.start;
    if (!start) continue;

    // Skip all-day events
    if (start.dateOnly === true || ev.datetype === 'date') continue;

    const desc = ev.description || '';
    // Look for arrival pattern: "HH:MM AM/PM TZ\nArrive City (CODE)"
    const arrivalMatch = desc.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s+([A-Z]{2,5})\s*\n\s*Arrive\s+(.+)/i);
    if (!arrivalMatch) continue;

    const [, arrivalTime, tzAbbr, arrivalCity] = arrivalMatch;
    const arrivalDate = new Date(start);

    flights.push({
      summary: ev.summary || '',
      arrivalDate,
      arrivalTime,
      tzAbbr: tzAbbr.toUpperCase(),
      arrivalCity: arrivalCity.replace(/\s*\(.*\)/, '').trim(),
      arrivalCityCode: (arrivalCity.match(/\(([A-Z]{3})\)/) || [])[1] || '',
      description: desc,
      uid: ev.uid || '',
    });
  }

  flights.sort((a, b) => a.arrivalDate - b.arrivalDate);
  console.log(`  Found ${flights.length} flight arrival(s)`);
  return flights;
}

/**
 * Build timezone segments for each trip.
 *
 * Priority for determining timezones:
 * 1. Flights — arrival timezone is explicit in the iCal description
 * 2. Lodging — check-in events have TZ abbreviations and/or GEO coordinates
 * 3. Trip-level GEO — fallback using the trip's coordinates
 *
 * For trips with flights, lodging fills gaps between the last flight and trip end.
 * For trips without flights, lodging stays define the segments directly.
 *
 * Returns flat array of { startDate, endDate, timezone, label }.
 */
export function buildTimezoneSegments(trips, flights, stays = []) {
  const segments = [];

  for (const trip of trips) {
    // Find flights for this trip (arrival within trip date range, with 1-day buffer)
    const tripStart = trip.startDate;
    const tripEnd = trip.endDate;
    const buffer = 24 * 60 * 60 * 1000; // 1 day

    const tripFlights = flights.filter(f => {
      const t = f.arrivalDate.getTime();
      return t >= tripStart.getTime() - buffer && t <= tripEnd.getTime() + buffer;
    });

    const tripStays = stays.filter(s => {
      const t = (s.checkinDate || s.checkoutDate).getTime();
      return t >= tripStart.getTime() - buffer && t <= tripEnd.getTime() + buffer;
    });

    if (tripFlights.length > 0) {
      // Find lodging stays after the last flight for gap-filling.
      // Compare by calendar date, not exact timestamp, because hotel check-in
      // times are often defaults (midnight, 3pm) that don't match actual arrival.
      const lastFlight = tripFlights[tripFlights.length - 1];
      const lastFlightDate = formatDate(lastFlight.arrivalDate);
      const staysAfterLastFlight = tripStays.filter(s => {
        const stayDate = formatDate(s.checkinDate || s.checkoutDate);
        return stayDate >= lastFlightDate && s.timezone;
      }).sort((a, b) => (a.checkinDate || a.checkoutDate) - (b.checkinDate || b.checkoutDate));

      // Build segments from flight arrivals
      for (let i = 0; i < tripFlights.length; i++) {
        const flight = tripFlights[i];
        const tz = resolveAbbreviation(flight.tzAbbr);
        if (!tz) {
          console.log(`  WARNING: Unknown TZ abbreviation "${flight.tzAbbr}" for ${flight.arrivalCity}`);
          continue;
        }

        const segStart = i === 0
          ? new Date(Math.max(tripStart.getTime(), flight.arrivalDate.getTime()))
          : flight.arrivalDate;

        let segEnd;
        if (i < tripFlights.length - 1) {
          segEnd = tripFlights[i + 1].arrivalDate;
        } else if (staysAfterLastFlight.length > 0) {
          // Last flight segment ends at the first post-flight lodging check-in
          segEnd = staysAfterLastFlight[0].checkinDate || staysAfterLastFlight[0].checkoutDate;
        } else {
          segEnd = tripEnd;
        }

        // Use trip start if the first flight is on or before trip start
        const effectiveStart = i === 0 && flight.arrivalDate <= tripStart
          ? tripStart
          : segStart;

        segments.push({
          startDate: formatDate(effectiveStart),
          endDate: formatDate(segEnd),
          timezone: tz,
          label: `${trip.summary} - ${flight.arrivalCity}`,
        });
      }

      // Fill gap after last flight with lodging stays
      buildLodgingSegments(staysAfterLastFlight, lastFlight.arrivalDate, tripEnd, trip.summary, segments);
    } else if (tripStays.length > 0) {
      // No flights — build segments entirely from lodging
      const staysWithTz = tripStays.filter(s => s.timezone);
      buildLodgingSegments(staysWithTz, tripStart, tripEnd, trip.summary, segments);
    } else {
      // Fallback: use GEO coordinates
      const tz = resolveFromGeo(trip.geo);
      if (tz) {
        segments.push({
          startDate: formatDate(tripStart),
          endDate: formatDate(tripEnd),
          timezone: tz,
          label: `${trip.summary} - ${trip.location}`,
        });
      } else {
        console.log(`  WARNING: No flights, lodging, or GEO for trip "${trip.summary}" (${trip.location})`);
      }
    }
  }

  return segments;
}

/**
 * Build timezone segments from lodging stays within a date range.
 * Each stay's check-in starts a segment; it ends at the next stay's check-in or rangeEnd.
 */
function buildLodgingSegments(stays, rangeStart, rangeEnd, tripSummary, segments) {
  if (stays.length === 0) return;

  const sorted = [...stays].sort((a, b) =>
    (a.checkinDate || a.checkoutDate) - (b.checkinDate || b.checkoutDate)
  );

  for (let i = 0; i < sorted.length; i++) {
    const stay = sorted[i];
    const segStart = stay.checkinDate || rangeStart;
    const segEnd = i < sorted.length - 1
      ? (sorted[i + 1].checkinDate || sorted[i + 1].checkoutDate)
      : (stay.checkoutDate || rangeEnd);

    segments.push({
      startDate: formatDate(segStart),
      endDate: formatDate(segEnd),
      timezone: stay.timezone,
      label: `${tripSummary} - ${stay.hotelName}`,
    });
  }
}

/**
 * Map a TZ abbreviation to an IANA timezone string.
 */
function resolveAbbreviation(abbr) {
  return TZ_ABBR_TO_IANA[abbr] || null;
}

/**
 * Resolve timezone from GEO coordinates using geo-tz.
 */
function resolveFromGeo(geo) {
  if (!geo || geo.lat == null || geo.lon == null) return null;
  const results = findTz(parseFloat(geo.lat), parseFloat(geo.lon));
  return results && results.length > 0 ? results[0] : null;
}

/**
 * Normalize a date value from node-ical into a JS Date.
 */
function normalizeDate(val) {
  if (val instanceof Date) return val;
  if (typeof val === 'string') return new Date(val);
  return new Date(val);
}

/**
 * Format a Date as YYYY-MM-DD string for the Reclaim API.
 */
function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

/**
 * Filter segments to future only, lasting > 1 day.
 */
export function filterFutureSegments(segments) {
  const today = new Date().toISOString().slice(0, 10);

  return segments.filter(s => {
    if (s.endDate < today) return false;
    const start = new Date(s.startDate);
    const end = new Date(s.endDate);
    const days = (end - start) / (24 * 60 * 60 * 1000);
    return days >= 1;
  });
}

/**
 * Deduplicate consecutive segments with the same timezone.
 * Merges date ranges when adjacent segments share a timezone.
 */
export function deduplicateSegments(segments) {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const result = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1];
    const curr = sorted[i];

    if (prev.timezone === curr.timezone) {
      prev.endDate = curr.endDate > prev.endDate ? curr.endDate : prev.endDate;
      prev.label += ` + ${curr.label}`;
    } else {
      result.push({ ...curr });
    }
  }

  return result;
}
