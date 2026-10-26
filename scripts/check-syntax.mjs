import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
function collect(directory, recursive = false) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(relative);
    else if (recursive && entry.isDirectory()) collect(relative, true);
  }
}
collect('.');
collect('scripts', true);
collect('test', true);
files.push('vendor/gpt-image-playground/app/codex-web-integration.js');

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`Syntax check failed: ${file}`);
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
