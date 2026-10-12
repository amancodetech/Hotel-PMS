import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { loadConfig } from '../packages/backend/dist/index.js';

const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm dev');
const config = loadConfig();
for (const port of [config.API_PORT, config.WORKER_PORT, config.WEB_PORT]) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(
        new Error(
          `Local port ${port} is unavailable; choose a different port in .env.`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
mkdirSync('.local', { recursive: true, mode: 0o700 });
writeFileSync('.local/dev.json', JSON.stringify({ pid: process.pid }), {
  mode: 0o600,
});
process.once('exit', () => {
  try {
    if (JSON.parse(readFileSync('.local/dev.json', 'utf8')).pid === process.pid)
      unlinkSync('.local/dev.json');
  } catch {
    /* No runtime state left. */
  }
});
const commands = [
  ['-r', '--parallel', '--if-present', 'watch'],
  ...['@hotel/api', '@hotel/worker', '@hotel/web'].map((name) => [
    '--filter',
    name,
    'dev',
  ]),
];
const children = commands.map((args) =>
  spawn(process.execPath, [pnpm, ...args], {
    stdio: 'inherit',
    detached: true,
  }),
);
let stopped = false;
function stop(code = 0) {
  if (stopped) return;
  stopped = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
  }
  process.exitCode = code;
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
for (const child of children) {
  child.once('error', () => stop(1));
  child.once('exit', (code) => stop(code ?? 1));
}
