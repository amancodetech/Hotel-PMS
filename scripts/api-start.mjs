import { spawn } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:http';
import { loadConfig } from '../packages/backend/dist/index.js';

const config = loadConfig();
const logPath = '.local/api-run.log';
const statePath = '.local/api.json';
const extra = process.argv.slice(2);

function ready() {
  return new Promise((resolve) => {
    const request = get(
      `http://127.0.0.1:${config.API_PORT}/api/v1/system/ready`,
      { timeout: 2000 },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.once('error', () => resolve(null));
    request.once('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}

function recorded() {
  try {
    const { pid } = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid API PID');
    if (
      !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(
        'apps/api/dist/main.js',
      )
    )
      throw new Error('PID does not belong to the API');
    return pid;
  } catch {
    try {
      unlinkSync(statePath);
    } catch {
      /* Nothing to remove. */
    }
    return null;
  }
}

const existing = await ready();
if (existing?.status === 'ready') {
  const pid = recorded();
  console.log(
    pid
      ? `API is already running (pid ${pid}):`
      : 'API is already running (started outside api:start):',
  );
  console.log(`  url   http://127.0.0.1:${config.API_PORT}`);
  console.log(`  ready ${JSON.stringify(existing.checks)}`);
  console.log(`  log   ${logPath}`);
  process.exit(0);
}

mkdirSync('.local', { recursive: true, mode: 0o700 });
const log = openSync(logPath, 'a', 0o600);
const child = spawn(
  process.execPath,
  ['--env-file=.env', ...extra, 'apps/api/dist/main.js'],
  { detached: true, stdio: ['ignore', log, log], env: process.env },
);
child.unref();
writeFileSync(statePath, JSON.stringify({ pid: child.pid }), { mode: 0o600 });

const deadline = Date.now() + 120_000;
let lastNote = Date.now();
for (;;) {
  const status = await ready();
  if (status?.status === 'ready') {
    console.log('API is ready:');
    console.log(`  url   http://127.0.0.1:${config.API_PORT}`);
    console.log(`  ready ${JSON.stringify(status.checks)}`);
    console.log(`  log   ${logPath} (pnpm api:stop to shut down)`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error('API did not become ready within 120s. Last log lines:');
    try {
      const tail = readFileSync(logPath, 'utf8')
        .trimEnd()
        .split('\n')
        .slice(-8);
      console.error(tail.join('\n'));
    } catch {
      /* No log yet. */
    }
    process.exit(1);
  }
  if (Date.now() - lastNote > 10_000) {
    lastNote = Date.now();
    console.log(
      `Waiting for API readiness (status=${status?.status ?? 'down'}) ...`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
