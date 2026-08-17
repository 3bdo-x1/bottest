# dyno-lite

A Dyno-class Discord bot (moderation, auto-mod, logging, custom commands) built to run
inside a **hard 100 MB RSS ceiling**.

* **Runtime:** Node.js ≥ 18.17, discord.js **v14**, better-sqlite3
* **Runtime dependencies:** 2 (`discord.js`, `better-sqlite3`) — no command framework, no ORM, no lodash/moment
* **Storage:** single SQLite file (WAL, ~1.6 MB page cache, `mmap_size = 0`)
* **Intents:** `Guilds`, `GuildMembers`, `GuildMessages`, `MessageContent`, `GuildBans` — nothing else

---

## Control center (zero-dependency, pure Node `http`)

`DASHBOARD=1` (already set in `bot/.env`) starts a small HTTP server **inside the bot process**
on `DASHBOARD_PORT` (default 3001, bound to `127.0.0.1` — set `DASHBOARD_HOST=0.0.0.0` to expose):

| Route | Method | What it does |
| --- | --- | --- |
| `/` | GET | single-page control center (live RSS vs 100 MB, per-guild settings editor, mod log) |
| `/api/stats` | GET | bot tag, ws ping, guild/channel/user cache sizes, RSS + heap, SQLite row counts, node version |
| `/api/guilds` | GET | guilds the bot is in |
| `/api/guilds/:id` | GET | settings, banned words, custom commands, recent mod log (works for guilds it has **not** joined yet) |
| `/api/guilds/:id` | POST | validate + write settings/bad words straight into SQLite — picked up live by the bot |
| `/api/commands` | GET | the real command registry |
| `/api/register` | POST | re-register slash commands (global, or the configured guild) |
| `/health` | GET | liveness probe |

No Express, no ORM, no client framework: the page is one template string, the JSON handlers are
plain functions, request bodies are capped at 32 KB and sockets are recycled.

## Dashboard tabs

| Tab | What server owners can configure |
| --- | --- |
| **Overview** | live RSS/heap gauges, recent moderation log, registered commands |
| **Welcome & farewell** | enable/disable, pick the channel from a real channel list, message template with `{user}` `{username}` `{tag}` `{server}` `{count}` placeholder chips, embed on/off, auto-delete after N seconds, live preview, and a **Send test message** button that posts the rendered message into the real channel |
| **Logging** | audit-log channel + mod-log channel pickers, and per-event toggles: deleted messages, joins/leaves/autorole, kicks, bans & unbans, mutes/timeouts, role changes, auto-mod actions, config & custom-command changes |
| **Auto-mod** | word filter / anti-spam / invite-filter switches, mention limit, spam messages + window, mute length, violation action (delete · delete+warn · delete+timeout), banned-word list with `*` wildcards, and **exempt roles / exempt channels** multi-selects |
| **Custom commands** | add, update and delete custom commands (each is also registered as a real guild slash command) |
| **Settings** | command prefix, autorole for new members, SQLite/storage stats |

Everything is written straight into the bot's SQLite file and picked up by the running
gateway connection — no restart, no second process.

## Welcome & farewell

Enabled per guild, rendered at send time (so template edits apply on the next join):

```
Welcome {user} to **{server}** - you are member #{count}! 🎉
```

* welcome → optional embed frame + member-count field, optional auto-delete (0–600 s)
* farewell → plain message in the chosen channel
* joins/leaves are also written to the audit log channel (toggleable)

## Configuration sources

`index.js` loads config in this order (earlier wins), so it keeps working when a
container rebuild wipes `.env`:

1. real environment variables
2. `bot/data/config.json` ← survives rebuilds, holds your token
3. `bot/.env`
4. `bot/.env.local`

```json
{ "DISCORD_TOKEN": "…", "GUILD_ID": "1536391692557488239", "DASHBOARD": "1", "DASHBOARD_PORT": "3001" }
```

## Verified status (real run)

```
[ready] bot1538820854719455232#3278 - 1 guild(s) - shard 0
[ready] rss 89.15 MB / 100 MB
[ready] invite: https://discord.com/oauth2/authorize?client_id=1538820854719455232&permissions=1099780156550&scope=bot%20applications.commands
[commands] GUILD_ID 1536391692557488239 is not available, falling back to global
[commands] registered 23 global commands
[stats] rss 79.49 MB (79.5%) heap 17.25 MB | guilds 0 | db 0 logs
```

