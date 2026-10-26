import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'os';
import path from 'path';

const MAX_DESCRIPTION = 160;
const DEFAULT_CACHE_TTL_MS = 5_000;
const pluginCache = new Map();

function cacheKey(codexHome, home) {
  return `${path.resolve(codexHome || path.join(home, '.codex'))}\0${path.resolve(home)}`;
}

function createIoLimiter(limit = 8) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const { operation, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(operation).then(resolve, reject).finally(() => { active -= 1; drain(); });
    }
  };
  return (operation) => new Promise((resolve, reject) => { queue.push({ operation, resolve, reject }); drain(); });
}

function safeRealpath(target) {
  try { return realpathSync(target); } catch { return path.resolve(target); }
}

function isDirectory(target) {
  try { return existsSync(target) && statSync(target).isDirectory(); } catch { return false; }
}

function scrubText(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  text = text.split('/Users/').join('[path]');
  text = text.split('/home/').join('[path]');
  return text.slice(0, MAX_DESCRIPTION);
}

function sanitizePluginName(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function titleCasePlugin(name) {
  const map = {
    pdf: 'PDF',
    cowart: 'Cowart',
    documents: 'Documents',
    spreadsheets: 'Spreadsheets',
    presentations: 'Presentations',
    browser: 'Browser',
    chrome: 'Chrome',
    sites: 'Sites',
    visualize: 'Visualize',
    latex: 'LaTeX',
  };
  const key = String(name || '').toLowerCase();
  if (map[key]) return map[key];
  return String(name || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function pluginRoots(codexHome, home = homedir()) {
  const homeDir = home || homedir();
  const codex = codexHome || path.join(homeDir, '.codex');
  const roots = [];
  for (const dir of [path.join(codex, 'plugins', 'cache'), path.join(homeDir, '.codex', 'plugins', 'cache')]) {
    if (isDirectory(dir)) roots.push(safeRealpath(dir));
  }
  return [...new Set(roots)];
}

function readPluginJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function collectPluginsFromCache(cacheRoot, seen, out) {
  if (!isDirectory(cacheRoot)) return;
  let markets = [];
  try { markets = readdirSync(cacheRoot, { withFileTypes: true }); } catch { return; }
  for (const market of markets) {
    if (!market.isDirectory() || market.name.startsWith('.')) continue;
    const marketDir = path.join(cacheRoot, market.name);
    let plugins = [];
    try { plugins = readdirSync(marketDir, { withFileTypes: true }); } catch { continue; }
    for (const plugin of plugins) {
      if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
      const pluginDir = path.join(marketDir, plugin.name);
      let versions = [];
      try { versions = readdirSync(pluginDir, { withFileTypes: true }); } catch { continue; }
      const versionDirs = versions
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
      if (!versionDirs.length) continue;
      const version = versionDirs[versionDirs.length - 1];
      const manifest = path.join(pluginDir, version, '.codex-plugin', 'plugin.json');
      if (!existsSync(manifest)) continue;
      const data = readPluginJson(manifest) || {};
      const name = sanitizePluginName(data.name || plugin.name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: name,
        name,
        title: titleCasePlugin(data.name || name),
        description: scrubText(data.description || ''),
        market: market.name,
        invocation: '@' + name,
      });
    }
  }
}

export function listCodexPluginsUncached(codexHome, home = homedir()) {
  const seen = new Set();
  const plugins = [];
  for (const root of pluginRoots(codexHome, home)) {
    collectPluginsFromCache(root, seen, plugins);
  }
  plugins.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
  return plugins;
}

export function listCodexPlugins(codexHome, {
  home = homedir(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  force = false,
} = {}) {
  const now = Date.now();
  const key = cacheKey(codexHome, home);
  const cached = pluginCache.get(key);
  if (!force && cached?.expiresAt > now) return cached.plugins;
  const plugins = listCodexPluginsUncached(codexHome, home);
  pluginCache.set(key, {
    expiresAt: now + Math.max(0, Number(cacheTtlMs) || 0),
    plugins,
  });
  return plugins;
}

async function collectPluginsFromCacheAsync(cacheRoot, io) {
  let markets;
  try { markets = await io(() => readdir(cacheRoot, { withFileTypes: true })); } catch { return []; }
  const marketResults = await Promise.all(markets.map(async (market) => {
    if (!market.isDirectory() || market.name.startsWith('.')) return [];
    let plugins;
    try { plugins = await io(() => readdir(path.join(cacheRoot, market.name), { withFileTypes: true })); } catch { return []; }
    return Promise.all(plugins.map(async (plugin) => {
      if (!plugin.isDirectory() || plugin.name.startsWith('.')) return null;
      const pluginDir = path.join(cacheRoot, market.name, plugin.name);
      let versions;
      try { versions = await io(() => readdir(pluginDir, { withFileTypes: true })); } catch { return null; }
      const version = versions.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort().at(-1);
      if (!version) return null;
      let manifest;
      try { manifest = await io(() => readFile(path.join(pluginDir, version, '.codex-plugin', 'plugin.json'), 'utf8')); } catch (error) {
        // Missing manifests are ignored, while existing but unreadable files
        // match readPluginJson() by falling back to the directory name.
        if (error?.code === 'ENOENT') return null;
        manifest = '';
      }
      let data;
      try { data = JSON.parse(manifest); } catch { data = {}; }
      const name = sanitizePluginName(data.name || plugin.name);
      if (!name) return null;
      return { id: name, name, title: titleCasePlugin(data.name || name), description: scrubText(data.description || ''), market: market.name, invocation: '@' + name };
    }));
  }));
  return marketResults.flat(2).filter(Boolean);
}

export async function listCodexPluginsUncachedAsync(codexHome, home = homedir(), { concurrency = 8 } = {}) {
  const io = createIoLimiter(Math.max(1, Number(concurrency) || 8));
  const seen = new Set();
  const plugins = [];
  const homeDir = home || homedir();
  const codex = codexHome || path.join(homeDir, '.codex');
  const roots = [...new Set([
    path.resolve(path.join(codex, 'plugins', 'cache')),
    path.resolve(path.join(homeDir, '.codex', 'plugins', 'cache')),
  ])];
  for (const root of roots) {
    for (const plugin of await collectPluginsFromCacheAsync(root, io)) {
      const key = plugin.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      plugins.push(plugin);
    }
  }
  plugins.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
  return plugins;
}

export async function listCodexPluginsAsync(codexHome, {
  home = homedir(), cacheTtlMs = DEFAULT_CACHE_TTL_MS, force = false, concurrency = 8,
} = {}) {
  const now = Date.now();
  const key = cacheKey(codexHome, home);
  const cached = pluginCache.get(key);
  if (!force && cached?.expiresAt > now) return cached.plugins;
  if (cached?.pending) return cached.pending;
  const request = { pending: null };
  const pending = listCodexPluginsUncachedAsync(codexHome, home, { concurrency }).then((plugins) => {
    if (pluginCache.get(key) === request) {
      pluginCache.set(key, { expiresAt: Date.now() + Math.max(0, Number(cacheTtlMs) || 0), plugins });
    }
    return plugins;
  }).catch((error) => {
    if (pluginCache.get(key) === request) pluginCache.delete(key);
    throw error;
  });
  request.pending = pending;
  pluginCache.set(key, request);
  return pending;
}

export function clearCodexPluginsCache() {
  pluginCache.clear();
}

export { sanitizePluginName, titleCasePlugin, scrubText as scrubPluginText };
