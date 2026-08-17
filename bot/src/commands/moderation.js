'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { warnings, timeouts } = require('../db');
const { logEvent } = require('../logger');
const {
  baseEmbed,
  COLORS,
  canModerate,
  formatDuration,
  parseDuration,
  shorten,
  userTag,
  timestamp,
} = require('../util');

const MAX_TIMEOUT = 28 * 24 * 60 * 60_000 - 60_000; // Discord hard limit: 28 days

/* -------------------------------------------------------------------------- */
/* Shared moderation actions                                                  */
/* -------------------------------------------------------------------------- */

async function actionKick(ctx, member, reason) {
  const tag = userTag(member.user ?? member);
  try {
    await member.kick(`${ctx.user.tag}: ${reason}`.slice(0, 512));
  } catch (error) {
    return ctx.error(`Could not kick **${tag}** (${error.message}).`);
  }
  await logEvent(ctx.client, ctx.guild.id, {
    action: 'kick',
    user: member.user ?? member,
    moderator: ctx.user,
    reason,
    detail: `Channel: <#${ctx.channel.id}>`,
  });
  return ctx.send({
    embeds: [baseEmbed(COLORS.mod).setTitle('👢 Member kicked').setDescription(`**${tag}** was kicked.\n**Reason:** ${shorten(reason, 500)}`)],
    ephemeral: false,
  });
}

async function actionBan(ctx, memberOrId, reason, deleteDays = 0) {
  const id = typeof memberOrId === 'string' ? memberOrId : memberOrId.id;
  const user = typeof memberOrId === 'string' ? { id, username: id } : memberOrId.user ?? memberOrId;
  try {
    await ctx.guild.members.ban(id, { deleteMessageSeconds: deleteDays * 86400, reason: `${ctx.user.tag}: ${reason}`.slice(0, 512) });
  } catch (error) {
    return ctx.error(`Could not ban \`${id}\` (${error.message}).`);
  }
  await logEvent(ctx.client, ctx.guild.id, { action: 'ban', user, moderator: ctx.user, reason, detail: 'Message history deleted: ' + deleteDays + 'd' });
  return ctx.send({
    embeds: [baseEmbed(COLORS.danger).setTitle('🔨 Member banned').setDescription(`**${userTag(user)}** (\`${id}\`) was banned.\n**Reason:** ${shorten(reason, 500)}`)],
  });
}

