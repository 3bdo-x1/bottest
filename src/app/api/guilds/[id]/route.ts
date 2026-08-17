import { NextResponse } from "next/server";
import { botApi, type BotGuildView } from "@/lib/bot";
import {
  FEATURE_TYPES,
  getGuildBadWords,
  getGuildFeatures,
  getGuildSettings,
  removeFeature,
  replaceBadWords,
  setFeature,
  upsertSettings,
} from "@/lib/guilds";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const GUILD_ID = /^\d{15,20}$/;

/** Assemble a guild view from Postgres when the bot process is offline. */
async function dbView(guildId: string): Promise<Partial<BotGuildView>> {
  const [settings, features, badWords] = await Promise.all([
    getGuildSettings(guildId),
    getGuildFeatures(guildId),
    getGuildBadWords(guildId),
  ]);

  return {
    id: guildId,
    name: null,
    joined: false,
    channels: [],
    roles: [],
    features: features.map((f) => ({ type: f.type, channelId: f.channel_id, enabled: f.enabled, config: f.config ?? {} })),
    settings: {
      prefix: settings?.prefix ?? "!",
      autoroleId: settings?.autorole_id ?? null,
      logChannelId: settings?.log_channel_id ?? null,
      modLogChannelId: settings?.mod_log_channel_id ?? null,
      welcome: {
        enabled: Boolean(settings?.welcome_enabled),
        channelId: settings?.welcome_channel_id ?? null,
        message: settings?.welcome_message ?? "",
        embed: Boolean(settings?.welcome_embed),
        autoDelete: settings?.welcome_auto_delete ?? 0,
      },
      farewell: {
        enabled: Boolean(settings?.farewell_enabled),
        channelId: settings?.farewell_channel_id ?? null,
        message: settings?.farewell_message ?? "",
      },
      logs: {
        deleted: Boolean(settings?.log_deleted ?? 1),
        joins: Boolean(settings?.log_joins ?? 1),
        kicks: Boolean(settings?.log_kicks ?? 1),
        bans: Boolean(settings?.log_bans ?? 1),
        timeouts: Boolean(settings?.log_timeouts ?? 1),
        roles: Boolean(settings?.log_roles ?? 1),
        automod: Boolean(settings?.log_automod ?? 1),
        config: Boolean(settings?.log_config ?? 1),
      },
      automod: {
        wordsEnabled: Boolean(settings?.words_enabled ?? 1),
        antispamEnabled: Boolean(settings?.antispam_enabled ?? 1),
        inviteFilter: Boolean(settings?.invite_filter ?? 0),
        mentionLimit: settings?.mention_limit ?? 6,
        spamCount: settings?.spam_count ?? 6,
        spamSeconds: settings?.spam_seconds ?? 5,
        spamMuteMinutes: settings?.spam_mute_minutes ?? 10,
        action: settings?.automod_action ?? "timeout",
        exemptRoleIds: (settings?.exempt_role_ids ?? "").split(",").filter(Boolean),
        exemptChannelIds: (settings?.exempt_channel_ids ?? "").split(",").filter(Boolean),
      },
      badWords,
    },
  };
}

export async function GET(request: Request, { params }: Params) {
  const session = readSession(request);
  if (!session.botId && !session.userId) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const { id } = await params;
  if (!GUILD_ID.test(id)) return NextResponse.json({ error: "invalid guild id" }, { status: 422 });

  const live = await botApi.guild(id);
  if (live) return NextResponse.json({ guild: live, source: "bot" });

  const guild = await dbView(id);
  return NextResponse.json({ guild, source: "database" });
}

/**
 * POST /api/guilds/:id
 * { kind: 'settings', payload: { general|welcome|farewell|logs|automod } }
 * { kind: 'feature', payload: { type, channelId, config, enabled, remove } }
 * { kind: 'badwords', payload: { words: string[] } }
 * { kind: 'test', payload: { kind: 'welcome'|'farewell'|'meme' } }
 */
