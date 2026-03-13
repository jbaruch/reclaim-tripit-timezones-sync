import {
  fetchIcalEvents,
  extractTrips,
  extractFlights,
  extractLodging,
  buildTimezoneSegments,
  filterFutureSegments,
  filterFutureTrips,
  deduplicateSegments,
} from './lib/tripit.mjs';

import {
  createClient,
  listEntries,
  clearAllEntries,
  createEntry,
  getPrimaryCalendar,
  listReclaimEvents,
  setEventPriority,
} from './lib/reclaim.mjs';

import {
  createGCalClient,
  listOooEvents,
  createOooEvent,
  deleteOooEvent,
  OOO_PREFIX,
} from './lib/google-calendar.mjs';

import { entriesChanged, sendNotification, findOverlaps } from './lib/notify.mjs';

const mode = process.argv[2] || 'dry-run';
const VALID_MODES = ['dry-run', 'sync'];

if (!VALID_MODES.includes(mode)) {
  console.error(`Unknown mode: ${mode}`);
  console.error(`Usage: node sync.mjs [${VALID_MODES.join('|')}]`);
  process.exit(1);
}

const TRIPIT_ICAL_URL = process.env.TRIPIT_ICAL_URL;
const RECLAIM_API_TOKEN = process.env.RECLAIM_API_TOKEN;

if (!TRIPIT_ICAL_URL) {
  console.error('Missing TRIPIT_ICAL_URL environment variable');
  process.exit(1);
}

if (!RECLAIM_API_TOKEN) {
  console.error('Missing RECLAIM_API_TOKEN environment variable');
  process.exit(1);
}

// Google Calendar credentials (all optional — OOO feature skips if missing)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

console.log(`\n=== TripIt → Reclaim Travel Timezone Sync ===`);
console.log(`Mode: ${mode}\n`);

