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
 * Parse the TripIt trip ID from an event description. Trip-level events
 * use `tripit.com/trip/show?id=<n>`; flight and lodging events use
 * `tripit.com/trip/show/id/<n>`. Returns the numeric ID as a string, or
 * null if the description doesn't contain one.
 */
function parseTripId(description) {
  if (!description) return null;
  const m = description.match(/tripit\.com\/trip\/show(?:\?id=|\/id\/)(\d+)/);
  return m ? m[1] : null;
}

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
      tripId: parseTripId(ev.description),
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
      tripId: parseTripId(desc),
    };

    if (isCheckin) checkins.push(entry);
    else checkouts.push(entry);
  }

  // Dedup multiple-room bookings (same hotel, same time, different UIDs).
  // Two events for the same booking with a one-sided missing tripId must
  // still collapse (one parsed the URL, the other didn't); two events
  // from DIFFERENT trips at the same hotel/time must NOT collapse. The
  // rule: collapse when (a) both lack tripId, (b) only one has tripId,
  // or (c) both have the same tripId. Split only when both have tripIds
  // that differ. Prefer the tripId-bearing copy on collapse.
  const dedupBy = (arr) => {
    const result = [];
    for (const e of arr) {
      let merged = false;
      for (let i = 0; i < result.length; i++) {
        const r = result[i];
        if (r.hotelName !== e.hotelName) continue;
        if (r.date.getTime() !== e.date.getTime()) continue;
        if (r.tripId && e.tripId && r.tripId !== e.tripId) continue;
        if (!r.tripId && e.tripId) result[i] = e;
        merged = true;
        break;
      }
      if (!merged) result.push(e);
    }
    return result;
  };
  const uniqueCheckins = dedupBy(checkins);
  const uniqueCheckouts = dedupBy(checkouts);

  // Pair check-ins with check-outs by name + date proximity
  const stays = [];
  const usedCheckoutIndices = new Set();

  for (const ci of uniqueCheckins) {
    // Two-pass pairing:
    //   Pass 1: both sides MUST carry matching tripIds. Same-trip pairs win.
    //   Pass 2: both sides must be missing tripId — pure name+date pairing
    //     for legacy/URL-less iCal events. NEVER pair a side with an ID
    //     against a side without one — a URL-less checkin paired with an
    //     ID'd checkout would re-introduce cross-trip pairing.
    let bestIdx = -1;
    let bestDate = null;
    const tryMatch = (mode) => {
      for (let i = 0; i < uniqueCheckouts.length; i++) {
        if (usedCheckoutIndices.has(i)) continue;
        const co = uniqueCheckouts[i];
        if (co.hotelName !== ci.hotelName) continue;
        if (co.date < ci.date) continue;
        if (mode === 'sameId') {
          if (!ci.tripId || !co.tripId) continue;
          if (ci.tripId !== co.tripId) continue;
        } else {
          // 'bothMissing'
          if (ci.tripId || co.tripId) continue;
        }
        if (bestIdx === -1 || co.date < bestDate) {
          bestIdx = i;
          bestDate = co.date;
        }
      }
    };
    tryMatch('sameId');
    if (bestIdx === -1) tryMatch('bothMissing');

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
      tripId: ci.tripId || (co && co.tripId) || null,
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
      tripId: co.tripId,
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
      tripId: parseTripId(desc),
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

    // Trip-ID is the authoritative association. `extractTrips`,
    // `extractFlights`, and `extractLodging` all parse the trip ID out
    // of the iCal event description. When trip IDs are present on both
    // sides we filter strictly by ID and never need date heuristics —
    // carry-over hotels, adjacent-trip flights, east/west-of-UTC
    // boundary cases, and unmatched-checkout orphans are all attributed
    // unambiguously by TripIt itself.
    //
    // Date-overlap is the fallback for records without a tripId (older
    // test fixtures, or rare iCal events whose description didn't match
    // the URL pattern).
    // Fallback buffers used only when either trip or record lacks a
    // tripId. Symmetric 24h on both sides handles east-of-UTC first-day
    // arrivals (lower) and west-of-UTC last-day arrivals (upper). Trip-ID
    // matching is the source of truth in production, so this fallback
    // can be lenient without re-introducing adjacent-trip bleed (different
    // tripIds skip the buffered overlap path entirely).
    const FALLBACK_LOWER_BUFFER_MS = 24 * 60 * 60 * 1000;
    const FALLBACK_UPPER_BUFFER_MS = 24 * 60 * 60 * 1000;
    const matchesTrip = (rec, recStart, recEnd) => {
      // When the trip itself has a parsed tripId, it's authoritative —
      // records without a matching tripId belong to a different trip
      // (or are unparseable noise). Excluding them prevents adjacent-trip
      // bleed when a record's date window happens to overlap but no URL
      // could be parsed.
      if (trip.tripId) return rec.tripId === trip.tripId;
      // Trip has no parsed tripId (URL parsing failed on the trip-level
      // event). Fall back to date-window overlap regardless of whether
      // the record has an ID — otherwise an unparseable trip event would
      // orphan all of its child records, even ones with valid IDs.
      return recStart <= tripEnd.getTime() + FALLBACK_UPPER_BUFFER_MS
        && recEnd >= tripStart.getTime() - FALLBACK_LOWER_BUFFER_MS;
    };

    const tripFlights = flights.filter(f => {
      const t = f.arrivalDate.getTime();
      return matchesTrip(f, t, t);
    });

    const tripStays = stays.filter(s => {
      const stayStart = (s.checkinDate || s.checkoutDate).getTime();
      const stayEnd = (s.checkoutDate || s.checkinDate).getTime();
      return matchesTrip(s, stayStart, stayEnd);
    });

    let produced = false;
    const isUseful = (s) => s.startDate < s.endDate;
    const anyResolvedStay = tripStays.some(s => s.timezone);
    const tripGeoTz = resolveFromGeo(trip.geo);
    // Path selection: lodging-primary requires either a resolved stay or a
    // GEO fallback to cover the stay window. Without either, fall through
    // to flight-only so the trip still gets coverage from flight arrivals
    // (instead of an uncovered stay window in the middle of the trip).
    if (anyResolvedStay || (tripStays.length > 0 && tripGeoTz)) {
      const before = segments.length;
      buildLodgingPrimarySegments(trip, tripFlights, tripStays, segments);
      produced = segments.slice(before).some(isUseful);
    } else if (tripFlights.length > 0) {
      const before = segments.length;
      buildFlightOnlySegments(trip, tripFlights, segments);
      produced = segments.slice(before).some(isUseful);
    }

    // GEO fallback in two shapes:
    //   1. Nothing emitted at all → cover the entire trip window.
    //   2. Lodging-primary emitted, but at least one stay was TZ-less →
    //      cover ONLY the stay window (earliest checkin to latest
    //      checkout). Bounding to the stay window prevents the GEO
    //      segment from clipping pre/post-lodging flight segments at
    //      the trip edges (which start/end on the same calendar day).
    //      Dedup later clips the GEO segment against any resolved
    //      lodging segments inside the stay window, leaving GEO only
    //      where coverage is otherwise missing.
    const allStaysResolved = tripStays.length > 0 && tripStays.every(s => s.timezone);

    if (!produced) {
      if (tripGeoTz) {
        segments.push({
          startDate: formatDate(tripStart),
          endDate: formatDate(tripEnd),
          timezone: tripGeoTz,
          label: `${trip.summary} - ${trip.location}`,
        });
      } else {
        // No segment at all for this trip — neither lodging-primary nor
        // flight-only nor GEO produced anything. Distinguish the "no data"
        // case from the "had data but couldn't resolve" case so the log
        // signal points at the right diagnosis.
        if (tripStays.length === 0 && tripFlights.length === 0) {
          console.log(`  WARNING: No flights, lodging, or GEO for trip "${trip.summary}" (${trip.location})`);
        } else {
          console.log(`  WARNING: Trip "${trip.summary}" (${trip.location}) had ${tripFlights.length} flight(s) and ${tripStays.length} stay(s) but no resolvable timezone — check TZ abbreviations and GEO data`);
        }
      }
    } else if (tripStays.length > 0 && !allStaysResolved) {
      // Bound GEO to the stay window. Single-sided stays extend the
      // missing side to the trip boundary so the segment has positive
      // duration. Both sides clamped to [tripStart, tripEnd] so a
      // fallback-attributed adjacent-trip stay (no tripId) can't push
      // the GEO segment outside the trip window.
      // Derive the GEO window from stay boundaries. For single-sided
      // unresolved stays (only checkin OR only checkout), extend the
      // missing side to the trip boundary so the window has positive
      // duration AND covers the open-ended portion. Using only
      // observed timestamps would leave a single-sided open-ended stay
      // with a zero-or-near-zero window even when other segments
      // already exist.
      const allCheckins = tripStays.filter(s => s.checkinDate).map(s => s.checkinDate.getTime());
      const allCheckouts = tripStays.filter(s => s.checkoutDate).map(s => s.checkoutDate.getTime());
      const allBoundaries = [...allCheckins, ...allCheckouts];
      const tripStartMs = tripStart.getTime();
      const tripEndMs = tripEnd.getTime();
      // stayStart: earliest boundary of any kind (so a leading
      // checkout-only orphan still anchors the start).
      const stayStart = allBoundaries.length > 0 ? Math.min(...allBoundaries) : tripStartMs;
      // stayEnd: latest known checkout, OR (when an open-ended stay
      // exists whose checkin is past the latest checkout) extend to
      // trip end so the open-ended stay's trailing days are covered.
      const latestCheckin = allCheckins.length > 0 ? Math.max(...allCheckins) : 0;
      const latestCheckout = allCheckouts.length > 0 ? Math.max(...allCheckouts) : 0;
      const hasOpenEndedStay = tripStays.some(s => s.checkinDate && !s.checkoutDate);
      const stayEnd = hasOpenEndedStay && latestCheckin > latestCheckout
        ? tripEndMs
        : (allCheckouts.length > 0 ? latestCheckout : tripEndMs);
      const clampedStart = Math.max(tripStartMs, Math.min(stayStart, tripEndMs));
      const clampedEnd = Math.max(tripStartMs, Math.min(stayEnd, tripEndMs));
      if (clampedStart < clampedEnd && tripGeoTz) {
        segments.push({
          startDate: formatDate(new Date(clampedStart)),
          endDate: formatDate(new Date(clampedEnd)),
          timezone: tripGeoTz,
          label: `${trip.summary} - ${trip.location}`,
        });
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
  const tripStartMs = trip.startDate.getTime();
  const tripEndMs = trip.endDate.getTime();
  const clamp = (d) => new Date(Math.max(tripStartMs, Math.min(d.getTime(), tripEndMs)));
  // Mark where this trip's segments start in the shared array so later
  // computations (preLodgingEnd) can scope to this trip only.
  const preLodgingSliceStart = segments.length;

  // Pre-lodging gap: flights arriving before the first check-in are the
  // outbound journey. Anchor on the earliest known check-in regardless
  // of whether its TZ resolved — a TZ-less stay still proves user
  // presence at that hotel. Flights arriving during the stay must not
  // be classified as pre-lodging and steal those days. The trade-off:
  // a leading TZ-less stay's days remain uncovered when no GEO exists.
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

      const rawStart = flight.arrivalDate;
      const rawEnd = i < preLodgingFlights.length - 1
        ? preLodgingFlights[i + 1].arrivalDate
        : firstCheckinDate;

      segments.push({
        startDate: formatDate(clamp(rawStart)),
        endDate: formatDate(clamp(rawEnd)),
        timezone: tz,
        label: `${trip.summary} - ${flight.arrivalCity}`,
      });
    }
  }

  // Pass the highest endDate emitted so far (from pre-lodging flights) as
  // the orphan rawStart fallback. Without this, an orphan with no earlier
  // resolved stay could claim back to rangeStart and eclipse pre-lodging
  // flight segments after dedup-clip. Compute it from THIS trip's slice
  // of `segments` — scanning the whole array would pick up segments from
  // earlier trips that happen to share the same summary.
  const preLodgingEnd = (() => {
    let latest = null;
    for (let k = preLodgingSliceStart; k < segments.length; k++) {
      const seg = segments[k];
      if (!latest || seg.endDate > latest) latest = seg.endDate;
    }
    return latest ? new Date(latest + 'T00:00:00Z') : null;
  })();

  // Lodging segments
  buildLodgingSegments(sortedStays, trip.startDate, trip.endDate, trip.summary, segments, preLodgingEnd);

  // Between-stay flight gap-fill: when consecutive lodgings have a multi-day
  // gap (user moved on but TripIt has no hotel for some nights), flights in
  // that window indicate where they actually were. Without this, the previous
  // stay's timezone bleeds forward to the next check-in. Dedup later clips
  // any overlap with the lodging segments themselves.
  for (let i = 0; i < sortedStays.length - 1; i++) {
    const stay = sortedStays[i];
    const nextStay = sortedStays[i + 1];
    const checkout = stay.checkoutDate;
    // Require a real next-stay check-in. Falling back to the next stay's
    // checkout would treat days the user was at the next hotel as a gap and
    // manufacture flight segments over them.
    const nextCheckin = nextStay.checkinDate;
    if (!checkout || !nextCheckin) continue;
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

      const rawStart = flight.arrivalDate;
      const rawEnd = j < gapFlights.length - 1
        ? gapFlights[j + 1].arrivalDate
        : nextCheckin;

      segments.push({
        startDate: formatDate(clamp(rawStart)),
        endDate: formatDate(clamp(rawEnd)),
        timezone: tz,
        label: `${trip.summary} - ${flight.arrivalCity}`,
      });
    }
  }

  // Post-lodging gap: every flight after the LAST stay's checkout produces
  // a segment, mirroring the pre-lodging path. Iterating all post-checkout
  // flights handles multi-leg returns (e.g., overnight transit + connecting
  // flight); the < 1 day filter drops layover micro-segments later.
  //
  // Anchor on the chronologically last stay's checkout only. If that stay
  // is open-ended (no checkout), post-lodging is skipped — we can't tell
  // whether the user actually left that hotel, and using an earlier stay's
  // checkout would manufacture a post-lodging window inside an ongoing
  // lodging stay.
  const lastStay = sortedStays[sortedStays.length - 1];
  const lastStayCheckout = lastStay?.checkoutDate || null;
  if (lastStayCheckout && lastStayCheckout.getTime() < trip.endDate.getTime()) {
    // Allow flights up to tripEnd + 24h so a late-night return on the
    // user's local last day (which can land hours after tripEnd UTC for
    // west-of-UTC trips) is still considered post-lodging.
    const POST_LODGING_UPPER_BUFFER_MS = 24 * 60 * 60 * 1000;
    const postLodgingUpper = trip.endDate.getTime() + POST_LODGING_UPPER_BUFFER_MS;
    const postLodgingFlights = tripFlights.filter(f => {
      const t = f.arrivalDate.getTime();
      return t >= lastStayCheckout.getTime() && t <= postLodgingUpper;
    });
    for (let i = 0; i < postLodgingFlights.length; i++) {
      const flight = postLodgingFlights[i];
      const tz = resolveAbbreviation(flight.tzAbbr);
      if (!tz) {
        console.log(`  WARNING: Unknown TZ abbreviation "${flight.tzAbbr}" for ${flight.arrivalCity}`);
        continue;
      }

      const rawStart = flight.arrivalDate;
      const rawEnd = i < postLodgingFlights.length - 1
        ? postLodgingFlights[i + 1].arrivalDate
        : trip.endDate;

      segments.push({
        startDate: formatDate(clamp(rawStart)),
        endDate: formatDate(clamp(rawEnd)),
        timezone: tz,
        label: `${trip.summary} - ${flight.arrivalCity}`,
      });
    }
  }
}

