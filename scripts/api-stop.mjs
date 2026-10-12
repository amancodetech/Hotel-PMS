import { readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { get } from 'node:http';
import { loadConfig } from '../packages/backend/dist/index.js';

const config = loadConfig();
const statePath = '.local/api.json';

function ready() {
  return new Promise((resolve) => {
    const request = get(
      `http://127.0.0.1:${config.API_PORT}/api/v1/system/ready`,
      { timeout: 2000 },
      (response) => {
        response.resume();
        response.on('end', () => resolve(true));
      },
    );
    request.once('error', () => resolve(false));
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

try {
  const { pid } = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid API PID');
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (
      !command.includes('apps/api/dist/main.js') ||
      readlinkSync(`/proc/${pid}/cwd`) !== process.cwd()
    )
      throw new Error('PID does not belong to this API instance');
    process.kill(pid, 'SIGTERM');
    unlinkSync(statePath);
    console.log('API shutdown requested.');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') {
      unlinkSync(statePath);
      console.log('Removed stale API PID file.');
    } else throw error;
  }
} catch (error) {
  if (error.code === 'ENOENT') {
    if (await ready())
      console.log(
        'No API started by api:start is recorded, but port responds; stop it manually (e.g. pkill -f apps/api/dist/main.js).',
      );
    else console.log('No API process recorded.');
  } else throw error;
}
