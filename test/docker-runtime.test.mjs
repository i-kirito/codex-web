import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Docker runtime includes the server import graph and browser entry assets', () => {
  const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ');
  const copied = dockerfile.split('\n')
    .filter((line) => /^COPY\s+(?!--from)/.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
  const packaged = (file) => copied.some((source) => file === source || file.startsWith(`${source}/`));
  const visited = new Set();
  function inspect(file) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.ok(packaged(file), `Docker image is missing runtime module: ${file}`);
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      inspect(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  inspect('server.mjs');
  const server = readFileSync(path.join(root, 'server.mjs'), 'utf8');
  for (const match of server.matchAll(/path\.join\(ROOT,\s*['"]([^'"]+\.(?:css|js))['"]\)/g)) {
    assert.ok(packaged(match[1]), `Docker image is missing browser asset: ${match[1]}`);
  }
});
