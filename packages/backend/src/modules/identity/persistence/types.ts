export interface UserRow {
  id: string;
  identity_subject: string;
  issuer: string;
  email: string | null;
  display_name: string | null;
  status: 'ACTIVE' | 'DISABLED';
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  active_tenant_id: string | null;
  csrf_token_hash: string;
  id_token: string | null;
  auth_methods: string[];
  auth_time: string | null;
  expires_at: string;
  revoked_at: string | null;
  rotated_from: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthFlowRow {
  id: string;
  state: string;
  nonce: string;
  code_verifier: string;
  redirect_after: string | null;
  browser_secret_hash: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: string;
  updated_at: string;
}

export interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  authz_version: number;
  joined_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MembershipViewRow extends MembershipRow {
  tenant_name: string;
  tenant_slug: string;
  tenant_status: string;
  user_email: string | null;
  user_display_name: string | null;
}

export interface RoleRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  is_system: boolean;
  status: 'ACTIVE' | 'RETIRED';
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RoleGrantRow {
  id: string;
  tenant_id: string;
  membership_id: string;
  role_id: string;
  effect: 'GRANT' | 'DENY';
  scope_type: 'TENANT' | 'PROPERTIES';
  granted_by: string | null;
  reason: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface EffectivePermissionRow {
  permission_code: string;
  effect: 'GRANT' | 'DENY';
  scope_type: 'TENANT' | 'PROPERTIES';
  property_ref: string | null;
  grant_id: string;
  expires_at: string | null;
}

export interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  role_id: string | null;
  scope_type: 'TENANT' | 'PROPERTIES';
  scope_refs: string[];
  token_hash: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  expires_at: string;
  used_at: string | null;
  created_by: string | null;
  accepted_by: string | null;
  invited_by_membership_id: string | null;
  role_version: number | null;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  tenant_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_hash: string;
  resource_version: number | null;
  currency: string | null;
  amount: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
  requested_by: string;
  decided_by: string | null;
  reason: string | null;
  decision_reason: string | null;
  consumed_at: string | null;
  consumed_by: string | null;
  consumed_resource_type: string | null;
  consumed_resource_id: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEventRow {
  id: string;
  tenant_id: string;
  property_id: string | null;
  actor_type: 'USER' | 'SERVICE';
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
  before_safe: Record<string, unknown> | null;
  after_safe: Record<string, unknown> | null;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}
