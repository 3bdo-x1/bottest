import { redirect } from "next/navigation";
import Manager from "@/components/Manager";
import { BOT_SESSION_COOKIE, ensureHostingSchema, getBot, hostStatus } from "@/lib/hosting";
import { cookies } from "next/headers";
import { verifyBotSession } from "@/lib/hosting";
import { botApi } from "@/lib/bot";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const raw = (await cookies()).get(BOT_SESSION_COOKIE)?.value;
  const session = verifyBotSession(raw);
  if (!session) redirect("/");

  await ensureHostingSchema();
  const [bot, host, stats] = await Promise.all([getBot(session.botId), hostStatus(), botApi.stats()]);

  return (
    <main className="min-h-dvh bg-[#0b0d14] text-white">
      <Manager
        user={{
          id: session.botId,
          username: bot?.discriminator && bot.discriminator !== "0" ? `${bot.username}#${bot.discriminator}` : bot?.username ?? session.username,
          avatar: null,
          demo: false,
        }}
        hosting={{
          status: bot?.status ?? "offline",
          desiredState: bot?.desired_state ?? "running",
          restarts: Number(bot?.restarts ?? 0),
          rssBytes: Number(bot?.rss_bytes ?? 0),
          guildCount: Number(bot?.guild_count ?? 0),
          pid: bot?.pid ?? null,
          port: bot?.port ?? null,
          startedAt: bot?.started_at ? Number(bot.started_at) : null,
          hostOnline: host.online,
          hostId: host.host_id,
        }}
        initialBotOnline={Boolean(stats?.bot?.ready)}
        initialBotTag={stats?.bot?.tag ?? "bot offline"}
      />
    </main>
  );
}
