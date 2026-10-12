import { api } from './client.js';

export interface UsageCounter {
  metric: string;
  period_key: string;
  used: number;
  limit_value: number;
}

export interface PlatformTenantRow {
  tenant_id: string;
  tenant_slug: string;
  customer_label: string;
  plan_code: string;
  policy_version: number;
  state: string;
  version: number;
  entitlements: number;
  usage: UsageCounter[];
  lifecycle_events: number;
}

export interface PlatformPlan {
  code: string;
  name: string;
  status: string;
  policy_versions: number;
  created_at: string;
}

export interface PlatformAuditEvent {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface SupportGrant {
  id: string;
  tenant_id: string;
  platform_user_id: string;
  platform_user_email: string | null;
  scopes: string[];
  reason: string;
  granted_by_user_id: string;
  starts_at: string;
  expires_at: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
}

export interface LifecycleResult {
  tenant_id: string;
  tenant_slug: string;
  state: string;
  version: number;
  plan_code: string;
  policy_version: number;
  safety?: {
    writer?: string;
    sales_stops_applied?: number;
    sales_restrictions_reopened?: number;
    state_before?: string | null;
    deletions?: number;
    snapshot?: Record<string, unknown>;
  };
  expired_entitlements?: string[];
  repinned_policy_version?: number;
  replayed?: boolean;
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

export const platformApi = {
  listTenants: () =>
    api<{ items: PlatformTenantRow[] }>('/api/v1/platform/tenants'),
  listPlans: () => api<{ items: PlatformPlan[] }>('/api/v1/platform/plans'),
  listAudit: (tenantId?: string) =>
    api<{ items: PlatformAuditEvent[] }>(
      `/api/v1/platform/audit${tenantId ? `?tenant_id=${tenantId}` : ''}`,
    ),
  listSupportGrants: (tenantId?: string) =>
    api<{ items: SupportGrant[] }>(
      `/api/v1/platform/support-grants${tenantId ? `?tenant_id=${tenantId}` : ''}`,
    ),
  createSupportGrant: (input: {
    tenant_id: string;
    platform_user_email: string;
    scopes: string[];
    reason: string;
    expires_at: string;
  }) =>
    api<SupportGrant>('/api/v1/platform/support-grants', {
      method: 'POST',
      body: input,
      headers: { 'idempotency-key': idempotencyKey() },
    }),
  revokeSupportGrant: (grantId: string, reason: string) =>
    api<{ grant: SupportGrant }>(
      `/api/v1/platform/support-grants/${grantId}/revocation`,
      { method: 'POST', body: { reason } },
    ),
  suspendTenant: (tenantId: string, version: number, reason: string) =>
    api<LifecycleResult>(`/api/v1/platform/tenants/${tenantId}/suspension`, {
      method: 'POST',
      body: { reason },
      headers: {
        'idempotency-key': idempotencyKey(),
        'if-match': String(version),
      },
    }),
  reactivateTenant: (
    tenantId: string,
    version: number,
    reason: string,
    options: { acknowledgePolicyVersion?: boolean; resumeSales?: boolean } = {},
  ) =>
    api<LifecycleResult>(`/api/v1/platform/tenants/${tenantId}/reactivation`, {
      method: 'POST',
      body: {
        reason,
        acknowledge_policy_version: options.acknowledgePolicyVersion ?? false,
        resume_sales: options.resumeSales ?? false,
      },
      headers: {
        'idempotency-key': idempotencyKey(),
        'if-match': String(version),
      },
    }),
  closeTenant: (tenantId: string, version: number, reason: string) =>
    api<LifecycleResult>(`/api/v1/platform/tenants/${tenantId}/closure`, {
      method: 'POST',
      body: { reason },
      headers: {
        'idempotency-key': idempotencyKey(),
        'if-match': String(version),
      },
    }),
  readSupportProfile: (tenantId: string) =>
    api<{
      scope: string;
      tenant: { name: string; slug: string; status: string };
    }>('/api/v1/platform/support/tenant-profile', {
      method: 'POST',
      body: { tenant_id: tenantId },
    }),
  readSupportAudit: (tenantId: string) =>
    api<{ scope: string; events: PlatformAuditEvent[] }>(
      '/api/v1/platform/support/tenant-audit',
      { method: 'POST', body: { tenant_id: tenantId, limit: 20 } },
    ),
};
