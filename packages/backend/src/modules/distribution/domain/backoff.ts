import { createHash } from 'node:crypto';

export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  referenceId: string,
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 3_600_000);
  const base = 1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 10);
  const jitter =
    Number.parseInt(
      createHash('sha256').update(referenceId).digest('hex').slice(0, 4),
      16,
    ) % 250;
  return Math.min(base + jitter, 3_600_000);
}
