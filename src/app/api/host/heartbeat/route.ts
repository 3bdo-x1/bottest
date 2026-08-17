import { NextResponse } from "next/server";
import { authorisedHost, ensureHostingSchema, pushLog, updateBot } from "@/lib/hosting";

export const dynamic = "force-dynamic";

/**
 * POST /api/host/heartbeat   (x-host-key)
 * { botId, status, pid, port, rssBytes, guildCount, restarts, startedAt, logs: [] }
 */
export async function POST(request: Request) {
  if (!authorisedHost(request)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  let body: {
    botId?: string;
    status?: string;
    pid?: number;
    port?: number;
    rssBytes?: number;
    guildCount?: number;
    restarts?: number;
    startedAt?: number;
    logs?: string[];
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.botId) return NextResponse.json({ error: "botId required" }, { status: 422 });

  await ensureHostingSchema();
  await updateBot(body.botId, {
    status: body.status ?? "online",
    pid: body.pid ?? null,
    port: body.port ?? null,
    rss_bytes: Math.round(Number(body.rssBytes ?? 0)),
    guild_count: Number(body.guildCount ?? 0),
    restarts: Number(body.restarts ?? 0),
    started_at: body.startedAt ?? null,
    last_heartbeat: Date.now(),
  });

  if (Array.isArray(body.logs) && body.logs.length) await pushLog(body.botId, body.logs.map(String));

  return NextResponse.json({ ok: true });
}
