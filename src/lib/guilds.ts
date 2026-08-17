import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * The bot owns the DDL (bot/src/db.js) and creates these tables on boot.
 * Drizzle is used here for typed reads/writes from the dashboard only, so we
 * never run `drizzle-kit push` against them (no drift, no accidental drops).
 */

export type GuildSettingsRow = {
  guild_id: string;
  prefix: string;
  log_channel_id: string | null;
  mod_log_channel_id: string | null;
  autorole_id: string | null;
  words_enabled: number;
  antispam_enabled: number;
  mention_limit: number;
  spam_count: number;
  spam_seconds: number;
  spam_mute_minutes: number;
  invite_filter: number;
  welcome_enabled: number;
  welcome_channel_id: string | null;
  welcome_message: string;
  welcome_embed: number;
  welcome_auto_delete: number;
  farewell_enabled: number;
  farewell_channel_id: string | null;
  farewell_message: string;
  log_deleted: number;
  log_joins: number;
  log_kicks: number;
  log_bans: number;
  log_timeouts: number;
  log_roles: number;
  log_automod: number;
  log_config: number;
  automod_action: string;
  exempt_role_ids: string;
  exempt_channel_ids: string;
};

export type FeatureRow = {
  id: number;
  guild_id: string;
  type: string;
  channel_id: string;
  enabled: number;
  config: Record<string, unknown>;
};

export const FEATURE_TYPES = [
  "media",
  "counting",
  "admin",
  "botcmd",
  "memes",
  "starboard",
  "confess",
  "suggestions",
  "levels",
] as const;

export async function getGuildSettings(guildId: string): Promise<GuildSettingsRow | null> {
  const result = await db.execute<GuildSettingsRow>(
    sql`select * from guilds where guild_id = ${guildId} limit 1`,
  );
  return result.rows[0] ?? null;
}

export async function getGuildFeatures(guildId: string): Promise<FeatureRow[]> {
  const result = await db.execute<FeatureRow>(
    sql`select id, guild_id, type, channel_id, enabled, config from feature_channels where guild_id = ${guildId} order by id asc`,
  );
  return result.rows ?? [];
}

export async function getGuildBadWords(guildId: string): Promise<string[]> {
  const result = await db.execute<{ word: string }>(
    sql`select word from bad_words where guild_id = ${guildId} order by word`,
  );
  return (result.rows ?? []).map((r) => r.word);
}

export async function getKnownGuilds(): Promise<{ guild_id: string }[]> {
  const result = await db.execute<{ guild_id: string }>(
    sql`select guild_id from guilds where guild_id <> '' order by updated_at desc limit 200`,
  );
  return result.rows ?? [];
}

const INT_COLUMNS = [
  "words_enabled",
  "antispam_enabled",
  "invite_filter",
  "welcome_enabled",
  "welcome_embed",
  "welcome_auto_delete",
  "farewell_enabled",
  "log_deleted",
  "log_joins",
  "log_kicks",
  "log_bans",
  "log_timeouts",
  "log_roles",
  "log_automod",
  "log_config",
  "mention_limit",
  "spam_count",
  "spam_seconds",
  "spam_mute_minutes",
] as const;

type SettingsPatch = Partial<Record<(typeof INT_COLUMNS)[number] | string, string | number | null>>;

/** Upsert a settings patch. Used when the bot process is offline. */
export async function upsertSettings(guildId: string, patch: SettingsPatch): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  // make sure the row exists, then apply the patch (true upsert)
  await db.execute(sql`
    insert into guilds (guild_id, prefix, updated_at)
    values (${guildId}, '!', ${Date.now()})
    on conflict (guild_id) do nothing
  `);
  const assignments = keys.map((key) => sql`${sql.identifier(key)} = ${patch[key]}`);
  await db.execute(sql`
    update guilds
    set ${sql.join(assignments, sql`, `)}, updated_at = ${Date.now()}
    where guild_id = ${guildId}
  `);
}

export async function setFeature(
  guildId: string,
  type: string,
  channelId: string,
  config: Record<string, unknown>,
  enabled: boolean,
): Promise<void> {
  await db.execute(sql`
    insert into feature_channels (guild_id, type, channel_id, enabled, config, created_at)
    values (${guildId}, ${type}, ${channelId}, ${enabled ? 1 : 0}, ${JSON.stringify(config)}::jsonb, ${Date.now()})
    on conflict (guild_id, type, channel_id)
    do update set enabled = excluded.enabled, config = excluded.config
  `);
}

export async function removeFeature(guildId: string, type: string, channelId: string | null): Promise<void> {
  if (channelId) {
    await db.execute(
      sql`delete from feature_channels where guild_id = ${guildId} and type = ${type} and channel_id = ${channelId}`,
    );
    return;
  }
  await db.execute(sql`delete from feature_channels where guild_id = ${guildId} and type = ${type}`);
}

export async function replaceBadWords(guildId: string, words: string[]): Promise<void> {
  const cleaned = [...new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9*]/g, "")).filter((w) => w.replace(/\*/g, "").length > 1))].slice(0, 400);
  await db.execute(sql`delete from bad_words where guild_id = ${guildId}`);
  if (!cleaned.length) return;
  await db.execute(sql`
    insert into bad_words (guild_id, word) values ${sql.join(
      cleaned.map((word) => sql`(${guildId}, ${word})`),
      sql`, `,
    )} on conflict do nothing
  `);
}
