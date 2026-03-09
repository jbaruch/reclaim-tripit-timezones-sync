FROM node:22-alpine

ENV TRIPIT_ICAL_URL=""
ENV RECLAIM_API_TOKEN=""
ENV TELEGRAM_BOT_TOKEN=""
ENV TELEGRAM_CHAT_ID=""

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Run sync once at startup, then daily at 3:00 AM via crond
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
