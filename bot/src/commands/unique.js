'use strict';

/**
 * Commands you will not find in the average Discord bot.
 */

const { baseEmbed, COLORS, shorten, userTag, formatDuration } = require('../util');
const store = require('../db');
const features = require('../features');

/* deterministic pseudo-random from a string so results are stable per day */
function seeded(input, buckets) {
  let hash = 2166136261;
  const key = String(input);
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % Math.max(1, buckets);
}

const AURAS = ['Main character', 'Side character energy', 'NPC with a lore drop', 'Final boss', 'Tutorial guide', 'Secret boss', 'Shopkeeper', 'Speedrunner'];
const RIZZ = ['devastating', 'respectable', 'situational', 'non-existent', 'theoretical', 'certified', 'chaotic'];
const TITLES = ['Certified Yapper', 'Thread Necromancer', 'Emoji Economist', 'Server Historian', 'Chaotic Archivist', 'Reaction Farmer', 'Lore Keeper', 'Ratio Survivor'];

module.exports = [
  {
    name: 'vibecheck',
    description: 'Run a (deterministic) vibe analysis on a member.',
    category: 'Unique',
    usage: 'vibecheck [user]',
    example: '!vibecheck @khaled',
    options: [{ name: 'user', description: 'Who to scan', type: 'user' }],
    async execute(ctx) {
      const user = (await ctx.targetUser('user')) || ctx.user;
      const member = ctx.guild.members.cache.get(user.id);
      const day = new Date().toISOString().slice(0, 10);
      const key = `${user.id}:${day}`;

      const aura = 35 + seeded(`${key}:aura`, 65);
      const rizz = 20 + seeded(`${key}:rizz`, 80);
      const chaos = seeded(`${key}:chaos`, 100);
      const luck = 10 + seeded(`${key}:luck`, 90);
      const brain = 25 + seeded(`${key}:brain`, 75);
      const match = 40 + seeded(`${ctx.user.id}:${user.id}`, 60);

      const bar = (pct) => `${'█'.repeat(Math.round(pct / 10))}${'░'.repeat(10 - Math.round(pct / 10))} ${pct}%`;

      const embed = baseEmbed(COLORS.brand)
        .setAuthor({ name: `Vibe check · ${userTag(user)}`, iconURL: user.displayAvatarURL({ size: 64 }) })
        .setDescription(`**${AURAS[seeded(`${key}:a`, AURAS.length)]}** · rizz is *${RIZZ[seeded(`${key}:r`, RIZZ.length)]}*`)
        .addFields(
          { name: 'Aura', value: `\`${bar(aura)}\``, inline: false },
          { name: 'Rizz', value: `\`${bar(rizz)}\``, inline: true },
          { name: 'Chaos', value: `\`${bar(chaos)}\``, inline: true },
          { name: 'Luck', value: `\`${bar(luck)}\``, inline: true },
          { name: 'Big brain', value: `\`${bar(brain)}\``, inline: true },
          { name: 'Vibe match with you', value: `\`${bar(match)}\``, inline: true },
        )
        .setFooter({ text: `Badge: ${TITLES[seeded(key, TITLES.length)]} · resets daily · member since ${member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'unknown'}` });
      return ctx.send({ embeds: [embed] });
    },
  },

  {
    name: 'ship',
    description: 'Compatibility report for two members.',
    category: 'Unique',
    usage: 'ship <user> <user2>',
    example: '!ship @a @b',
    options: [
      { name: 'user', description: 'First member', type: 'user', required: true },
      { name: 'user2', description: 'Second member', type: 'user', required: true },
    ],
    async execute(ctx) {
      const a = await ctx.targetUser('user');
      const b = await ctx.targetUser('user2');
      if (!a || !b) return ctx.error('Mention two members.');
      if (a.id === b.id) return ctx.error('Shipping someone with themselves is just confidence.');

      const pair = [a.id, b.id].sort().join(':');
      const score = 25 + seeded(pair, 75);
      const shipName = `${a.username.slice(0, Math.ceil(a.username.length / 2))}${b.username.slice(Math.floor(b.username.length / 2))}`;
      const verdicts = [
        [90, 'Soulmates. The server has no choice but to accept it. 💞'],
        [75, 'Very promising. Same playlist energy. 🎧'],
        [55, 'Workable. Needs one shared hobby. 🛠️'],
        [35, 'Chaotic. Fun, but someone is ending up muted. ⚠️'],
        [0, 'Ships sink. This one needs a life raft. 🚢'],
      ];
      const verdict = verdicts.find(([min]) => score >= min)[1];
      const hearts = `${'❤️'.repeat(Math.round(score / 10))}${'🖤'.repeat(10 - Math.round(score / 10))}`;

      return ctx.send({
        embeds: [
          baseEmbed(0xeb459e)
            .setTitle(`💗 ${a.username} × ${b.username}`)
            .setDescription(`**${shipName}** — **${score}%**\n${hearts}\n\n${verdict}`),
        ],
      });
    },
  },

  {
    name: 'wheel',
    description: 'Spin a wheel of names/options and get a winner.',
    category: 'Unique',
    usage: 'wheel <option1, option2, ...>',
    example: '!wheel pizza, sushi, cereal',
    options: [{ name: 'options', description: 'Comma separated options', type: 'string', required: true }],
    async execute(ctx) {
      const list = (ctx.str('options') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20);
      if (list.length < 2) return ctx.error('Give me at least two comma separated options.');
      const winner = list[Math.floor(Math.random() * list.length)];
      return ctx.send({
        embeds: [
          baseEmbed(COLORS.ok)
            .setTitle('🎡 Wheel spun')
            .setDescription(`Entries: ${list.map((l) => `\`${shorten(l, 40)}\``).join(' · ')}\n\n**Winner: ${winner}**`),
        ],
      });
    },
  },

  {
    name: 'randomperson',
    description: 'Pick a random member of this server.',
    category: 'Unique',
    usage: 'randomperson',
    example: '!randomperson',
    options: [],
    async execute(ctx) {
      const members = [...ctx.guild.members.cache.values()].filter((m) => !m.user.bot);
      if (!members.length) {
        const fetched = await ctx.guild.members.fetch({ limit: 200 }).catch(() => null);
        if (fetched) members.push(...fetched.values());
      }
      const pool = members.filter((m) => !m.user.bot);
      if (!pool.length) return ctx.error('I could not find any humans.');
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return ctx.send({
        embeds: [baseEmbed(COLORS.brand).setTitle('🎯 Random member').setDescription(`**${userTag(pick.user)}**\n<@${pick.id}>`)],
      });
    },
  },

  {
    name: 'meme',
    description: 'Post a fresh meme.',
    category: 'Unique',
    usage: 'meme [subreddit]',
    example: '!meme programmerhumor',
    options: [{ name: 'subreddit', description: 'Subreddit to pull from', type: 'string', greedy: false }],
    async execute(ctx) {
      await ctx.defer();
      const requested = (ctx.str('subreddit') || '').replace(/[^a-z0-9_]/gi, '').slice(0, 24);
      if (requested) {
        const { fetchMemes } = features;
        const items = await fetchMemes([requested]);
        if (!items.length) return ctx.error(`Could not fetch r/${requested} right now.`);
        const meme = items[Math.floor(Math.random() * items.length)];
        return ctx.send({ embeds: [baseEmbed(COLORS.brand).setTitle(shorten(meme.title, 200)).setImage(meme.image_url).setURL(meme.permalink || undefined)] });
      }
      const meme = await features.randomMeme(ctx.guild.id);
      if (!meme) return ctx.error('Meme sources are unreachable at the moment - try again shortly.');
      return ctx.send({
        embeds: [baseEmbed(COLORS.brand).setTitle(shorten(meme.title, 200)).setImage(meme.image_url).setURL(meme.permalink || undefined).setFooter({ text: `👍 ${meme.ups}` })],
      });
    },
  },

  {
    name: 'rank',
    description: 'Show your XP level and progress.',
    category: 'Unique',
    usage: 'rank [user]',
    example: '!rank @member',
    options: [{ name: 'user', description: 'Member to inspect', type: 'user' }],
    async execute(ctx) {
      const user = (await ctx.targetUser('user')) || ctx.user;
      const row = store.xp.get(ctx.guild.id, user.id);
      const nextLevelPoints = Math.ceil(((row.level + 1) / 0.1) ** 2);
      const progress = Math.min(100, Math.round((row.points / Math.max(1, nextLevelPoints)) * 100));
      return ctx.send({
        embeds: [
          baseEmbed(COLORS.brand)
            .setAuthor({ name: userTag(user), iconURL: user.displayAvatarURL({ size: 64 }) })
            .addFields(
              { name: 'Level', value: `${row.level}`, inline: true },
              { name: 'XP', value: `${row.points}`, inline: true },
              { name: 'Messages', value: `${row.messages}`, inline: true },
              { name: 'Progress to next level', value: `\`${'█'.repeat(Math.round(progress / 10))}${'░'.repeat(10 - Math.round(progress / 10))}\` ${progress}%` },
            ),
        ],
      });
    },
  },

  {
    name: 'leaderboard',
    description: 'Server leaderboard (xp or counting).',
    category: 'Unique',
    usage: 'leaderboard [board]',
    example: '!leaderboard xp',
    options: [
      { name: 'board', description: 'Which board', type: 'string', greedy: false, choices: [
        { name: 'xp', value: 'xp' },
        { name: 'counting', value: 'counting' },
      ] },
    ],
    async execute(ctx) {
      const board = (ctx.str('board', 'xp') || 'xp').toLowerCase();
      const rows = board === 'counting' ? store.counting.leaderboard(ctx.guild.id, 10) : store.xp.leaderboard(ctx.guild.id, 10);
      const embed = baseEmbed(COLORS.brand).setTitle(board === 'counting' ? '🔢 Counting leaderboard' : '📊 XP leaderboard');
      if (!rows.length) embed.setDescription('Nothing recorded yet.');
      else {
        embed.setDescription(
          rows
            .map((r, i) => {
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
              const value = board === 'counting' ? `${r.score} correct · best ${r.best}` : `level ${r.level} · ${r.points} XP`;
              return `${medal} <@${r.userId}> — ${value}`;
            })
            .join('\n'),
        );
      }
      embed.setFooter({ text: `Uptime ${formatDuration(ctx.client.uptime || 0)}` });
      return ctx.send({ embeds: [embed] });
    },
  },
];
