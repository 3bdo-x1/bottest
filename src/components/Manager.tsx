"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type Channel = { id: string; name: string };
type Role = { id: string; name: string; color: string };
type Feature = { type: string; channelId: string; enabled: number; config: Record<string, unknown> };

type GuildView = {
  id: string;
  name: string | null;
  icon: string | null;
  memberCount: number | null;
  joined: boolean;
  channels: Channel[];
  roles: Role[];
  settings: {
    prefix: string;
    autoroleId: string | null;
    logChannelId: string | null;
    modLogChannelId: string | null;
    welcome: { enabled: boolean; channelId: string | null; message: string; embed: boolean; autoDelete: number };
    farewell: { enabled: boolean; channelId: string | null; message: string };
    logs: Record<string, boolean>;
    automod: {
      wordsEnabled: boolean;
      antispamEnabled: boolean;
      inviteFilter: boolean;
      mentionLimit: number;
      spamCount: number;
      spamSeconds: number;
      spamMuteMinutes: number;
      action: string;
      exemptRoleIds: string[];
      exemptChannelIds: string[];
    };
    badWords: string[];
  };
  features: Feature[];
  counting: { channelId: string | null; current: number; best: number; fails: number };
  leaderboard: { counting: { userId: string; score: number; best: number }[]; xp: { userId: string; level: number; points: number }[] };
  modLogs: { action: string; user_id: string | null; reason: string | null; created_at: number }[];
};

type GuildSummary = {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number | null;
  features: number;
  botPresent: boolean;
};

export type HostingState = {
  status: string;
  desiredState: string;
  restarts: number;
  rssBytes: number;
  guildCount: number;
  pid: number | null;
  port: number | null;
  startedAt: number | null;
  hostOnline: boolean;
  hostId: string | null;
};

type Props = {
  user: { id: string; username: string; avatar: string | null; demo: boolean };
  hosting?: HostingState;
  initialBotOnline: boolean;
  initialBotTag: string;
};

const TABS = ["Hosting", "Overview", "Welcome", "Logging", "Auto-mod", "Channels", "Commands"] as const;
type Tab = (typeof TABS)[number];

