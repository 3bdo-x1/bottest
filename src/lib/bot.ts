import { botConfig } from "@/lib/discord";

/** Server-side client for the bot's internal HTTP API (bot/src/api.js). */

const base = () => `http://127.0.0.1:${botConfig().botPort}`;

async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  const method = (init?.method ?? "GET").toUpperCase();
  try {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": botConfig().botSecret,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(method === "GET" ? 5_000 : 25_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // bot offline - callers fall back to Postgres
  }
}

export type BotGuild = {
  id: string;
  name: string | null;
  icon: string | null;
  memberCount: number | null;
  features: number;
};

export type BotGuildView = {
  id: string;
  name: string | null;
  icon: string | null;
  memberCount: number | null;
  joined: boolean;
  channels: { id: string; name: string; parentId: string | null }[];
  roles: { id: string; name: string; color: string }[];
  settings: Record<string, unknown> & {
    prefix: string;
    autoroleId: string | null;
    logChannelId: string | null;
    modLogChannelId: string | null;
    welcome: { enabled: boolean; channelId: string | null; message: string; embed: boolean; autoDelete: number };
    farewell: { enabled: boolean; channelId: string | null; message: string };
    logs: Record<string, boolean>;
    automod: {
      wordsEnabled: boolean;
      antispamEnabled: boolean;
      inviteFilter: boolean;
      mentionLimit: number;
      spamCount: number;
      spamSeconds: number;
      spamMuteMinutes: number;
      action: string;
      exemptRoleIds: string[];
      exemptChannelIds: string[];
    };
    badWords: string[];
  };
  features: { type: string; channelId: string; enabled: number; config: Record<string, unknown> }[];
  counting: { channelId: string | null; current: number; best: number; fails: number };
  leaderboard: { counting: { userId: string; score: number; best: number }[]; xp: { userId: string; level: number; points: number }[] };
  modLogs: { action: string; user_id: string | null; reason: string | null; created_at: number }[];
};

export type BotStats = {
  bot: {
    tag: string;
    id: string | null;
    ready: boolean;
    ping: number | null;
    guilds: number;
    channels: number;
    usersCached: number;
    membersCached: number;
    invite: string | null;
    uptime: string;
  };
  memory: { rssText: string; heapText: string };
  db: Record<string, number | string>;
  node: { version: string; pid: number };
};

export const botApi = {
  online: () => call<{ ok: boolean }>("/health"),
  stats: () => call<BotStats>("/stats"),
  guilds: () => call<{ guilds: BotGuild[] }>("/guilds"),
  guild: (id: string) => call<BotGuildView>(`/guilds/${id}`),
  saveSettings: (id: string, payload: unknown) =>
    call<{ ok: boolean; guild: BotGuildView }>(`/guilds/${id}`, { method: "POST", body: JSON.stringify(payload) }),
  saveFeature: (id: string, payload: unknown) =>
    call<{ ok: boolean; guild: BotGuildView }>(`/guilds/${id}/features`, { method: "POST", body: JSON.stringify(payload) }),
  test: (id: string, kind: string) =>
    call<{ ok: boolean; channel: string; rendered?: string }>(`/guilds/${id}/test`, {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),
  register: () => call<{ ok: boolean; message: string }>("/register", { method: "POST" }),
};
