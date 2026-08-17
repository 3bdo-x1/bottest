'use strict';

/**
 * dyno-lite v2 — all-in-one Discord bot.
 *
 *  - discord.js v14 gateway with generous caching (the 100 MB cap is gone)
 *  - PostgreSQL persistence shared with the Next.js web dashboard
 *  - channel systems: media-only, counting, staff-only, bot-cmds, auto-memes,
 *    starboard, confessions, suggestions, levels
 *  - internal HTTP API (src/api.js) the dashboard uses for live Discord data
 *
 * Start:  cd bot && npm install && npm start
 */

const {
  Client,
  GatewayIntentBits,
  Options,
  Events,
  AuditLogEvent,
  PermissionFlagsBits,
  Partials,
} = require('discord.js');
const handler = require('./src/commands');
const { runAutoMod, sweepTrackers, trackerSize } = require('./src/automod');
const { logEvent, logDeletedMessage } = require('./src/logger');
const api = require('./src/api');
const features = require('./src/features');
const welcome = require('./src/welcome');
const store = require('./src/db');
const { memoryUsage, inviteLink } = require('./src/util');

/* -------------------------------------------------------------------------- */
/* Config loading: env > data/config.json > .env > .env.local                  */
/* -------------------------------------------------------------------------- */

function applyEnv(pairs) {
  for (const [key, value] of Object.entries(pairs)) {
    if (key && typeof value === 'string' && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadEnvFile(file) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const raw = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const pairs = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      pairs[key] = value;
    }
    applyEnv(pairs);
  } catch {
    /* optional */
  }
}

function loadJsonConfig(file = 'data/config.json') {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    applyEnv(JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf8')));
    return true;
  } catch {
    return false;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');
loadJsonConfig();

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const REGISTER_ONLY = process.argv.includes('--register-only');

if (!TOKEN) {
  console.error('[fatal] DISCORD_TOKEN missing. Put {"DISCORD_TOKEN":"..."} in bot/data/config.json');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Client — memory limit lifted: cache enough to power every feature          */
/* -------------------------------------------------------------------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessageReactions, // starboard
    GatewayIntentBits.GuildEmojisAndStickers,
  ],
  // Partials let starboard/reactions work on uncached messages.
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],

  sweepers: {
    messages: { interval: 300, lifetime: 900 }, // 15 min of message context
    users: { interval: 3_600, filter: () => (user) => user.id !== client.user?.id },
    guildMembers: { interval: 1_800, filter: () => (member) => member.id !== client.user?.id },
    threads: { interval: 600, lifetime: 900, filter: () => (t) => !t.archived },
    invites: { interval: 600, lifetime: 300 },
  },

  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: { maxSize: 400, overageSliderLimit: 200 },
    ThreadManager: { maxSize: 200, overageSliderLimit: 100 },
    UserManager: { maxSize: 2_000, overageSliderLimit: 500 },
    GuildMemberManager: { maxSize: 2_000, overageSliderLimit: 500, keepOverLimit: (m) => m.id === client.user?.id },
    ReactionManager: { maxSize: 200, overageSliderLimit: 100 },
    ReactionUserManager: { maxSize: 100, overageSliderLimit: 50 },
    GuildEmojiManager: 500, // emojis are used by reaction features
    PresenceManager: 0, // still unused
    TypingManager: 0,
    ThreadMemberManager: 0,
  }),

  ws: { large_threshold: 250, compress: true },
  rest: { timeout: 20_000, retries: 2, globalRequestsPerSecond: 30 },
});

handler.load();

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function registerSlashCommands() {
  const payload = handler.buildSlashJson();
  if (GUILD_ID && client.guilds.cache.has(GUILD_ID)) {
    await client.guilds.cache.get(GUILD_ID).commands.set(payload);
    console.log(`[commands] ${payload.length} guild commands registered in ${GUILD_ID}`);
    return;
  }
  if (GUILD_ID) console.warn(`[commands] GUILD_ID ${GUILD_ID} not joined yet - registering globally instead.\n${inviteLink(client.user?.id ?? '')}`);
  await client.application.commands.set(payload);
  console.log(`[commands] ${payload.length} global commands registered (${client.guilds.cache.size} guild(s))`);
}

async function boot() {
  const loaded = await store.loadAll().catch((error) => {
    console.error('[fatal] could not load from Postgres:', error.message);
    process.exit(1);
  });
  console.log(`[db] postgres ready: ${JSON.stringify(loaded)}`);

  client.once(Events.ClientReady, async (ready) => {
    console.log(`[ready] ${ready.user.tag} · ${ready.guilds.cache.size} guild(s) · rss ${memoryUsage().rssText}`);
    console.log(`[ready] invite: ${inviteLink(ready.user.id)}`);
    for (const id of client.guilds.cache.keys()) store.settings.ensure(id);

    if (REGISTER_ONLY) {
      await registerSlashCommands();
      await client.destroy();
      await store.db.close();
      process.exit(0);
    }
    await registerSlashCommands().catch((e) => console.error('[commands] registration failed:', e.message));
  });

  api.start(client, registerSlashCommands);
  await client.login(TOKEN);
}

/* -------------------------------------------------------------------------- */
/* Message pipeline                                                           */
/* -------------------------------------------------------------------------- */

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    const cfg = store.settings.get(message.guild.id) || store.settings.ensure(message.guild.id);
    const prefixes = [cfg.prefix, `<@${client.user.id}>`, `<@!${client.user.id}>`];

    const invocation = handler.parseInvocation(message.content, prefixes);
    if (invocation) {
      // bot-command channel allow-list
      if (!features.commandChannelAllowed(message.guild.id, message.channelId)) {
        const reply = await message
          .reply({ content: `🤖 ${features.commandChannelNotice(message.guild, message.channelId)}`, allowedMentions: { repliedUser: true } })
          .catch(() => null);
        if (reply) setTimeout(() => reply.delete().catch(() => {}), 8_000).unref?.();
        return;
      }
      await handler.handleMessage(client, message, invocation.name, invocation.args);
      return;
    }

    // channel systems (media-only, staff-only, counting, AFK, XP)
    const result = await features.handleMessage(client, message);
    if (result.handled) return;

    await runAutoMod(client, message);
  } catch (error) {
    console.error('[messageCreate]', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.guildId && !features.commandChannelAllowed(interaction.guildId, interaction.channelId)) {
      return void (await interaction.reply({
        content: `🤖 ${features.commandChannelNotice(interaction.guild, interaction.channelId)}`,
        ephemeral: true,
      }));
    }
    await handler.handleInteraction(interaction);
  } catch (error) {
    console.error('[interactionCreate]', error);
  }
});

