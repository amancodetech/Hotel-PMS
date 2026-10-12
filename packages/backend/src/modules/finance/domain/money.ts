import {
  addDecimal,
  formatDecimal,
  parseDecimal,
  roundHalfUp,
} from '../../inventory/domain/pricing.js';
import { PropertyError } from '../../property/domain/errors.js';
import { ACCOUNT_CODE_PATTERN, financeAccounts } from './accounts.js';

/**
 * D-14 money model: balances and intermediate arithmetic carry six decimal
 * places, while every posted journal line is rounded HALF_UP to two decimal
 * places per line and then summed. The residual produced by per-line rounding
 * (never by silent editing of a posted amount) is declared as a separate
 * `ROUNDING_DIFFERENCE` line so the posted journal balances exactly.
 *
 * The decimal primitives are the shared ones owned by the pricing domain to
 * keep a single six-place representation across the product.
 */
export const INTERMEDIATE_SCALE = 6;
export const POSTING_SCALE = 2;
export const SUPPORTED_CURRENCIES = ['IDR', 'USD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export type LineSide = 'DEBIT' | 'CREDIT';

export interface MoneyLineInput {
  account_code: string;
  side: LineSide;
  amount: bigint;
}

export interface PostingLine {
  account_code: string;
  debit: string;
  credit: string;
}

export interface PostingPlan {
  lines: PostingLine[];
  total_debit: string;
  total_credit: string;
}

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function assertCurrency(value: string): SupportedCurrency {
  if (!isSupportedCurrency(value))
    throw new PropertyError('INVALID_REQUEST', {
      field: 'currency',
      reason: 'unsupported_currency',
    });
  return value;
}

/**
 * Validates the optional currency a caller attached to a transport money object
 * against the ledger currency that owns the amount (folio, charge, payment,
 * deposit or invoice). Omitting it keeps inference from the document; declaring
 * a different one is rejected instead of silently reinterpreting the amount.
 * No conversion is applied in this phase (D-11/D-14): one document is one
 * currency.
 */
export function assertMoneyCurrency(
  provided: string | null | undefined,
  expected: string,
  field: string,
): void {
  if (provided === null || provided === undefined || provided === '') return;
  if (assertCurrency(provided) !== expected)
    throw new PropertyError('INVALID_REQUEST', {
      field,
      reason: 'currency_mismatch',
      expected,
    });
}

/**
 * Parses a positive money amount with at most six decimal places. Strings are
 * required (AT-A02): binary floating point input or an unsupported shape is
 * rejected, and a non-positive amount is rejected.
 */
export function parsePositiveMoney(value: unknown, field: string): bigint {
  if (typeof value !== 'string')
    throw new PropertyError('INVALID_REQUEST', {
      field,
      reason: 'decimal_string_required',
    });
  const scaled = parseDecimal(value, field);
  if (scaled <= 0n)
    throw new PropertyError('INVALID_REQUEST', {
      field,
      reason: 'positive_amount_required',
    });
  return scaled;
}

/** HALF_UP rounding of an intermediate six-place amount to posting precision. */
export function roundPosting(scaled: bigint): bigint {
  return roundHalfUp(scaled, POSTING_SCALE);
}

export function formatMoney(scaled: bigint): string {
  return formatDecimal(scaled);
}

/**
 * Normalizes a numeric string coming back from PostgreSQL (`numeric(20,6)`
 * renders as `100.000000`) into the canonical money representation used in
 * transport responses and audit payloads.
 */
export function normalizeMoney(value: string): string {
  return formatDecimal(parseDecimal(value, 'amount'));
}

/**
 * Builds the immutable posted lines for a journal: every line is rounded
 * HALF_UP to two decimals per line, and any residual after summation becomes a
 * declared rounding-difference line. Amounts that would round to zero are
 * rejected instead of being silently dropped from a posted document.
 */
export function planPostingLines(
  inputs: readonly MoneyLineInput[],
): PostingPlan {
  if (inputs.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'lines' });
  const rounded: PostingLine[] = [];
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const input of inputs) {
    if (!ACCOUNT_CODE_PATTERN.test(input.account_code))
      throw new PropertyError('INVALID_REQUEST', {
        field: 'account_code',
      });
    if (input.side !== 'DEBIT' && input.side !== 'CREDIT')
      throw new PropertyError('INVALID_REQUEST', { field: 'side' });
    if (input.amount <= 0n)
      throw new PropertyError('INVALID_REQUEST', {
        field: 'amount',
        reason: 'positive_amount_required',
      });
    const amount = roundPosting(input.amount);
    if (amount === 0n)
      throw new PropertyError('FRACTION_NOT_SUPPORTED', {
        field: 'amount',
        reason: 'rounds_to_zero',
      });
    if (input.side === 'DEBIT') debitTotal += amount;
    else creditTotal += amount;
    rounded.push({
      account_code: input.account_code,
      debit: input.side === 'DEBIT' ? formatDecimal(amount) : '0',
      credit: input.side === 'CREDIT' ? formatDecimal(amount) : '0',
    });
  }
  const residual = debitTotal - creditTotal;
  if (residual !== 0n) {
    const amount = residual > 0n ? residual : -residual;
    rounded.push({
      account_code: financeAccounts.ROUNDING_DIFFERENCE,
      debit: residual < 0n ? formatDecimal(amount) : '0',
      credit: residual > 0n ? formatDecimal(amount) : '0',
    });
    if (residual > 0n) creditTotal += amount;
    else debitTotal += amount;
  }
  if (debitTotal !== creditTotal)
    throw new PropertyError('JOURNAL_UNBALANCED', {
      currency_hint: 'rounding_difference_failed',
    });
  return {
    lines: rounded,
    total_debit: formatDecimal(debitTotal),
    total_credit: formatDecimal(creditTotal),
  };
}

export function sumIntermediate(values: readonly bigint[]): bigint {
  return addDecimal(values);
}
