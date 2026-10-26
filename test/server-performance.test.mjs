import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

test('unknown session tokens never rewrite storage; expired sessions are removed once', () => {
  const sessions = new Map([['valid', Date.now() + 60_000], ['expired', 1]]);
  let writes = 0;
  const context = vm.createContext({ sessions, getCookie: (req) => req.token, hashToken: (value) => value, saveSessions: () => { writes++; } });
  vm.runInContext(between('function validateSession(', '\nfunction parseCodexEvent('), context);
  for (let i = 0; i < 200; i++) assert.equal(context.validateSession({ token: `unknown-${i}` }), false);
  assert.equal(writes, 0);
  assert.equal(context.validateSession({ token: 'valid' }), true);
  assert.equal(context.validateSession({ token: 'expired' }), false);
  assert.equal(writes, 1);
  assert.equal(context.validateSession({ token: 'expired' }), false);
  assert.equal(writes, 1);
  assert.equal(sessions.size, 1);
});

function modelContext(request) {
  const context = vm.createContext({
    nativeModelCapabilitiesCache: { models: [], expiresAt: 0 },
    appServerClient: { request }, NATIVE_MODEL_CAPABILITIES_TIMEOUT_MS: 1000,
    NATIVE_MODEL_CAPABILITIES_CACHE_MS: 60_000,
  });
  vm.runInContext(between('async function readNativeModelCapabilities(', '\nfunction readCodexDefaults('), context);
  return context;
}

test('concurrent model reads share one request and provider invalidation isolates old results', async () => {
  const pending = [];
  const context = modelContext(() => new Promise((resolve) => pending.push(resolve)));
  const reads = Array.from({ length: 20 }, () => context.readNativeModelCapabilities());
  assert.equal(pending.length, 1);
  context.nativeModelCapabilitiesCache = { models: [], expiresAt: 0 };
  const current = context.readNativeModelCapabilities();
  assert.equal(pending.length, 2);
  pending[1]({ data: [{ id: 'current', displayName: 'Current' }] });
  await current;
  pending[0]({ data: [{ id: 'old' }] });
  for (const models of await Promise.all(reads)) assert.equal(models[0].id, 'old');
  assert.equal((await context.readNativeModelCapabilities())[0].id, 'current');
  assert.equal(pending.length, 2);
});

