import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const excluded = new Set([
  '.git',
  '.agents',
  '.codex',
  'node_modules',
  'dist',
  'coverage',
  '.local',
  'CHECKSUMS.sha256',
]);
function collect(directory = '.') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
    if (
      excluded.has(entry.name) ||
      (entry.name.startsWith('.env') && entry.name !== '.env.example') ||
      entry.name.endsWith('.tsbuildinfo') ||
      /\.xlsx$/i.test(entry.name) ||
      entry.name.endsWith('.generated.ts') ||
      (entry.name.startsWith('.snapshot-') &&
        entry.name !== '.snapshot-hotel.json')
    )
      return [];
    return entry.isDirectory() ? collect(path) : entry.isFile() ? [path] : [];
  });
}
let localSecrets = [];
try {
  localSecrets = Object.entries(parseEnv(readFileSync('.env', 'utf8')))
    .filter(
      ([key, value]) => /PASSWORD|SECRET|TOKEN/.test(key) && value.length >= 12,
    )
    .map(([, value]) => value);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const lines = collect()
  .sort()
  .map((path) => {
    const content = readFileSync(path);
    if (localSecrets.some((secret) => content.includes(secret)))
      throw new Error(`Local secret detected in source file: ${path}`);
    return `${createHash('sha256').update(content).digest('hex')}  ${path}`;
  });
writeFileSync('CHECKSUMS.sha256', lines.join('\n') + '\n');
console.log(
  `Updated ${lines.length} source/document checksums; secrets, operational spreadsheets, test-run snapshots and generated output excluded (canonical .snapshot-hotel.json kept as migration reference).`,
);
