// OneCLI mode: install undici ProxyAgent before any HTTP.
// ESM evaluates all static imports (the whole dependency graph) before this
// module body runs, so import order does NOT control when the agent is
// installed — the explicit call below does. That is safe because lib/*
// only export functions; they do not perform HTTP at load time. Any future
// top-level HTTP in an imported module would race this and break OneCLI.
// When ONECLI_URL is unset, installProxyDispatcher() is a no-op: no ProxyAgent,
// no dispatcher swap, HTTP behavior unchanged. Note: importing this module
// still loads `undici` (a declared dependency); the no-op is about runtime
// HTTP routing, not zero module-graph difference.
import { installProxyDispatcher } from './lib/proxy.mjs';
installProxyDispatcher();

import {
  fetchIcalEvents,
  extractTrips,
  extractFlights,
  extractLodging,
  buildTimezoneSegments,
  filterFutureSegments,
  filterFutureTrips,
  filterIgnoredTrips,
  deduplicateSegments,
  resolveHomeTimezone,
  filterHomeTimezoneSegments,
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
  oooSkipReason,
  listOooEvents,
  createOooEvent,
  deleteOooEvent,
  OOO_PREFIX,
} from './lib/google-calendar.mjs';

import { entriesChanged, sendNotification, findOverlaps } from './lib/notify.mjs';

// Parse CLI arguments: mode (positional) and --output=json (flag)
const args = process.argv.slice(2);
const outputIdx = args.findIndex(a => a.startsWith('--output='));
const outputFormat = outputIdx >= 0 ? args.splice(outputIdx, 1)[0].split('=')[1] : 'text';
if (outputFormat !== 'text' && outputFormat !== 'json') {
  console.error(`Unknown output format: ${outputFormat}`);
  console.error('Supported: --output=text (default), --output=json');
  process.exit(1);
}
const jsonOutput = outputFormat === 'json';

const mode = args[0] || 'dry-run';
const VALID_MODES = ['dry-run', 'sync'];

if (!VALID_MODES.includes(mode)) {
  console.error(`Unknown mode: ${mode}`);
  console.error(`Usage: node sync.mjs [${VALID_MODES.join('|')}] [--output=json]`);
  process.exit(1);
}

// In JSON mode, suppress human-readable output and collect structured data instead
const _log = console.log;
const _error = console.error;
if (jsonOutput) {
  console.log = () => {};
}

const result = {
  mode,
  noChanges: true,
  homeTimezone: null,
  timezoneChanges: [],
  segments: [],
  ooo: null,
  conflicts: [],
  errors: [],
};

const TRIPIT_ICAL_URL = process.env.TRIPIT_ICAL_URL;
const RECLAIM_API_TOKEN = process.env.RECLAIM_API_TOKEN;

if (!TRIPIT_ICAL_URL) {
  if (jsonOutput) { result.errors.push('Missing TRIPIT_ICAL_URL environment variable'); _log(JSON.stringify(result)); }
  _error('Missing TRIPIT_ICAL_URL environment variable');
  process.exit(1);
}

if (!RECLAIM_API_TOKEN) {
  if (jsonOutput) { result.errors.push('Missing RECLAIM_API_TOKEN environment variable'); _log(JSON.stringify(result)); }
  _error('Missing RECLAIM_API_TOKEN environment variable');
  process.exit(1);
}

