#!/bin/sh
set -e

# Run sync immediately on startup
echo "=== Initial sync at $(date) ==="
node /app/sync.mjs sync || true

# Write env vars into the cron job so crond can access them
cat > /etc/crontabs/root <<EOF
# Run sync daily at 3:00 AM
0 3 * * * TRIPIT_ICAL_URL="$TRIPIT_ICAL_URL" RECLAIM_API_TOKEN="$RECLAIM_API_TOKEN" TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" TELEGRAM_CHAT_ID="$TELEGRAM_CHAT_ID" /usr/local/bin/node /app/sync.mjs sync >> /proc/1/fd/1 2>> /proc/1/fd/2
EOF

echo "=== Cron scheduled: daily at 3:00 AM ==="

# Start crond in foreground (log level 8 = errors only, avoids leaking env vars in logs)
exec crond -f -l 8
