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
 * Normalize ENABLE_OOO env values. Case-insensitive for true/false;
 * also accepts 1/0. Returns 'on' | 'off' | null (unset / unrecognized).
 */
function enableOooFlag() {
  const raw = process.env.ENABLE_OOO;
  if (raw == null || raw === '') return null;
  const flag = String(raw).trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return 'off';
  if (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') return 'on';
  return null;
}

/**
 * Whether OOO / Google Calendar is opted in under the current env.
 * Used by createGCalClient and by sync.mjs skip messaging.
 */
export function isOooOptedIn(credentials = {}) {
  if (process.env.ONECLI_URL) {
    const flag = enableOooFlag();
    if (flag === 'off') return false;
    if (flag === 'on') return true;
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
    if (enableOooFlag() === 'off') {
      return 'OOO disabled under OneCLI (ENABLE_OOO=0)';
    }
    return 'OOO not opted in under OneCLI (set ENABLE_OOO=1, or set GOOGLE_* placeholders as opt-in markers)';
  }
  return 'Google Calendar credentials not configured';
}

export { ONECLI_ACCESS_TOKEN };

/**
 * Whether `tz` is an IANA zone Intl accepts. `resolveHomeTimezone` only trims its
 * input, so a typo'd HOME_TZ reaches here; an invalid zone makes Intl throw a
 * RangeError, which must not abort the sync — callers fall back to UTC instead.
 * Only RangeError (the invalid-zone signal) is swallowed; anything else rethrows.
 */
function isValidTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

/**
 * A resolver for the home-local calendar date (YYYY-MM-DD) an OOO boundary reads
 * as. Google returns OOO `dateTime` in the calendar's zone; formatting the instant
 * in the home tz yields the date the block reads as there, so reconciliation
 * compares like-for-like and a legacy UTC-midnight block (which lands the evening
 * before in a behind-UTC home zone) is seen as changed and migrated to home
 * midnight. Builds one formatter per run (reused across every boundary). With no
 * valid home tz, resolves to the UTC date (the prior behavior).
 */
function makeOooDateResolver(timeZone) {
  const fmt = isValidTimeZone(timeZone)
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    : null;
  return (raw) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw; // all-day `date` value
    return fmt ? fmt.format(new Date(raw)) : new Date(raw).toISOString().slice(0, 10);
  };
}

/**
 * List existing [TripIt OOO] events in Google Calendar.
 * Returns array of { id, summary, startDate, endDate }. `timeZone` is the home tz
 * the dates are resolved in (see makeOooDateResolver); omit or pass an invalid
 * zone for the UTC-date fallback.
 */
export async function listOooEvents(gcal, calendarId, timeZone) {
  const events = [];
  const toLocalDate = makeOooDateResolver(timeZone);
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

      // Resolve each boundary to its home-local calendar date so it compares
      // like-for-like against the desired trip dates.
      events.push({
        id: ev.id,
        summary: ev.summary,
        startDate: toLocalDate(startRaw),
        endDate: toLocalDate(endRaw),
      });
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return events;
}

/**
 * Create an OOO event in Google Calendar.
 * Google Calendar API requires OOO events to use dateTime (not date). We anchor
 * the block at LOCAL midnight in the home timezone (`timeZone` + a zone-naive
 * `T00:00:00`), so it reads as a clean whole-day block. Anchoring at UTC midnight
 * instead renders as the evening before in a behind-UTC home zone (00:00Z shows
 * as 19:00 the prior day in America/Chicago). When no home tz is known we fall
 * back to UTC midnight (the prior behavior).
 * @param {{ summary: string, startDate: string, endDate: string, timeZone?: string }} opts
 *   dates are YYYY-MM-DD; timeZone is the home IANA zone (optional — UTC fallback)
 * @returns {Promise<string>} The created event's ID
 */
export async function createOooEvent(gcal, calendarId, opts) {
  const { summary, startDate, endDate, timeZone } = opts;
  // A valid home tz anchors at local midnight; an absent or typo'd zone (Intl /
  // Google would reject it) falls back to UTC midnight rather than failing.
  const homeTz = isValidTimeZone(timeZone) ? timeZone : null;
  const at = (date) =>
    homeTz ? { dateTime: `${date}T00:00:00`, timeZone: homeTz } : { dateTime: `${date}T00:00:00Z` };
  const res = await gcal.events.insert({
    calendarId,
    requestBody: {
      summary: `${OOO_PREFIX}${summary}`,
      start: at(startDate),
      end: at(endDate),
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
