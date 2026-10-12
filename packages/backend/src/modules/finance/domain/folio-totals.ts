import { parseDecimal } from '../../inventory/domain/pricing.js';

/**
 * Pure folio totals used by `GetFolio` and the P08-06 clearance view so both
 * surfaces report the same balance. The balance is derived from the posted
 * subledger facts:
 *
 *   balance = charges + corrections - routed out + routed in
 *             - deposits applied - resolved payments + resolved refunds
 *
 * `corrections` is the signed effect on the guest folio account of the
 * reversal/adjustment journals linked to this folio's charges (P08-04), so a
 * corrected charge no longer blocks clearance while the original document is
 * preserved (F-05). No currency conversion happens here: one folio is one
 * currency.
 */
export interface FolioChargeTotalRow {
  id: string;
  folio_id: string;
  net_amount: string;
  tax_amount: string;
}

export interface AllocationTotalRow {
  charge_id: string;
  payer_folio_id: string;
  amount: string;
}

export interface DepositTotalRow {
  amount: string;
  applied: string;
  released: string;
}

export interface ResolvedMoneyRow {
  state: string;
  amount: string;
}

export interface FolioTotals {
  charges_total: bigint;
  adjustments_total: bigint;
  routed_out: bigint;
  routed_in: bigint;
  deposits_held: bigint;
  deposits_applied: bigint;
  payments_total: bigint;
  refunds_total: bigint;
  balance_due: bigint;
}

function money(value: string): bigint {
  return parseDecimal(value, 'amount');
}

function sumStored(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + money(value), 0n);
}

export function computeFolioTotals(input: {
  folioId: string;
  charges: readonly FolioChargeTotalRow[];
  allocations: readonly AllocationTotalRow[];
  deposits: readonly DepositTotalRow[];
  payments: readonly ResolvedMoneyRow[];
  refunds: readonly ResolvedMoneyRow[];
  adjustments: bigint;
}): FolioTotals {
  const chargeById = new Map(
    input.charges.map((charge) => [charge.id, charge]),
  );
  const routedOut = input.allocations.filter(
    (allocation) =>
      chargeById.get(allocation.charge_id)?.folio_id === input.folioId &&
      allocation.payer_folio_id !== input.folioId,
  );
  const routedIn = input.allocations.filter(
    (allocation) =>
      allocation.payer_folio_id === input.folioId &&
      chargeById.get(allocation.charge_id)?.folio_id !== input.folioId,
  );
  const chargesTotal = sumStored(
    input.charges.map((charge) => charge.net_amount),
  );
  const chargesTax = sumStored(
    input.charges.map((charge) => charge.tax_amount),
  );
  const routedOutTotal = sumStored(routedOut.map((row) => row.amount));
  const routedInTotal = sumStored(routedIn.map((row) => row.amount));
  let depositsHeld = 0n;
  let depositsApplied = 0n;
  for (const deposit of input.deposits) {
    const applied = money(deposit.applied);
    depositsHeld += money(deposit.amount) - applied - money(deposit.released);
    depositsApplied += applied;
  }
  const paymentsTotal = sumStored(
    input.payments
      .filter((payment) => payment.state === 'SUCCEEDED')
      .map((payment) => payment.amount),
  );
  const refundsTotal = sumStored(
    input.refunds
      .filter((refund) => refund.state === 'SUCCEEDED')
      .map((refund) => refund.amount),
  );
  const balanceDue =
    chargesTotal +
    chargesTax +
    input.adjustments -
    routedOutTotal +
    routedInTotal -
    depositsApplied -
    paymentsTotal +
    refundsTotal;
  return {
    charges_total: chargesTotal + chargesTax,
    adjustments_total: input.adjustments,
    routed_out: routedOutTotal,
    routed_in: routedInTotal,
    deposits_held: depositsHeld,
    deposits_applied: depositsApplied,
    payments_total: paymentsTotal,
    refunds_total: refundsTotal,
    balance_due: balanceDue,
  };
}
