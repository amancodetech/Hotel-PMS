import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  acceptInvitation,
  changeMembershipStatus,
  IdentityError,
  inviteMember,
  readAuditForTenant,
  readEffectivePermissions,
  readGrants,
  readInvitations,
  readMemberships,
  readSelfMembership,
  revokeInvitationById,
} from '@hotel/backend';
import { IDENTITY } from './tokens.js';
import type { IdentityRuntime } from './runtime.js';
import { RequirePermission } from './guards.js';
import type { AuthedRequest } from './guards.js';
import { APPROVAL_HEADER, PROPERTY_HEADER } from './runtime.js';
import { headerString, requestCorrelation } from './http.js';
import { auditDto, grantDto, invitationDto, membershipDto } from './dto.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(300);
const statusBody = z.object({ reason }).strict();
const optionalReason = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();
const invitationBody = z
  .object({
    email: z.string().trim().email().max(320),
    role_id: uuid.nullable().optional(),
    scope_type: z.enum(['TENANT', 'PROPERTIES']).optional(),
    scope_refs: z.array(uuid).max(100).optional(),
    expires_in_hours: z.number().int().min(1).max(168).optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();
const acceptBody = z.object({ token: z.string().min(32).max(200) }).strict();
const auditQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

@Controller('api/v1/tenants')
export class TenantsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @Get()
  async listTenants(@Req() request: AuthedRequest) {
    const auth = request.auth;
    if (!auth) throw new IdentityError('AUTH_REQUIRED');
    const memberships = await this.runtime.auth.listMemberships(auth.session);
    return {
      tenants: memberships.map(membershipDto),
      active_tenant_id: auth.session.active_tenant_id,
    };
  }

  @HttpCode(200)
  @Post(':tenantId/select')
  async selectTenant(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const auth = request.auth;
    if (!auth) throw new IdentityError('AUTH_REQUIRED');
    const session = await this.runtime.auth.selectTenant(
      auth.session,
      uuid.parse(tenantId),
      requestCorrelation(request),
    );
    const memberships = await this.runtime.auth.listMemberships(session);
    const effective = await readEffectivePermissions(this.runtime.orm, {
      actor: auth.actor,
      tenantId: session.active_tenant_id!,
      membershipId: null,
    });
    return {
      active_tenant_id: session.active_tenant_id,
      memberships: memberships.map(membershipDto),
      permissions: effective.permissions,
      role_codes: effective.role_codes,
    };
  }

  @RequirePermission('tenant.read')
  @Get(':tenantId/me')
  async me(@Req() request: AuthedRequest, @Param('tenantId') tenantId: string) {
    const auth = request.auth!;
    const membership = await readSelfMembership(
      this.runtime.orm,
      auth.actor,
      tenantId,
    );
    const effective = await readEffectivePermissions(this.runtime.orm, {
      actor: auth.actor,
      tenantId,
      membershipId: membership.id,
      propertyRef: headerString(request, PROPERTY_HEADER),
    });
    return {
      membership: membershipDto(membership),
      role_codes: effective.role_codes,
      permissions: effective.permissions,
    };
  }

  @RequirePermission('membership.read')
  @Get(':tenantId/memberships')
  async listMemberships(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const memberships = await readMemberships(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      headerString(request, PROPERTY_HEADER),
    );
    return { memberships: memberships.map(membershipDto) };
  }

  @RequirePermission('membership.read')
  @Get(':tenantId/memberships/:membershipId/effective-permissions')
  async membershipPermissions(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
  ) {
    const effective = await readEffectivePermissions(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      membershipId: uuid.parse(membershipId),
      propertyRef: headerString(request, PROPERTY_HEADER),
    });
    return {
      membership_id: effective.membership_id,
      role_codes: effective.role_codes,
      permissions: effective.permissions,
    };
  }

  @RequirePermission('membership.read')
  @Get(':tenantId/memberships/:membershipId/grants')
  async membershipGrants(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
  ) {
    const grants = await readGrants(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      uuid.parse(membershipId),
      headerString(request, PROPERTY_HEADER),
    );
    return { grants: grants.map(grantDto) };
  }

  @RequirePermission('membership.manage')
  @Post(':tenantId/memberships/:membershipId/suspend')
  async suspend(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ) {
    const parsed = statusBody.parse(body);
    const membership = await changeMembershipStatus(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      membershipId: uuid.parse(membershipId),
      status: 'SUSPENDED',
      reason: parsed.reason,
      correlationId: requestCorrelation(request),
    });
    return { membership: membershipDto(membership) };
  }

  @RequirePermission('membership.manage')
  @Post(':tenantId/memberships/:membershipId/reactivate')
  async reactivate(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ) {
    const parsed = optionalReason.parse(body);
    const membership = await changeMembershipStatus(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      membershipId: uuid.parse(membershipId),
      status: 'ACTIVE',
      reason: parsed.reason ?? null,
      correlationId: requestCorrelation(request),
    });
    return { membership: membershipDto(membership) };
  }

  @RequirePermission('membership.revoke')
  @Post(':tenantId/memberships/:membershipId/revoke')
  async revoke(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ) {
    const parsed = statusBody.parse(body);
    const membership = await changeMembershipStatus(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      membershipId: uuid.parse(membershipId),
      status: 'REVOKED',
      reason: parsed.reason,
      correlationId: requestCorrelation(request),
    });
    return { membership: membershipDto(membership) };
  }

  @RequirePermission('membership.read')
  @Get(':tenantId/invitations')
  async listInvitations(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const invitations = await readInvitations(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      headerString(request, PROPERTY_HEADER),
    );
    return { invitations: invitations.map((row) => invitationDto(row)) };
  }

  @RequirePermission('membership.invite')
  @Post(':tenantId/invitations')
  async createInvitation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const parsed = invitationBody.parse(body);
    const result = await inviteMember(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      email: parsed.email,
      roleId: parsed.role_id ?? null,
      scopeType: parsed.scope_type ?? 'TENANT',
      scopeRefs: parsed.scope_refs ?? [],
      expiresInHours: parsed.expires_in_hours ?? 72,
      reason: parsed.reason ?? null,
      approvalId: headerString(request, APPROVAL_HEADER),
      correlationId: requestCorrelation(request),
    });
    return {
      invitation: invitationDto(
        { ...result.invitation, role_code: null },
        result.token,
      ),
    };
  }

  @RequirePermission('membership.invite')
  @Post(':tenantId/invitations/:invitationId/revoke')
  async revokeInvitation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
  ) {
    const parsed = optionalReason.parse(body);
    await revokeInvitationById(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      invitationId: uuid.parse(invitationId),
      reason: parsed.reason ?? null,
      correlationId: requestCorrelation(request),
    });
    return { revoked: true };
  }

  @RequirePermission('audit.read')
  @Get(':tenantId/audit-events')
  async auditEvents(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Query() query: unknown,
  ) {
    const parsed = auditQuery.parse(query);
    const events = await readAuditForTenant(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      {
        limit: parsed.limit,
        cursor: parsed.cursor ?? null,
      },
      headerString(request, PROPERTY_HEADER),
    );
    return { events: events.map(auditDto) };
  }
}

@Controller('api/v1')
export class InvitationsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @Post('invitations/accept')
  async accept(@Req() request: AuthedRequest, @Body() body: unknown) {
    const auth = request.auth;
    if (!auth) throw new IdentityError('AUTH_REQUIRED');
    const parsed = acceptBody.parse(body);
    const result = await acceptInvitation(this.runtime.orm, {
      actor: auth.actor,
      token: parsed.token,
      correlationId: requestCorrelation(request),
    });
    const memberships = await this.runtime.auth.listMemberships(auth.session);
    return {
      accepted: true,
      tenant_id: result.tenant_id,
      membership_id: result.membership_id,
      memberships: memberships.map(membershipDto),
    };
  }
}
