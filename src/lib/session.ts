import { BOT_SESSION_COOKIE, cookieFromRequest, verifyBotSession } from "@/lib/hosting";
import { SESSION_COOKIE, verifySession } from "@/lib/discord";

/**
 * One session reader for every route: the dashboard accepts both a
 * bot-token session (BotGhost style login) and the legacy Discord OAuth user
 * session, so either way you get the same management endpoints.
 */
export function readSession(request: Request): { botId: string | null; userId: string | null; username: string | null } {
  const bot = verifyBotSession(cookieFromRequest(request, BOT_SESSION_COOKIE));
  if (bot) return { botId: bot.botId, userId: null, username: bot.username };
  const user = verifySession(cookieFromRequest(request, SESSION_COOKIE));
  if (user) return { botId: null, userId: user.id, username: user.username };
  return { botId: null, userId: null, username: null };
}

export function isAuthorised(request: Request): boolean {
  return Boolean(readSession(request).botId || readSession(request).userId);
}
