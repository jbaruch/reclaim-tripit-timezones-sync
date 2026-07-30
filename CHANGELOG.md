# Changelog

## Unreleased

- OOO calendar blocks are now anchored at **home-local midnight** instead of
  UTC midnight. A UTC-midnight block renders as the evening before in a
  behind-UTC home zone (00:00Z shows as 19:00 the prior day in
  `America/Chicago`); `createOooEvent` now emits a zone-naive `T00:00:00` plus
  the home `timeZone` (resolved via `resolveHomeTimezone`), falling back to UTC
  midnight only when no home tz is known. `listOooEvents` resolves each existing
  block's date in the home tz, so legacy UTC-midnight blocks are seen as changed
  and migrated to home midnight on the next sync.
- Optional OneCLI / MITM credential-gateway mode, gated on `ONECLI_URL`.
  When set (via `onecli run`), outbound HTTP routes through `HTTPS_PROXY`,
  TripIt iCal is fetched via proxied global `fetch`, Google Calendar uses a
  static placeholder Bearer with no client-side OAuth refresh, and placeholder
  TripIt/Reclaim credentials are accepted for gateway injection. No behavior
  change when `ONECLI_URL` is unset. Adds `undici` dependency and `lib/proxy.mjs`.

## 0.3.3 — 2026-06-18

- Onboarding skill is now autonomous-first: it resolves the credentials
  source file from an explicitly provided path or common locations and
  acts on it directly, only asking the user when nothing is discoverable.
  Previously it always stopped to ask first, which stalled autonomous
  agents when the file was already available. The "never read/echo
  credential values" guardrail is unchanged.

## 0.3.2 — 2026-06-18

- Stop creating redundant travel-timezone overrides that just restate the
  home timezone (e.g. Central→Central for domestic trips). Reclaim already
  falls back to the home timezone wherever no override applies, so those
  entries were noise. The home timezone is read from the `HOME_TZ` env var
  when set, otherwise from Reclaim's account `defaultTimezone`. Adds a
  `homeTimezone` field to the JSON output. Dry-run now also queries Reclaim,
  so it reports the exact segment list sync would push and validates the
  Reclaim token.

## 0.3.1 — 2026-06-18

- Repackaged from the Tessl *tile* format to the *plugin* format. The
  manifest moved to `.tessl-plugin/plugin.json`; rules and skills now live
  at the repo root and are discovered by convention. Sync behavior is
  unchanged. Publishing is handled by `tessl plugin publish` via the
  `publish-plugin` workflow (the in-skill install URL now pins `v0.3.1`).

## 0.3.0 — 2026-05-11

- Every segment in the JSON output now carries both date-only
  (`from`/`to`) and ISO 8601 UTC datetime (`from_dt`/`to_dt`)
  boundaries. Date-only fields are preserved verbatim for the Reclaim
  API contract; datetime fields are for sub-day-aware downstream
  consumers that need to resolve the active timezone at actual flight
  arrival or check-in time, not at UTC midnight of the boundary date.
  Fixes a downstream walker bug where the active timezone could flip
  hours before the user actually arrived in the new zone.
- `deduplicateSegments` now uses datetime for sort, overlap detection,
  merge advance, and the empty-segment filter (date-only fallback for
  legacy callers). Same-calendar-date overlaps are now correctly
  clipped instead of slipping through.

## 0.2.0 — 2026-05-02

- Lodging is now the primary signal for timezone segments. Where the user
  sleeps determines their timezone; flights only fill pre-first-checkin,
  between-stay, and post-last-checkout gaps. Fixes the case where
  companion-traveler flights to a different destination would override
  the user's actual lodging in Reclaim.
- TripIt trip ID is now the authoritative trip↔event association. Every
  extractor parses the trip ID from the iCal description URL and the
  segment builder filters by ID match. Removes a series of date-overlap
  heuristics that previously bridged the gap.
- Sync library is now installed from a pinned tag URL
  (`v<version>.tar.gz`) instead of `main.tar.gz`, so an agent's copy of
  the library matches the version it expects.

## 0.1.0 — Initial release
