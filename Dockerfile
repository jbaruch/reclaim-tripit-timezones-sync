FROM node:22-alpine

ENV TRIPIT_ICAL_URL=""
ENV RECLAIM_API_TOKEN=""
ENV TELEGRAM_BOT_TOKEN=""
ENV TELEGRAM_CHAT_ID=""
ENV SNS_TOPIC_ARN=""
ENV GOOGLE_CLIENT_ID=""
ENV GOOGLE_CLIENT_SECRET=""
ENV GOOGLE_REFRESH_TOKEN=""
ENV TRIPIT_IGNORE_TRIPS=""
ENV TRIPIT_IGNORE_KEYWORDS=""

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Run sync once at startup, then daily at 3:00 AM via crond
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
