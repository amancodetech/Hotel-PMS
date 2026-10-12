/**
 * Night audit step catalog (P10). Steps are stable keys with a fixed order and
 * one checkpoint row per property/business date (docs/25: "خطوة واحدة لكل
 * property/date/name"). The engine is resumable: each step commits its own
 * checkpoint so a killed worker continues from the first non-DONE step without
 * repeating a successful side effect.
 */
export const nightAuditSteps = [
  { key: 'PREPARE', order: 10 },
  { key: 'ARRIVALS', order: 20 },
  { key: 'DEPARTURES', order: 30 },
  { key: 'NIGHTLY_CHARGES', order: 40 },
  { key: 'BALANCES', order: 50 },
  { key: 'PAYMENTS_RECON', order: 60 },
  { key: 'VALIDATE', order: 70 },
  { key: 'CLOSING_BARRIER', order: 80 },
  { key: 'CLOSE_DAY', order: 90 },
  { key: 'FINALIZE', order: 100 },
] as const;

export type NightAuditStepKey = (typeof nightAuditSteps)[number]['key'];

export const nightAuditStepKeys = nightAuditSteps.map((step) => step.key);

export function stepOrder(key: NightAuditStepKey): number {
  const step = nightAuditSteps.find((entry) => entry.key === key);
  if (!step) throw new Error(`Unknown night audit step ${key}`);
  return step.order;
}

export type NightAuditRunState =
  'PENDING' | 'RUNNING' | 'VALIDATION_FAILED' | 'FAILED' | 'SUCCEEDED';

export type NightAuditStepState =
  'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

export type NightAuditExceptionSeverity = 'BLOCKING' | 'WARNING';

export type NightAuditExceptionState = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

/**
 * Exception codes emitted by the preparation/validation steps. BLOCKING
 * exceptions block the close until acknowledged with an owner and a reason;
 * WARNING exceptions are surfaced without blocking (docs/08: clear suspension
 * of an allowed exception is the property policy, not a server default).
 */
export const nightAuditExceptionCodes = {
  ARRIVAL_NOT_RESOLVED: {
    severity: 'BLOCKING',
    step: 'ARRIVALS',
    subject: 'RESERVATION_ITEM',
  },
  DEPARTURE_NOT_RESOLVED: {
    severity: 'BLOCKING',
    step: 'DEPARTURES',
    subject: 'RESERVATION_ITEM',
  },
  MISSING_FOLIO: {
    severity: 'BLOCKING',
    step: 'NIGHTLY_CHARGES',
    subject: 'RESERVATION',
  },
  MISSING_PRICE: {
    severity: 'BLOCKING',
    step: 'NIGHTLY_CHARGES',
    subject: 'RESERVATION_ITEM',
  },
  RATE_CURRENCY_MISMATCH: {
    severity: 'BLOCKING',
    step: 'NIGHTLY_CHARGES',
    subject: 'RESERVATION_ITEM',
  },
  OUTSTANDING_BALANCE: {
    severity: 'WARNING',
    step: 'BALANCES',
    subject: 'FOLIO',
  },
  PAYMENT_UNKNOWN: {
    severity: 'BLOCKING',
    step: 'PAYMENTS_RECON',
    subject: 'PAYMENT',
  },
} as const;

export type NightAuditExceptionCode = keyof typeof nightAuditExceptionCodes;

export function isNightAuditExceptionCode(
  value: string,
): value is NightAuditExceptionCode {
  return Object.hasOwn(nightAuditExceptionCodes, value);
}

export function exceptionDefinition(code: NightAuditExceptionCode): {
  severity: NightAuditExceptionSeverity;
  step: NightAuditStepKey;
  subject: string;
} {
  return nightAuditExceptionCodes[code];
}

export function runIsTerminal(state: string): boolean {
  return (
    state === 'SUCCEEDED' || state === 'VALIDATION_FAILED' || state === 'FAILED'
  );
}
