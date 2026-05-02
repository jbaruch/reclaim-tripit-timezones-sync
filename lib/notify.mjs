const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

/**
 * Send notifications about timezone sync changes via configured channels.
 * Supports Telegram and/or AWS SNS — both are optional and independent.
 * Never throws — notification failure should not crash the sync.
 *
 * @param {Array} previousEntries - entries from Reclaim before sync
 * @param {Array} newSegments - deduplicated segments written to Reclaim (for count)
 * @param {Array} [rawSegments] - pre-dedup segments with original labels (for trip-grouped display)
 * @param {Object} [oooStats] - OOO sync stats { created, deleted, prioritySet }
 */
export async function sendNotification(previousEntries, newSegments, rawSegments = null, oooStats = null) {
  try {
    const message = buildMessage(previousEntries, newSegments, rawSegments, oooStats);

    await Promise.all([sendTelegram(message), sendSns(message)]);
  } catch (err) {
    console.log(`  WARNING: Notification failed: ${err.message}`);
  }
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log(`  WARNING: Telegram notification failed: ${res.status} ${body}`);
    } else {
      console.log('  Telegram notification sent');
    }
  } catch (err) {
    console.log(`  WARNING: Telegram notification failed: ${err.message}`);
  }
}

async function sendSns(message) {
  if (!SNS_TOPIC_ARN) return;

  if (!isValidSnsArn(SNS_TOPIC_ARN)) {
    console.log(`  WARNING: Invalid SNS_TOPIC_ARN format: ${SNS_TOPIC_ARN}`);
    return;
  }

  try {
    const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
    const region = SNS_TOPIC_ARN.split(':')[3] || process.env.AWS_REGION || 'us-east-1';
    const client = new SNSClient({ region });

    await client.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: 'Reclaim Timezone Sync',
      Message: stripMarkdown(message),
    }));

    console.log('  SNS notification sent');
  } catch (err) {
    console.log(`  WARNING: SNS notification failed: ${err.message}`);
  }
}

export function isValidSnsArn(arn) {
  return /^arn:aws:sns:[a-z0-9-]+:\d{12}:.+$/.test(arn);
}

export function stripMarkdown(text) {
  return text
    .replace(/\*([^*]+)\*/g, '$1')   // *bold*
    .replace(/_([^_]+)_/g, '$1')     // _italic_
    .replace(/`([^`]+)`/g, '$1');    // `code`
}

/**
 * Build a human-readable Markdown message describing the changes.
 * Groups segments by trip name for readability.
 *
 * @param {Array} previousEntries - entries from Reclaim before sync
 * @param {Array} newSegments - deduplicated segments (for the count in header)
 * @param {Array} [rawSegments] - pre-dedup segments with original labels (for display)
 * @param {Object} [oooStats] - OOO sync stats { created, deleted, prioritySet }
 */
export function buildMessage(previousEntries, newSegments, rawSegments = null, oooStats = null) {
  const prevCount = previousEntries.length;
  const newCount = newSegments.length;

  let text = '*Reclaim Timezone Sync*\n\n';

  // Warn about overlapping trips (detected from pre-dedup segments)
  const overlaps = findOverlaps(rawSegments || newSegments);
  if (overlaps.length > 0) {
    text += '*⚠️ OVERLAPPING TRIPS DETECTED:*\n';
    for (const o of overlaps) {
      text += `  ${o.labelA} (→ ${o.endA}) overlaps ${o.labelB} (${o.startB} →)\n`;
    }
    text += '\n';
  }

  if (newCount === 0) {
    text += `Cleared ${prevCount} timezone ${prevCount === 1 ? 'override' : 'overrides'} — no upcoming travel.`;
    text += buildOooSection(oooStats);
    return text;
  }

  text += `Set ${newCount} timezone ${newCount === 1 ? 'override' : 'overrides'}`;
  if (prevCount > 0) {
    text += ` (was ${prevCount})`;
  }
  text += ':\n\n';

  const displaySegments = rawSegments || newSegments;
  const tripGroups = groupByTrip(displaySegments);

  for (const [trip, segs] of tripGroups) {
    text += `*${trip}*\n`;
    for (const s of segs) {
      text += `  \`${s.timezone}\` ${s.startDate} → ${s.endDate}`;
      if (s.locations.length > 0) text += ` — ${s.locations.join(', ')}`;
      text += '\n';
    }
    text += '\n';
  }

  text = text.trimEnd() + '\n';
  text += buildOooSection(oooStats);
  return text;
}

/**
 * Build the OOO section for the notification message.
 */
function buildOooSection(oooStats) {
  if (!oooStats) return '';

  const parts = [];
  if (oooStats.created > 0) parts.push(`${oooStats.created} created`);
  if (oooStats.deleted > 0) parts.push(`${oooStats.deleted} deleted`);
  if (oooStats.prioritySet > 0) parts.push(`${oooStats.prioritySet} set to P2`);

  if (parts.length === 0) return '';

  let text = `\n*OOO Calendar Blocks:* ${parts.join(', ')}\n`;

  if (oooStats.createdNames?.length > 0) {
    for (const name of oooStats.createdNames) {
      text += `  + ${name}\n`;
    }
  }
  if (oooStats.deletedNames?.length > 0) {
    for (const name of oooStats.deletedNames) {
      text += `  − ${name}\n`;
    }
  }

  return text;
}

/**
 * Group segments by trip name (extracted from label before " - ").
 * Merges consecutive same-timezone segments within each trip, combining locations.
 */
