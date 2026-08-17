import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Bot hosting layer.
 *
 * Users log in to the dashboard with their **bot token**. The token is verified
 * against Discord, encrypted with AES-256-GCM and stored, and a host runner
 * (see host/runner.js) claims it and keeps the bot process alive 24/7.
 */

export const BOTS_TABLE = "bots";

export type BotRow = {
  bot_id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  token_iv: string;
  token_tag: string;
  token_ct: string;
  desired_state: "running" | "stopped";
  status: "offline" | " starting" | "online" | "crashed" | "stopped";
  host_id: string | null;
  pid: number | null;
  port: number | null;
  rss_bytes: number;
  guild_count: number;
  restarts: number;
  started_at: number | null;
  last_heartbeat: number | null;
  updated_at: number;
};

/* -------------------------------------------------------------------------- */
/* Encryption                                                                 */
/* -------------------------------------------------------------------------- */

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw) {
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
    return crypto.createHash("sha256").update(raw).digest();
  }
  // dev fallback: stable per-install key so encrypted rows stay readable
  const file = path.join(process.cwd(), ".encryption-key");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return Buffer.from(existing, "hex");
  } catch {
    /* create below */
  }
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, generated.toString("hex"), { mode: 0o600 });
  } catch {
    /* read-only fs (Vercel) - fall back to a secret derived from SESSION_SECRET */
    return crypto.createHash("sha256").update(process.env.SESSION_SECRET || "dyno-lite-dev").digest();
  }
  return generated;
}

export function encryptToken(token: string): { iv: string; tag: string; ct: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

export function decryptToken(row: Pick<BotRow, "token_iv" | "token_tag" | "token_ct">): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.token_iv, "hex"));
  decipher.setAuthTag(Buffer.from(row.token_tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(row.token_ct, "hex")), decipher.final()]).toString("utf8");
}

