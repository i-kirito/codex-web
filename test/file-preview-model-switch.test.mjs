import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0);
  const last = source.indexOf(end, offset + start.length);
  assert.ok(last > offset);
  return source.slice(offset, last);
}
function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    type(value) { this.headers['Content-Type'] = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    sendFile(file) { this.body = readFileSync(file, 'utf8'); return this; },
  };
}

test('HTML file links render an interactive document in an isolated origin; other files stay escaped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'web-file-preview-'));
  try {
    const html = path.join(dir, 'index.html');
    const text = path.join(dir, 'example.md');
    const document = '<!doctype html><button>Pause</button><script>window.example=1</script>';
    writeFileSync(html, document);
    writeFileSync(text, '<script>alert(1)</script>');
    const context = vm.createContext({
      path, realpathSync, statSync, readFileSync,
      LOCAL_FILE_ROOTS: [dir], LOCAL_FILE_MAX_BYTES: 1024,
      escapeHtml: (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      setLocalImageSecurityHeaders: (res, type) => {
        if (type === 'image/svg+xml') {
          res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
        }
      },
    });
    vm.runInContext(between('function isPathWithinRoot(', '\nfunction decorateNativeConversation('), context);
    const res = response();
    context.sendAllowedLocalFile(res, html, { html: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, document);
    const policy = res.headers['Content-Security-Policy'];
    assert.match(policy, /sandbox allow-scripts;/);
    assert.doesNotMatch(policy, /allow-same-origin|allow-forms|allow-top-navigation/);
    assert.match(policy, /connect-src 'none'/);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    const escaped = response();
    context.sendAllowedLocalFile(escaped, text, { html: true });
    assert.match(escaped.body, /&lt;script&gt;/);
    assert.equal(escaped.headers['Content-Security-Policy'], "default-src 'none'");
    const png = path.join(dir, 'preview.png');
    writeFileSync(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const image = response();
    context.sendAllowedLocalFile(image, png, { html: true });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['Content-Type'], 'image/png');
    assert.equal(image.headers['Content-Security-Policy'], "default-src 'none'");
    assert.equal(image.headers['X-Content-Type-Options'], 'nosniff');
    const sibling = path.join(dir, 'sibling.html');
    writeFileSync(sibling, document);
    context.LOCAL_FILE_ROOTS = [html];
    const denied = response();
    context.sendAllowedLocalFile(denied, sibling, { html: true });
    assert.equal(denied.statusCode, 404, 'authorizing one file must not authorize its directory');
    const link = path.join(dir, 'escape.html');
    symlinkSync(new URL('../server.mjs', import.meta.url).pathname, link);
    context.LOCAL_FILE_ROOTS = [dir];
    assert.equal(context.resolveAllowedLocalFile(link), '', 'symlinks cannot escape allowed roots');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function settingsHarness(defaultProvider = '') {
  const calls = [];
  let handler;
  const context = vm.createContext({
    app: { patch(_path, _auth, fn) { handler = fn; } }, requireAuth() {},
    cleanNativeThreadId: (value) => value, cleanProviderName: (value) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : '',
    readCodexDefaults: () => ({ provider: defaultProvider }), DEFAULT_PROVIDER: '',
    readProviders: () => ['custom'], cleanThreadSettingsModel: (value) => value,
    CODEX_EXISTING_THREAD_APP_SERVER_FALLBACK: true, parseBoolean: (value, fallback) => value ?? fallback,
    nativeSessions: { get: () => ({ metadata: {} }), applyThreadSettings: (value) => calls.push(['persist', value]), scheduleRefresh() {} },
    activeNativeTurns: new Map(),
    nativeThreadProviderChanges: new Set(), nativeTurnReservations: new Set(),
    nativeActiveTurnFor: () => null, appServerThreadIsBusy: () => false,
    releaseAppServerThreadForProviderChange: async () => {},
    scheduleAppServerWriterIdleStop() {},
    requestLoadedAppServerThread: async (method, params) => { calls.push([method, params]); return {}; },
    requestThreadAppServer: async (method, params) => { calls.push([method, params]); return {}; },
    releaseAppServerThreadAfterTurn: async () => calls.push(['release']),
    nativeAppErrorStatus: () => 500, isNativeActiveWriterConflict: () => false,
  });
  vm.runInContext(between("app.patch('/api/native-sessions/:id',", "\napp.patch('/api/native-sessions/:id/goal'"), context);
  return { calls, handler };
}

test('model-only changes reach settings/update and persist without a provider switch', async () => {
  const { calls, handler } = settingsHarness();
  const res = response();
  await handler({ params: { id: 'thread' }, body: { model: 'gpt-6-sol' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.model, 'gpt-6-sol');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['thread/resume', { threadId: 'thread' }]);
  assert.equal(calls[1][0], 'thread/settings/update');
  assert.equal(calls[1][1].model, 'gpt-6-sol');
  assert.equal(calls[2][1].model, 'gpt-6-sol');
  assert.equal(calls.at(-1)[0], 'release');
});

test('selecting the default provider resolves the configured provider or the built-in OpenAI provider', async () => {
  for (const [configured, expected] of [['', 'openai'], ['custom', 'custom']]) {
    const { calls, handler } = settingsHarness(configured);
    const res = response();
    await handler({ params: { id: 'thread' }, body: { provider: null, model: 'gpt-6-sol' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.provider, expected);
    assert.equal(calls[0][1].modelProvider, expected);
  }
});

test('model-only composer writes omit provider and preserve the requested model', async () => {
  let request;
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'thread', nativeComposerSettingsWriteId: 0,
    nativeComposerSettingsError: null,
    nativeComposerSettingsQueue: Promise.resolve(), nativeComposerSettingsWrites: new Map(),
    nativeComposerOverride: null, nativeComposerOverrides: new Map(), nativeComposerSettingsRevisions: new Map(),
    rememberNativeComposerOverride({ writeId }) { const value = { threadId: 'thread', writeId, pending: true }; context.nativeComposerOverride = value; context.nativeComposerOverrides.set('thread', value); },
    nativeComposerOverrideFor(id) { return context.nativeComposerOverrides.get(id) || null; },
    clearNativeComposerOverride(id) { context.nativeComposerOverrides.delete(id); context.nativeComposerOverride = null; },
    bumpNativeComposerSettingsRevision() {},
    syncComposerChrome() {}, syncCurrentNativeConversation() {},
    fetch: async (url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; },
  });
  vm.runInContext(between('function syncNativeComposerSettings(', '\nfunction newChat('), context);
  assert.equal(await context.syncNativeComposerSettings({ model: 'gpt-6-astra' }), true);
  assert.deepEqual(request, { model: 'gpt-6-astra' });
});

test('the default model catalog uses the signed-in Codex catalog without demanding an API URL or key', async () => {
  let handler;
  const context = vm.createContext({
    app: { post(_path, _auth, fn) { handler = fn; } }, requireAuth() {},
    cleanProviderName: () => '',
    readNativeModelCapabilities: async () => [
      { id: 'gpt-6-sol', model: 'gpt-6-sol' }, { id: 'gpt-6-astra' },
    ],
  });
  vm.runInContext(between("app.post('/api/models',", "\napp.post('/api/providers'"), context);
  const res = response();
  await handler({ body: { provider: '' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body.models), ['gpt-6-sol', 'gpt-6-astra']);
});

test('refreshing an OpenAI task restores its model even when the provider picker uses the default alias', async () => {
  const selected = [];
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'thread', nativeComposerOverrideFor: () => null,
    currentNativeWorkspaceKind: '', forceFullAccess: true,
    provider: { options: [{ value: '' }, { value: 'custom' }], value: 'custom' },
    modelOptionsProvider: '', modelLoadInFlight: null, modelLoadRevision: 1,
    defaultComposerServiceTier: null, composerPermissionMode: '', sandbox: {}, approval: {},
    selectComposerModel: (value) => selected.push(value),
    normalizeComposerServiceTier: (value) => value, reconcileComposerFastSupport() {}, updateSafetyHint() {},
  });
  vm.runInContext(between('async function applyNativeConversationMetadata(', '\nasync function rollbackConversation('), context);
  await context.applyNativeConversationMetadata({ modelProvider: 'openai', model: 'gpt-6-astra' });
  assert.equal(context.provider.value, '');
  assert.deepEqual(selected, ['gpt-6-astra']);
});

test('a confirmed composer write protects stale snapshots until matching metadata acknowledges it', async () => {
  let release;
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'thread', nativeComposerSettingsWriteId: 0,
    nativeComposerSettingsError: null, nativeComposerSettingsQueue: Promise.resolve(), nativeComposerSettingsWrites: new Map(),
    nativeComposerOverride: null, nativeComposerOverrides: new Map(), nativeComposerSettingsRevisions: new Map(),
    provider: { value: 'openai', options: [{ value: 'openai' }] }, model: { value: 'new-model', options: [{ value: 'new-model' }] },
    reasoningEffort: { value: 'high' }, composerServiceTier: null, composerPermissionMode: 'legacy', sandbox: { value: '' }, approval: { value: '' },
    normalizeComposerServiceTier: value => value, syncComposerChrome() {}, syncCurrentNativeConversation() {}, statusEl: { textContent: '' },
    fetch: () => new Promise(resolve => { release = resolve; }),
  });
  vm.runInContext(between('function nativeComposerOverrideFor(', '\nfunction newChat('), context);
  const oldRequestRevision = context.nativeComposerSettingsRevision('thread');
  const write = context.syncNativeComposerSettings({ model: 'new-model' });
  const pendingRequestRevision = context.nativeComposerSettingsRevision('thread');
  assert.equal(context.nativeComposerOverrideApplies('thread', { modelProvider: 'openai', model: 'old-model' }), true);
  await new Promise(resolve => setImmediate(resolve));
  release({ ok: true, json: async () => ({ model: 'new-model' }) });
  assert.equal(await write, true);
  assert.equal(context.nativeComposerOverrideApplies('thread', { modelProvider: 'openai', model: 'old-model' }), true);
  assert.equal(context.nativeComposerOverrideApplies('thread', { modelProvider: 'openai', model: 'new-model' }), false);
  assert.equal(context.nativeComposerOverrides.has('thread'), false);
  assert.equal(context.nativeComposerSnapshotIsStale('thread', oldRequestRevision), true);
  assert.equal(context.nativeComposerSnapshotIsStale('thread', pendingRequestRevision), true);
});

test('rapid and cross-conversation model writes retain the latest expected value per thread', async () => {
  const releases = [];
  const requests = [];
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'alpha', nativeComposerSettingsWriteId: 0,
    nativeComposerSettingsError: null, nativeComposerSettingsQueue: Promise.resolve(), nativeComposerSettingsWrites: new Map(),
    nativeComposerOverride: null, nativeComposerOverrides: new Map(), nativeComposerSettingsRevisions: new Map(),
    provider: { value: 'openai', options: [{ value: 'openai' }] }, model: { value: 'one', options: [{ value: 'one' }, { value: 'two' }] },
    reasoningEffort: { value: '' }, composerServiceTier: null, composerPermissionMode: 'legacy', sandbox: { value: '' }, approval: { value: '' },
    normalizeComposerServiceTier: value => value, syncComposerChrome() {}, syncCurrentNativeConversation() {}, statusEl: { textContent: '' },
    fetch: (_url, options) => { requests.push(JSON.parse(options.body)); return new Promise(resolve => releases.push(resolve)); },
  });
  vm.runInContext(between('function nativeComposerOverrideFor(', '\nfunction newChat('), context);
  const first = context.syncNativeComposerSettings({ model: 'one' });
  context.model.value = 'two';
  const second = context.syncNativeComposerSettings({ model: 'two' });
  context.currentConversationId = 'beta';
  context.activateNativeComposerOverride('beta');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [{ model: 'one' }]);
  releases.shift()({ ok: true, json: async () => ({ model: 'one' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [{ model: 'one' }, { model: 'two' }]);
  releases.shift()({ ok: true, json: async () => ({ model: 'two' }) });
  assert.equal(await first, true);
  assert.equal(await second, true);
  context.currentConversationId = 'alpha';
  context.activateNativeComposerOverride('alpha');
  assert.equal(context.nativeComposerOverrideFor('alpha').expected.model, 'two');
  assert.equal(context.nativeComposerOverrideApplies('alpha', { model: 'one' }), true);
  assert.equal(context.nativeComposerOverrideApplies('alpha', { model: 'two' }), false);
});

test('metadata loading cannot restore an old model after a newer selection starts', async () => {
  let releaseModels;
  const selected = [];
  const overrides = new Map();
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'thread', nativeComposerOverrides: overrides, nativeComposerOverrideFor: id => overrides.get(id) || null,
    currentNativeWorkspaceKind: '', forceFullAccess: false, provider: { options: [{ value: 'openai' }], value: 'openai' },
    modelOptionsProvider: 'other', modelLoadInFlight: null, modelLoadRevision: 1, defaultComposerServiceTier: null,
    composerPermissionMode: 'legacy', sandbox: { value: '' }, approval: { value: '' }, reasoningEffort: { value: '' },
    isAutoApprovalsReviewer: () => false, composerPermissionModeFromValues: () => 'legacy',
    loadModels: () => new Promise(resolve => { releaseModels = resolve; }), selectComposerModel: value => selected.push(value),
    normalizeComposerServiceTier: value => value, reconcileComposerFastSupport() {}, updateSafetyHint() {},
  });
  vm.runInContext(between('async function applyNativeConversationMetadata(', '\nasync function rollbackConversation('), context);
  const applying = context.applyNativeConversationMetadata({ modelProvider: 'openai', model: 'old-model' }, { threadId: 'thread' });
  await new Promise(resolve => setImmediate(resolve));
  overrides.set('thread', { threadId: 'thread', writeId: 1, pending: true });
  releaseModels(true);
  assert.equal(await applying, false);
  assert.deepEqual(selected, []);
});

