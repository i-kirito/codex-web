import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DARWIN_LOCK_HELPER = `
import fcntl, os, stat, sys, time

source, target, age_ms = sys.argv[1:]
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except (BlockingIOError, OSError):
    sys.exit(75)

held = os.fstat(3)
try:
    current = os.lstat(source)
except OSError:
    sys.exit(75)

age_ns = int(age_ms) * 1_000_000
if (not stat.S_ISREG(current.st_mode)
        or current.st_dev != held.st_dev
        or current.st_ino != held.st_ino
        or held.st_size != 0
        or time.time_ns() - held.st_mtime_ns < age_ns):
    sys.exit(75)

os.rename(source, target)
`;

// Hold the same inode's flock throughout the rename. A zero-byte lock may
// still belong to a live writer; snapshots and file ages cannot prove otherwise.
export function quarantineUnlockedWriterLock(lockPath, backupPath, minAgeMs = 5000) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  let fd;
  try {
    fd = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 0 || Date.now() - stat.mtimeMs < minAgeMs) return false;
    const command = process.platform === 'darwin' ? '/usr/bin/python3' : 'flock';
    const args = process.platform === 'darwin'
      ? ['-c', DARWIN_LOCK_HELPER, lockPath, backupPath, String(minAgeMs)]
      : [
        '--exclusive', '--nonblock', '--conflict-exit-code', '75', '/proc/self/fd/3',
        process.execPath, '--input-type=module', '-e', `
          import { fstatSync, lstatSync, renameSync } from 'node:fs';
          const [source, target, age] = process.argv.slice(1);
          const held = fstatSync(3);
          const current = lstatSync(source);
          if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino
              || held.size !== 0 || Date.now() - held.mtimeMs < Number(age)) process.exit(75);
          renameSync(source, target);
        `, lockPath, backupPath, String(minAgeMs),
      ];
    const result = spawnSync(command, args, {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      timeout: 3000,
    });
    return !result.error && result.status === 0;
  } catch {
    // Missing platform lock helpers, inaccessible files and unknown ownership all fail closed.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
