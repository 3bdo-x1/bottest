'use strict';

/**
 * Personal tools: reminders, time capsules, AFK, quotes, snipe,
 * anonymous confessions and suggestions.
 */

const { PermissionFlagsBits } = require('discord.js');
const { baseEmbed, COLORS, shorten, parseDuration, formatDuration, timestamp, userTag } = require('../util');
const store = require('../db');

module.exports = [
  {
    name: 'remind',
    description: 'Set a reminder (10m, 1h, 2d ...).',
    category: 'Tools',
    usage: 'remind <duration> [note]',
    example: '!remind 45m take the pizza out',
    options: [
      { name: 'duration', description: 'e.g. 30s, 10m, 1h, 2d', type: 'string', required: true, greedy: false },
      { name: 'note', description: 'What to remind you about', type: 'string' },
    ],
    async execute(ctx) {
      const duration = ctx.str('duration', '');
      const ms = parseDuration(duration);
      if (!ms) return ctx.error('Invalid duration. Try `30s`, `10m`, `1h`, `2d`.');
      if (ms > 30 * 24 * 60 * 60_000) return ctx.error('Reminders are capped at 30 days.');
      const note = ctx.str('note', 'No note provided');
      const dueAt = Date.now() + ms;
      await store.asyncRepo.addReminder({
        guildId: ctx.guild.id,
        channelId: ctx.channel.id,
        userId: ctx.user.id,
        content: note,
        dueAt,
        kind: 'reminder',
      });
      return ctx.success(`reminder set for ${timestamp(dueAt, 'R')} (${formatDuration(ms)}).`);
    },
  },

  {
    name: 'timecapsule',
    description: 'Write a message to your future self - delivered by DM.',
    category: 'Tools',
    usage: 'timecapsule <duration> <message>',
    example: '!timecapsule 30d remember the server rebuild?',
    options: [
      { name: 'duration', description: 'e.g. 7d, 30d, 1y (365d)', type: 'string', required: true, greedy: false },
      { name: 'message', description: 'Message for future you', type: 'string', required: true },
    ],
    async execute(ctx) {
      const ms = parseDuration(ctx.str('duration', ''));
      if (!ms) return ctx.error('Invalid duration. Try `7d`, `30d`, `365d`.');
      if (ms < 60 * 60_000) return ctx.error('A time capsule should be at least 1 hour away.');
      if (ms > 365 * 24 * 60 * 60_000) return ctx.error('Capsules are capped at one year.');
      const message = ctx.str('message', '');
      if (!message) return ctx.error('Write the message you want to receive.');
      await store.asyncRepo.addReminder({
        guildId: ctx.guild.id,
        channelId: ctx.channel.id,
        userId: ctx.user.id,
        content: message,
        dueAt: Date.now() + ms,
        kind: 'timecapsule',
      });
      return ctx.success(`capsule sealed. It opens ${timestamp(Date.now() + ms, 'R')} - keep your DMs open. 📬`);
    },
  },

  {
    name: 'reminders',
    description: 'List your active reminders and capsules.',
    category: 'Tools',
    usage: 'reminders',
    example: '!reminders',
    options: [],
    async execute(ctx) {
      const rows = await store.asyncRepo.userReminders(ctx.guild.id, ctx.user.id);
      const embed = baseEmbed(COLORS.info).setTitle('⏰ Your reminders');
      if (!rows.length) embed.setDescription('Nothing pending. Set one with `/remind` or `/timecapsule`.');
      else {
        embed.setDescription(
          rows
            .map((r) => `${r.kind === 'timecapsule' ? '📬 capsule' : '⏰ reminder'} · ${timestamp(Number(r.due_at), 'R')}\n> ${shorten(r.content, 120)}`)
            .join('\n'),
        );
      }
      return ctx.send({ embeds: [embed] });
    },
  },

  {
    name: 'afk',
    description: 'Go AFK - I will reply to mentions and clear it when you return.',
    category: 'Tools',
    usage: 'afk [note]',
    example: '!afk studying for 2 hours',
    options: [{ name: 'note', description: 'Why you are away', type: 'string' }],
    async execute(ctx) {
      const note = ctx.str('note', 'Away from keyboard');
      store.afk.set(ctx.guild.id, ctx.user.id, note, 0);
      return ctx.send({
        embeds: [baseEmbed(COLORS.mod).setTitle('💤 AFK set').setDescription(`**${userTag(ctx.user)}** is away.\n> ${shorten(note, 300)}`)],
        allowedMentions: { users: [], roles: [], everyone: false },
      });
    },
  },

  {
    name: 'quote',
    description: 'Save and replay the best moments of this server.',
    category: 'Tools',
    usage: 'quote <add|random|list> [text] [user]',
    example: '!quote add that was definitely intentional @member',
    options: [],
    subcommands: [
      {
        name: 'add',
        description: 'Save a quote.',
        options: [
          { name: 'text', description: 'The quote', type: 'string', required: true },
          { name: 'user', description: 'Who said it', type: 'user' },
        ],
        async execute(ctx) {
          const text = ctx.str('text', '');
          if (!text || text.length < 3) return ctx.error('Quote is too short.');
          const user = await ctx.targetUser('user');
          const row = store.quotes.add(ctx.guild.id, user?.id || ctx.user.id, text, ctx.user.id);
          return ctx.success(`saved quote #${row.id}.`);
        },
      },
      {
        name: 'random',
        description: 'Replay a random quote.',
        options: [],
        async execute(ctx) {
          const row = store.quotes.random(ctx.guild.id);
          if (!row) return ctx.error('No quotes saved yet. `/quote add` first.');
          return ctx.send({
            embeds: [baseEmbed(COLORS.brand).setTitle('📜 Quote').setDescription(`> ${shorten(row.content, 400)}\n\n— <@${row.authorId}> · ${timestamp(row.createdAt, 'R')}`)],
          });
        },
      },
      {
        name: 'list',
        description: 'Latest quotes.',
        options: [],
        async execute(ctx) {
          const rows = store.quotes.list(ctx.guild.id).slice(-10).reverse();
          if (!rows.length) return ctx.error('No quotes saved yet.');
          return ctx.send({
            embeds: [
              baseEmbed(COLORS.info)
                .setTitle('📜 Quote archive')
                .setDescription(rows.map((r) => `> ${shorten(r.content, 120)}\n— <@${r.authorId}>`).join('\n')),
            ],
          });
        },
      },
    ],
  },

  {
    name: 'snipe',
    description: 'Show the last deleted message in this channel.',
    category: 'Tools',
    usage: 'snipe',
    example: '!snipe',
    options: [],
    async execute(ctx) {
      const row = store.deletedMessages.last(ctx.guild.id, ctx.channel.id);
      if (!row || !row.content) return ctx.error('Nothing to snipe here.');
      return ctx.send({
        embeds: [
          baseEmbed(COLORS.danger)
            .setTitle('🎯 Snipe')
            .setDescription(shorten(row.content, 1000))
            .setFooter({ text: `${row.authorId ? `<@${row.authorId}>` : 'unknown'} · deleted ${timestamp(row.createdAt, 'R')}` }),
        ],
      });
    },
  },

  {
    name: 'confess',
    description: 'Post an anonymous confession.',
    category: 'Tools',
    usage: 'confess <message>',
    example: '!confess I still use Internet Explorer',
    options: [{ name: 'message', description: 'Your confession', type: 'string', required: true }],
    async execute(ctx) {
      const channelId = store.features.ids(ctx.guild.id, 'confess')[0];
      if (!channelId) return ctx.error('Confessions are not set up. An admin can run `/confesschannel`.');
      const channel = ctx.client.channels.cache.get(channelId);
      if (!channel) return ctx.error('I cannot see the confession channel anymore.');
      const message = ctx.str('message', '');
      if (message.length < 3) return ctx.error('Write something first.');
      const number = 1 + (store.modLogs.recent(ctx.guild.id, 500).filter((l) => l.action === 'confession').length % 999);
      await channel
        .send({
          embeds: [
            baseEmbed(0x9b59b6)
              .setAuthor({ name: `Anonymous confession #${number}` })
              .setDescription(shorten(message, 1500))
              .setTimestamp(new Date()),
          ],
        })
        .catch(() => null);
      store.modLogs.add(ctx.guild.id, 'confession', null, null, 'Anonymous confession posted', `<#${channelId}>`);
      return ctx.success('your confession was posted anonymously. 🤫');
    },
  },

  {
    name: 'suggest',
    description: 'Submit a server suggestion for voting.',
    category: 'Tools',
    usage: 'suggest <suggestion>',
    example: '!suggest add a movie night channel',
    options: [{ name: 'suggestion', description: 'Your suggestion', type: 'string', required: true }],
    async execute(ctx) {
      const channelId = store.features.ids(ctx.guild.id, 'suggestions')[0];
      if (!channelId) return ctx.error('Suggestions are not set up. An admin can run `/suggestchannel`.');
      const channel = ctx.client.channels.cache.get(channelId);
      if (!channel) return ctx.error('I cannot see the suggestion channel anymore.');
      const content = ctx.str('suggestion', '');
      if (content.length < 5) return ctx.error('Describe your suggestion in a little more detail.');

      const sent = await channel
        .send({
          embeds: [
            baseEmbed(COLORS.info)
              .setAuthor({ name: `Suggestion`, iconURL: ctx.user.displayAvatarURL({ size: 64 }) })
              .setDescription(shorten(content, 1500))
              .setFooter({ text: `Submitted by ${ctx.user.tag} · status: open` })
              .setTimestamp(new Date()),
          ],
        })
        .catch(() => null);
      if (!sent) return ctx.error('I could not post that.');
      await sent.react('👍').catch(() => {});
      await sent.react('👎').catch(() => {});
      await store.asyncRepo.addSuggestion(ctx.guild.id, ctx.user.id, content, sent.id);
      return ctx.success(`suggestion posted in <#${channelId}>.`);
    },
  },

  {
    name: 'suggestions',
    description: 'Review suggestions (staff) or list them.',
    category: 'Tools',
    usage: 'suggestions [status] [id] [approve|deny|consider]',
    example: '!suggestions open',
    userPerms: [PermissionFlagsBits.ManageGuild],
    options: [
      { name: 'status', description: 'Filter by status', type: 'string', greedy: false, choices: [
        { name: 'open', value: 'open' },
        { name: 'approved', value: 'approved' },
        { name: 'denied', value: 'denied' },
        { name: 'considered', value: 'considered' },
      ] },
    ],
    async execute(ctx) {
      const status = ctx.str('status', 'open');
      const rows = await store.asyncRepo.suggestions(ctx.guild.id, status);
      const embed = baseEmbed(COLORS.info).setTitle(`💡 Suggestions · ${status}`);
      if (!rows.length) embed.setDescription('Nothing here.');
      else embed.setDescription(rows.slice(0, 10).map((r) => `**#${r.id}** · <@${r.user_id}>\n> ${shorten(r.content, 120)}`).join('\n'));
      embed.setFooter({ text: 'Use /suggestions set to change a status' });
      return ctx.send({ embeds: [embed] });
    },
  },
];
