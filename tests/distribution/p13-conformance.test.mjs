import { expect, test } from '@jest/globals';
import {
  certificationChecklist,
  channelKeys,
  runAdapterConformance,
} from './support/p13-suite.mjs';

test('P13 local simulator conformance passes for the five channels', async () => {
  for (const channelKey of channelKeys()) {
    const result = await runAdapterConformance(channelKey);
    for (const check of result.checks) {
      if (!check.passed)
        throw new Error(`${channelKey} ${check.id}: ${check.detail}`);
    }
    expect(result.passed).toBe(true);
  }
});

test('P13 certification checklist keeps every live cell BLOCKED_EXTERNAL', () => {
  const checklist = certificationChecklist();
  expect(checklist.map((entry) => entry.code)).toEqual([
    'AT-C01',
    'AT-C02',
    'AT-C03',
    'AT-C04',
    'AT-C05',
    'AT-C06',
    'AT-C07',
    'AT-C08',
    'AT-C09',
    'AT-C10',
  ]);
  expect(
    checklist.every((entry) => entry.live_status === 'BLOCKED_EXTERNAL'),
  ).toBe(true);
  expect(
    checklist.every(
      (entry) =>
        typeof entry.local_coverage === 'string' &&
        entry.local_coverage.length > 0,
    ),
  ).toBe(true);
});
