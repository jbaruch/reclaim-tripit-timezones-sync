# TripIt → Reclaim.ai Travel Timezone Sync

Automatically syncs travel timezones from your TripIt trips to [Reclaim.ai](https://reclaim.ai), so your scheduling links, habits, and working hours all adjust to wherever you're traveling.

Parses your TripIt iCal feed to extract flight arrival timezones, builds timezone segments for each trip, and pushes them to Reclaim's travel timezone settings via REST API. Runs daily in a Docker container.

## How it works

1. Fetches your TripIt iCal calendar feed
2. Identifies trip-level events (date ranges) and flight events (arrival timezones)
3. Extracts timezone from each flight's arrival description (e.g., `2:10 PM CEST\nArrive Paris (CDG)`)
4. For trips without flights, falls back to geo-coordinate lookup
5. Filters to future segments, deduplicates consecutive same-timezone periods
6. Clears existing Reclaim travel timezone entries and creates new ones

## Setup

### 1. Get your TripIt iCal feed URL

1. Go to [tripit.com](https://www.tripit.com) and log in
2. Navigate to **Settings** (gear icon) → **Calendar Feed**
3. Enable the iCal feed if not already enabled
4. Copy the **private feed URL** — it looks like:
   ```
   https://www.tripit.com/feed/ical/private/XXXXXXXX-XXXXXXXXXXXXXXXXXXXX/tripit.ics
   ```

### 2. Get your Reclaim.ai API token

1. Go to [app.reclaim.ai/settings/developer](https://app.reclaim.ai/settings/developer)
2. Generate a new API key
3. Copy the token

### 3. Run with Docker

```bash
docker run -d \
  --name tripit-reclaim-sync \
  --restart unless-stopped \
  -e TRIPIT_ICAL_URL="https://www.tripit.com/feed/ical/private/YOUR-FEED-ID/tripit.ics" \
  -e RECLAIM_API_TOKEN="your-reclaim-api-token" \
  tripit-reclaim-sync
```

The container syncs immediately on startup, then daily at 3:00 AM.

If you're using a NAS or other Docker UI (Portainer, Synology, UGREEN, etc.), the two required environment variables will appear pre-populated in the container creation form — just fill in the values.

### Build the image

```bash
docker build -t tripit-reclaim-sync .
```

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

### Alternative: Deploy on AWS

For a serverless deployment that runs as a scheduled ECS Fargate task (~$0.01/month), see [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md).

## Running locally (without Docker)

```bash
npm install

# Dry run — shows what would be synced without making changes
TRIPIT_ICAL_URL="..." RECLAIM_API_TOKEN="..." node sync.mjs dry-run

# Full sync
TRIPIT_ICAL_URL="..." RECLAIM_API_TOKEN="..." node sync.mjs sync
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TRIPIT_ICAL_URL` | Yes | Your private TripIt iCal feed URL |
| `RECLAIM_API_TOKEN` | Yes | Reclaim.ai API token |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for change notifications (from [@BotFather](https://t.me/BotFather)) |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID to send notifications to |
