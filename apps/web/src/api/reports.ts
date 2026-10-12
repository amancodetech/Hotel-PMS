import { api, csrfToken } from './client.js';

export type ReportKind =
  | 'OCCUPANCY'
  | 'ADR_REVPAR'
  | 'ARRIVALS'
  | 'DEPARTURES'
  | 'PICKUP'
  | 'REVENUE'
  | 'TAX'
  | 'SETTLEMENTS'
  | 'CHANNEL_PERFORMANCE';

export type ReportCurrency = 'IDR' | 'USD';

export interface ReportMetric {
  key: string;
  label: string;
  value: string | null;
  unit: string;
  basis: string;
  numerator: string | null;
  denominator: string | null;
  zero_denominator: boolean;
  null_reason: string | null;
}

export interface ReportRow {
  label: string;
  value: string;
  unit: string;
  state?: string;
  date?: string;
}

export interface ReportResult {
  report_id: string;
  kind: string;
  generated_at: string;
  period: { date_from: string; date_to: string };
  currency: string | null;
  cutoff: {
    business_date: string | null;
    state: string | null;
    property_timezone: string;
  };
  data_basis: string;
  metrics: ReportMetric[];
  rows: ReportRow[];
}

export interface ReportExport {
  id: string;
  kind: string;
  format: 'CSV';
  state: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED' | 'REVOKED';
  property_id: string | null;
  created_at: string;
  ready_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  correlation_id: string | null;
}

export interface ReportSnapshot {
  id: string;
  kind: string;
  reference_date: string;
  captured_at: string;
  captured_by_label: string | null;
}

export interface ReportQueryInput {
  kind: ReportKind;
  period: { date_from: string; date_to: string };
  currency?: ReportCurrency;
  resource_type?: string;
  reference_date?: string;
}

function tenantRoot(tenantId: string, propertyId: string) {
  return `/api/v1/tenants/${tenantId}/properties/${propertyId}`;
}

function write<T>(path: string, body?: unknown) {
  return api<T>(path, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
}

export const reportsApi = {
  read: (tenantId: string, propertyId: string, input: ReportQueryInput) =>
    write<ReportResult>(`${tenantRoot(tenantId, propertyId)}/reports/query`, {
      ...input,
    }),
  readPortfolio: (
    tenantId: string,
    input: {
      kind: 'PORTFOLIO';
      period: { date_from: string; date_to: string };
      currency: ReportCurrency;
    },
  ) =>
    write<ReportResult>(`/api/v1/tenants/${tenantId}/reports/query`, {
      ...input,
    }),
  captureSnapshot: (
    tenantId: string,
    propertyId: string,
    referenceDate?: string,
  ) =>
    write<{ snapshot: ReportSnapshot; replayed: boolean }>(
      `${tenantRoot(tenantId, propertyId)}/reports/snapshots`,
      referenceDate ? { reference_date: referenceDate } : {},
    ),
  listSnapshots: (tenantId: string, propertyId: string) =>
    api<{ items: ReportSnapshot[] }>(
      `${tenantRoot(tenantId, propertyId)}/reports/snapshots`,
    ),
  createExport: (
    tenantId: string,
    propertyId: string,
    input: ReportQueryInput,
  ) =>
    write<{ export: ReportExport; replayed: boolean }>(
      `${tenantRoot(tenantId, propertyId)}/reports/exports`,
      { ...input },
    ),
  listExports: (tenantId: string, propertyId: string) =>
    api<{ items: ReportExport[] }>(
      `/api/v1/tenants/${tenantId}/reports/exports?property_id=${propertyId}`,
    ),
  revokeExport: (tenantId: string, exportId: string) =>
    api<{ export: ReportExport }>(
      `/api/v1/tenants/${tenantId}/reports/exports/${exportId}/revocation`,
      { method: 'POST', body: {} },
    ),
  downloadExport: async (
    tenantId: string,
    exportId: string,
  ): Promise<{ blob: Blob; fileName: string }> => {
    const response = await fetch(
      `/api/v1/tenants/${tenantId}/reports/exports/${exportId}/download`,
      {
        method: 'GET',
        headers: csrfToken() ? { 'x-csrf-token': csrfToken() ?? '' } : {},
        credentials: 'same-origin',
      },
    );
    if (!response.ok) {
      let body: { code?: string };
      try {
        body = (await response.json()) as { code?: string };
      } catch {
        body = {};
      }
      throw new Error(body.code ?? `HTTP_${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/);
    return { blob, fileName: match?.[1] ?? `report-${exportId}.csv` };
  },
};
