import { spawnSync } from 'node:child_process';

const commands = { up: ['up', '-d', '--wait'], stop: ['stop'], status: ['ps'] };
const args = commands[process.argv[2]];
if (!args) throw new Error('Expected up, stop or status');
const binary = process.env.COMPOSE_BIN ?? 'docker';
const prefix = process.env.COMPOSE_BIN ? [] : ['compose'];
const result = spawnSync(
  binary,
  [...prefix, '--env-file', '.env', '-f', 'infra/compose.yaml', ...args],
  { stdio: 'inherit' },
);
if (result.error)
  console.error(
    'Compose unavailable. Install the Docker Compose plugin or set COMPOSE_BIN to the official binary.',
  );
process.exitCode = result.status ?? 1;
