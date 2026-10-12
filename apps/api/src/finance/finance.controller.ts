import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  applyDeposit,
  collectDeposit,
  consumePackage,
  createChargeSchedule,
  createPackageEntitlement,
  getBusinessDay,
  getFolio,
  listFolios,
  openFolio,
  postCharge,
  postSchedulePeriod,
  reconcilePayment,
  recordPayment,
  releaseDeposit,
  routeCharge,
  runNightAudit,
  getPayment,
  listPayments,
  requestRefund,
  resolveRefund,
  reverseCharge,
  postAdjustment,
  requestFxApproval,
  recordFxSnapshot,
  listFxSnapshots,
  issueInvoice,
  issueCreditNote,
  listInvoices,
  openCashierSession,
  countCashierSession,
  closeCashierSession,
  listCashierSessions,
  getReservationClearance,
  settleClearance,
  listExternalSettlements,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import {
  applyDepositBody,
  businessDayQuery,
  collectDepositBody,
  consumePackageBody,
  createPackageBody,
  createScheduleBody,
  listFoliosQuery,
  nightAuditBody,
  openFolioBody,
  postChargeBody,
  postSchedulePeriodBody,
  reconcilePaymentBody,
  recordPaymentBody,
  releaseDepositBody,
  routeChargeBody,
  listPaymentsQuery,
  requestRefundBody,
  resolveRefundBody,
  reverseChargeBody,
  adjustmentBody,
  fxSnapshotBody,
  recordFxSnapshotBody,
  issueInvoiceBody,
  creditNoteBody,
  openCashierBody,
  countCashierBody,
  settleClearanceBody,
  listExternalSettlementsQuery,
} from './dto.js';

const uuid = z.string().uuid();

