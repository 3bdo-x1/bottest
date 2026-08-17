import { NextResponse } from "next/server";
import { ensureHostingSchema, hostStatus, listBots } from "@/lib/hosting";

export const dynamic = "force-dynamic";

export const maxDuration = 60;

/**
 * GET /api/host/keepalive  — called by `vercel.json` cron every 5 minutes.
 *
 * Vercel functions cannot hold a gateway socket open, so the cron does not keep
 * bots alive itself. It (a) reports whether the host runner is healthy, and
 * (b) clears stale "online" flags if a runner vanished without a stop request,
 * which the website surfaces as "host offline — bots are not running".
 */
export async function GET() {
  await ensureHostingSchema();
  const [host, bots] = await Promise.all([hostStatus(), listBots()]);
  const stale = bots.filter((bot) => bot.status === "online" && (!bot.last_heartbeat || Date.now() - Number(bot.last_heartbeat) > 120_000));

  for (const bot of stale) {
    const { updateBot } = await import("@/lib/hosting");
    await updateBot(bot.bot_id, { status: bot.desired_state === "running" ? "crashed" : "stopped", pid: null });
  }

  return NextResponse.json({
    ok: true,
    hostOnline: host.online,
    hostId: host.host_id,
    bots: bots.length,
    markedStale: stale.map((bot) => bot.bot_id),
    note: "Vercel runs the dashboard; the host runner keeps bots online 24/7.",
    at: new Date().toISOString(),
  });
}
