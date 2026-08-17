"use client";

import { useState } from "react";

export default function Page() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    setStep("verifying token with Discord…");
    try {
      const res = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = (await res.json()) as {
        error?: string;
        verified?: boolean;
        bot?: { tag: string };
        warning?: string | null;
      };
      if (!res.ok) throw new Error(data.error ?? "login failed");
      if (data.warning) sessionStorage.setItem("dyno-hosting-warning", data.warning);
      else sessionStorage.removeItem("dyno-hosting-warning");
      setStep(data.verified ? `${data.bot?.tag} verified — starting your bot…` : "token saved — opening the dashboard…");
      setTimeout(() => {
              }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
      setStep("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[#0b0d14] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(60rem_40rem_at_10%_-10%,rgba(88,101,242,0.22),transparent),radial-gradient(50rem_30rem_at_90%_0%,rgba(235,69,158,0.14),transparent)]" />
      <div className="relative mx-auto w-full max-w-5xl px-4 py-14 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">discord bot hosting panel</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Host your Discord bot.
          <br />
          <span className="text-white/60">Configure everything. Online 24/7.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-white/70">
          Paste your bot token — we verify it with Discord, encrypt it (AES-256-GCM), start it on our host runner and keep
          it alive with automatic restarts. Then manage auto-mod, log channels, welcome messages, media-only channels,
          counting channels, admin channels, bot-command channels, auto-memes, starboard and more from this dashboard.
        </p>

        <form onSubmit={submit} className="mt-8 rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-white/50">bot token</label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="MTUzODgyMDg1NDcxOTQ1NTIzMg.GWVHOE…"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-sm text-white placeholder:text-white/25 focus:border-indigo-400/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || token.trim().length < 40}
              className="whitespace-nowrap rounded-xl bg-[#5865f2] px-6 py-3 text-base font-semibold shadow-lg shadow-indigo-500/25 transition hover:bg-[#4752c4] disabled:opacity-50"
            >
              {busy ? "Starting…" : "Host my bot"}
            </button>
          </div>
          <p className="mt-2 text-xs text-white/45">
            {step || "Developer Portal → Bot → Reset Token gives you one. It is stored encrypted and only decrypted inside the host runner."}
          </p>
          {error && <p className="mt-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
        </form>

        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          {[
            ["24/7 supervisor", "The host runner watches every bot, restarts on crash with backoff, and reports RSS, PID, uptime and logs."],
            ["No-code setup", "Auto-mod, log channels, welcome & farewell, media-only, counting, staff-only, bot-command, auto-meme, starboard channels."],
            ["Every change is live", "The dashboard talks to the running gateway through a secret-protected bridge — no restarts needed."],
          ].map(([title, body]) => (
            <div key={title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="text-base font-semibold">{title}</div>
              <p className="mt-1 text-[13.5px] leading-relaxed text-white/65">{body}</p>
            </div>
          ))}
        </div>

        <h2 className="mt-14 text-2xl font-semibold">How 24/7 hosting works here</h2>
        <p className="mt-2 max-w-3xl text-white/70">
          This website is a Vercel app. Vercel serverless functions cannot keep a Discord gateway WebSocket open (they
          freeze between requests), so a tiny supervisor — <code className="text-indigo-200">host/runner.js</code> — runs
          on any always-on host and pulls the bot list from this site:
        </p>
        <pre className="mt-4 overflow-x-auto rounded-2xl border border-white/10 bg-black/50 p-4 text-[12.5px] leading-relaxed text-emerald-200">
          <code>{`you ──▶ dashboard on Vercel (this site)
         │ POST /api/auth/token      verify + encrypt token, mark bot "running"
         │ GET  /api/host            live status, logs, start/stop/restart
         │
host runner (Railway / Render / Fly / VPS / Docker)   ── 24/7
         │ POST /api/host/claim     "which bots should run?" (x-host-key)
         │ POST /api/host/heartbeat status · rss · pid · logs
         └─▶ spawn node bot/index.js per bot, restart on crash`}</code>
        </pre>
        <p className="mt-4 text-sm text-white/60">
          Deploy the runner with:{" "}
          <code className="rounded bg-black/40 px-2 py-1 text-emerald-200">
            DASHBOARD_URL=https://your-app.vercel.app HOST_KEY=… node host/runner.js
          </code>{" "}
          — or use <code className="text-white/80">host/Dockerfile</code>. A Vercel cron pings{" "}
          <code className="text-white/80">/api/host/keepalive</code> every 5 minutes to flag bots whose runner vanished.
        </p>

        <p className="mt-10 text-xs text-white/40">
          Your token is encrypted at rest and never sent to the browser again. Rotating it in the Discord Developer
          Portal invalidates the stored copy instantly — paste the new one and the runner restarts that bot.
        </p>
      </div>
    </main>
  );
}
