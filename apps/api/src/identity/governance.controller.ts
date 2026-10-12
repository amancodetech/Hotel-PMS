import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  cancelApprovalRequest,
  createApprovalRequest,
  createCustomRole,
  decideApprovalRequest,
  deleteCustomRole,
  grantActionKey,
  grantHashInput,
  grantRoleToMembership,
  permissionCatalog,
  readApprovals,
  readGrants,
  readRoles,
  resolveGrantRole,
  revokeRoleGrantById,
  updateCustomRole,
} from '@hotel/backend';
import { IDENTITY } from './tokens.js';
import type { IdentityRuntime } from './runtime.js';
import { RequirePermission } from './guards.js';
import type { AuthedRequest } from './guards.js';
import { APPROVAL_HEADER, PROPERTY_HEADER } from './runtime.js';
import { headerString, requestCorrelation } from './http.js';
import { approvalDto, grantDto, roleDto } from './dto.js';

const uuid = z.string().uuid();
const optionalReason = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();
const roleBody = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).nullable().optional(),
    permission_codes: z.array(z.string().min(3).max(100)).max(100),
  })
  .strict();
const rolePatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    status: z.enum(['ACTIVE', 'RETIRED']).optional(),
    permission_codes: z.array(z.string().min(3).max(100)).max(100).optional(),
  })
  .strict();
const grantBody = z
  .object({
    membership_id: uuid,
    role_id: uuid,
    effect: z.enum(['GRANT', 'DENY']).optional(),
    scope_type: z.enum(['TENANT', 'PROPERTIES']),
    property_refs: z.array(uuid).max(100).optional(),
    expires_at: z.string().datetime().nullable().optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();
const invitationGrantBody = z
  .object({
    email: z.string().trim().email().max(320),
    role_id: uuid,
    scope_type: z.enum(['TENANT', 'PROPERTIES']),
    property_refs: z.array(uuid).max(100).optional(),
  })
  .strict();
const approvalBody = z
  .object({
    action: z.literal('role.grant'),
    payload: z.union([invitationGrantBody, grantBody]),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();
const approvalQuery = z
  .object({
    status: z
      .enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'])
      .optional(),
  })
  .strict();
const decideBody = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    permission: z
      .enum(['role.grant', 'payment.refund.request', 'folio.adjust'])
      .default('role.grant'),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

@Controller('api/v1/permissions')
export class PermissionsController {
  @Get()
  list() {
    return { permissions: permissionCatalog() };
  }
}

@Controller('api/v1/tenants/:tenantId/roles')
export class RolesController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('role.read')
  @Get()
  async list(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const roles = await readRoles(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      headerString(request, PROPERTY_HEADER),
    );
    return { roles: roles.map(roleDto) };
  }

  @RequirePermission('role.manage')
  @Post()
  async create(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const parsed = roleBody.parse(body);
    const role = await createCustomRole(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      code: parsed.code,
      name: parsed.name,
      description: parsed.description ?? null,
      permissionCodes: parsed.permission_codes,
      correlationId: requestCorrelation(request),
    });
    return { role: roleDto(role) };
  }

  @RequirePermission('role.manage')
  @Patch(':roleId')
  async update(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('roleId') roleId: string,
    @Body() body: unknown,
  ) {
    const parsed = rolePatch.parse(body);
    const role = await updateCustomRole(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      roleId: uuid.parse(roleId),
      name: parsed.name,
      description:
        parsed.description === undefined ? undefined : parsed.description,
      status: parsed.status,
      permissionCodes: parsed.permission_codes,
      correlationId: requestCorrelation(request),
    });
    return { role: roleDto(role) };
  }

  @RequirePermission('role.manage')
  @Delete(':roleId')
  async remove(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('roleId') roleId: string,
  ) {
    await deleteCustomRole(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      roleId: uuid.parse(roleId),
      correlationId: requestCorrelation(request),
    });
    return { deleted: true };
  }
}

