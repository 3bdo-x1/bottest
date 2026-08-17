'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { baseEmbed, COLORS, formatDuration, userTag } = require('./util');
const { settings, badWords, violations } = require('./db');
const { logEvent } = require('./logger');

/**
 * Auto-moderation engine.
 *
 * Memory contract:
 *  - word lists live in SQLite and are cached per guild in a small Map that is
 *    invalidated on every mutation (never a second copy of the DB in RAM).
 *  - the spam tracker stores NUMBERS ONLY (timestamps), one array per
 *    (guild,user) pair, hard-capped at 512 entries and swept every 30 s.
 */

const WORD_CACHE = new Map(); // guildId -> { words: RegExp|null, at: number }
const SPAM_TRACKER = new Map(); // "guildId:userId" -> number[]
const SPAM_TRACKER_CAP = 512;
const ESCALATION_WINDOW_MS = 10 * 60_000;

const INVITE_RE = /(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com\/invite)\/[\w-]+/i;

/* -------------------------------------------------------------------------- */
/* Word normalisation (defeat basic evasion: leetspeak, separators, zalgo)     */
/* -------------------------------------------------------------------------- */

// Only unambiguous substitutions - mapping "!" to "i" corrupts real sentences.
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

function normalise(text) {
  const stripped = String(text)
    // strip control chars + zero-width tricks used to evade word filters
    .replace(/[\u0000-\u001f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, '')
    .toLowerCase();
  let out = '';
  for (const ch of stripped) out += LEET[ch] ?? ch;
  return out
    .replace(/[^a-z0-9]+/g, ' ') // punctuation & emoji become separators
    .replace(/(.)\1+/g, '$1') // "daaamn" -> "damn", "hello" -> "helo"
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn a stored word into a pattern that tolerates separator spam: "h e c k". */
function wordToPattern(word) {
  return word
    .split('*')
    .map((part) => normalise(part).split('').join('\\s*'))
    .join('[a-z0-9\\s]*'); // "*" == any run of letters (wildcard)
}

function getWordRegex(guildId) {
  const cached = WORD_CACHE.get(guildId);
  if (cached) return cached.words;
  const rows = badWords.list(guildId);
  const words = rows
    .map((r) => r.word.toLowerCase().replace(/[^a-z0-9*]+/g, ''))
    .filter((w) => w.replace(/\*/g, '').length > 1)
    .slice(0, 400); // hard cap: keeps regex compilation bounded
  let regex = null;
  if (words.length) {
    const pattern = words.map(wordToPattern).join('|');
    try {
      // Boundary guards keep short words from matching inside longer words.
      regex = new RegExp(`(?:^|\\s)(?:${pattern})(?=\\s|$)`, 'i');
    } catch {
      regex = null;
    }
  }
  WORD_CACHE.set(guildId, { words: regex, at: Date.now() });
  return regex;
}

function invalidateWords(guildId) {
  WORD_CACHE.delete(guildId);
}

function matchBadWord(guildId, content) {
  const regex = getWordRegex(guildId);
  if (!regex) return null;
  const haystack = normalise(content);
  if (!haystack) return null;
  return regex.test(haystack) ? regex.source.slice(0, 120) : null;
}

/* -------------------------------------------------------------------------- */
/* Spam tracker                                                               */
/* -------------------------------------------------------------------------- */

function spamKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function recordSpam(guildId, userId, cfg) {
  const key = spamKey(guildId, userId);
  const windowMs = Math.max(2, cfg.spamSeconds) * 1000;
  const cutoff = Date.now() - windowMs;
  let stamps = SPAM_TRACKER.get(key);
  if (!stamps) {
    if (SPAM_TRACKER.size >= SPAM_TRACKER_CAP) sweepTrackers();
    stamps = [];
    SPAM_TRACKER.set(key, stamps);
  }
  stamps.push(Date.now());
  // keep only timestamps inside the sliding window (usually 3-8 numbers)
  let i = 0;
  while (i < stamps.length && stamps[i] < cutoff) i++;
  if (i) stamps.splice(0, i);
  return stamps.length;
}

function clearSpam(guildId, userId) {
  SPAM_TRACKER.delete(spamKey(guildId, userId));
}

function sweepTrackers() {
  const cutoff = Date.now() - 60_000;
  for (const [key, stamps] of SPAM_TRACKER) {
    let i = 0;
    while (i < stamps.length && stamps[i] < cutoff) i++;
    if (i) stamps.splice(0, i);
    if (stamps.length === 0) SPAM_TRACKER.delete(key);
  }
  if (SPAM_TRACKER.size > SPAM_TRACKER_CAP) {
    // hard drop: oldest keys first - correctness of a spam heuristic is not
    // worth unbounded memory.
    let excess = SPAM_TRACKER.size - SPAM_TRACKER_CAP;
    for (const key of SPAM_TRACKER.keys()) {
      if (excess-- <= 0) break;
      SPAM_TRACKER.delete(key);
    }
  }
  if (WORD_CACHE.size > 512) WORD_CACHE.clear();
}

/* -------------------------------------------------------------------------- */
/* Escalation                                                                 */
/* -------------------------------------------------------------------------- */

function escalationTimeoutMs(guildId, userId) {
  const hits = violations.countSince(guildId, userId, 'automod', Date.now() - ESCALATION_WINDOW_MS);
  if (hits >= 5) return 6 * 60 * 60_000;
  if (hits >= 3) return 60 * 60_000;
  return Math.max(5, 10) * 60_000;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function isExempt(message) {
  if (!message.guild) return true;
  if (message.author.bot || message.webhookId) return true;
  const cfg = settings.get(message.guildId);
  if (cfg?.exemptChannelIds?.includes(message.channelId)) return true;
  const member = message.member;
  if (!member) return true;
  if (cfg?.exemptRoleIds?.some((id) => member.roles.cache.has(id))) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return false;
}

/**
 * Run every auto-mod rule against a message.
 * @returns {Promise<null|'deleted'|'timedOut'>}
 */
async function runAutoMod(client, message) {
  if (isExempt(message)) return null;
  const cfg = settings.get(message.guildId);
  if (!cfg) return null;

  const content = message.content || '';
  let reason = null;
  let kind = 'word';

  if (cfg.wordsEnabled) {
    const hit = matchBadWord(message.guildId, content);
    if (hit) {
      reason = 'Banned word filter';
      kind = 'word';
    }
  }

  if (!reason && cfg.inviteFilter && INVITE_RE.test(content)) {
    reason = 'Invite link filter';
    kind = 'invite';
  }

  if (!reason && cfg.antispamEnabled) {
    const mentionCount =
      message.mentions.users.filter((u) => u.id !== message.author.id && !u.bot).size +
      message.mentions.roles.size +
      (message.mentions.everyone ? cfg.mentionLimit : 0);

    if (mentionCount >= Math.max(2, cfg.mentionLimit)) {
      reason = `Mass mention (${mentionCount} mentions)`;
      kind = 'mention';
    } else {
      const hits = recordSpam(message.guildId, message.author.id, cfg);
      if (hits >= Math.max(2, cfg.spamCount)) {
        reason = `Spam (${hits} messages in ${cfg.spamSeconds}s)`;
        kind = 'spam';
      }
    }
  }

  if (!reason) return null;

  // 1. remove the offending content
  try {
    await message.delete();
  } catch {
    /* missing perms / already gone */
  }

  if (kind !== 'spam' && kind !== 'mention') {
    // soft violations: delete + warn first, escalate only for repeat offenders
    violations.add(message.guildId, message.author.id, 'automod');
    const repeat = violations.countSince(message.guildId, message.author.id, 'automod', Date.now() - ESCALATION_WINDOW_MS);
    if (repeat < 3) {
      try {
        await message.channel.send({
          content: `<@${message.author.id}> that word is not allowed here.`,
          allowedMentions: { repliedUser: false, users: [message.author.id], roles: [], everyone: false },
        });
      } catch {
        /* ignore */
      }
      await logEvent(client, message.guildId, {
        action: 'automod',
        user: message.author,
        moderator: client.user,
        reason,
        detail: `Message deleted in <#${message.channelId}> (violation ${repeat} in the last 10 min).`,
      });
      return 'deleted';
    }
  }

  // "delete" / "warn" modes never escalate to a timeout
  if (cfg.automodAction === 'delete' || cfg.automodAction === 'warn') {
    clearSpam(message.guildId, message.author.id);
    await logEvent(client, message.guildId, {
      action: 'automod',
      user: message.author,
      moderator: client.user,
      reason,
      detail: `Action: ${cfg.automodAction} • channel <#${message.channelId}>`,
      extra: [['Rule', kind]],
    });
    return 'deleted';
  }

  // 2. hard violation: temporary timeout (native Discord timeout = zero memory)
  const ms = kind === 'spam' ? Math.max(1, cfg.spamMuteMinutes) * 60_000 : escalationTimeoutMs(message.guildId, message.author.id);
  violations.add(message.guildId, message.author.id, 'automod');
  clearSpam(message.guildId, message.author.id);

  let applied = false;
  try {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (member && member.moderatable) {
      await member.timeout(ms, `Auto-mod: ${reason}`);
      applied = true;
      const { timeouts } = require('./db');
      timeouts.set(message.guildId, message.author.id, `Auto-mod: ${reason}`, Date.now() + ms);
    }
  } catch {
    /* missing perms */
  }

  try {
    await message.channel.send({
      embeds: [
        baseEmbed(COLORS.danger)
          .setTitle('🛡️ Auto-mod action')
          .setDescription(
            `${userTag(message.author)} was ${applied ? `muted for **${formatDuration(ms)}**` : 'warned'} — ${reason}.`,
          )
          .setFooter({ text: `Auto-mod • ${kind}` }),
      ],
      allowedMentions: { users: [], roles: [], everyone: false },
    });
  } catch {
    /* ignore */
  }

  await logEvent(client, message.guildId, {
    action: 'automod',
    user: message.author,
    moderator: client.user,
    reason,
    detail: `${applied ? `Timeout ${formatDuration(ms)}` : 'No timeout applied (missing permission)'} • channel <#${message.channelId}>`,
    extra: [['Rule', kind]],
  });

  return applied ? 'timedOut' : 'deleted';
}

function trackerSize() {
  return SPAM_TRACKER.size;
}

module.exports = {
  runAutoMod,
  invalidateWords,
  normalise,
  matchBadWord,
  sweepTrackers,
  trackerSize,
  clearSpam,
  ESCALATION_WINDOW_MS,
};
