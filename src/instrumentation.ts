import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Next.js instrumentation hook - runs once when the server process boots.
 *
 * AUTO_HOST=1 makes this single container host the bots itself: the website
 * spawns the 24/7 supervisor (host/runner.js) as a child process, so pasting a
 * bot token immediately brings that bot online. This is how the preview/sandbox
 * and any single-server deployment works.
 *
 * On Vercel (process.env.VERCEL is set) we never spawn anything - Vercel
 * functions cannot keep a gateway socket open, so there you deploy host/runner.js
 * on an always-on host instead (see README).
 */

const SHUTDOWN_GRACE_MS = 15_000;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AUTO_HOST !== "1") return;
  if (process.env.VERCEL || process.env.VERCEL_ENV) return;

  const botDir = path.join(process.cwd(), "bot");
  const runner = path.join(process.cwd(), "host", "runner.js");

  const env = {
    ...process.env,
    DASHBOARD_URL: process.env.DASHBOARD_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
    HOST_KEY: process.env.HOST_KEY || "dyno-lite-host-key",
    HOST_ID: process.env.HOST_ID || `auto-host-${process.pid}`,
    BOT_DIR: botDir,
    BOT_SECRET: process.env.BOT_SECRET || "dyno-lite-bridge-secret",
    DATABASE_URL:
      process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
    AUTO_HOST: "1",
  };

  const child = spawn(process.execPath, [runner], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const prefix = "[auto-host]";
  const pipe = (stream: NodeJS.ReadableStream, isError: boolean) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console.log(`${prefix} ${isError ? "! " : ""}${line}`);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on("exit", (code, signal) => {
    console.log(`${prefix} supervisor exited (${signal || `exit ${code}`})`);
    // the supervisor is the thing that keeps bots online - bring it back
    if (process.exitCode === undefined && !process.env.DISABLE_AUTO_HOST_RESTART) {
      setTimeout(() => {
        console.log(`${prefix} restarting supervisor`);
        void register();
      }, 5_000);
    }
  });

  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  console.log(`${prefix} supervisor running (pid ${child.pid}) - pasted bot tokens will start immediately`);
}
