# Changelog

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
