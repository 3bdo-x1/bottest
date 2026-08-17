'use strict';

/**
 * Offline smoke test - no Discord connection required, but Postgres must be
 * reachable (the bot and dashboard share that database).
 *
 *   cd bot && npm test
 */

process.env.BOT_SECRET = process.env.BOT_SECRET || 'smoke-test';
const assert = require('node:assert');

const G = String(process.env.SMOKE_GUILD_ID || '900' + String(Date.now()).slice(-12));
const U = '111111111111111111';
const U2 = '222222222222222222';

const store = require('../src/db');
const handler = require('../src/commands');
const { matchBadWord, normalise, sweepTrackers, trackerSize } = require('../src/automod');
const welcome = require('../src/welcome');
const features = require('../src/features');
const { parseDuration, formatDuration, memoryUsage } = require('../src/util');

let passed = 0;
const check = (label, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${label}`);
    });
};

(async () => {
  console.log('— command registry');
  await check('commands registered (built-ins + new modules)', () => {
    handler.load();
    assert.ok(handler.registry.size >= 40, `got ${handler.registry.size}`);
  });
  await check('new unique commands exist', () => {
    for (const name of ['vibecheck', 'ship', 'wheel', 'randomperson', 'meme', 'rank', 'leaderboard', 'remind', 'timecapsule', 'afk', 'snipe', 'confess', 'suggest', 'counting', 'mediaonly', 'adminchannel', 'botchannel', 'automemes', 'starboard', 'levels']) {
      assert.ok(handler.registry.has(name), `missing ${name}`);
    }
  });
  await check('slash payload is JSON-serialisable', () => {
    const json = handler.buildSlashJson();
    const text = JSON.stringify(json, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    assert.ok(!text.includes('undefined'));
    assert.ok(json.length >= 40);
  });
  await check('prefix parser', () => {
    assert.deepStrictEqual(handler.parseInvocation('!kick @a b', ['!']), { name: 'kick', args: ['@a', 'b'] });
    assert.strictEqual(handler.parseInvocation('plain text', ['!']), null);
  });

  console.log('— postgres data layer');
  await check('loadAll()', async () => {
    const loaded = await store.loadAll();
    assert.ok(typeof loaded.guilds === 'number');
  });
  await check('settings write-through', () => {
    const cfg = store.settings.ensure(G);
    assert.strictEqual(cfg.prefix, '!');
    const next = store.settings.update(G, { prefix: '?', spamCount: 8, welcomeEnabled: 1, welcomeMessage: 'Yo {user}', logDeleted: 0 });
    assert.strictEqual(next.prefix, '?');
    assert.strictEqual(next.spamCount, 8);
    assert.strictEqual(next.welcomeEnabled, 1);
    assert.strictEqual(store.settings.get(G).logDeleted, 0);
  });
  await check('bad words', () => {
    assert.ok(store.badWords.add(G, 'badword'));
    assert.ok(!store.badWords.add(G, 'badword'));
    assert.ok(store.badWords.words(G).includes('badword'));
    assert.ok(store.badWords.remove(G, 'badword'));
  });
  await check('feature channels', () => {
    store.features.set(G, 'media', '333333333333333333', { allowLinks: true });
    store.features.set(G, 'counting', '444444444444444444', { resetOnFail: true, blockSameUser: true });
    assert.ok(features.commandChannelAllowed(G, 'any') === true);
    store.features.set(G, 'botcmd', '555555555555555555', {});
    assert.strictEqual(features.commandChannelAllowed(G, '555555555555555555'), true);
    assert.strictEqual(features.commandChannelAllowed(G, '999999999999999999'), false);
    assert.deepStrictEqual(store.features.ids(G, 'counting'), ['444444444444444444']);
    const removed = store.features.remove(G, 'botcmd', '555555555555555555');
    assert.strictEqual(removed, 1);
    assert.strictEqual(features.commandChannelAllowed(G, '999999999999999999'), true);
  });
  await check('counting state + scores', () => {
    const state = store.counting.get(G);
    store.counting.set(G, { ...state, channelId: '444444444444444444', current: 41, lastUserId: U, best: 41, bestUserId: U });
    store.counting.bumpScore(G, U, { score: 1, best: 41 });
    store.counting.bumpScore(G, U2, { fails: 1 });
    const board = store.counting.leaderboard(G, 5);
    assert.ok(board[0].userId === U && board[0].score >= 1);
    assert.strictEqual(store.counting.get(G).current, 41);
  });
  await check('xp + levels', () => {
    let result = null;
    for (let i = 0; i < 30; i++) result = store.xp.add(G, U, 60);
    assert.ok(result.points >= 1800);
    assert.ok(result.level >= 1);
    assert.ok(store.xp.leaderboard(G, 5)[0].userId === U);
  });
  await check('warnings + mod logs', () => {
    store.warnings.add(G, U, U2, 'spam');
    assert.strictEqual(store.warnings.count(G, U), 1);
    store.modLogs.add(G, 'warn', U, U2, 'test', null);
    assert.ok(store.modLogs.recent(G, 5).length >= 1);
    assert.ok(store.modLogs.total() >= 1);
  });
  await check('reminders + suggestions (async repos)', async () => {
    const row = await store.asyncRepo.addReminder({ guildId: G, channelId: '1', userId: U, content: 'ping', dueAt: Date.now() - 1000, kind: 'reminder' });
    assert.ok(row.id);
    const due = await store.asyncRepo.reminders(Date.now());
    assert.ok(due.some((r) => r.id === row.id));
    await store.asyncRepo.completeReminder(row.id);
    const after = await store.asyncRepo.reminders(Date.now());
    assert.ok(!after.some((r) => r.id === row.id));
    const suggestion = await store.asyncRepo.addSuggestion(G, U, 'add movie night', 'message-id');
    await store.asyncRepo.setSuggestionStatus(suggestion.id, 'approved');
    const approved = await store.asyncRepo.suggestions(G, 'approved');
    assert.ok(approved.some((s) => s.id === suggestion.id));
  });
  await check('afk', () => {
    store.afk.set(G, U, 'studying');
    assert.strictEqual(store.afk.get(G, U).note, 'studying');
    assert.ok(store.afk.clear(G, U));
  });
  await check('quotes + snipe', () => {
    store.quotes.add(G, U, 'that was intentional', U2);
    assert.ok(store.quotes.random(G));
    store.deletedMessages.add(G, '444444444444444444', U, 'deleted text');
    assert.strictEqual(store.deletedMessages.last(G, '444444444444444444').content, 'deleted text');
  });

  console.log('— auto-mod + welcome');
  await check('normalisation defeats evasion', () => {
    assert.strictEqual(normalise('H3LL0'), 'helo');
    assert.strictEqual(normalise('heeeello'), 'helo');
  });
  await check('word matcher honours boundaries', () => {
    store.badWords.add(G, 'darn');
    assert.ok(matchBadWord(G, 'well D4RN it'));
    assert.ok(matchBadWord(G, 'd  a  r  n'));
    assert.ok(!matchBadWord(G, 'the darnel plant'));
    assert.strictEqual(matchBadWord(G, ''), null);
  });
  await check('spam tracker sweep', () => {
    sweepTrackers();
    assert.strictEqual(trackerSize(), 0);
  });
  await check('welcome placeholders', () => {
    const out = welcome.preview('Hi {user} @ {server} #{count}', 'Arena', 12);
    for (const [token] of welcome.PLACEHOLDERS) {
      if (token === '{username}' || token === '{tag}') continue;
      assert.ok(!out.includes(token), `unreplaced ${token}`);
    }
    assert.ok(out.includes('@ Arena #12'));
  });

  console.log('— api layer');
  await check('applySettings validates + persists', async () => {
    const api = require('../src/api');
    const view = api.applySettings(G, {
      welcome: { enabled: true, channelId: '333333333333333333', message: 'Welcome {user}!', embed: true, autoDelete: 30 },
      logs: { auditChannelId: '333333333333333333', deleted: true, roles: false },
      automod: { wordsEnabled: true, action: 'warn', badWords: ['heck', 'spam*'], mentionLimit: 4 },
    });
    assert.strictEqual(view.settings.welcome.channelId, '333333333333333333');
    assert.strictEqual(view.settings.logs.roles, false);
    assert.strictEqual(view.settings.automod.action, 'warn');
    assert.deepStrictEqual(view.settings.badWords, ['heck', 'spam*']);
    assert.strictEqual(store.settings.get(G).logRoles, 0);
  });
  await check('applyFeature rejects unknown types', async () => {
    const api = require('../src/api');
    assert.throws(() => api.applyFeature(G, { type: 'nope', channelId: '1' }), /unknown feature/);
    const result = api.applyFeature(G, { type: 'memes', channelId: '333333333333333333', config: { intervalMinutes: 30, subreddits: ['memes'] } });
    assert.ok(result.guild.features.some((f) => f.type === 'memes'));
  });

  console.log('— durations & memory');
  await check('duration parsing', () => {
    assert.strictEqual(parseDuration('30s'), 30_000);
    assert.strictEqual(parseDuration('1h30m'), 5_400_000);
    assert.strictEqual(parseDuration('nope'), null);
    assert.strictEqual(formatDuration(5_400_000), '1h 30m');
  });
  await check('memory telemetry', () => {
    const mem = memoryUsage();
    assert.ok(mem.rss > 0);
  });

  await store.maintainance();
  await store.db.close();
  console.log(`\nAll ${passed} checks passed. rss=${memoryUsage().rssText}`);
  process.exit(0);
})().catch(async (error) => {
  console.error('\nSMOKE TEST FAILED:', error);
  await store.db.close().catch(() => {});
  process.exit(1);
});