/* -------------------------------------------------------------------------- */
/* Reactions: starboard                                                       */
/* -------------------------------------------------------------------------- */

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await features.handleReactionAdd(client, reaction, user);
  } catch (error) {
    console.error('[reactionAdd]', error);
  }
});

/* -------------------------------------------------------------------------- */
/* Logging + lifecycle                                                        */
/* -------------------------------------------------------------------------- */

client.on(Events.MessageDelete, (message) => void logDeletedMessage(client, message).catch(() => {}));

client.on(Events.MessageDeleteBulk, async (messages, channel) => {
  if (!channel.guild || messages.size < 5) return;
  await logEvent(client, channel.guild.id, {
    action: 'purge',
    moderator: client.user,
    reason: `${messages.size} messages bulk-deleted`,
    detail: `<#${channel.id}>`,
  }).catch(() => {});
});

client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
  if (!newMsg.guildId || newMsg.author?.bot || oldMsg?.content === newMsg.content) return;
  const cfg = store.settings.get(newMsg.guildId);
  if (cfg?.wordsEnabled) {
    const { matchBadWord } = require('./src/automod');
    if (matchBadWord(newMsg.guildId, newMsg.content)) {
      await newMsg.delete().catch(() => {});
      await logEvent(client, newMsg.guildId, {
        action: 'automod',
        user: newMsg.author,
        moderator: client.user,
        reason: 'Banned word filter (edited message)',
        detail: `<#${newMsg.channelId}>`,
      }).catch(() => {});
    }
  }
});

client.on(Events.GuildBanAdd, (ban) =>
  logEvent(client, ban.guild.id, { action: 'ban', user: ban.user, moderator: client.user, reason: ban.reason || 'Ban event' }).catch(() => {}),
);

