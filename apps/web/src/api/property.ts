import type { Phase4Components } from '@hotel/contracts';
import { api } from './client.js';

type Schemas = Phase4Components['schemas'];

export type Property = Schemas['Property'];
export type PropertyGroup = Schemas['PropertyGroup'];
export type Location = Schemas['Location'];
export type ResourceType = Schemas['ResourceType'];
export type Resource = Schemas['Resource'];
export type ResourceInput = Schemas['ResourceInput'];
export type ArchiveImpact = Schemas['ArchiveImpact'];
export type Product = Schemas['Product'];
export type ProductCandidate = Schemas['ProductCandidate'];
export type Pool = Schemas['Pool'];
export type PoolMember = Schemas['PoolMember'];
export type Composition = Schemas['Composition'];
export type CompositionEdge = Schemas['CompositionEdge'];
export type CompositionLeaf = Schemas['CompositionLeaf'];
export type Connection = Schemas['Connection'];
export type Mapping = Schemas['Mapping'];

export interface CompositionWindow {
  composition_id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  version_number: number;
  effective_from: string;
  effective_to: string | null;
  status: string;
}

export interface SetupChangeEvent {
  id: string;
  property_id: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  before_safe: Record<string, unknown> | null;
  after_safe: Record<string, unknown> | null;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface SetupSettings {
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
  scheduled_changes: CompositionWindow[];
  recent_changes: SetupChangeEvent[];
}

export interface CompositionLeafView {
  resource_id: string;
  code: string;
  resource_type: string;
}

export interface ResourceAllocationView {
  commitment_id: string;
  source_kind: string;
  resource_id: string;
  resource_code: string;
  start_date: string;
  end_date: string;
  product_id: string | null;
  expires_at: string | null;
}

export interface ResourceBlockView {
  block_id: string;
  resource_id: string;
  resource_code: string;
  mode: string;
  start_date: string;
  end_date: string;
}

export interface CompositionChangeImpact {
  verdict: 'SAFE' | 'BLOCKED';
  fingerprint: string;
  product_id: string;
  product_code: string;
  composition_id: string;
  current: { composition: Composition; leaves: CompositionLeafView[] };
  proposed: {
    effective_from: string;
    effective_to: string | null;
    leaves: CompositionLeafView[];
  };
  conflicts: ResourceAllocationView[];
  retained_commitments: ResourceAllocationView[];
  removed_leaves: CompositionLeafView[];
  intersecting_blocks: ResourceBlockView[];
}

export interface ReconciliationCheck {
  code: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  details: Array<Record<string, unknown>>;
}

export interface SetupReconciliation {
  generated_at: string;
  counts: {
    resources: number;
    products: number;
    active_compositions: number;
    future_commitments: number;
  };
  products: Array<{
    product_id: string;
    product_code: string;
    product_name: string;
    status: string;
    active_versions: number;
    leaf_count: number;
    effective_from: string | null;
    effective_to: string | null;
  }>;
  checks: ReconciliationCheck[];
}

export const timezoneOptions = [
  'Asia/Jakarta',
  'Asia/Makassar',
  'Asia/Jayapura',
] as const;
export const currencyOptions = ['IDR', 'USD'] as const;
export const resourceKinds = [
  'ROOM',
  'BED',
  'VILLA',
  'APARTMENT',
  'HOUSE',
  'SITE',
  'TENT',
  'CABIN',
] as const;

export const propertyApi = {
  listGroups: (tenantId: string) =>
    api<{ items: PropertyGroup[] }>(
      `/api/v1/tenants/${tenantId}/property-groups`,
    ),
  createGroup: (tenantId: string, body: unknown) =>
    api<{ group: PropertyGroup }>(
      `/api/v1/tenants/${tenantId}/property-groups`,
      { method: 'POST', body },
    ),
  listProperties: (tenantId: string) =>
    api<{ items: Property[] }>(`/api/v1/tenants/${tenantId}/properties`),
  createProperty: (tenantId: string, body: unknown) =>
    api<{ property: Property }>(`/api/v1/tenants/${tenantId}/properties`, {
      method: 'POST',
      body,
    }),
  getProperty: (tenantId: string, propertyId: string) =>
    api<{ property: Property }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}`,
    ),
  updateProperty: (tenantId: string, propertyId: string, body: unknown) =>
    api<{ property: Property }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}`,
      { method: 'PATCH', body },
    ),
  listResourceTypes: (tenantId: string) =>
    api<{ items: ResourceType[] }>(
      `/api/v1/tenants/${tenantId}/resource-types`,
    ),
  listLocations: (tenantId: string, propertyId: string) =>
    api<{ items: Location[] }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/locations`,
    ),
  listLocationChildren: (
    tenantId: string,
    propertyId: string,
    options: {
      parent_id?: string;
      limit?: number;
      cursor?: string;
      q?: string;
      kind?:
        'ZONE' | 'BUILDING' | 'WING' | 'FLOOR' | 'CLUSTER' | 'SERVICE_AREA';
      sort?: 'display_order' | 'code' | 'name';
    } = {},
  ) => {
    const query = new URLSearchParams({ tree: 'true' });
    for (const [key, value] of Object.entries(options))
      if (value !== undefined) query.set(key, String(value));
    return api<Schemas['LocationTreePageV2']>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/locations?${query}`,
    );
  },
  createTreeLocation: (
    tenantId: string,
    propertyId: string,
    body: Schemas['LocationTreeInputV2'],
    key: string,
  ) =>
    api<{ location: Location }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/locations`,
      {
        method: 'POST',
        body: { parent_id: null, ...body },
        headers: { 'Idempotency-Key': key },
      },
    ),
  updateLocation: (
    tenantId: string,
    propertyId: string,
    locationId: string,
    body: Schemas['LocationTreeUpdateV2'],
  ) =>
    api<{ location: Location }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/locations/${locationId}`,
      { method: 'PATCH', body },
    ),
  previewLocationArchive: (
    tenantId: string,
    propertyId: string,
    locationId: string,
  ) =>
    api<ArchiveImpact>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/locations/${locationId}/archive-preview`,
    ),
  previewResourceArchive: (
    tenantId: string,
    propertyId: string,
    resourceId: string,
  ) =>
    api<ArchiveImpact>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/resources/${resourceId}/archive-preview`,
    ),
  createLocation: (tenantId: string, propertyId: string, body: unknown) =>
    api<{ location: Location }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/locations`,
      { method: 'POST', body },
    ),
  listResourcePage: (
    tenantId: string,
    propertyId: string,
    cursor: string | null,
    filters: {
      q?: string;
      sort?: 'code' | 'label' | 'capacity';
      type?: string;
      min_capacity?: number;
      bedrooms_count?: number;
      bathrooms_count?: number;
      limit?: number;
    } = {},
  ) => {
    const query = new URLSearchParams({ limit: String(filters.limit ?? 50) });
    if (cursor) query.set('cursor', cursor);
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) query.set(key, String(value));
    return api<{ items: Resource[]; next_cursor: string | null }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/resources?${query}`,
    );
  },
  listResources: (tenantId: string, propertyId: string) =>
    api<{ items: Resource[]; next_cursor: string | null }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/resources?limit=100`,
    ),
  createResource: (
    tenantId: string,
    propertyId: string,
    body: ResourceInput,
    key?: string,
  ) =>
    api<{ resource: Resource }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/resources`,
      {
        method: 'POST',
        body,
        ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
      },
    ),
  updateResource: (
    tenantId: string,
    propertyId: string,
    resourceId: string,
    body: unknown,
  ) =>
    api<{ resource: Resource }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/resources/${resourceId}`,
      { method: 'PATCH', body },
    ),
  listProducts: (tenantId: string, propertyId: string) =>
    api<{ items: Product[] }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/products`,
    ),
  createProduct: (tenantId: string, propertyId: string, body: unknown) =>
    api<{ product: Product }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/products`,
      { method: 'POST', body },
    ),
  updateProduct: (
    tenantId: string,
    propertyId: string,
    productId: string,
    body: unknown,
  ) =>
    api<{ product: Product }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/products/${productId}`,
      { method: 'PATCH', body },
    ),
  listCandidates: (tenantId: string, propertyId: string, productId: string) =>
    api<{ items: ProductCandidate[] }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/products/${productId}/candidates`,
    ),
  addCandidate: (
    tenantId: string,
    propertyId: string,
    productId: string,
    resourceId: string,
  ) =>
    api<{ candidate: ProductCandidate }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/products/${productId}/candidates`,
      { method: 'POST', body: { resource_id: resourceId } },
    ),
  removeCandidate: (
    tenantId: string,
    propertyId: string,
    productId: string,
    resourceId: string,
  ) =>
    api<{ removed: boolean }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/products/${productId}/candidates/${resourceId}`,
      { method: 'DELETE' },
    ),
  listCompositions: (tenantId: string, propertyId: string) =>
    api<{ items: Composition[] }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/compositions`,
    ),
  createComposition: (tenantId: string, propertyId: string, body: unknown) =>
    api<{ composition: Composition }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/compositions`,
      { method: 'POST', body },
    ),
  getComposition: (
    tenantId: string,
    propertyId: string,
    compositionId: string,
  ) =>
    api<{
      composition: Composition;
      edges: CompositionEdge[];
      leaves: CompositionLeaf[];
    }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/compositions/${compositionId}`,
    ),
  previewCompositionChange: (
    tenantId: string,
    propertyId: string,
    compositionId: string,
    body: unknown,
  ) =>
    api<CompositionChangeImpact>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/compositions/${compositionId}/change-previews`,
      { method: 'POST', body },
    ),
  applyCompositionChange: (
    tenantId: string,
    propertyId: string,
    compositionId: string,
    body: unknown,
  ) =>
    api<{
      composition: Composition;
      superseded: Composition;
      fingerprint: string;
      replayed: boolean;
    }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/compositions/${compositionId}/changes`,
      {
        method: 'POST',
        body,
        headers: { 'idempotency-key': crypto.randomUUID() },
      },
    ),
  getSetupSettings: (tenantId: string, propertyId: string) =>
    api<SetupSettings>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-settings`,
    ),
  listSetupChanges: (
    tenantId: string,
    propertyId: string,
    cursor?: string | null,
  ) =>
    api<{ items: SetupChangeEvent[]; next_cursor: string | null }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-changes?limit=20${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    ),
  getSetupReconciliation: (tenantId: string, propertyId: string) =>
    api<SetupReconciliation>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/setup-reconciliation`,
    ),
  activateComposition: (
    tenantId: string,
    propertyId: string,
    compositionId: string,
    reason: string,
  ) =>
    api<{
      composition: Composition;
      edges: CompositionEdge[];
      leaves: CompositionLeaf[];
    }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/compositions/${compositionId}/activate`,
      { method: 'POST', body: { reason } },
    ),
  listConnections: (tenantId: string, propertyId: string) =>
    api<{ items: Connection[] }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/connections`,
    ),
  createConnection: (tenantId: string, propertyId: string, body: unknown) =>
    api<{ connection: Connection }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/connections`,
      { method: 'POST', body },
    ),
  listMappings: (tenantId: string, propertyId: string, connectionId: string) =>
    api<{ items: Mapping[] }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/connections/${connectionId}/mappings`,
    ),
  saveMapping: (
    tenantId: string,
    propertyId: string,
    connectionId: string,
    body: unknown,
  ) =>
    api<{ mapping: Mapping }>(
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/connections/${connectionId}/mapping`,
      { method: 'PUT', body },
    ),
};
