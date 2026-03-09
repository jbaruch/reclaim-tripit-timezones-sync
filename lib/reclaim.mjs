const BASE_URL = 'https://api.app.reclaim.ai';

/**
 * Create a Reclaim API client.
 */
export function createClient(apiToken) {
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  return { headers };
}

/**
 * GET current travel timezone override entries.
 * Returns { entries: [...], defaultTimezone: "..." }
 */
export async function listEntries(client) {
  const res = await fetch(`${BASE_URL}/api/time-window-overrides`, {
    headers: client.headers,
  });

  if (!res.ok) {
    throw new Error(`Reclaim GET entries failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * POST a new travel timezone entry.
 * @param {Object} entry - { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", timezone: "America/New_York" }
 */
export async function createEntry(client, entry) {
  const res = await fetch(`${BASE_URL}/api/time-window-overrides/entry`, {
    method: 'POST',
    headers: client.headers,
    body: JSON.stringify(entry),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Reclaim POST entry failed: ${res.status} ${res.statusText} ${body}`);
  }

  return res.json();
}

/**
 * DELETE a travel timezone entry by ID.
 */
export async function deleteEntry(client, entryId) {
  const res = await fetch(`${BASE_URL}/api/time-window-overrides/entry/${entryId}`, {
    method: 'DELETE',
    headers: client.headers,
  });

  if (!res.ok) {
    throw new Error(`Reclaim DELETE entry ${entryId} failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Delete all existing travel timezone entries.
 * @param {Object} client - Reclaim API client
 * @param {Array} [knownEntries] - pre-fetched entries to avoid redundant API call
 */
export async function clearAllEntries(client, knownEntries = null) {
  const entries = knownEntries ?? (await listEntries(client)).entries ?? [];

  if (entries.length === 0) {
    console.log('  No existing entries to clear');
    return 0;
  }

  await Promise.all(entries.map(entry => deleteEntry(client, entry.id)));

  console.log(`  Deleted ${entries.length} existing entry/entries`);
  return entries.length;
}
