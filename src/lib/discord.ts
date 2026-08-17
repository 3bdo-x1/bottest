import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Shared bot configuration (token, secrets, ports) from bot/data/config.json. */
export type BotConfig = {
  clientId: string | null;
  clientSecret: string | null;
  botSecret: string;
  botPort: number;
  guildId: string | null;
  redirectBase: string | null;
};

function readBotConfigFile(): Record<string, string> {
  try {
    const file = path.join(process.cwd(), "bot", "data", "config.json");
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

let cached: BotConfig | null = null;

export function botConfig(): BotConfig {
  if (cached) return cached;
  const file = readBotConfigFile();
  const clientId = process.env.DISCORD_CLIENT_ID || file.DISCORD_CLIENT_ID || null;
  cached = {
    clientId:
      clientId ||
      (file.DISCORD_TOKEN
        ? Buffer.from(file.DISCORD_TOKEN.split(".")[0], "base64").toString("utf8")
        : null),
    clientSecret: process.env.DISCORD_CLIENT_SECRET || file.DISCORD_CLIENT_SECRET || null,
    botSecret: process.env.BOT_SECRET || file.BOT_SECRET || "dyno-lite-bridge-secret",
    botPort: Number(process.env.BOT_PORT || file.BOT_PORT || 3001),
    guildId: process.env.GUILD_ID || file.GUILD_ID || null,
    redirectBase: process.env.REDIRECT_BASE || file.REDIRECT_BASE || null,
  };
  return cached;
}

export const SESSION_COOKIE = "dyno_session";
export const OAUTH_STATE_COOKIE = "dyno_oauth_state";
export const OAUTH_TOKEN_COOKIE = "dyno_oauth_token";

/* -------------------------------------------------------------------------- */
/* Sessions (stateless, signed with HMAC - no session table, no dependency)   */
/* -------------------------------------------------------------------------- */

export type Session = {
  id: string;
  username: string;
  avatar: string | null;
  demo: boolean;
  exp: number;
};

const SESSION_TTL = 7 * 24 * 60 * 60;

function secret(): string {
  return process.env.SESSION_SECRET || botConfig().botSecret || "dyno-lite-dev-secret";
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function signSession(payload: Omit<Session, "exp">): string {
  const body: Session = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL };
  const data = b64url(JSON.stringify(body));
  const mac = b64url(crypto.createHmac("sha256", secret()).update(data).digest());
  return `${data}.${mac}`;
}

export function verifySession(token: string | undefined | null): Session | null {
  if (!token || !token.includes(".")) return null;
  const [data, mac] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", secret()).update(data).digest());
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as Session;
    if (!parsed.exp || parsed.exp * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* OAuth2 (PKCE - works without a client secret)                              */
/* -------------------------------------------------------------------------- */

export const MANAGE_GUILD = 0x20;

export function randomToken(bytes = 32): string {
  return b64url(crypto.randomBytes(bytes));
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function redirectUri(request: Request): string {
  const base =
    botConfig().redirectBase ||
    process.env.NEXT_PUBLIC_REDIRECT_BASE ||
    new URL(request.url).origin;
  return `${base.replace(/\/$/, "")}/api/auth/callback`;
}

export function authorizeUrl(options: { clientId: string; state: string; challenge: string; redirect: string }): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirect,
    response_type: "code",
    scope: "identify guilds",
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export type DiscordUser = { id: string; username: string; avatar: string | null };
export type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: number;
};

export async function exchangeCode(options: {
  clientId: string;
  clientSecret: string | null;
  code: string;
  verifier: string;
  redirect: string;
}): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirect,
    code_verifier: options.verifier,
  });
  if (options.clientSecret) body.set("client_secret", options.clientSecret);

  const res = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? null;
}

export async function fetchUser(accessToken: string): Promise<DiscordUser | null> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as DiscordUser;
}

export async function fetchGuilds(accessToken: string): Promise<DiscordGuild[]> {
  const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  return (await res.json()) as DiscordGuild[];
}

export function avatarUrl(id: string, hash: string | null): string | null {
  return hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=64` : null;
}
