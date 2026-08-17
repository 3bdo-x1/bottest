'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { settings, badWords } = require('../db');
const { logEvent } = require('../logger');
const { invalidateWords } = require('../automod');
const { baseEmbed, COLORS, shorten } = require('../util');

function describeConfig(cfg) {
  return (
    `**Banned word filter:** ${cfg.wordsEnabled ? '✅ on' : '❌ off'} (${badWords.list(cfg.guildId).length} words)\n` +
    `**Anti-spam:** ${cfg.antispamEnabled ? '✅ on' : '❌ off'} → \`${cfg.spamCount} msgs / ${cfg.spamSeconds}s\` mute \`${cfg.spamMuteMinutes}m\`\n` +
    `**Mass mention limit:** \`${cfg.mentionLimit}\`\n` +
    `**Invite filter:** ${cfg.inviteFilter ? '✅ on' : '❌ off'}`
  );
}

module.exports = [
  {
    name: 'badwords',
    description: 'Manage the banned word list used by auto-mod.',
    category: 'Auto-Moderation',
    usage: 'badwords <add|remove|list|clear> [word]',
    example: '!badwords add exampleword',
    userPerms: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageGuild],
    options: [],
    subcommands: [
      {
        name: 'add',
        description: 'Add one or more banned words (space separated, * = wildcard).',
        options: [{ name: 'words', description: 'Words to ban', type: 'string', required: true }],
        async execute(ctx) {
          const raw = ctx.str('words', '');
          const words = raw
            .split(/[\s,]+/)
            .map((w) => w.toLowerCase().replace(/[^a-z0-9*]/g, ''))
            .filter((w) => w.length > 1)
            .slice(0, 25);
          if (!words.length) return ctx.error('Give me at least one word (2+ letters).');
          let added = 0;
          for (const w of words) if (badWords.add(ctx.guild.id, w, ctx.user.id)) added++;
          invalidateWords(ctx.guild.id);
          settings.update(ctx.guild.id, { wordsEnabled: 1 });
          await logEvent(ctx.client, ctx.guild.id, {
            action: 'automod',
            moderator: ctx.user,
            reason: `${added} banned word(s) added`,
            detail: shorten(words.join(', '), 400),
          });
          return ctx.success(`${added} word(s) added to the filter (word filter enabled).`);
        },
      },
      {
        name: 'remove',
        description: 'Remove a banned word.',
        options: [{ name: 'word', description: 'Word to remove', type: 'string', required: true, greedy: false }],
        async execute(ctx) {
          const word = (ctx.str('word') || '').toLowerCase().replace(/[^a-z0-9*]/g, '');
          if (!word) return ctx.error('Which word?');
          const removed = badWords.remove(ctx.guild.id, word);
          invalidateWords(ctx.guild.id);
          return removed ? ctx.success(`Removed \`${word}\`.`) : ctx.error(`\`${word}\` is not on the list.`);
        },
      },
      {
        name: 'list',
        description: 'List banned words.',
        options: [],
        async execute(ctx) {
          const rows = badWords.list(ctx.guild.id);
          const embed = baseEmbed(COLORS.info).setTitle('🛡️ Banned words');
          if (!rows.length) embed.setDescription('The list is empty — the word filter has nothing to match.');
          else embed.setDescription(`\`\`\`\n${rows.map((r) => r.word).join(', ').slice(0, 3900)}\n\`\`\``);
          embed.setFooter({ text: 'Leetspeak and separator evasion are normalised before matching' });
          return ctx.send({ embeds: [embed] });
        },
      },
      {
        name: 'clear',
        description: 'Empty the banned word list.',
        options: [],
        async execute(ctx) {
          const n = badWords.clear(ctx.guild.id);
          invalidateWords(ctx.guild.id);
          await logEvent(ctx.client, ctx.guild.id, { action: 'automod', moderator: ctx.user, reason: `${n} banned words cleared` });
          return ctx.success(`Removed ${n} word(s).`);
        },
      },
    ],
  },

  {
    name: 'automod',
    description: 'Configure auto-moderation rules for this server.',
    category: 'Auto-Moderation',
    usage: 'automod [words] [antispam] [mention_limit] [spam_count] [spam_seconds] [spam_mute_minutes] [invites]',
    example: '!automod antispam on',
    userPerms: [PermissionFlagsBits.ManageGuild],
    options: [
      { name: 'words', description: 'Toggle the banned word filter', type: 'boolean' },
      { name: 'antispam', description: 'Toggle spam + mass mention protection', type: 'boolean' },
      { name: 'mention_limit', description: 'Max mentions per message', type: 'integer', min: 2, max: 50 },
      { name: 'spam_count', description: 'Messages allowed in the window', type: 'integer', min: 2, max: 30 },
      { name: 'spam_seconds', description: 'Window length in seconds', type: 'integer', min: 2, max: 60 },
      { name: 'spam_mute_minutes', description: 'Timeout length for spammers (minutes)', type: 'integer', min: 1, max: 1440 },
      { name: 'invites', description: 'Delete Discord invite links', type: 'boolean' },
    ],
    async execute(ctx) {
      const before = settings.get(ctx.guild.id);
      const patch = {};
      if (ctx.bool('words', null) !== null) patch.wordsEnabled = ctx.bool('words', null) ? 1 : 0;
      if (ctx.bool('antispam', null) !== null) patch.antispamEnabled = ctx.bool('antispam', null) ? 1 : 0;
      if (ctx.bool('invites', null) !== null) patch.inviteFilter = ctx.bool('invites', null) ? 1 : 0;
      const mentionLimit = ctx.int('mention_limit', null);
      const spamCount = ctx.int('spam_count', null);
      const spamSeconds = ctx.int('spam_seconds', null);
      const spamMinutes = ctx.int('spam_mute_minutes', null);
      if (mentionLimit !== null) patch.mentionLimit = mentionLimit;
      if (spamCount !== null) patch.spamCount = spamCount;
      if (spamSeconds !== null) patch.spamSeconds = spamSeconds;
      if (spamMinutes !== null) patch.spamMuteMinutes = spamMinutes;

      if (!ctx.isSlash && ctx.args.length === 0) Object.assign(patch, {});
      const changed = Object.keys(patch).length;
      const cfg = changed ? settings.update(ctx.guild.id, patch) : before;

      if (changed) {
        await logEvent(ctx.client, ctx.guild.id, {
          action: 'automod',
          moderator: ctx.user,
          reason: 'Auto-mod configuration updated',
          detail: Object.entries(patch)
            .map(([k, v]) => `${k} = ${v}`)
            .join(', '),
        });
      }
      return ctx.send({
        embeds: [baseEmbed(COLORS.brand).setTitle('🛡️ Auto-moderation').setDescription(describeConfig(cfg))],
      });
    },
  },
];
