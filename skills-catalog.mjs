import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'os';
import path from 'path';

const SKILL_FILE = 'SKILL.md';
const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_DESCRIPTION = 240;

const skillCache = new Map();

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
      Promise.resolve().then(operation).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return (operation) => new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject });
    drain();
  });
}

function sanitizeSkillName(value) {
  return String(value || '')
    .trim()
    .replace(/^\$+/, '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function scrubSkillText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\/Users|\/home|\/var\/folders|C:\\Users)[^\s"'<>]*/gi, '[path]')
    .replace(/\b[A-Za-z0-9._-]+@[^\s"'<>]+/g, '[email]')
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function safeRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isDirectory(target) {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function shouldSkipDirName(name) {
  return name === 'node_modules'
    || name === '.git'
    || name === '.DS_Store'
    || name === 'dist'
    || name === 'build';
}

function collectSkillsFromRoot(rootDir, source, {
  maxDepth = 4,
  seenNames = new Set(),
  out = [],
} = {}) {
  if (!isDirectory(rootDir)) return out;

  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const skillFile = path.join(dir, SKILL_FILE);
    if (depth > 0 && existsSync(skillFile)) {
      try {
        const content = readFileSync(skillFile, 'utf8');
        const frontmatter = parseFrontmatter(content);
        const folderName = path.basename(dir);
        const name = sanitizeSkillName(frontmatter.name || folderName);
        if (!name) return;
        const key = name.toLowerCase();
        if (seenNames.has(key)) return;
        seenNames.add(key);
        const description = scrubSkillText(frontmatter.description || '');
        out.push({
          id: name,
          name,
          description,
          source,
          invocation: '$' + name,
        });
      } catch {
        // ignore unreadable skill packages
      }
      return;
    }

    for (const entry of entries) {
      if (shouldSkipDirName(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.system') continue;
      const full = path.join(dir, entry.name);
      if (!isDirectory(full)) continue;
      visit(full, depth + 1);
    }
  };

  visit(safeRealpath(rootDir), 0);
  return out;
}

function skillRoots(codexHome, home = homedir()) {
  const roots = [];
  const push = (dir, source, maxDepth = 4) => {
    if (!dir || !isDirectory(dir)) return;
    roots.push({ dir: safeRealpath(dir), source, maxDepth });
  };

  const homeDir = home || homedir();
  const codex = codexHome || path.join(homeDir, '.codex');
  push(path.join(codex, 'skills'), 'user', 3);
  push(path.join(homeDir, '.agents', 'skills'), 'agents', 3);
  push(path.join(homeDir, '.claude', 'skills'), 'claude', 4);
  push(path.join(codex, 'plugins', 'cache'), 'plugins', 7);
  return roots;
}

function sourceRank(source) {
  switch (source) {
    case 'user': return 0;
    case 'agents': return 1;
    case 'claude': return 2;
    case 'plugins': return 3;
    case 'system': return 4;
    default: return 9;
  }
}

export function listCodexSkillsUncached(codexHome, home = homedir()) {
  const seenNames = new Set();
  const skills = [];
  for (const root of skillRoots(codexHome, home)) {
    collectSkillsFromRoot(root.dir, root.source, {
      maxDepth: root.maxDepth,
      seenNames,
      out: skills,
    });
  }
  skills.sort((left, right) => {
    const bySource = sourceRank(left.source) - sourceRank(right.source);
    if (bySource) return bySource;
    const byName = left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
    if (byName) return byName;
    return 0;
  });
  // Keep the picker usable; plugins cache can contain hundreds of packages.
  const MAX_SKILLS = 120;
  return skills.slice(0, MAX_SKILLS);
}

export function listCodexSkills(codexHome, {
  home = homedir(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  force = false,
} = {}) {
  const now = Date.now();
  const key = cacheKey(codexHome, home);
  const cached = skillCache.get(key);
  if (!force && cached?.expiresAt > now) {
    return cached.skills;
  }
  const skills = listCodexSkillsUncached(codexHome, home);
  skillCache.set(key, {
    expiresAt: now + Math.max(0, Number(cacheTtlMs) || 0),
    skills,
  });
  return skills;
}

async function collectSkillsFromRootAsync(rootDir, source, maxDepth, io) {
  let resolved;
  try { resolved = await io(() => realpath(rootDir)); } catch { resolved = path.resolve(rootDir); }
  try { if (!(await io(() => stat(resolved))).isDirectory()) return []; } catch { return []; }

  const visit = async (dir, depth) => {
    if (depth > maxDepth) return [];
    let entries;
    try { entries = await io(() => readdir(dir, { withFileTypes: true })); } catch { return []; }
    if (depth > 0) {
      try {
        const content = await io(() => readFile(path.join(dir, SKILL_FILE), 'utf8'));
        const frontmatter = parseFrontmatter(content);
        const name = sanitizeSkillName(frontmatter.name || path.basename(dir));
        if (!name) return [];
        return [{
          id: name,
          name,
          description: scrubSkillText(frontmatter.description || ''),
          source,
          invocation: '$' + name,
        }];
      } catch (error) {
        // The synchronous API stops at a package when SKILL.md exists but is
        // unreadable; only a missing file permits traversal into descendants.
        if (error?.code !== 'ENOENT') return [];
      }
    }
    const children = entries.filter((entry) => {
      if (shouldSkipDirName(entry.name)) return false;
      return !entry.name.startsWith('.') || entry.name === '.system';
    });
    const nested = await Promise.all(children.map(async (entry) => {
      const full = path.join(dir, entry.name);
      try { if (!(await io(() => stat(full))).isDirectory()) return []; } catch { return []; }
      return visit(full, depth + 1);
    }));
    return nested.flat();
  };
  return visit(resolved, 0);
}

export async function listCodexSkillsUncachedAsync(codexHome, home = homedir(), { concurrency = 8 } = {}) {
  const io = createIoLimiter(Math.max(1, Number(concurrency) || 8));
  const seenNames = new Set();
  const skills = [];
  const homeDir = home || homedir();
  const codex = codexHome || path.join(homeDir, '.codex');
  const rootCandidates = [
    { dir: path.join(codex, 'skills'), source: 'user', maxDepth: 3 },
    { dir: path.join(homeDir, '.agents', 'skills'), source: 'agents', maxDepth: 3 },
    { dir: path.join(homeDir, '.claude', 'skills'), source: 'claude', maxDepth: 4 },
    { dir: path.join(codex, 'plugins', 'cache'), source: 'plugins', maxDepth: 7 },
  ];
  // Roots remain ordered so duplicate-name precedence matches the synchronous API.
  for (const root of rootCandidates) {
    const candidates = await collectSkillsFromRootAsync(root.dir, root.source, root.maxDepth, io);
    for (const skill of candidates) {
      const key = skill.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      skills.push(skill);
    }
  }
  skills.sort((left, right) => {
    const bySource = sourceRank(left.source) - sourceRank(right.source);
    return bySource || left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
  });
  return skills.slice(0, 120);
}

export async function listCodexSkillsAsync(codexHome, {
  home = homedir(), cacheTtlMs = DEFAULT_CACHE_TTL_MS, force = false, concurrency = 8,
} = {}) {
  const now = Date.now();
  const key = cacheKey(codexHome, home);
  const cached = skillCache.get(key);
  if (!force && cached?.expiresAt > now) return cached.skills;
  // force bypasses only a completed TTL entry; sharing an active scan avoids
  // duplicate directory walks and prevents an older scan winning the cache.
  if (cached?.pending) return cached.pending;
  const request = { pending: null };
  const pending = listCodexSkillsUncachedAsync(codexHome, home, { concurrency }).then((skills) => {
    if (skillCache.get(key) === request) {
      skillCache.set(key, { expiresAt: Date.now() + Math.max(0, Number(cacheTtlMs) || 0), skills });
    }
    return skills;
  }).catch((error) => {
    if (skillCache.get(key) === request) skillCache.delete(key);
    throw error;
  });
  request.pending = pending;
  skillCache.set(key, request);
  return pending;
}

export function clearCodexSkillsCache() {
  skillCache.clear();
}

export {
  parseFrontmatter,
  sanitizeSkillName,
  collectSkillsFromRoot,
  skillRoots,
};
