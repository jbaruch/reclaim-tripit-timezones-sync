---
name: onboard-tripit-reclaim
description: >
  Guided setup for TripIt→Reclaim travel timezone sync credentials.
  Validates environment variables and runs a dry-run to confirm everything works.
  Use when the user wants to set up, configure, or troubleshoot the TripIt to
  Reclaim calendar sync, API keys, or integration connection.
---

# Onboard TripIt-Reclaim Sync

## Step 1: Check for existing `.env` file

Ask the user: "Do you have a `.env` file for this tool? If so, provide the path and I'll read it."

If the file exists, read and parse it. Extract only the relevant variables (see table below). Skip Telegram and SNS variables — the agent handles notifications.

If no file exists, fall back to interactive prompting for the mandatory variables first, then offer optional ones.

## Step 2: Validate mandatory variables

These two must be present:

| Variable | How to get it |
|---|---|
| `TRIPIT_ICAL_URL` | TripIt → Settings → iCal Feeds → Private URL |
| `RECLAIM_API_TOKEN` | Reclaim.ai → Settings → Integrations → API → Generate Token |

If either is missing, explain where to find it and ask the user to provide it.

## Step 3: Check optional features

| Feature | Variables needed | What to tell the user |
|---|---|---|
| Google Calendar OOO blocks | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | "Want OOO calendar blocks for travel? I need Google OAuth2 credentials. See [Google Calendar setup](https://github.com/jbaruch/reclaim-tripit-timezones-sync#google-calendar-ooo-blocks) in the repo README." |
| Trip filtering | `TRIPIT_IGNORE_TRIPS`, `TRIPIT_IGNORE_KEYWORDS` | "Any trips in TripIt you want to exclude from syncing? Give me names or keywords." |
| Retry tuning | `OOO_RETRY_DELAY_MS` | Only mention if the user reports OOO priority issues. Default (60s) works for most setups. |

All three Google variables must be present together. If only some are set, warn that OOO blocks won't work.

## Step 4: Store credentials

Write the validated variables to `/opt/tripit-reclaim/.env` in standard dotenv format (`KEY=value`, one per line). The `sync-tripit` skill sources this file before running the sync.

```bash
mkdir -p /opt/tripit-reclaim
cat > /opt/tripit-reclaim/.env << 'EOF'
TRIPIT_ICAL_URL=<value>
RECLAIM_API_TOKEN=<value>
# ... optional vars ...
EOF
chmod 600 /opt/tripit-reclaim/.env
```

## Step 5: Verify with dry-run

Run the sync in dry-run mode to confirm credentials work:

```bash
node /opt/tripit-reclaim/sync.mjs dry-run --output=json
```

Parse the JSON output:
- `errors` is empty → credentials are valid, report which features are active
- `errors` is non-empty → report the specific error and ask the user to fix credentials

## Variables to skip

These are irrelevant when running as a tile (the agent handles output):

| Variable | Why skip |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Agent is the notification layer |
| `TELEGRAM_CHAT_ID` | Agent is the notification layer |
| `SNS_TOPIC_ARN` | AWS-only deployment model |
| `AWS_REGION` | AWS-only deployment model |

**Never ask the user to paste tokens directly into chat.** Use file-based input or the container's credential store.
