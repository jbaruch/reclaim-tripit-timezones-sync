import { google } from 'googleapis';

const OOO_PREFIX = '[TripIt OOO] ';

// Placeholder Bearer sent in OneCLI mode. OneCLI's built-in Google Calendar
// connection overwrites Authorization on www.googleapis.com with a real
// access token. Must NOT trigger a client-side OAuth refresh.
const ONECLI_ACCESS_TOKEN = 'onecli-managed';

/**
 * Create a Google Calendar API client.
 *
 * Default path: OAuth2 refresh token (returns null if any credential is missing).
 *
 * OneCLI path (`ONECLI_URL` set): ignore the OAuth credentials entirely.
 * googleapis refuses to call Calendar until it has completed its own token
 * refresh — with placeholder vaulted creds that refresh fails before the
 * gateway ever sees an API request. Instead we hand googleapis a static
 * access token (no refresh_token) so it sends
 * `Authorization: Bearer onecli-managed` and the gateway swaps in the real
 * token. gaxios honors HTTPS_PROXY, so Calendar traffic still goes through
 * the MITM proxy set up by `onecli run`.
 *
 * OOO activation in OneCLI mode is opt-in: set ENABLE_OOO=1/true, or keep
 * the three GOOGLE_* env vars present as placeholder markers. ENABLE_OOO=0
 * forces OOO off.
 *
 * Prerequisite (operator): configure OneCLI's Google Calendar connection
 * (`onecli apps configure`) and authorize once so the gateway has a token
 * to inject. Otherwise Calendar calls 401.
 *
 * @param {Object} [credentials] - { clientId, clientSecret, refreshToken }
 * @returns {calendar_v3.Calendar|null}
 */
export function createGCalClient(credentials = {}) {
  if (process.env.ONECLI_URL) {
    if (!isOooOptedIn(credentials)) return null;

    const auth = new google.auth.OAuth2();
    // Static token only — no refresh_token, so googleapis will not POST
    // oauth2.googleapis.com/token. Far-future expiry_date is belt-and-
    // suspenders in case a googleapis version treats a missing expiry as
    // "expired, refresh now".
    auth.setCredentials({
      access_token: ONECLI_ACCESS_TOKEN,
      expiry_date: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    return google.calendar({ version: 'v3', auth });
  }

  const { clientId, clientSecret, refreshToken } = credentials;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  return google.calendar({ version: 'v3', auth });
}

/**
 * Whether OOO / Google Calendar is opted in under the current env.
 * Used by createGCalClient and by sync.mjs skip messaging.
 */
export function isOooOptedIn(credentials = {}) {
  if (process.env.ONECLI_URL) {
    const flag = process.env.ENABLE_OOO;
    if (flag === '0' || flag === 'false') return false;
    if (flag === '1' || flag === 'true') return true;
    // Convenience: presence of the three Google env placeholders still
    // means "I want OOO; gateway holds the real auth".
    const { clientId, clientSecret, refreshToken } = credentials;
    return Boolean(clientId && clientSecret && refreshToken);
  }
  const { clientId, clientSecret, refreshToken } = credentials;
  return Boolean(clientId && clientSecret && refreshToken);
}

/**
 * Human-readable reason OOO is skipped (when createGCalClient returns null).
 * Distinguishes OneCLI opt-in from missing local OAuth credentials.
 */
export function oooSkipReason(credentials = {}) {
  if (process.env.ONECLI_URL) {
    const flag = process.env.ENABLE_OOO;
    if (flag === '0' || flag === 'false') {
      return 'OOO disabled under OneCLI (ENABLE_OOO=0)';
    }
    return 'OOO not opted in under OneCLI (set ENABLE_OOO=1, or set GOOGLE_* placeholders as opt-in markers)';
  }
  return 'Google Calendar credentials not configured';
}

export { ONECLI_ACCESS_TOKEN };

/**
 * List existing [TripIt OOO] events in Google Calendar.
 * Returns array of { id, summary, startDate, endDate }.
 */
export async function listOooEvents(gcal, calendarId) {
  const events = [];
  let pageToken;

  do {
    const res = await gcal.events.list({
      calendarId,
      eventTypes: ['outOfOffice'],
      singleEvents: true,
      timeMin: new Date().toISOString(),
      maxResults: 250,
      pageToken,
    });

    for (const ev of res.data.items || []) {
      if (!ev.summary?.startsWith(OOO_PREFIX)) continue;

      const startRaw = ev.start?.date || ev.start?.dateTime;
      const endRaw = ev.end?.date || ev.end?.dateTime;
      if (!startRaw || !endRaw) continue;

      // OOO events use dateTime, which Google returns in local timezone.
      // Parse to Date and format as UTC YYYY-MM-DD for consistent comparison.
      events.push({
        id: ev.id,
        summary: ev.summary,
        startDate: new Date(startRaw).toISOString().slice(0, 10),
        endDate: new Date(endRaw).toISOString().slice(0, 10),
      });
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return events;
}

/**
 * Create an OOO event in Google Calendar.
 * Google Calendar API requires OOO events to use dateTime (not date),
 * so we span midnight-to-midnight UTC.
 * @param {Object} opts - { summary, startDate, endDate } where dates are YYYY-MM-DD
 * @returns {string} The created event's ID
 */
export async function createOooEvent(gcal, calendarId, { summary, startDate, endDate }) {
  const res = await gcal.events.insert({
    calendarId,
    requestBody: {
      summary: `${OOO_PREFIX}${summary}`,
      start: { dateTime: `${startDate}T00:00:00Z` },
      end: { dateTime: `${endDate}T00:00:00Z` },
      eventType: 'outOfOffice',
      outOfOfficeProperties: {
        autoDeclineMode: 'declineNone',
      },
      transparency: 'opaque',
      visibility: 'public',
    },
  });

  return res.data.id;
}

/**
 * Delete an OOO event from Google Calendar.
 */
export async function deleteOooEvent(gcal, calendarId, eventId) {
  await gcal.events.delete({ calendarId, eventId });
}

export { OOO_PREFIX };
