'use strict';

/**
 * PostgreSQL data layer for the bot (write-through in-memory cache).
 *
 * Why: the dashboard (Next.js) and the bot must share one source of truth, and
 * Postgres is already provisioned for this project. The bot keeps a small
 * write-through cache so every hot path (per-message auto-mod, counting, XP)
 * stays synchronous and fast - writes go to Postgres immediately but never
 * block the gateway event loop.
 *
 * Tables are created here with IF NOT EXISTS so the bot can boot before the
 * dashboard has ever run a migration.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const candidates = ['data/config.json', '.env'];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      if (file.endsWith('.json')) {
        const parsed = JSON.parse(raw);
        if (parsed.DATABASE_URL) return parsed.DATABASE_URL;
      } else {
        const m = /^DATABASE_URL=(.+)$/m.exec(raw);
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch {
      /* keep looking */
    }
  }
  return 'postgresql://postgres:postgres@127.0.0.1:5432/app_db';
}

const DATABASE_URL = resolveDatabaseUrl();

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 6),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

pool.on('error', (error) => console.error('[pg] idle client error:', error.message));

const query = (text, params) => pool.query(text, params);
/** Fire-and-forget write: cache is already updated, persistence must never throw. */
const write = (text, params) =>
  pool.query(text, params).catch((error) => console.error(`[pg] ${error.message} :: ${text.slice(0, 70)}`));

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

const DDL = `
CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL DEFAULT '!',
  log_channel_id TEXT,
  mod_log_channel_id TEXT,
  autorole_id TEXT,
  words_enabled INT NOT NULL DEFAULT 1,
  antispam_enabled INT NOT NULL DEFAULT 1,
  mention_limit INT NOT NULL DEFAULT 6,
  spam_count INT NOT NULL DEFAULT 6,
  spam_seconds INT NOT NULL DEFAULT 5,
  spam_mute_minutes INT NOT NULL DEFAULT 10,
  invite_filter INT NOT NULL DEFAULT 0,
  welcome_enabled INT NOT NULL DEFAULT 0,
  welcome_channel_id TEXT,
  welcome_message TEXT NOT NULL DEFAULT '',
  welcome_embed INT NOT NULL DEFAULT 1,
  welcome_auto_delete INT NOT NULL DEFAULT 0,
  farewell_enabled INT NOT NULL DEFAULT 0,
  farewell_channel_id TEXT,
  farewell_message TEXT NOT NULL DEFAULT '',
  log_deleted INT NOT NULL DEFAULT 1,
  log_joins INT NOT NULL DEFAULT 1,
  log_kicks INT NOT NULL DEFAULT 1,
  log_bans INT NOT NULL DEFAULT 1,
  log_timeouts INT NOT NULL DEFAULT 1,
  log_roles INT NOT NULL DEFAULT 1,
  log_automod INT NOT NULL DEFAULT 1,
  log_config INT NOT NULL DEFAULT 1,
  automod_action TEXT NOT NULL DEFAULT 'timeout',
  exempt_role_ids TEXT NOT NULL DEFAULT '',
  exempt_channel_ids TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feature_channels (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  enabled INT NOT NULL DEFAULT 1,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  UNIQUE (guild_id, type, channel_id)
);

CREATE TABLE IF NOT EXISTS bad_words (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  word TEXT NOT NULL,
  added_by TEXT,
  UNIQUE (guild_id, word)
);

CREATE TABLE IF NOT EXISTS custom_commands (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  response TEXT NOT NULL,
  command_id TEXT,
  added_by TEXT,
  uses INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0,
  UNIQUE (guild_id, name)
);

CREATE TABLE IF NOT EXISTS warnings (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_warnings_lookup ON warnings (guild_id, user_id, id DESC);

CREATE TABLE IF NOT EXISTS mod_logs (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id TEXT,
  moderator_id TEXT,
  reason TEXT,
  detail TEXT,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mod_logs_guild ON mod_logs (guild_id, id DESC);

CREATE TABLE IF NOT EXISTS violations (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_violations_at ON violations (at);

CREATE TABLE IF NOT EXISTS deleted_messages (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT,
  content TEXT,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deleted_channel ON deleted_messages (guild_id, channel_id, id DESC);

CREATE TABLE IF NOT EXISTS counting (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  current INT NOT NULL DEFAULT 0,
  last_user_id TEXT,
  best INT NOT NULL DEFAULT 0,
  best_user_id TEXT,
  fails INT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counting_scores (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score INT NOT NULL DEFAULT 0,
  best INT NOT NULL DEFAULT 0,
  fails INT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS xp (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  points INT NOT NULL DEFAULT 0,
  level INT NOT NULL DEFAULT 0,
  messages INT NOT NULL DEFAULT 0,
  last_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  added_by TEXT,
  created_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS afk (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  until BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  due_at BIGINT NOT NULL DEFAULT 0,
  done INT NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'reminder'
);

CREATE TABLE IF NOT EXISTS memes (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT NOT NULL,
  permalink TEXT,
  author TEXT,
  ups INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suggestions (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  upvotes INT NOT NULL DEFAULT 0,
  downvotes INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS starboard_posts (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  star_message_id TEXT,
  stars INT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, message_id)
);
`;

