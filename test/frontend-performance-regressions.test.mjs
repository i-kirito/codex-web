import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const imagePromptSource = await readFile(new URL('../image-prompt.js', import.meta.url), 'utf8');
const playgroundSource = await readFile(
  new URL('../vendor/gpt-image-playground/app/codex-web-integration.js', import.meta.url),
  'utf8',
);

function sourceBetween(source, start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `missing source range ${start}..${end}`);
  return source.slice(startAt, endAt);
}

test('history filtering is frame-coalesced and identical history state skips DOM replacement', () => {
  assert.match(serverSource, /historyFilterFrame=requestAnimationFrame\(\(\)=>\{historyFilterFrame=0;renderHistory\(\)\}\)/);
  const render = sourceBetween(serverSource, 'function renderHistory(items)', 'function createHistoryRow');
  assert.match(render, /const fingerprint=historyRenderStateFingerprint\(query\)/);
  assert.match(render, /if\(fingerprint===historyRenderFingerprint\)\{updateActiveHistory\(\);return\}/);
  assert.match(render, /historyRenderFingerprint=fingerprint/);
});

test('assistant dedupe uses sequence and turn indexes before falling back to a document scan', () => {
  const dedupe = sourceBetween(serverSource, 'function findDuplicateAssistantBubble', 'function nativeSnapshotLiveKey');
  assert.match(dedupe, /nativeAssistantBySequence\.get\(seq\)/);
  assert.match(dedupe, /nativeAssistantsByTurn\.get\(turnId\)/);
  assert.match(dedupe, /else\{\s*candidates=nativeAssistantBubbleElements\(\)/);
  assert.match(serverSource, /if\(role==='assistant'\)indexNativeAssistantBubble\(el\)/);
  assert.match(serverSource, /chat\.replaceChildren\(\);\s*resetNativeAssistantIndex\(\)/);
});

test('assistant turn index preserves prefix-based dedupe without scanning the whole transcript', () => {
  const env = {
    nativeAssistantBySequence: new Map(),
    nativeAssistantsByTurn: new Map(),
    Node: { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 },
    nativeAssistantBubbleElements: () => { throw new Error('unexpected full transcript scan'); },
  };
  vm.createContext(env);
  vm.runInContext(sourceBetween(serverSource, 'function normalizeAssistantDedupeText', 'function findRuntimeLiveForSnapshotMessage'), env);
  vm.runInContext(sourceBetween(serverSource, 'function resetNativeAssistantIndex', 'function nativeSnapshotLiveKey'), env);
  const item = {
    isConnected: true,
    classList: { contains: (name) => name === 'assistant' },
    dataset: { nativeMessageSeq: '7', turnId: 'turn-1', messageText: 'partial answer' },
    textContent: 'partial answer',
  };
  env.indexNativeAssistantBubble(item);
  assert.equal(env.findDuplicateAssistantBubble('partial answer completed', { turnId: 'turn-1' }), item);
  assert.equal(env.findDuplicateAssistantBubble('different', { nativeMessageSeq: 7, turnId: 'turn-1' }), item);
  assert.equal(env.findDuplicateAssistantBubble('different', { nativeMessageSeq: 7, turnId: 'turn-2' }), null);
  const unscoped = {
    isConnected: true,
    classList: item.classList,
    dataset: { nativeMessageSeq: '8', turnId: '', messageText: 'unscoped answer' },
    textContent: 'unscoped answer',
  };
  env.indexNativeAssistantBubble(unscoped);
  assert.equal(env.findDuplicateAssistantBubble('different', { nativeMessageSeq: 8, turnId: 'turn-2' }), unscoped);
  const ordered = (turnId, order) => ({
    isConnected: true,
    classList: item.classList,
    dataset: { turnId, messageText: 'shared answer' },
    textContent: 'shared answer',
    order,
    compareDocumentPosition(other) {
      return other.order > this.order
        ? env.Node.DOCUMENT_POSITION_FOLLOWING
        : env.Node.DOCUMENT_POSITION_PRECEDING;
    },
  });
  const olderUnscoped = ordered('', 1);
  const newerTurn = ordered('turn-3', 2);
  env.resetNativeAssistantIndex();
  env.indexNativeAssistantBubble(olderUnscoped);
  env.indexNativeAssistantBubble(newerTurn);
  assert.equal(
    env.findDuplicateAssistantBubble('shared answer', { turnId: 'turn-3' }),
    newerTurn,
    'dedupe must preserve reverse DOM order across scoped and unscoped candidates',
  );
});

test('new conversations and streamed assistant adoption keep the assistant index current', () => {
  const newChat = sourceBetween(serverSource, 'function newChat()', 'function startNewChatMode');
  assert.match(newChat, /resetTurnProcessCollection\(\);resetNativeAssistantIndex\(\);resumeNativeLiveFollowBottom\(\)/);
  const adoption = sourceBetween(serverSource, 'function adoptRuntimeLiveForSnapshotMessage', 'function nativeAssistantBubbleElements');
  assert.equal((adoption.match(/indexNativeAssistantBubble\(live\.element\)/g) || []).length, 2);
});

test('prompt library keeps stable nodes, appends pages, filters, and refreshes revised items', () => {
  class FakeClassList {
    values = new Set();
    add(...names) { for (const name of names) this.values.add(name); }
    toggle(name, force) {
      if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
      else this.values.delete(name);
    }
    contains(name) { return this.values.has(name); }
  }
  class FakeNode {
    constructor(fragment = false) {
      this.fragment = fragment;
      this.children = [];
      this.parentNode = null;
      this.classList = new FakeClassList();
      this.textContent = '';
    }
    appendChild(child) {
      if (child.fragment) {
        for (const nested of [...child.children]) this.appendChild(nested);
        return child;
      }
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      for (const child of children) this.appendChild(child);
    }
  }
  const document = { createDocumentFragment: () => new FakeNode(true) };
  const grid = new FakeNode();
  const elements = {
    grid,
    loading: new FakeNode(),
    empty: new FakeNode(),
    resultCount: new FakeNode(),
    loadMore: new FakeNode(),
  };
  let created = 0;
  const createPromptCard = (item) => {
    created += 1;
    const node = new FakeNode();
    node.item = item;
    node.activate = () => item.title;
    node._favoriteButton = new FakeNode();
    return node;
  };
  const renderSource = sourceBetween(imagePromptSource, '  function filteredItems()', '  function createPromptCard');
  const harness = new Function('document', 'elements', 'createPromptCard', `
    const searchTextCache = new WeakMap();
    const promptCardCache = new Map();
    let renderedPromptKeys = [];
    let renderedPromptNodes = [];
    const state = { library: null, mode: 'cases', query: '', category: '', favoritesOnly: false, visible: 24, favorites: new Set() };
    const itemTitle = (item) => item.title;
    const itemDescription = (item) => item.description || item.prompt || '';
    const itemKey = (type, item) => type + ':' + item.id;
    const refreshPromptIcons = () => {};
    ${renderSource}
    return { state, renderLibrary, prunePromptCardCache, cacheHas: (key) => promptCardCache.has(key) };
  `)(document, elements, createPromptCard);
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    title: `Item ${index + 1}`,
    description: `Description ${index + 1}`,
    category: index % 2 ? 'odd' : 'even',
  }));
  harness.state.library = { cases: items, templates: [] };
  harness.prunePromptCardCache(harness.state.library);
  harness.renderLibrary();
  const firstPage = [...grid.children];
  assert.equal(grid.children.length, 24);
  assert.equal(created, 24);

  harness.renderLibrary();
  assert.deepEqual(grid.children, firstPage, 'an identical render must not detach stable cards');
  assert.equal(created, 24);
  harness.state.favorites.add('case:1');
  harness.renderLibrary();
  assert.equal(grid.children[0]._favoriteButton.classList.contains('active'), true);
  assert.deepEqual(grid.children, firstPage, 'favorite refresh must preserve the grid');

  harness.state.visible = 48;
  harness.renderLibrary();
  assert.equal(grid.children.length, 30);
  assert.deepEqual(grid.children.slice(0, 24), firstPage);
  assert.equal(created, 30, 'load more creates only newly visible cards');

  harness.state.query = 'Item 2';
  harness.renderLibrary();
  assert.ok(grid.children.length > 0 && grid.children.length < 30);
  assert.ok(grid.children.every((node) => node.item.title.includes('Item 2')));
  harness.state.query = '';
  harness.renderLibrary();
  assert.equal(grid.children.length, 30);
  assert.equal(created, 30, 'filtering reuses cached card nodes');

  const revised = { ...items[0], title: 'Item 1 revised' };
  harness.state.library = { cases: [revised, ...items.slice(1)], templates: [] };
  harness.prunePromptCardCache(harness.state.library);
  harness.renderLibrary();
  assert.notEqual(grid.children[0], firstPage[0]);
  assert.equal(grid.children[0].activate(), 'Item 1 revised', 'callbacks must close over the current library item');
  harness.state.library = { cases: [revised, ...items.slice(1, -1)], templates: [] };
  harness.prunePromptCardCache(harness.state.library);
  harness.renderLibrary();
  assert.equal(harness.cacheHas('case:30'), false, 'removed library keys must not leak across revisions');
});

