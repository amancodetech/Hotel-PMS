import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { loadConfig } from '../packages/backend/dist/index.js';

const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm dev:start');
const config = loadConfig();
const ports = [
  ['api', config.API_PORT],
  ['web', config.WEB_PORT],
  ['worker', config.WORKER_PORT],
];
const logPath = '.local/dev-run.log';

function probe(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function recorded() {
  try {
    return Number.isInteger(
      JSON.parse(readFileSync('.local/dev.json', 'utf8')).pid,
    );
  } catch {
    return false;
  }
}

function report(state) {
  const lines = ports.map(
    ([name, port]) =>
      `  ${name.padEnd(6)} :${port} ${state[name] ? 'up' : 'down'}`,
  );
  console.log(lines.join('\n'));
}

mkdirSync('.local', { recursive: true, mode: 0o700 });
const alreadyUp = (
  await Promise.all(ports.map(([, port]) => probe(port)))
).every(Boolean);
if (alreadyUp || (recorded() && (await probe(config.API_PORT)))) {
  console.log('Development is already running:');
  report(Object.fromEntries(ports.map(([name]) => [name, true])));
  console.log(`  web   http://127.0.0.1:${config.WEB_PORT}`);
  console.log(`  log   ${logPath}`);
  process.exit(0);
}

const log = openSync(logPath, 'a', 0o600);
const child = spawn(process.execPath, [pnpm, 'dev'], {
  detached: true,
  stdio: ['ignore', log, log],
  env: process.env,
});
child.unref();

const deadline = Date.now() + 180_000;
let lastNote = Date.now();
for (;;) {
  const states = Object.fromEntries(
    await Promise.all(
      ports.map(async ([name, port]) => [name, await probe(port)]),
    ),
  );
  if (states.api && states.web && states.worker) {
    console.log('Development is ready:');
    report(states);
    console.log(`  web   http://127.0.0.1:${config.WEB_PORT}`);
    console.log(`  log   ${logPath} (pnpm dev:stop to shut down)`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(
      'Development did not become ready within 180s. Last log lines:',
    );
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
  if (Date.now() - lastNote > 15_000) {
    lastNote = Date.now();
    console.log('Still building/starting (output in ' + logPath + ') ...');
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