/**
 * Flight-only build: no lodging available, so flights define the timeline.
 * Used for transit-only trips or trips where TripIt has no hotel data.
 */
function buildFlightOnlySegments(trip, tripFlights, segments) {
  // Clamp is defense-in-depth. Upper bound is tripEnd + 24h so a
  // late-night return on the user's local last day (which can land
  // hours after tripEnd UTC for west-of-UTC trips) still produces a
  // non-zero segment.
  const FLIGHT_CLAMP_UPPER_BUFFER_MS = 24 * 60 * 60 * 1000;
  const tripStartMs = trip.startDate.getTime();
  const tripEndMs = trip.endDate.getTime();
  const upperClampMs = tripEndMs + FLIGHT_CLAMP_UPPER_BUFFER_MS;

  for (let i = 0; i < tripFlights.length; i++) {
    const flight = tripFlights[i];
    const tz = resolveAbbreviation(flight.tzAbbr);
    if (!tz) {
      console.log(`  WARNING: Unknown TZ abbreviation "${flight.tzAbbr}" for ${flight.arrivalCity}`);
      continue;
    }

    const rawStart = i === 0
      ? Math.max(tripStartMs, flight.arrivalDate.getTime())
      : flight.arrivalDate.getTime();
    // Last flight's segment runs to tripEnd OR (for late-night returns
    // past tripEnd UTC) extends a day past arrival so the segment has
    // positive duration. Clamping caps it at tripEnd + 24h.
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const rawEnd = i < tripFlights.length - 1
      ? tripFlights[i + 1].arrivalDate.getTime()
      : Math.max(tripEndMs, flight.arrivalDate.getTime() + ONE_DAY);
    const segStart = new Date(Math.max(tripStartMs, Math.min(rawStart, upperClampMs)));
    const segEnd = new Date(Math.max(tripStartMs, Math.min(rawEnd, upperClampMs)));

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
 *
 * Each emitted segment ends at the boundary set by walking forward through
 * the remaining stays:
 *   - Next resolved stay-with-checkin → end at its check-in (it claims its
 *     own window from there).
 *   - Next resolved orphan (TZ but no check-in) → end at THIS stay's own
 *     check-out, leaving room for the orphan to emit from `lastEmittedEnd`.
 *   - TZ-less stays (no segment to emit) → walk through and fold their days
 *     into this segment.
 *   - No claimant ahead → extend through any trailing TZ-less stays to the
 *     last available checkout, then fall back to rangeEnd.
 *
 * Orphan stays (no checkinDate) start at `lastEmittedEnd` (the latest end
 * already covered by an earlier segment) so a later orphan can't claim
 * the trip back to its start and eclipse earlier segments.
 *
 * All segment endpoints are clamped to [rangeStart, rangeEnd] as
 * defense-in-depth. Stays without a resolved timezone are kept for boundary
 * influence but skipped during emission (they have no TZ to write).
 */
function buildLodgingSegments(stays, rangeStart, rangeEnd, tripSummary, segments, initialLastEnd = null) {
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();
  const clamp = (d) => new Date(Math.max(startMs, Math.min(d.getTime(), endMs)));

  // Tracks the latest boundary already covered by a preceding emitted
  // segment. Orphan stays (no checkinDate) start here instead of at
  // rangeStart, so a later orphan checkout doesn't retroactively claim
  // the entire trip back to its start and eclipse earlier segments.
  // The caller seeds this with the latest pre-lodging flight endDate so
  // an orphan with no earlier resolved stay still doesn't bleed back.
  let lastEmittedEnd = initialLastEnd;

  for (let i = 0; i < stays.length; i++) {
    const stay = stays[i];
    // Skip stays whose timezone couldn't be resolved — they still influence
    // boundary calculations upstream, but we can't emit a segment for them.
    if (!stay.timezone) continue;

    // Find the next stay that has a resolved timezone. Skipping over
    // TZ-less stays (rather than ending the segment at their check-in)
    // extends the current TZ across the unresolved window — best-guess
    // continuity is better than leaving the days uncovered for Reclaim
    // to fall back to its default timezone.
    // Walk forward to find this segment's end. Three cases drive the
    // boundary:
    //   1. Next stay has a checkinDate — end at its checkin (it claims
    //      its own window starting there).
    //   2. Next stay is a resolved orphan (TZ but no checkin) — end at
    //      THIS stay's own checkout, so the orphan can emit its segment
    //      from `lastEmittedEnd` onward without collapsing to zero length.
    //   3. Stay is TZ-less without a checkin — skip; only used to extend
    //      the current segment if no claimant follows.
    const rawStart = stay.checkinDate || lastEmittedEnd || rangeStart;
    let rawEnd;
    if (!stay.checkinDate) {
      // Orphan stay (TZ but no checkin) — the only evidence is that the
      // user was at this hotel UNTIL `checkoutDate`. Don't speculate
      // about days past checkout; end the segment at the known boundary.
      rawEnd = stay.checkoutDate || rangeEnd;
    } else {
      rawEnd = null;
      for (let k = i + 1; k < stays.length; k++) {
        const next = stays[k];
        if (next.timezone && next.checkinDate) {
          // Resolved stay-with-checkin — it claims its own window starting
          // at its checkin.
          rawEnd = next.checkinDate;
          break;
        }
        if (next.timezone) {
          // Resolved orphan (TZ but no checkin) — let it claim its own
          // window starting from `lastEmittedEnd`. End this stay at its
          // own checkout. If this stay has no checkout, reserve a 1-day
          // window before the orphan's checkout so the orphan's TZ
          // still appears (otherwise prev would extend to rangeEnd,
          // collapsing the orphan to zero length).
          if (stay.checkoutDate) {
            rawEnd = stay.checkoutDate;
          } else if (next.checkoutDate) {
            const ONE_DAY = 24 * 60 * 60 * 1000;
            const candidate = new Date(next.checkoutDate.getTime() - ONE_DAY);
            rawEnd = candidate.getTime() > rawStart.getTime() ? candidate : next.checkoutDate;
          } else {
            rawEnd = rangeEnd;
          }
          break;
        }
        // TZ-less (with or without checkin) — can't emit a segment, so it
        // doesn't claim a window. Keep walking; its days will fold into
        // this stay's window if no claimant appears later.
      }
      if (rawEnd === null) {
        // No claimant ahead. Either we're the last stay, or only TZ-less
        // stays follow — extend through them so trailing unresolved-hotel
        // days don't fall back to the default timezone.
        let trailingEnd = stay.checkoutDate;
        for (let k = i + 1; k < stays.length; k++) {
          if (stays[k].checkoutDate) trailingEnd = stays[k].checkoutDate;
        }
        rawEnd = trailingEnd || rangeEnd;
      }
    }

    const clampedEnd = clamp(rawEnd);
    segments.push({
      startDate: formatDate(clamp(rawStart)),
      endDate: formatDate(clampedEnd),
      timezone: stay.timezone,
      label: `${tripSummary} - ${stay.hotelName}`,
    });
    if (!lastEmittedEnd || clampedEnd.getTime() > lastEmittedEnd.getTime()) {
      lastEmittedEnd = clampedEnd;
    }
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
