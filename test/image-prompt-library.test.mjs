import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ImagePromptLibrary,
  normalizeImagePromptAssetPath,
} from '../image-prompt-library.mjs';

const BUILTIN_REVISION = 'a'.repeat(40);
const UPDATED_REVISION = 'b'.repeat(40);

test('downloads a pinned GitHub revision and reloads it from runtime cache', async () => {
  const fixture = await createFixture();
  const requested = [];
  const updatedCases = caseData([{ id: 2, prompt: 'updated prompt' }, { id: 3, prompt: 'second prompt' }]);
  const updatedStyles = styleData([{ id: 'template-2', title: { zh: '新模板' } }], 2);
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.includes('/commits/main')) return jsonResponse({ sha: UPDATED_REVISION });
    if (url.endsWith('/data/cases.json')) return jsonResponse(updatedCases);
    if (url.endsWith('/data/style-library.json')) return jsonResponse(updatedStyles);
    return jsonResponse({}, 404);
  };

  try {
    const library = new ImagePromptLibrary({
      ...fixture,
      builtInRevision: BUILTIN_REVISION,
      fetchImpl,
      autoSync: false,
      now: () => new Date('2026-07-17T05:30:00.000Z'),
    });
    assert.equal(library.getLibrary().sync.source, 'bundled');

    const status = await library.sync({ reason: 'test' });
    assert.equal(status.revision, UPDATED_REVISION);
    assert.equal(status.source, 'github');
    assert.equal(status.status, 'ready');
    assert.equal(status.updatedAt, '2026-07-17T05:30:00.000Z');
    assert.equal(library.getLibrary().totalCases, 2);
    assert.equal(library.getLibrary().totalTemplates, 1);
    assert.equal(library.getLibrary().imageBaseUrl, '/api/image-prompts/assets');
    assert.match(library.getLibrary().imageUpstreamBaseUrl, new RegExp(UPDATED_REVISION));
    assert.ok(requested.some((url) => url.includes(`/${UPDATED_REVISION}/data/cases.json`)));
    assert.ok(requested.some((url) => url.includes(`/${UPDATED_REVISION}/data/style-library.json`)));

    const state = JSON.parse(await readFile(path.join(fixture.cacheDir, 'state.json'), 'utf8'));
    assert.equal(state.revision, UPDATED_REVISION);
    assert.equal(state.reason, 'test');

    const restored = new ImagePromptLibrary({
      ...fixture,
      builtInRevision: BUILTIN_REVISION,
      fetchImpl: async () => {
        throw new Error('cache restore must not access the network');
      },
      autoSync: false,
    });
    assert.equal(restored.getLibrary().sync.source, 'github');
    assert.equal(restored.getLibrary().revision, UPDATED_REVISION);
    assert.equal(restored.getLibrary().cases[0].prompt, 'updated prompt');
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('coalesces identical asset downloads and evicts cached assets by total bytes', async () => {
  const fixture = await createFixture();
  let calls = 0;
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    autoSync: false,
    assetCacheMaxBytes: 5,
    fetchImpl: async (url) => {
      calls += 1;
      if (calls === 1) await first;
      const body = String(url).endsWith('/large.jpg')
        ? [7, 8, 9, 10, 11, 12]
        : String(url).endsWith('/one.jpg') ? [1, 2, 3] : [4, 5, 6];
      return new Response(Uint8Array.from(body), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    },
  });
  try {
    const left = library.fetchAsset('images/one.jpg');
    const right = library.fetchAsset('images/one.jpg');
    releaseFirst();
    const [one, duplicate] = await Promise.all([left, right]);
    assert.deepEqual([...one.body], [1, 2, 3]);
    assert.strictEqual(one, duplicate);
    assert.equal(calls, 1);
    assert.strictEqual(await library.fetchAsset('images/one.jpg'), one);
    assert.equal(calls, 1);
    await library.fetchAsset('images/two.jpg');
    assert.equal(calls, 2);
    await library.fetchAsset('images/one.jpg');
    assert.equal(calls, 3);
    const large = await library.fetchAsset('images/large.jpg');
    assert.deepEqual([...large.body], [7, 8, 9, 10, 11, 12]);
    assert.equal(calls, 4);
    await library.fetchAsset('images/large.jpg');
    assert.equal(calls, 5, 'assets larger than the cache budget remain downloadable but are not retained');
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('asset failures are retryable and cache entries remain isolated by revision and path', async () => {
  const fixture = await createFixture();
  const requested = [];
  let failFirst = true;
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    autoSync: false,
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (failFirst) {
        failFirst = false;
        throw new Error('temporary');
      }
      return new Response(Uint8Array.from([1]), { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
  });
  try {
    await assert.rejects(library.fetchAsset('images/a.png'), /temporary/);
    assert.equal((await library.fetchAsset('images/a.png')).revision, BUILTIN_REVISION);
    await library.fetchAsset('images/b.png');
    library.library = { ...library.library, revision: UPDATED_REVISION };
    assert.equal((await library.fetchAsset('images/a.png')).revision, UPDATED_REVISION);
    assert.equal(requested.length, 4);
    assert.match(requested[1], new RegExp(`${BUILTIN_REVISION}/data/images/a\\.png$`));
    assert.match(requested[2], new RegExp(`${BUILTIN_REVISION}/data/images/b\\.png$`));
    assert.match(requested[3], new RegExp(`${UPDATED_REVISION}/data/images/a\\.png$`));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('keeps the active library when a GitHub update is invalid', async () => {
  const fixture = await createFixture();
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    fetchImpl: async (url) => {
      if (url.includes('/commits/main')) return jsonResponse({ sha: UPDATED_REVISION });
      if (url.endsWith('/data/cases.json')) return jsonResponse(caseData([]));
      return jsonResponse(styleData([]));
    },
    autoSync: false,
    now: () => new Date('2026-07-17T06:00:00.000Z'),
  });

  try {
    await assert.rejects(library.sync({ reason: 'test-invalid' }), /提示词数据为空/);
    const active = library.getLibrary();
    assert.equal(active.revision, BUILTIN_REVISION);
    assert.equal(active.totalCases, 1);
    assert.equal(active.sync.source, 'bundled');
    assert.equal(active.sync.status, 'error');
    assert.match(active.sync.error, /提示词数据为空/);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('checks GitHub without downloading data when the revision is unchanged', async () => {
  const fixture = await createFixture();
  const requested = [];
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse({ sha: BUILTIN_REVISION });
    },
    autoSync: false,
    now: () => new Date('2026-07-17T06:30:00.000Z'),
  });

  try {
    const status = await library.sync({ reason: 'test-current' });
    assert.equal(status.status, 'ready');
    assert.equal(status.source, 'bundled');
    assert.equal(status.checkedAt, '2026-07-17T06:30:00.000Z');
    assert.deepEqual(requested, [
      'https://api.github.com/repos/freestylefly/awesome-gpt-image-2/commits/main',
    ]);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('sends an optional GitHub token only to the API origin', async () => {
  const fixture = await createFixture();
  const requests = [];
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    githubToken: 'test-github-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      if (url.includes('/commits/main')) return jsonResponse({ sha: UPDATED_REVISION });
      if (url.endsWith('/data/cases.json')) return jsonResponse(caseData([{ id: 2, prompt: 'updated' }]));
      return jsonResponse(styleData([{ id: 'template-2' }]));
    },
    autoSync: false,
  });

  try {
    await library.sync({ reason: 'test-token' });
    assert.equal(requests[0].authorization, 'Bearer test-github-token');
    assert.equal(requests[1].authorization, undefined);
    assert.equal(requests[2].authorization, undefined);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('retries an automatic sync after a transient startup failure', async () => {
  const fixture = await createFixture();
  let attempts = 0;
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ENETDOWN' };
        throw error;
      }
      return jsonResponse({ sha: BUILTIN_REVISION });
    },
    autoSync: true,
    intervalMs: 20,
    logger: { warn() {} },
  });

  try {
    library.start();
    await waitFor(() => attempts >= 2 && library.getStatus().status === 'ready');
    assert.ok(attempts >= 2);
    assert.equal(library.getStatus().error, '');
  } finally {
    library.stop();
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('proxies same-origin image assets from the active GitHub revision', async () => {
  const fixture = await createFixture();
  const requested = [];
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    fetchImpl: async (url) => {
      requested.push(url);
      if (String(url).endsWith('/data/images/case1.jpg')) {
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : null;
            },
          },
          async arrayBuffer() {
            return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
          },
        };
      }
      return {
        ok: false,
        status: 404,
        headers: { get() { return null; } },
        async arrayBuffer() {
          return Buffer.alloc(0);
        },
      };
    },
    autoSync: false,
  });

  try {
    assert.equal(normalizeImagePromptAssetPath('../secret.txt'), '');
    assert.equal(normalizeImagePromptAssetPath('images/case1.jpg'), 'images/case1.jpg');
    assert.throws(() => library.resolveAsset('../../etc/passwd'), /无效的提示词图片路径/);

    const asset = await library.fetchAsset('/images/case1.jpg');
    assert.equal(asset.path, 'images/case1.jpg');
    assert.equal(asset.revision, BUILTIN_REVISION);
    assert.equal(asset.contentType, 'image/jpeg');
    assert.equal(asset.cacheControl, 'private, max-age=86400');
    assert.deepEqual([...asset.body], [0xff, 0xd8, 0xff, 0xd9]);
    assert.ok(requested.some((url) => url.includes(`/${BUILTIN_REVISION}/data/images/case1.jpg`)));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

async function createFixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-image-prompts-'));
  const vendorDir = path.join(temporary, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  const casesFile = path.join(vendorDir, 'cases.json');
  const stylesFile = path.join(vendorDir, 'styles.json');
  await writeFile(casesFile, JSON.stringify(caseData([{ id: 1, prompt: 'bundled prompt' }])), 'utf8');
  await writeFile(stylesFile, JSON.stringify(styleData([{ id: 'template-1', title: { zh: '内置模板' } }])), 'utf8');
  return {
    temporary,
    cacheDir: path.join(temporary, 'runtime', 'image-prompts'),
    casesFile,
    stylesFile,
  };
}

function caseData(cases) {
  return {
    repository: 'https://github.com/freestylefly/awesome-gpt-image-2',
    cases,
  };
}

function styleData(templates, version = 1) {
  return {
    version,
    categories: [{ value: 'UI & Interfaces', title: { zh: 'UI 与界面' } }],
    styles: [],
    scenes: [],
    templates,
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