test('playground toolbar repair is mutation-driven and pauses while hidden', () => {
  assert.doesNotMatch(playgroundSource, /setInterval\(scheduleEnsureButtons/);
  assert.match(playgroundSource, /new MutationObserver/);
  assert.match(playgroundSource, /if \(record\.target\?\.closest\?\.\('header'\)\) return true/);
  assert.match(playgroundSource, /if \(!document\.hidden\) scheduleEnsureButtons\(\)/);
});

test('playground toolbar observer ignores hidden mutations and repairs again after resume', async () => {
  const frames = [];
  const listeners = new Map();
  let observerCallback = null;
  const document = {
    readyState: 'complete',
    hidden: true,
    body: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  const env = {
    document,
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    fetch: async () => ({ ok: true, json: async () => ({ enabled: true, status: 'idle' }) }),
    window: { setTimeout, clearTimeout, location: { reload() {} } },
  };
  vm.createContext(env);
  vm.runInContext(playgroundSource, env);
  const headerMutation = [{ target: { closest: () => ({}) }, addedNodes: [], removedNodes: [] }];
  observerCallback(headerMutation);
  assert.equal(frames.length, 0);
  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(frames.length, 1);
  frames.shift()();
  observerCallback(headerMutation);
  assert.equal(frames.length, 1);
});