test('failed model reads release the shared request for retry', async () => {
  let calls = 0;
  const context = modelContext(async () => {
    if (++calls === 1) throw new Error('offline');
    return { data: [{ id: 'recovered' }] };
  });
  const failed = await Promise.allSettled(Array.from({ length: 20 }, () => context.readNativeModelCapabilities()));
  assert.ok(failed.every((value) => value.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal((await context.readNativeModelCapabilities())[0].id, 'recovered');
  assert.equal(calls, 2);
});

function queueContext(initial, appInitial = {}) {
  let stored = JSON.stringify(initial);
  let appQueues = appInitial;
  let stamp = 1;
  let reads = 0;
  let appReads = 0;
  let writes = 0;
  let failWrites = false;
  const broadcasts = [];
  const context = vm.createContext({
    PROMPT_QUEUE_FILE: '/fixture/queues.json',
    existsSync: () => true,
    readFileSync: () => { reads++; return stored; },
    atomicWriteFile: (_path, value) => { if (failWrites) throw new Error('disk full'); stored = value; writes++; },
    appQueuedFollowUpsFile: () => '/fixture/app-queues.json',
    statSync: () => {
      if (stamp === null) throw new Error('ENOENT');
      return { dev: 1, ino: stamp, mtimeMs: stamp, ctimeMs: stamp, size: 100 };
    },
    loadAppQueuedFollowUps: () => { appReads++; return appQueues; },
    cleanNativeThreadId: (value) => String(value || '').trim(),
    normalizeServerQueuedPrompt: (value) => value,
    mergePromptQueueItemsWithAuthoritativeAppItems: (web, app) => {
      const byId = new Map([...web, ...app].map((item) => [item.id, item]));
      return [...byId.values()];
    },
    broadcastPromptQueueChange: (event) => broadcasts.push(event), scheduleServerPromptQueueDispatch: () => {},
  });
  vm.runInContext(between('function fingerprintPromptQueueItems(', '\nfunction assertPromptQueueExpectedRevision('), context);
  vm.runInContext(between('function promptQueuePauseState(', '\nfunction isPromptQueuePaused('), context);
  return {
    context, stats: () => ({ reads, appReads, writes }),
    broadcasts, failWrites: (value) => { failWrites = value; },
    replace: (value) => { stored = JSON.stringify(value); },
    replaceApp: (value, nextStamp) => { appQueues = value; stamp = nextStamp; },
  };
}

test('queue listing reads one document for all threads and preserves pauses and tombstones', () => {
  const queues = {};
  const app = {};
  for (let index = 0; index < 40; index++) {
    const id = `thread-${index}`;
    queues[id] = { revision: 2, updatedAt: 'saved', items: [{ id: `web-${index}`, source: 'web', message: 'web' }], pause: { reason: 'rate_limit', pausedAt: 'saved', message: 'pause' } };
    app[id] = [{ id: `app-${index}`, source: 'codex-app', message: 'app' }];
  }
  const fixture = queueContext({ queues, dismissed: { 'thread-0': ['id:app-0'] } }, app);
  const result = fixture.context.loadPromptQueues();
  assert.equal(Object.keys(result).length, 40);
  assert.equal(result['thread-0'].items.length, 1);
  assert.equal(result['thread-1'].items.length, 2);
  assert.equal(result['thread-1'].pause.reason, 'rate_limit');
  assert.deepEqual(fixture.stats(), { reads: 1, appReads: 1, writes: 1 });
  const state = fixture.context.getPromptQueueState('thread-1');
  assert.equal(state.revision, 3);
  assert.equal(state.pause.reason, 'rate_limit');
  assert.deepEqual(fixture.stats(), { reads: 2, appReads: 2, writes: 1 });
});

test('queue snapshots are fresh per call and a missing App file only reconciles once', () => {
  const fixture = queueContext({ queues: { thread: { revision: 1, items: [{ id: 'app', source: 'codex-app', message: 'app' }] } } }, { thread: [{ id: 'app', source: 'codex-app', message: 'app' }] });
  fixture.context.loadPromptQueues();
  fixture.replaceApp({}, null);
  assert.equal(fixture.context.getPromptQueueState('thread').items.length, 0);
  const previous = fixture.stats();
  fixture.context.syncAppQueuedFollowUpsIntoWeb();
  fixture.context.syncAppQueuedFollowUpsIntoWeb();
  assert.deepEqual(fixture.stats(), previous);
  fixture.replace({ queues: { thread: { revision: 20, items: [{ id: 'external', source: 'web', message: 'new' }] } } });
  assert.equal(fixture.context.getPromptQueueState('thread').revision, 20);
  assert.equal(fixture.context.getPromptQueueState('thread').items[0].id, 'external');
});

test('failed queue persistence never publishes an uncommitted revision and retries later', () => {
  const fixture = queueContext({ queues: { thread: { revision: 1, updatedAt: 'saved', items: [{ id: 'app', source: 'codex-app', message: 'app' }] } } });
  fixture.failWrites(true);
  const failed = fixture.context.getPromptQueueState('thread');
  assert.equal(failed.revision, 1);
  assert.equal(failed.items[0].id, 'app');
  assert.equal(fixture.broadcasts.length, 0);
  assert.equal(fixture.stats().writes, 0);
  fixture.failWrites(false);
  const saved = fixture.context.getPromptQueueState('thread');
  assert.equal(saved.revision, 2);
  assert.equal(saved.items.length, 0);
  assert.equal(fixture.broadcasts.length, 1);
  assert.equal(fixture.stats().writes, 1);
});
