import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearCodexSkillsCache,
  listCodexSkillsAsync,
  listCodexSkillsUncached,
  listCodexSkillsUncachedAsync,
  parseFrontmatter,
  sanitizeSkillName,
} from '../skills-catalog.mjs';

test('parseFrontmatter reads skill name and description', () => {
  const source = [
    '---',
    "name: 'hatch-pet'",
    'description: "Create animated pets from references."',
    'metadata:',
    '  short-description: ignored nested',
    '---',
    '',
    '# Hatch Pet',
    '',
  ].join('\n');
  const parsed = parseFrontmatter(source);
  assert.equal(parsed.name, 'hatch-pet');
  assert.equal(parsed.description, 'Create animated pets from references.');
});

test('async skill catalog preserves synchronous ordering and isolates caches by home', async () => {
  clearCodexSkillsCache();
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-skills-async-'));
  const firstHome = path.join(temporary, 'first');
  const secondHome = path.join(temporary, 'second');
  for (const [home, name] of [[firstHome, 'first-skill'], [secondHome, 'second-skill']]) {
    const skill = path.join(home, '.codex', 'skills', name);
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`);
  }
  const firstCodex = path.join(firstHome, '.codex');
  const expected = listCodexSkillsUncached(firstCodex, firstHome);
  assert.deepEqual(await listCodexSkillsUncachedAsync(firstCodex, firstHome, { concurrency: 2 }), expected);
  const first = await listCodexSkillsAsync(firstCodex, { home: firstHome });
  const second = await listCodexSkillsAsync(path.join(secondHome, '.codex'), { home: secondHome });
  assert.deepEqual(first.map((item) => item.name), ['first-skill']);
  assert.deepEqual(second.map((item) => item.name), ['second-skill']);
});

test('async skill catalog stops below an unreadable SKILL.md package like the sync scanner', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-skills-unreadable-'));
  const home = temporary;
  const codexHome = path.join(home, '.codex');
  const blocked = path.join(codexHome, 'skills', 'blocked');
  const nested = path.join(blocked, 'nested');
  await mkdir(path.join(blocked, 'SKILL.md'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'SKILL.md'), '---\nname: must-not-leak\n---\n');
  const sync = listCodexSkillsUncached(codexHome, home);
  const asyncResult = await listCodexSkillsUncachedAsync(codexHome, home);
  assert.deepEqual(asyncResult, sync);
  assert.equal(asyncResult.some((item) => item.name === 'must-not-leak'), false);
});

test('async skill cache shares force with an active scan and clear prevents stale writeback', async () => {
  clearCodexSkillsCache();
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-skills-cache-'));
  const home = temporary;
  const codexHome = path.join(home, '.codex');
  for (let index = 0; index < 40; index += 1) {
    const dir = path.join(codexHome, 'skills', `skill-${index}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), `---\nname: skill-${index}\n---\n`);
  }
  const active = listCodexSkillsAsync(codexHome, { home });
  const forced = listCodexSkillsAsync(codexHome, { home, force: true });
  const [first, joined] = await Promise.all([active, forced]);
  assert.strictEqual(joined, first);

  clearCodexSkillsCache();
  const stale = listCodexSkillsAsync(codexHome, { home, force: true });
  clearCodexSkillsCache();
  await stale;
  const added = path.join(codexHome, 'skills', 'added-after-clear');
  await mkdir(added, { recursive: true });
  await writeFile(path.join(added, 'SKILL.md'), '---\nname: added-after-clear\n---\n');
  const refreshed = await listCodexSkillsAsync(codexHome, { home });
  assert.equal(refreshed.some((item) => item.name === 'added-after-clear'), true);
});

test('sanitizeSkillName strips dollar prefixes and invalid chars', () => {
  assert.equal(sanitizeSkillName('$ui-ux-pro-max'), 'ui-ux-pro-max');
  assert.equal(sanitizeSkillName('browser:control chrome'), 'browser:control-chrome');
});

test('listCodexSkillsUncached discovers skills without exposing absolute paths', async () => {
  clearCodexSkillsCache();
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-skills-'));
  const codexHome = path.join(temporary, '.codex');
  const home = temporary;
  const userSkill = path.join(codexHome, 'skills', 'demo-skill');
  const systemSkill = path.join(codexHome, 'skills', '.system', 'imagegen');
  const agentsSkill = path.join(home, '.agents', 'skills', 'agent-reach');
  await mkdir(userSkill, { recursive: true });
  await mkdir(systemSkill, { recursive: true });
  await mkdir(agentsSkill, { recursive: true });
  await writeFile(path.join(userSkill, 'SKILL.md'), [
    '---',
    'name: demo-skill',
    'description: Demo skill for slash menu.',
    '---',
    '# Demo',
    '',
  ].join('\n'));
  await writeFile(path.join(systemSkill, 'SKILL.md'), [
    '---',
    'name: imagegen',
    'description: Generate images.',
    '---',
    '# Imagegen',
    '',
  ].join('\n'));
  await writeFile(path.join(agentsSkill, 'SKILL.md'), [
    '---',
    'name: agent-reach',
    'description: Reach the internet.',
    '---',
    '# Agent Reach',
    '',
  ].join('\n'));

  const skills = listCodexSkillsUncached(codexHome, home);
  assert.ok(skills.some((item) => item.name === 'demo-skill'));
  assert.ok(skills.some((item) => item.name === 'imagegen'));
  assert.ok(skills.some((item) => item.name === 'agent-reach'));
  for (const skill of skills) {
    assert.equal(skill.invocation, '$' + skill.name);
    assert.equal('path' in skill, false);
    assert.equal('file' in skill, false);
    assert.match(skill.source, /^(user|agents|claude|plugins|system)$/);
    assert.ok(!String(skill.description || '').includes(temporary));
  }
});
