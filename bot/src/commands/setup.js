'use strict';

/**
 * Channel-system setup commands. Everything here can also be configured from
 * the web dashboard (it writes to the same tables through the bot's API).
 */

const { PermissionFlagsBits } = require('discord.js');
const store = require('../db');
const { baseEmbed, COLORS, userTag } = require('../util');

function featureListEmbed(guildId, type, title) {
  const rows = store.features.of(guildId, type);
  const embed = baseEmbed(COLORS.info).setTitle(title);
  if (!rows.length) embed.setDescription('Not configured yet. Use the command with a channel to enable it.');
  else {
    embed.setDescription(
      rows.map((r) => `<#${r.channelId}> ${Object.keys(r.config || {}).length ? `\`${JSON.stringify(r.config)}\`` : ''}`).join('\n').slice(0, 3900),
    );
  }
  return embed;
}

function parseChannel(ctx, name = 'channel') {
  if (ctx.isSlash) return ctx.interaction.options.getChannel(name, false)?.id ?? null;
  const id = ctx.snowflake(name);
  if (id) return id;
  const raw = (ctx.str(name) || '').replace(/[^\d]/g, '');
  return /^\d{15,20}$/.test(raw) ? raw : null;
}

const STAFF_PERMS = [PermissionFlagsBits.ManageGuild];

module.exports = [
  /* ------------------------------------------------------------------ */
  /* Counting channel                                                     */
  /* ------------------------------------------------------------------ */
  {
    name: 'counting',
    description: 'Turn a channel into a cooperative counting game.',
    category: 'Channels',
    usage: 'counting [channel] [reset_on_fail] [block_same_user] [reset]',
    example: '!counting #counting',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Channel used for counting', type: 'channel' },
      { name: 'reset_on_fail', description: 'Restart the count on a wrong number', type: 'boolean' },
      { name: 'block_same_user', description: 'Block counting twice in a row', type: 'boolean' },
      { name: 'reset', description: 'Reset the count to zero', type: 'boolean' },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) {
        const state = store.counting.get(ctx.guild.id);
        return ctx.send({
          embeds: [
            baseEmbed(COLORS.info)
              .setTitle('🔢 Counting')
              .setDescription(
                `Channel: ${state.channelId ? `<#${state.channelId}>` : 'not set'}\nCurrent: **${state.current}**\nRecord: **${state.best}**` +
                  (state.bestUserId ? ` by <@${state.bestUserId}>` : '') +
                  `\nFails: **${state.fails}**`,
              ),
          ],
        });
      }
      const resetOnFail = ctx.bool('reset_on_fail', true);
      const blockSameUser = ctx.bool('block_same_user', true);
      const reset = ctx.bool('reset', false);
      store.features.set(ctx.guild.id, 'counting', channelId, { resetOnFail, blockSameUser }, 1);
      const state = store.counting.get(ctx.guild.id);
      store.counting.set(ctx.guild.id, { ...state, channelId, current: reset ? 0 : state.current, lastUserId: null });
      return ctx.success(`counting enabled in <#${channelId}>. Say **1** to start - wrong numbers ${resetOnFail ? 'reset' : 'are ignored'}.`);
    },
  },
  {
    name: 'countingleaderboard',
    description: 'Top counters for this server.',
    category: 'Channels',
    usage: 'countingleaderboard',
    example: '!countingleaderboard',
    options: [],
    async execute(ctx) {
      const rows = store.counting.leaderboard(ctx.guild.id, 10);
      const embed = baseEmbed(COLORS.brand).setTitle('🔢 Counting leaderboard');
      if (!rows.length) embed.setDescription('No counts recorded yet.');
      else embed.setDescription(rows.map((r, i) => `**${i + 1}.** <@${r.userId}> — ${r.score} correct · best ${r.best}`).join('\n'));
      return ctx.send({ embeds: [embed] });
    },
  },

  /* ------------------------------------------------------------------ */
  /* Media only                                                           */
  /* ------------------------------------------------------------------ */
  {
    name: 'mediaonly',
    description: 'Only allow media (or links) in a channel.',
    category: 'Channels',
    usage: 'mediaonly [channel] [allow_links] [remove]',
    example: '!mediaonly #showcase',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Channel to restrict', type: 'channel' },
      { name: 'allow_links', description: 'Also allow plain links', type: 'boolean' },
      { name: 'remove', description: 'Remove the restriction', type: 'boolean' },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) return ctx.send({ embeds: [featureListEmbed(ctx.guild.id, 'media', '📷 Media-only channels')] });
      if (ctx.bool('remove', false)) {
        const removed = store.features.remove(ctx.guild.id, 'media', channelId);
        return ctx.success(removed ? `Removed <#${channelId}> from media-only.` : 'That channel was not media-only.');
      }
      const allowLinks = ctx.bool('allow_links', true);
      store.features.set(ctx.guild.id, 'media', channelId, { allowLinks, notice: true }, 1);
      return ctx.success(`<#${channelId}> now accepts images, videos${allowLinks ? ' and links' : ''} only.`);
    },
  },

  /* ------------------------------------------------------------------ */
  /* Admin channel                                                        */
  /* ------------------------------------------------------------------ */
  {
    name: 'adminchannel',
    description: 'Staff-only channel (non-staff messages are removed).',
    category: 'Channels',
    usage: 'adminchannel [channel] [remove]',
    example: '!adminchannel #staff',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Staff channel', type: 'channel' },
      { name: 'remove', description: 'Stop enforcing', type: 'boolean' },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) return ctx.send({ embeds: [featureListEmbed(ctx.guild.id, 'admin', '🔐 Staff-only channels')] });
      if (ctx.bool('remove', false)) {
        const removed = store.features.remove(ctx.guild.id, 'admin', channelId);
        return ctx.success(removed ? `Stopped enforcing <#${channelId}>.` : 'Not configured.');
      }
      store.features.set(ctx.guild.id, 'admin', channelId, { silent: false }, 1);
      return ctx.success(`<#${channelId}> is now staff-only. Members without Manage Messages will be removed + DMed.`);
    },
  },

  /* ------------------------------------------------------------------ */
  /* Bot command channel                                                  */
  /* ------------------------------------------------------------------ */
  {
    name: 'botchannel',
    description: 'Restrict bot commands to specific channels.',
    category: 'Channels',
    usage: 'botchannel [channel] [remove]',
    example: '!botchannel #bot-commands',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Channel where commands are allowed', type: 'channel' },
      { name: 'remove', description: 'Remove the channel from the allow-list', type: 'boolean' },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) {
        const ids = store.features.ids(ctx.guild.id, 'botcmd');
        return ctx.send({
          embeds: [
            baseEmbed(COLORS.info)
              .setTitle('🤖 Bot command channels')
              .setDescription(ids.length ? ids.map((id) => `<#${id}>`).join('\n') : 'Commands work everywhere.'),
          ],
        });
      }
      if (ctx.bool('remove', false)) {
        const removed = store.features.remove(ctx.guild.id, 'botcmd', channelId);
        return ctx.success(removed ? `Removed <#${channelId}>.` : 'Not configured.');
      }
      store.features.set(ctx.guild.id, 'botcmd', channelId, {}, 1);
      return ctx.success(`Commands are now limited to the allow-list. Added <#${channelId}>.`);
    },
  },

  /* ------------------------------------------------------------------ */
  /* Auto memes                                                           */
  /* ------------------------------------------------------------------ */
  {
    name: 'automemes',
    description: 'Automatic meme feed in a channel.',
    category: 'Channels',
    usage: 'automemes [channel] [interval_minutes] [subreddit]',
    example: '!automemes #memes 30 memes',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Channel for the meme feed', type: 'channel' },
      { name: 'interval_minutes', description: 'Minutes between memes (min 5)', type: 'integer', min: 5, max: 1440 },
      { name: 'subreddit', description: 'Subreddit to pull from', type: 'string', greedy: false },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) return ctx.send({ embeds: [featureListEmbed(ctx.guild.id, 'memes', '😂 Auto-meme channels')] });
      const interval = Math.max(5, ctx.int('interval_minutes', 60));
      const subreddit = (ctx.str('subreddit', 'memes') || 'memes').replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'memes';
      store.features.set(ctx.guild.id, 'memes', channelId, { intervalMinutes: interval, subreddits: [subreddit] }, 1);
      return ctx.success(`meme feed every **${interval} min** from r/${subreddit} in <#${channelId}>.`);
    },
  },

  /* ------------------------------------------------------------------ */
  /* Starboard                                                            */
  /* ------------------------------------------------------------------ */
  {
    name: 'starboard',
    description: 'Pin highly starred messages to a channel.',
    category: 'Channels',
    usage: 'starboard [channel] [threshold]',
    example: '!starboard #stars 3',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Starboard channel', type: 'channel' },
      { name: 'threshold', description: 'Stars needed (default 3)', type: 'integer', min: 1, max: 25 },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) return ctx.send({ embeds: [featureListEmbed(ctx.guild.id, 'starboard', '⭐ Starboard')] });
      const threshold = Math.max(1, ctx.int('threshold', 3));
      store.features.set(ctx.guild.id, 'starboard', channelId, { threshold }, 1);
      return ctx.success(`starboard enabled in <#${channelId}> with a threshold of **${threshold}** ⭐.`);
    },
  },

  /* ------------------------------------------------------------------ */
  /* Confessions + suggestions                                            */
  /* ------------------------------------------------------------------ */
  {
    name: 'confesschannel',
    description: 'Where anonymous confessions are posted.',
    category: 'Channels',
    usage: 'confesschannel [channel] [remove]',
    example: '!confesschannel #confessions',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Confession channel', type: 'channel' },
      { name: 'remove', description: 'Disable confessions', type: 'boolean' },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) return ctx.send({ embeds: [featureListEmbed(ctx.guild.id, 'confess', '🫂 Confession channel')] });
      if (ctx.bool('remove', false)) {
        store.features.remove(ctx.guild.id, 'confess');
        return ctx.success('Confessions disabled.');
      }
      store.features.set(ctx.guild.id, 'confess', channelId, {}, 1);
      return ctx.success(`Anonymous confessions will be posted in <#${channelId}>.`);
    },
  },
  {
    name: 'suggestchannel',
    description: 'Where server suggestions are posted for voting.',
    category: 'Channels',
    usage: 'suggestchannel [channel] [remove]',
    example: '!suggestchannel #suggestions',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Suggestion channel', type: 'channel' },
      { name: 'remove', description: 'Disable suggestions', type: 'boolean' },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) return ctx.send({ embeds: [featureListEmbed(ctx.guild.id, 'suggestions', '💡 Suggestion channel')] });
      if (ctx.bool('remove', false)) {
        store.features.remove(ctx.guild.id, 'suggestions');
        return ctx.success('Suggestions disabled.');
      }
      store.features.set(ctx.guild.id, 'suggestions', channelId, {}, 1);
      return ctx.success(`Suggestions will be posted in <#${channelId}>.`);
    },
  },
  {
    name: 'levels',
    description: 'XP system + level-up announcement channel.',
    category: 'Channels',
    usage: 'levels [channel] [enabled] [remove]',
    example: '!levels #level-ups',
    userPerms: STAFF_PERMS,
    options: [
      { name: 'channel', description: 'Where level ups are announced', type: 'channel' },
      { name: 'enabled', description: 'Turn XP on or off', type: 'boolean' },
      { name: 'remove', description: 'Reset to defaults (XP on, no channel)', type: 'boolean' },
    ],
    async execute(ctx) {
      const channelId = parseChannel(ctx, 'channel');
      if (!channelId) {
        const rows = store.features.of(ctx.guild.id, 'levels');
        const enabled = !rows.length || (rows[0].config || {}).enabled !== false;
        return ctx.send({
          embeds: [baseEmbed(COLORS.info).setTitle('📊 Levels').setDescription(`XP is **${enabled ? 'on' : 'off'}**.\nAnnouncement channel: ${rows[0] ? `<#${rows[0].channelId}>` : 'wherever the member chatted'}.`)],
        });
      }
      if (ctx.bool('remove', false)) {
        store.features.remove(ctx.guild.id, 'levels');
        return ctx.success('Levels reset to defaults.');
      }
      store.features.set(ctx.guild.id, 'levels', channelId, { enabled: ctx.bool('enabled', true) }, 1);
      return ctx.success(`level ups will be announced in <#${channelId}>.`);
    },
  },
];
