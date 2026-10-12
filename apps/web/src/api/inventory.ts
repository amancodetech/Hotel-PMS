import type { Phase5Components } from '@hotel/contracts';
import { api } from './client.js';
import type { Resource } from './property.js';

type Schemas = Phase5Components['schemas'];

export type Money = Schemas['Money'];
export type RatePlan = Schemas['RatePlan'];
export type RatePlanInput = Schemas['RatePlanInput'];
export type RatePlanPatch = Schemas['RatePlanPatch'];
export type RateBatchCell = Schemas['RateBatch']['cells'][number];
export type NightlyPrice = Schemas['NightlyPrice'];
export type RateCalendar = Schemas['RateCalendar'];
export type RatesResult = Schemas['RatesResult'];
export type SearchInput = Schemas['SearchInput'];
export type SearchOffer = Schemas['SearchOffer'];
export type SearchResult = Schemas['SearchResult'];
export type QuoteInput = Schemas['QuoteInput'];
export type PriceQuote = Schemas['PriceQuote'];
export type Hold = Schemas['Hold'];
export type HoldInput = Schemas['HoldInput'];
export type Block = Schemas['Block'];
export type BlockInput = Schemas['BlockInput'];
export type Disruption = Schemas['Disruption'];
export type BlockList = Schemas['BlockList'];
export type MaintenanceInput = Schemas['MaintenanceInput'];
export type ExposurePreviewInput = Schemas['ExposurePreviewInput'];
export type ExposurePreview = Schemas['ExposurePreview'];
export type Exposure = Schemas['Exposure'];
export type ExposureList = Schemas['ExposureList'];
export type ExposureOperationResult = Schemas['ExposureOperationResult'];
export type SaleInput = Schemas['SaleInput'];
export type SaleResult = Schemas['SaleResult'];
export type SyncStatus = Schemas['SyncStatus'];
export type ReconcileResult = Schemas['ReconcileResult'];

const root = (tenantId: string, propertyId: string) =>
  `/api/v1/tenants/${tenantId}/properties/${propertyId}`;

export const inventoryApi = {
  listRatePlans: (tenantId: string, propertyId: string) =>
    api<{ items: RatePlan[] }>(`${root(tenantId, propertyId)}/rate-plans`),
  createRatePlan: (tenantId: string, propertyId: string, body: RatePlanInput) =>
    api<{ rate_plan: RatePlan }>(`${root(tenantId, propertyId)}/rate-plans`, {
      method: 'POST',
      body,
    }),
  updateRatePlan: (
    tenantId: string,
    propertyId: string,
    ratePlanId: string,
    body: RatePlanPatch,
  ) =>
    api<{ rate_plan: RatePlan }>(
      `${root(tenantId, propertyId)}/rate-plans/${ratePlanId}`,
      { method: 'PATCH', body },
    ),
  getRateCalendar: (
    tenantId: string,
    propertyId: string,
    from: string,
    to: string,
  ) =>
    api<RateCalendar>(
      `${root(tenantId, propertyId)}/rates?from=${from}&to=${to}`,
    ),
  setRates: (tenantId: string, propertyId: string, cells: RateBatchCell[]) =>
    api<RatesResult>(`${root(tenantId, propertyId)}/rates/batch`, {
      method: 'POST',
      body: { cells },
    }),
  searchAvailability: (
    tenantId: string,
    propertyId: string,
    body: SearchInput,
  ) =>
    api<SearchResult>(`${root(tenantId, propertyId)}/availability/search`, {
      method: 'POST',
      body,
    }),
  quoteStay: (tenantId: string, propertyId: string, body: QuoteInput) =>
    api<{ quote: PriceQuote }>(`${root(tenantId, propertyId)}/quotes`, {
      method: 'POST',
      body,
    }),
  listHolds: (tenantId: string, propertyId: string) =>
    api<{ items: Hold[] }>(`${root(tenantId, propertyId)}/holds`),
  createHold: (tenantId: string, propertyId: string, body: HoldInput) =>
    api<{ hold: Hold }>(`${root(tenantId, propertyId)}/holds`, {
      method: 'POST',
      body,
    }),
  releaseHold: (tenantId: string, propertyId: string, holdId: string) =>
    api<{ hold: Hold }>(
      `${root(tenantId, propertyId)}/holds/${holdId}/release`,
      { method: 'POST' },
    ),
  listBlocks: (tenantId: string, propertyId: string) =>
    api<BlockList>(`${root(tenantId, propertyId)}/blocks`),
  createBlock: (tenantId: string, propertyId: string, body: BlockInput) =>
    api<{ block: Block; disruptions: Disruption[] }>(
      `${root(tenantId, propertyId)}/blocks`,
      { method: 'POST', body },
    ),
  releaseBlock: (
    tenantId: string,
    propertyId: string,
    blockId: string,
    reason: string,
  ) =>
    api<{ block: Block }>(
      `${root(tenantId, propertyId)}/blocks/${blockId}/release`,
      { method: 'POST', body: { reason } },
    ),
  setResourceMaintenance: (
    tenantId: string,
    propertyId: string,
    resourceId: string,
    body: MaintenanceInput,
  ) =>
    api<{ resource: Resource }>(
      `${root(tenantId, propertyId)}/resources/${resourceId}/maintenance`,
      { method: 'POST', body },
    ),
  previewExposure: (
    tenantId: string,
    propertyId: string,
    body: ExposurePreviewInput,
  ) =>
    api<ExposurePreview>(`${root(tenantId, propertyId)}/exposures/preview`, {
      method: 'POST',
      body,
    }),
  publishExposure: (
    tenantId: string,
    propertyId: string,
    previewId: string,
    previewVersion: number,
  ) =>
    api<ExposureOperationResult>(`${root(tenantId, propertyId)}/exposures`, {
      method: 'POST',
      body: { preview_id: previewId, preview_version: previewVersion },
    }),
  withdrawExposure: (
    tenantId: string,
    propertyId: string,
    exposureId: string,
    reason: string,
  ) =>
    api<ExposureOperationResult>(
      `${root(tenantId, propertyId)}/exposures/${exposureId}/withdraw`,
      { method: 'POST', body: { reason } },
    ),
  listExposures: (
    tenantId: string,
    propertyId: string,
    connectionId?: string,
  ) =>
    api<ExposureList>(
      `${root(tenantId, propertyId)}/exposures${
        connectionId ? `?connectionId=${connectionId}` : ''
      }`,
    ),
  setSaleStatus: (
    tenantId: string,
    propertyId: string,
    connectionId: string,
    body: SaleInput,
  ) =>
    api<SaleResult>(
      `${root(tenantId, propertyId)}/connections/${connectionId}/sale-status`,
      { method: 'POST', body },
    ),
  getSyncStatus: (
    tenantId: string,
    propertyId: string,
    connectionId: string,
    attempts = true,
  ) =>
    api<SyncStatus>(
      `${root(tenantId, propertyId)}/connections/${connectionId}/sync?attempts=${
        attempts ? 'true' : 'false'
      }`,
    ),
  reconcileConnection: (
    tenantId: string,
    propertyId: string,
    connectionId: string,
    reason: string,
  ) =>
    api<ReconcileResult>(
      `${root(tenantId, propertyId)}/connections/${connectionId}/reconcile`,
      { method: 'POST', body: { reason } },
    ),
};
