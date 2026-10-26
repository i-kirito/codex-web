import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { quarantineUnlockedWriterLock } from '../native-writer-lock.mjs';

const supported = process.platform === 'linux' || process.platform === 'darwin';

function spawnLockOwner(lock) {
  if (process.platform === 'darwin') {
    return spawn('/usr/bin/python3', ['-c', `
import fcntl, sys
handle = open(sys.argv[1], 'r+')
fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
sys.stdout.write('locked')
sys.stdout.flush()
sys.stdin.read()
`, lock], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn('flock', [lock, process.execPath, '-e',
    'process.stdout.write("locked"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

test('writer takeover preserves live locks and only moves old unlocked regular files', {
  skip: !supported,
  timeout: 10000,
}, async () => {
  if (process.platform === 'linux') assert.equal(spawnSync('flock', ['--version']).status, 0);
  if (process.platform === 'darwin') {
    assert.equal(spawnSync('/usr/bin/python3', ['-c', 'import fcntl']).status, 0);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'writer-lock-test-'));
  const lock = path.join(dir, 'thread.lock');
  const backup = `${lock}.backup`;
  let owner;
  try {
    writeFileSync(lock, '');
    assert.equal(quarantineUnlockedWriterLock(lock, backup), false, 'young lock stays');
    const old = new Date(Date.now() - 10000);
    utimesSync(lock, old, old);
    owner = spawnLockOwner(lock);
    await once(owner.stdout, 'data');
    assert.equal(quarantineUnlockedWriterLock(lock, backup), false, 'live owner keeps its inode');
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(backup), false);
    const exited = once(owner, 'exit');
    owner.stdin.end();
    await exited;
    assert.equal(quarantineUnlockedWriterLock(lock, backup), true, 'released old lock can move');
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(backup), true);
    symlinkSync(backup, lock);
    assert.equal(quarantineUnlockedWriterLock(lock, `${backup}.other`), false, 'symlinks stay');
  } finally {
    if (owner && owner.exitCode === null) owner.stdin.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writer takeover rejects non-empty locks', { skip: !supported }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'writer-lock-content-test-'));
  const lock = path.join(dir, 'thread.lock');
  const backup = `${lock}.backup`;
  try {
    writeFileSync(lock, 'owned');
    const old = new Date(Date.now() - 10000);
    utimesSync(lock, old, old);
    assert.equal(quarantineUnlockedWriterLock(lock, backup), false);
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(backup), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
