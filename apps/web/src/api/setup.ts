import type { SetComponents } from '@hotel/contracts';
export type SetupDraftInputV2 = SetComponents['schemas']['SetupDraftInputV2'];
export type VersionedSetupInput = SetupDraftInput | SetupDraftInputV2;
import { api } from './client.js';

export type SetupTemplateCode =
  'ROOM' | 'CABIN' | 'TENT' | 'VILLA' | 'APARTMENT' | 'DORM' | 'SITE' | 'SUITE';
export type SetupRentalMode = 'EXCLUSIVE' | 'WHOLE_OR_PARTS' | 'BEDS';
export type SetupSharingScope = 'MIXED';

export interface SetupTemplate {
  code: SetupTemplateCode;
  resource_type: string;
  default_rental_mode: SetupRentalMode;
  supports_parts: boolean;
  supports_beds: boolean;
  default_capacity: number | null;
  guaranteed_setup_options: string[];
}

export interface SetupPartInput {
  label: string;
  capacity?: number | null;
}

export interface SetupUnitGroupInput {
  id?: string | null;
  template_code: SetupTemplateCode;
  pattern: string;
  exclusions?: string[];
  capacity?: number | null;
  location_code?: string | null;
  rental_mode?: SetupRentalMode | null;
  privacy_ack?: boolean;
  sharing_scope?: SetupSharingScope | null;
  beds_per_unit?: number | null;
  guaranteed_specs?: string[];
  parts?: SetupPartInput[];
  connected_codes?: string[];
}

export interface SetupDraftInput {
  property: {
    name?: string | null;
    code?: string | null;
    country?: string | null;
    timezone?: 'Asia/Jakarta' | 'Asia/Makassar' | 'Asia/Jayapura' | null;
    base_currency?: 'IDR' | 'USD' | null;
    types?: SetupTemplateCode[];
  };
  unit_groups: SetupUnitGroupInput[];
  operations: {
    check_in?: string | null;
    check_out?: string | null;
    inspection_required?: boolean;
    explicit_states?: boolean;
  };
  pricing?: {
    postponed: boolean;
    plan_name?: string | null;
    sell_from?: string | null;
    sell_to?: string | null;
    base_price?: string | null;
  } | null;
}

export interface SetupDraft {
  draft_id: string;
  property_id: string;
  revision: number;
  updated_at: string;
  updated_by_user_id: string | null;
  completed: boolean;
  input: VersionedSetupInput;
}

export interface SetupIssue {
  code: string;
  step: string;
  field?: string;
  group_index?: number;
  message: string;
}

export interface SetupPreview {
  batch_plan?: { total_batches: number } | null;
  property_etag?: string;
  preview_version: string;
  draft_revision: number;
  inventory_version: number;
  generated: {
    total_units: number;
    by_template: Array<{
      template_code: string;
      units: number;
      rooms: number;
      beds: number;
      sites: number;
      parts: number;
      compositions: number;
    }>;
    codes_preview: string[];
    excluded_codes: string[];
  };
  limits: { max_units_inline: number; resource_capacity_remaining: number };
  blockers: SetupIssue[];
  warnings: SetupIssue[];
}

export interface SetupApplyResult {
  property_id: string;
  created_units: number;
  created_products: number;
  created_compositions: number;
  created_rate_plan: string | null;
  inventory_version: number;
  applied_at: string;
  follow_up_tasks: string[];
}

export interface SetupReadiness {
  ready: boolean;
  missing: SetupIssue[];
  checked_at: string;
  draft_revision: number | null;
}

export interface SetupSimulation {
  scope: 'WHOLE' | 'PART' | 'BED';
  allowed: boolean;
  blocked: Array<{ kind: string; code: string }>;
  available_after: string[];
  explanation: string;
}

