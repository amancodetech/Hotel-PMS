import type { MikroORM } from '@mikro-orm/postgresql';
import { runPlatformTransaction } from '../../../persistence/platform-context.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { addDecimal, roundHalfUp } from '../../inventory/domain/pricing.js';
import {
  assertIdempotencyKey,
  assertPlatformIsoDate,
  assertLabel,
  assertReason,
  formatPostingMoney,
  multiplyDecimal,
  normalizePosting,
  parseNonNegativeDecimal,
} from '../domain/validation.js';
import {
  findPlatformInvoiceById,
  findPlatformInvoiceByKey,
  findSubscriptionByTenant,
  insertPlatformInvoiceRow,
  insertPlatformInvoiceLine,
  listPlatformInvoiceLines,
  listPlatformInvoiceRows,
  nextInvoiceNumber,
  settlePlatformInvoiceRow,
  voidPlatformInvoiceRow,
} from '../persistence/platform-repository.js';
import type { PlatformInvoiceRow } from '../persistence/types.js';
import { authorizePlatform, type PlatformServiceContext } from './context.js';
import {
  recordPlatformAudit,
  recordTenantAuditAsPlatform,
} from './audit-service.js';

export interface InvoiceLineInput {
  description: unknown;
  quantity: unknown;
  unit_amount: unknown;
}

export interface InvoiceView {
  id: string;
  tenant_id: string;
  number: string;
  period_start: string;
  period_end: string;
  currency: string;
  total_amount: string;
  state: string;
  issued_at: string;
  voided_at: string | null;
  void_reason: string | null;
  settled_at: string | null;
  settlement_reference: string | null;
  notes: string | null;
}

export function platformInvoiceView(row: PlatformInvoiceRow): InvoiceView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    number: row.number,
    period_start: String(row.period_start).slice(0, 10),
    period_end: String(row.period_end).slice(0, 10),
    currency: row.currency,
    total_amount: normalizePosting(row.total_amount),
    state: row.state,
    issued_at: row.issued_at,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
    settled_at: row.settled_at,
    settlement_reference: row.settlement_reference,
    notes: row.notes,
  };
}

interface NormalizedLine {
  description: string;
  quantity: string;
  unitAmount: string;
  amount: string;
  scaledAmount: bigint;
}

function normalizeLines(value: unknown): NormalizedLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50)
    throw new IdentityError('INVALID_REQUEST', { field: 'lines' });
  const lines: NormalizedLine[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object')
      throw new IdentityError('INVALID_REQUEST', { field: `lines[${index}]` });
    const line = entry as Record<string, unknown>;
    const description = assertLabel(
      line['description'],
      `lines[${index}].description`,
      300,
    );
    const quantity = parseNonNegativeDecimal(
      line['quantity'],
      `lines[${index}].quantity`,
    );
    if (quantity <= 0n)
      throw new IdentityError('INVALID_REQUEST', {
        field: `lines[${index}].quantity`,
      });
    const unit = parseNonNegativeDecimal(
      line['unit_amount'],
      `lines[${index}].unit_amount`,
    );
    if (unit <= 0n && quantity > 0n) {
      // Zero unit amounts need an explicit documentary note; keep the rule
      // simple for the administrative ledger and reject them here.
      throw new IdentityError('INVALID_REQUEST', {
        field: `lines[${index}].unit_amount`,
      });
    }
    const scaledAmount = roundHalfUp(multiplyDecimal(quantity, unit), 2);
    lines.push({
      description,
      quantity: formatPostingQuantity(quantity),
      unitAmount: formatPostingMoney(unit),
      amount: formatPostingMoney(scaledAmount),
      scaledAmount,
    });
  }
  return lines;
}

