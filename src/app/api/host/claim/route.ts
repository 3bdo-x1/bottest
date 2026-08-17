import { NextResponse } from "next/server";
import {
  authorisedHost,
  decryptToken,
  ensureHostingSchema,
  listBots,
  recordHostHeartbeat,
} from "@/lib/hosting";

export const dynamic = "force-dynamic";

/**
 * POST /api/host/claim   (x-host-key)
 *
 * The host runner calls this every few seconds. It returns the exact work the
 * runner should be doing, including the decrypted token for bots it must run.
 * Nothing else can reach this endpoint without HOST_KEY.
 */
export async function POST(request: Request) {
  if (!authorisedHost(request)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  await ensureHostingSchema();
  const bots = await listBots();
  const hostId = new URL(request.url).searchParams.get("host") || "unknown-host";

  const jobs = await Promise.all(
    bots.map(async (bot) => ({
      botId: bot.bot_id,
      desiredState: bot.desired_state,
      username: bot.username,
      status: bot.status,
      token: bot.desired_state === "running" ? decryptToken(bot) : null,
      restarts: bot.restarts,
    })),
  );

  await recordHostHeartbeat(hostId, bots.filter((b) => b.desired_state === "running").length, "2.0");

  return NextResponse.json({
    host: hostId,
    serverTime: Date.now(),
    jobs: jobs.filter((job) => job.desiredState === "running" || job.status !== "stopped"),
  });
}
