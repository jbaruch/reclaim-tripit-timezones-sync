# Changelog

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
