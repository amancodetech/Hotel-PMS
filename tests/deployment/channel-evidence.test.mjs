import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { validateChannelEvidence } from '../../scripts/support/p13-evidence.mjs';

test('evidence rejects simulator, another channel, missing provenance and changed artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'p13-evidence-'));
  try {
    writeFileSync(
      join(root, 'artifact.txt'),
      'synthetic schema-control only; no live claim',
    );
    writeFileSync(join(root, 'authorization.txt'), 'synthetic schema-control');
    const manifest = {
      evidence_version: 1,
      kind: 'official-channel-test',
      provider_key: 'channex',
      channel_key: 'tiket-com',
      environment: 'staging',
      profile: 'staging',
      connection_id: '12345678-1234-4234-8234-123456789012',
      test_run_id: 'synthetic-control',
      synthetic: false,
      live_tested: true,
      authorization_status: 'AUTHORIZED',
      authorization_ref: 'authorization.txt',
      adapter_version: 'schema-control',
      checked_at: '2026-09-17T00:00:00Z',
      at_codes: ['AT-C01'],
      provenance: {
        kind: 'official-provider',
        evidence_url: 'https://docs.channex.io/control',
        artifact_ref: 'artifact.txt',
        sha256: createHash('sha256')
          .update('synthetic schema-control only; no live claim')
          .digest('hex'),
      },
    };
    const expected = {
      channel_key: 'tiket-com',
      test_run_id: 'synthetic-control',
      at_code: 'AT-C01',
    };
    const check = (value) => {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(value));
      return () => validateChannelEvidence('manifest.json', expected, root);
    };
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    expect(() =>
      validateChannelEvidence(
        'manifest.json',
        { ...expected, test_run_id: undefined },
        root,
      ),
    ).toThrow(/binding required/);
    // Positive structural control is not stored in the readiness registry.
    expect(check(manifest)).not.toThrow();
    for (const change of [
      { provider_key: 'simulator' },
      { channel_key: 'booking-com' },
      { environment: 'local' },
      { synthetic: true },
      { live_tested: false },
      { test_run_id: 'another-run' },
      { connection_id: 'another-connection' },
      { at_codes: ['AT-C02'] },
      { provenance: null },
      { authorization_ref: 'missing.txt' },
      {
        provenance: {
          ...manifest.provenance,
          evidence_url: 'https://example.test/fake',
        },
      },
    ])
      expect(check({ ...manifest, ...change })).toThrow();
    writeFileSync(join(root, 'artifact.txt'), 'changed');
    expect(check(manifest)).toThrow(/hash mismatch/);
    expect(() =>
      validateChannelEvidence('missing.json', expected, root),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
