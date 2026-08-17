'use strict';

/**
 * Welcome / farewell system (pure functions + one send call).
 *
 * Templates support these placeholders:
 *   {user}      -> <@123456789012345678>  (mention)
 *   {username}  -> name without discriminator
 *   {tag}       -> name#0000
 *   {server}    -> guild name
 *   {count}     -> member count after the join
 *
 * Rendering happens at send time (never cached), so editing a template from the
 * dashboard takes effect on the very next join.
 */

const { baseEmbed, COLORS, shorten } = require('./util');
const { settings } = require('./db');

const PLACEHOLDERS = [
  ['{user}', (member) => `<@${member.id}>`],
  ['{username}', (member) => (member.user ? member.user.username : 'member')],
  ['{tag}', (member) => (member.user ? member.user.tag : 'member')],
  ['{server}', (member) => (member.guild ? member.guild.name : 'the server')],
  ['{count}', (member) => String((member.guild && member.guild.memberCount) || '?')],
];

function render(template, member) {
  let out = String(template || '');
  for (const [token, fn] of PLACEHOLDERS) out = out.split(token).join(fn(member));
  return out;
}

/** Dashboard preview: renders against a mock member so you can see the result. */
function preview(template, guildName, memberCount) {
  const mock = {
    id: '1538820854719455232',
    user: { username: 'NewMember', tag: 'NewMember#0001' },
    guild: { name: guildName || 'your server', memberCount: memberCount || 42 },
  };
  return render(template, mock);
}

function buildPayload(cfg, member, kind) {
  const isJoin = kind === 'join';
  const template = isJoin ? cfg.welcomeMessage : cfg.farewellMessage;
  const channelId = isJoin ? cfg.welcomeChannelId : cfg.farewellChannelId;
  const text = render(template, member);

  if (isJoin && cfg.welcomeEmbed) {
    return {
      content: text.includes('<@') ? text.replace(/[^ ]*<@!?\d+>[^ ]*/g, (m) => m).slice(0, 60) : undefined,
      embeds: [
        baseEmbed(isJoin ? COLORS.ok : COLORS.mod)
          .setAuthor({
            name: `${member.user ? member.user.tag : 'member'} ${isJoin ? 'joined' : 'left'}`,
            iconURL: member.user ? member.user.displayAvatarURL({ size: 64 }) : undefined,
          })
          .setDescription(shorten(text, 3900))
          .addFields({ name: 'Member count', value: String((member.guild && member.guild.memberCount) || '?'), inline: true })
          .setFooter({ text: member.guild ? member.guild.name : '' }),
      ],
    };
  }

  return { content: shorten(text, 1900) };
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').GuildMember} member
 * @param {'join'|'leave'} kind
 * @returns {Promise<boolean>} whether a message was sent
 */
async function send(client, member, kind) {
  const guildId = member.guild && member.guild.id;
  if (!guildId) return false;

  const cfg = settings.get(guildId);
  const isJoin = kind === 'join';
  if (isJoin ? !cfg.welcomeEnabled : !cfg.farewellEnabled) return false;

  const channelId = isJoin ? cfg.welcomeChannelId : cfg.farewellChannelId;
  if (!channelId) return false;

  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased?.() || channel.isVoiceBased?.()) return false;

  const payload = buildPayload(cfg, member, kind);
  payload.allowedMentions = { parse: ['users'], roles: [], everyone: false };

  try {
    const message = await channel.send(payload);
    const seconds = Number(cfg.welcomeAutoDelete) || 0;
    if (isJoin && seconds > 0) {
      setTimeout(() => {
        message.delete().catch(() => {});
      }, Math.min(600, seconds) * 1000).unref?.();
    }
    return true;
  } catch {
    return false; // missing permissions or deleted channel - never crash the join handler
  }
}

module.exports = { send, render, preview, PLACEHOLDERS };
