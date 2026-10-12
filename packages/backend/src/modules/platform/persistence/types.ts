export interface PlatformStaffRow {
  id: string;
  user_id: string;
  role_code: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformPlanRow {
  id: string;
  code: string;
  name: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanPolicyVersionRow {
  id: string;
  plan_id: string;
  version: number;
  effective_from: string;
  limits: Record<string, number>;
  entitlements: Record<string, boolean>;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PlatformSubscriptionRow {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  customer_label: string;
  plan_id: string;
  policy_version_id: string;
  plan_code: string;
  policy_version: number;
  policy_snapshot: Record<string, unknown>;
  state: string;
  version: number;
  started_at: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  reactivated_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformEntitlementRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  capability_code: string;
  state: string;
  limits: Record<string, number>;
  source: string;
  version: number;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformEntitlementEventRow {
  id: string;
  tenant_id: string;
  entitlement_id: string;
  capability_code: string;
  state: string;
  limits: Record<string, number>;
  source: string;
  effective_from: string;
  reason: string | null;
  actor_user_id: string | null;
  actor_label: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface PlatformUsageCounterRow {
  id: string;
  tenant_id: string;
  metric: string;
  period_key: string;
  used: bigint | number | string;
  limit_value: bigint | number | string;
  created_at: string;
  updated_at: string;
}

export interface PlatformUsageEventRow {
  id: string;
  tenant_id: string;
  metric: string;
  quantity: bigint | number | string;
  idempotency_key: string;
  correlation_id: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface PlatformUsageConsumeRow {
  outcome: string;
  used: bigint | number | string | null;
  limit_value: bigint | number | string | null;
}

export interface PlatformInvoiceRow {
  id: string;
  tenant_id: string;
  number: string;
  period_start: string;
  period_end: string;
  currency: string;
  total_amount: string;
  state: string;
  issued_by: string | null;
  issued_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  settled_at: string | null;
  settled_by: string | null;
  settlement_reference: string | null;
  notes: string | null;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformInvoiceLineRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  description: string;
  quantity: string;
  unit_amount: string;
  amount: string;
  created_at: string;
}

export interface PlatformAuditEventRow {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  before_safe: Record<string, unknown> | null;
  after_safe: Record<string, unknown> | null;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface PlatformLifecycleEventRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  event_type: string;
  state_before: string | null;
  state_after: string;
  reason: string | null;
  idempotency_key: string;
  snapshot: Record<string, unknown>;
  actor_user_id: string | null;
  actor_label: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface PlatformSupportGrantRow {
  id: string;
  tenant_id: string;
  platform_user_id: string;
  scopes: string[];
  reason: string;
  granted_by_user_id: string;
  starts_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  revoke_reason: string | null;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformOnboardingRequestRow {
  id: string;
  idempotency_key: string;
  fingerprint: string;
  tenant_id: string;
  response: Record<string, unknown>;
  actor_user_id: string | null;
  created_at: string;
}