const additionInput = (input: SetupDraftInputV2) => ({
  schema_version: 2,
  locations: input.locations,
  unit_groups: input.unit_groups,
});
export type SetupBatch = SetComponents['schemas']['SetupBatch'];
export const setupApi = {
  getBatch: (tenantId: string, propertyId: string, id?: string) =>
    api<{ batch: SetupBatch | null }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-batches${id ? `?id=${id}` : ''}`,
    ),
  startBatch: (
    tenantId: string,
    propertyId: string,
    body: {
      mode: 'DRAFT' | 'ADDITION';
      input?: unknown;
      preview_version: string;
    },
    options: { idempotencyKey: string; ifMatch: string },
  ) =>
    api<{ batch: SetupBatch }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-batches`,
      {
        method: 'POST',
        body:
          body.mode === 'ADDITION'
            ? { ...body, input: additionInput(body.input as SetupDraftInputV2) }
            : body,
        headers: {
          'idempotency-key': options.idempotencyKey,
          'if-match': options.ifMatch,
        },
      },
    ),
  advanceBatch: (tenantId: string, propertyId: string, batch: SetupBatch) =>
    api<{ batch: SetupBatch }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-batches/${batch.id}/advance`,
      {
        method: 'POST',
        body: {
          index: batch.completed_batches,
          preview_version: batch.preview_version,
        },
        headers: {
          'idempotency-key': `batch-${batch.id}-${batch.completed_batches}-${batch.preview_version?.slice(0, 24)}`,
        },
      },
    ),
  simulateProduct: (
    tenantId: string,
    propertyId: string,
    query: {
      product_id: string;
      from: string;
      to: string;
      adults: number;
      quantity: number;
    },
  ) =>
    api<SetComponents['schemas']['SetupProductSimulation']>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-product-simulation?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`,
    ),
  previewAddition: (
    tenantId: string,
    propertyId: string,
    input: SetupDraftInputV2,
  ) =>
    api<SetupPreview>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-unit-additions/preview`,
      { method: 'POST', body: additionInput(input) },
    ),
  applyAddition: (
    tenantId: string,
    propertyId: string,
    input: SetupDraftInputV2,
    previewVersion: string,
    options: { idempotencyKey: string; ifMatch: string },
  ) =>
    api<{ result: SetupApplyResult; replayed: boolean }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-unit-additions`,
      {
        method: 'POST',
        body: { input: additionInput(input), preview_version: previewVersion },
        headers: {
          'idempotency-key': options.idempotencyKey,
          'if-match': options.ifMatch,
        },
      },
    ),
  listTemplates: (tenantId: string) =>
    api<{ items: SetupTemplate[] }>(
      `/api/v1/tenants/${tenantId}/setup-templates`,
    ),
  getDraft: (tenantId: string, propertyId: string) =>
    api<{ draft: SetupDraft | null }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-draft`,
    ),
  saveDraft: (
    tenantId: string,
    propertyId: string,
    input: VersionedSetupInput,
    options: { idempotencyKey: string; ifMatch: string | null },
  ) =>
    api<{ draft: SetupDraft; replayed: boolean }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-draft`,
      {
        method: 'PUT',
        body: input,
        headers: {
          'idempotency-key': options.idempotencyKey,
          ...(options.ifMatch === null ? {} : { 'if-match': options.ifMatch }),
        },
      },
    ),
  discardDraft: (
    tenantId: string,
    propertyId: string,
    ifMatch: string | null,
  ) =>
    api<{ removed: boolean; replayed: boolean }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-draft`,
      {
        method: 'DELETE',
        headers: ifMatch === null ? {} : { 'if-match': ifMatch },
      },
    ),
  readiness: (tenantId: string, propertyId: string) =>
    api<SetupReadiness>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-readiness`,
    ),
  simulate: (
    tenantId: string,
    propertyId: string,
    query: {
      scope: 'WHOLE' | 'PART' | 'BED';
      unitCode: string;
      from: string;
      to: string;
    },
  ) =>
    api<SetupSimulation>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-simulation?scope=${query.scope}&unit_code=${encodeURIComponent(query.unitCode)}&from=${query.from}&to=${query.to}`,
    ),
  previewDraft: (tenantId: string, propertyId: string) =>
    api<SetupPreview>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-draft/preview`,
      { method: 'POST' },
    ),
  applyDraft: (
    tenantId: string,
    propertyId: string,
    previewVersion: string,
    options: { idempotencyKey: string; ifMatch: string },
  ) =>
    api<{ result: SetupApplyResult; replayed: boolean }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-draft/apply`,
      {
        method: 'POST',
        body: { preview_version: previewVersion },
        headers: {
          'idempotency-key': options.idempotencyKey,
          'if-match': options.ifMatch,
        },
      },
    ),
};
