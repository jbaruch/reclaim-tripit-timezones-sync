# TripIt → Reclaim.ai Travel Timezone Sync

Automatically syncs travel timezones from your TripIt trips to [Reclaim.ai](https://reclaim.ai), so your scheduling links, habits, and working hours all adjust to wherever you're traveling.

Parses your TripIt iCal feed to extract timezones from flights and hotel stays, builds timezone segments for each trip, and pushes them to Reclaim's travel timezone settings via REST API. Optionally notifies via Telegram when changes are detected.

## How it works

1. Fetches your TripIt iCal calendar feed
2. Identifies trip-level events (date ranges), flights, and hotel/lodging stays
3. Builds timezone segments using a priority chain: flights → hotel stays → trip-level geo-coordinates
4. For hotels, disambiguates timezone abbreviations (CST, IST, EST) using the location's country
5. Filters to future segments, deduplicates consecutive same-timezone periods
6. Skips sync if nothing changed; otherwise clears existing Reclaim entries and creates new ones
7. Sends a Telegram notification when timezone overrides change (if configured)

## Prerequisites

### Get your TripIt iCal feed URL

1. Go to [tripit.com](https://www.tripit.com) and log in
2. Navigate to **Settings** (gear icon) → **Calendar Feed**
3. Enable the iCal feed if not already enabled
4. Copy the **private feed URL** — it looks like:
   ```
   https://www.tripit.com/feed/ical/private/XXXXXXXX-XXXXXXXXXXXXXXXXXXXX/tripit.ics
   ```

### Get your Reclaim.ai API token

1. Go to [app.reclaim.ai/settings/developer](https://app.reclaim.ai/settings/developer)
2. Generate a new API key
3. Copy the token

## Deployment options

### Run locally

```bash
npm install

# Dry run — shows what would be synced without making changes
TRIPIT_ICAL_URL="..." RECLAIM_API_TOKEN="..." node sync.mjs dry-run

# Full sync
TRIPIT_ICAL_URL="..." RECLAIM_API_TOKEN="..." node sync.mjs sync

# JSON output (for scripts, agents, or automation)
TRIPIT_ICAL_URL="..." RECLAIM_API_TOKEN="..." node sync.mjs sync --output=json
```

The `--output=json` flag works with both `dry-run` and `sync` modes. When set, the script outputs a single JSON object to stdout instead of human-readable text:

```json
{
  "mode": "sync",
  "noChanges": false,
  "timezoneChanges": [
    { "action": "create", "timezone": "America/Chicago", "from": "2026-04-01", "to": "2026-04-05" }
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

Human-readable output remains the default.

### Run with Docker

Build the image:

```bash
docker build -t tripit-reclaim-sync .
```

Run the container:

```bash
docker run -d \
  --name tripit-reclaim-sync \
  --restart unless-stopped \
  -e TRIPIT_ICAL_URL="https://www.tripit.com/feed/ical/private/YOUR-FEED-ID/tripit.ics" \
  -e RECLAIM_API_TOKEN="your-reclaim-api-token" \
  tripit-reclaim-sync
```

The container syncs immediately on startup, then daily at 3:00 AM.

If you're using a NAS or other Docker UI (Portainer, Synology, UGREEN, etc.), the environment variables will appear pre-populated in the container creation form — just fill in the values.

For a NAS or remote host with a different architecture, build for the target platform:

```bash
# For x86_64 NAS (Intel/AMD)
docker buildx build --platform linux/amd64 -t tripit-reclaim-sync .

# Export as tar.gz to transfer to the NAS
docker save tripit-reclaim-sync | gzip > tripit-reclaim-sync.tar.gz
```

On the NAS, load and run:

```bash
docker load < tripit-reclaim-sync.tar.gz
```

### Deploy on AWS

For a serverless deployment that runs as a scheduled ECS Fargate task (~$0.01/month), see [AWS_DEPLOYMENT.md](https://github.com/jbaruch/reclaim-tripit-timezones-sync/blob/main/AWS_DEPLOYMENT.md).

### Run as an AI agent tile

Install the [Tessl](https://tessl.io) tile to let any AI agent run the sync on your behalf:

```bash
tessl install jbaruch/reclaim-tripit-sync
```

The tile provides two skills:
- **`sync-tripit`** — runs the sync with `--output=json`, interprets the result, and reports changes (or stays silent if nothing changed)
- **`onboard-tripit-reclaim`** — guided credential setup with dry-run validation

The agent downloads and installs the sync tool on first use — no pre-configuration needed beyond setting your environment variables. Telegram and SNS notification variables are not needed when running as a tile; the agent handles reporting.

## OOO calendar blocks (optional)

Automatically creates Google Calendar Out-of-Office events for every future TripIt trip and sets their Reclaim priority to P2 (high) instead of the default P1 (critical).

### Why you'd want this

Reclaim scheduling links respect priority levels. Google Calendar's built-in OOO events sync to Reclaim as P1 (critical), which means ALL your scheduling links treat those days as unavailable. That's usually fine — except when it isn't.

By creating our own OOO events at P2 priority, you get a useful split:
- **Regular scheduling links** (default priority) — still see the OOO blocks, still respect your travel days
- **A special "critical-only" scheduling link** — sees P2 blocks as available time, lets people book through travel days

Use case: you're traveling but technically reachable. You want a booking link that says "I'm on a plane but sure, let's talk" for important meetings, while your regular links still show you as out of office.

### How to configure Reclaim scheduling links

1. In Reclaim → **Scheduling Links** → create or edit a link
2. Set **Availability** or **Minimum priority** to **Critical**
3. This link will ignore P2 (high) OOO blocks and show those days as bookable
4. Regular links at default priority still respect the OOO blocks

### How to get Google Calendar API credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project (or use an existing one)
2. Enable the **Google Calendar API** (APIs & Services → Library → search "Google Calendar API" → Enable)
3. Create **OAuth 2.0 credentials**:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Desktop app**
   - Note the **Client ID** and **Client Secret**
4. Configure the **OAuth consent screen** (APIs & Services → OAuth consent screen) — "External" is fine for personal use, just add yourself as a test user
5. Get a **refresh token** — run this one-time auth flow:
   ```bash
   # Open this URL in your browser (replace YOUR_CLIENT_ID):
   # https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/calendar&access_type=offline&prompt=consent

   # After authorizing, you'll be redirected to localhost with a ?code= parameter
   # Exchange that code for tokens:
   curl -s -X POST https://oauth2.googleapis.com/token \
     -d "code=AUTH_CODE_FROM_REDIRECT" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "redirect_uri=http://localhost" \
     -d "grant_type=authorization_code" | jq .refresh_token
   ```
6. Set the three environment variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`

The feature auto-activates when all three are present. If any are missing, OOO sync is silently skipped.

### How it works

On each sync run (after timezone sync):
1. Gets future trips from TripIt
2. Lists existing `[TripIt OOO]` events in Google Calendar
3. Creates missing OOO events, deletes stale ones (trip removed or dates changed)
4. Searches Reclaim for the synced OOO events and sets their priority to P2
5. If Reclaim hasn't synced the new Google Calendar events yet, the next run catches them

The events show up in Google Calendar as proper OOO events with `autoDeclineMode: declineNone` — they mark your calendar as out-of-office without auto-declining meeting invites.

## Ignoring trips (optional)

Some trips in TripIt don't need timezone sync or OOO blocks — family members traveling without you, trips you're tracking for logistics but not attending. Two env vars let you skip them:

- **`TRIPIT_IGNORE_TRIPS`** — comma-separated trip names (case-insensitive substring match)
- **`TRIPIT_IGNORE_KEYWORDS`** — comma-separated keywords that match against any trip name

```bash
# Skip a specific trip
TRIPIT_IGNORE_TRIPS="Family trip to Paris"

# Skip any trip with a family member's name in it
TRIPIT_IGNORE_KEYWORDS=alice,daniel,nicole
```

Ignored trips are excluded from both timezone segments and OOO calendar blocks. Their flights and lodging data won't leak into other trips' segments.

## Telegram notifications (optional)

Get notified when timezone overrides change. To set up:

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the bot token
2. Send any message to your bot, then get your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` environment variables

When configured, you'll receive a message listing the new timezone overrides whenever the sync detects changes. If the variables are not set, notifications are silently skipped.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TRIPIT_ICAL_URL` | Yes | Your private TripIt iCal feed URL |
| `RECLAIM_API_TOKEN` | Yes | Reclaim.ai API token |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for change notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID to send notifications to |
| `GOOGLE_CLIENT_ID` | No | Google OAuth2 client ID (enables OOO blocks) |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | No | Google OAuth2 refresh token |
| `TRIPIT_IGNORE_TRIPS` | No | Comma-separated trip names to ignore (case-insensitive substring match) |
| `TRIPIT_IGNORE_KEYWORDS` | No | Comma-separated keywords — any trip whose name contains one matches |

## Releasing a new version

The tile is versioned (see `.tile/CHANGELOG.md`). The agent install URL in
`skills/sync-tripit/SKILL.md` points at a tagged tarball, so installs pull
the exact version the tile expects rather than whatever happens to be on
`main`.

To cut a release:

```bash
# 1. Bump version + propagate to SKILL.md, eval criteria, research.md
.tile/scripts/bump-version.sh 0.3.0

# 2. Add an entry to .tile/CHANGELOG.md, commit, open a PR, merge

# 3. Tag the merge commit on main
git checkout main && git pull
git tag v0.3.0
git push origin v0.3.0
```

The tag is what the install URL resolves to — pushing it makes the new
version installable. Any agent tile that has already been installed from
an earlier tag continues to work; only fresh installs pick up the new
version.
