'use strict';

const { EmbedBuilder, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

/* -------------------------------------------------------------------------- */
/* Time helpers                                                               */
/* -------------------------------------------------------------------------- */

const TIME_UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse "10m", "1h30m", "2d", "45" into milliseconds. Returns null when invalid. */
function parseDuration(input) {
  if (input == null) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 60_000; // bare number => minutes
  const re = /(\d+)\s*(s|m|h|d|w)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(raw)) !== null) {
    matched = true;
    total += Number(m[1]) * TIME_UNITS[m[2]];
  }
  if (!matched) return null;
  return total > 0 ? total : null;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const abs = Math.floor(ms / 1000);
  const units = [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ];
  const parts = [];
  let left = abs;
  for (const [label, size] of units) {
    const v = Math.floor(left / size);
    if (v > 0) {
      parts.push(`${v}${label}`);
      left -= v * size;
    }
    if (parts.length === 3) break;
  }
  return parts.join(' ') || '0s';
}

const timestamp = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

const shorten = (text, max = 1024) => (text && text.length > max ? `${text.slice(0, max - 3)}...` : text || '');
const escapeMarkdown = (text) => String(text).replace(/([*_`~|>\\[\]])/g, '\\$1');

/* -------------------------------------------------------------------------- */
/* Embeds                                                                     */
/* -------------------------------------------------------------------------- */

const COLORS = {
  brand: 0x5865f2,
  mod: 0xfaa61a,
  danger: 0xed4245,
  ok: 0x57f287,
  info: 0x00b0f4,
  log: 0x2b2d31,
};

function baseEmbed(color = COLORS.brand) {
  return new EmbedBuilder().setColor(color).setTimestamp(new Date());
}

function ok(message) {
  return { content: `✅ ${message}`, ephemeral: true };
}
function warn(message) {
  return { content: `⚠️ ${message}`, ephemeral: true };
}
function fail(message) {
  return { content: `❌ ${message}`, ephemeral: true };
}

/* -------------------------------------------------------------------------- */
/* Permission helpers                                                         */
/* -------------------------------------------------------------------------- */

const MOD_PERMS = [PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild];
const ADMIN_PERMS = [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator];

function hasAny(member, flags) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.permissions.has(flags);
}

/** Returns a human readable error string, or null when the action is allowed. */
function canModerate(interactionOrMessage, target) {
  const executor = interactionOrMessage.member;
  const me = interactionOrMessage.guild?.members?.me;
  if (!executor || !me) return 'I could not resolve guild members.';

  const isSelf = target.id === executor.id;
  const isBotOwner = target.id === interactionOrMessage.client?.user?.id;

  if (isSelf) return 'You cannot moderate yourself.';
  if (isBotOwner) return 'You cannot moderate me.';

  if (target.roles && executor.roles && target.roles.highest.position >= executor.roles.highest.position) {
    return 'That member has a role equal to or higher than yours.';
  }
  if (target.roles && me.roles && target.roles.highest.position >= me.roles.highest.position) {
    return 'My highest role must be above that member\u2019s highest role.';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Interaction plumbing                                                       */
/* -------------------------------------------------------------------------- */

/** Reply or followUp depending on whether the interaction was already answered. */
async function reply(ctx, payload) {
  const fn = ctx.replied || ctx.deferred ? ctx.followUp.bind(ctx) : ctx.reply.bind(ctx);
  return fn(payload);
}

/** Resolve a slash option or fall back to a positional prefix argument. */
function opt(ctx, name) {
  if (!ctx.isSlash) return ctx.args.shift();
  const value = ctx.options.get(name, false)?.value;
  return value === undefined ? undefined : value;
}

function memberTag(member) {
  return member ? `${member.user ?? member}` : 'Unknown#0000';
}

function userTag(user) {
  return user ? `${user.username}${user.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : ''}` : 'Unknown';
}

function channelLink(id) {
  return id ? `<#${id}>` : 'not set';
}

/* -------------------------------------------------------------------------- */
/* Memory telemetry                                                           */
/* -------------------------------------------------------------------------- */

function memoryUsage() {
  const m = process.memoryUsage();
  const fmt = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    rssText: fmt(m.rss),
    heapText: fmt(m.heapUsed),
    budget: 100 * 1024 * 1024,
    budgetPct: ((m.rss / (100 * 1024 * 1024)) * 100).toFixed(1),
  };
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 2 : 0)} ${units[i]}`;
}

/** Paginate an array into fixed-size chunks (used by list-style commands). */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Permission integer for the invite URL:
 * Kick, Ban, ViewAuditLog, ViewChannel, SendMessages, ManageMessages,
 * EmbedLinks, ReadMessageHistory, ManageRoles, ModerateMembers.
 */
const PERMISSION_BITS = [1, 2, 7, 10, 11, 13, 14, 16, 28, 40];
const PERMISSIONS_INTEGER = (() => {
  let bits = 0n;
  for (const shift of PERMISSION_BITS) bits |= 1n << BigInt(shift);
  return bits.toString();
})();

function inviteLink(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${PERMISSIONS_INTEGER}&scope=bot%20applications.commands`;
}

module.exports = {
  TIME_UNITS,
  COLORS,
  PermissionsBitField,
  parseDuration,
  formatDuration,
  timestamp,
  shorten,
  escapeMarkdown,
  baseEmbed,
  ok,
  warn,
  fail,
  MOD_PERMS,
  ADMIN_PERMS,
  hasAny,
  canModerate,
  reply,
  opt,
  memberTag,
  userTag,
  channelLink,
  memoryUsage,
  fmtBytes,
  chunk,
  PERMISSIONS_INTEGER,
  inviteLink,
};
