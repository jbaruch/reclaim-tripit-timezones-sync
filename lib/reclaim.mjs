const BASE_URL = 'https://api.app.reclaim.ai';

/** Expected provider/transport failure; programming errors remain fatal. */
export class ReclaimApiError extends Error {}

/** @param {unknown} error */
function expectedTransportFailure(error) {
  if (!(error instanceof Error)) return false;
  if (['AbortError', 'TimeoutError'].includes(error.name)) return true;
  const codes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET'
  ]);
  for (const candidate of [error, error.cause]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'code' in candidate &&
      typeof candidate.code === 'string' &&
      codes.has(candidate.code)
    )
      return true;
  }
  return false;
}

/** @param {string} url @param {RequestInit} options */
async function priorityRequest(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (!expectedTransportFailure(error)) throw error;
    throw new ReclaimApiError('Reclaim priority connection failed; verify connectivity and retry.', { cause: error });
  }
}

/**
 * Create a Reclaim API client.
 */
export function createClient(apiToken) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json'
  };

  return { headers };
}

/**
 * GET current travel timezone override entries.
 * Returns { entries: [...], defaultTimezone: "..." }
 */
export async function listEntries(client) {
  const res = await fetch(`${BASE_URL}/api/time-window-overrides`, {
    headers: client.headers
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
    body: JSON.stringify(entry)
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
    headers: client.headers
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
/**
 * GET the primary calendar info from Reclaim.
 * Returns { calendarId, googleCalendarId }.
 */
export async function getPrimaryCalendar(client) {
  const res = await fetch(`${BASE_URL}/api/calendars/primary`, {
    headers: client.headers
  });

  if (!res.ok) {
    throw new Error(`Reclaim GET primary calendar failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return {
    calendarId: data.id,
    googleCalendarId: data.data?.id || null
  };
}

/**
 * GET events from Reclaim within a date range.
 * @param {number} calendarId - Reclaim calendar ID
 * @param {string} start - YYYY-MM-DD date string
 * @param {string} end - YYYY-MM-DD date string
 */
export async function listReclaimEvents(client, calendarId, start, end) {
  const params = new URLSearchParams({
    start: start.slice(0, 10),
    end: end.slice(0, 10),
    calendarIds: String(calendarId)
  });
  const res = await priorityRequest(`${BASE_URL}/api/events?${params}`, {
    headers: client.headers
  });

  if (!res.ok) {
    throw new ReclaimApiError(
      `Reclaim GET events failed (HTTP ${res.status}); verify the Reclaim connection and retry.`
    );
  }

  try {
    return await res.json();
  } catch (error) {
    if (!(error instanceof SyntaxError) && !expectedTransportFailure(error)) throw error;
    throw new ReclaimApiError(
      'Reclaim events response could not be read; retry or report the provider response format.',
      { cause: error }
    );
  }
}

/**
 * Set the priority of a Reclaim event.
 * @param {number} calendarId - Reclaim calendar ID
 * @param {string} eventId - Google Calendar event ID
 * @param {string} priority - e.g. 'P2'
 */
export async function setEventPriority(client, calendarId, eventId, priority) {
  const res = await priorityRequest(`${BASE_URL}/api/events/${calendarId}/${eventId}/priority?priority=${priority}`, {
    method: 'POST',
    headers: client.headers
  });

  if (!res.ok) {
    throw new ReclaimApiError(
      `Reclaim POST event priority failed (HTTP ${res.status}); verify the Reclaim connection and retry.`
    );
  }
}

export async function clearAllEntries(client, knownEntries = null) {
  const entries = knownEntries ?? (await listEntries(client)).entries ?? [];

  if (entries.length === 0) {
    console.log('  No existing entries to clear');
    return 0;
  }

  await Promise.all(entries.map((entry) => deleteEntry(client, entry.id)));

  console.log(`  Deleted ${entries.length} existing entry/entries`);
  return entries.length;
}
