'use strict';

const { baseEmbed, COLORS, shorten, timestamp, userTag } = require('./util');
const { settings, modLogs, deletedMessages } = require('./db');

/**
 * Logging module. Everything here is fire-and-forget: logging must never be
 * able to break moderation, and must never retain messages in memory.
 */

const ICONS = {
  kick: '👢',
  ban: '🔨',
  unban: '🔓',
  mute: '🔇',
  member_join: '📥',
  member_leave: '📤',
  autorole: '🛬',
  unmute: '🔊',
  warn: '⚠️',
  purge: '🧹',
  automod: '🛡️',
  deleted_message: '🗑️',
  role_add: '➕',
  role_remove: '➖',
  custom_command: '⌨️',
  settings: '⚙️',
};

function resolveChannel(client, id) {
  if (!id) return null;
  const channel = client.channels.cache.get(id);
  if (!channel || !channel.isTextBased() || channel.isVoiceBased()) return null;
  return channel;
}

/**
 * Persist + emit a moderation log entry.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {{action: string, user?: object|null, moderator?: object|null, reason?: string|null, detail?: string|null, extra?: Array<[string,string]>}} data
 */
/** Which settings flag gates each logged action (missing = always logged). */
const TOGGLE = {
  deleted_message: 'logDeleted',
  member_join: 'logJoins',
  member_leave: 'logJoins',
  autorole: 'logJoins',
  kick: 'logKicks',
  ban: 'logBans',
  unban: 'logBans',
  mute: 'logTimeouts',
  unmute: 'logTimeouts',
  role_add: 'logRoles',
  role_remove: 'logRoles',
  automod: 'logAutomod',
  custom_command: 'logConfig',
  settings: 'logConfig',
  announce: 'logConfig',
};

async function logEvent(client, guildId, data) {
  const action = data.action || 'settings';

  // Per-event toggles configured from the dashboard.
  const gate = TOGGLE[action];
  if (gate) {
    const cfg = settings.get(guildId);
    if (cfg && !cfg[gate]) return false;
  }
  const userId = data.user?.id || null;
  const moderatorId = data.moderator?.id || null;

  modLogs.add(guildId, action, userId, moderatorId, data.reason || null, data.detail || null);

  const cfg = settings.get(guildId);
  const channel = resolveChannel(client, cfg.modLogChannelId || cfg.logChannelId);
  if (!channel) return false;

  const embed = baseEmbed(COLORS.log)
    .setTitle(`${ICONS[action] || '📋'} ${action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`)
    .setColor(
      action === 'ban' || action === 'automod'
        ? COLORS.danger
        : action === 'mute' || action === 'warn'
          ? COLORS.mod
          : COLORS.info,
    );

  if (data.user) embed.addFields({ name: 'User', value: `${userTag(data.user)} (\`${data.user.id}\`)`, inline: true });
  if (data.moderator) {
    embed.addFields({ name: 'Moderator', value: `${userTag(data.moderator)} (\`${data.moderator.id}\`)`, inline: true });
  }
  if (data.reason) embed.addFields({ name: 'Reason', value: shorten(data.reason, 1000) });
  if (data.detail) embed.addFields({ name: 'Detail', value: shorten(data.detail, 1000) });
  for (const f of data.extra || []) embed.addFields({ name: f[0], value: shorten(f[1], 1000) });

  embed.setFooter({ text: `guild ${guildId}` }).setTimestamp(new Date());

  try {
    await channel.send({ embeds: [embed] });
    return true;
  } catch {
    return false;
  }
}

/** Log a deleted message (cached messages only - no fetching, no history hoarding). */
async function logDeletedMessage(client, message) {
  if (!message.guildId) return;
  const content = message.content || '';
  if (!content) return; // nothing textual to report; skip embeds/attachments to save RAM
  const author = message.author;
  deletedMessages.add(message.guildId, message.channelId, author?.id ?? null, content);

  const cfg = settings.get(message.guildId);
  const channel = resolveChannel(client, cfg.logChannelId || cfg.modLogChannelId);
  if (!channel) return;

  const embed = baseEmbed(COLORS.danger)
    .setTitle('🗑️ Message deleted')
    .addFields(
      { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
      {
        name: 'Author',
        value: author ? `${userTag(author)} (\`${author.id}\`)` : 'Unknown (uncached)',
        inline: true,
      },
      { name: 'Sent', value: timestamp(message.createdTimestamp || Date.now(), 'R'), inline: true },
      { name: 'Content', value: shorten(content, 1000) },
    )
    .setFooter({ text: `message ${message.id}` });

  try {
    await channel.send({ embeds: [embed] });
  } catch {
    /* channel removed or missing perms */
  }
}

module.exports = { logEvent, logDeletedMessage, resolveChannel, ICONS };
