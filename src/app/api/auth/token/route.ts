import { NextResponse } from "next/server";
import {
  BOT_SESSION_COOKIE,
  ensureHostingSchema,
  signBotSession,
  upsertBot,
  verifyBotToken,
} from "@/lib/hosting";

export const dynamic = "force-dynamic";

/** Discord snowflake is the base64url payload before the first dot. */
function botIdFromToken(token: string): string | null {
  const head = token.split(".")[0] ?? "";
  try {
    const decoded = Buffer.from(head.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^\d{15,20}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/token   { token }
 *
 * Verifies the token with Discord and starts hosting. If Discord rejects it we
 * still let you into the dashboard (marked "unverified") so you can configure
 * everything and paste a working token afterwards — settings are stored in
 * Postgres and apply the moment the bot comes online.
 */
export async function POST(request: Request) {
  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const token = String(body.token ?? "").trim();
  if (!token || token.length < 40 || token.split(".").length < 3) {
    return NextResponse.json({ error: "That does not look like a bot token — copy the whole string from Developer Portal → Bot → Reset Token." }, { status: 422 });
  }

  await ensureHostingSchema();

  const verified = await verifyBotToken(token);
  const botId = verified?.id ?? botIdFromToken(token);

  if (!botId) {
    return NextResponse.json({ error: "Could not read a bot id from that token. Make sure you copied all three dot-separated parts." }, { status: 422 });
  }

  const warned = !verified;

  await upsertBot({
    botId,
    username: verified?.username ?? `bot-${botId.slice(-6)}`,
    discriminator: verified?.discriminator ?? "0",
    avatar: verified?.avatar ?? null,
    token,
  });

  // an unverified token must not be spawned in a crash loop
  if (warned) {
    const { updateBot } = await import("@/lib/hosting");
    await updateBot(botId, { desired_state: "stopped", status: "invalid-token" });
  }

  const res = NextResponse.json({
    ok: true,
    verified: !warned,
    bot: {
      id: botId,
      tag: verified ? verified.tag : `bot-${botId.slice(-6)} (unverified)`,
      avatar: verified?.avatar ?? null,
    },
    hosting: {
      desiredState: warned ? "stopped" : "running",
      status: warned ? "invalid-token" : "starting",
    },
    warning: warned
      ? "Discord rejected that token (it may have been reset). You can still configure everything — paste a fresh token on the Hosting tab to bring the bot online."
      : null,
  });

  res.cookies.set(BOT_SESSION_COOKIE, signBotSession(botId, verified?.username ?? `bot-${botId.slice(-6)}`), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
