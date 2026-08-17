import { NextResponse } from "next/server";
import { BOT_SESSION_COOKIE } from "@/lib/hosting";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(BOT_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

export async function GET(request: Request) {
  return POST(request);
}