export async function POST(request: Request, { params }: Params) {
  const session = readSession(request);
  if (!session.botId && !session.userId) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const { id } = await params;
  if (!GUILD_ID.test(id)) return NextResponse.json({ error: "invalid guild id" }, { status: 422 });

  let body: { kind?: string; payload?: Record<string, unknown> };
  try {
    body = (await request.json()) as { kind?: string; payload?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const payload = body.payload ?? {};
  const kind = body.kind ?? "settings";

  // preferred path: the live bot (also updates its in-memory cache instantly)
  if (kind === "settings") {
    const live = await botApi.saveSettings(id, payload);
    if (live) return NextResponse.json({ ok: true, guild: live.guild, source: "bot" });
  }
  if (kind === "feature") {
    const type = String(payload.type ?? "");
    if (!FEATURE_TYPES.includes(type as (typeof FEATURE_TYPES)[number])) {
      return NextResponse.json({ error: `unknown feature type ${type}` }, { status: 422 });
    }
    const live = await botApi.saveFeature(id, payload);
    if (live) return NextResponse.json({ ok: true, guild: live.guild, source: "bot" });
  }
  if (kind === "test") {
    const result = await botApi.test(id, String(payload.kind ?? "welcome"));
    if (result) return NextResponse.json({ ...result, source: "bot" });
    return NextResponse.json({ error: "the bot process is offline - start it with `cd bot && npm start`" }, { status: 503 });
  }

  // fallback: write straight to Postgres so nothing is lost while the bot is down
  try {
    if (kind === "settings") {
      const patch: Record<string, string | number | null> = {};
      const general = payload.general as Record<string, unknown> | undefined;
      const welcome = payload.welcome as Record<string, unknown> | undefined;
      const farewell = payload.farewell as Record<string, unknown> | undefined;
      const logs = payload.logs as Record<string, unknown> | undefined;
      const automod = payload.automod as Record<string, unknown> | undefined;

      if (general?.prefix) patch.prefix = String(general.prefix).slice(0, 5);
      if (general && 'autoroleId' in general) patch.autorole_id = (general.autoroleId as string) || null;
      if (welcome) {
        patch.welcome_enabled = welcome.enabled ? 1 : 0;
        if ('channelId' in welcome) patch.welcome_channel_id = (welcome.channelId as string) || null;
        if (typeof welcome.message === "string") patch.welcome_message = welcome.message.slice(0, 1500);
        patch.welcome_embed = welcome.embed ? 1 : 0;
        if (welcome.autoDelete !== undefined) patch.welcome_auto_delete = Number(welcome.autoDelete) || 0;
      }
      if (farewell) {
        patch.farewell_enabled = farewell.enabled ? 1 : 0;
        if ('channelId' in farewell) patch.farewell_channel_id = (farewell.channelId as string) || null;
        if (typeof farewell.message === "string") patch.farewell_message = farewell.message.slice(0, 1500);
      }
      if (logs) {
        const map: Record<string, string> = {
          auditChannelId: "log_channel_id",
          modChannelId: "mod_log_channel_id",
          deleted: "log_deleted",
          joins: "log_joins",
          kicks: "log_kicks",
          bans: "log_bans",
          timeouts: "log_timeouts",
          roles: "log_roles",
          automod: "log_automod",
          config: "log_config",
        };
        for (const [key, column] of Object.entries(map)) {
          if (!(key in logs)) continue;
          const value = logs[key];
          patch[column] = typeof value === "boolean" ? (value ? 1 : 0) : (value as string) || null;
        }
      }
      if (automod) {
        const map: Record<string, string> = {
          wordsEnabled: "words_enabled",
          antispamEnabled: "antispam_enabled",
          inviteFilter: "invite_filter",
          mentionLimit: "mention_limit",
          spamCount: "spam_count",
          spamSeconds: "spam_seconds",
          spamMuteMinutes: "spam_mute_minutes",
        };
        for (const [key, column] of Object.entries(map)) {
          if (!(key in automod)) continue;
          const value = automod[key];
          patch[column] = typeof value === "boolean" ? (value ? 1 : 0) : Number(value) || 0;
        }
        if (typeof automod.action === "string" && ["delete", "warn", "timeout"].includes(automod.action)) {
          patch.automod_action = automod.action;
        }
      }
      await upsertSettings(id, patch);
    } else if (kind === "feature") {
      const type = String(payload.type ?? "");
      if (payload.remove) await removeFeature(id, type, (payload.channelId as string) || null);
      else {
        const channelId = String(payload.channelId ?? "");
        if (!GUILD_ID.test(channelId)) return NextResponse.json({ error: "channelId must be a snowflake" }, { status: 422 });
        await setFeature(
          id,
          type,
          channelId,
          (payload.config as Record<string, unknown>) ?? {},
          payload.enabled !== false,
        );
      }
    } else if (kind === "badwords") {
      const words = Array.isArray(payload.words) ? payload.words.map(String) : [];
      await replaceBadWords(id, words);
    } else {
      return NextResponse.json({ error: `unknown kind ${kind}` }, { status: 422 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "write failed" }, { status: 500 });
  }

  const guild = await dbView(id);
  return NextResponse.json({ ok: true, guild, source: "database" });
}