const CHANNEL_FEATURES: { type: string; label: string; hint: string; multi: boolean }[] = [
  { type: "media", label: "Media-only channels", hint: "Only images, videos or links allowed", multi: true },
  { type: "admin", label: "Staff-only channels", hint: "Non-staff messages removed + author DMed", multi: true },
  { type: "botcmd", label: "Bot command channels", hint: "Commands blocked everywhere else", multi: true },
  { type: "memes", label: "Auto-meme channels", hint: "Reddit meme feed on an interval", multi: true },
  { type: "counting", label: "Counting channel", hint: "Cooperative counting game", multi: false },
  { type: "starboard", label: "Starboard", hint: "Mirror highly starred messages", multi: false },
  { type: "confess", label: "Confession channel", hint: "Anonymous confessions", multi: false },
  { type: "suggestions", label: "Suggestion channel", hint: "Suggestion queue with voting", multi: false },
  { type: "levels", label: "Level-up channel", hint: "Where XP level-ups are announced", multi: false },
];

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export default function Manager({ user, hosting, initialBotOnline, initialBotTag }: Props) {
  const [tab, setTab] = useState<Tab>("Hosting");
  const [guilds, setGuilds] = useState<GuildSummary[]>([]);
  const [active, setActive] = useState<string>("");
  const [view, setView] = useState<GuildView | null>(null);
  const [source, setSource] = useState<string>("");
  const [botOnline, setBotOnline] = useState(initialBotOnline);
  const [botTag, setBotTag] = useState(initialBotTag);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const [hostingState, setHostingState] = useState<HostingState | null>(hosting ?? null);
  const [hostLogs, setHostLogs] = useState<{ line: string; level: string; at: number }[]>([]);
  const [loginWarning, setLoginWarning] = useState<string | null>(null);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? sessionStorage.getItem("dyno-hosting-warning") : null;
    if (stored) {
      setLoginWarning(stored);
      sessionStorage.removeItem("dyno-hosting-warning");
    }
  }, []);
  const notify = (text: string, ok = true) => setToast({ text, ok });

  const loadHosting = useCallback(async () => {
    const res = await fetch("/api/host", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { hosting: HostingState & { host: { online: boolean; id: string | null } }; logs: { line: string; level: string; at: number }[] };
    setHostingState(data.hosting);
    setHostLogs(data.logs ?? []);
  }, []);

  const hostAction = async (action: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as { error?: string; reload?: boolean };
      if (!res.ok) throw new Error(data.error ?? "action failed");
      if (data.reload) {
        notify("token replaced - reloading");
        setTimeout(() => window.location.reload(), 900);
        return;
      }
      notify(`${action} requested - the host runner picks it up within a few seconds`);
      setTimeout(() => void loadHosting(), 2500);
    } catch (error) {
      notify(error instanceof Error ? error.message : "failed", false);
    } finally {
      setBusy(false);
    }
  };

  const loadGuilds = useCallback(async () => {
    const res = await fetch("/api/guilds", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { guilds: GuildSummary[]; botOnline: boolean };
    setGuilds(data.guilds ?? []);
    setBotOnline(data.botOnline);
    setActive((current) => current || data.guilds?.[0]?.id || "");
  }, []);

  const loadGuild = useCallback(async (id: string) => {
    if (!id) return;
    const res = await fetch(`/api/guilds/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { guild: GuildView; source: string };
    setView(data.guild);
    setSource(data.source);
  }, []);

  useEffect(() => {
    void loadGuilds();
    void loadHosting();
    const timer = setInterval(() => void loadHosting(), 8000);
    return () => clearInterval(timer);
  }, [loadGuilds, loadHosting]);

  useEffect(() => {
    void loadGuild(active);
  }, [active, loadGuild]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const send = async (kind: string, payload: Record<string, unknown>, label: string) => {
    if (!active) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/guilds/${active}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, payload }),
      });
      const data = (await res.json()) as { guild?: GuildView; error?: string; channel?: string; rendered?: string };
      if (!res.ok) throw new Error(data.error ?? "request failed");
      if (data.guild) setView(data.guild);
      notify(data.channel ? `${label} → ${data.channel}` : label, true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "failed", false);
    } finally {
      setBusy(false);
    }
  };

  const channels = view?.channels ?? [];
  const roles = view?.roles ?? [];
  const channelName = (id: string | null) => (id ? channels.find((c) => c.id === id)?.name ?? id : "not set");
  const featuresOf = (type: string) => (view?.features ?? []).filter((f) => f.type === type);

  /* ---------------------------------------------------------------- */

  const field = "w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none";
  const label = "text-[11px] font-semibold uppercase tracking-wider text-white/45";
  const card = "rounded-2xl border border-white/10 bg-white/[0.03] p-5";
  const primary =
    "rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50";
  const ghost = "rounded-xl border border-white/15 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">dyno-lite dashboard</h1>
          <p className="text-sm text-white/55">
            signed in as <span className="text-white/85">{user.username}</span>
            {user.demo && <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">demo session</span>}
            {" · bot "}
            <span className={botOnline ? "text-emerald-300" : "text-rose-300"}>{botOnline ? `online (${botTag})` : "offline"}</span>
            {source && <span className="ml-2 text-white/35">data source: {source}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className={ghost} onClick={() => void loadGuilds().then(() => loadGuild(active))}>
            Refresh
          </button>
          <a className={ghost} href="/api/auth/logout">
            Log out
          </a>
        </div>
      </header>

      <section className={`${card} mt-5`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-56 flex-1">
            <span className={label}>Server</span>
            <select className={field} value={active} onChange={(e) => setActive(e.target.value)}>
              {guilds.length ? (
                guilds.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} {g.memberCount ? `· ${g.memberCount} members` : ""} {g.botPresent ? "" : "· bot not in server"}
                  </option>
                ))
              ) : (
                <option value="">no servers yet</option>
              )}
            </select>
          </div>
          {view && (
            <div className="flex flex-wrap gap-4 text-sm text-white/60">
              <span>
                prefix <code className="text-white/90">{view.settings.prefix}</code>
              </span>
              <span>
                counting <code className="text-white/90">{view.counting?.current ?? 0}</code> / best {view.counting?.best ?? 0}
              </span>
              <span>{view.features.length} channel systems</span>
              <span>{view.modLogs.length} recent log rows</span>
            </div>
          )}
        </div>
        {!channels.length && (
          <p className="mt-3 text-[13px] text-amber-300/80">
            Channel and role dropdowns appear once the bot is online for this server ({view?.joined ? "joined" : "not joined"}).
            Start it with <code className="text-white/80">cd bot && npm start</code>.
          </p>
        )}
      </section>

      <nav className="mt-5 flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              tab === item ? "bg-indigo-500 text-white" : "bg-white/[0.05] text-white/70 hover:bg-white/10"
            }`}
          >
            {item}
          </button>
        ))}
      </nav>

      {loginWarning && (
        <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {loginWarning}
        </div>
      )}

      {toast && (
        <div className={`mt-4 rounded-xl border px-4 py-2 text-sm ${toast.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-rose-400/30 bg-rose-500/10 text-rose-200"}`}>
          {toast.text}
        </div>
      )}

      {tab === "Hosting" && (
        <HostingPanel state={hostingState} logs={hostLogs} busy={busy} onAction={hostAction} />
      )}

      {view && (
        <>
          {tab === "Overview" && <Overview view={view} />}
          {tab === "Welcome" && <Welcome view={view} send={send} busy={busy} channels={channels} />}
          {tab === "Logging" && <Logging view={view} send={send} busy={busy} channels={channels} />}
          {tab === "Auto-mod" && <AutoMod view={view} send={send} busy={busy} channels={channels} roles={roles} />}
          {tab === "Channels" && (
            <Channels view={view} send={send} busy={busy} channels={channels} channelName={channelName} featuresOf={featuresOf} />
          )}
          {tab === "Commands" && <Commands view={view} send={send} busy={busy} />}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

type SendFn = (kind: string, payload: Record<string, unknown>, label: string) => Promise<void>;

function Overview({ view }: { view: GuildView }) {
  const stats: [string, string][] = [
    ["Server", view.name ?? view.id],
    ["Members", view.memberCount ? String(view.memberCount) : "—"],
    ["Channels cached", String(view.channels.length)],
    ["Roles cached", String(view.roles.length)],
    ["Counting record", String(view.counting?.best ?? 0)],
    ["Counting fails", String(view.counting?.fails ?? 0)],
    ["Banned words", String(view.settings.badWords.length)],
    ["Channel systems", String(view.features.length)],
  ];
  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <div className="text-xl font-semibold">{value}</div>
            <div className="text-[11px] uppercase tracking-wide text-white/50">{label}</div>
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-white/50">Active channel systems</h3>
        {view.features.length ? (
          <ul className="mt-3 space-y-1 text-sm text-white/80">
            {view.features.map((f, index) => (
              <li key={`${f.type}-${f.channelId}-${index}`}>
                <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[11px] text-indigo-200">{f.type}</span>{" "}
                <code className="text-white/70">{f.channelId}</code>{" "}
                <span className="text-white/40">{Object.keys(f.config ?? {}).length ? JSON.stringify(f.config) : ""}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-white/50">None configured yet — open the Channels tab.</p>
        )}
      </div>
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-white/50">Leaderboards</h3>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {([
            {
              title: "Counting",
              rows: (view.leaderboard?.counting ?? []).map((row) => ({ userId: row.userId, text: `${row.score} correct · best ${row.best}` })),
            },
            {
              title: "XP",
              rows: (view.leaderboard?.xp ?? []).map((row) => ({ userId: row.userId, text: `level ${row.level} · ${row.points} XP` })),
            },
          ] as { title: string; rows: { userId: string; text: string }[] }[]).map((board) => (
            <div key={board.title}>
              <div className="text-sm font-semibold">{board.title}</div>
              <ul className="mt-1 space-y-1 text-sm text-white/70">
                {board.rows.length ? (
                  board.rows.map((row, index) => (
                    <li key={row.userId ?? index}>
                      {index + 1}. <code className="text-white/50">{row.userId}</code> — {row.text}
                    </li>
                  ))
                ) : (
                  <li className="text-white/40">no entries yet</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Welcome({ view, send, busy, channels }: { view: GuildView; send: SendFn; busy: boolean; channels: Channel[] }) {
  const [welcome, setWelcome] = useState(view.settings.welcome);
  const [farewell, setFarewell] = useState(view.settings.farewell);
  const preview = useMemo(
    () =>
      (welcome.message || "")
        .replace(/\{user\}/g, "@NewMember")
        .replace(/\{username\}/g, "NewMember")
        .replace(/\{tag\}/g, "NewMember#0001")
        .replace(/\{server\}/g, view.name ?? "your server")
        .replace(/\{count\}/g, String(view.memberCount ?? 42)),
    [welcome.message, view.name, view.memberCount],
  );

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Welcome message</h3>
        <label className="mt-3 flex items-center gap-2 text-sm text-white/80">
          <input type="checkbox" checked={welcome.enabled} onChange={(e) => setWelcome({ ...welcome, enabled: e.target.checked })} className="h-4 w-4 accent-indigo-500" />
          enabled
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm text-white/80">
          <input type="checkbox" checked={welcome.embed} onChange={(e) => setWelcome({ ...welcome, embed: e.target.checked })} className="h-4 w-4 accent-indigo-500" />
          send as embed
        </label>
        <div className="mt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">channel</span>
          <select
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            value={welcome.channelId ?? ""}
            onChange={(e) => setWelcome({ ...welcome, channelId: e.target.value || null })}
          >
            <option value="">not set</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>
        <div className="mt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">auto-delete after (seconds)</span>
          <input
            type="number"
            min={0}
            max={600}
            value={welcome.autoDelete}
            onChange={(e) => setWelcome({ ...welcome, autoDelete: Number(e.target.value) })}
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">message · {"{user} {username} {tag} {server} {count}"}</span>
          <textarea
            rows={3}
            value={welcome.message}
            onChange={(e) => setWelcome({ ...welcome, message: e.target.value })}
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-[13px]"
          />
        </div>
        <div className="mt-3 rounded-xl border border-dashed border-indigo-400/40 bg-indigo-500/10 px-3 py-2 text-[13px] text-white/80">{preview}</div>
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
            onClick={() => void send("settings", { welcome }, "welcome saved")}
          >
            Save welcome
          </button>
          <button
            disabled={busy}
            className="rounded-xl border border-white/15 bg-white/[0.05] px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={() => void send("test", { kind: "welcome" }, "welcome test sent")}
          >
            Send test
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Farewell message</h3>
        <label className="mt-3 flex items-center gap-2 text-sm text-white/80">
          <input type="checkbox" checked={farewell.enabled} onChange={(e) => setFarewell({ ...farewell, enabled: e.target.checked })} className="h-4 w-4 accent-indigo-500" />
          enabled
        </label>
        <div className="mt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">channel</span>
          <select
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            value={farewell.channelId ?? ""}
            onChange={(e) => setFarewell({ ...farewell, channelId: e.target.value || null })}
          >
            <option value="">not set</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>
        <div className="mt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">message</span>
          <textarea
            rows={3}
            value={farewell.message}
            onChange={(e) => setFarewell({ ...farewell, message: e.target.value })}
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-[13px]"
          />
        </div>
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
            onClick={() => void send("settings", { farewell }, "farewell saved")}
          >
            Save farewell
          </button>
          <button
            disabled={busy}
            className="rounded-xl border border-white/15 bg-white/[0.05] px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={() => void send("test", { kind: "farewell" }, "farewell test sent")}
          >
            Send test
          </button>
        </div>

        <h3 className="mt-6 text-base font-semibold">Prefix & autorole</h3>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">command prefix</span>
            <input
              defaultValue={view.settings.prefix}
              id="prefix-input"
              maxLength={5}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">autorole</span>
            <select id="autorole-select" defaultValue={view.settings.autoroleId ?? ""} className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm">
              <option value="">disabled</option>
              {view.roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          disabled={busy}
          className="mt-3 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          onClick={() => {
            const prefix = (document.getElementById("prefix-input") as HTMLInputElement).value;
            const autoroleId = (document.getElementById("autorole-select") as HTMLSelectElement).value;
            void send("settings", { general: { prefix, autoroleId } }, "server settings saved");
          }}
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

function Logging({ view, send, busy, channels }: { view: GuildView; send: SendFn; busy: boolean; channels: Channel[] }) {
  const [logs, setLogs] = useState({
    auditChannelId: view.settings.logChannelId ?? "",
    modChannelId: view.settings.modLogChannelId ?? "",
    ...(view.settings.logs ?? {}),
  });

  const EVENTS: [string, string][] = [
    ["deleted", "Deleted messages"],
    ["joins", "Joins, leaves & autorole"],
    ["kicks", "Kicks"],
    ["bans", "Bans & unbans"],
    ["timeouts", "Mutes & timeouts"],
    ["roles", "Role changes"],
    ["automod", "Auto-mod actions"],
    ["config", "Config & custom commands"],
  ];

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Log destinations</h3>
        <div className="mt-3 space-y-3">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">audit log channel</span>
            <select
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
              value={logs.auditChannelId}
              onChange={(e) => setLogs({ ...logs, auditChannelId: e.target.value })}
            >
              <option value="">not set</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">mod log channel</span>
            <select
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
              value={logs.modChannelId}
              onChange={(e) => setLogs({ ...logs, modChannelId: e.target.value })}
            >
              <option value="">same as audit log</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <h3 className="mt-5 text-sm font-semibold uppercase tracking-wider text-white/45">Events</h3>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {EVENTS.map(([key, title]) => (
            <label key={key} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean((logs as Record<string, unknown>)[key])}
                onChange={(e) => setLogs({ ...logs, [key]: e.target.checked })}
                className="h-4 w-4 accent-indigo-500"
              />
              {title}
            </label>
          ))}
        </div>
        <button
          disabled={busy}
          className="mt-4 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          onClick={() => void send("settings", { logs }, "logging saved")}
        >
          Save logging
        </button>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Recent log entries</h3>
        <div className="mt-3 max-h-96 overflow-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2">action</th>
                <th className="py-2">user</th>
                <th className="py-2">reason</th>
                <th className="py-2">when</th>
              </tr>
            </thead>
            <tbody>
              {view.modLogs.length ? (
                view.modLogs.map((row, index) => (
                  <tr key={index} className="border-t border-white/5">
                    <td className="py-2">{row.action}</td>
                    <td className="py-2 font-mono text-white/50">{row.user_id ?? "—"}</td>
                    <td className="py-2 text-white/70">{row.reason ?? "—"}</td>
                    <td className="py-2 font-mono text-white/40">{new Date(row.created_at).toLocaleTimeString()}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="py-3 text-white/40">
                    nothing logged yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AutoMod({
  view,
  send,
  busy,
  channels,
  roles,
}: {
  view: GuildView;
  send: SendFn;
  busy: boolean;
  channels: Channel[];
  roles: Role[];
}) {
  const [automod, setAutomod] = useState({ ...view.settings.automod, badWords: view.settings.badWords.join(", ") });
  const selectedChannels = channels.filter((c) => automod.exemptChannelIds.includes(c.id));

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Rules</h3>
        <div className="mt-3 space-y-2">
          {[
            ["wordsEnabled", "Banned word filter"],
            ["antispamEnabled", "Anti-spam & mass mention"],
            ["inviteFilter", "Delete invite links"],
          ].map(([key, title]) => (
            <label key={key} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean((automod as Record<string, unknown>)[key])}
                onChange={(e) => setAutomod({ ...automod, [key]: e.target.checked })}
                className="h-4 w-4 accent-indigo-500"
              />
              {title}
            </label>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {[
            ["mentionLimit", "Max mentions"],
            ["spamCount", "Spam messages"],
            ["spamSeconds", "Spam window (s)"],
            ["spamMuteMinutes", "Mute length (min)"],
          ].map(([key, title]) => (
            <div key={key}>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{title}</span>
              <input
                type="number"
                value={Number((automod as unknown as Record<string, number>)[key])}
                onChange={(e) => setAutomod({ ...automod, [key]: Number(e.target.value) } as typeof automod)}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
              />
            </div>
          ))}
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">action</span>
            <select
              value={automod.action}
              onChange={(e) => setAutomod({ ...automod, action: e.target.value })}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            >
              <option value="timeout">delete + mute</option>
              <option value="warn">delete + warn</option>
              <option value="delete">delete only</option>
            </select>
          </div>
        </div>
        <div className="mt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">banned words (* = wildcard)</span>
          <textarea
            rows={3}
            value={automod.badWords}
            onChange={(e) => setAutomod({ ...automod, badWords: e.target.value })}
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-[13px]"
          />
        </div>
        <button
          disabled={busy}
          className="mt-4 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          onClick={() => {
            const words = automod.badWords.split(/[\s,]+/).filter(Boolean);
            void send("settings", { automod: { ...automod, badWords: words } }, "auto-mod saved");
            void send("badwords", { words }, "banned words saved");
          }}
        >
          Save auto-mod
        </button>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Exemptions</h3>
        <p className="text-[13px] text-white/55">Roles and channels auto-mod never touches.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">exempt roles</span>
            <select
              multiple
              value={automod.exemptRoleIds}
              onChange={(e) =>
                setAutomod({
                  ...automod,
                  exemptRoleIds: Array.from(e.target.selectedOptions).map((o) => o.value),
                })
              }
              className="h-32 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">exempt channels</span>
            <select
              multiple
              value={automod.exemptChannelIds}
              onChange={(e) =>
                setAutomod({
                  ...automod,
                  exemptChannelIds: Array.from(e.target.selectedOptions).map((o) => o.value),
                })
              }
              className="h-32 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            >
              {(selectedChannels.length ? selectedChannels : channels).map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          disabled={busy}
          className="mt-4 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          onClick={() => void send("settings", { automod: { ...automod, badWords: automod.badWords.split(/[\s,]+/).filter(Boolean) } }, "exemptions saved")}
        >
          Save exemptions
        </button>
      </div>
    </div>
  );
}

function Channels({
  view,
  send,
  busy,
  channels,
  channelName,
  featuresOf,
}: {
  view: GuildView;
  send: SendFn;
  busy: boolean;
  channels: Channel[];
  channelName: (id: string | null) => string;
  featuresOf: (type: string) => Feature[];
}) {
  return (
    <div className="mt-4 space-y-4">
      {CHANNEL_FEATURES.map((feature) => {
        const existing = featuresOf(feature.type);
        return (
          <div key={feature.type} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">{feature.label}</h3>
                <p className="text-[13px] text-white/55">{feature.hint}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-white/60">
                {existing.length ? (
                  existing.map((row) => (
                    <span key={row.channelId} className="flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-1 text-indigo-100">
                      #{channelName(row.channelId)}
                      <button
                        className="text-white/50 hover:text-rose-300"
                        onClick={() => void send("feature", { type: feature.type, channelId: row.channelId, remove: true }, `removed #${channelName(row.channelId)}`)}
                      >
                        ✕
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="text-white/35">not configured</span>
                )}
              </div>
            </div>

            <FeatureForm type={feature.type} send={send} busy={busy} channels={channels} view={view} />
          </div>
        );
      })}
    </div>
  );
}

function FeatureForm({ type, send, busy, channels, view }: { type: string; send: SendFn; busy: boolean; channels: Channel[]; view: GuildView }) {
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(() => {
    const existing = view.features.find((f) => f.type === type);
    const defaults: Record<string, unknown> = {
      media: { allowLinks: true },
      counting: { resetOnFail: true, blockSameUser: true },
      memes: { intervalMinutes: 60, subreddits: ["memes"] },
      starboard: { threshold: 3 },
    };
    return { ...(defaults[type] ?? {}), ...((existing?.config ?? {}) as Record<string, unknown>) };
  });

  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(channels[0].id);
  }, [channels, channelId]);

  const toggle = (key: string, value: boolean) => setConfig({ ...config, [key]: value });
  const numberValue = (key: string, fallback: number) => Number(config[key] ?? fallback);

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="lg:col-span-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">channel</span>
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
        >
          {channels.map((c) => (
            <option key={c.id} value={c.id}>#{c.name}</option>
          ))}
        </select>
      </div>

      {type === "media" && (
        <label className="flex items-end gap-2 pb-2 text-sm text-white/80">
          <input type="checkbox" checked={Boolean(config.allowLinks)} onChange={(e) => toggle("allowLinks", e.target.checked)} className="h-4 w-4 accent-indigo-500" />
          also allow links
        </label>
      )}
      {type === "counting" && (
        <>
          <label className="flex items-end gap-2 pb-2 text-sm text-white/80">
            <input type="checkbox" checked={Boolean(config.resetOnFail)} onChange={(e) => toggle("resetOnFail", e.target.checked)} className="h-4 w-4 accent-indigo-500" />
            reset on fail
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-white/80">
            <input type="checkbox" checked={Boolean(config.blockSameUser)} onChange={(e) => toggle("blockSameUser", e.target.checked)} className="h-4 w-4 accent-indigo-500" />
            block double counting
          </label>
        </>
      )}
      {type === "memes" && (
        <>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">interval (min)</span>
            <input
              type="number"
              min={5}
              value={numberValue("intervalMinutes", 60)}
              onChange={(e) => setConfig({ ...config, intervalMinutes: Number(e.target.value) })}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">subreddit</span>
            <input
              value={String((config.subreddits as string[])?.[0] ?? "memes")}
              onChange={(e) => setConfig({ ...config, subreddits: [e.target.value.replace(/[^a-z0-9_]/gi, "")] })}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            />
          </div>
        </>
      )}
      {type === "starboard" && (
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">stars needed</span>
          <input
            type="number"
            min={1}
            max={25}
            value={numberValue("threshold", 3)}
            onChange={(e) => setConfig({ ...config, threshold: Number(e.target.value) })}
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
          />
        </div>
      )}

      <div className="flex items-end">
        <button
          disabled={busy || !channelId}
          onClick={() => void send("feature", { type, channelId, config, enabled: true }, `${type} channel saved`)}
          className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function Commands({ view, send, busy }: { view: GuildView; send: SendFn; busy: boolean }) {
  const [name, setName] = useState("");
  const [response, setResponse] = useState("");
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Custom commands</h3>
        <p className="text-[13px] text-white/55">Each one works as a slash command and with the server prefix (max 50).</p>
        <div className="mt-3 space-y-2">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm" />
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">response</span>
            <textarea value={response} onChange={(e) => setResponse(e.target.value)} rows={3} className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm" />
          </div>
          <button
            disabled={busy || !name || !response}
            className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
            onClick={() => {
              void send("customcommand", { op: "add", name, response }, `/${name} saved`);
              setName("");
              setResponse("");
            }}
          >
            Save command
          </button>
          <p className="text-[12px] text-white/40">
            Tip: in Discord use <code>/customcommand add</code> or <code>{view.settings.prefix}customcommand add</code> — both
            hit the same database.
          </p>
        </div>
      </div>
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Channel systems in place</h3>
        <ul className="mt-3 space-y-1 text-sm text-white/75">
          {view.features.length ? (
            view.features.map((f, index) => (
              <li key={index}>
                <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[11px] text-indigo-200">{f.type}</span>{" "}
                <code className="text-white/60">{f.channelId}</code>
              </li>
            ))
          ) : (
            <li className="text-white/40">none yet</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hosting                                                                    */
/* -------------------------------------------------------------------------- */

function HostingPanel({
  state,
  logs,
  busy,
  onAction,
}: {
  state: HostingState | null;
  logs: { line: string; level: string; at: number }[];
  busy: boolean;
  onAction: (action: string) => Promise<void>;
}) {
  const online = state?.status === "online";
  const mb = (state?.rssBytes ?? 0) / 1024 / 1024;
  const uptime = state?.startedAt ? Date.now() - state.startedAt : 0;
  const uptimeText =
    uptime > 3600_000 ? `${Math.floor(uptime / 3600_000)}h ${Math.floor((uptime % 3600_000) / 60_000)}m` : `${Math.floor(uptime / 60_000)}m`;

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "status", value: state?.status ?? "unknown", good: online },
          { label: "host runner", value: state?.hostOnline ? `online${state.hostId ? ` · ${state.hostId.slice(0, 12)}` : ""}` : "offline", good: state?.hostOnline },
          { label: "memory", value: `${mb.toFixed(1)} MB`, good: mb < 400 },
          { label: "restarts", value: String(state?.restarts ?? 0), good: (state?.restarts ?? 0) < 5 },
          { label: "uptime", value: state?.startedAt ? uptimeText : "—" },
          { label: "pid", value: state?.pid ? String(state.pid) : "—" },
          { label: "guilds", value: String(state?.guildCount ?? 0) },
          { label: "bridge port", value: state?.port ? String(state.port) : "—" },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <div className={`text-lg font-semibold ${item.good === undefined ? "" : item.good ? "text-emerald-300" : "text-amber-300"}`}>
              {item.value}
            </div>
            <div className="text-[11px] uppercase tracking-wide text-white/50">{item.label}</div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Bot lifecycle</h3>
        <p className="mt-1 text-[13px] text-white/60">
          Desired state: <code className="text-white/85">{state?.desiredState ?? "unknown"}</code>. The host runner
          reconciles every few seconds — start/stop takes effect almost immediately.
        </p>
        {!state?.hostOnline && (
          <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-[13px] text-amber-200">
            No host runner is reporting. Deploy one with{" "}
            <code className="text-white/85">DASHBOARD_URL=&lt;this site&gt; HOST_KEY=… node host/runner.js</code> (Railway,
            Render, Fly.io, a VPS, Docker) — Vercel functions cannot hold a gateway socket open.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => void onAction("start")} className="rounded-xl bg-emerald-500/90 px-4 py-2 text-sm font-semibold disabled:opacity-50">
            Start
          </button>
          <button disabled={busy} onClick={() => void onAction("restart")} className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50">
            Restart
          </button>
          <button disabled={busy} onClick={() => void onAction("stop")} className="rounded-xl bg-rose-500/90 px-4 py-2 text-sm font-semibold disabled:opacity-50">
            Stop
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-base font-semibold">Live logs</h3>
        <div className="mt-3 max-h-80 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-[12px] leading-relaxed">
          {logs.length ? (
            logs.map((entry, index) => (
              <div key={index} className={entry.level === "error" ? "text-rose-300" : "text-emerald-200/90"}>
                <span className="text-white/30">{new Date(entry.at).toLocaleTimeString()} </span>
                {entry.line}
              </div>
            ))
          ) : (
            <span className="text-white/40">waiting for the host runner to stream logs…</span>
          )}
        </div>
      </div>
    </div>
  );
}
