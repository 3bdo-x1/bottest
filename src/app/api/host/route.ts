import { NextResponse } from "next/server";
import {
  BOT_SESSION_COOKIE,
  cookieFromRequest,
  signBotSession,
  ensureHostingSchema,
  getBot,
  getLogs,
  hostStatus,
  updateBot,
  verifyBotSession,
} from "@/lib/hosting";

export const dynamic = "force-dynamic";

/** GET /api/host -> hosting dashboard payload for the logged-in bot. */
export async function GET(request: Request) {
  const session = verifyBotSession(cookieFromRequest(request, BOT_SESSION_COOKIE));
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  await ensureHostingSchema();
  const [bot, host, logs] = await Promise.all([getBot(session.botId), hostStatus(), getLogs(session.botId, 80)]);

  return NextResponse.json({
    hosting: {
      desiredState: bot?.desired_state ?? "running",
      status: bot?.status ?? "offline",
      pid: bot?.pid ?? null,
      port: bot?.port ?? null,
      rssBytes: Number(bot?.rss_bytes ?? 0),
      guildCount: bot?.guild_count ?? 0,
      restarts: bot?.restarts ?? 0,
      startedAt: bot?.started_at ? Number(bot.started_at) : null,
      lastHeartbeat: bot?.last_heartbeat ? Number(bot.last_heartbeat) : null,
      uptimeMs: bot?.started_at ? Date.now() - Number(bot.started_at) : 0,
      host: { online: host.online, id: host.host_id, bots: host.bots, lastSeen: host.last_seen },
    },
    logs: logs.reverse().map((line) => ({ line: line.line, level: line.level, at: Number(line.created_at) })),
  });
}

/**
 * POST /api/host  { action: 'start' | 'stop' | 'restart' | 'rotate', token? }
 * The host runner picks the change up within a few seconds.
 */
export async function POST(request: Request) {
  const session = verifyBotSession(cookieFromRequest(request, BOT_SESSION_COOKIE));
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  let body: { action?: string; token?: string };
  try {
    body = (await request.json()) as { action?: string; token?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  await ensureHostingSchema();
  const action = body.action ?? "";

  if (action === "start") await updateBot(session.botId, { desired_state: "running", status: "starting" });
  else if (action === "stop") await updateBot(session.botId, { desired_state: "stopped", status: "stopped" });
  else if (action === "restart") await updateBot(session.botId, { desired_state: "running", status: "starting", restarts: 0 });
  else if (action === "rotate") {
    const token = String(body.token ?? "").trim();
    if (!token || token.split(".").length < 3) return NextResponse.json({ error: "invalid token" }, { status: 422 });
    const { verifyBotToken, upsertBot } = await import("@/lib/hosting");
    const verified = await verifyBotToken(token);
    if (!verified) return NextResponse.json({ error: "Discord rejected the new token" }, { status: 401 });
    await upsertBot({
      botId: verified.id,
      username: verified.username,
      discriminator: verified.discriminator,
      avatar: verified.avatar,
      token,
    });
    // rotating to a different bot rebinds the session to the new application id
    const res = NextResponse.json({ ok: true, action, rotatedTo: verified.id, reload: true });
    res.cookies.set(BOT_SESSION_COOKIE, signBotSession(verified.id, verified.username), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  } else {
    return NextResponse.json({ error: `unknown action "${action}"` }, { status: 422 });
  }

  return NextResponse.json({ ok: true, action });
}
