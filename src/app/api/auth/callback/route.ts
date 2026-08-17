import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  avatarUrl,
  botConfig,
  exchangeCode,
  fetchUser,
  signSession,
} from "@/lib/discord";
import { OAUTH_STATE_COOKIE, OAUTH_TOKEN_COOKIE, SESSION_COOKIE } from "@/lib/discord";

export const dynamic = "force-dynamic";

/**
 * Discord redirects here with ?code&state. We verify state, exchange the code
 * using PKCE, then issue a signed session cookie. OAuth guilds are cached in a
 * second short-lived cookie so /api/guilds can filter by MANAGE_GUILD.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cfg = botConfig();

  if (!code || !state) return NextResponse.redirect(new URL("/?error=missing_code", url.origin));

  const stored = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OAUTH_STATE_COOKIE}=`))
    ?.split("=")
    .slice(1)
    .join("=");

  if (!stored) return NextResponse.redirect(new URL("/?error=expired_state", url.origin));

  const [expectedState, verifier] = decodeURIComponent(stored).split(".");
  if (!verifier || expectedState !== state) {
    return NextResponse.redirect(new URL("/?error=state_mismatch", url.origin));
  }

  if (!cfg.clientId) return NextResponse.redirect(new URL("/?error=no_client_id", url.origin));

  const accessToken = await exchangeCode({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    code,
    verifier,
    redirect: `${url.origin}/api/auth/callback`,
  });

  if (!accessToken) return NextResponse.redirect(new URL("/?error=oauth_failed", url.origin));

  const user = await fetchUser(accessToken);
  if (!user) return NextResponse.redirect(new URL("/?error=profile_failed", url.origin));

  // cache the access token briefly so the guild list can be fetched once
  const tokenFile = path.join(process.cwd(), ".next", "oauth-token.txt");
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, accessToken, { mode: 0o600 });
  } catch {
    /* non-fatal */
  }

  const session = signSession({
    id: user.id,
    username: user.username,
    avatar: avatarUrl(user.id, user.avatar),
    demo: false,
  });

  const res = NextResponse.redirect(new URL("/dashboard", url.origin));
  res.cookies.set(SESSION_COOKIE, session, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
  res.cookies.set(OAUTH_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}
