import { api } from './client.js';

export type Currency = 'IDR' | 'USD';
export type PaymentMethod =
  'CASH' | 'BANK_TRANSFER' | 'OTA_SETTLEMENT' | 'EXTERNAL_POS';

export interface Money {
  amount: string;
  currency: Currency;
}

export interface BusinessDay {
  id: string;
  business_date: string;
  state: string;
  version: number;
  opened_at: string;
  closed_at: string | null;
}

export interface BusinessDayResult {
  date: string;
  timezone: string;
  business_day: BusinessDay | null;
}

export interface Folio {
  id: string;
  reservation_id: string | null;
  kind: 'GUEST' | 'COMPANY' | 'HOUSE' | 'OWNER';
  payer_label: string;
  currency: Currency;
  state: 'OPEN' | 'CLOSED';
  version: number;
}

export interface FolioCharge {
  id: string;
  folio_id: string;
  business_date: string;
  currency: Currency;
  kind: string;
  account_code: string;
  net_amount: string;
  tax_amount: string;
  tax_policy: Record<string, unknown>;
  policy_snapshot_id?: string | null;
  source_kind: string;
  source_ref: string;
  period_start?: string | null;
  period_end?: string | null;
  journal_id: string;
  posted_at: string;
}

export interface FolioAllocation {
  id: string;
  charge_id: string;
  payer_folio_id: string;
  amount: string;
  journal_id: string;
}

export interface FolioDeposit {
  id: string;
  kind: 'DEPOSIT' | 'DAMAGE';
  method: Exclude<PaymentMethod, 'OTA_SETTLEMENT'>;
  currency: Currency;
  amount: string;
  applied: string;
  released: string;
  held: string;
  external_reference: string;
  source_ref: string;
  journal_id: string;
}

export interface FolioPayment {
  id: string;
  folio_id: string;
  method: PaymentMethod;
  currency: Currency;
  amount: string;
  gross_amount: string | null;
  commission_amount: string | null;
  business_date: string;
  external_reference: string;
  evidence_ref: string | null;
  source_ref: string;
  state: 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
  journal_id: string | null;
  reconciled_at: string | null;
  replayed?: boolean;
}

export interface FolioRefund {
  id: string;
  payment_id: string;
  folio_id: string;
  currency: Currency;
  amount: string;
  reason: string;
  state: 'RESERVED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
  approval_id: string | null;
  journal_id: string | null;
  replayed?: boolean;
}

export interface FolioTotals {
  charges_total: string;
  adjustments_total: string;
  routed_out: string;
  routed_in: string;
  deposits_held: string;
  deposits_applied: string;
  balance_due: string;
  payments_total: string;
  refunds_total: string;
}

export interface FolioDetail {
  folio: Folio;
  charges: FolioCharge[];
  allocations: FolioAllocation[];
  deposits: FolioDeposit[];
  payments: FolioPayment[];
  refunds: FolioRefund[];
  totals: FolioTotals;
}

export type ClearanceState = 'PENDING' | 'CLEARED' | 'NOT_REQUIRED';
export type ClearanceBasis = 'SETTLED' | 'TRANSFER_TO_PAYER';

export interface ClearanceSchedule {
  id: string;
  code: string;
  account_code: string;
  quantity: number;
  net_amount: string;
  tax_amount: string;
  currency: Currency;
  interval: 'DAY' | 'WEEK' | 'MONTH';
  starts_on: string;
  ends_on: string | null;
  state: 'ACTIVE' | 'STOPPED';
  version: number;
  posted_periods: number;
  next_period_start: string | null;
}

export interface ClearanceEntitlement {
  id: string;
  code: string;
  quantity_total: number;
  quantity_consumed: number;
  unit_net_amount: string;
  unit_tax_amount: string;
  currency: Currency;
  state: string;
}

export interface ClearanceFolio {
  folio: Folio;
  totals: FolioTotals;
  charges: FolioCharge[];
  allocations: FolioAllocation[];
  payments: FolioPayment[];
  refunds: FolioRefund[];
  invoices: FolioInvoice[];
  schedules: ClearanceSchedule[];
  entitlements: ClearanceEntitlement[];
}

export interface ReservationClearance {
  reservation: {
    id: string;
    state: string;
    version: number;
    source: string;
    channel_connection_id: string | null;
    external_booking_key: string | null;
    financial_clearance_state: ClearanceState;
    financial_cleared_at: string | null;
    financial_clearance_basis: ClearanceBasis | null;
    financial_clearance_reference: string | null;
    departed: boolean;
  };
  external_booking: {
    id: string;
    connection_id: string;
    channel_key: string;
    external_booking_id: string;
    provider_booking_id: string | null;
    state: string;
  } | null;
  folios: ClearanceFolio[];
  totals_by_currency: Array<FolioTotals & { currency: Currency }>;
  balanced: boolean;
  outstanding: boolean;
  credit: boolean;
  settled: boolean;
}

export interface SettleClearanceInput {
  version: number;
  basis: ClearanceBasis;
  payer_folio_id?: string;
  collection_plan_ref?: string;
  reason?: string;
}

