/**
 * Operational subledger account catalog (D-14): a balanced double-entry
 * subledger per currency, not a full general ledger. Codes are validated by
 * the database (`journal_line_account_check`) and mirrored here so producers
 * use one canonical vocabulary. New accounts are added with the package that
 * first posts to them.
 */
export const financeAccounts = {
  GUEST_FOLIO: 'FOLIO_GUEST',
  GUEST_RECEIVABLE: 'AR_GUEST',
  REVENUE_ROOM: 'REVENUE_ROOM',
  REVENUE_OTHER: 'REVENUE_OTHER',
  TAX_PAYABLE: 'TAX_PAYABLE',
  CASH: 'CASH',
  BANK: 'BANK',
  OTA_CLEARING: 'OTA_CLEARING',
  POS_CLEARING: 'POS_CLEARING',
  DEPOSIT_LIABILITY: 'DEPOSIT_LIABILITY',
  DAMAGE_DEPOSIT_LIABILITY: 'DAMAGE_DEPOSIT_LIABILITY',
  REFUND_CLEARING: 'REFUND_CLEARING',
  COMMISSION_EXPENSE: 'COMMISSION_EXPENSE',
  FX_CLEARING: 'FX_CLEARING',
  CASHIER_VARIANCE: 'CASHIER_VARIANCE',
  ROUNDING_DIFFERENCE: 'ROUNDING_DIFFERENCE',
} as const;

export type FinanceAccount =
  (typeof financeAccounts)[keyof typeof financeAccounts];

export const ACCOUNT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,31}$/;

export function isFinanceAccount(value: string): value is FinanceAccount {
  return Object.values(financeAccounts).includes(value as FinanceAccount);
}
