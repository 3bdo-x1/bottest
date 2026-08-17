'use strict';

/**
 * Channel systems + community features.
 *
 *  media-only   -> messages must contain an attachment/embed/link
 *  counting     -> cooperative counting game with leaderboard + milestones
 *  admin        -> only staff may talk there
 *  botcmd       -> bot commands are only allowed in these channels
 *  memes        -> automatic meme feed on an interval
 *  starboard    -> messages with enough stars get pinned to a channel
 *  levels       -> XP + level ups with an announcement channel
 *  confess      -> anonymous confessions
 *  suggestions  -> suggestion queue with voting
 */

const { baseEmbed, COLORS, formatDuration, shorten } = require('./util');
const store = require('./db');

const isStaff = (member) =>
  Boolean(
    member &&
      (member.permissions?.has?.('Administrator') ||
        member.permissions?.has?.('ManageGuild') ||
        member.permissions?.has?.('ManageMessages')),
  );

/* -------------------------------------------------------------------------- */
/* Media-only channels                                                        */
/* -------------------------------------------------------------------------- */

const MEDIA_URL = /https?:\/\/\S+/i;

async function enforceMediaOnly(client, message) {
  const rows = store.features.of(message.guildId, 'media');
  if (!rows.length) return false;
  const row = rows.find((f) => f.channelId === message.channelId);
  if (!row) return false;
  if (message.author.bot || isStaff(message.member)) return false;

  const cfg = { allowLinks: true, allowText: false, ...(row.config || {}) };
  const hasAttachment = message.attachments?.size > 0;
  const hasEmbed = (message.embeds?.length || 0) > 0;
  const hasLink = cfg.allowLinks ? MEDIA_URL.test(message.content || '') : false;
  const ok = hasAttachment || hasEmbed || hasLink;

  if (ok) return false;

  try {
    await message.delete();
  } catch {
    /* missing perms */
  }
  if (cfg.notice !== false) {
    const notice = await message.channel
      .send({
        embeds: [
          baseEmbed(COLORS.mod)
            .setTitle('📷 Media only')
            .setDescription(`<@${message.author.id}> this channel only accepts images, videos or links.`),
        ],
        allowedMentions: { users: [], roles: [], everyone: false },
      })
      .catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 6_000).unref?.();
  }
  await require('./logger').logEvent(client, message.guildId, {
    action: 'media_removed',
    user: message.author,
    moderator: client.user,
    reason: 'Non-media message removed',
    detail: `<#${message.channelId}>`,
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Admin-only channels                                                        */
/* -------------------------------------------------------------------------- */

async function enforceAdminOnly(client, message) {
  const rows = store.features.of(message.guildId, 'admin');
  if (!rows.length) return false;
  const row = rows.find((f) => f.channelId === message.channelId);
  if (!row) return false;
  if (message.author.bot || isStaff(message.member)) return false;
  if ((row.config || {}).silent !== true && message.member) {
    // members cannot type here: nudge them once, quietly
    const dm = await message.author
      .send({ content: `🔐 <#${message.channelId}> in **${message.guild.name}** is staff-only.` })
      .catch(() => null);
    if (dm) setTimeout(() => dm.delete().catch(() => {}), 30_000).unref?.();
  }
  try {
    await message.delete();
  } catch {
    /* ignore */
  }
  await require('./logger').logEvent(client, message.guildId, {
    action: 'admin_channel_blocked',
    user: message.author,
    moderator: client.user,
    reason: 'Message removed from staff channel',
    detail: `<#${message.channelId}>`,
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Bot-command channels                                                       */
/* -------------------------------------------------------------------------- */

function commandChannelAllowed(guildId, channelId) {
  const ids = store.features.ids(guildId, 'botcmd');
  if (!ids.length) return true; // not configured -> allowed everywhere
  return ids.includes(channelId);
}

function commandChannelNotice(guild, channelId) {
  const ids = store.features.ids(guild.id, 'botcmd');
  return `Commands are only allowed in ${ids.map((id) => `<#${id}>`).join(', ')}.`;
}

/* -------------------------------------------------------------------------- */
/* Counting channel                                                           */
/* -------------------------------------------------------------------------- */

const COUNT_FAILS = [
  '💥 **{n}**?! We were on **{expected}**. Back to zero!',
  '🧮 That is not **{expected}**, that is **{n}**. Restarting the count!',
  '🌀 Someone cannot count. Reset!',
  '🚫 **{n}** breaks the chain (needed **{expected}**). Starting over!',
];
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

async function handleCounting(client, message) {
  const state = store.counting.get(message.guildId);
  if (!state.channelId || state.channelId !== message.channelId) return false;
  if (message.author.bot) return false;

  const cfg = { resetOnFail: true, blockSameUser: true, ...(store.features.config(message.guildId, 'counting', {})) };
  const raw = (message.content || '').trim().split(/\s+/)[0].replace(/[,.\s]/g, '');
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isFinite(value)) return false; // chatter is fine

  const expected = state.current + 1;
  const userTag = `<@${message.author.id}>`;

  if (cfg.blockSameUser && state.lastUserId === message.author.id) {
    await fail(message, client, state, cfg, `${userTag} you cannot count twice in a row! Needed **${expected}**.`);
    return true;
  }

  if (value === expected) {
    const next = { ...state, current: value, lastUserId: message.author.id, updatedAt: Date.now() };
    if (value > (state.best || 0)) {
      next.best = value;
      next.bestUserId = message.author.id;
    }
    store.counting.set(message.guildId, next);
    store.counting.bumpScore(message.guildId, message.author.id, { score: 1, best: value });

    if (MILESTONES.includes(value)) {
      await message
        .react('🎉')
        .catch(() => {});
      await message.channel
        .send({
          embeds: [
            baseEmbed(COLORS.ok)
              .setTitle(`🏁 Milestone: ${value}`)
              .setDescription(`${userTag} brought us to **${value}**! Record: **${next.best}**.`),
          ],
          allowedMentions: { users: [message.author.id], roles: [], everyone: false },
        })
        .catch(() => {});
    } else {
      await message.react('✅').catch(() => {});
    }
    return true;
  }

  const line = COUNT_FAILS[Math.floor(Math.random() * COUNT_FAILS.length)]
    .replace('{n}', String(value))
    .replace('{expected}', String(expected));
  await fail(message, client, state, cfg, line);
  return true;
}

async function fail(message, client, state, cfg, text) {
  const next = { ...state, fails: (state.fails || 0) + 1, current: cfg.resetOnFail === false ? state.current : 0 };
  if (cfg.resetOnFail !== false) next.lastUserId = null;
  store.counting.set(message.guildId, next);
  store.counting.bumpScore(message.guildId, message.author.id, { fails: 1 });
  await message.react('❌').catch(() => {});
  await message.channel
    .send({
      embeds: [baseEmbed(COLORS.danger).setTitle('🔢 Count broken').setDescription(text)],
      allowedMentions: { users: [], roles: [], everyone: false },
    })
    .catch(() => {});
}

/* -------------------------------------------------------------------------- */
/* Levels (XP)                                                                */
/* -------------------------------------------------------------------------- */

const XP_COOLDOWN = 45_000;
const xpLast = new Map();

function levelsEnabled(guildId) {
  const rows = store.features.of(guildId, 'levels');
  if (!rows.length) return true; // on by default
  return (rows[0].config || {}).enabled !== false;
}

async function awardXp(client, message) {
  if (!message.guildId || message.author.bot) return null;
  if (!levelsEnabled(message.guildId)) return null;
  const key = `${message.guildId}:${message.author.id}`;
  const last = xpLast.get(key) || 0;
  if (Date.now() - last < XP_COOLDOWN) return null;
  xpLast.set(key, Date.now());
  if (xpLast.size > 10_000) xpLast.clear();

  const result = store.xp.add(message.guildId, message.author.id, 4 + Math.floor(Math.random() * 9));
  if (!result.levelledUp || result.level <= 0) return null;

  const channel = store.features.ids(message.guildId, 'levels')[0];
  const target = channel ? client.channels.cache.get(channel) : message.channel;
  if (!target) return null;
  await target
    .send({
      embeds: [
        baseEmbed(COLORS.ok)
          .setTitle('⬆️ Level up')
          .setDescription(`<@${message.author.id}> reached **level ${result.level}** with ${result.points} XP.`),
      ],
      allowedMentions: { users: [], roles: [], everyone: false },
    })
    .catch(() => {});
  return result;
}

/* -------------------------------------------------------------------------- */
/* AFK                                                                        */
/* -------------------------------------------------------------------------- */

const afkNotified = new Set();

async function handleAfkMentions(client, message) {
  if (!message.mentions?.users?.size) return false;
  let acted = false;
  for (const user of message.mentions.users.values()) {
    if (user.id === message.author.id || user.bot) continue;
    const row = store.afk.get(message.guildId, user.id);
    if (!row) continue;
    const until = row.until ? ` (back <t:${Math.floor(row.until / 1000)}:R>)` : '';
    await message
      .reply({
        embeds: [baseEmbed(COLORS.mod).setTitle(`💤 ${user.username} is AFK`).setDescription(shorten(row.note || 'Away from keyboard', 400) + until)],
        allowedMentions: { users: [], roles: [], everyone: false },
      })
      .catch(() => {});
    acted = true;
  }
  return acted;
}

async function clearAfkOnReturn(client, message) {
  if (!store.afk.get(message.guildId, message.author.id)) return false;
  store.afk.clear(message.guildId, message.author.id);
  if (afkNotified.has(message.author.id)) return false;
  afkNotified.add(message.author.id);
  setTimeout(() => afkNotified.delete(message.author.id), 60_000).unref?.();
  await message
    .reply({ content: '👋 Welcome back - I cleared your AFK status.', allowedMentions: { repliedUser: true } })
    .catch(() => {});
  return true;
}

/* -------------------------------------------------------------------------- */
/* Memes (Reddit public JSON, no API key, cached)                             */
/* -------------------------------------------------------------------------- */

const memeCache = { at: 0, items: [] };
const memeLastPost = new Map();

async function fetchMemes(subreddits = ['memes']) {
  if (Date.now() - memeCache.at < 10 * 60_000 && memeCache.items.length) return memeCache.items;
  const items = [];

  // primary: meme-api.com (Reddit mirror, no API key, batches of 10)
  for (const sub of subreddits.slice(0, 3)) {
    try {
      const res = await fetch(`https://meme-api.com/gimme/${encodeURIComponent(sub)}/10`, {
        headers: { 'User-Agent': 'dyno-lite/2.0 (discord bot)' },
        signal: AbortSignal.timeout(9_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data?.memes) ? data.memes : [data];
      for (const meme of list) {
        if (!meme?.url || meme.nsfw) continue;
        items.push({
          title: meme.title || 'meme',
          image_url: meme.url,
          permalink: meme.postLink || null,
          author: meme.author || null,
          ups: meme.ups || 0,
        });
      }
    } catch {
      /* try the next source */
    }
    if (items.length >= 6) break;
  }

  // fallback: imgflip public template feed (always up, no key)
  if (!items.length) {
    try {
      const res = await fetch('https://api.imgflip.com/get_memes', { signal: AbortSignal.timeout(9_000) });
      if (res.ok) {
        const data = await res.json();
        for (const meme of (data?.data?.memes ?? []).slice(0, 25)) {
          items.push({
            title: meme.name,
            image_url: meme.url,
            permalink: `https://imgflip.com/memetemplate/${meme.id}`,
            author: 'imgflip',
            ups: 0,
          });
        }
      }
    } catch {
      /* offline */
    }
  }

  if (items.length) {
    // shuffle so repeated pulls differ
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    memeCache.items = items;
    memeCache.at = Date.now();
  }
  return memeCache.items;
}

async function randomMeme(guildId, attempt = 0) {
  const cfg = store.features.config(guildId, 'memes', { subreddits: ['memes'] });
  const subs = (cfg.subreddits && cfg.subreddits.length ? cfg.subreddits : ['memes']).slice(0, 3);

  let list = await fetchMemes(subs);
  if (!list.length && attempt === 0) {
    list = await fetchMemes(['memes', 'dankmemes', 'wholesomememes']); // retry with defaults
  }

  // last resort: reuse the memes already stored in Postgres
  if (!list.length) {
    try {
      const rows = await store.asyncRepo.recentMemes(guildId, 10);
      list = rows.map((row) => ({
        title: row.title,
        image_url: row.image_url,
        permalink: row.permalink,
        author: 'archive',
        ups: row.ups || 0,
      }));
    } catch {
      /* archive unavailable */
    }
  }

  if (!list.length) return null;
  const meme = list[Math.floor(Math.random() * list.length)];
  void store.asyncRepo.saveMeme(guildId, meme).catch(() => {});
  return meme;
}

async function memeFeedTick(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const row of store.features.of(guild.id, 'memes')) {
      const interval = Math.max(5, Number((row.config || {}).intervalMinutes) || 60) * 60_000;
      const last = memeLastPost.get(row.channelId) || 0;
      if (Date.now() - last < interval) continue;
      const channel = client.channels.cache.get(row.channelId);
      if (!channel) continue;
      const meme = await randomMeme(guild.id);
      if (!meme) continue;
      memeLastPost.set(row.channelId, Date.now());
      await channel
        .send({
          embeds: [
            baseEmbed(COLORS.brand)
              .setTitle(shorten(meme.title, 250))
              .setImage(meme.image_url)
              .setURL(meme.permalink || undefined)
              .setFooter({ text: `r/${(row.config || {}).subreddits?.[0] || 'memes'} · 👍 ${meme.ups}` }),
          ],
        })
        .catch(() => {});
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Starboard                                                                  */
/* -------------------------------------------------------------------------- */

async function handleReactionAdd(client, reaction, user) {
  if (user?.bot) return false;
  if (reaction.emoji?.name !== '⭐') return false;
  const message = reaction.message;
  if (!message?.guildId) return false;

  const cfg = store.features.config(message.guildId, 'starboard', { threshold: 3 });
  const target = store.features.ids(message.guildId, 'starboard')[0];
  if (!target) return false;

  const stars = (reaction.count || 1) + (message.reactions?.cache?.get('⭐')?.count || 0) > 0 ? reaction.count || 1 : 1;
  if (stars < Number(cfg.threshold || 3)) return false;

  const existing = await store.asyncRepo.starboardGet(message.guildId, message.id).catch(() => null);
  const channel = client.channels.cache.get(target);
  if (!channel) return false;

  const embed = baseEmbed(0xffc53d)
    .setTitle(`⭐ ${stars} · ${message.channel.name}`)
    .setAuthor({ name: message.author?.tag ?? 'unknown', iconURL: message.author?.displayAvatarURL?.({ size: 64 }) })
    .setDescription(shorten(message.content || '*(no text)*', 1500) || '*(no text)*')
    .addFields({ name: 'Jump', value: `[original message](https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id})` })
    .setTimestamp(message.createdTimestamp || Date.now());
  if (message.attachments?.size) embed.setImage([...message.attachments.values()][0].url);

  try {
    if (existing?.star_message_id) {
      const previous = await channel.messages.fetch(existing.star_message_id).catch(() => null);
      if (previous) {
        await previous.edit({ content: `⭐ **${stars}** · <#${message.channelId}>`, embeds: [embed] });
        await store.asyncRepo.starboardPut(message.guildId, message.id, previous.id, stars);
        return true;
      }
    }
    const sent = await channel.send({ content: `⭐ **${stars}** · <#${message.channelId}>`, embeds: [embed] });
    await store.asyncRepo.starboardPut(message.guildId, message.id, sent.id, stars);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Reminders & time capsules                                                  */
/* -------------------------------------------------------------------------- */

async function reminderTick(client) {
  const due = await store.asyncRepo.reminders(Date.now()).catch(() => []);
  for (const row of due) {
    await store.asyncRepo.completeReminder(row.id).catch(() => {});
    const isCapsule = row.kind === 'timecapsule';
    const payload = {
      embeds: [
        baseEmbed(isCapsule ? COLORS.info : COLORS.brand)
          .setTitle(isCapsule ? '⏳ Time capsule opened' : '⏰ Reminder')
          .setDescription(shorten(row.content, 1500))
          .setFooter({ text: `set <t:${Math.floor((row.due_at - 0) / 1000)}:R>` }),
      ],
      allowedMentions: { users: [row.user_id], roles: [], everyone: false },
    };

    if (isCapsule) {
      const user = await client.users.fetch(row.user_id).catch(() => null);
      await user?.send(payload).catch(() => {});
      const channel = client.channels.cache.get(row.channel_id);
      if (channel) await channel.send({ content: `<@${row.user_id}> your time capsule arrived - check your DMs 📬`, allowedMentions: { users: [], roles: [], everyone: false } }).catch(() => {});
    } else {
      const channel = client.channels.cache.get(row.channel_id);
      await channel?.send({ content: `<@${row.user_id}>`, ...payload }).catch(() => {});
    }
  }
  return due.length;
}

/* -------------------------------------------------------------------------- */
/* Message pipeline                                                           */
/* -------------------------------------------------------------------------- */

async function handleMessage(client, message) {
  if (!message.guildId || message.author.bot) return { handled: false };
  let handled = false;

  if (await enforceAdminOnly(client, message)) return { handled: true, reason: 'admin' };
  if (await enforceMediaOnly(client, message)) return { handled: true, reason: 'media' };

  await clearAfkOnReturn(client, message);
  await handleAfkMentions(client, message);
  await awardXp(client, message);

  if (await handleCounting(client, message)) handled = true;
  return { handled };
}

module.exports = {
  handleMessage,
  handleCounting,
  handleReactionAdd,
  commandChannelAllowed,
  commandChannelNotice,
  isStaff,
  levelsEnabled,
  awardXp,
  memeFeedTick,
  randomMeme,
  fetchMemes,
  reminderTick,
  clearAfkOnReturn,
  handleAfkMentions,
  MILESTONES,
};
