# Interpret and Report a Travel Sync Run

## Problem/Feature Description

A DevOps engineer maintains a TripIt-to-Reclaim sync pipeline that runs nightly. This morning's run produced JSON output that needs to be summarized for the team Slack channel. The team doesn't want noise — only tell them about things that matter.

Analyze the JSON output and produce a file named `sync-report.md` with an appropriate summary.

## Input Files

The following files are provided as inputs. Extract them before beginning.

=============== FILE: sync-output.json ===============
{
  "mode": "sync",
  "noChanges": false,
  "timezoneChanges": [
    { "action": "create", "timezone": "America/Chicago", "from": "2026-04-07", "to": "2026-04-11" },
    { "action": "create", "timezone": "Europe/Berlin", "from": "2026-04-22", "to": "2026-04-26" },
    { "action": "delete", "timezone": "Asia/Singapore", "from": "2026-03-10", "to": "2026-03-14" }
  ],
  "segments": [
    { "timezone": "America/Chicago", "from": "2026-04-07", "to": "2026-04-11", "label": "KubeCon - Austin" },
    { "timezone": "Europe/Berlin", "from": "2026-04-22", "to": "2026-04-26", "label": "Open Source Summit - Amsterdam" }
  ],
  "ooo": { "created": 2, "deleted": 1, "setToP2": 2 },
  "conflicts": [
    { "trip1": "Open Source Summit", "trip2": "PlatformCon", "overlap": "2026-04-24" }
  ],
  "errors": ["WARNING: Failed to set priority for \"[TripIt OOO] PlatformCon\": 404 Not Found"]
}
