'use strict';

/**
 * dyno-lite host runner — keeps Discord bots online 24/7.
 *
 *   DASHBOARD_URL=https://your-app.vercel.app HOST_KEY=... node runner.js
 *
 * Every few seconds it asks the website which bots should be running
 * (/api/host/claim), spawns one child process per bot (`node bot/index.js`),
 * watches it, restarts it with exponential backoff, and streams status + logs
 * back to the website (/api/host/heartbeat).
 *
 * Deploy it anywhere that allows a long-lived process:
 *   Railway · Render · Fly.io · a $4 VPS · Docker · systemd · this sandbox.
 * Vercel itself cannot host this file (functions freeze between requests).
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const HOST_KEY = process.env.HOST_KEY || 'dyno-lite-host-key';
const HOST_ID = process.env.HOST_ID || `${os.hostname()}-${process.pid}`;
const POLL_MS = Number(process.env.POLL_MS || 4000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 10_000);
const BASE_PORT = Number(process.env.BASE_PORT || 3100);
const BOT_DIR = process.env.BOT_DIR || path.join(__dirname, '..', 'bot');
const MAX_LOG_LINES = 250;

const jobs = new Map(); // botId -> { child, restarts, startedAt, logs:[], status, rss, guildCount, port, backoffMs, lastClaimedToken }
let stopping = false;

const log = (...args) => console.log(`[host ${HOST_ID}]`, ...args);

/* -------------------------------------------------------------------------- */
/* Website API                                                               */
/* -------------------------------------------------------------------------- */

