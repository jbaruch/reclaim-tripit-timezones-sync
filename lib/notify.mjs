const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a Telegram notification about timezone sync changes.
 * No-op if TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are not set.
 * Never throws — notification failure should not crash the sync.
 */
export async function sendNotification(previousEntries, newSegments) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const message = buildMessage(previousEntries, newSegments);

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

/**
 * Build a human-readable Markdown message describing the changes.
 */
export function buildMessage(previousEntries, newSegments) {
  const prevCount = previousEntries.length;
  const newCount = newSegments.length;

  let text = '*Reclaim Timezone Sync*\n\n';

  if (newCount === 0) {
    text += `Cleared ${prevCount} timezone ${prevCount === 1 ? 'override' : 'overrides'} — no upcoming travel.`;
    return text;
  }

  text += `Set ${newCount} timezone ${newCount === 1 ? 'override' : 'overrides'}`;
  if (prevCount > 0) {
    text += ` (was ${prevCount})`;
  }
  text += ':\n\n';

  for (const s of newSegments) {
    text += `• \`${s.timezone}\` ${s.startDate} → ${s.endDate}\n`;
    if (s.label) text += `  _${s.label}_\n`;
  }

  return text;
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
