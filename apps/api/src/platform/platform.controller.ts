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
  closePlatformTenant,
  createPlanPolicyVersion,
  createPlatformPlan,
  createPlatformSupportGrant,
  getTenantSubscription,
  issuePlatformInvoice,
  listPlanPolicyVersions,
  listPlatformAuditEvents,
  listPlatformInvoices,
  listPlatformPlans,
  listPlatformSupportGrants,
  listPlatformTenantLifecycle,
  listPlatformTenants,
  listPlatformUsage,
  onboardPlatformTenant,
  reactivatePlatformTenant,
  readPlatformSubscription,
  readPlatformSupportTenantAudit,
  readPlatformSupportTenantProfile,
  recordPlatformUsage,
  revokePlatformSupportGrant,
  setPlatformEntitlement,
  settlePlatformInvoice,
  suspendPlatformTenant,
  voidPlatformInvoice,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import {
  RequirePermission,
  RequirePlatformPermission,
} from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import { platformContext } from './platform-context.js';
import {
  createPlanBody,
  createPolicyVersionBody,
  issueInvoiceBody,
  lifecycleReasonBody,
  onboardTenantBody,
  platformAuditQuery,
  reactivationBody,
  recordUsageBody,
  revokeGrantBody,
  setEntitlementBody,
  settleInvoiceBody,
  supportGrantBody,
  supportGrantQuery,
  supportTenantBody,
  voidInvoiceBody,
} from './dto.js';

const uuid = z.string().uuid();

