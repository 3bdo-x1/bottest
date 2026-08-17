'use strict';

/**
 * Lightweight command handler.
 *
 * One definition per command powers BOTH the slash registration payload and the
 * legacy prefix parser, so nothing is duplicated and there is no extra dependency
 * (no discord-akairo / @sapphire / discordx — those cost megabytes).
 */

const {
  ApplicationCommandOptionType,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { settings } = require('../db');
const { fail, hasAny } = require('../util');
const { customCommands } = require('../db');

const MODULES = [
  './moderation',   // kick ban unban mute unmute purge warn warnings modlogs
  './automod',      // badwords automod
  './utility',      // serverinfo userinfo ping avatar roll eightball
  './config',       // setprefix autorole announce setlogchannel customcommand help
  './setup',        // counting mediaonly adminchannel botchannel automemes starboard confess suggest levels
  './unique',       // vibecheck ship wheel randomperson meme rank leaderboard
  './tools',        // remind timecapsule afk quote snipe confess suggest suggestions
];

const TYPE_MAP = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  member: ApplicationCommandOptionType.Member,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
  mentionable: ApplicationCommandOptionType.Mentionable,
};

const registry = new Map(); // name -> definition
const categories = new Map(); // category -> names[]

function register(def) {
  if (!def || !def.name) return;
  const command = {
    slash: def.slash !== false,
    prefix: def.prefix !== false,
    ephemeral: def.ephemeral !== false,
    ...def,
  };
  registry.set(command.name, command);
  const list = categories.get(command.category) || [];
  list.push(command.name);
  categories.set(command.category, list);
}

function load() {
  for (const mod of MODULES) {
    const defs = require(mod);
    for (const def of defs) register(def);
  }
  return registry;
}

/* -------------------------------------------------------------------------- */
/* Slash payload builder                                                      */
/* -------------------------------------------------------------------------- */

function toSlashOption(opt) {
  return {
    name: opt.name,
    description: opt.description || opt.name,
    type: TYPE_MAP[opt.type] ?? ApplicationCommandOptionType.String,
    required: opt.required !== false,
    autocomplete: opt.autocomplete || undefined,
    choices: opt.choices || undefined,
    channel_types: opt.type === 'channel' ? [ChannelType.GuildText, ChannelType.GuildAnnouncement] : undefined,
    min_value: opt.min !== undefined ? opt.min : undefined,
    max_value: opt.max !== undefined ? opt.max : undefined,
  };
}

function buildSlashJson() {
  const out = [];
  for (const cmd of registry.values()) {
    if (!cmd.slash) continue;
    const data = {
      name: cmd.name,
      description: cmd.description.slice(0, 100),
      // PermissionFlagsBits are BigInts - the REST API wants a decimal string.
      default_member_permissions: (() => {
        const bits = (cmd.userPerms || []).filter((p) => typeof p === 'bigint');
        return bits.length ? String(bits.reduce((acc, bit) => acc | bit, 0n)) : undefined;
      })(),
      dm_permission: false,
      options: [],
    };
    if (cmd.subcommands?.length) {
      for (const sub of cmd.subcommands) {
        data.options.push({
          name: sub.name,
          description: sub.description.slice(0, 100),
          type: ApplicationCommandOptionType.Subcommand,
          options: (sub.options || []).map(toSlashOption),
        });
      }
    } else {
      data.options = (cmd.options || []).map(toSlashOption);
    }
    out.push(data);
  }
  return out;
}

