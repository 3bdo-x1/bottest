import { NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, authorizeUrl, botConfig, pkcePair, randomToken, redirectUri, signSession } from "@/lib/discord";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/login        -> redirect to Discord OAuth2 (PKCE, no client secret needed)
 * GET /api/auth/login?demo=1 -> local demo session so the dashboard is usable
 *                               before OAuth credentials exist
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cfg = botConfig();

  if (url.searchParams.get("demo") === "1" || !cfg.clientId) {
    const demo = signSession({ id: "000000000000000000", username: "demo-admin", avatar: null, demo: true });
    const res = NextResponse.json({ ok: true, demo: true, message: "demo session started" });
    res.cookies.set(SESSION_COOKIE, demo, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 });
    return res;
  }

  const state = randomToken(16);
  const { verifier, challenge } = pkcePair();

  const res = NextResponse.redirect(
    authorizeUrl({ clientId: cfg.clientId as string, state, challenge, redirect: redirectUri(request) }),
  );
  res.cookies.set(OAUTH_STATE_COOKIE, `${state}.${verifier}`, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