@Controller('api/v1/tenants')
export class FinanceController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/finance/business-day')
  async getBusinessDay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = businessDayQuery.parse(query);
    return getBusinessDay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input.date ?? null,
    );
  }

  @RequirePermission('business_day.close')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/night-audits')
  async runNightAudit(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = nightAuditBody.parse(body);
    return runNightAudit(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        business_date: input.business_date,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/folios')
  async listFolios(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listFoliosQuery.parse(query);
    return listFolios(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        reservation_id: input.reservation_id ?? null,
        state: input.state ?? null,
      },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/folios/:folioId')
  async getFolio(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('folioId') folioId: string,
  ) {
    return getFolio(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(folioId),
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/folios')
  async openFolio(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = openFolioBody.parse(body);
    return openFolio(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        reservation_id: input.reservation_id ?? null,
        kind: input.kind,
        payer_label: input.payer_label,
        currency: input.currency,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/charges')
  async postCharge(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = postChargeBody.parse(body);
    return postCharge(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        folio_id: input.folio_id,
        business_date: input.business_date,
        net_money: input.money.amount,
        currency: input.money.currency,
        tax_money: input.tax_money?.amount ?? null,
        tax_money_currency: input.tax_money?.currency ?? null,
        tax_policy: input.tax_policy ?? null,
        policy_snapshot_id: input.policy_snapshot_id ?? null,
        account_code: input.account_code ?? null,
        source_ref: input.source_ref,
        memo: input.memo ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/charges/:chargeId/allocations')
  async routeCharge(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('chargeId') chargeId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = routeChargeBody.parse(body);
    return routeCharge(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(chargeId),
      {
        allocations: input.allocations.map((allocation) => ({
          payer_folio_id: allocation.payer_folio_id,
          money: allocation.money.amount,
          currency: allocation.money.currency,
        })),
        memo: input.memo ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/folios/:folioId/charge-schedules')
  async createChargeSchedule(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('folioId') folioId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = createScheduleBody.parse(body);
    return createChargeSchedule(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(folioId),
      {
        code: input.code,
        account_code: input.account_code ?? null,
        quantity: input.quantity,
        net_money: input.money.amount,
        net_money_currency: input.money.currency,
        tax_money: input.tax_money?.amount ?? null,
        tax_money_currency: input.tax_money?.currency ?? null,
        tax_policy: input.tax_policy ?? null,
        currency: input.currency ?? null,
        interval: input.interval,
        starts_on: input.starts_on,
        ends_on: input.ends_on ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/charge-schedules/:scheduleId/post')
  async postSchedulePeriod(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('scheduleId') scheduleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = postSchedulePeriodBody.parse(body);
    return postSchedulePeriod(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(scheduleId),
      {
        business_date: input.business_date,
        period_start: input.period_start ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/folios/:folioId/packages')
  async createPackageEntitlement(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('folioId') folioId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = createPackageBody.parse(body);
    return createPackageEntitlement(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(folioId),
      {
        code: input.code,
        account_code: input.account_code ?? null,
        quantity_total: input.quantity_total,
        unit_net_money: input.unit_money.amount,
        unit_net_money_currency: input.unit_money.currency,
        unit_tax_money: input.unit_tax_money?.amount ?? null,
        unit_tax_money_currency: input.unit_tax_money?.currency ?? null,
        tax_policy: input.tax_policy ?? null,
        currency: input.currency ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/package-entitlements/:entitlementId/consumptions',
  )
  async consumePackage(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('entitlementId') entitlementId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = consumePackageBody.parse(body);
    return consumePackage(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(entitlementId),
      {
        quantity: input.quantity,
        source_ref: input.source_ref,
        business_date: input.business_date,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/folios/:folioId/deposits')
  async collectDeposit(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('folioId') folioId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = collectDepositBody.parse(body);
    return collectDeposit(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(folioId),
      {
        kind: input.kind,
        method: input.method,
        money: input.money.amount,
        money_currency: input.money.currency,
        business_date: input.business_date,
        external_reference: input.external_reference,
        source_ref: input.source_ref,
        evidence_ref: input.evidence_ref ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/deposits/:depositId/applications')
  async applyDeposit(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('depositId') depositId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = applyDepositBody.parse(body);
    return applyDeposit(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(depositId),
      {
        charge_id: input.charge_id,
        money: input.money.amount,
        money_currency: input.money.currency,
        business_date: input.business_date,
        reason: input.reason,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/payments')
  async listPayments(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listPaymentsQuery.parse(query);
    return listPayments(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        folio_id: input.folio_id ?? null,
        state: input.state ?? null,
      },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/payments/:paymentId')
  async getPayment(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('paymentId') paymentId: string,
  ) {
    return getPayment(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(paymentId),
    );
  }

  @RequirePermission('payment.record')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/payments')
  async recordPayment(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = recordPaymentBody.parse(body);
    return recordPayment(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        folio_id: input.folio_id,
        method: input.method,
        money: input.money.amount,
        money_currency: input.money.currency,
        currency: input.currency ?? null,
        gross_money: input.gross_money?.amount ?? null,
        gross_currency: input.gross_money?.currency ?? null,
        commission_money: input.commission_money?.amount ?? null,
        commission_currency: input.commission_money?.currency ?? null,
        business_date: input.business_date,
        external_reference: input.external_reference,
        evidence_ref: input.evidence_ref ?? null,
        source_ref: input.source_ref,
        certainty: input.certainty,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('payment.record')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/payments/:paymentId/reconcile')
  async reconcilePayment(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('paymentId') paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = reconcilePaymentBody.parse(body);
    return reconcilePayment(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(paymentId),
      {
        outcome: input.outcome,
        reconciliation_reference: input.reconciliation_reference ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/deposits/:depositId/releases')
  async releaseDeposit(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('depositId') depositId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = releaseDepositBody.parse(body);
    return releaseDeposit(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(depositId),
      {
        money: input.money.amount,
        money_currency: input.money.currency,
        business_date: input.business_date,
        reason: input.reason,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('payment.refund.request')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/payments/:paymentId/refunds')
  async requestRefund(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('paymentId') paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = requestRefundBody.parse(body);
    return requestRefund(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(paymentId),
      {
        money: input.money.amount,
        money_currency: input.money.currency,
        reason: input.reason,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('payment.refund.request')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/refunds/:refundId/resolve')
  async resolveRefund(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('refundId') refundId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = resolveRefundBody.parse(body);
    return resolveRefund(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(refundId),
      {
        outcome: input.outcome,
        approval_id: input.approval_id ?? null,
        evidence_ref: input.evidence_ref ?? null,
        external_reference: input.external_reference ?? null,
        reconciliation_reference: input.reconciliation_reference ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.adjust')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/charges/:chargeId/reversal')
  async reverseCharge(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('chargeId') chargeId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = reverseChargeBody.parse(body);
    return reverseCharge(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(chargeId),
      { reason: input.reason, idempotencyKey: idempotencyKey ?? null },
    );
  }

  @RequirePermission('folio.adjust')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/charges/:chargeId/adjustments')
  async postAdjustment(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('chargeId') chargeId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = adjustmentBody.parse(body);
    return postAdjustment(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(chargeId),
      {
        money: input.money.amount,
        money_currency: input.money.currency,
        direction: input.direction,
        account_code: input.account_code ?? null,
        reason: input.reason,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.adjust')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/fx-snapshots/requests')
  async requestFxApproval(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = fxSnapshotBody.parse(body);
    return requestFxApproval(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        pair: input.pair,
        rate: input.rate,
        effective_at: input.effective_at,
        source: input.source,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.adjust')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/fx-snapshots')
  async recordFxSnapshot(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = recordFxSnapshotBody.parse(body);
    return recordFxSnapshot(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        pair: input.pair,
        rate: input.rate,
        effective_at: input.effective_at,
        source: input.source,
        approval_id: input.approval_id,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/fx-snapshots')
  async listFxSnapshots(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    return listFxSnapshots(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('invoice.issue')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/invoices')
  async issueInvoice(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = issueInvoiceBody.parse(body);
    return issueInvoice(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        folio_id: input.folio_id,
        series: input.series,
        kind: input.kind,
        source_ref: input.source_ref,
        business_date: input.business_date,
        net_money: input.money.amount,
        net_money_currency: input.money.currency,
        tax_money: input.tax_money?.amount ?? null,
        tax_money_currency: input.tax_money?.currency ?? null,
        tax_policy: input.tax_policy ?? null,
        account_code: input.account_code ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('invoice.issue')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/invoices/:invoiceId/credit-notes')
  async issueCreditNote(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = creditNoteBody.parse(body);
    return issueCreditNote(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(invoiceId),
      {
        money: input.money.amount,
        money_currency: input.money.currency,
        reason: input.reason,
        source_ref: input.source_ref,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/invoices')
  async listInvoices(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query('folio_id') folioId: string | undefined,
  ) {
    return listInvoices(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      { folio_id: folioId ? uuid.parse(folioId) : null },
    );
  }

  @RequirePermission('cashier.operate')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/cashier-sessions')
  async openCashierSession(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = openCashierBody.parse(body);
    return openCashierSession(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        currency: input.currency ?? null,
        opening_float: input.opening_float ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('cashier.operate')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/cashier-sessions/:sessionId/count')
  async countCashierSession(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = countCashierBody.parse(body);
    return countCashierSession(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(sessionId),
      {
        counted_money: input.counted_money,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('cashier.operate')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/cashier-sessions/:sessionId/close')
  async closeCashierSession(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return closeCashierSession(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(sessionId),
      { idempotencyKey: idempotencyKey ?? null },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/cashier-sessions')
  async listCashierSessions(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    return listCashierSessions(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/reservations/:reservationId/clearance')
  async getReservationClearance(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
  ) {
    return getReservationClearance(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
    );
  }

  @RequirePermission('folio.charge')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/clearance',
  )
  async settleClearance(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = settleClearanceBody.parse(body);
    return settleClearance(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      {
        version: input.version,
        basis: input.basis,
        payer_folio_id: input.payer_folio_id ?? null,
        collection_plan_ref: input.collection_plan_ref ?? null,
        reason: input.reason ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/external-settlements')
  async listExternalSettlements(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listExternalSettlementsQuery.parse(query);
    return listExternalSettlements(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        reservation_id: input.reservation_id ?? null,
        state: input.state ?? null,
      },
    );
  }
}