const SETTINGS_DDL = {
  prefix: 'TEXT NOT NULL DEFAULT \'!\'',
  log_channel_id: 'TEXT',
  mod_log_channel_id: 'TEXT',
  autorole_id: 'TEXT',
  words_enabled: 'INT NOT NULL DEFAULT 1',
  antispam_enabled: 'INT NOT NULL DEFAULT 1',
  mention_limit: 'INT NOT NULL DEFAULT 6',
  spam_count: 'INT NOT NULL DEFAULT 6',
  spam_seconds: 'INT NOT NULL DEFAULT 5',
  spam_mute_minutes: 'INT NOT NULL DEFAULT 10',
  invite_filter: 'INT NOT NULL DEFAULT 0',
  welcome_enabled: 'INT NOT NULL DEFAULT 0',
  welcome_channel_id: 'TEXT',
  welcome_message: "TEXT NOT NULL DEFAULT ''",
  welcome_embed: 'INT NOT NULL DEFAULT 1',
  welcome_auto_delete: 'INT NOT NULL DEFAULT 0',
  farewell_enabled: 'INT NOT NULL DEFAULT 0',
  farewell_channel_id: 'TEXT',
  farewell_message: "TEXT NOT NULL DEFAULT ''",
  log_deleted: 'INT NOT NULL DEFAULT 1',
  log_joins: 'INT NOT NULL DEFAULT 1',
  log_kicks: 'INT NOT NULL DEFAULT 1',
  log_bans: 'INT NOT NULL DEFAULT 1',
  log_timeouts: 'INT NOT NULL DEFAULT 1',
  log_roles: 'INT NOT NULL DEFAULT 1',
  log_automod: 'INT NOT NULL DEFAULT 1',
  log_config: 'INT NOT NULL DEFAULT 1',
  automod_action: "TEXT NOT NULL DEFAULT 'timeout'",
  exempt_role_ids: "TEXT NOT NULL DEFAULT ''",
  exempt_channel_ids: "TEXT NOT NULL DEFAULT ''",
};

async function migrate() {
  await query(DDL);

  // keep older databases in sync with new settings columns
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'guilds'`,
  );
  const present = new Set(rows.map((r) => r.column_name));
  for (const [column, ddl] of Object.entries(SETTINGS_DDL)) {
    if (!present.has(column)) await query(`ALTER TABLE guilds ADD COLUMN ${column} ${ddl}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

const now = () => Date.now();

const CACHE = {
  settings: new Map(),
  badWords: new Map(),
  customCommands: new Map(),
  warnings: new Map(),
  modLogs: new Map(),
  violations: new Map(),
  deleted: new Map(),
  features: new Map(),
  counting: new Map(),
  countingScores: new Map(),
  xp: new Map(),
  quotes: new Map(),
  afk: new Map(),
};

const bound = (map, max) => {
  if (map.size <= max) return;
  let excess = map.size - max;
  for (const key of map.keys()) {
    if (excess-- <= 0) break;
    map.delete(key);
  }
};

const DEFAULTS = Object.freeze({
  prefix: '!',
  logChannelId: null,
  modLogChannelId: null,
  autoroleId: null,
  wordsEnabled: 1,
  antispamEnabled: 1,
  mentionLimit: 6,
  spamCount: 6,
  spamSeconds: 5,
  spamMuteMinutes: 10,
  inviteFilter: 0,
  welcomeEnabled: 0,
  welcomeChannelId: null,
  welcomeMessage: 'Welcome {user} to **{server}** - you are member #{count}!',
  welcomeEmbed: 1,
  welcomeAutoDelete: 0,
  farewellEnabled: 0,
  farewellChannelId: null,
  farewellMessage: 'See you soon, {username}!',
  logDeleted: 1,
  logJoins: 1,
  logKicks: 1,
  logBans: 1,
  logTimeouts: 1,
  logRoles: 1,
  logAutomod: 1,
  logConfig: 1,
  automodAction: 'timeout',
  exemptRoleIds: [],
  exemptChannelIds: [],
});

const COLUMNS = Object.keys(DEFAULTS);
const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const SNAKE = COLUMNS.map(snake);

function rowToSettings(row) {
  const out = { guildId: row.guild_id };
  COLUMNS.forEach((key, index) => {
    const column = SNAKE[index];
    let value = row[column];
    if (key === 'exemptRoleIds' || key === 'exemptChannelIds') {
      value = String(value || '')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => /^\d{15,20}$/.test(v));
    }
    out[key] = value === null || value === undefined ? DEFAULTS[key] : value;
  });
  return out;
}