function helpOverview() {
  const lines = [];
  for (const [category, names] of categories) {
    lines.push(`**${category}**`);
    for (const name of names) {
      const cmd = registry.get(name);
      lines.push(`\`${cmd.usage || name}\` — ${cmd.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Context object                                                             */
/* -------------------------------------------------------------------------- */

const ID_RE = /^<?@?&?#?(\d{15,20})>?$/;

function parseSnowflake(token) {
  if (!token) return null;
  const raw = String(token).trim();
  const mention = /^<@!?(\d{15,20})>$/.exec(raw) || /^<#(\d{15,20})>$/.exec(raw) || /^<@&(\d{15,20})>$/.exec(raw);
  if (mention) return mention[1];
  const bare = ID_RE.exec(raw);
  if (bare) return bare[1];
  // raw username lookup (best effort, cache-only => zero network cost)
  return null;
}

function makeContext({ client, interaction, message, command, sub, args = [] }) {
  const isSlash = Boolean(interaction);
  const guild = isSlash ? interaction.guild : message.guild;
  const channel = isSlash ? interaction.channel : message.channel;
  const member = isSlash ? interaction.member : message.member;
  const user = isSlash ? interaction.user : message.author;
  const positional = args.slice();
  if (!isSlash && sub && positional.length && positional[0].toLowerCase() === String(sub).toLowerCase()) {
    positional.shift(); // consume the subcommand token
  }

  const ctx = {
    client,
    guild,
    channel,
    member,
    user,
    author: user,
    me: guild?.members?.me ?? null,
    isSlash,
    interaction,
    message,
    command,
    sub: sub || null,
    args,
    settings: guild ? settings.ensure(guild.id) : null,
    replied: false,
    deferred: false,
  };

  /** Raw slash option value / positional prefix token. */
  ctx.raw = (name) => {
    const host = sub ? ctx.command.subcommands.find((s) => s.name === sub) : ctx.command;
    const optDef = (host?.options || []).find((o) => o.name === name);
    if (isSlash) return interaction.options.get(name, false)?.value;
    if (!optDef) return ctx.args.shift();
    if (optDef.type === 'boolean') {
      const token = ctx.args[0];
      if (token && /^(on|off|true|false|yes|no|enable|disable)$/i.test(token)) {
        ctx.args.shift();
        return /^(on|true|yes|enable)$/i.test(token);
      }
      return undefined;
    }
    if (optDef.type === 'integer' || optDef.type === 'number') {
      const token = ctx.args.shift();
      if (token == null) return undefined;
      const n = Number(token);
      return Number.isFinite(n) ? n : undefined;
    }
    if (optDef.type === 'string' && optDef.greedy !== false) {
      // trailing string option consumes the rest of the message (reasons, etc.)
      const tail = ctx.args.join(' ');
      ctx.args.length = 0;
      return tail || undefined;
    }
    return ctx.args.shift();
  };

  ctx.str = (name, fallback) => {
    const v = ctx.raw(name);
    return typeof v === 'string' && v.length ? v : fallback;
  };
  ctx.int = (name, fallback) => {
    const v = Number(ctx.raw(name));
    return Number.isFinite(v) ? v : fallback;
  };
  ctx.bool = (name, fallback) => {
    const v = ctx.raw(name);
    return typeof v === 'boolean' ? v : fallback;
  };
  ctx.snowflake = (name) => {
    const v = ctx.raw(name);
    if (typeof v === 'string') return parseSnowflake(v) || (/^\d{15,20}$/.test(v) ? v : null);
    if (typeof v === 'object' && v?.id) return v.id;
    return null;
  };
  ctx.targetMember = async (name = 'user') => {
    if (isSlash) {
      const m = interaction.options.getMember(name);
      if (m) return m;
      const id = interaction.options.getUser(name)?.id;
      if (id && guild) return guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
      return null;
    }
    const id = ctx.snowflake(name);
    if (!id) return null;
    const cached = guild?.members?.cache?.get(id);
    if (cached) return cached;
    try {
      return (await guild.members.fetch(id)) || null;
    } catch {
      return null;
    }
  };
  ctx.targetUser = async (name = 'user') => {
    if (isSlash) return interaction.options.getUser(name, false) || null;
    const id = ctx.snowflake(name);
    if (!id) return null;
    const cached = client.users.cache.get(id);
    if (cached) return cached;
    return client.users.fetch(id).catch(() => null);
  };
  ctx.targetRole = (name = 'role') => {
    if (isSlash) return interaction.options.getRole(name, false) || null;
    const id = ctx.snowflake(name);
    return id ? guild?.roles?.cache?.get(id) ?? null : null;
  };
  ctx.targetChannel = (name = 'channel') => {
    if (isSlash) return interaction.options.getChannel(name, false) || null;
    const id = ctx.snowflake(name);
    if (!id) return ctx.channel;
    return client.channels.cache.get(id) || ctx.channel;
  };
  ctx.reason = (name = 'reason', fallback = 'No reason provided') => ctx.str(name, fallback);

  ctx.send = async (payload) => {
    if (isSlash) {
      const fn = ctx.deferred || ctx.replied ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
      ctx.replied = true;
      return fn(payload);
    }
    return channel.send(payload);
  };
  ctx.defer = async () => {
    if (isSlash && !ctx.deferred && !ctx.replied) {
      ctx.deferred = true;
      await interaction.deferReply({ withResponse: false }).catch(() => {});
    }
  };
  ctx.error = (text) => ctx.send(fail(text));
  ctx.success = (text) => ctx.send({ content: `✅ ${text}`, ephemeral: isSlash });

  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

function guard(ctx) {
  const { command, guild, member, me } = ctx;
  if (!guild) return 'Commands only work inside servers.';
  if (command.userPerms?.length && !hasAny(member, command.userPerms)) {
    return 'You do not have permission to use this command.';
  }
  if (command.botPerms?.length) {
    const missing = command.botPerms.filter((p) => !me?.permissions?.has(p));
    if (missing.length) {
      return `I need the \`${missing.map((m) => Object.keys(PermissionFlagsBits).find((k) => PermissionFlagsBits[k] === m) || m).join('`, `')}\` permission for that.`;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Routers                                                                    */
/* -------------------------------------------------------------------------- */

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  const command = registry.get(name);

  let sub = null;
  try {
    sub = interaction.options.getSubcommand(false);
  } catch {
    sub = null;
  }

  const ctx = makeContext({
    client: interaction.client,
    interaction,
    message: null,
    command: command || { name, description: name, options: [], subcommands: [] },
    sub,
  });

  if (!command) {
    // Unknown built-in => maybe a registered custom command (/rules, /faq ...)
    const custom = customCommands.get(ctx.guild?.id, name);
    if (!custom) return void (await ctx.error('That command is not available. Run `/help`.'));
    customCommands.bump(name, ctx.guild.id);
    return void (await ctx.send({ content: custom.response.slice(0, 2000) }));
  }

  const blocked = guard(ctx);
  if (blocked) {
    return void interaction.reply({ ...fail(blocked), flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  try {
    if (sub && command.subcommands?.length) {
      const subDef = command.subcommands.find((s) => s.name === sub);
      if (!subDef?.execute) return void (await ctx.error(`Unknown subcommand \`${sub}\`.`));
      await subDef.execute(ctx);
    } else {
      await command.execute(ctx);
    }
  } catch (error) {
    const payload = { ...fail(`Command failed: ${String(error?.message || error).slice(0, 300)}`), flags: MessageFlags.Ephemeral };
    await (ctx.deferred || ctx.replied
      ? interaction.followUp(payload).catch(() => {})
      : interaction.reply(payload).catch(() => {}));
  }
}

async function handleMessage(client, message, prefixLength) {
  const name = (message.__commandName || '').toLowerCase();
  const command = registry.get(name);
  const ctx = makeContext({
    client,
    interaction: null,
    message,
    command: command || { name, description: name, options: [], subcommands: [] },
    sub: command?.subcommands?.length ? (ctxArgSub(message) ?? null) : null,
  });

  if (!command) {
    const custom = customCommands.get(ctx.guild.id, name);
    if (!custom) return null;
    customCommands.bump(name, ctx.guild.id);
    return ctx.send({ content: custom.response.slice(0, 2000) });
  }

  const blocked = guard(ctx);
  if (blocked) return void (await message.reply(blocked).catch(() => {}));

  try {
    if (ctx.sub && command.subcommands?.length) {
      const subDef = command.subcommands.find((s) => s.name === ctx.sub);
      if (!subDef?.execute) return void (await message.reply(`Unknown subcommand \`${ctx.sub}\`.`).catch(() => {}));
      return void (await subDef.execute(ctx));
    }
    await command.execute(ctx);
  } catch (error) {
    await message.reply(`❌ Command failed: ${String(error?.message || error).slice(0, 300)}`).catch(() => {});
  }
}

/** Parse a raw prefix invocation: "!kick @user spamming" -> name + args. */
function parseInvocation(content, prefixes) {
  const trimmed = content.trim();
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
      const rest = trimmed.slice(prefix.length).trim();
      const parts = rest.split(/\s+/);
      const name = String(parts.shift() || '').toLowerCase();
      if (!/^[\w-]{1,32}$/.test(name)) return null;
      return { name, args: parts };
    }
  }
  return null;
}

module.exports = {
  load,
  registry,
  categories,
  buildSlashJson,
  helpOverview,
  handleInteraction,
  handleMessage,
  makeContext,
  guard,
  parseInvocation,
};
