import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearCodexPluginsCache,
  listCodexPluginsAsync,
  listCodexPluginsUncached,
  listCodexPluginsUncachedAsync,
} from '../plugins-catalog.mjs';

async function addPlugin(home, market, folder, version, data) {
  const dir = path.join(home, '.codex', 'plugins', 'cache', market, folder, version, '.codex-plugin');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(data));
}

test('async plugin catalog preserves synchronous output and isolates caches by home', async () => {
  clearCodexPluginsCache();
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-plugins-async-'));
  const firstHome = path.join(temporary, 'first');
  const secondHome = path.join(temporary, 'second');
  await addPlugin(firstHome, 'market', 'alpha', '1.0.0', { name: 'alpha', description: 'A' });
  await addPlugin(firstHome, 'market', 'alpha', '2.0.0', { name: 'alpha', description: 'latest' });
  await addPlugin(secondHome, 'market', 'beta', '1.0.0', { name: 'beta', description: 'B' });
  const firstCodex = path.join(firstHome, '.codex');
  const expected = listCodexPluginsUncached(firstCodex, firstHome);
  assert.deepEqual(await listCodexPluginsUncachedAsync(firstCodex, firstHome, { concurrency: 2 }), expected);
  const first = await listCodexPluginsAsync(firstCodex, { home: firstHome });
  const second = await listCodexPluginsAsync(path.join(secondHome, '.codex'), { home: secondHome });
  assert.deepEqual(first.map((item) => item.name), ['alpha']);
  assert.deepEqual(second.map((item) => item.name), ['beta']);
});

test('async plugin catalog falls back to the directory name for an invalid manifest', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-plugins-invalid-'));
  const home = temporary;
  const codexHome = path.join(home, '.codex');
  const dir = path.join(codexHome, 'plugins', 'cache', 'market', 'fallback-name', '1.0.0', '.codex-plugin');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), '{invalid');
  const sync = listCodexPluginsUncached(codexHome, home);
  const asyncResult = await listCodexPluginsUncachedAsync(codexHome, home);
  assert.deepEqual(asyncResult, sync);
  assert.equal(asyncResult[0].name, 'fallback-name');
});

test('async plugin cache shares force with an active scan and clear prevents stale writeback', async () => {
  clearCodexPluginsCache();
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-plugins-cache-'));
  const home = temporary;
  const codexHome = path.join(home, '.codex');
  for (let index = 0; index < 30; index += 1) {
    await addPlugin(home, 'market', `plugin-${index}`, '1.0.0', { name: `plugin-${index}` });
  }
  const active = listCodexPluginsAsync(codexHome, { home });
  const forced = listCodexPluginsAsync(codexHome, { home, force: true });
  const [first, joined] = await Promise.all([active, forced]);
  assert.strictEqual(joined, first);

  clearCodexPluginsCache();
  const stale = listCodexPluginsAsync(codexHome, { home, force: true });
  clearCodexPluginsCache();
  await stale;
  await addPlugin(home, 'market', 'added-after-clear', '1.0.0', { name: 'added-after-clear' });
  const refreshed = await listCodexPluginsAsync(codexHome, { home });
  assert.equal(refreshed.some((item) => item.name === 'added-after-clear'), true);
});
