'use strict';

/**
 * Internal HTTP API the Next.js dashboard talks to (server-to-server).
 *
 *   GET  /health | /stats | /guilds | /guilds/:id | /commands
 *   POST /guilds/:id/settings   { general|welcome|farewell|logs|automod }
 *   POST /guilds/:id/features   { type, channelId, enabled, config } | { type, remove: true }
 *   POST /guilds/:id/badwords   { words: [] }
 *   POST /guilds/:id/test       { kind: 'welcome'|'farewell'|'meme' }
 *   POST /register
 *
 * Auth: every request must carry `x-bot-secret` (env BOT_SECRET). The server binds
 * to 127.0.0.1 by default, so it is unreachable from outside the container.
 */

const http = require('node:http');
const { URL } = require('node:url');
const store = require('./db');
const features = require('./features');
const welcome = require('./welcome');
const { memoryUsage, formatDuration, PERMISSIONS_INTEGER } = require('./util');

const PORT = Number(process.env.BOT_PORT || 3001);
const HOST = process.env.BOT_HOST || '127.0.0.1';
const secret = () => process.env.BOT_SECRET || 'dyno-lite-local';
const BODY_LIMIT = 96 * 1024;

let client = null;
let reRegister = async () => {};

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });

const snowflakeOrNull = (value) =>
  typeof value === 'string' && /^\d{15,20}$/.test(value.trim()) ? value.trim() : null;
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const text = (value, max, fallback) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
};

function guildView(guildId) {
  const guild = client?.guilds?.cache?.get(guildId) ?? null;
  const cfg = store.settings.ensure(guildId);
  const channels = guild
    ? [...guild.channels.cache.values()]
        .filter((c) => typeof c.isTextBased === 'function' && c.isTextBased() && !c.isVoiceBased?.())
        .sort((a, b) => (b.rawPosition ?? 0) - (a.rawPosition ?? 0) || a.name.localeCompare(b.name))
        .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null }))
    : [];
  const roles = guild
    ? [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }))
    : [];
  return {
    id: guildId,
    name: guild?.name ?? null,
    icon: guild?.iconURL?.({ size: 64 }) ?? null,
    memberCount: guild?.memberCount ?? null,
    joined: Boolean(guild),
    owner_id: guild?.ownerId ?? null,
    channels,
    roles,
    settings: {
      prefix: cfg.prefix,
      autoroleId: cfg.autoroleId,
      logChannelId: cfg.logChannelId,
      modLogChannelId: cfg.modLogChannelId,
      welcome: {
        enabled: !!cfg.welcomeEnabled,
        channelId: cfg.welcomeChannelId,
        message: cfg.welcomeMessage,
        embed: !!cfg.welcomeEmbed,
        autoDelete: cfg.welcomeAutoDelete,
      },
      farewell: {
        enabled: !!cfg.farewellEnabled,
        channelId: cfg.farewellChannelId,
        message: cfg.farewellMessage,
      },
      logs: {
        deleted: !!cfg.logDeleted,
        joins: !!cfg.logJoins,
        kicks: !!cfg.logKicks,
        bans: !!cfg.logBans,
        timeouts: !!cfg.logTimeouts,
        roles: !!cfg.logRoles,
        automod: !!cfg.logAutomod,
        config: !!cfg.logConfig,
      },
      automod: {
        wordsEnabled: !!cfg.wordsEnabled,
        antispamEnabled: !!cfg.antispamEnabled,
        inviteFilter: !!cfg.inviteFilter,
        mentionLimit: cfg.mentionLimit,
        spamCount: cfg.spamCount,
        spamSeconds: cfg.spamSeconds,
        spamMuteMinutes: cfg.spamMuteMinutes,
        action: cfg.automodAction,
        exemptRoleIds: cfg.exemptRoleIds,
        exemptChannelIds: cfg.exemptChannelIds,
      },
      badWords: store.badWords.words(guildId),
    },
    features: store.features.all(guildId),
    counting: store.counting.get(guildId),
    leaderboard: {
      counting: store.counting.leaderboard(guildId, 5),
      xp: store.xp.leaderboard(guildId, 5),
    },
    modLogs: store.modLogs.recent(guildId, 10),
  };
}