test('returning to a conversation restores its pending model fields instead of retaining the other conversation UI', async () => {
  const selected = [];
  const overrides = new Map([['alpha', {
    threadId: 'alpha', provider: 'openai', model: 'alpha-new', reasoningEffort: 'high', serviceTier: 'fast',
    permissionMode: 'auto', sandbox: 'workspace-write', approval: 'on-request', pending: true,
  }]]);
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'alpha', nativeComposerOverrideFor: id => overrides.get(id) || null,
    currentNativeWorkspaceKind: '', forceFullAccess: false, provider: { options: [{ value: 'openai' }], value: 'other' },
    modelOptionsProvider: 'openai', modelLoadInFlight: null, modelLoadRevision: 1, defaultComposerServiceTier: null,
    composerServiceTier: null, composerPermissionMode: 'legacy', sandbox: { value: 'read-only' }, approval: { value: 'never' }, reasoningEffort: { value: '' },
    selectComposerModel: value => selected.push(value), loadModels: async () => true,
    isAutoApprovalsReviewer: () => false, composerPermissionModeFromValues: () => 'legacy',
    normalizeComposerServiceTier: value => value, reconcileComposerFastSupport() {}, updateSafetyHint() {},
  });
  vm.runInContext(between('async function applyNativeConversationMetadata(', '\nasync function rollbackConversation('), context);
  assert.equal(await context.applyNativeConversationMetadata(
    { modelProvider: 'openai', model: 'alpha-old', reasoningEffort: 'low' },
    { threadId: 'alpha', preserveProviderModel: true },
  ), true);
  assert.equal(context.provider.value, 'openai');
  assert.deepEqual(selected, ['alpha-new']);
  assert.equal(context.reasoningEffort.value, 'high');
  assert.equal(context.composerPermissionMode, 'auto');
});

