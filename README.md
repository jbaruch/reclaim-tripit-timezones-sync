# TripIt → Reclaim.ai Travel Timezone Sync

Automatically syncs travel timezones from your TripIt trips to [Reclaim.ai](https://reclaim.ai), so your working hours adjust to wherever you're traveling.

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

1. Go to [app.reclaim.ai](https://app.reclaim.ai) and log in
2. Navigate to **Settings** → **Integrations** → **API**
3. Generate a new API key
4. Copy the token

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

### Build the image

```bash
docker build -t tripit-reclaim-sync .
```

## Running locally (without Docker)

```bash
npm install

# Dry run — shows what would be synced without making changes
TRIPIT_ICAL_URL="..." RECLAIM_API_TOKEN="..." node sync.mjs dry-run

# Full sync
TRIPIT_ICAL_URL="..." RECLAIM_API_TOKEN="..." node sync.mjs sync
```

## Environment variables

| Variable | Description |
|---|---|
| `TRIPIT_ICAL_URL` | Your private TripIt iCal feed URL |
| `RECLAIM_API_TOKEN` | Reclaim.ai API token |
