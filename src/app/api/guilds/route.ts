import { NextResponse } from "next/server";
import { readSession } from "@/lib/session";
import { botApi } from "@/lib/bot";
import { getKnownGuilds } from "@/lib/guilds";
import { ensureHostingSchema, getBot, hostStatus } from "@/lib/hosting";

export const dynamic = "force-dynamic";

export { readSession };

/** GET /api/guilds -> guilds available to the logged-in bot. */
export async function GET(request: Request) {
  const session = readSession(request);
  if (!session.botId && !session.userId) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  await ensureHostingSchema();
  const [live, known, botRow, host] = await Promise.all([
    botApi.guilds(),
    getKnownGuilds(),
    session.botId ? getBot(session.botId) : Promise.resolve(null),
    hostStatus(),
  ]);

  const list = [
    ...(live?.guilds ?? []).map((g) => ({
      id: g.id,
      name: g.name ?? g.id,
      icon: g.icon,
      memberCount: g.memberCount ?? null,
      features: g.features ?? 0,
      botPresent: true,
      knownToDashboard: known.some((k) => k.guild_id === g.id),
    })),
    ...known
      .filter((k) => !(live?.guilds ?? []).some((g) => g.id === k.guild_id))
      .map((k) => ({
        id: k.guild_id,
        name: `guild ${k.guild_id}`,
        icon: null,
        memberCount: null,
        features: 0,
        botPresent: false,
        knownToDashboard: true,
      })),
  ].filter((guild, index, all) => all.findIndex((g) => g.id === guild.id) === index);

  return NextResponse.json({
    guilds: list,
    botOnline: Boolean(live),
    hosting: {
      botId: session.botId,
      status: botRow?.status ?? "unknown",
      desiredState: botRow?.desired_state ?? "unknown",
      guildCount: botRow?.guild_count ?? 0,
      hostOnline: host.online,
      hostId: host.host_id,
    },
  });
}
