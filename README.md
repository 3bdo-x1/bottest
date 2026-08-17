# dyno-lite — bot hosting panel + 24/7 supervisor

BotGhost-style website: a server owner pastes their **bot token**, the site verifies it with
Discord, stores it encrypted, and a host runner keeps the bot **online 24/7** — with a full
no-code dashboard for automod, log channels, welcome messages, media-only/counting/admin/bot
command/auto-meme channels, starboard, levels and 49 commands.

```
you ──▶ dashboard on Vercel (src/)         token login, config UI, status + logs
         │ POST /api/auth/token            verify + AES-256-GCM encrypt, mark "running"
         │ GET  /api/host                  status · rss · pid · restarts · live logs · start/stop
         │ GET  /api/host/keepalive        vercel.json cron (*/5) flags dead runners
host runner (host/runner.js)               runs 24/7 on Railway/Render/Fly/VPS/Docker
         │ POST /api/host/claim            "which bots should run?"  (x-host-key)
         │ POST /api/host/heartbeat        status · rss · pid · logs
         └─▶ spawn node bot/index.js per bot, restart with backoff, detect revoked tokens
bot (bot/)                                 discord.js v14, Postgres, 49 commands, channel systems
```

## Deploy

**1. Website on Vercel**

```bash
vercel                       # imports this repo as-is
```
Environment variables: `DATABASE_URL` (any Postgres — Neon/Supabase/RDS), `HOST_KEY` (any long
random string), `SESSION_SECRET`, `ENCRYPTION_KEY` (64 hex chars — keep it stable or stored
tokens become unreadable). `vercel.json` already registers the 5-minute keepalive cron.

**2. Host runner (this is what keeps bots alive)**

Vercel functions freeze between requests, so the runner needs an always-on host:

```bash
# Railway / Render / Fly.io / any VPS / Docker
DASHBOARD_URL=https://your-app.vercel.app \
HOST_KEY=same-as-above \
DATABASE_URL=$DATABASE_URL \
BOT_SECRET=dyno-lite-bridge-secret \
node host/runner.js

# or
docker build -f host/Dockerfile -t dyno-lite-runner .
docker run -d --restart=always -e DASHBOARD_URL=... -e HOST_KEY=... dyno-lite-runner
```

The runner claims every bot whose desired state is `running`, spawns one process each (ports
`BASE_PORT+`), restarts on crash with exponential backoff, stops looping when Discord rejects a
token (`invalid-token`) or privileged intents are missing, and streams status + logs back.

**3. Point users at the site** — paste token → hosted.

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/token` | — | verify a bot token, encrypt + store, start hosting |
| `GET /api/me` | bot cookie | bot identity + hosting snapshot |
| `GET/POST /api/host` | bot cookie | status, logs, `start/stop/restart/rotate` |
| `POST /api/host/claim` | `x-host-key` | runner asks which bots to run (returns decrypted tokens) |
| `POST /api/host/heartbeat` | `x-host-key` | runner reports status/rss/pid/logs |
| `GET /api/host/keepalive` | cron | flags bots whose runner disappeared |
| `GET/POST /api/guilds/:id` | bot cookie | read/write guild config (bridge → Postgres fallback) |
| `GET /api/health` | — | liveness |

## Local development

```bash
npm install && npm run dev                 # dashboard on :3000
cd bot && npm install                      # bot deps (runner spawns it)
node host/runner.js                        # supervisor: claims bots from :3000
cd bot && npm test                         # 22 assertions
```
