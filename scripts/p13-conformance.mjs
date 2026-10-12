import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  certificationChecklist,
  runAdapterConformance,
} from '../tests/distribution/support/p13-suite.mjs';
import {
  realChannelKeys,
  syntheticSixthChannelKey,
} from '../packages/backend/dist/modules/distribution/index.js';

const evidenceDir =
  process.env.P13_EVIDENCE_DIR ?? '.local/verification/P13-03';
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const logPath = `${evidenceDir}/local-conformance.log`;
rmSync(logPath, { force: true });
const jsonPath = `${evidenceDir}/local-conformance-matrix.json`;

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(logPath, `${stamped}\n`, { mode: 0o600 });
}

const channels = [...realChannelKeys(), syntheticSixthChannelKey];
const matrix = [];
let failures = 0;
for (const channelKey of channels) {
  const result = await runAdapterConformance(channelKey);
  for (const entry of result.checks)
    log(
      `${channelKey} ${entry.passed ? 'PASS' : 'FAIL'} ${entry.id} :: ${entry.detail}`,
    );
  if (!result.passed) failures += 1;
  matrix.push({
    channel_key: channelKey,
    synthetic: channelKey === syntheticSixthChannelKey,
    passed: result.passed,
    checks: result.checks,
  });
}

const summary = {
  generated_at: new Date().toISOString(),
  boundary:
    'Local simulator conformance only. Simulator output is never live channel evidence.',
  channels,
  matrix,
  certification_checklist: certificationChecklist(),
  failures,
};
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, {
  mode: 0o600,
});
log(
  `local conformance: ${channels.length - failures}/${channels.length} channels passed; ` +
    `live_status remains BLOCKED_EXTERNAL for AT-C01..10`,
);
if (failures > 0) {
  log('LOCAL CONFORMANCE FAILED');
  process.exit(1);
}
log(`matrix written to ${jsonPath}`);