async function actionMute(ctx, member, ms, reason) {
  const tag = userTag(member.user ?? member);
  if (!member.moderatable) return ctx.error(`I cannot mute **${tag}** — check my role position and timeout permission.`);
  try {
    await member.timeout(ms, `${ctx.user.tag}: ${reason}`.slice(0, 512));
  } catch (error) {
    return ctx.error(`Could not mute **${tag}** (${error.message}).`);
  }
  timeouts.set(ctx.guild.id, member.id, reason, Date.now() + ms);
  await logEvent(ctx.client, ctx.guild.id, {
    action: 'mute',
    user: member.user ?? member,
    moderator: ctx.user,
    reason,
    detail: `Duration: ${formatDuration(ms)} (expires ${timestamp(Date.now() + ms, 'R')})`,
  });
  return ctx.send({
    embeds: [
      baseEmbed(COLORS.mod)
        .setTitle('🔇 Member muted')
        .setDescription(`**${tag}** was muted for **${formatDuration(ms)}**.\n**Reason:** ${shorten(reason, 500)}`),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

module.exports = [
  {
    name: 'kick',
    description: 'Kick a member from the server.',
    category: 'Moderation',
    usage: 'kick <user> [reason]',
    example: '!kick @spammer advertising in #general',
    userPerms: [PermissionFlagsBits.KickMembers],
    botPerms: [PermissionFlagsBits.KickMembers],
    options: [
      { name: 'user', description: 'Member to kick', type: 'user', required: true },
      { name: 'reason', description: 'Reason for the kick', type: 'string' },
    ],
    async execute(ctx) {
      const member = await ctx.targetMember('user');
      if (!member) return ctx.error('Mention a valid member (they must be in this server).');
      const reason = ctx.reason('reason', 'No reason provided');
      const blocked = canModerate(ctx, member);
      if (blocked) return ctx.error(blocked);
      return actionKick(ctx, member, reason);
    },
  },

  {
    name: 'ban',
    description: 'Ban a user (works with an ID even if they left).',
    category: 'Moderation',
    usage: 'ban <user|id> [delete_days] [reason]',
    example: '!ban @raider 1 raiding',
    userPerms: [PermissionFlagsBits.BanMembers],
    botPerms: [PermissionFlagsBits.BanMembers],
    options: [
      { name: 'user', description: 'User or ID to ban', type: 'string', required: true, greedy: false },
      { name: 'delete_days', description: 'Days of messages to delete (0-7)', type: 'integer', min: 0, max: 7 },
      { name: 'reason', description: 'Reason for the ban', type: 'string' },
    ],
    async execute(ctx) {
      const raw = ctx.str('user');
      const id = (await ctx.targetMember('user'))?.id ?? raw?.replace(/[^\d]/g, '');
      if (!id || !/^\d{15,20}$/.test(id)) return ctx.error('Provide a valid mention or user ID.');
      const reason = ctx.reason('reason', 'No reason provided');
      const days = Math.min(7, Math.max(0, Number(ctx.int('delete_days', 0)) || 0));
      const member = ctx.guild.members.cache.get(id) || null;
      if (member) {
        const blocked = canModerate(ctx, member);
        if (blocked) return ctx.error(blocked);
      }
      const user = (await ctx.client.users.fetch(id).catch(() => null)) || { id, username: id };
      return actionBan(ctx, user, reason, days);
    },
  },

  {
    name: 'unban',
    description: 'Unban a user by their ID.',
    category: 'Moderation',
    usage: 'unban <user_id> [reason]',
    example: '!unban 123456789012345678 appeal approved',
    userPerms: [PermissionFlagsBits.BanMembers],
    botPerms: [PermissionFlagsBits.BanMembers],
    options: [
      { name: 'user_id', description: 'ID of the banned user', type: 'string', required: true, greedy: false },
      { name: 'reason', description: 'Reason', type: 'string' },
    ],
    async execute(ctx) {
      const id = (ctx.str('user_id') || '').replace(/[^\d]/g, '');
      if (!/^\d{15,20}$/.test(id)) return ctx.error('Provide the numeric user ID to unban.');
      const reason = ctx.reason('reason', 'No reason provided');
      try {
        await ctx.guild.bans.remove(id, `${ctx.user.tag}: ${reason}`.slice(0, 512));
      } catch (error) {
        return ctx.error(`Could not unban \`${id}\` — ${error.message}.`);
      }
      timeouts.remove(ctx.guild.id, id);
      await logEvent(ctx.client, ctx.guild.id, { action: 'unban', user: { id, username: id }, moderator: ctx.user, reason });
      return ctx.send({ embeds: [baseEmbed(COLORS.ok).setTitle('🔓 User unbanned').setDescription(`\`${id}\` can rejoin now.`)] });
    },
  },

  {
    name: 'mute',
    description: 'Timeout a member (10m, 1h, 2d ... max 28d).',
    category: 'Moderation',
    usage: 'mute <user> [duration] [reason]',
    example: '!mute @noisy 2h being disruptive',
    userPerms: [PermissionFlagsBits.ModerateMembers],
    botPerms: [PermissionFlagsBits.ModerateMembers],
    options: [
      { name: 'user', description: 'Member to mute', type: 'user', required: true },
      { name: 'duration', description: 'e.g. 10m, 1h, 2d (default 10m)', type: 'string', greedy: false },
      { name: 'reason', description: 'Reason', type: 'string' },
    ],
    async execute(ctx) {
      const member = await ctx.targetMember('user');
      if (!member) return ctx.error('Mention a valid member.');
      const durationRaw = ctx.str('duration');
      const ms = durationRaw ? parseDuration(durationRaw) : 10 * 60_000;
      if (!ms) return ctx.error('Invalid duration. Examples: `30s`, `10m`, `1h`, `2d`.');
      if (ms > MAX_TIMEOUT) return ctx.error('Discord caps timeouts at 28 days.');
      const reason = ctx.reason('reason', 'No reason provided');
      const blocked = canModerate(ctx, member);
      if (blocked) return ctx.error(blocked);
      return actionMute(ctx, member, ms, reason);
    },
  },

  {
    name: 'unmute',
    description: 'Remove a timeout from a member.',
    category: 'Moderation',
    usage: 'unmute <user> [reason]',
    example: '!unmute @user calmed down',
    userPerms: [PermissionFlagsBits.ModerateMembers],
    botPerms: [PermissionFlagsBits.ModerateMembers],
    options: [
      { name: 'user', description: 'Member to unmute', type: 'user', required: true },
      { name: 'reason', description: 'Reason', type: 'string' },
    ],
    async execute(ctx) {
      const member = await ctx.targetMember('user');
      if (!member) return ctx.error('Mention a valid member.');
      const reason = ctx.reason('reason', 'No reason provided');
      try {
        await member.timeout(null, `${ctx.user.tag}: ${reason}`.slice(0, 512));
      } catch (error) {
        return ctx.error(`Could not unmute them (${error.message}).`);
      }
      timeouts.remove(ctx.guild.id, member.id);
      await logEvent(ctx.client, ctx.guild.id, {
        action: 'unmute',
        user: member.user ?? member,
        moderator: ctx.user,
        reason,
      });
      return ctx.send({
        embeds: [baseEmbed(COLORS.ok).setTitle('🔊 Member unmuted').setDescription(`**${userTag(member.user ?? member)}** can talk again.`)],
      });
    },
  },

  {
    name: 'purge',
    description: 'Bulk delete up to 100 recent messages.',
    category: 'Moderation',
    usage: 'purge <amount> [user]',
    example: '!purge 50 @spammer',
    userPerms: [PermissionFlagsBits.ManageMessages],
    botPerms: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory],
    options: [
      { name: 'amount', description: 'Messages to delete (1-100)', type: 'integer', required: true, min: 1, max: 100 },
      { name: 'user', description: 'Only delete this user\u2019s messages', type: 'user' },
    ],
    async execute(ctx) {
      const amount = Math.min(100, Math.max(1, Number(ctx.int('amount', 0)) || 0));
      if (!amount) return ctx.error('Give me a number between 1 and 100.');
      await ctx.defer();
      const targetId = ctx.snowflake('user');
      try {
        let collected = await ctx.channel.messages.fetch({ limit: 100, before: undefined });
        let selected = [...collected.values()];
        if (targetId) selected = selected.filter((m) => m.author.id === targetId);
        selected = selected.slice(0, amount).map((m) => m.id);

        let deleted = 0;
        if (selected.length) {
          const res = await ctx.channel.bulkDelete(selected, true).catch(() => null);
          deleted = res ? res.size : 0;
        }
        // messages older than 14 days cannot be bulk deleted - fall back one by one
        if (deleted === 0 && selected.length) {
          for (const id of selected.slice(0, amount)) {
            try {
              await ctx.channel.messages.delete(id);
              deleted++;
            } catch {
              /* skip */
            }
          }
        }
        await logEvent(ctx.client, ctx.guild.id, {
          action: 'purge',
          moderator: ctx.user,
          reason: `${deleted} message(s) purged`,
          detail: `Channel <#${ctx.channel.id}>${targetId ? ` • user <@${targetId}>` : ''}`,
        });
        return ctx.send({
          embeds: [baseEmbed(COLORS.ok).setTitle('🧹 Purge complete').setDescription(`Deleted **${deleted}** message(s) in <#${ctx.channel.id}>.`)],
        });
      } catch (error) {
        return ctx.error(`Purge failed: ${error.message}`);
      }
    },
  },

  {
    name: 'warn',
    description: 'Warn a member and store it in the database.',
    category: 'Moderation',
    usage: 'warn <user> [reason]',
    example: '!warn @user toxic attitude',
    userPerms: [PermissionFlagsBits.ModerateMembers],
    options: [
      { name: 'user', description: 'Member to warn', type: 'user', required: true },
      { name: 'reason', description: 'Reason', type: 'string' },
    ],
    async execute(ctx) {
      const member = await ctx.targetMember('user');
      if (!member) return ctx.error('Mention a valid member.');
      const reason = ctx.reason('reason', 'No reason provided');
      const user = member.user ?? member;
      const entry = warnings.add(ctx.guild.id, user.id, ctx.user.id, reason);
      const total = warnings.count(ctx.guild.id, user.id);

      await logEvent(ctx.client, ctx.guild.id, { action: 'warn', user, moderator: ctx.user, reason, detail: `Warning #${total}` });

      const embed = baseEmbed(COLORS.mod)
        .setTitle('⚠️ Warning issued')
        .setDescription(`${userTag(user)} now has **${total}** warning(s).`)
        .addFields({ name: 'Reason', value: shorten(reason, 500) }, { name: 'Warning ID', value: `#${entry.id}`, inline: true });

      // auto-escalate: 3 warnings => 1 hour timeout, 5 => 1 day
      if (total >= 5 && member.moderatable) {
        await member.timeout(24 * 60 * 60_000, 'Automatic escalation: 5 warnings').catch(() => {});
        timeouts.set(ctx.guild.id, user.id, 'Automatic escalation: 5 warnings', Date.now() + 24 * 60 * 60_000);
        embed.addFields({ name: 'Auto-escalation', value: '5+ warnings → 24h timeout applied.' });
      } else if (total >= 3 && member.moderatable) {
        await member.timeout(60 * 60_000, 'Automatic escalation: 3 warnings').catch(() => {});
        timeouts.set(ctx.guild.id, user.id, 'Automatic escalation: 3 warnings', Date.now() + 3_600_000);
        embed.addFields({ name: 'Auto-escalation', value: '3+ warnings → 1h timeout applied.' });
      }

      try {
        await user.send({ embeds: [baseEmbed(COLORS.danger).setTitle(`⚠️ Warning in ${ctx.guild.name}`).setDescription(shorten(reason, 500))] });
      } catch {
        /* DMs closed */
      }

      return ctx.send({ embeds: [embed] });
    },
  },

  {
    name: 'warnings',
    description: 'List (or clear) a member\u2019s warnings.',
    category: 'Moderation',
    usage: 'warnings <user> [clear]',
    example: '!warnings @user',
    userPerms: [PermissionFlagsBits.ModerateMembers],
    options: [
      { name: 'user', description: 'Member to inspect', type: 'user', required: true },
      { name: 'action', description: 'Clear all warnings instead', type: 'string', greedy: false, choices: [
        { name: 'list', value: 'list' },
        { name: 'clear', value: 'clear' },
      ] },
    ],
    async execute(ctx) {
      const user = await ctx.targetUser('user');
      if (!user) return ctx.error('Mention a valid user.');
      if ((ctx.str('action') || 'list') === 'clear') {
        const removed = warnings.clear(ctx.guild.id, user.id);
        await logEvent(ctx.client, ctx.guild.id, {
          action: 'warn',
          user,
          moderator: ctx.user,
          reason: `${removed} warning(s) cleared`,
        });
        return ctx.success(`Cleared **${removed}** warning(s) for ${userTag(user)}.`);
      }
      const rows = warnings.for(ctx.guild.id, user.id);
      const embed = baseEmbed(COLORS.info)
        .setTitle(`⚠️ Warnings for ${userTag(user)}`)
        .setDescription(rows.length ? `**${rows.length}** recent warning(s):` : 'This user has a clean record. 🎉');
      for (const r of rows.slice(0, 10)) {
        embed.addFields({
          name: `#${r.id} • ${timestamp(r.created_at, 'R')}`,
          value: shorten(r.reason, 300),
          inline: false,
        });
      }
      embed.setFooter({ text: `Total: ${warnings.count(ctx.guild.id, user.id)}` });
      return ctx.send({ embeds: [embed] });
    },
  },

  {
    name: 'modlogs',
    description: 'Show the most recent moderation log entries for this server.',
    category: 'Moderation',
    usage: 'modlogs [count]',
    example: '!modlogs 10',
    userPerms: [PermissionFlagsBits.ViewAuditLog],
    options: [{ name: 'count', description: 'How many entries (1-25)', type: 'integer', min: 1, max: 25 }],
    async execute(ctx) {
      const { modLogs } = require('../db');
      const rows = modLogs.recent(ctx.guild.id, Math.min(25, Math.max(1, ctx.int('count', 10))));
      const embed = baseEmbed(COLORS.log).setTitle('📋 Recent moderation log');
      if (!rows.length) embed.setDescription('Nothing logged yet.');
      for (const r of rows.slice(0, 15)) {
        embed.addFields({
          name: `${r.action} • ${timestamp(r.created_at, 'R')}`,
          value: `<@${r.user_id ?? '0'}> by <@${r.moderator_id ?? '0'}>\n${shorten(r.reason || 'No reason', 200)}`,
          inline: true,
        });
      }
      embed.setFooter({ text: `Total stored: ${modLogs.total()} (retention capped at 250/guild)` });
      return ctx.send({ embeds: [embed] });
    },
  },
];