function formatPostingQuantity(scaled: bigint): string {
  const rounded = roundHalfUp(scaled, 6);
  const negative = rounded < 0n;
  const absolute = negative ? -rounded : rounded;
  const factor = 10n ** 6n;
  const intPart = absolute / factor;
  const fraction = (absolute % factor)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart}${fraction ? `.${fraction}` : ''}`;
}

export async function issuePlatformInvoice(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  input: {
    period_start: unknown;
    period_end: unknown;
    currency: unknown;
    lines: unknown;
    notes?: unknown;
  },
  rawIdempotencyKey: unknown,
): Promise<
  InvoiceView & {
    lines: Array<{
      description: string;
      quantity: string;
      unit_amount: string;
      amount: string;
    }>;
    replayed: boolean;
  }
> {
  const idempotencyKey = assertIdempotencyKey(rawIdempotencyKey);
  const periodStart = assertPlatformIsoDate(input.period_start, 'period_start');
  const periodEnd = assertPlatformIsoDate(input.period_end, 'period_end');
  if (periodEnd <= periodStart)
    throw new IdentityError('INVALID_REQUEST', { field: 'period_end' });
  if (input.currency !== 'IDR' && input.currency !== 'USD')
    throw new IdentityError('INVALID_REQUEST', { field: 'currency' });
  const currency = input.currency;
  const lines = normalizeLines(input.lines);
  const notes =
    input.notes === undefined || input.notes === null
      ? null
      : assertLabel(input.notes, 'notes', 500);
  authorizePlatform(context.actor, 'platform.billing.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      const replay = await findPlatformInvoiceByKey(
        em,
        tenantId,
        idempotencyKey,
      );
      if (replay) return invoiceReplay(em, replay);
      const total = formatPostingMoney(
        addDecimal(lines.map((line) => line.scaledAmount)),
      );
      const number = await nextInvoiceNumber(em);
      const invoice = await insertPlatformInvoiceRow(em, {
        tenantId,
        number,
        periodStart,
        periodEnd,
        currency,
        totalAmount: total,
        issuedBy: context.actor.userId,
        notes,
        idempotencyKey,
        correlationId: context.correlationId,
      });
      if (!invoice) {
        const winner = await findPlatformInvoiceByKey(
          em,
          tenantId,
          idempotencyKey,
        );
        if (!winner) throw new IdentityError('CONFLICT');
        return invoiceReplay(em, winner);
      }
      for (const line of lines)
        await insertPlatformInvoiceLine(em, {
          tenantId,
          invoiceId: invoice.id,
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unitAmount,
          amount: line.amount,
        });
      await recordPlatformAudit(em, context, {
        tenantId,
        action: 'platform.invoice_issued',
        resourceType: 'PlatformInvoice',
        resourceId: invoice.id,
        outcome: 'SUCCESS',
        afterSafe: {
          number,
          currency,
          total_amount: total,
          period_start: periodStart,
          period_end: periodEnd,
        },
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId,
        action: 'platform.invoice_issued',
        resourceType: 'PlatformInvoice',
        resourceId: invoice.id,
        outcome: 'SUCCESS',
        afterSafe: { number, currency, total_amount: total },
      });
      return {
        ...platformInvoiceView(invoice),
        lines: lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unit_amount: line.unitAmount,
          amount: line.amount,
        })),
        replayed: false,
      };
    },
  );
}

async function invoiceReplay(
  em: Parameters<typeof listPlatformInvoiceLines>[0],
  invoice: PlatformInvoiceRow,
): Promise<
  InvoiceView & {
    lines: Array<{
      description: string;
      quantity: string;
      unit_amount: string;
      amount: string;
    }>;
    replayed: boolean;
  }
> {
  const lines = await listPlatformInvoiceLines(em, invoice.id);
  return {
    ...platformInvoiceView(invoice),
    lines: lines.map((line) => ({
      description: line.description,
      quantity: formatPostingQuantity(
        parseNonNegativeDecimal(line.quantity, 'quantity'),
      ),
      unit_amount: normalizePosting(line.unit_amount),
      amount: normalizePosting(line.amount),
    })),
    replayed: true,
  };
}

export async function listPlatformInvoices(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
): Promise<InvoiceView[]> {
  authorizePlatform(context.actor, 'platform.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      const invoices = await listPlatformInvoiceRows(em, tenantId);
      return invoices.map((row) => platformInvoiceView(row));
    },
  );
}

export async function voidPlatformInvoice(
  orm: MikroORM,
  context: PlatformServiceContext,
  invoiceId: string,
  input: { reason: unknown },
): Promise<InvoiceView> {
  const reason = assertReason(input.reason);
  authorizePlatform(context.actor, 'platform.billing.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const existing = await findPlatformInvoiceById(em, invoiceId);
      if (!existing) throw new IdentityError('NOT_FOUND');
      const updated = await voidPlatformInvoiceRow(em, {
        id: invoiceId,
        reason,
        voidedBy: context.actor.userId,
      });
      if (!updated)
        throw new IdentityError('PLATFORM_INVOICE_STATE', {
          state: existing.state,
        });
      await recordPlatformAudit(em, context, {
        tenantId: updated.tenant_id,
        action: 'platform.invoice_voided',
        resourceType: 'PlatformInvoice',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: existing.state },
        afterSafe: { state: updated.state, void_reason: reason },
        reason,
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId: updated.tenant_id,
        action: 'platform.invoice_voided',
        resourceType: 'PlatformInvoice',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        afterSafe: { state: updated.state, number: updated.number },
        reason,
      });
      return platformInvoiceView(updated);
    },
  );
}

export async function settlePlatformInvoice(
  orm: MikroORM,
  context: PlatformServiceContext,
  invoiceId: string,
  input: { reference: unknown },
): Promise<InvoiceView> {
  const reference = assertLabel(input.reference, 'reference', 200);
  authorizePlatform(context.actor, 'platform.billing.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const existing = await findPlatformInvoiceById(em, invoiceId);
      if (!existing) throw new IdentityError('NOT_FOUND');
      const updated = await settlePlatformInvoiceRow(em, {
        id: invoiceId,
        reference,
        settledBy: context.actor.userId,
        correlationId: context.correlationId,
      });
      if (!updated)
        throw new IdentityError('PLATFORM_INVOICE_STATE', {
          state: existing.state,
        });
      await recordPlatformAudit(em, context, {
        tenantId: updated.tenant_id,
        action: 'platform.invoice_settled',
        resourceType: 'PlatformInvoice',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: existing.state },
        afterSafe: {
          state: updated.state,
          settlement_reference: reference,
          manual_record: true,
        },
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId: updated.tenant_id,
        action: 'platform.invoice_settled',
        resourceType: 'PlatformInvoice',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        afterSafe: {
          state: updated.state,
          number: updated.number,
          manual_record: true,
        },
      });
      return platformInvoiceView(updated);
    },
  );
}