client.on(Events.GuildBanRemove, (ban) => {
  store.timeouts.remove(ban.guild.id, ban.user.id);
  return logEvent(client, ban.guild.id, { action: 'unban', user: ban.user, moderator: client.user, reason: 'Ban removed' }).catch(() => {});
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guild = member.guild;
  store.timeouts.remove(guild.id, member.id);
  await welcome.send(client, member, 'leave').catch(() => {});
  await logEvent(client, guild.id, { action: 'member_leave', user: member.user, moderator: client.user, reason: 'Member left' }).catch(() => {});
  try {
    const audit = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberKick });
    const entry = audit.entries.first();
    if (entry && Date.now() - entry.createdTimestamp < 8_000 && entry.target?.id === member.id) {
      await logEvent(client, guild.id, {
        action: 'kick',
        user: member.user,
        moderator: entry.executor ?? client.user,
        reason: entry.reason || 'No reason provided',
      });
    }
  } catch {
    /* no audit log permission */
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (!oldMember?.roles?.cache || !newMember?.roles?.cache) return;
  const guildId = newMember.guild.id;
  const added = [...newMember.roles.cache.keys()].filter((id) => !oldMember.roles.cache.has(id));
  const removed = [...oldMember.roles.cache.keys()].filter((id) => !newMember.roles.cache.has(id));
  const wasTimedOut = oldMember.isCommunicationDisabled?.();
  const isTimedOut = newMember.isCommunicationDisabled?.();

  if (wasTimedOut !== isTimedOut) {
    if (isTimedOut) store.timeouts.set(guildId, newMember.id, 'Timeout', newMember.communicationDisabledUntilTimestamp);
    else {
      store.timeouts.remove(guildId, newMember.id);
      await logEvent(client, guildId, { action: 'unmute', user: newMember.user, moderator: client.user, reason: 'Timeout expired or removed' }).catch(() => {});
    }
  }
  for (const id of added.slice(0, 5)) {
    await logEvent(client, guildId, { action: 'role_add', user: newMember.user, moderator: client.user, reason: `Role added <@&${id}>` }).catch(() => {});
  }
  for (const id of removed.slice(0, 5)) {
    await logEvent(client, guildId, { action: 'role_remove', user: newMember.user, moderator: client.user, reason: `Role removed <@&${id}>` }).catch(() => {});
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = store.settings.get(member.guild.id);
  await welcome.send(client, member, 'join').catch(() => {});
  await logEvent(client, member.guild.id, {
    action: 'member_join',
    user: member.user,
    moderator: client.user,
    reason: 'Member joined',
    detail: `Account created <t:${Math.floor((member.user?.createdTimestamp || Date.now()) / 1000)}:R>`,
  }).catch(() => {});

  if (cfg?.autoroleId) {
    const me = member.guild.members.me;
    const role = member.guild.roles.cache.get(cfg.autoroleId);
    if (me?.permissions?.has(PermissionFlagsBits.ManageRoles) && role && !role.managed && role.position < me.roles.highest.position) {
      await member.roles.add(role, 'Autorole').catch(() => {});
      await logEvent(client, member.guild.id, {
        action: 'autorole',
        user: member.user,
        moderator: client.user,
        reason: `Assigned autorole <@&${role.id}>`,
      }).catch(() => {});
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  store.settings.ensure(guild.id);
  console.log(`[guilds] joined ${guild.name} (${guild.id})`);
  await guild.commands.set(handler.buildSlashJson()).catch(() => {});
});

client.on(Events.GuildDelete, (guild) => console.log(`[guilds] left ${guild.name} (${guild.id})`));

/* -------------------------------------------------------------------------- */
/* Background loops                                                           */
/* -------------------------------------------------------------------------- */

let ticks = 0;
setInterval(() => {
  ticks++;
  sweepTrackers();
  if (ticks % 2 === 0) void store.maintainance();
  if (ticks % 2 === 0) void features.reminderTick(client).catch(() => {}); // every 60s
  if (ticks % 5 === 0) void features.memeFeedTick(client).catch(() => {}); // every 150s
  for (const row of store.timeouts.due(Date.now())) {
    store.timeouts.remove(row.guild_id, row.user_id);
    void logEvent(client, row.guild_id, { action: 'unmute', user: { id: row.user_id }, moderator: client.user, reason: 'Timeout expired' }).catch(() => {});
  }
  if (process.env.LOG_LEVEL === 'debug' || ticks % 20 === 0) {
    console.log(
      `[stats] rss ${memoryUsage().rssText} · heap ${memoryUsage().heapText} · guilds ${client.guilds.cache.size} · ` +
        `commands ${handler.registry.size} · spam-windows ${trackerSize()} · timeouts ${store.timeouts.size()} · ${JSON.stringify(store.stats())}`,
    );
  }
}, 30_000).unref();

/* -------------------------------------------------------------------------- */
/* Resilience + shutdown                                                      */
/* -------------------------------------------------------------------------- */

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (error) => console.error('[uncaughtException]', error));

async function shutdown(signal) {
  console.log(`[shutdown] ${signal} - closing gateway + postgres pool`);
  await client.destroy().catch(() => {});
  await store.db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void boot().catch(async (error) => {
  const message = String(error?.message || error);
  console.error(`[fatal] ${message}`);
  if (process.env.LOG_LEVEL === 'debug') console.error(error?.stack || '');
  if (/disallowed intents/i.test(message)) {
    console.error('[fatal] enable Server Members + Message Content intents in the Developer Portal, then restart.');
  }
  await client.destroy().catch(() => {});
  process.exit(1);
});

module.exports = { client, handler, store, features };
