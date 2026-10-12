import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { PropertyError } from '../domain/errors.js';
import { authorize } from './context.js';
import type { ServiceContext } from './context.js';
import { findPropertyView } from '../persistence/property-repository.js';
import { findSetupDraft } from '../persistence/setup-repository.js';
import {
  countFutureActiveCommitments,
  listCommitmentCoverageGaps,
  listCompositionSummaryRows,
  listOverlappingActiveWindows,
  listScheduledCompositionWindows,
  listSetupChangeEvents,
  listSharedActiveResources,
  readSetupCounts,
} from '../persistence/setup-insights-repository.js';
import type {
  CommitmentCoverageGapRow,
  CompositionSummaryRow,
  CompositionWindowRow,
  SetupChangeEventRow,
  SharedResourceRow,
} from '../persistence/types.js';

export interface SetupChangePage {
  items: SetupChangeEventRow[];
  next_cursor: string | null;
}

export interface SetupSettingsResult {
  property: {
    id: string;
    code: string;
    name: string;
    status: string;
    timezone: string;
    base_currency: string;
    inventory_version: number;
  };
  setup: {
    draft_present: boolean;
    draft_completed: boolean;
    draft_revision: number | null;
    draft_updated_at: string | null;
  };
  counts: {
    locations: number;
    resources: number;
    resources_active: number;
    resources_retired: number;
    products: number;
    products_active: number;
    products_draft: number;
    compositions_active: number;
    compositions_draft: number;
  };
  scheduled_changes: CompositionWindowRow[];
  recent_changes: SetupChangeEventRow[];
}

export type ReconciliationCheck =
  | {
      code: 'WINDOW_OVERLAP';
      status: 'PASS' | 'WARN';
      details: Array<{ product_id: string; product_code: string }>;
    }
  | {
      code: 'SHARED_RESOURCE';
      status: 'PASS' | 'WARN';
      details: SharedResourceRow[];
    }
  | {
      code: 'COMMITMENT_COVERAGE';
      status: 'PASS' | 'WARN';
      details: CommitmentCoverageGapRow[];
    };

export interface SetupReconciliationResult {
  generated_at: string;
  counts: {
    resources: number;
    products: number;
    active_compositions: number;
    future_commitments: number;
  };
  products: CompositionSummaryRow[];
  checks: ReconciliationCheck[];
}

const cursorTimestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const cursorUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

function parseCursor(
  cursor: string | null | undefined,
): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf('|');
  if (separator <= 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'cursor' });
  const createdAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (
    !cursorTimestamp.test(createdAt) ||
    !isCalendarDate(createdAt) ||
    Number.isNaN(Date.parse(createdAt)) ||
    !cursorUuid.test(id)
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'cursor' });
  return { createdAt, id };
}

export function cursorOf(event: SetupChangeEventRow): string {
  return `${new Date(event.created_at).toISOString()}|${event.id}`;
}

export async function readSetupChanges(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: { limit?: number; cursor?: string | null },
): Promise<SetupChangePage> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      const events = await listSetupChangeEvents(em, {
        tenantId: context.tenantId,
        propertyId,
        limit: limit + 1,
        cursor: parseCursor(input.cursor),
      });
      const items = events.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        next_cursor: events.length > limit && last ? cursorOf(last) : null,
      };
    },
  );
}

export async function readSetupSettings(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<SetupSettingsResult> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      const draft = await findSetupDraft(em, context.tenantId, propertyId);
      const counts = await readSetupCounts(em, context.tenantId, propertyId);
      const scheduled = await listScheduledCompositionWindows(
        em,
        context.tenantId,
        propertyId,
      );
      const recent = await listSetupChangeEvents(em, {
        tenantId: context.tenantId,
        propertyId,
        limit: 10,
        cursor: null,
      });
      return {
        property: {
          id: property.id,
          code: property.code,
          name: property.name,
          status: property.status,
          timezone: property.timezone,
          base_currency: property.base_currency,
          inventory_version: property.inventory_version,
        },
        setup: {
          draft_present: draft !== null,
          draft_completed: draft?.completed ?? false,
          draft_revision: draft?.revision ?? null,
          draft_updated_at: draft?.updated_at ?? null,
        },
        counts,
        scheduled_changes: scheduled,
        recent_changes: recent,
      };
    },
  );
}

export async function readSetupReconciliation(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<SetupReconciliationResult> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      const counts = await readSetupCounts(em, context.tenantId, propertyId);
      const futureCommitments = await countFutureActiveCommitments(
        em,
        context.tenantId,
        propertyId,
      );
      const products = await listCompositionSummaryRows(
        em,
        context.tenantId,
        propertyId,
      );
      const overlaps = await listOverlappingActiveWindows(
        em,
        context.tenantId,
        propertyId,
      );
      const shared: SharedResourceRow[] = await listSharedActiveResources(
        em,
        context.tenantId,
        propertyId,
      );
      const gaps: CommitmentCoverageGapRow[] = await listCommitmentCoverageGaps(
        em,
        context.tenantId,
        propertyId,
      );
      return {
        generated_at: new Date().toISOString(),
        counts: {
          resources: counts.resources,
          products: counts.products,
          active_compositions: counts.compositions_active,
          future_commitments: futureCommitments,
        },
        products,
        checks: [
          {
            code: 'WINDOW_OVERLAP',
            status: overlaps.length > 0 ? 'WARN' : 'PASS',
            details: overlaps,
          },
          {
            code: 'SHARED_RESOURCE',
            status: shared.length > 0 ? 'WARN' : 'PASS',
            details: shared,
          },
          {
            code: 'COMMITMENT_COVERAGE',
            status: gaps.length > 0 ? 'WARN' : 'PASS',
            details: gaps,
          },
        ],
      };
    },
  );
}