export interface SettleClearanceResult {
  reservation_id: string;
  state: string;
  reservation_version: number;
  financial_clearance_state: ClearanceState;
  financial_cleared_at: string | null;
  financial_clearance_basis: ClearanceBasis | null;
  financial_clearance_reference: string | null;
  financial_clearance_payer_folio_id: string | null;
  transfer_allocations: Array<{
    charge_id: string;
    payer_folio_id: string;
    amount: string;
  }>;
  replayed: boolean;
}

export interface ExternalSettlement {
  id: string;
  folio_id: string;
  folio_reservation_id: string | null;
  method: 'OTA_SETTLEMENT';
  currency: Currency;
  amount: string;
  gross_amount: string | null;
  commission_amount: string | null;
  business_date: string;
  external_reference: string;
  evidence_ref: string | null;
  source_ref: string;
  state: 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
  journal_id: string | null;
  reservation: {
    id: string;
    state: string;
    source: string;
    channel_connection_id: string | null;
    external_booking_key: string | null;
  } | null;
  external_booking: {
    id: string;
    channel_key: string;
    provider_booking_id: string | null;
    state: string;
  } | null;
  linked_to_external_booking: boolean;
}

export interface FolioCreditNote {
  id: string;
  invoice_id: string;
  series: string;
  number: string;
  currency: Currency;
  amount: string;
  reason: string;
  source_ref: string;
  journal_id: string;
  issued_at: string;
}

export interface FolioInvoice {
  id: string;
  folio_id: string;
  series: string;
  number: string;
  kind: 'SYNTHETIC' | 'PRODUCTION';
  currency: Currency;
  net_amount: string;
  tax_amount: string;
  total_amount: string;
  tax_policy: Record<string, unknown>;
  account_code: string;
  state: 'ISSUED';
  source_ref: string;
  business_date: string;
  journal_id: string | null;
  issued_at: string;
  credit_notes?: FolioCreditNote[];
}

export interface CashierSession {
  id: string;
  currency: Currency;
  state: 'OPEN' | 'COUNTING' | 'RECONCILED' | 'CLOSED';
  opening_float: string;
  expected_amount: string | null;
  counted_amount: string | null;
  variance: string | null;
  version: number;
}

export interface OpenFolioInput {
  reservation_id?: string;
  kind?: Folio['kind'];
  payer_label: string;
  currency: Currency;
}

export interface PostChargeInput {
  folio_id: string;
  business_date: string;
  money: Money;
  tax_money?: Money;
  tax_policy?: Record<string, unknown>;
  policy_snapshot_id?: string;
  account_code?: string;
  source_ref: string;
  memo?: string;
}

export interface RouteChargeInput {
  allocations: Array<{ payer_folio_id: string; money: Money }>;
  memo?: string;
}

export interface CollectDepositInput {
  kind: FolioDeposit['kind'];
  method: FolioDeposit['method'];
  money: Money;
  business_date: string;
  external_reference: string;
  source_ref: string;
  evidence_ref?: string;
}

export interface RecordPaymentInput {
  folio_id: string;
  method: PaymentMethod;
  money: Money;
  currency?: Currency;
  gross_money?: Money;
  commission_money?: Money;
  business_date: string;
  external_reference: string;
  evidence_ref?: string;
  source_ref: string;
  certainty?: 'CONFIRMED' | 'UNKNOWN';
}

export interface IssueInvoiceInput {
  folio_id: string;
  series: string;
  kind?: FolioInvoice['kind'];
  source_ref: string;
  business_date: string;
  money: Money;
  tax_money?: Money;
  tax_policy?: Record<string, unknown>;
  account_code?: string;
}

function tenantRoot(tenantId: string, propertyId: string) {
  return `/api/v1/tenants/${tenantId}/properties/${propertyId}`;
}

function withQuery(base: string, params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
}

function idempotencyKey() {
  return crypto.randomUUID();
}

function write<T>(path: string, body?: unknown) {
  return api<T>(path, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey() },
  });
}

