import { api } from './client.js';

export interface ReservationSummary {
  id: string;
  source: string;
  state: string;
  version: number;
  created_at: string;
  item_states: string[];
  item_count: number;
}

export interface ReservationItem {
  id: string;
  product_id: string | null;
  period: { arrival: string; departure: string };
  occupancy: { adults: number; child_ages: number[] };
  quantity: number;
  state: string;
  version: number;
  segments: Array<{ id: string; start_date: string; end_date: string }>;
}

export interface ReservationDetail {
  reservation: {
    id: string;
    source: string;
    state: string;
    version: number;
    external_booking_key: string | null;
    channel_connection_id: string | null;
    created_at: string;
  };
  items: ReservationItem[];
  guests: Array<{
    guest_id: string;
    item_id: string | null;
    role: string;
    full_name: string;
    email: string | null;
  }> | null;
}

export interface Guest {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  version: number;
  country_code: string | null;
  language: string | null;
  gender: 'FEMALE' | 'MALE' | null;
  notes: string | null;
}

export interface DraftInput {
  source?: 'DIRECT' | 'OTA' | 'IMPORT';
  channel_connection_id?: string | null;
  external_booking_key?: string | null;
  items: Array<{
    product_id?: string | null;
    period: { arrival: string; departure: string };
    occupancy: { adults: number; child_ages: number[] };
    quantity?: number;
  }>;
  guests?: Array<{ guest_id: string; role?: 'LEAD' | 'ACCOMPANYING' }>;
}

export interface GuestInput {
  full_name: string;
  email?: string | null;
  phone?: string | null;
  country_code?: string | null;
  language?: string | null;
  gender?: 'FEMALE' | 'MALE' | null;
  notes?: string | null;
}

export interface ImportInput {
  mode: 'DRY_RUN' | 'APPLY';
  source: 'UPLOAD' | 'FEED';
  file_name: string;
  content_type: string;
  content: string;
  external_id?: string | null;
}

export interface ImportRow {
  line_no: number;
  external_key: string | null;
  status: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
  error_code: string | null;
}

export interface ImportResult {
  mode: string;
  source: string;
  file_name: string;
  rows_total: number;
  rows_accepted: number;
  rows_rejected: number;
  rows_duplicate: number;
  rows: ImportRow[];
  run_id: string;
  replayed: boolean;
}

export interface ChannelException {
  id: string;
  type: string;
  state: string;
  connection_id: string | null;
  inbox_revision_id: string | null;
  outbox_id: string | null;
  owner: string | null;
  resolution: string | null;
  details_safe: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ReprocessResult {
  outcome: string;
  error_code?: string;
  exception_id?: string;
  reservation_id?: string | null;
  replayed?: boolean;
}

function tenantRoot(tenantId: string) {
  return `/api/v1/tenants/${tenantId}`;
}

function idempotencyKey() {
  return crypto.randomUUID();
}

function withQuery(
  base: string,
  params: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
}

export const reservationsApi = {
  listReservations: (
    tenantId: string,
    propertyId: string,
    params: { cursor?: string; limit?: number } = {},
  ) =>
    api<{ items: ReservationSummary[]; next_cursor: string | null }>(
      withQuery(
        `${tenantRoot(tenantId)}/properties/${propertyId}/reservations`,
        params,
      ),
    ),
  getReservation: (tenantId: string, propertyId: string, id: string) =>
    api<ReservationDetail>(
      `${tenantRoot(tenantId)}/properties/${propertyId}/reservations/${id}`,
    ),
  createReservationDraft: (
    tenantId: string,
    propertyId: string,
    body: DraftInput,
  ) =>
    api<{ reservation: { id: string; state: string; version: number } }>(
      `${tenantRoot(tenantId)}/properties/${propertyId}/reservations/drafts`,
      {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey() },
      },
    ),
  listGuests: (
    tenantId: string,
    params: { search?: string; cursor?: string; limit?: number } = {},
  ) =>
    api<{ items: Guest[]; next_cursor: string | null }>(
      withQuery(`${tenantRoot(tenantId)}/guests`, params),
    ),
  getGuest: (tenantId: string, id: string) =>
    api<{ guest: Guest }>(`${tenantRoot(tenantId)}/guests/${id}`),
  createGuest: (tenantId: string, body: GuestInput) =>
    api<{ guest: Guest }>(`${tenantRoot(tenantId)}/guests`, {
      method: 'POST',
      body,
      headers: { 'idempotency-key': idempotencyKey() },
    }),
  importReservations: (
    tenantId: string,
    propertyId: string,
    body: ImportInput,
  ) =>
    api<ImportResult>(
      `${tenantRoot(tenantId)}/properties/${propertyId}/imports`,
      {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey() },
      },
    ),
  listChannelExceptions: (tenantId: string, propertyId: string) =>
    api<{ items: ChannelException[] }>(
      `${tenantRoot(tenantId)}/properties/${propertyId}/inbox/exceptions`,
    ),
  reprocessChannelEvent: (
    tenantId: string,
    propertyId: string,
    revisionId: string,
  ) =>
    api<ReprocessResult>(
      `${tenantRoot(tenantId)}/properties/${propertyId}/inbox/${revisionId}/reprocess`,
      { method: 'POST' },
    ),
};