@Controller('api/v1/tenants/:tenantId/role-grants')
export class RoleGrantsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('role.read')
  @Get()
  async list(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Query() query: unknown,
  ) {
    const parsed = z
      .object({ membership_id: uuid.optional() })
      .strict()
      .parse(query);
    const grants = await readGrants(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      parsed.membership_id ?? null,
      headerString(request, PROPERTY_HEADER),
    );
    return { grants: grants.map(grantDto) };
  }

  @RequirePermission('role.grant')
  @Post()
  async grant(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const parsed = grantBody.parse(body);
    const grant = await grantRoleToMembership(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      membershipId: parsed.membership_id,
      roleId: parsed.role_id,
      effect: parsed.effect ?? 'GRANT',
      scopeType: parsed.scope_type,
      propertyRefs: parsed.property_refs ?? [],
      expiresAt: parsed.expires_at ?? null,
      reason: parsed.reason ?? null,
      approvalId: headerString(request, APPROVAL_HEADER),
      correlationId: requestCorrelation(request),
    });
    return { grant: grantDto(grant) };
  }

  @RequirePermission('role.grant')
  @Post(':grantId/revoke')
  async revoke(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    const parsed = optionalReason.parse(body);
    await revokeRoleGrantById(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      grantId: uuid.parse(grantId),
      reason: parsed.reason ?? null,
      correlationId: requestCorrelation(request),
    });
    return { revoked: true };
  }
}

@Controller('api/v1/tenants/:tenantId/approval-requests')
export class ApprovalRequestsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('approval.read')
  @Get()
  async list(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Query() query: unknown,
  ) {
    const parsed = approvalQuery.parse(query);
    const approvals = await readApprovals(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      parsed.status ?? null,
      requestCorrelation(request),
      headerString(request, PROPERTY_HEADER),
    );
    return { approval_requests: approvals.map(approvalDto) };
  }

  @RequirePermission('role.grant')
  @Post()
  async create(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const parsed = approvalBody.parse(body);
    const payload = parsed.payload;
    const role = await resolveGrantRole(
      this.runtime.orm,
      request.auth!.actor,
      tenantId,
      payload.role_id,
    );
    const hashInput =
      'email' in payload
        ? grantHashInput({
            membershipId: null,
            roleId: role.id,
            effect: 'GRANT',
            scopeType: payload.scope_type,
            propertyRefs: payload.property_refs ?? [],
            expiresAt: null,
            email: payload.email,
          })
        : grantHashInput({
            membershipId: payload.membership_id,
            roleId: role.id,
            effect: payload.effect ?? 'GRANT',
            scopeType: payload.scope_type,
            propertyRefs: payload.property_refs ?? [],
            expiresAt: payload.expires_at ?? null,
          });
    const approval = await createApprovalRequest(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      permission: 'role.grant',
      actionKey: grantActionKey(
        'email' in payload ? 'GRANT' : (payload.effect ?? 'GRANT'),
        payload.scope_type,
      ),
      resourceType: 'role',
      resourceId: role.id,
      resourceVersion: role.version,
      hashInput,
      reason: parsed.reason ?? null,
      correlationId: requestCorrelation(request),
    });
    return { approval_request: approvalDto(approval) };
  }

  @RequirePermission('approval.approve')
  @Post(':approvalId/decide')
  async decide(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
  ) {
    const parsed = decideBody.parse(body);
    const approval = await decideApprovalRequest(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      approvalId: uuid.parse(approvalId),
      permission: parsed.permission,
      decision: parsed.decision,
      reason: parsed.reason ?? null,
      correlationId: requestCorrelation(request),
    });
    return { approval_request: approvalDto(approval) };
  }

  @Post(':approvalId/cancel')
  async cancel(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
  ) {
    const parsed = optionalReason.parse(body);
    const approval = await cancelApprovalRequest(this.runtime.orm, {
      actor: request.auth!.actor,
      tenantId,
      approvalId: uuid.parse(approvalId),
      reason: parsed.reason ?? null,
      correlationId: requestCorrelation(request),
    });
    return { approval_request: approvalDto(approval) };
  }
}
