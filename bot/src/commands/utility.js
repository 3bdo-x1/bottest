'use strict';

const { baseEmbed, COLORS, memoryUsage, fmtBytes, formatDuration, userTag, shorten } = require('../util');
const { stats } = require('../db');

function guildFeatures(guild) {
  const f = guild.features ?? [];
  return f.length ? f.slice(0, 12).map((x) => `\`${String(x).toLowerCase()}\``).join(' ') : '—';
}

module.exports = [
  {
    name: 'serverinfo',
    description: 'Show information about this server.',
    category: 'Utility',
    usage: 'serverinfo',
    example: '!serverinfo',
    options: [],
    async execute(ctx) {
      const g = ctx.guild;
      const { memberCount, ownerId, premiumSubscriptionCount, createdTimestamp } = g;
      const embed = baseEmbed(COLORS.brand)
        .setTitle(`${g.name}`)
        .setThumbnail(g.iconURL({ size: 128 }))
        .addFields(
          { name: 'Owner', value: `<@${ownerId}>`, inline: true },
          { name: 'Members', value: `${memberCount ?? g.memberCount ?? '—'}`, inline: true },
          { name: 'Created', value: `<t:${Math.floor(createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Roles', value: `${g.roles.cache.size}`, inline: true },
          { name: 'Channels', value: `${g.channels.cache.size}`, inline: true },
          { name: 'Boosts', value: `${premiumSubscriptionCount ?? 0}`, inline: true },
          { name: 'Verification', value: `${g.verificationLevel}`, inline: true },
          { name: 'ID', value: `\`${g.id}\``, inline: true },
          { name: 'Features', value: guildFeatures(g) },
        )
        .setFooter({ text: `Shard ${g.shardId ?? 0} • data cached in SQLite` });
      return ctx.send({ embeds: [embed] });
    },
  },

  {
    name: 'userinfo',
    description: 'Show information about a member.',
    category: 'Utility',
    usage: 'userinfo [user]',
    example: '!userinfo @member',
    options: [{ name: 'user', description: 'Member to inspect (defaults to you)', type: 'user' }],
    async execute(ctx) {
      const member = (await ctx.targetMember('user')) || ctx.member;
      const user = member.user ?? member;
      const roles = [...member.roles.cache.values()]
        .filter((r) => r.id !== ctx.guild.id)
        .sort((a, b) => b.position - a.position)
        .slice(0, 15);

      const embed = baseEmbed(COLORS.info)
        .setAuthor({ name: userTag(user), iconURL: user.displayAvatarURL({ size: 64 }) })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: `\`${user.id}\``, inline: true },
          { name: 'Nickname', value: member.nickname ? shorten(member.nickname, 60) : '—', inline: true },
          { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
          { name: 'Joined', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : '—', inline: true },
          { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Timeout', value: member.isCommunicationDisabled() ? `<t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:R>` : 'None', inline: true },
          { name: `Roles (${roles.length})`, value: roles.length ? roles.join(' ') : 'None' },
        );
      return ctx.send({ embeds: [embed] });
    },
  },

  {
    name: 'avatar',
    description: 'Show a user\u2019s avatar in full resolution.',
    category: 'Utility',
    usage: 'avatar [user]',
    example: '!avatar @member',
    options: [{ name: 'user', description: 'Whose avatar (defaults to you)', type: 'user' }],
    async execute(ctx) {
      const user = (await ctx.targetUser('user')) || ctx.user;
      return ctx.send({
        embeds: [
          baseEmbed(COLORS.brand)
            .setTitle(`${userTag(user)}'s avatar`)
            .setImage(user.displayAvatarURL({ extension: 'png', size: 1024 }))
            .addFields({ name: 'Links', value: `[png](${user.displayAvatarURL({ extension: 'png', size: 1024 })}) • [jpg](${user.displayAvatarURL({ extension: 'jpg', size: 1024 })}) • [webp](${user.displayAvatarURL({ extension: 'webp', size: 1024 })})` }),
        ],
      });
    },
  },

  {
    name: 'ping',
    description: 'Latency, uptime and live memory usage.',
    category: 'Utility',
    usage: 'ping',
    example: '!ping',
    options: [],
    async execute(ctx) {
      const mem = memoryUsage();
      const sent = ctx.isSlash ? await ctx.send({ content: '📡 Measuring...', ephemeral: true }) : await ctx.send({ content: '📡 Measuring...' });
      const roundtrip = Math.max(0, Date.now() - (ctx.isSlash ? ctx.interaction.createdTimestamp : ctx.message.createdTimestamp));
      const ws = ctx.client.ws.ping ?? -1;
      const uptime = formatDuration(ctx.client.uptime ?? 0);
      const dbStats = stats();

      const embed = baseEmbed(COLORS.ok)
        .setTitle('🏓 Pong')
        .addFields(
          { name: 'WebSocket', value: ws >= 0 ? `${ws} ms` : 'measuring...', inline: true },
          { name: 'Round trip', value: `${roundtrip} ms`, inline: true },
          { name: 'Uptime', value: uptime, inline: true },
          { name: 'RSS memory', value: `${mem.rssText} / 100 MB (${mem.budgetPct}% of budget)`, inline: true },
          { name: 'Heap used', value: `${mem.heapText} of ${(mem.heapTotal / 1048576).toFixed(2)} MB`, inline: true },
          { name: 'External', value: `${(mem.external / 1048576).toFixed(2)} MB`, inline: true },
          { name: 'Database', value: `${dbStats.engine ?? 'postgres'} · ${dbStats.guilds} guilds · ${dbStats.modLogs} logs`, inline: true },
          { name: 'Guilds cached', value: `${ctx.client.guilds.cache.size}`, inline: true },
          { name: 'Rows stored', value: `${dbStats.modLogs} logs • ${dbStats.warnings} warns • ${dbStats.customCommands} cc`, inline: true },
        )
        .setFooter({ text: `Ping message will be cleaned up • ${mem.rss > 90 * 1048576 ? '⚠️ near limit' : 'memory healthy'}` });

      if (ctx.isSlash) return ctx.send({ embeds: [embed], ephemeral: true });
      if (sent?.deletable) await sent.delete().catch(() => {});
      return ctx.channel.send({ embeds: [embed] });
    },
  },

  {
    name: 'roll',
    description: 'Roll dice, e.g. 2d20.',
    category: 'Fun',
    usage: 'roll [dice]',
    example: '!roll 2d20',
    options: [{ name: 'dice', description: 'NdM format (default 1d6)', type: 'string', greedy: false }],
    async execute(ctx) {
      const spec = (ctx.str('dice') || '1d6').toLowerCase();
      const m = /^(\d{1,3})d(\d{1,4})$/.exec(spec);
      if (!m) return ctx.error('Use the `NdM` format, e.g. `2d20`.');
      const count = Math.min(25, Number(m[1]));
      const sides = Math.min(1000, Number(m[2]));
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      const total = rolls.reduce((a, b) => a + b, 0);
      return ctx.send({
        embeds: [baseEmbed(COLORS.brand).setTitle('🎲 Dice roll').setDescription(`**${total}**  •  ${rolls.join(' + ')}`)],
      });
    },
  },

  {
    name: 'eightball',
    description: 'Ask the magic 8-ball a question.',
    category: 'Fun',
    usage: 'eightball [question]',
    example: '!eightball will this bot stay under 100MB?',
    options: [{ name: 'question', description: 'Your yes/no question', type: 'string' }],
    async execute(ctx) {
      const answers = [
        'It is certain.', 'Without a doubt.', 'Most likely.', 'Yes, definitely.',
        'Ask again later.', 'Cannot predict now.', "Don't count on it.", 'Very doubtful.',
        'My reply is no.', 'Outlook good.',
      ];
      const pick = answers[Math.floor(Math.random() * answers.length)];
      const q = ctx.str('question', '(no question)');
      return ctx.send({
        embeds: [baseEmbed(COLORS.brand).setTitle('🎱 8-ball').addFields({ name: 'Question', value: shorten(q, 200) }, { name: 'Answer', value: pick })],
      });
    },
  },
];