The bot is a member of `K H A L E D's server` (guild `1536391692557488239`), 23 guild commands
registered, welcome/farewell/logging/auto-mod saved from the dashboard, and a test welcome
message was delivered to `#general`:

```json
{"ok":true,"channel":"<#1536391693916577856>","rendered":"Welcome <@1538820854719455232> to K H A L E D's server - you are member #4! 🎉"}
```

If login ever prints *"Used disallowed intents"*, enable **Server Members Intent** and
**Message Content Intent** in the Developer Portal → Bot → Privileged Gateway Intents.

## Quick start

```bash
cd bot
npm install
cp .env.example .env          # put DISCORD_TOKEN in it (GUILD_ID optional)
set -a; . ./.env; set +a
npm start                     # registers slash commands, then serves
npm run register              # register slash commands and exit
npm test                      # 19 offline assertions (no token needed)
```

Invite URL scopes: `bot applications.commands`. Permissions the bot needs:
`View Channels, Send Messages, Embed Links, Read Message History, Manage Messages,
Kick Members, Ban Members, Moderate Members (timeout), Manage Roles, View Audit Log`.

---

## Memory strategy (< 100 MB)

Measured floor on Node 22: **≈ 45 MB Node baseline + ≈ 34 MB discord.js module load ≈ 79 MB at
boot**, before any cache trimming. Everything below exists to keep the *running* total flat.

| Area | Setting | Effect |
| --- | --- | --- |
| Intents | 5 intents only, no presences/voice/typing/reactions/DMs | −8…12 MB, and no dead event buffers |
| Partials | `partials: []` | −2 MB, no half-built structures |
| Messages | `MessageManager { maxSize: 20 }` + sweeper `lifetime: 180s / interval: 60s` + forced trim to 5/channel every 5 min | −20…40 MB |
| Presence/typing/reactions | `PresenceManager`, `TypingManager`, `ReactionManager`, `ReactionUserManager`, `ThreadMemberManager`, `GuildInviteManager`, `GuildStickerManager` = `0` | caches are literally empty collections |
| Members/users | `GuildMemberManager` 200 / `UserManager` 150, `keepOverLimit` pins the bot itself, sweeper every 300 s | −15…60 MB, permission checks still work |
| Threads | `ThreadManager` 20, sweeper `lifetime: 300s`, archived immediately | −5 MB |
| Roles | `RoleManager` 500 | kept on purpose (permission resolution, tiny objects) |
| Gateway | `ws.large_threshold: 50`, `compress: true` | big guilds are not fully chunked |
| V8 | `node --max-old-space-size=72 --max-semi-space-size=8` | GC runs earlier instead of creeping to the limit |
| SQLite | WAL, `synchronous=NORMAL`, `cache_size=-1600`, `mmap_size=0`, `temp_store=FILE` | ≈ 2 MB |
| Retention | 250 mod logs/guild, 15 min violation history, 24 h deleted-message evidence, WAL checkpoint each pass | file and page cache cannot grow unbounded |
| Auto-mod state | spam windows = arrays of timestamps, capped at 512 keys; word-regex cache capped at 512 guilds; 25 custom commands/guild | < 1 MB |
| Emergency | housekeeping pass warns at 95 %, trims message/member/user caches | graceful instead of OOM |

`/ping` prints live RSS vs. the 100 MB budget, heap, uptime, SQLite file size and row counts.
Set `LOG_LEVEL=debug` for a stats line every housekeeping tick (30 s).

---

## Commands

Every command works as a **slash command** and as a **prefix command** (`!` by default, also
`@mention`). One definition in `src/commands/*.js` produces both the registration payload and
the positional prefix parser.

### Moderation
| Command | Behaviour |
| --- | --- |
| `/kick <user> [reason]` | kicks, logs, role-hierarchy checked |
| `/ban <user\|id> [delete_days] [reason]` | bans by mention **or** raw ID, optional 0–7 days of message deletion |
| `/unban <user_id> [reason]` | lifts a ban, clears any stored timeout |
| `/mute <user> [duration] [reason]` | native Discord timeout (`30s`, `10m`, `1h30m`, `2d`, max 28 d), tracked in SQLite |
| `/unmute <user> [reason]` | clears the timeout |
| `/purge <amount> [user]` | bulk-deletes up to 100 messages (filtered by user if given), falls back to single deletes past 14 days |
| `/warn <user> [reason]` | stores the warning, DMs the user, auto-escalates (3 → 1 h, 5 → 24 h timeout) |
| `/warnings <user> [list\|clear]` | lists the last 25 warnings or clears them |
| `/modlogs [count]` | recent moderation log entries from SQLite |