export function maskToken(token: string): string {
  if (token.length < 20) return "••••";
  return `${token.slice(0, 8)}••••••••${token.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* Schema (created here so a fresh Vercel/Postgres deploy self-heals)         */
/* -------------------------------------------------------------------------- */

let schemaReady = false;

export async function ensureHostingSchema(): Promise<void> {
  if (schemaReady) return;
  await db.execute(sql`
    create table if not exists ${sql.raw(BOTS_TABLE)} (
      bot_id text primary key,
      username text not null default '',
      discriminator text not null default '0',
      avatar text,
      token_iv text not null,
      token_tag text not null,
      token_ct text not null,
      desired_state text not null default 'running',
      status text not null default 'offline',
      host_id text,
      pid integer,
      port integer,
      rss_bytes bigint not null default 0,
      guild_count integer not null default 0,
      restarts integer not null default 0,
      started_at bigint,
      last_heartbeat bigint,
      updated_at bigint not null default 0
    )
  `);
  await db.execute(sql`
    create table if not exists host_heartbeats (
      host_id text primary key,
      bots integer not null default 0,
      version text,
      last_seen bigint not null default 0
    )
  `);
  await db.execute(sql`
    create table if not exists bot_logs (
      id bigserial primary key,
      bot_id text not null,
      line text not null,
      level text not null default 'info',
      created_at bigint not null default 0
    )
  `);
  await db.execute(sql`create index if not exists idx_bot_logs on bot_logs (bot_id, id desc)`);
  schemaReady = true;
}

/* -------------------------------------------------------------------------- */
/* Host runner authentication                                                 */
/* -------------------------------------------------------------------------- */

export function hostKey(): string {
  return process.env.HOST_KEY || "dyno-lite-host-key";
}

export function authorisedHost(request: Request): boolean {
  const provided = request.headers.get("x-host-key");
  return Boolean(provided) && provided === hostKey();
}

/* -------------------------------------------------------------------------- */
/* Bot sessions (cookie)                                                      */
/* -------------------------------------------------------------------------- */

export const BOT_SESSION_COOKIE = "dyno_bot_session";

type BotSession = { botId: string; username: string; exp: number };

const b64 = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sessionSecret(): string {
  return process.env.SESSION_SECRET || hostKey();
}

export function signBotSession(botId: string, username: string): string {
  const body: BotSession = { botId, username, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 };
  const data = b64(JSON.stringify(body));
  const mac = b64(crypto.createHmac("sha256", sessionSecret()).update(data).digest());
  return `${data}.${mac}`;
}

export function verifyBotSession(token: string | undefined | null): BotSession | null {
  if (!token || !token.includes(".")) return null;
  const [data, mac] = token.split(".");
  const expected = b64(crypto.createHmac("sha256", sessionSecret()).update(data).digest());
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as BotSession;
    if (!parsed.exp || parsed.exp * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function cookieFromRequest(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export async function upsertBot(input: {
  botId: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  token: string;
}): Promise<void> {
  const enc = encryptToken(input.token);
  await db.execute(sql`
    insert into ${sql.raw(BOTS_TABLE)} (bot_id, username, discriminator, avatar, token_iv, token_tag, token_ct, desired_state, status, updated_at)
    values (${input.botId}, ${input.username}, ${input.discriminator}, ${input.avatar}, ${enc.iv}, ${enc.tag}, ${enc.ct}, 'running', 'starting', ${Date.now()})
    on conflict (bot_id) do update set
      username = excluded.username,
      discriminator = excluded.discriminator,
      avatar = excluded.avatar,
      token_iv = excluded.token_iv,
      token_tag = excluded.token_tag,
      token_ct = excluded.token_ct,
      desired_state = 'running',
      updated_at = excluded.updated_at
  `);
}

export async function getBot(botId: string): Promise<BotRow | null> {
  const result = await db.execute<BotRow>(sql`select * from ${sql.raw(BOTS_TABLE)} where bot_id = ${botId} limit 1`);
  return result.rows[0] ?? null;
}

export async function listBots(): Promise<BotRow[]> {
  const result = await db.execute<BotRow>(sql`select * from ${sql.raw(BOTS_TABLE)} order by updated_at desc limit 100`);
  return result.rows ?? [];
}

export async function updateBot(botId: string, patch: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const assignments = keys.map((key) => sql`${sql.identifier(key)} = ${patch[key]}`);
  await db.execute(sql`
    update ${sql.raw(BOTS_TABLE)}
    set ${sql.join(assignments, sql`, `)}, updated_at = ${Date.now()}
    where bot_id = ${botId}
  `);
}

export async function pushLog(botId: string, lines: string[], level = "info"): Promise<void> {
  if (!lines.length) return;
  const trimmed = lines.slice(-40).map((line) => line.slice(0, 500));
  await db.execute(sql`
    insert into bot_logs (bot_id, line, level, created_at)
    values ${sql.join(trimmed.map((line) => sql`(${botId}, ${line}, ${level}, ${Date.now()})`), sql`, `)}
  `);
  // keep the ring small
  await db.execute(sql`
    delete from bot_logs
    where bot_id = ${botId}
      and id not in (select id from bot_logs where bot_id = ${botId} order by id desc limit 300)
  `);
}

export async function getLogs(botId: string, limit = 120): Promise<{ line: string; level: string; created_at: number }[]> {
  const result = await db.execute<{ line: string; level: string; created_at: number }>(
    sql`select line, level, created_at from bot_logs where bot_id = ${botId} order by id desc limit ${limit}`,
  );
  return result.rows ?? [];
}

export async function recordHostHeartbeat(hostId: string, bots: number, version: string): Promise<void> {
  await db.execute(sql`
    insert into host_heartbeats (host_id, bots, version, last_seen)
    values (${hostId}, ${bots}, ${version}, ${Date.now()})
    on conflict (host_id) do update set bots = excluded.bots, version = excluded.version, last_seen = excluded.last_seen
  `);
}

export async function hostStatus(): Promise<{ online: boolean; host_id: string | null; bots: number; last_seen: number | null }> {
  const result = await db.execute<{ host_id: string; bots: number; last_seen: number }>(
    sql`select host_id, bots, last_seen from host_heartbeats order by last_seen desc limit 1`,
  );
  const row = result.rows[0];
  if (!row) return { online: false, host_id: null, bots: 0, last_seen: null };
  return { online: Date.now() - Number(row.last_seen) < 45_000, host_id: row.host_id, bots: row.bots, last_seen: Number(row.last_seen) };
}

/* -------------------------------------------------------------------------- */
/* Discord token verification                                                 */
/* -------------------------------------------------------------------------- */

export type VerifiedBot = { id: string; username: string; discriminator: string; avatar: string | null; tag: string };

export async function verifyBotToken(token: string): Promise<VerifiedBot | null> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id: string; username: string; discriminator: string; avatar: string | null };
  return {
    id: user.id,
    username: user.username,
    discriminator: user.discriminator ?? "0",
    avatar: user.avatar,
    tag: user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username,
  };
}

export async function botGuilds(token: string): Promise<{ id: string; name: string; icon: string | null; owner: boolean }[]> {
  const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const guilds = (await res.json()) as { id: string; name: string; icon: string | null; owner: boolean }[];
  return guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon, owner: g.owner }));
}
