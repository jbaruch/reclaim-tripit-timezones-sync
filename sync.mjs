import {
  fetchIcalEvents,
  extractTrips,
  extractFlights,
  extractLodging,
  buildTimezoneSegments,
  filterFutureSegments,
  deduplicateSegments,
} from './lib/tripit.mjs';

import {
  createClient,
  listEntries,
  clearAllEntries,
  createEntry,
} from './lib/reclaim.mjs';

import { sendNotification, buildSyncSummary } from './lib/notify.mjs';

/**
 * Compare previous Reclaim entries to new segments.
 * Returns true if the set of (startDate, endDate, timezone) tuples differs.
 */
function entriesChanged(previousEntries, newSegments) {
  const key = (e) => `${e.startDate}|${e.endDate}|${e.timezone}`;
  const prev = new Set(previousEntries.map(key));
  const next = new Set(newSegments.map(key));
  if (prev.size !== next.size) return true;
  for (const k of prev) {
    if (!next.has(k)) return true;
  }
  return false;
}

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

  // Print summary
  console.log(`\n── Timezone segments ──`);
  for (const s of segments) {
    console.log(`  ${s.label}`);
    console.log(`    ${s.startDate} → ${s.endDate}  [${s.timezone}]`);
  }

  if (mode === 'dry-run') {
    console.log('\nDry run complete. No changes made to Reclaim.');
    process.exit(0);
  }

  // Step 4: Sync to Reclaim
  console.log('\n── Syncing to Reclaim ──');
  const client = createClient(RECLAIM_API_TOKEN);

  // Show current state
  const current = await listEntries(client);
  console.log(`  Current entries: ${(current.entries || []).length}`);
  const defTz = typeof current.defaultTimezone === 'object'
    ? JSON.stringify(current.defaultTimezone)
    : current.defaultTimezone || 'unknown';
  console.log(`  Default timezone: ${defTz}`);

  // Check if entries actually changed
  const previousEntries = current.entries || [];
  const changed = entriesChanged(previousEntries, segments);

  if (!changed) {
    console.log('  No changes detected — skipping sync and notification.');
  } else {
    // Clear existing
    await clearAllEntries(client);

    // Create new entries
    if (segments.length === 0) {
      console.log('  No segments to sync.');
    } else {
      for (const s of segments) {
        console.log(`  Creating: ${s.timezone} (${s.startDate} → ${s.endDate})`);
        await createEntry(client, {
          startDate: s.startDate,
          endDate: s.endDate,
          timezone: s.timezone,
        });
      }
      console.log(`  Created ${segments.length} entry/entries`);
    }

    // Send notification
    const { subject, message } = buildSyncSummary(previousEntries, segments, defTz);
    await sendNotification(subject, message);
  }

  console.log('\nSync complete!');
} catch (err) {
  console.error(`\nFATAL ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
