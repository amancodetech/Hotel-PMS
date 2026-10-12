import { readFileSync, readlinkSync, unlinkSync } from 'node:fs';

try {
  const { pid } = JSON.parse(readFileSync('.local/dev.json', 'utf8'));
  if (!Number.isInteger(pid) || pid < 2)
    throw new Error('Invalid development PID');
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (
      !command.includes('scripts/dev.mjs') ||
      readlinkSync(`/proc/${pid}/cwd`) !== process.cwd()
    )
      throw new Error('PID does not belong to this development server');
    process.kill(pid, 'SIGTERM');
    console.log(
      'Development shutdown requested. Infrastructure volumes are untouched.',
    );
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') {
      unlinkSync('.local/dev.json');
      console.log('Removed stale development PID file.');
    } else throw error;
  }
} catch (error) {
  if (error.code === 'ENOENT') console.log('No development process recorded.');
  else throw error;
}
