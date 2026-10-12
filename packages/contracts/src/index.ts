export type DependencyName = 'database' | 'redis' | 'identity';
export type DependencyChecks = Record<DependencyName, 'up' | 'down'>;
export interface ReadinessReport {
  status: 'ready' | 'unavailable';
  checked_at: string;
  checks: DependencyChecks;
}
export interface ApiError {
  code: string;
  message: string;
  correlation_id: string;
  details: Record<string, unknown>;
}
export type { paths as PlannedV1Paths } from './v1.generated.js';
export type {
  paths as Phase3Paths,
  components as Phase3Components,
} from './phase3.generated.js';
export type {
  paths as Phase4Paths,
  components as Phase4Components,
} from './phase4.generated.js';
export type {
  paths as Phase5Paths,
  components as Phase5Components,
} from './phase5.generated.js';
export * from './distribution.js';
export type { components as SetComponents } from './set.generated.js';
