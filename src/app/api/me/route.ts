import { NextResponse } from "next/server";
import {
  BOT_SESSION_COOKIE,
  cookieFromRequest,
  ensureHostingSchema,
  getBot,
  hostStatus,
  verifyBotSession,
} from "@/lib/hosting";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = verifyBotSession(cookieFromRequest(request, BOT_SESSION_COOKIE));
  if (!session) return NextResponse.json({ authenticated: false }, { status: 401 });

  await ensureHostingSchema();
  const [bot, host] = await Promise.all([getBot(session.botId), hostStatus()]);

  return NextResponse.json({
    authenticated: true,
    bot: {
      id: session.botId,
      username: session.username,
      avatar: bot?.avatar ?? null,
      tag: bot ? (bot.discriminator !== "0" ? `${bot.username}#${bot.discriminator}` : bot.username) : session.username,
    },
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
      hostOnline: host.online,
      hostId: host.host_id,
      hostBots: host.bots,
    },
  });
}
