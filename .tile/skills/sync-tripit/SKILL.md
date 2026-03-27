---
name: sync-tripit
description: >
  Run the TripIt→Reclaim travel timezone sync and interpret its JSON output.
  Handles no-change silence, change summaries, overlap warnings, and errors.
  Use when the user asks to sync time zones, update Reclaim from TripIt,
  check travel schedule sync, or run the calendar timezone update.
---

# Sync TripIt → Reclaim

## Step 1: Ensure the sync library is installed

```bash
if [ ! -f /opt/tripit-reclaim/sync.mjs ]; then
  curl -sL https://github.com/jbaruch/reclaim-tripit-timezones-sync/archive/refs/heads/main.tar.gz \
    | tar xz -C /opt/
  mv /opt/reclaim-tripit-timezones-sync-main /opt/tripit-reclaim
  cd /opt/tripit-reclaim && npm ci --omit=dev
fi
```

Verify installation succeeded:

```bash
node -e "require('/opt/tripit-reclaim/sync.mjs')" 2>/dev/null || node /opt/tripit-reclaim/sync.mjs --help 2>&1 | head -1
```

If `/opt/tripit-reclaim/sync.mjs` does not exist after the install step, report the download failure and stop.

## Step 2: Run the sync

```bash
[ -f /opt/tripit-reclaim/.env ] && set -a && source /opt/tripit-reclaim/.env && set +a
node /opt/tripit-reclaim/sync.mjs sync --output=json
```

Capture the full stdout (JSON) and the exit code. Stderr may contain human-readable diagnostics on failure.

## Step 3: Parse the JSON output

The script outputs a single JSON object to stdout:

```json
{
  "mode": "sync",
  "noChanges": true,
  "timezoneChanges": [
    { "action": "create", "timezone": "America/Chicago", "from": "2026-04-01", "to": "2026-04-05" },
    { "action": "delete", "timezone": "Europe/Berlin", "from": "2026-03-20", "to": "2026-03-25" }
  ],
  "segments": [
    { "timezone": "America/Chicago", "from": "2026-04-01", "to": "2026-04-05", "label": "KubeCon - Austin" }
  ],
  "ooo": { "created": 2, "deleted": 1, "setToP2": 1 },
  "conflicts": [
    { "trip1": "KubeCon", "trip2": "DevOps Days", "overlap": "2026-04-03" }
  ],
  "errors": []
}
```

## Step 4: Decide what to report

**Silent (send nothing):**
- `noChanges` is `true` AND `errors` is empty AND `conflicts` is empty

**Report changes:**
- `noChanges` is `false` → summarize `timezoneChanges` (group creates, mention deletes)
- `ooo` is not null and has non-zero counts → mention OOO blocks created/deleted/prioritized
- `conflicts` is non-empty → warn about overlapping trips with names and dates

**Report errors:**
- `errors` is non-empty OR exit code is 1 → report the error messages
- If the error is a network/timeout failure, retry once before reporting

## Environment variables

Mandatory: `TRIPIT_ICAL_URL`, `RECLAIM_API_TOKEN`. Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (all three for OOO blocks), `TRIPIT_IGNORE_TRIPS`, `TRIPIT_IGNORE_KEYWORDS`, `OOO_RETRY_DELAY_MS`. Telegram and SNS variables are not needed — the agent handles reporting. See the `onboard-tripit-reclaim` skill for setup details.
