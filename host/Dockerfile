# dyno-lite host runner — a long-lived container that keeps Discord bots online.
# Build from the repository root so the bot source ships with it:
#
#   docker build -f host/Dockerfile -t dyno-lite-runner .
#   docker run -d --restart=always \
#     -e DASHBOARD_URL=https://your-app.vercel.app \
#     -e HOST_KEY=your-host-key \
#     -e DATABASE_URL=$DATABASE_URL \
#     -p 3100-3200:3100-3200 dyno-lite-runner

FROM node:22-slim

# libssl is required by better-sqlite3 / pg native bits on slim images
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bot/package.json bot/package-lock.json* ./bot/
RUN cd bot && npm install --omit=dev --no-audit --no-fund

COPY host ./host
COPY bot ./bot

WORKDIR /app/host
ENV NODE_ENV=production BOT_DIR=/app/bot
CMD ["node", "runner.js"]