async function claim() {
  const res = await fetch(`${DASHBOARD_URL}/api/host/claim?host=${encodeURIComponent(HOST_ID)}`, {
    method: 'POST',
    headers: { 'x-host-key': HOST_KEY, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`);
  return res.json();
}

async function heartbeat() {
  const payload = [...jobs.values()].map((job) => ({
    botId: job.botId,
    status: job.fatal ?? job.status,
    pid: job.child?.pid ?? null,
    port: job.port,
    rssBytes: job.rss,
    guildCount: job.guildCount,
    restarts: job.restarts,
    startedAt: job.startedAt,
    logs: job.logs.splice(0, job.logs.length),
  }));
  if (!payload.length) return;

  for (const item of payload) {
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/host/heartbeat`, {
        method: 'POST',
        headers: { 'x-host-key': HOST_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log(`heartbeat for ${item.botId} failed: HTTP ${res.status}`);
    } catch (error) {
      log(`heartbeat for ${item.botId} failed: ${error.message}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Process supervision                                                       */
/* -------------------------------------------------------------------------- */

function pushLog(job, line) {
  job.logs.push(String(line).slice(0, 500));
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  process.stdout.write(`[bot ${job.botId.slice(-6)}] ${line}\n`);
}

function envFor(job, token) {
  return {
    ...process.env,
    DISCORD_TOKEN: token,
    BOT_ID: job.botId,
    MANAGED_BY: HOST_ID,
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/app_db',
    BOT_SECRET: process.env.BOT_SECRET || 'dyno-lite-bridge-secret',
    BOT_PORT: String(job.port),
    BOT_HOST: '127.0.0.1',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    // keep the bot's own config file from overriding the runner's env
    DASHBOARD_URL,
  };
}

let depsPromise = null;
function ensureBotDependencies() {
  if (depsPromise) return depsPromise;
  const marker = path.join(BOT_DIR, 'node_modules', 'discord.js');
  if (require('node:fs').existsSync(marker)) return Promise.resolve();
  log('bot dependencies missing - installing (one time, ~10s)');
  depsPromise = new Promise((resolve) => {
    const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: BOT_DIR, stdio: 'ignore' });
    child.on('exit', () => {
      log('bot dependencies installed');
      resolve();
    });
    child.on('error', (error) => {
      log(`npm install failed: ${error.message}`);
      resolve();
    });
  });
  return depsPromise;
}

async function start(job, token) {
  await ensureBotDependencies().catch(() => {});
  job.lastToken = token;
  job.startedAt = Date.now();
  job.status = 'starting';
  job.rss = 0;
  job.guildCount = 0;

  const child = spawn(process.execPath, [path.join(BOT_DIR, 'index.js')], {
    cwd: BOT_DIR,
    env: envFor(job, token),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  job.child = child;
  pushLog(job, `spawned pid ${child.pid} on port ${job.port}`);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) pushLog(job, line);
    if (/^\[ready\]/m.test(chunk)) {
      job.status = 'online';
      const guilds = /\[ready\].*?(\d+) guild\(s\)/.exec(chunk);
      if (guilds) job.guildCount = Number(guilds[1]);
      job.backoffMs = 1000;
    }
    const rss = /rss ([\d.]+) MB/.exec(chunk);
    if (rss) job.rss = Math.round(Number(rss[1]) * 1024 * 1024);
    const registered = /(\d+) guild commands registered/.exec(chunk);
    if (registered) job.guildCount = job.guildCount || 0;
  });
  const scanForFatal = (chunk) => {
    // a reset/revoked token (or missing privileged intents) must not restart-loop
    if (/an invalid token was provided|disallowed intents/i.test(String(chunk))) {
      job.fatal = /invalid token/i.test(chunk) ? 'invalid-token' : 'disallowed-intents';
      job.status = job.fatal;
      job.desiredState = 'stopped';
      pushLog(job, `fatal: ${job.fatal} - fix it in the dashboard; not restarting`);
      child.kill('SIGTERM');
    }
  };
  child.stdout.on('data', scanForFatal);
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) pushLog(job, `! ${line}`);
    scanForFatal(chunk);
  });

  child.on('exit', async (code, signal) => {
    job.child = null;
    if (stopping || job.desiredState !== 'running') {
      job.status = 'stopped';
      pushLog(job, `stopped (${signal || `exit ${code}`})`);
      return;
    }
    job.status = 'crashed';
    job.restarts += 1;
    job.backoffMs = Math.min(60_000, (job.backoffMs || 1000) * 2);
    pushLog(job, `crashed (${signal || `exit ${code}`}) - restarting in ${job.backoffMs / 1000}s (restart #${job.restarts})`);
    setTimeout(() => {
      if (!stopping && job.desiredState === 'running' && job.lastToken) start(job, job.lastToken);
    }, job.backoffMs).unref();
  });

  return job;
}

function stop(job, reason) {
  job.desiredState = 'stopped';
  if (job.child) {
    pushLog(job, `stopping: ${reason}`);
    job.child.kill('SIGTERM');
    setTimeout(() => job.child?.kill('SIGKILL'), 8_000).unref();
  }
  job.status = 'stopped';
}

/* -------------------------------------------------------------------------- */
/* Control loop                                                              */
/* -------------------------------------------------------------------------- */

let portCursor = BASE_PORT;

async function reconcile() {
  const data = await claim();

  const wanted = new Map();
  for (const item of data.jobs ?? []) wanted.set(item.botId, item);

  // stop what is no longer wanted
  for (const [botId, job] of jobs) {
    const target = wanted.get(botId);
    if (!target || target.desiredState !== 'running') {
      stop(job, target ? `desired state ${target.desiredState}` : 'removed from dashboard');
      jobs.delete(botId);
    }
  }

  // start / refresh what is wanted
  for (const [botId, item] of wanted) {
    if (item.desiredState !== 'running') continue;
    let job = jobs.get(botId);
    if (!job) {
      job = {
        botId,
        child: null,
        restarts: item.restarts || 0,
        startedAt: 0,
        logs: [],
        status: 'offline',
        rss: 0,
        guildCount: 0,
        backoffMs: 1000,
        desiredState: 'running',
        port: portCursor++,
        lastToken: null,
      };
      jobs.set(botId, job);
      log(`claimed bot ${botId} (${item.username || 'unknown'}) on port ${job.port}`);
    }
    job.desiredState = 'running';

    // token rotated or process missing -> (re)start
    if (job.fatal && job.restarts === 0) { job.fatal = null; job.backoffMs = 1000; }
    if (!job.child && !job.fatal && item.token) void start(job, item.token);
    else if (item.token && item.token !== job.lastToken) {
      pushLog(job, 'token changed on the dashboard - restarting');
      job.child?.kill('SIGTERM');
      setTimeout(() => void start(job, item.token), 3_000).unref();
    }
  }
}

async function main() {
  log(`runner up · dashboard ${DASHBOARD_URL} · bot dir ${BOT_DIR}`);
  log('you can also set HOST_ID, BASE_PORT, POLL_MS, DATABASE_URL, BOT_SECRET');

  const loop = async () => {
    try {
      await reconcile();
    } catch (error) {
      log(`reconcile error: ${error.message}`);
    }
  };

  await loop();
  await heartbeat().catch(() => {});
  setInterval(async () => {
    await loop();
    await heartbeat().catch(() => {});
  }, POLL_MS).unref();
  setInterval(() => void heartbeat().catch(() => {}), HEARTBEAT_MS).unref();

  const shutdown = (signal) => {
    stopping = true;
    log(`${signal} - stopping ${jobs.size} bot(s)`);
    for (const job of jobs.values()) stop(job, signal);
    setTimeout(() => process.exit(0), 9_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log('unhandledRejection', reason));
}

main();
