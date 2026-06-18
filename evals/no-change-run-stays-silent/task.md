# Process Nightly Sync Results

## Problem/Feature Description

A team runs the TripIt-to-Reclaim sync every night at 2am via cron. The post-sync step is an agent that reads the JSON output and decides whether the team needs to be notified. Most nights, nothing changes — and the team has been very clear that they do NOT want "all clear" messages cluttering their Slack channel.

Two sync runs completed overnight. Process both outputs and decide what, if anything, to report. Write your decision to `notification-decision.md`.

## Input Files

The following files are provided as inputs. Extract them before beginning.

=============== FILE: run-1-output.json ===============
{
  "mode": "sync",
  "noChanges": true,
  "timezoneChanges": [],
  "segments": [
    { "timezone": "America/Chicago", "from": "2026-04-07", "to": "2026-04-11", "label": "KubeCon - Austin" },
    { "timezone": "Europe/Berlin", "from": "2026-04-22", "to": "2026-04-26", "label": "Open Source Summit - Amsterdam" }
  ],
  "ooo": { "created": 0, "deleted": 0, "setToP2": 0 },
  "conflicts": [],
  "errors": []
}

=============== FILE: run-2-output.json ===============
{
  "mode": "sync",
  "noChanges": true,
  "timezoneChanges": [],
  "segments": [
    { "timezone": "America/Chicago", "from": "2026-04-07", "to": "2026-04-11", "label": "KubeCon - Austin" }
  ],
  "ooo": null,
  "conflicts": [],
  "errors": []
}