function groupByTrip(segments) {
  const groups = new Map();
  for (const s of segments) {
    const trip = extractTripName(s.label);
    if (!groups.has(trip)) groups.set(trip, []);
    groups.get(trip).push(s);
  }

  const result = new Map();
  for (const [trip, segs] of groups) {
    const merged = [];
    for (const s of segs) {
      const loc = extractLocation(s.label);
      const last = merged[merged.length - 1];
      if (last && last.timezone === s.timezone) {
        last.endDate = s.endDate;
        if (loc && !last.locations.includes(loc)) last.locations.push(loc);
      } else {
        merged.push({
          timezone: s.timezone,
          startDate: s.startDate,
          endDate: s.endDate,
          locations: loc ? [loc] : [],
        });
      }
    }
    result.set(trip, merged);
  }

  return result;
}

function extractTripName(label) {
  if (!label) return 'Other';
  const idx = label.indexOf(' - ');
  return idx >= 0 ? label.substring(0, idx) : label;
}

function extractLocation(label) {
  if (!label) return '';
  const idx = label.indexOf(' - ');
  return idx >= 0 ? label.substring(idx + 3) : '';
}

/**
 * Find overlapping segments with different timezones.
 * Returns array of { labelA, endA, labelB, startB } for each overlap pair.
 */
export function findOverlaps(segments) {
  if (!segments || segments.length < 2) return [];

  // Sweep: every segment is checked against every still-active earlier segment
  // (one whose endDate is past the current startDate). Comparing only adjacent
  // pairs would miss A1 → A2 → B where A1 (long, Trip A) overlaps B (Trip B)
  // but A2 (short, same Trip A) was the immediate predecessor of B.
  //
  // Dedupe by (labelA, labelB) PER curr — multiple raw segments of the same
  // earlier trip overlapping curr emit only one warning, but a separate
  // overlap window between the same trip pair (e.g., trips that overlap in
  // two distinct date ranges) still produces a distinct warning.
  const sorted = [...segments].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const overlaps = [];
  const active = [];
  // Tracks the high-water endDate per trip pair for the currently-running
  // overlap. As long as the next overlap's curr.startDate is at or before
  // that endDate, it's the same continuous window and we suppress the
  // duplicate. A gap (curr.startDate > stored endDate) means the pair has
  // re-overlapped in a new window and we report it again.
  //
  // Pair keys are stored as `[sortedNameA, sortedNameB]` tuples (joined
  // via a JSON array stringify) to avoid delimiter collisions if a trip
  // summary itself contains the separator character.
  const pairKeyOf = (n1, n2) => JSON.stringify(n1 < n2 ? [n1, n2] : [n2, n1]);
  const tripsInKey = new Map(); // pairKey → [n1, n2] for cleanup
  const pairOverlapEnd = new Map();

  for (const curr of sorted) {
    const justExpired = [];
    for (let k = active.length - 1; k >= 0; k--) {
      if (active[k].endDate <= curr.startDate) {
        justExpired.push(active[k]);
        active.splice(k, 1);
      }
    }
    // Reset pair-window tracking for any pair whose trips are no longer
    // BOTH represented in the active set. `curr`'s trip is treated as
    // still-active ONLY if it's bridging an end-exclusive handoff —
    // i.e. one of its own segments just expired with endDate exactly
    // equal to curr.startDate (continuous coverage). Without that
    // bridge check, two same-trip segments with a real gap would be
    // misclassified as continuous and collapse two distinct overlap
    // windows into one warning.
    if (pairOverlapEnd.size > 0) {
      const stillActiveTrips = new Set(active.map(a => extractTripName(a.label)));
      const currTripName = extractTripName(curr.label);
      const isSameTripHandoff = justExpired.some(d =>
        extractTripName(d.label) === currTripName && d.endDate === curr.startDate
      );
      if (isSameTripHandoff) stillActiveTrips.add(currTripName);
      for (const key of [...pairOverlapEnd.keys()]) {
        const [n1, n2] = tripsInKey.get(key);
        if (!stillActiveTrips.has(n1) || !stillActiveTrips.has(n2)) {
          pairOverlapEnd.delete(key);
          tripsInKey.delete(key);
        }
      }
    }
    for (const a of active) {
      if (a.timezone === curr.timezone) continue;
      // Same trip producing overlapping raw segments is expected (lodging vs
      // gap-fill flight in the same trip). Only warn on cross-trip conflicts.
      // Skip the suppression when both labels resolve to the "Other" fallback
      // — that's the unlabeled-segment case, which we can't reliably attribute
      // to a single trip, so we should still surface the overlap.
      const nameA = extractTripName(a.label);
      const nameCurr = extractTripName(curr.label);
      if (nameA === nameCurr && nameA !== 'Other') continue;
      const pairKey = pairKeyOf(nameA, nameCurr);
      const prevEnd = pairOverlapEnd.get(pairKey);
      if (prevEnd !== undefined && curr.startDate <= prevEnd) {
        // Same continuous overlap window — extend high-water mark, skip.
        if (curr.endDate > prevEnd) pairOverlapEnd.set(pairKey, curr.endDate);
        continue;
      }
      pairOverlapEnd.set(pairKey, curr.endDate);
      tripsInKey.set(pairKey, nameA < nameCurr ? [nameA, nameCurr] : [nameCurr, nameA]);
      overlaps.push({
        labelA: nameA,
        endA: a.endDate,
        labelB: nameCurr,
        startB: curr.startDate,
      });
    }
    active.push(curr);
  }

  return overlaps;
}

/**
 * Compare previous Reclaim entries with new segments.
 * Returns true if there are meaningful differences.
 */
export function entriesChanged(previousEntries, newSegments) {
  const toKey = (e) => `${e.startDate}|${e.endDate}|${e.timezone}`;
  const prevSet = new Set(previousEntries.map(toKey));
  const newSet = new Set(newSegments.map(toKey));

  if (prevSet.size !== newSet.size) return true;
  for (const key of newSet) {
    if (!prevSet.has(key)) return true;
  }
  return false;
}
