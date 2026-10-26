import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPageAssets } from '../page-assets.mjs';

test('static extraction preserves exact script bytes, load order, and theme bootstrap', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-page-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const css = path.join(dir, 'ui.css');
  writeFileSync(css, 'body { color: red; }');
  const assets = createPageAssets([{ route: '/ui.css', path: css, contentType: 'text/css' }]);
  const script = `const text = ${JSON.stringify('x'.repeat(70_000))};\nboot(true);`;
  const original = `<link href="/ui.css?v=old"><script>theme();</script><script src="/vendor.js"></script><script>${script}</script><script src="/effects.js"></script>`;
  const result = assets.render(original);
  const mainUrl = result.match(/src="([^" ]+\/app\.js)"/)[1];
  const cssUrl = result.match(/href="([^"]+)"/)[1];
  assert.equal(assets.get(mainUrl).body, script);
  assert.equal(assets.get(cssUrl).body.toString(), 'body { color: red; }');
  assert.equal(result.replace(`<script src="${mainUrl}"></script>`, `<script>${script}</script>`).replace(cssUrl, '/ui.css?v=old'), original);
  assert.equal(assets.render(original), result);
  const changed = assets.render(original.replace('boot(true)', 'boot(false)'));
  assert.notEqual(changed, result);
  assert.equal(assets.get(mainUrl).body, script, 'another auth/theme variant must not invalidate existing URLs');
  assert.equal(assets.get('/assets/not-a-valid-hash/app.js'), undefined);
  assert.equal(assets.get('/assets/../../secret'), undefined);
});