function applySettings(guildId, body) {
  const cur = store.settings.ensure(guildId);
  const patch = {};

  if (body.general) {
    patch.prefix = text(body.general.prefix, 5, cur.prefix);
    patch.autoroleId = body.general.autoroleId === undefined ? cur.autoroleId : snowflakeOrNull(body.general.autoroleId);
  }
  if (body.welcome) {
    patch.welcomeEnabled = bool(body.welcome.enabled, !!cur.welcomeEnabled) ? 1 : 0;
    patch.welcomeChannelId = body.welcome.channelId === undefined ? cur.welcomeChannelId : snowflakeOrNull(body.welcome.channelId);
    patch.welcomeMessage = text(body.welcome.message, 1500, cur.welcomeMessage);
    patch.welcomeEmbed = bool(body.welcome.embed, !!cur.welcomeEmbed) ? 1 : 0;
    patch.welcomeAutoDelete = clampInt(body.welcome.autoDelete, 0, 600, cur.welcomeAutoDelete);
  }
  if (body.farewell) {
    patch.farewellEnabled = bool(body.farewell.enabled, !!cur.farewellEnabled) ? 1 : 0;
    patch.farewellChannelId = body.farewell.channelId === undefined ? cur.farewellChannelId : snowflakeOrNull(body.farewell.channelId);
    patch.farewellMessage = text(body.farewell.message, 1500, cur.farewellMessage);
  }
  if (body.logs) {
    const l = body.logs;
    if (l.auditChannelId !== undefined) patch.logChannelId = snowflakeOrNull(l.auditChannelId);
    if (l.modChannelId !== undefined) patch.modLogChannelId = snowflakeOrNull(l.modChannelId);
    patch.logDeleted = bool(l.deleted, !!cur.logDeleted) ? 1 : 0;
    patch.logJoins = bool(l.joins, !!cur.logJoins) ? 1 : 0;
    patch.logKicks = bool(l.kicks, !!cur.logKicks) ? 1 : 0;
    patch.logBans = bool(l.bans, !!cur.logBans) ? 1 : 0;
    patch.logTimeouts = bool(l.timeouts, !!cur.logTimeouts) ? 1 : 0;
    patch.logRoles = bool(l.roles, !!cur.logRoles) ? 1 : 0;
    patch.logAutomod = bool(l.automod, !!cur.logAutomod) ? 1 : 0;
    patch.logConfig = bool(l.config, !!cur.logConfig) ? 1 : 0;
  }
  if (body.automod) {
    const a = body.automod;
    patch.wordsEnabled = bool(a.wordsEnabled, !!cur.wordsEnabled) ? 1 : 0;
    patch.antispamEnabled = bool(a.antispamEnabled, !!cur.antispamEnabled) ? 1 : 0;
    patch.inviteFilter = bool(a.inviteFilter, !!cur.inviteFilter) ? 1 : 0;
    patch.mentionLimit = clampInt(a.mentionLimit, 2, 50, cur.mentionLimit);
    patch.spamCount = clampInt(a.spamCount, 2, 30, cur.spamCount);
    patch.spamSeconds = clampInt(a.spamSeconds, 2, 60, cur.spamSeconds);
    patch.spamMuteMinutes = clampInt(a.spamMuteMinutes, 1, 1440, cur.spamMuteMinutes);
    if (['delete', 'warn', 'timeout'].includes(a.action)) patch.automodAction = a.action;
    if (Array.isArray(a.exemptRoleIds)) patch.exemptRoleIds = [...new Set(a.exemptRoleIds.map(snowflakeOrNull).filter(Boolean))].slice(0, 25);
    if (Array.isArray(a.exemptChannelIds)) patch.exemptChannelIds = [...new Set(a.exemptChannelIds.map(snowflakeOrNull).filter(Boolean))].slice(0, 50);
    if (Array.isArray(a.badWords)) {
      store.badWords.clear(guildId);
      for (const word of [
        ...new Set(
          a.badWords
            .map((w) => String(w).toLowerCase().replace(/[^a-z0-9*]/g, ''))
            .filter((w) => w.replace(/\*/g, '').length > 1),
        ),
      ].slice(0, 400))
        store.badWords.add(guildId, word);
    }
  }

  store.settings.update(guildId, patch);
  return guildView(guildId);
}

function applyFeature(guildId, body) {
  const type = String(body.type || '');
  if (!store.FEATURE_TYPES.includes(type)) throw new Error(`unknown feature type "${type}"`);
  if (body.remove) {
    const removed = store.features.remove(guildId, type, body.channelId || null);
    if (type === 'counting' && removed) {
      const state = store.counting.get(guildId);
      store.counting.set(guildId, { ...state, channelId: null, current: 0, lastUserId: null });
    }
    return { removed, guild: guildView(guildId) };
  }
  const channelId = snowflakeOrNull(body.channelId);
  if (!channelId) throw new Error('channelId must be a Discord snowflake');
  const config = body.config && typeof body.config === 'object' ? body.config : {};
  store.features.set(guildId, type, channelId, config, body.enabled === false ? 0 : 1);
  if (type === 'counting') {
    const state = store.counting.get(guildId);
    store.counting.set(guildId, { ...state, channelId, current: body.reset ? 0 : state.current });
  }
  return { guild: guildView(guildId) };
}

