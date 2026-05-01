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

// Country/city patterns to disambiguate TZ abbreviations that map to multiple IANA zones
const COUNTRY_TZ_OVERRIDES = {
  CST: [
    { pattern: /\bCosta Rica\b/i, tz: 'America/Costa_Rica' },
    { pattern: /\bMexico\b/i, tz: 'America/Mexico_City' },
    { pattern: /\bChina\b|Beijing|Shanghai|Shenzhen|Guangzhou/i, tz: 'Asia/Shanghai' },
  ],
  IST: [
    { pattern: /\bIndia\b|Mumbai|Delhi|Bangalore|Chennai|Kolkata|Hyderabad/i, tz: 'Asia/Kolkata' },
    { pattern: /\bIsrael\b|Jerusalem|Tel Aviv/i, tz: 'Asia/Jerusalem' },
  ],
  EST: [
    { pattern: /\bPanama\b/i, tz: 'America/Panama' },
  ],
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

  // Dedup multiple-room bookings (same hotel, same time, different UIDs)
  const dedupBy = (arr) => {
    const seen = new Set();
    return arr.filter(e => {
      const key = `${e.hotelName}|${e.date.getTime()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const uniqueCheckins = dedupBy(checkins);
  const uniqueCheckouts = dedupBy(checkouts);

  // Pair check-ins with check-outs by name + date proximity
  const stays = [];
  const usedCheckoutIndices = new Set();

  for (const ci of uniqueCheckins) {
    let bestIdx = -1;
    let bestDate = null;
    for (let i = 0; i < uniqueCheckouts.length; i++) {
      if (usedCheckoutIndices.has(i)) continue;
      const co = uniqueCheckouts[i];
      if (co.hotelName !== ci.hotelName) continue;
      if (co.date < ci.date) continue;
      if (bestIdx === -1 || co.date < bestDate) {
        bestIdx = i;
        bestDate = co.date;
      }
    }

    const co = bestIdx >= 0 ? uniqueCheckouts[bestIdx] : null;
    if (co) usedCheckoutIndices.add(bestIdx);

    const location = ci.location || (co && co.location) || '';
    const tz = resolveAbbreviation(ci.tzAbbr, location) || resolveFromGeo(ci.geo)
      || (co && (resolveAbbreviation(co.tzAbbr, location) || resolveFromGeo(co.geo)));

    stays.push({
      hotelName: ci.hotelName,
      checkinDate: ci.date,
      checkoutDate: co ? co.date : null,
      timezone: tz,
      location,
    });
  }

  // Capture unmatched check-outs
  for (let i = 0; i < uniqueCheckouts.length; i++) {
    if (usedCheckoutIndices.has(i)) continue;
    const co = uniqueCheckouts[i];
    const tz = resolveAbbreviation(co.tzAbbr, co.location) || resolveFromGeo(co.geo);
    stays.push({
      hotelName: co.hotelName,
      checkinDate: null,
      checkoutDate: co.date,
      timezone: tz,
      location: co.location || '',
    });
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
 * Lodging is the primary signal: where you sleep is your timezone. Flights
 * fill three gap kinds — pre-first-checkin (outbound journey), between-stay
 * (when a hotel is missing in the middle of a trip), and post-last-checkout
 * (return flight). TripIt feeds often include companion-traveler flights to
 * different destinations that can't be distinguished structurally from the
 * user's own, so flight-driven segmentation is unreliable when lodging exists.
 *
 * Priority:
 * 1. Lodging — drives the timeline when present
 * 2. Flights — fall back to flight-driven segments when there's no lodging
 * 3. Trip-level GEO — last-resort fallback
 *
 * Returns flat array of { startDate, endDate, timezone, label }.
 */
export function buildTimezoneSegments(trips, flights, stays = []) {
  const segments = [];

  for (const trip of trips) {
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
    }).filter(s => s.timezone);

    if (tripStays.length > 0) {
      buildLodgingPrimarySegments(trip, tripFlights, tripStays, segments);
    } else if (tripFlights.length > 0) {
      buildFlightOnlySegments(trip, tripFlights, segments);
    } else {
      // No flights, no lodging — trip-level GEO
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
 * Lodging-primary build: lodging defines segments, flights fill three gap
 * kinds — pre-first-checkin, between-stay (missing-hotel windows in the
 * middle of a trip), and post-last-checkout.
 */
function buildLodgingPrimarySegments(trip, tripFlights, tripStays, segments) {
  const sortedStays = [...tripStays].sort((a, b) =>
    (a.checkinDate || a.checkoutDate) - (b.checkinDate || b.checkoutDate)
  );

  // Pre-lodging gap: flights arriving before the first check-in are the
  // outbound journey. Anchor on the earliest known check-in — using an
  // unmatched checkout's date instead would mis-classify flights that
  // occurred during the lodging as pre-lodging. Skip this section entirely
  // when no check-in is known.
  const firstCheckinDate = sortedStays.find(s => s.checkinDate)?.checkinDate;
  if (firstCheckinDate) {
    const preLodgingFlights = tripFlights.filter(f =>
      f.arrivalDate.getTime() <= firstCheckinDate.getTime()
    );

    for (let i = 0; i < preLodgingFlights.length; i++) {
      const flight = preLodgingFlights[i];
      const tz = resolveAbbreviation(flight.tzAbbr);
      if (!tz) {
        console.log(`  WARNING: Unknown TZ abbreviation "${flight.tzAbbr}" for ${flight.arrivalCity}`);
        continue;
      }

      const segStart = i === 0
        ? new Date(Math.max(trip.startDate.getTime(), flight.arrivalDate.getTime()))
        : flight.arrivalDate;
      const segEnd = i < preLodgingFlights.length - 1
        ? preLodgingFlights[i + 1].arrivalDate
        : firstCheckinDate;

      segments.push({
        startDate: formatDate(segStart),
        endDate: formatDate(segEnd),
        timezone: tz,
        label: `${trip.summary} - ${flight.arrivalCity}`,
      });
    }
  }

  // Lodging segments
  buildLodgingSegments(sortedStays, trip.startDate, trip.endDate, trip.summary, segments);

  // Between-stay flight gap-fill: when consecutive lodgings have a multi-day
  // gap (user moved on but TripIt has no hotel for some nights), flights in
  // that window indicate where they actually were. Without this, the previous
  // stay's timezone bleeds forward to the next check-in. Dedup later clips
  // any overlap with the lodging segments themselves.
  for (let i = 0; i < sortedStays.length - 1; i++) {
    const stay = sortedStays[i];
    const nextStay = sortedStays[i + 1];
    const checkout = stay.checkoutDate;
    const nextCheckin = nextStay.checkinDate || nextStay.checkoutDate;
    if (!checkout) continue;
    if (checkout.getTime() >= nextCheckin.getTime()) continue;

    const gapFlights = tripFlights.filter(f => {
      const t = f.arrivalDate.getTime();
      return t >= checkout.getTime() && t <= nextCheckin.getTime();
    });
    if (gapFlights.length === 0) continue;

    for (let j = 0; j < gapFlights.length; j++) {
      const flight = gapFlights[j];
      const tz = resolveAbbreviation(flight.tzAbbr);
      if (!tz) {
        console.log(`  WARNING: Unknown TZ abbreviation "${flight.tzAbbr}" for ${flight.arrivalCity}`);
        continue;
      }

      const segStart = flight.arrivalDate;
      const segEnd = j < gapFlights.length - 1
        ? gapFlights[j + 1].arrivalDate
        : nextCheckin;

      segments.push({
        startDate: formatDate(segStart),
        endDate: formatDate(segEnd),
        timezone: tz,
        label: `${trip.summary} - ${flight.arrivalCity}`,
      });
    }
  }

  // Post-lodging gap: if there's a flight after the last checkout, the
  // chronologically-last such flight is where the traveler ends up (e.g.,
  // the return-home red-eye on the last trip day).
  const lastStay = sortedStays[sortedStays.length - 1];
  const lastStayCheckout = lastStay.checkoutDate;
  if (lastStayCheckout && lastStayCheckout.getTime() < trip.endDate.getTime()) {
    const postLodgingFlights = tripFlights.filter(f => {
      const t = f.arrivalDate.getTime();
      return t >= lastStayCheckout.getTime() && t <= trip.endDate.getTime();
    });
    if (postLodgingFlights.length > 0) {
      const finalFlight = postLodgingFlights[postLodgingFlights.length - 1];
      const tz = resolveAbbreviation(finalFlight.tzAbbr);
      if (tz) {
        segments.push({
          startDate: formatDate(finalFlight.arrivalDate),
          endDate: formatDate(trip.endDate),
          timezone: tz,
          label: `${trip.summary} - ${finalFlight.arrivalCity}`,
        });
      } else {
        console.log(`  WARNING: Unknown TZ abbreviation "${finalFlight.tzAbbr}" for ${finalFlight.arrivalCity}`);
      }
    }
  }
}

/**
 * Flight-only build: no lodging available, so flights define the timeline.
 * Used for transit-only trips or trips where TripIt has no hotel data.
 */
function buildFlightOnlySegments(trip, tripFlights, segments) {
  for (let i = 0; i < tripFlights.length; i++) {
    const flight = tripFlights[i];
    const tz = resolveAbbreviation(flight.tzAbbr);
    if (!tz) {
      console.log(`  WARNING: Unknown TZ abbreviation "${flight.tzAbbr}" for ${flight.arrivalCity}`);
      continue;
    }

    const segStart = i === 0
      ? new Date(Math.max(trip.startDate.getTime(), flight.arrivalDate.getTime()))
      : flight.arrivalDate;
    const segEnd = i < tripFlights.length - 1
      ? tripFlights[i + 1].arrivalDate
      : trip.endDate;

    segments.push({
      startDate: formatDate(segStart),
      endDate: formatDate(segEnd),
      timezone: tz,
      label: `${trip.summary} - ${flight.arrivalCity}`,
    });
  }
}

/**
 * Build timezone segments from lodging stays within a date range. Stays must
 * already be sorted by check-in/checkout date; the only caller does this so
 * we don't pay for the sort twice.
 * Each stay's check-in starts a segment; it ends at the next stay's check-in or rangeEnd.
 */
function buildLodgingSegments(stays, rangeStart, rangeEnd, tripSummary, segments) {
  for (let i = 0; i < stays.length; i++) {
    const stay = stays[i];
    const segStart = stay.checkinDate || rangeStart;
    const segEnd = i < stays.length - 1
      ? (stays[i + 1].checkinDate || stays[i + 1].checkoutDate)
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
 * For ambiguous abbreviations (CST, IST, EST), uses the location string
 * to disambiguate by country/city when possible.
 */
function resolveAbbreviation(abbr, location = '') {
  if (!abbr) return null;

  const overrides = COUNTRY_TZ_OVERRIDES[abbr];
  if (overrides && location) {
    for (const { pattern, tz } of overrides) {
      if (pattern.test(location)) return tz;
    }
  }

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
 * Filter out trips whose name matches any of the ignore patterns or keywords.
 * Both lists are case-insensitive substring matches against trip.summary.
 */
export function filterIgnoredTrips(trips, ignoreTrips = [], ignoreKeywords = []) {
  if (ignoreTrips.length === 0 && ignoreKeywords.length === 0) return trips;

  const lowerTrips = ignoreTrips.map(s => s.toLowerCase());
  const lowerKeywords = ignoreKeywords.map(s => s.toLowerCase());

  return trips.filter(t => {
    const name = t.summary.toLowerCase();
    if (lowerTrips.some(pattern => name.includes(pattern))) return false;
    if (lowerKeywords.some(kw => name.includes(kw))) return false;
    return true;
  });
}

/**
 * Filter trips to future only (endDate >= today).
 * Returns trips with YYYY-MM-DD formatted dates.
 */
export function filterFutureTrips(trips) {
  const today = new Date().toISOString().slice(0, 10);

  return trips
    .filter(t => formatDate(t.endDate) >= today)
    .map(t => ({
      summary: t.summary,
      startDate: formatDate(t.startDate),
      endDate: formatDate(t.endDate),
    }));
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
 * Then clips overlapping segments with different timezones so that
 * later segments take priority (the traveler is in the new timezone).
 */
export function deduplicateSegments(segments) {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const result = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1];
    const curr = sorted[i];

    if (prev.timezone === curr.timezone && prev.endDate >= curr.startDate) {
      prev.endDate = curr.endDate > prev.endDate ? curr.endDate : prev.endDate;
      prev.label += ` + ${curr.label}`;
    } else {
      // Clip previous segment if it overlaps with the current one
      if (prev.endDate > curr.startDate) {
        prev.endDate = curr.startDate;
      }
      result.push({ ...curr });
    }
  }

  // Remove segments that were clipped to zero or negative duration
  return result.filter(s => s.startDate < s.endDate);
}