const settings = {
  get(guildId) {
    const cached = CACHE.settings.get(guildId);
    if (cached) return cached;
    const fresh = rowToSettings({ guild_id: guildId });
    CACHE.settings.set(guildId, fresh);
    return fresh;
  },
  ensure(guildId) {
    const existing = CACHE.settings.get(guildId);
    if (existing && existing.guildId) return existing;
    const value = rowToSettings({ guild_id: guildId });
    value.guildId = guildId;
    CACHE.settings.set(guildId, value);
    write(
      `INSERT INTO guilds (guild_id, prefix, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId, DEFAULTS.prefix, now()],
    );
    return value;
  },
  update(guildId, patch) {
    const next = { ...this.ensure(guildId), ...patch };
    next.exemptRoleIds = (next.exemptRoleIds || []).filter((v) => /^\d{15,20}$/.test(v));
    next.exemptChannelIds = (next.exemptChannelIds || []).filter((v) => /^\d{15,20}$/.test(v));
    CACHE.settings.set(guildId, next);

    const values = [guildId];
    const sets = [];
    SNAKE.forEach((column, index) => {
      const key = COLUMNS[index];
      let value = next[key];
      if (key === 'exemptRoleIds' || key === 'exemptChannelIds') value = (value || []).join(',');
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    });
    values.push(now());
    sets.push(`updated_at = $${values.length}`);
    write(
      `INSERT INTO guilds (guild_id, ${SNAKE.join(', ')})
       VALUES ($1, ${SNAKE.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (guild_id) DO UPDATE SET ${sets.join(', ')}`,
      values,
    );
    return next;
  },
};

/* -------------------------------------------------------------------------- */
/* Feature channels (media-only, counting, admin, bot-cmds, memes, starboard…) */
/* -------------------------------------------------------------------------- */

const FEATURE_TYPES = ['media', 'counting', 'admin', 'botcmd', 'memes', 'starboard', 'confess', 'suggestions'];

const features = {
  all(guildId) {
    return CACHE.features.get(guildId) || [];
  },
  of(guildId, type) {
    return this.all(guildId).filter((f) => f.type === type && f.enabled);
  },
  has(guildId, type) {
    return this.of(guildId, type).length > 0;
  },
  ids(guildId, type) {
    return this.of(guildId, type).map((f) => f.channelId);
  },
  config(guildId, type, fallback = {}) {
    const list = this.of(guildId, type);
    return list.length ? { ...fallback, ...(list[0].config || {}) } : fallback;
  },
  set(guildId, type, channelId, config = {}, enabled = 1) {
    // one row per channel per type; some types (media/admin/botcmd/memes) allow several
    const multi = ['media', 'admin', 'botcmd', 'memes'].includes(type);
    if (!multi) {
      CACHE.features.set(guildId, (this.all(guildId) || []).filter((f) => f.type !== type));
    } else {
      CACHE.features.set(guildId, (this.all(guildId) || []).filter((f) => !(f.type === type && f.channelId === channelId)));
    }
    const row = { guildId, type, channelId, enabled: enabled ? 1 : 0, config: config || {} };
    const list = CACHE.features.get(guildId) || [];
    list.push(row);
    CACHE.features.set(guildId, list);
    write(
      `INSERT INTO feature_channels (guild_id, type, channel_id, enabled, config, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (guild_id, type, channel_id) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config`,
      [guildId, type, channelId, row.enabled, JSON.stringify(row.config), now()],
    );
    return row;
  },
  remove(guildId, type, channelId = null) {
    const before = this.all(guildId);
    const after = before.filter((f) => !(f.type === type && (!channelId || f.channelId === channelId)));
    CACHE.features.set(guildId, after);
    if (channelId) write(`DELETE FROM feature_channels WHERE guild_id=$1 AND type=$2 AND channel_id=$3`, [guildId, type, channelId]);
    else write(`DELETE FROM feature_channels WHERE guild_id=$1 AND type=$2`, [guildId, type]);
    return before.length - after.length;
  },
};

/* -------------------------------------------------------------------------- */
/* Legacy-compatible repositories (bad words, custom commands, warnings…)     */
/* -------------------------------------------------------------------------- */

const badWords = {
  list(guildId) {
    return (CACHE.badWords.get(guildId) || []).map((word) => ({ word }));
  },
  words(guildId) {
    return CACHE.badWords.get(guildId) || [];
  },
  add(guildId, word, addedBy = null) {
    const list = CACHE.badWords.get(guildId) || [];
    if (list.includes(word)) return false;
    list.push(word);
    CACHE.badWords.set(guildId, list);
    write(`INSERT INTO bad_words (guild_id, word, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [guildId, word, addedBy]);
    return true;
  },
  remove(guildId, word) {
    const list = CACHE.badWords.get(guildId) || [];
    const next = list.filter((w) => w !== word);
    if (next.length === list.length) return false;
    CACHE.badWords.set(guildId, next);
    write(`DELETE FROM bad_words WHERE guild_id=$1 AND word=$2`, [guildId, word]);
    return true;
  },
  clear(guildId) {
    const count = (CACHE.badWords.get(guildId) || []).length;
    CACHE.badWords.set(guildId, []);
    write(`DELETE FROM bad_words WHERE guild_id=$1`, [guildId]);
    return count;
  },
};

const customCommands = {
  MAX: 50,
  list(guildId) {
    return (CACHE.customCommands.get(guildId) || []).map((c) => ({ name: c.name, response: c.response }));
  },
  names(guildId) {
    return (CACHE.customCommands.get(guildId) || []).map((c) => c.name);
  },
  get(guildId, name) {
    return (CACHE.customCommands.get(guildId) || []).find((c) => c.name === name) || null;
  },
  add(guildId, name, response, addedBy = null) {
    const list = CACHE.customCommands.get(guildId) || [];
    const existing = list.find((c) => c.name === name);
    if (existing) {
      existing.response = response;
      CACHE.customCommands.set(guildId, list);
    } else {
      list.push({ name, response, commandId: null, uses: 0 });
      CACHE.customCommands.set(guildId, list);
    }
    write(
      `INSERT INTO custom_commands (guild_id, name, response, added_by, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id, name) DO UPDATE SET response = EXCLUDED.response`,
      [guildId, name, response, addedBy, now()],
    );
    return true;
  },
  setCommandId(guildId, name, commandId) {
    const list = CACHE.customCommands.get(guildId) || [];
    const found = list.find((c) => c.name === name);
    if (found) {
      found.commandId = commandId;
      CACHE.customCommands.set(guildId, list);
    }
    write(`UPDATE custom_commands SET command_id=$1 WHERE guild_id=$2 AND name=$3`, [commandId, guildId, name]);
  },
  remove(guildId, name) {
    const list = CACHE.customCommands.get(guildId) || [];
    const found = list.find((c) => c.name === name);
    if (!found) return null;
    CACHE.customCommands.set(guildId, list.filter((c) => c.name !== name));
    write(`DELETE FROM custom_commands WHERE guild_id=$1 AND name=$2`, [guildId, name]);
    return found;
  },
  bump(guildId, name) {
    const list = CACHE.customCommands.get(guildId) || [];
    const found = list.find((c) => c.name === name);
    if (found) found.uses = (found.uses || 0) + 1;
    write(`UPDATE custom_commands SET uses = uses + 1 WHERE guild_id=$1 AND name=$2`, [guildId, name]);
  },
};

const warnings = {
  add(guildId, userId, moderatorId, reason) {
    const list = CACHE.warnings.get(guildId) || [];
    const row = {
      id: (list[0]?.id || 0) + 1 + Math.floor(Math.random() * 1000),
      userId: String(userId),
      moderatorId: String(moderatorId),
      reason: reason || 'No reason provided',
      createdAt: now(),
    };
    list.unshift(row);
    CACHE.warnings.set(guildId, list.slice(0, 100));
    write(
      `INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [guildId, userId, moderatorId, row.reason, row.createdAt],
    );
    return row;
  },
  for(guildId, userId) {
    return (CACHE.warnings.get(guildId) || [])
      .filter((w) => w.userId === String(userId))
      .slice(0, 25)
      .map((w) => ({ id: w.id, moderator_id: w.moderatorId, reason: w.reason, created_at: w.createdAt }));
  },
  count(guildId, userId) {
    return this.for(guildId, userId).length;
  },
  clear(guildId, userId) {
    const list = CACHE.warnings.get(guildId) || [];
    const count = list.filter((w) => w.userId === userId).length;
    CACHE.warnings.set(guildId, list.filter((w) => w.userId !== userId));
    write(`DELETE FROM warnings WHERE guild_id=$1 AND user_id=$2`, [guildId, userId]);
    return count;
  },
};

const modLogs = {
  MAX_PER_GUILD: 250,
  add(guildId, action, userId, moderatorId, reason, detail) {
    const list = CACHE.modLogs.get(guildId) || [];
    const row = { action, userId, moderatorId, reason: reason || null, detail: detail ? String(detail).slice(0, 900) : null, createdAt: now() };
    list.unshift(row);
    CACHE.modLogs.set(guildId, list.slice(0, this.MAX_PER_GUILD));
    write(
      `INSERT INTO mod_logs (guild_id, action, user_id, moderator_id, reason, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [guildId, action, userId || null, moderatorId || null, row.reason, row.detail, row.createdAt],
    );
  },
  recent(guildId, limit = 10) {
    return (CACHE.modLogs.get(guildId) || []).slice(0, Math.min(25, limit)).map((r) => ({
      action: r.action,
      user_id: r.userId,
      moderator_id: r.moderatorId,
      reason: r.reason,
      created_at: r.createdAt,
    }));
  },
  total() {
    let total = 0;
    for (const list of CACHE.modLogs.values()) total += list.length;
    return total;
  },
};

const violations = {
  add(guildId, userId, kind) {
    const key = guildId;
    const list = CACHE.violations.get(key) || [];
    list.push({ userId, kind, at: now() });
    CACHE.violations.set(key, list.slice(-200));
    write(`INSERT INTO violations (guild_id, user_id, kind, at) VALUES ($1,$2,$3,$4)`, [guildId, userId, kind, now()]);
  },
  countSince(guildId, userId, kind, sinceMs) {
    return (CACHE.violations.get(guildId) || []).filter((v) => v.userId === userId && v.kind === kind && v.at >= sinceMs).length;
  },
};

const deletedMessages = {
  add(guildId, channelId, authorId, content) {
    const key = `${guildId}:${channelId}`;
    const list = CACHE.deleted.get(key) || [];
    list.unshift({ authorId: authorId || null, content: content ? String(content).slice(0, 1500) : null, createdAt: now() });
    CACHE.deleted.set(key, list.slice(0, 15));
    bound(CACHE.deleted, 500);
    write(
      `INSERT INTO deleted_messages (guild_id, channel_id, author_id, content, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [guildId, channelId, authorId || null, content ? String(content).slice(0, 1500) : null, now()],
    );
  },
  last(guildId, channelId) {
    return (CACHE.deleted.get(`${guildId}:${channelId}`) || [])[0] || null;
  },
};

/**
 * Active timeouts are ephemeral (Discord owns the truth); keeping them in memory
 * lets the bot log expiry exactly once without a table scan.
 */
const timeouts = {
  map: new Map(),
  set(guildId, userId, reason, expiresAt) {
    this.map.set(`${guildId}:${userId}`, { reason: reason || '', expiresAt: expiresAt || 0 });
    if (this.map.size > 2000) this.map.clear(); // safety valve
  },
  remove(guildId, userId) {
    return this.map.delete(`${guildId}:${userId}`);
  },
  due(before) {
    const out = [];
    for (const [key, value] of this.map) {
      if (value.expiresAt <= before) {
        const [guild_id, user_id] = key.split(':');
        out.push({ guild_id, user_id, reason: value.reason });
      }
    }
    return out;
  },
  size() {
    return this.map.size;
  },
};

/* -------------------------------------------------------------------------- */
/* New feature repositories                                                   */
/* -------------------------------------------------------------------------- */

const counting = {
  get(guildId) {
    return CACHE.counting.get(guildId) || { guildId, channelId: null, current: 0, lastUserId: null, best: 0, bestUserId: null, fails: 0 };
  },
  set(guildId, value) {
    CACHE.counting.set(guildId, value);
    write(
      `INSERT INTO counting (guild_id, channel_id, current, last_user_id, best, best_user_id, fails, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id, current=EXCLUDED.current,
       last_user_id=EXCLUDED.last_user_id, best=EXCLUDED.best, best_user_id=EXCLUDED.best_user_id,
       fails=EXCLUDED.fails, updated_at=EXCLUDED.updated_at`,
      [guildId, value.channelId, value.current, value.lastUserId, value.best, value.bestUserId, value.fails, now()],
    );
    return value;
  },
  score(guildId, userId) {
    const key = `${guildId}:${userId}`;
    return CACHE.countingScores.get(key) || { score: 0, best: 0, fails: 0 };
  },
  bumpScore(guildId, userId, { score = 0, best = 0, fails = 0 } = {}) {
    const key = `${guildId}:${userId}`;
    const current = CACHE.countingScores.get(key) || { score: 0, best: 0, fails: 0 };
    current.score += score;
    current.best = Math.max(current.best, best);
    current.fails += fails;
    CACHE.countingScores.set(key, current);
    bound(CACHE.countingScores, 5000);
    write(
      `INSERT INTO counting_scores (guild_id, user_id, score, best, fails)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET score = counting_scores.score + EXCLUDED.score,
       best = GREATEST(counting_scores.best, EXCLUDED.best), fails = counting_scores.fails + EXCLUDED.fails`,
      [guildId, userId, current.score, current.best, current.fails],
    );
    return current;
  },
  leaderboard(guildId, limit = 10) {
    return [...CACHE.countingScores.entries()]
      .filter(([key]) => key.startsWith(`${guildId}:`))
      .map(([key, value]) => ({ userId: key.split(':')[1], ...value }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  },
};

const xp = {
  get(guildId, userId) {
    return CACHE.xp.get(`${guildId}:${userId}`) || { points: 0, level: 0, messages: 0, lastAt: 0 };
  },
  add(guildId, userId, amount) {
    const key = `${guildId}:${userId}`;
    const current = CACHE.xp.get(key) || { points: 0, level: 0, messages: 0, lastAt: 0 };
    current.points += amount;
    current.messages += 1;
    current.lastAt = now();
    const level = Math.floor(0.1 * Math.sqrt(current.points));
    const levelledUp = level > current.level;
    current.level = level;
    CACHE.xp.set(key, current);
    bound(CACHE.xp, 8000);
    write(
      `INSERT INTO xp (guild_id, user_id, points, level, messages, last_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET points=EXCLUDED.points, level=EXCLUDED.level,
       messages=EXCLUDED.messages, last_at=EXCLUDED.last_at`,
      [guildId, userId, current.points, current.level, current.messages, current.lastAt],
    );
    return { ...current, levelledUp };
  },
  leaderboard(guildId, limit = 10) {
    return [...CACHE.xp.entries()]
      .filter(([key]) => key.startsWith(`${guildId}:`))
      .map(([key, value]) => ({ userId: key.split(':')[1], ...value }))
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  },
};

const quotes = {
  add(guildId, authorId, content, addedBy) {
    const list = CACHE.quotes.get(guildId) || [];
    const row = { id: now(), authorId, content: content.slice(0, 500), addedBy: addedBy || null, createdAt: now() };
    list.push(row);
    CACHE.quotes.set(guildId, list.slice(-200));
    write(`INSERT INTO quotes (guild_id, author_id, content, added_by, created_at) VALUES ($1,$2,$3,$4,$5)`, [
      guildId,
      authorId,
      row.content,
      row.addedBy,
      row.createdAt,
    ]);
    return row;
  },
  random(guildId) {
    const list = CACHE.quotes.get(guildId) || [];
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  },
  list(guildId) {
    return CACHE.quotes.get(guildId) || [];
  },
};

const afk = {
  set(guildId, userId, note, until = 0) {
    CACHE.afk.set(`${guildId}:${userId}`, { note, until });
    write(
      `INSERT INTO afk (guild_id, user_id, note, until) VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET note=EXCLUDED.note, until=EXCLUDED.until`,
      [guildId, userId, note, until],
    );
  },
  get(guildId, userId) {
    return CACHE.afk.get(`${guildId}:${userId}`) || null;
  },
  clear(guildId, userId) {
    const had = CACHE.afk.delete(`${guildId}:${userId}`);
    if (had) write(`DELETE FROM afk WHERE guild_id=$1 AND user_id=$2`, [guildId, userId]);
    return had;
  },
  all() {
    return CACHE.afk;
  },
};

/** Async helpers that need real rows (reminders, memes, suggestions, starboard). */
const asyncRepo = {
  async reminders(dueBefore) {
    const params = dueBefore ? [dueBefore] : [];
    const where = dueBefore ? 'WHERE done = 0 AND due_at <= $1' : 'WHERE done = 0';
    const { rows } = await query(`SELECT * FROM reminders ${where} ORDER BY due_at ASC LIMIT 25`, params);
    return rows;
  },
  async addReminder(reminder) {
    const { rows } = await query(
      `INSERT INTO reminders (guild_id, channel_id, user_id, content, due_at, kind)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [reminder.guildId, reminder.channelId, reminder.userId, reminder.content, reminder.dueAt, reminder.kind || 'reminder'],
    );
    return rows[0];
  },
  async completeReminder(id) {
    await query(`UPDATE reminders SET done = 1 WHERE id = $1`, [id]);
  },
  async userReminders(guildId, userId) {
    const { rows } = await query(
      `SELECT id, content, due_at, kind FROM reminders WHERE guild_id=$1 AND user_id=$2 AND done=0 ORDER BY due_at ASC LIMIT 10`,
      [guildId, userId],
    );
    return rows;
  },
  async saveMeme(guildId, meme) {
    await query(
      `INSERT INTO memes (guild_id, title, image_url, permalink, author, ups, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [guildId, meme.title, meme.image_url, meme.permalink || null, meme.author || null, meme.ups || 0, now()],
    );
  },
  async recentMemes(guildId, limit = 5) {
    const { rows } = await query(`SELECT title, image_url, permalink, ups, created_at FROM memes WHERE guild_id=$1 ORDER BY id DESC LIMIT $2`, [guildId, limit]);
    return rows;
  },
  async addSuggestion(guildId, userId, content, messageId) {
    const { rows } = await query(
      `INSERT INTO suggestions (guild_id, user_id, content, message_id, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [guildId, userId, content, messageId, now()],
    );
    return rows[0];
  },
  async suggestions(guildId, status = null) {
    const { rows } = status
      ? await query(`SELECT * FROM suggestions WHERE guild_id=$1 AND status=$2 ORDER BY id DESC LIMIT 25`, [guildId, status])
      : await query(`SELECT * FROM suggestions WHERE guild_id=$1 ORDER BY id DESC LIMIT 25`, [guildId]);
    return rows;
  },
  async setSuggestionStatus(id, status) {
    await query(`UPDATE suggestions SET status=$1 WHERE id=$2`, [status, id]);
  },
  async starboardGet(guildId, messageId) {
    const { rows } = await query(`SELECT * FROM starboard_posts WHERE guild_id=$1 AND message_id=$2`, [guildId, messageId]);
    return rows[0] || null;
  },
  async starboardPut(guildId, messageId, starMessageId, stars) {
    await query(
      `INSERT INTO starboard_posts (guild_id, message_id, star_message_id, stars) VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id, message_id) DO UPDATE SET stars=EXCLUDED.stars, star_message_id=COALESCE(EXCLUDED.star_message_id, starboard_posts.star_message_id)`,
      [guildId, messageId, starMessageId, stars],
    );
  },
};

/* -------------------------------------------------------------------------- */
/* Load / stats / maintenance                                                 */
/* -------------------------------------------------------------------------- */

async function loadAll() {
  await migrate();

  const [guilds, featureRows, wordRows, commandRows, warningRows, logRows, violationRows, deletedRows, countingRows, scoreRows, xpRows, quoteRows, afkRows] =
    await Promise.all([
      query('SELECT * FROM guilds'),
      query('SELECT * FROM feature_channels'),
      query('SELECT * FROM bad_words'),
      query('SELECT * FROM custom_commands'),
      query('SELECT * FROM warnings ORDER BY id DESC LIMIT 5000'),
      query('SELECT * FROM mod_logs ORDER BY id DESC LIMIT 5000'),
      query('SELECT * FROM violations ORDER BY id DESC LIMIT 2000'),
      query('SELECT * FROM deleted_messages ORDER BY id DESC LIMIT 500'),
      query('SELECT * FROM counting'),
      query('SELECT * FROM counting_scores'),
      query('SELECT * FROM xp'),
      query('SELECT * FROM quotes ORDER BY id DESC LIMIT 2000'),
      query('SELECT * FROM afk WHERE until = 0 OR until > $1', [now()]),
    ]);

  guilds.rows.forEach((row) => CACHE.settings.set(row.guild_id, rowToSettings(row)));
  featureRows.rows.forEach((row) => {
    const list = CACHE.features.get(row.guild_id) || [];
    list.push({ guildId: row.guild_id, type: row.type, channelId: row.channel_id, enabled: row.enabled, config: row.config || {} });
    CACHE.features.set(row.guild_id, list);
  });
  wordRows.rows.forEach((row) => {
    const list = CACHE.badWords.get(row.guild_id) || [];
    list.push(row.word);
    CACHE.badWords.set(row.guild_id, list);
  });
  commandRows.rows.forEach((row) => {
    const list = CACHE.customCommands.get(row.guild_id) || [];
    list.push({ name: row.name, response: row.response, commandId: row.command_id, uses: row.uses || 0 });
    CACHE.customCommands.set(row.guild_id, list);
  });
  warningRows.rows.forEach((row) => {
    const list = CACHE.warnings.get(row.guild_id) || [];
    list.push({ id: row.id, userId: row.user_id, moderatorId: row.moderator_id, reason: row.reason, createdAt: row.created_at });
    CACHE.warnings.set(row.guild_id, list.slice(0, 200));
  });
  logRows.rows.forEach((row) => {
    const list = CACHE.modLogs.get(row.guild_id) || [];
    list.push({ action: row.action, userId: row.user_id, moderatorId: row.moderator_id, reason: row.reason, detail: row.detail, createdAt: row.created_at });
    CACHE.modLogs.set(row.guild_id, list.slice(0, modLogs.MAX_PER_GUILD));
  });
  violationRows.rows.forEach((row) => {
    const list = CACHE.violations.get(row.guild_id) || [];
    list.push({ userId: row.user_id, kind: row.kind, at: row.at });
    CACHE.violations.set(row.guild_id, list.slice(-200));
  });
  deletedRows.rows.forEach((row) => {
    const key = `${row.guild_id}:${row.channel_id}`;
    const list = CACHE.deleted.get(key) || [];
    list.push({ authorId: row.author_id, content: row.content, createdAt: row.created_at });
    CACHE.deleted.set(key, list.slice(0, 15));
  });
  countingRows.rows.forEach((row) =>
    CACHE.counting.set(row.guild_id, {
      guildId: row.guild_id,
      channelId: row.channel_id,
      current: row.current,
      lastUserId: row.last_user_id,
      best: row.best,
      bestUserId: row.best_user_id,
      fails: row.fails,
    }),
  );
  scoreRows.rows.forEach((row) => CACHE.countingScores.set(`${row.guild_id}:${row.user_id}`, { score: row.score, best: row.best, fails: row.fails }));
  xpRows.rows.forEach((row) =>
    CACHE.xp.set(`${row.guild_id}:${row.user_id}`, { points: row.points, level: row.level, messages: row.messages, lastAt: row.last_at }),
  );
  quoteRows.rows.forEach((row) => {
    const list = CACHE.quotes.get(row.guild_id) || [];
    list.push({ id: row.id, authorId: row.author_id, content: row.content, addedBy: row.added_by, createdAt: row.created_at });
    CACHE.quotes.set(row.guild_id, list.slice(-200));
  });
  afkRows.rows.forEach((row) => CACHE.afk.set(`${row.guild_id}:${row.user_id}`, { note: row.note, until: row.until }));

  return {
    guilds: guilds.rows.length,
    features: featureRows.rows.length,
    badWords: wordRows.rows.length,
    customCommands: commandRows.rows.length,
    warnings: warningRows.rows.length,
    modLogs: logRows.rows.length,
  };
}

async function maintainance() {
  const t = now();
  await query(`DELETE FROM violations WHERE at < $1`, [t - 15 * 60_000]);
  await query(`DELETE FROM deleted_messages WHERE created_at < $1`, [t - 24 * 60 * 60_000]);
  await query(`DELETE FROM warnings WHERE created_at < $1`, [t - 180 * 24 * 60 * 60_000]);
  await query(`DELETE FROM memes WHERE created_at < $1`, [t - 7 * 24 * 60 * 60_000]);
  await query(`DELETE FROM reminders WHERE done = 1 AND due_at < $1`, [t - 7 * 24 * 60 * 60_000]);
  return true;
}

function stats() {
  return {
    engine: 'postgres',
    database: DATABASE_URL.replace(/:[^:@/]+@/, ':***@'),
    guilds: CACHE.settings.size,
    featureChannels: [...CACHE.features.values()].reduce((a, l) => a + l.length, 0),
    badWords: [...CACHE.badWords.values()].reduce((a, l) => a + l.length, 0),
    customCommands: [...CACHE.customCommands.values()].reduce((a, l) => a + l.length, 0),
    warnings: [...CACHE.warnings.values()].reduce((a, l) => a + l.length, 0),
    modLogs: modLogs.total(),
    xpUsers: CACHE.xp.size,
    counters: CACHE.counting.size,
    quotes: [...CACHE.quotes.values()].reduce((a, l) => a + l.length, 0),
  };
}

const db = {
  query,
  pool,
  close: () => pool.end(),
  pragma: () => {},
  /** used by the old shutdown path */
  checkPoint: () => Promise.resolve(),
};

module.exports = {
  db,
  pool,
  query,
  write,
  migrate,
  loadAll,
  maintainance,
  stats,
  now,
  DEFAULTS,
  FEATURE_TYPES,
  CACHE,
  settings,
  features,
  badWords,
  customCommands,
  warnings,
  modLogs,
  violations,
  deletedMessages,
  timeouts,
  counting,
  xp,
  quotes,
  afk,
  asyncRepo,
};
