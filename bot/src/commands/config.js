'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { settings, customCommands } = require('../db');
const { logEvent } = require('../logger');
const { baseEmbed, COLORS, shorten } = require('../util');

const NAME_OK = /^[\w-]{1,32}$/;
const FRAME_TOP = '╭─────────────────────────────────────╮';
const FRAME_BOTTOM = '╰─────────────────────────────────────╯';

module.exports = [
  {
    name: 'setprefix',
    description: 'Change the prefix used for message commands.',
    category: 'Config',
    usage: 'setprefix <prefix>',
    example: '!setprefix ?',
    userPerms: [PermissionFlagsBits.ManageGuild],
    options: [{ name: 'prefix', description: 'New prefix (1-5 characters)', type: 'string', required: true, greedy: false }],
    async execute(ctx) {
      const prefix = (ctx.str('prefix') || '').trim().replace(/\s+/g, '');
      if (!prefix || prefix.length > 5) return ctx.error('Prefix must be 1-5 characters with no spaces.');
      settings.update(ctx.guild.id, { prefix });
      await logEvent(ctx.client, ctx.guild.id, { action: 'settings', moderator: ctx.user, reason: `Prefix changed to \`${prefix}\`` });
      return ctx.send({
        embeds: [baseEmbed(COLORS.ok).setTitle('⚙️ Prefix updated').setDescription(`Message commands now start with \`${prefix}\` — try \`${prefix}ping\`.`)],
      });
    },
  },

  {
    name: 'autorole',
    description: 'Automatically give new members a role.',
    category: 'Config',
    usage: 'autorole [role] [disable]',
    example: '!autorole @Member',
    userPerms: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageGuild],
    botPerms: [PermissionFlagsBits.ManageRoles],
    options: [
      { name: 'role', description: 'Role to assign on join', type: 'role' },
      { name: 'disable', description: 'Turn autorole off', type: 'boolean' },
    ],
    async execute(ctx) {
      if (ctx.bool('disable', false)) {
        settings.update(ctx.guild.id, { autoroleId: null });
        await logEvent(ctx.client, ctx.guild.id, { action: 'settings', moderator: ctx.user, reason: 'Autorole disabled' });
        return ctx.success('Autorole disabled.');
      }
      const role = ctx.targetRole('role');
      if (!role) {
        const cfg = settings.get(ctx.guild.id);
        return ctx.send({
          embeds: [baseEmbed(COLORS.info).setTitle('🛬 Autorole').setDescription(cfg.autoroleId ? `Currently assigning ${cfg.autoroleId ? `<@&${cfg.autoroleId}>` : 'none'}.` : 'Autorole is not configured.')],
        });
      }
      if (role.id === ctx.guild.id) return ctx.error('That is the @everyone role.');
      if (role.managed) return ctx.error('That role is managed by an integration.');
      if (ctx.me && role.position >= ctx.me.roles.highest.position) return ctx.error('My highest role must be above that role.');
      settings.update(ctx.guild.id, { autoroleId: role.id });
      await logEvent(ctx.client, ctx.guild.id, { action: 'settings', moderator: ctx.user, reason: `Autorole set to ${role.name}` });
      return ctx.send({
        embeds: [baseEmbed(COLORS.ok).setTitle('🛬 Autorole configured').setDescription(`New members will receive <@&${role.id}>.`)],
      });
    },
  },

  {
    name: 'announce',
    description: 'Send a framed embed announcement to a channel.',
    category: 'Config',
    usage: 'announce <channel> <message> [title]',
    example: '/announce channel:#news message:Server rules updated',
    userPerms: [PermissionFlagsBits.ManageMessages],
    botPerms: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    options: [
      { name: 'channel', description: 'Channel to post in', type: 'channel', required: true },
      { name: 'message', description: 'Announcement text', type: 'string', required: true },
      { name: 'title', description: 'Embed title', type: 'string', greedy: false },
    ],
    async execute(ctx) {
      const target = ctx.targetChannel('channel');
      if (!target || !target.isTextBased() || target.isVoiceBased()) return ctx.error('Pick a text channel.');
      const message = ctx.str('message');
      if (!message) return ctx.error('Write the announcement message.');
      const title = ctx.str('title', '📣 Announcement');

      const embed = baseEmbed(COLORS.brand)
        .setAuthor({ name: `${ctx.guild.name}`, iconURL: ctx.guild.iconURL({ size: 64 }) ?? undefined })
        .setTitle(shorten(title, 250))
        .setDescription(`\`\`\`fix\n${FRAME_TOP}\n\`\`\`\n${shorten(message, 3900)}\n\`\`\`fix\n${FRAME_BOTTOM}\n\`\`\``)
        .setFooter({ text: `Announced by ${ctx.user.tag}`, iconURL: ctx.user.displayAvatarURL({ size: 64 }) });

      try {
        await target.send({
          embeds: [embed],
          allowedMentions: { parse: ['users'], roles: [], everyone: false },
        });
      } catch (error) {
        return ctx.error(`Could not post there: ${error.message}`);
      }
      await logEvent(ctx.client, ctx.guild.id, {
        action: 'announce',
        moderator: ctx.user,
        reason: shorten(title, 200),
        detail: `Sent to <#${target.id}>`,
      });
      return ctx.success(`Announcement posted in <#${target.id}>.`);
    },
  },

  {
    name: 'setlogchannel',
    description: 'Set the channel used for moderation + audit logs.',
    category: 'Config',
    usage: 'setlogchannel [channel] [separate_mod_logs]',
    example: '!setlogchannel #mod-logs',
    userPerms: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ViewAuditLog],
    botPerms: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    options: [
      { name: 'channel', description: 'Log channel', type: 'channel' },
      { name: 'separate_mod_logs', description: 'Use a different channel for mod actions', type: 'channel' },
    ],
    async execute(ctx) {
      const cfg = settings.get(ctx.guild.id);
      const main = ctx.targetChannel('channel');
      const mod = ctx.isSlash ? ctx.interaction.options.getChannel('separate_mod_logs', false) : null;

      if (!main && !mod) {
        return ctx.send({
          embeds: [
            baseEmbed(COLORS.info).setTitle('📜 Logging').setDescription(
              `**Audit log channel:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'not set'}\n` +
                `**Mod log channel:** ${cfg.modLogChannelId ? `<#${cfg.modLogChannelId}>` : 'not set'}\n\n` +
                'Logged events: deleted messages, kicks, bans, unbans, timeouts, warns, purges, auto-mod actions and role updates.',
            ),
          ],
        });
      }
      const patch = {};
      if (main) patch.logChannelId = main.id;
      if (mod) patch.modLogChannelId = mod.id;
      else if (main) patch.modLogChannelId = main.id;
      settings.update(ctx.guild.id, patch);

      await logEvent(ctx.client, ctx.guild.id, {
        action: 'settings',
        moderator: ctx.user,
        reason: `Log channels updated → <#${main?.id ?? mod?.id}>`,
      });
      return ctx.success(
        `Audit logs → <#${patch.logChannelId ?? '?'}>${patch.modLogChannelId ? ` • mod actions → <#${patch.modLogChannelId}>` : ''}`,
      );
    },
  },

  {
    name: 'customcommand',
    description: 'Create, delete and list custom text commands.',
    category: 'Config',
    usage: 'customcommand <add|delete|list|run> [name] [response]',
    example: '!customcommand add rules Read #rules first',
    userPerms: [PermissionFlagsBits.ManageMessages],
    options: [],
    subcommands: [
      {
        name: 'add',
        description: 'Add or update a custom command.',
        options: [
          { name: 'name', description: 'Command name', type: 'string', required: true, greedy: false },
          { name: 'response', description: 'Text the bot replies with', type: 'string', required: true },
        ],
        async execute(ctx) {
          const name = (ctx.str('name') || '').toLowerCase().replace(/[/\s]/g, '');
          const response = ctx.str('response');
          if (!NAME_OK.test(name)) return ctx.error('Name must be 1-32 letters, numbers, dashes or underscores.');
          if (!response || response.length < 2) return ctx.error('Provide a response.');
          if (response.length > 1500) return ctx.error('Response must be under 1500 characters.');
          const existingCount = customCommands.list(ctx.guild.id).length;
          if (existingCount >= customCommands.MAX && !customCommands.get(ctx.guild.id, name)) {
            return ctx.error(`Limit of ${customCommands.MAX} custom commands reached (memory guard).`);
          }
          if (require('./index').registry.has(name)) return ctx.error('That name collides with a built-in command.');

          customCommands.add(ctx.guild.id, name, response, ctx.user.id);

          // Register it as a real slash command in this guild so /name works too.
          let slashId = null;
          try {
            const created = await ctx.guild.commands.create({
              name,
              description: shorten(response, 90),
              type: 1,
            });
            slashId = created?.id ?? null;
          } catch {
            /* slash registration is best-effort; the prefix version still works */
          }
          if (slashId) customCommands.setCommandId(ctx.guild.id, name, slashId);

          await logEvent(ctx.client, ctx.guild.id, {
            action: 'custom_command',
            moderator: ctx.user,
            reason: `Added /${name}`,
            detail: shorten(response, 200),
          });
          return ctx.send({
            embeds: [
              baseEmbed(COLORS.ok)
                .setTitle('⌨️ Custom command saved')
                .setDescription(`\`/${name}\` and \`${ctx.settings.prefix}${name}\` now reply with:\n${shorten(response, 500)}`),
            ],
          });
        },
      },
      {
        name: 'delete',
        description: 'Delete a custom command.',
        options: [{ name: 'name', description: 'Command name', type: 'string', required: true, greedy: false }],
        async execute(ctx) {
          const name = (ctx.str('name') || '').toLowerCase();
          const removed = customCommands.remove(ctx.guild.id, name);
          if (!removed) return ctx.error(`No custom command named \`${name}\`.`);
          if (removed.command_id) await ctx.guild.commands.delete(removed.command_id).catch(() => {});
          await logEvent(ctx.client, ctx.guild.id, { action: 'custom_command', moderator: ctx.user, reason: `Deleted /${name}` });
          return ctx.success(`Deleted \`${name}\`.`);
        },
      },
      {
        name: 'list',
        description: 'List all custom commands.',
        options: [],
        async execute(ctx) {
          const rows = customCommands.list(ctx.guild.id);
          const embed = baseEmbed(COLORS.info).setTitle('⌨️ Custom commands');
          if (!rows.length) embed.setDescription('None yet. Add one with `/customcommand add`.');
          else embed.setDescription(rows.map((r) => `\`${r.name}\` → ${shorten(r.response, 80)}`).join('\n').slice(0, 3900));
          embed.setFooter({ text: `${rows.length}/${customCommands.MAX} used` });
          return ctx.send({ embeds: [embed] });
        },
      },
      {
        name: 'run',
        description: 'Run a custom command.',
        options: [{ name: 'name', description: 'Command name', type: 'string', required: true, greedy: false }],
        async execute(ctx) {
          const name = (ctx.str('name') || '').toLowerCase();
          const found = customCommands.get(ctx.guild.id, name);
          if (!found) return ctx.error(`No custom command named \`${name}\`.`);
          customCommands.bump(name, ctx.guild.id);
          return ctx.send({ content: shorten(found.response, 2000) });
        },
      },
    ],
  },

  {
    name: 'help',
    description: 'List every command with usage examples.',
    category: 'Utility',
    usage: 'help [command]',
    example: '!help ban',
    options: [{ name: 'command', description: 'Show detail for one command', type: 'string', greedy: false }],
    async execute(ctx) {
      const handler = require('./index');
      const name = (ctx.str('command') || '').toLowerCase();
      if (name) {
        const cmd = handler.registry.get(name);
        if (!cmd) return ctx.error(`No command named \`${name}\`.`);
        const embed = baseEmbed(COLORS.brand)
          .setTitle(`/${cmd.name}`)
          .setDescription(cmd.description)
          .addFields(
            { name: 'Slash usage', value: `\`/${cmd.usage}\`` },
            { name: 'Prefix usage', value: `\`${ctx.settings.prefix}${cmd.usage}\`` },
            { name: 'Example', value: `\`${cmd.example}\`` },
            { name: 'Category', value: cmd.category, inline: true },
          );
        return ctx.send({ embeds: [embed] });
      }
      return ctx.send({ embeds: [baseEmbed(COLORS.brand).setTitle('📖 Command reference').setDescription(handler.helpOverview().slice(0, 3900))] });
    },
  },
];