test('a real loadModels request invalidated by a newer model selection cannot be rejoined by the next metadata load', async () => {
  const releases = [];
  const applied = [];
  const context = vm.createContext({
    modelLoadInFlight: null, modelLoadRevision: 0, composerModelLoadPromise: Promise.resolve(true),
    modelListCache: new Map(), modelLoadWarnings: new Map(), modelOptionsProvider: '',
    provider: { value: 'openai' }, model: { innerHTML: '', value: '' }, statusEl: { textContent: '' },
    requestModels: () => new Promise(resolve => { releases.push(resolve); }),
    uniqueComposerModelItems: items => [...new Set(items)], providerModelFallbackMessage: value => value,
    applyComposerModels: (_provider, _items, selected) => applied.push(selected), syncComposerChrome() {}, selectComposerModel: value => applied.push(value),
  });
  vm.runInContext(between('function loadModels(', '\nasync function changeComposerProvider('), context);
  vm.runInContext(between('async function waitForLatestComposerModelLoad(', '\nasync function waitForLatestNativeComposerSettings('), context);
  const loading = context.loadModels('openai', 'old-model');
  context.modelLoadRevision += 1;
  context.modelLoadInFlight = null;
  context.composerModelLoadPromise = Promise.resolve(true);
  context.model.value = 'new-model';
  const reloading = context.loadModels('openai', 'new-model');
  const ready = context.waitForLatestComposerModelLoad();
  releases[0]({ models: ['old-model', 'new-model'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(context.modelLoadInFlight, 'the stale request finally must not clear the replacement request');
  releases[1]({ models: ['old-model', 'new-model'] });
  assert.equal(await reloading, true);
  assert.equal(await loading, true);
  assert.equal(await ready, true);
  assert.deepEqual(applied, ['new-model']);
  assert.equal(context.model.value, 'new-model');
});

test('a failed settings write stops send before clearing the draft', async () => {
  let fetchCalls = 0;
  const input = { value: 'keep this draft', style: {}, focus() {} };
  const context = vm.createContext({
    closeComposerPopovers() {}, input, pendingAttachments: [], canResumeInterruptedNativeTask: () => false,
    sendBtn: { disabled: false }, appQueueEditDraft: null, conversationLoadSeq: 3, currentConversationId: 'thread', currentConversationSource: 'codex',
    waitForLatestComposerProviderChange: async () => true, waitForLatestComposerModelLoad: async () => true,
    waitForLatestNativeComposerSettings: async () => false, nativeComposerSettingsError: { message: 'settings failed' },
    statusEl: { textContent: '' }, fetch: async () => { fetchCalls += 1; throw new Error('must not send'); },
  });
  vm.runInContext(between('async function send(){', '\n</script>'), context);
  await context.send();
  assert.equal(fetchCalls, 0);
  assert.equal(input.value, 'keep this draft');
  assert.equal(context.statusEl.textContent, 'settings failed');
});