try {
  // Step 1: Fetch and parse iCal feed
  const events = await fetchIcalEvents(TRIPIT_ICAL_URL);
  const trips = extractTrips(events);
  const flights = extractFlights(events);
  const stays = extractLodging(events);

  // Step 2: Build timezone segments
  console.log('\nBuilding timezone segments...');
  const allSegments = buildTimezoneSegments(trips, flights, stays);
  console.log(`  Built ${allSegments.length} segment(s)`);

  // Step 3: Filter and deduplicate
  const future = filterFutureSegments(allSegments);
  console.log(`  ${future.length} future segment(s) > 1 day`);

  const segments = deduplicateSegments(future);
  console.log(`  ${segments.length} after deduplication`);

  // Check for overlapping trips
  const overlaps = findOverlaps(future);
  if (overlaps.length > 0) {
    console.log(`\n⚠️  OVERLAPPING TRIPS:`);
    for (const o of overlaps) {
      console.log(`  ${o.labelA} (→ ${o.endA}) overlaps ${o.labelB} (${o.startB} →)`);
    }
  }

  // Print summary
  console.log(`\n── Timezone segments ──`);
  for (const s of segments) {
    console.log(`  ${s.label}`);
    console.log(`    ${s.startDate} → ${s.endDate}  [${s.timezone}]`);
  }

  // Get future trips for OOO sync
  const futureTrips = filterFutureTrips(trips);

  if (mode === 'dry-run') {
    console.log('\nDry run complete. No changes made to Reclaim.');

    if (futureTrips.length > 0 && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
      console.log(`\n── OOO blocks (would create) ──`);
      for (const t of futureTrips) {
        console.log(`  ${OOO_PREFIX}${t.summary}  ${t.startDate} → ${t.endDate}`);
      }
    } else if (futureTrips.length > 0) {
      console.log('\n  OOO blocks: skipped (Google Calendar credentials not configured)');
    }

    process.exit(0);
  }

  // Step 4: Sync to Reclaim
  console.log('\n── Syncing to Reclaim ──');
  const client = createClient(RECLAIM_API_TOKEN);

  // Show current state
  const current = await listEntries(client);
  const previousEntries = current.entries || [];
  console.log(`  Current entries: ${previousEntries.length}`);
  const defTz = typeof current.defaultTimezone === 'object'
    ? JSON.stringify(current.defaultTimezone)
    : current.defaultTimezone || 'unknown';
  console.log(`  Default timezone: ${defTz}`);

  let timezoneChanged = false;

  // Skip timezone sync if nothing changed
  if (!entriesChanged(previousEntries, segments)) {
    console.log('  No timezone changes detected — skipping timezone sync.');
  } else {
    timezoneChanged = true;

    // Clear existing (pass known entries to avoid redundant API call)
    await clearAllEntries(client, previousEntries);

    // Create new entries
    if (segments.length === 0) {
      console.log('  No segments to sync.');
    } else {
      for (const s of segments) {
        console.log(`  Creating: ${s.timezone} (${s.startDate} → ${s.endDate})`);
      }
      await Promise.all(segments.map(s => createEntry(client, {
        startDate: s.startDate,
        endDate: s.endDate,
        timezone: s.timezone,
      })));
      console.log(`  Created ${segments.length} ${segments.length === 1 ? 'entry' : 'entries'}`);
    }
  }

  // Step 5: OOO calendar blocks
  let oooStats = null;
  const gcal = createGCalClient({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH_TOKEN,
  });

  if (!gcal) {
    console.log('\n  OOO blocks: skipped (Google Calendar credentials not configured)');
  } else {
    console.log('\n── OOO Calendar Blocks ──');
    oooStats = await syncOooEvents(client, gcal, futureTrips);
  }

  // Notify on changes (never throws)
  if (timezoneChanged || (oooStats && (oooStats.created > 0 || oooStats.deleted > 0 || oooStats.prioritySet > 0))) {
    await sendNotification(previousEntries, segments, future, oooStats);
  }

  console.log('\nSync complete!');
} catch (err) {
  console.error(`\nFATAL ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}

/**
 * Sync OOO events: create missing, delete stale, set Reclaim priority to P2.
 */
async function syncOooEvents(reclaimClient, gcal, futureTrips) {
  const stats = { created: 0, deleted: 0, prioritySet: 0, createdNames: [], deletedNames: [] };

  // Get Reclaim primary calendar for the Google Calendar ID and Reclaim calendar ID
  const { calendarId, googleCalendarId } = await getPrimaryCalendar(reclaimClient);
  if (!googleCalendarId) {
    console.log('  WARNING: Could not determine Google Calendar ID from Reclaim');
    return stats;
  }
  console.log(`  Reclaim calendar: ${calendarId}, Google Calendar: ${googleCalendarId}`);

  // List existing OOO events in Google Calendar
  const existingOoo = await listOooEvents(gcal, googleCalendarId);
  console.log(`  Existing OOO events: ${existingOoo.length}`);

  // Build a map of desired OOO events keyed by trip summary
  const desiredByName = new Map();
  for (const trip of futureTrips) {
    desiredByName.set(trip.summary, trip);
  }

  // Build a map of existing OOO events keyed by trip summary (strip prefix)
  const existingByName = new Map();
  for (const ev of existingOoo) {
    const name = ev.summary.replace(OOO_PREFIX, '');
    existingByName.set(name, ev);
  }

  // Delete stale OOO events (exist in GCal but no matching future trip, or dates changed)
  for (const [name, ev] of existingByName) {
    const desired = desiredByName.get(name);
    if (!desired || desired.startDate !== ev.startDate || desired.endDate !== ev.endDate) {
      console.log(`  Deleting stale: ${ev.summary}`);
      await deleteOooEvent(gcal, googleCalendarId, ev.id);
      stats.deleted++;
      stats.deletedNames.push(name);
      existingByName.delete(name);
    }
  }

  // Create missing OOO events
  const createdEventIds = [];
  for (const [name, trip] of desiredByName) {
    if (existingByName.has(name)) continue;

    console.log(`  Creating: ${OOO_PREFIX}${name}  ${trip.startDate} → ${trip.endDate}`);
    const eventId = await createOooEvent(gcal, googleCalendarId, {
      summary: name,
      startDate: trip.startDate,
      endDate: trip.endDate,
    });
    createdEventIds.push(eventId);
    stats.created++;
    stats.createdNames.push(name);
  }

  // Set Reclaim priority to P2 for OOO events
  // Search Reclaim for our OOO events and set priority
  const pendingPriority = await setOooPriorities(reclaimClient, calendarId, futureTrips, stats);

  // If we just created events and Reclaim hasn't synced them yet, retry in 10 minutes
  if (stats.created > 0 && pendingPriority > 0) {
    const RETRY_DELAY_MS = parseInt(process.env.OOO_RETRY_DELAY_MS, 10) || 60 * 1000;
    console.log(`  ${pendingPriority} new event(s) not yet in Reclaim — retrying priority in ${RETRY_DELAY_MS / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    await setOooPriorities(reclaimClient, calendarId, futureTrips, stats);
  }

  console.log(`  OOO sync: ${stats.created} created, ${stats.deleted} deleted, ${stats.prioritySet} set to P2`);
  return stats;
}

/**
 * Find OOO events in Reclaim and set their priority to P2.
 * Returns the number of expected events that weren't found (still pending Reclaim sync).
 */
async function setOooPriorities(reclaimClient, calendarId, futureTrips, stats) {
  if (futureTrips.length === 0) return 0;

  const earliest = futureTrips.reduce((min, t) => t.startDate < min ? t.startDate : min, futureTrips[0].startDate);
  const latest = futureTrips.reduce((max, t) => t.endDate > max ? t.endDate : max, futureTrips[0].endDate);

  try {
    const reclaimEvents = await listReclaimEvents(
      reclaimClient,
      calendarId,
      earliest,
      latest,
    );

    const oooEvents = (reclaimEvents || []).filter(e =>
      e.title?.startsWith(OOO_PREFIX)
    );

    const needsPriority = oooEvents.filter(e => e.priority !== 'P2');

    for (const ev of needsPriority) {
      console.log(`  Setting P2 priority: ${ev.title}`);
      try {
        await setEventPriority(reclaimClient, calendarId, ev.eventId, 'P2');
        stats.prioritySet++;
      } catch (err) {
        console.log(`  WARNING: Failed to set priority for "${ev.title}": ${err.message}`);
      }
    }

    // How many trips don't have a matching Reclaim event yet?
    const foundNames = new Set(oooEvents.map(e => e.title));
    const missing = futureTrips.filter(t => !foundNames.has(`${OOO_PREFIX}${t.summary}`));
    return missing.length;
  } catch (err) {
    console.log(`  WARNING: Could not list Reclaim events for priority update: ${err.message}`);
    return futureTrips.length;
  }
}
