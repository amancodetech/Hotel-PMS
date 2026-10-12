import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatDeploymentIssues,
  validateDeploymentProfile,
} from '../packages/backend/dist/deployment/profile.js';

const args = new Map(
  process.argv
    .filter((value) => value.startsWith('--'))
    .map((value) => {
      const [key, ...rest] = value.slice(2).split('=');
      return [key, rest.join('=')];
    }),
);
const profile = args.get('profile');
if (!['staging', 'production'].includes(profile ?? '')) {
  console.error('Usage: --profile=staging|production --env-file=<path>');
  process.exit(2);
}
const envFile = args.get('env-file');
if (!envFile) {
  console.error(
    'Missing --env-file=<path>; refusing to read process env directly.',
  );
  process.exit(2);
}
const path = resolve(envFile);
if (!existsSync(path)) {
  console.error(`Env file not found: ${envFile}`);
  process.exit(2);
}

const env = {};
for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const separator = line.indexOf('=');
  if (separator <= 0) continue;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (value !== '') env[key] = value;
}

const result = validateDeploymentProfile(env, profile);
console.log(`Deployment profile check: ${profile} from ${envFile}`);
console.log(`Result: ${result.ok ? 'PASS' : 'FAIL'}`);
console.log(
  `Fields declared: ${result.fields.filter((field) => field.state === 'SET').length} set, ` +
    `${result.fields.filter((field) => field.state === 'MISSING').length} missing of ${result.fields.length}`,
);
for (const field of result.fields) {
  if (field.state !== 'SET') continue;
  console.log(`- ${field.field}: ${field.detail}`);
}
console.log(`Issues: ${result.issues.length}`);
for (const entry of result.issues)
  console.log(`- ${entry.field}: ${entry.problem}`);
if (!result.ok) {
  console.error(`Fail-closed: ${formatDeploymentIssues(result)}`);
  process.exit(1);
}
console.log(
  'Validation passed for the supplied file; this is a prerequisite, not a deployment authorization.',
);
