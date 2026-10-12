import type {
  ApprovalRow,
  AuditEventRow,
  InvitationRow,
  MembershipViewRow,
  RoleGrantRow,
  RoleRow,
  SessionRow,
  UserRow,
} from '@hotel/backend';

export function userDto(user: UserRow) {
  return {
    id: user.id,
    display_name: user.display_name,
    email: user.email,
  };
}

export function membershipDto(membership: MembershipViewRow) {
  return {
    id: membership.id,
    tenant_id: membership.tenant_id,
    tenant_name: membership.tenant_name,
    tenant_slug: membership.tenant_slug,
    tenant_status: membership.tenant_status,
    user_id: membership.user_id,
    user_display_name: membership.user_display_name,
    user_email: membership.user_email,
    status: membership.status,
    authz_version: membership.authz_version,
    joined_at: membership.joined_at,
    revoked_at: membership.revoked_at,
  };
}

export function sessionDto(input: {
  session: SessionRow;
  user: UserRow;
  memberships: MembershipViewRow[];
  csrfToken?: string | null;
  mfa: boolean;
  permissions?: Array<{
    permission: string;
    granted: boolean;
    denied: boolean;
    tenant_scope: boolean;
    property_refs: string[];
  }> | null;
  platform?: {
    role_code: string;
    status: string;
    permissions: string[];
  } | null;
}) {
  return {
    authenticated: true as const,
    user: userDto(input.user),
    session: {
      id: input.session.id,
      active_tenant_id: input.session.active_tenant_id,
      expires_at: input.session.expires_at,
      auth_methods: input.session.auth_methods,
      mfa: input.mfa,
    },
    memberships: input.memberships.map(membershipDto),
    csrf_token: input.csrfToken ?? null,
    permissions: input.permissions ?? null,
    platform: input.platform ?? null,
  };
}

export function invitationDto(
  invitation: InvitationRow & { role_code?: string | null },
  token?: string,
) {
  return {
    id: invitation.id,
    email: invitation.email,
    role_id: invitation.role_id,
    role_code: invitation.role_code ?? null,
    scope_type: invitation.scope_type,
    scope_refs: invitation.scope_refs,
    status: invitation.status,
    expires_at: invitation.expires_at,
    used_at: invitation.used_at,
    created_at: invitation.created_at,
    ...(token ? { token } : {}),
  };
}

export function roleDto(role: RoleRow & { permission_codes: string[] }) {
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    is_system: role.is_system,
    status: role.status,
    version: role.version,
    permission_codes: role.permission_codes,
  };
}

export function grantDto(
  grant: RoleGrantRow & {
    role_code?: string;
    role_name?: string;
    property_refs?: string[] | null;
    granted_by_email?: string | null;
  },
) {
  return {
    id: grant.id,
    membership_id: grant.membership_id,
    role_id: grant.role_id,
    role_code: grant.role_code ?? null,
    role_name: grant.role_name ?? null,
    effect: grant.effect,
    scope_type: grant.scope_type,
    property_refs: grant.property_refs ?? [],
    granted_by_email: grant.granted_by_email ?? null,
    reason: grant.reason,
    expires_at: grant.expires_at,
    revoked_at: grant.revoked_at,
    version: grant.version,
    created_at: grant.created_at,
  };
}

export function auditDto(event: AuditEventRow) {
  return {
    id: event.id,
    property_id: event.property_id,
    actor_type: event.actor_type,
    actor_id: event.actor_id,
    actor_label: event.actor_label,
    action: event.action,
    resource_type: event.resource_type,
    resource_id: event.resource_id,
    outcome: event.outcome,
    before_safe: event.before_safe,
    after_safe: event.after_safe,
    reason: event.reason,
    correlation_id: event.correlation_id,
    created_at: event.created_at,
  };
}

export function approvalDto(approval: ApprovalRow) {
  return {
    id: approval.id,
    action: approval.action,
    resource_type: approval.resource_type,
    resource_id: approval.resource_id,
    request_hash: approval.request_hash,
    resource_version: approval.resource_version,
    currency: approval.currency,
    amount: approval.amount,
    status: approval.status,
    requested_by: approval.requested_by,
    decided_by: approval.decided_by,
    reason: approval.reason,
    decision_reason: approval.decision_reason,
    expires_at: approval.expires_at,
    decided_at: approval.decided_at,
    created_at: approval.created_at,
  };
}
