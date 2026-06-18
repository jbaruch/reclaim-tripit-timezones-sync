# TripIt-Reclaim Sync Rules

**Never implement sync logic yourself.** Always run `sync.mjs` via the provided skill. The sync is deterministic code — your role is to execute the script and interpret its structured JSON output. Do not call TripIt or Reclaim APIs directly, do not reconstruct timezone logic, do not improvise.

When reporting sync results:
- **No changes** → stay silent, do not send a message
- **Changes detected** → summarize what changed (new timezones, OOO blocks created/deleted)
- **Overlapping trips** → flag as a warning with trip names and conflicting dates
- **Errors** → report the error message with context