### Auto-moderation
* Banned word filter: leetspeak (`h3ck`), separator spam (`h e c k`), zero-width characters and
  repeated letters are normalised before matching; `*` acts as a wildcard; word boundaries are
  respected so "class" ≠ "ass". Edited messages are re-checked.
* Anti-spam: `N` messages in `M` seconds (configurable) → message purge + temporary timeout.
* Mass mention: more than `mention_limit` mentions/roles/@everyone → delete + timeout.
* Invite filter: optional Discord invite deletion.
* Escalation: violations inside a 10-minute window → 10 min → 1 h → 6 h timeouts.
* Exemptions: bots, webhooks, administrators, Manage Messages / Manage Guild holders.
* `/badwords add|remove|list|clear`, `/automod [words] [antispam] [mention_limit] [spam_count] [spam_seconds] [spam_mute_minutes] [invites]`

### Utility & info
`/serverinfo`, `/userinfo [user]`, `/avatar [user]`, `/ping` (latency + memory + SQLite stats), `/help [command]`

### Customisation, logging, fun
`/setprefix <prefix>`, `/autorole [role] [disable]`, `/announce <channel> <message> [title]` (framed embed),
`/setlogchannel [channel] [separate_mod_logs]`, `/customcommand add|delete|list|run` (custom commands are
also registered as real guild slash commands, capped at 25), `/roll [NdM]`, `/eightball [question]`

### Logged automatically
deleted messages (content + channel + author), bulk deletes, kicks (via a 1-entry audit-log lookup),
bans/unbans, timeouts applied/expired, warnings, purges, auto-mod actions, role add/remove, autorole grants.

---

## SQLite schema (`data/dyno-lite.sqlite`)

| Table | Purpose |
| --- | --- |
| `settings` | prefix, log channels, autorole, auto-mod thresholds (1 row/guild) |
| `bad_words` | banned words per guild, unique `(guild_id, word)` |
| `custom_commands` | name, response, slash-command id, usage counter (max 25/guild) |
| `warnings` | user, moderator, reason, timestamp |
| `mod_logs` | action, user, moderator, reason, detail (retention 250/guild) |
| `violations` | auto-mod strikes used for escalation (15-minute window) |
| `active_timeouts` | mute expiry so expired timeouts are logged once |
| `deleted_messages` | deleted-message evidence for 24 h |

A maintenance pass runs every 60 s: prunes expired rows, enforces per-guild retention and
checkpoints the WAL. `/ping` reports the file size and row counts.

---

## Files

```
bot/
├── index.js                 # client options, sweepers, event listeners, housekeeping loop, shutdown
├── src/
│   ├── db.js                # schema, prepared statements, repositories, retention pruning
│   ├── util.js              # embeds, duration parsing, permission guards, RSS telemetry
│   ├── logger.js            # moderation + audit logging (fire and forget)
│   ├── automod.js           # word filter, spam/mention engine, escalation
│   └── commands/
│       ├── index.js         # handler for slash + prefix, slash payload builder, guards
│       ├── moderation.js    # kick ban unban mute unmute purge warn warnings modlogs
│       ├── automod.js       # badwords, automod
│       ├── utility.js       # serverinfo userinfo avatar ping roll eightball
│       └── config.js        # setprefix autorole announce setlogchannel customcommand help
└── test/smoke.js            # offline smoke suite (registry, parser, SQLite, auto-mod)
```

## Running under a container limit

```yaml
# docker-compose
services:
  dyno-lite:
    image: node:22-slim
    working_dir: /app
    command: npm start
    mem_limit: 100m
    environment:
      DISCORD_TOKEN: ${DISCORD_TOKEN}
    volumes: ['./bot:/app', '/app/data']
```

Or a hardened systemd unit:

```ini
[Service]
WorkingDirectory=/opt/dyno-lite/bot
EnvironmentFile=/opt/dyno-lite/bot/.env
ExecStart=/usr/bin/node --max-old-space-size=72 --max-semi-space-size=8 --no-warnings index.js
MemoryMax=100M
Restart=on-failure
```

## Notes

* Custom slash-command registration happens per guild on `customcommand add`; if the request
  fails the prefix version still works.
* Leaving a guild keeps its settings in SQLite — re-inviting the bot restores the configuration.
* `/ping` and the housekeeping log are the fastest way to confirm the memory budget is holding.