@Controller('api/v1')
export class PlatformController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePlatformPermission('platform.read')
  @Get('platform/plans')
  async listPlans(@Req() request: AuthedRequest) {
    const items = await listPlatformPlans(
      this.runtime.orm,
      platformContext(request),
    );
    return { items };
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(201)
  @Post('platform/plans')
  async createPlan(@Req() request: AuthedRequest, @Body() body: unknown) {
    const input = createPlanBody.parse(body);
    return createPlatformPlan(
      this.runtime.orm,
      platformContext(request),
      input,
    );
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/plans/:planCode/policy-versions')
  async listPolicyVersions(
    @Req() request: AuthedRequest,
    @Param('planCode') planCode: string,
  ) {
    const items = await listPlanPolicyVersions(
      this.runtime.orm,
      platformContext(request),
      planCode,
    );
    return { items };
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(201)
  @Post('platform/plans/:planCode/policy-versions')
  async createPolicyVersion(
    @Req() request: AuthedRequest,
    @Param('planCode') planCode: string,
    @Body() body: unknown,
  ) {
    const input = createPolicyVersionBody.parse(body);
    return createPlanPolicyVersion(
      this.runtime.orm,
      platformContext(request),
      planCode,
      input,
    );
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(201)
  @Post('platform/tenants')
  async onboardTenant(
    @Req() request: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = onboardTenantBody.parse(body);
    return onboardPlatformTenant(
      this.runtime.orm,
      platformContext(request),
      input,
      idempotencyKey,
    );
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(200)
  @Post('platform/tenants/:tenantId/suspension')
  async suspendTenant(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input = lifecycleReasonBody.parse(body);
    return suspendPlatformTenant(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
      input,
      idempotencyKey,
      ifMatch,
    );
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(200)
  @Post('platform/tenants/:tenantId/reactivation')
  async reactivateTenant(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input = reactivationBody.parse(body);
    return reactivatePlatformTenant(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
      input,
      idempotencyKey,
      ifMatch,
    );
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(200)
  @Post('platform/tenants/:tenantId/closure')
  async closeTenant(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input = lifecycleReasonBody.parse(body);
    return closePlatformTenant(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
      input,
      idempotencyKey,
      ifMatch,
    );
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/tenants/:tenantId/lifecycle')
  async tenantLifecycle(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const items = await listPlatformTenantLifecycle(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
    );
    return { items };
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/tenants/:tenantId/subscription')
  async readSubscription(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    return readPlatformSubscription(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
    );
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(200)
  @Post('platform/tenants/:tenantId/entitlements')
  async setEntitlement(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const input = setEntitlementBody.parse(body);
    return {
      entitlement: await setPlatformEntitlement(
        this.runtime.orm,
        platformContext(request),
        uuid.parse(tenantId),
        input,
      ),
    };
  }

  @RequirePlatformPermission('subscription.manage')
  @HttpCode(200)
  @Post('platform/tenants/:tenantId/usage')
  async recordUsage(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = recordUsageBody.parse(body);
    return recordPlatformUsage(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
      { ...input, idempotency_key: idempotencyKey },
    );
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/tenants/:tenantId/usage')
  async listUsage(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const items = await listPlatformUsage(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
    );
    return { items };
  }

  @RequirePlatformPermission('platform.billing.manage')
  @HttpCode(201)
  @Post('platform/tenants/:tenantId/invoices')
  async issueInvoice(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = issueInvoiceBody.parse(body);
    return issuePlatformInvoice(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
      input,
      idempotencyKey,
    );
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/tenants/:tenantId/invoices')
  async listInvoices(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const items = await listPlatformInvoices(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(tenantId),
    );
    return { items };
  }

  @RequirePlatformPermission('platform.billing.manage')
  @HttpCode(200)
  @Post('platform/invoices/:invoiceId/revocation')
  async revokeInvoice(
    @Req() request: AuthedRequest,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
  ) {
    const input = voidInvoiceBody.parse(body);
    return voidPlatformInvoice(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(invoiceId),
      input,
    );
  }

  @RequirePlatformPermission('platform.billing.manage')
  @HttpCode(200)
  @Post('platform/invoices/:invoiceId/settlement')
  async settleInvoice(
    @Req() request: AuthedRequest,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
  ) {
    const input = settleInvoiceBody.parse(body);
    return settlePlatformInvoice(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(invoiceId),
      input,
    );
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/tenants')
  async listTenants(@Req() request: AuthedRequest) {
    const items = await listPlatformTenants(
      this.runtime.orm,
      platformContext(request),
    );
    return { items };
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/audit')
  async listAudit(@Req() request: AuthedRequest, @Query() query: unknown) {
    const input = platformAuditQuery.parse(query);
    const items = await listPlatformAuditEvents(
      this.runtime.orm,
      platformContext(request),
      input.tenant_id ?? null,
      input.limit ?? 100,
    );
    return { items };
  }

  @RequirePlatformPermission('platform.support.manage')
  @HttpCode(201)
  @Post('platform/support-grants')
  async createSupportGrant(
    @Req() request: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = supportGrantBody.parse(body);
    return createPlatformSupportGrant(
      this.runtime.orm,
      platformContext(request),
      input,
      idempotencyKey,
    );
  }

  @RequirePlatformPermission('platform.support.manage')
  @HttpCode(200)
  @Post('platform/support-grants/:grantId/revocation')
  async revokeSupportGrant(
    @Req() request: AuthedRequest,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    const input = revokeGrantBody.parse(body);
    return {
      grant: await revokePlatformSupportGrant(
        this.runtime.orm,
        platformContext(request),
        uuid.parse(grantId),
        input,
      ),
    };
  }

  @RequirePlatformPermission('platform.read')
  @Get('platform/support-grants')
  async listSupportGrants(
    @Req() request: AuthedRequest,
    @Query() query: unknown,
  ) {
    const input = supportGrantQuery.parse(query);
    const items = await listPlatformSupportGrants(
      this.runtime.orm,
      platformContext(request),
      input.tenant_id ?? null,
    );
    return { items };
  }

  @RequirePlatformPermission('platform.support.read')
  @HttpCode(200)
  @Post('platform/support/tenant-profile')
  async readSupportTenantProfile(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ) {
    const input = supportTenantBody.parse(body);
    return readPlatformSupportTenantProfile(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(input.tenant_id),
    );
  }

  @RequirePlatformPermission('platform.support.read')
  @HttpCode(200)
  @Post('platform/support/tenant-audit')
  async readSupportTenantAudit(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ) {
    const input = supportTenantBody.parse(body);
    return readPlatformSupportTenantAudit(
      this.runtime.orm,
      platformContext(request),
      uuid.parse(input.tenant_id),
      input.limit ?? 50,
    );
  }

  @RequirePermission('subscription.read')
  @Get('tenants/:tenantId/subscription')
  async tenantSubscription(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    return getTenantSubscription(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(tenantId),
    );
  }
}