async function sendTest(guildId, kind) {
  const cfg = store.settings.get(guildId);
  const guild = client?.guilds?.cache?.get(guildId);
  if (kind === 'meme') {
    const channelId = store.features.ids(guildId, 'memes')[0];
    const channel = client?.channels?.cache?.get(channelId);
    if (!channel) throw new Error('configure an auto-meme channel first');
    const meme = await features.randomMeme(guildId);
    if (!meme) throw new Error('could not fetch a meme right now');
    await channel.send({ embeds: [require('./util').baseEmbed(0x5865f2).setTitle(meme.title.slice(0, 200)).setImage(meme.image_url)] });
    return { ok: true, channel: `<#${channelId}>` };
  }
  const isFarewell = kind === 'farewell';
  const channelId = isFarewell ? cfg.farewellChannelId : cfg.welcomeChannelId;
  const channel = client?.channels?.cache?.get(channelId || '');
  if (!channel) throw new Error(`configure a ${isFarewell ? 'farewell' : 'welcome'} channel first`);
  const rendered = welcome.preview(
    isFarewell ? cfg.farewellMessage : cfg.welcomeMessage,
    guild?.name,
    guild?.memberCount ?? null,
  );
  await channel.send({ content: rendered.slice(0, 1900), allowedMentions: { parse: [] } });
  return { ok: true, channel: `<#${channelId}>`, rendered };
}

function stats() {
  const mem = memoryUsage();
  return {
    ok: true,
    bot: {
      tag: client?.user?.tag ?? 'not connected',
      id: client?.user?.id ?? null,
      ready: client?.isReady?.() ?? false,
      ping: client?.ws?.ping ?? null,
      guilds: client?.guilds?.cache?.size ?? 0,
      channels: client?.channels?.cache?.size ?? 0,
      usersCached: client?.users?.cache?.size ?? 0,
      membersCached: client?.guilds?.cache?.reduce((a, g) => a + g.members.cache.size, 0) ?? 0,
      invite: client?.user
        ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${PERMISSIONS_INTEGER}&scope=bot%20applications.commands`
        : null,
      uptime: formatDuration(client?.uptime ?? process.uptime()),
    },
    memory: { rssText: mem.rssText, heapText: mem.heapText, usedPct: Number(mem.budgetPct) * 10 },
    db: store.stats(),
    node: { version: process.version, pid: process.pid },
    timestamp: new Date().toISOString(),
  };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.headers['x-bot-secret'] !== secret()) return json(res, 401, { error: 'unauthorised' });

  try {
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, pid: process.pid });
    if (req.method === 'GET' && path === '/stats') return json(res, 200, stats());

    if (req.method === 'GET' && path === '/guilds') {
      const list = client?.guilds?.cache
        ? [...client.guilds.cache.values()].map((g) => ({
            id: g.id,
            name: g.name,
            icon: g.iconURL?.({ size: 64 }) ?? null,
            memberCount: g.memberCount ?? null,
            features: store.features.all(g.id).length,
          }))
        : [];
      return json(res, 200, { guilds: list });
    }

    if (req.method === 'GET' && path === '/commands') {
      const registry = require('./commands');
      return json(res, 200, {
        count: registry.registry.size,
        commands: [...registry.registry.values()].map((c) => ({ name: c.name, category: c.category, description: c.description, usage: c.usage })),
      });
    }

    const guildRoute = /^\/guilds\/(\d{15,20})$/.exec(path);
    if (guildRoute) {
      const guildId = guildRoute[1];
      if (req.method === 'GET') return json(res, 200, guildView(guildId));
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readBody(req);
        return json(res, 200, { ok: true, guild: applySettings(guildId, body) });
      }
    }

    const featureRoute = /^\/guilds\/(\d{15,20})\/features$/.exec(path);
    if (featureRoute && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...applyFeature(featureRoute[1], body) });
    }

    if (/^\/guilds\/(\d{15,20})\/test$/.test(path) && req.method === 'POST') {
      const body = await readBody(req);
      const guildId = /^\/guilds\/(\d{15,20})\/test$/.exec(path)[1];
      return json(res, 200, await sendTest(guildId, body.kind || 'welcome'));
    }

    if (req.method === 'POST' && path === '/register') {
      await reRegister();
      return json(res, 200, { ok: true, message: 'slash commands re-registered' });
    }

    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
}

function start(botClient, registerFn) {
  client = botClient || null;
  reRegister = registerFn || reRegister;
  const server = http.createServer(handler);
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.listen(PORT, HOST, () => console.log(`[api] http://${HOST}:${PORT} (dashboard bridge, secret protected)`));
  server.on('error', (error) => console.error(`[api] ${error.message}`));
  return server;
}

module.exports = { start, stats, guildView, applySettings, applyFeature, sendTest, handler };
