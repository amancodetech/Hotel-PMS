import type {
  DependencyName,
  DependencyChecks,
  ReadinessReport,
} from '@hotel/contracts';

export type Probes = Record<DependencyName, () => Promise<void>>;
export async function inspectReadiness(
  probes: Probes,
): Promise<ReadinessReport> {
  const checks = {} as DependencyChecks;
  await Promise.all(
    (Object.keys(probes) as DependencyName[]).map(async (name) => {
      try {
        await probes[name]();
        checks[name] = 'up';
      } catch {
        checks[name] = 'down';
      }
    }),
  );
  return {
    status: Object.values(checks).every((value) => value === 'up')
      ? 'ready'
      : 'unavailable',
    checks,
    checked_at: new Date().toISOString(),
  };
}