export const financeApi = {
  getBusinessDay: (tenantId: string, propertyId: string, date?: string) =>
    api<BusinessDayResult>(
      withQuery(`${tenantRoot(tenantId, propertyId)}/finance/business-day`, {
        date,
      }),
    ),
  listFolios: (
    tenantId: string,
    propertyId: string,
    params: { reservation_id?: string; state?: string } = {},
  ) =>
    api<{ folios: Folio[] }>(
      withQuery(`${tenantRoot(tenantId, propertyId)}/folios`, params),
    ),
  openFolio: (tenantId: string, propertyId: string, body: OpenFolioInput) =>
    write<{ folio: Folio }>(`${tenantRoot(tenantId, propertyId)}/folios`, body),
  getFolio: (tenantId: string, propertyId: string, folioId: string) =>
    api<FolioDetail>(`${tenantRoot(tenantId, propertyId)}/folios/${folioId}`),
  postCharge: (tenantId: string, propertyId: string, body: PostChargeInput) =>
    write<FolioCharge>(`${tenantRoot(tenantId, propertyId)}/charges`, body),
  routeCharge: (
    tenantId: string,
    propertyId: string,
    chargeId: string,
    body: RouteChargeInput,
  ) =>
    write<{
      charge_id: string;
      journal_id: string;
      allocations: Array<{
        id: string;
        payer_folio_id: string;
        amount: string;
      }>;
    }>(
      `${tenantRoot(tenantId, propertyId)}/charges/${chargeId}/allocations`,
      body,
    ),
  collectDeposit: (
    tenantId: string,
    propertyId: string,
    folioId: string,
    body: CollectDepositInput,
  ) =>
    write<{
      id: string;
      folio_id: string;
      kind: string;
      method: string;
      currency: Currency;
      amount: string;
      held_amount: string;
      external_reference: string;
      source_ref: string;
      journal_id: string;
    }>(`${tenantRoot(tenantId, propertyId)}/folios/${folioId}/deposits`, body),
  listPayments: (
    tenantId: string,
    propertyId: string,
    params: { folio_id?: string; state?: string } = {},
  ) =>
    api<{ payments: FolioPayment[] }>(
      withQuery(`${tenantRoot(tenantId, propertyId)}/payments`, params),
    ),
  recordPayment: (
    tenantId: string,
    propertyId: string,
    body: RecordPaymentInput,
  ) =>
    write<FolioPayment>(`${tenantRoot(tenantId, propertyId)}/payments`, body),
  reconcilePayment: (
    tenantId: string,
    propertyId: string,
    paymentId: string,
    body: {
      outcome: 'SUCCEEDED' | 'FAILED';
      reconciliation_reference?: string;
    },
  ) =>
    write<FolioPayment>(
      `${tenantRoot(tenantId, propertyId)}/payments/${paymentId}/reconcile`,
      body,
    ),
  requestRefund: (
    tenantId: string,
    propertyId: string,
    paymentId: string,
    body: { money: Money; reason: string },
  ) =>
    write<FolioRefund>(
      `${tenantRoot(tenantId, propertyId)}/payments/${paymentId}/refunds`,
      body,
    ),
  resolveRefund: (
    tenantId: string,
    propertyId: string,
    refundId: string,
    body: {
      outcome: FolioRefund['state'];
      approval_id?: string;
      evidence_ref?: string;
      external_reference?: string;
      reconciliation_reference?: string;
    },
  ) =>
    write<FolioRefund>(
      `${tenantRoot(tenantId, propertyId)}/refunds/${refundId}/resolve`,
      body,
    ),
  listInvoices: (
    tenantId: string,
    propertyId: string,
    params: { folio_id?: string } = {},
  ) =>
    api<{ invoices: FolioInvoice[] }>(
      withQuery(`${tenantRoot(tenantId, propertyId)}/invoices`, params),
    ),
  issueInvoice: (
    tenantId: string,
    propertyId: string,
    body: IssueInvoiceInput,
  ) =>
    write<FolioInvoice>(`${tenantRoot(tenantId, propertyId)}/invoices`, body),
  issueCreditNote: (
    tenantId: string,
    propertyId: string,
    invoiceId: string,
    body: { money: Money; reason: string; source_ref: string },
  ) =>
    write<FolioCreditNote>(
      `${tenantRoot(tenantId, propertyId)}/invoices/${invoiceId}/credit-notes`,
      body,
    ),
  listCashierSessions: (tenantId: string, propertyId: string) =>
    api<{ cashier_sessions: CashierSession[] }>(
      `${tenantRoot(tenantId, propertyId)}/cashier-sessions`,
    ),
  openCashierSession: (
    tenantId: string,
    propertyId: string,
    body: { currency?: Currency; opening_float?: string },
  ) =>
    write<CashierSession>(
      `${tenantRoot(tenantId, propertyId)}/cashier-sessions`,
      body,
    ),
  countCashierSession: (
    tenantId: string,
    propertyId: string,
    sessionId: string,
    body: { counted_money: string },
  ) =>
    write<CashierSession>(
      `${tenantRoot(tenantId, propertyId)}/cashier-sessions/${sessionId}/count`,
      body,
    ),
  closeCashierSession: (
    tenantId: string,
    propertyId: string,
    sessionId: string,
  ) =>
    write<CashierSession>(
      `${tenantRoot(tenantId, propertyId)}/cashier-sessions/${sessionId}/close`,
    ),
  getReservationClearance: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
  ) =>
    api<ReservationClearance>(
      `${tenantRoot(tenantId, propertyId)}/reservations/${reservationId}/clearance`,
    ),
  settleClearance: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    body: SettleClearanceInput,
  ) =>
    write<SettleClearanceResult>(
      `${tenantRoot(tenantId, propertyId)}/reservations/${reservationId}/clearance`,
      body,
    ),
  listExternalSettlements: (
    tenantId: string,
    propertyId: string,
    params: { reservation_id?: string; state?: string } = {},
  ) =>
    api<{ settlements: ExternalSettlement[] }>(
      withQuery(
        `${tenantRoot(tenantId, propertyId)}/external-settlements`,
        params,
      ),
    ),
};