// Google Calendar credentials (all optional — OOO feature skips if missing)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Optional: comma-separated trip names to ignore (case-insensitive substring match)
const IGNORE_TRIPS = (process.env.TRIPIT_IGNORE_TRIPS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Optional: comma-separated keywords — any trip whose name contains one of these is ignored
const IGNORE_KEYWORDS = (process.env.TRIPIT_IGNORE_KEYWORDS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

console.log(`\n=== TripIt → Reclaim Travel Timezone Sync ===`);
console.log(`Mode: ${mode}\n`);

try {
  // Step 1: Fetch and parse iCal feed
  const events = await fetchIcalEvents(TRIPIT_ICAL_URL);
  const allTrips = extractTrips(events);
  const flights = extractFlights(events);
  const stays = extractLodging(events);

  // Filter out ignored trips (by exact name or keyword match)
  const trips = filterIgnoredTrips(allTrips, IGNORE_TRIPS, IGNORE_KEYWORDS);
  const skipped = allTrips.length - trips.length;
  if (skipped > 0) {
    console.log(`  Ignored ${skipped} trip(s) matching TRIPIT_IGNORE_TRIPS/KEYWORDS`);
  }

  // Step 2: Build timezone segments
  console.log('\nBuilding timezone segments...');
  const allSegments = buildTimezoneSegments(trips, flights, stays);
  console.log(`  Built ${allSegments.length} segment(s)`);

  // Step 3: Filter and deduplicate
  const future = filterFutureSegments(allSegments);
  console.log(`  ${future.length} future segment(s) > 1 day`);

  const deduped = deduplicateSegments(future);
  console.log(`  ${deduped.length} after deduplication`);

  // Connect to Reclaim now (both modes): we need the account's default
  // (home) timezone to drop redundant home→home overrides, and we reuse
  // the same fetch for the change-detection diff in sync mode. Reclaim
  // already falls back to the home timezone wherever no override covers a
  // date, so an override that merely restates home is pure noise in the
  // Travel timezones list. Dry-run now hits this too, so it both reports
  // the exact segment list sync would push and validates the Reclaim
  // token (matching what onboarding promises).
  const client = createClient(RECLAIM_API_TOKEN);
  const current = await listEntries(client);
  const previousEntries = current.entries || [];
  const defTz = typeof current.defaultTimezone === 'object'
    ? JSON.stringify(current.defaultTimezone)
    : current.defaultTimezone || 'unknown';
  console.log(`  Default timezone: ${defTz}`);

  const homeTz = resolveHomeTimezone(process.env.HOME_TZ, current.defaultTimezone);
  result.homeTimezone = homeTz;
  if (!homeTz && current.defaultTimezone != null) {
    console.log(`  WARNING: could not resolve home timezone from Reclaim (defaultTimezone: ${defTz}). Set HOME_TZ to drop redundant home-timezone overrides.`);
  }

  const { kept: segments, dropped: homeDropped } = filterHomeTimezoneSegments(deduped, homeTz);
  if (homeDropped.length > 0) {
    console.log(`  Dropped ${homeDropped.length} redundant home-timezone segment(s) [${homeTz}]`);
  }

  // Check for overlapping trips
  const overlaps = findOverlaps(future);
  if (overlaps.length > 0) {
    console.log(`\n⚠️  OVERLAPPING TRIPS:`);
    for (const o of overlaps) {
      console.log(`  ${o.labelA} (→ ${o.endA}) overlaps ${o.labelB} (${o.startB} →)`);
      result.conflicts.push({ trip1: o.labelA, trip2: o.labelB, overlap: o.startB });
    }
  }

  // Print summary
  console.log(`\n── Timezone segments ──`);
  for (const s of segments) {
    console.log(`  ${s.label}`);
    console.log(`    ${s.startDate} → ${s.endDate}  [${s.timezone}]`);
  }

  // Populate result segments. `from` / `to` (date-only YYYY-MM-DD)
  // preserve the JSON contract existing consumers depend on; the
  // adjacent `from_dt` / `to_dt` (ISO 8601 UTC) carry the underlying
  // wall-clock so a downstream walker can resolve at the actual
  // flight-arrival / check-in moment instead of UTC midnight of the
  // departure day. See jbaruch/nanoclaw-admin#229.
  result.segments = segments.map(s => ({
    timezone: s.timezone,
    from: s.startDate,
    to: s.endDate,
    from_dt: s.startDateTime,
    to_dt: s.endDateTime,
    label: s.label,
  }));

  // Get future trips for OOO sync
  const futureTrips = filterFutureTrips(trips);

  // Google Calendar client (null when OOO not configured / not opted in).
  // In OneCLI mode the gateway injects Google auth; createGCalClient ignores
  // the real OAuth values and sends a static placeholder Bearer instead.
  const googleCreds = {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH_TOKEN,
  };
  const gcal = createGCalClient(googleCreds);

  if (mode === 'dry-run') {
    console.log('\nDry run complete. No changes made to Reclaim.');

    if (futureTrips.length > 0 && gcal) {
      console.log(`\n── OOO blocks (would create) ──`);
      for (const t of futureTrips) {
        console.log(`  ${OOO_PREFIX}${t.summary}  ${t.startDate} → ${t.endDate}`);
      }
    } else if (futureTrips.length > 0) {
      console.log(`\n  OOO blocks: skipped (${oooSkipReason(googleCreds)})`);
    }

    if (jsonOutput) _log(JSON.stringify(result));
    process.exit(0);
  }

  // Step 4: Sync to Reclaim
  // `client`, `current`, and `previousEntries` were fetched above (to
  // resolve the home timezone); reuse them here rather than re-querying.
  console.log('\n── Syncing to Reclaim ──');
  console.log(`  Current entries: ${previousEntries.length}`);

  let timezoneChanged = false;

  // Skip timezone sync if nothing changed
  if (!entriesChanged(previousEntries, segments)) {
    console.log('  No timezone changes detected — skipping timezone sync.');
  } else {
    timezoneChanged = true;
    result.noChanges = false;

    // Clear existing (pass known entries to avoid redundant API call)
    await clearAllEntries(client, previousEntries);
    for (const e of previousEntries) {
      result.timezoneChanges.push({
        action: 'delete', timezone: e.timezone, from: e.startDate, to: e.endDate,
      });
    }

    // Create new entries
    if (segments.length === 0) {
      console.log('  No segments to sync.');
    } else {
      for (const s of segments) {
        console.log(`  Creating: ${s.timezone} (${s.startDate} → ${s.endDate})`);
        result.timezoneChanges.push({
          action: 'create', timezone: s.timezone, from: s.startDate, to: s.endDate,
        });
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

  if (!gcal) {
    console.log(`\n  OOO blocks: skipped (${oooSkipReason(googleCreds)})`);
  } else {
    console.log('\n── OOO Calendar Blocks ──');
    try {
      oooStats = await syncOooEvents(client, gcal, futureTrips);
    } catch (err) {
      // Surface OneCLI Google-connection misconfig clearly (gateway 401
      // when the built-in Google Calendar connection isn't authorized).
      // Don't assume `err` is an Error — libraries sometimes throw strings
      // or plain objects; preserve the original via `cause`.
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env.ONECLI_URL && /401|unauthorized|invalid.?credential/i.test(msg)) {
        throw new Error(
          `Google Calendar OOO failed under OneCLI (${msg}). ` +
          'Configure and authorize the OneCLI Google Calendar connection ' +
          '(`onecli apps configure`) so the gateway can inject a real Bearer, ' +
          'or set ENABLE_OOO=0 to skip OOO.',
          { cause: err },
        );
      }
      throw err;
    }
    result.ooo = {
      created: oooStats.created,
      deleted: oooStats.deleted,
      setToP2: oooStats.prioritySet,
    };
    if (oooStats.created > 0 || oooStats.deleted > 0) {
      result.noChanges = false;
    }
  }

  // Notify on changes (never throws)
  if (timezoneChanged || (oooStats && (oooStats.created > 0 || oooStats.deleted > 0 || oooStats.prioritySet > 0))) {
    await sendNotification(previousEntries, segments, future, oooStats);
  }

  console.log('\nSync complete!');
  if (jsonOutput) _log(JSON.stringify(result));
} catch (err) {
  if (jsonOutput) {
    result.errors.push(err.message);
    _log(JSON.stringify(result));
  }
  _error(`\nFATAL ERROR: ${err.message}`);
  _error(err.stack);
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
