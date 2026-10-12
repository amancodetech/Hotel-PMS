import type { ImplementedOperation } from '../identity/operations.js';

export const phase10Operations: ImplementedOperation[] = [
  {
    operationId: 'GetNightAuditOverview',
    method: 'GET',
    path: '/api/v1/tenants/{tenantId}/properties/{propertyId}/night-audits',
    access: 'permission',
    permission: 'folio.read',
  },
  {
    operationId: 'ListNightAuditRuns',
    method: 'GET',
    path: '/api/v1/tenants/{tenantId}/properties/{propertyId}/night-audits/runs',
    access: 'permission',
    permission: 'folio.read',
  },
  {
    operationId: 'StartNightAudit',
    method: 'POST',
    path: '/api/v1/tenants/{tenantId}/properties/{propertyId}/night-audits/runs',
    access: 'permission',
    permission: 'business_day.close',
    csrf: true,
  },
  {
    operationId: 'RetryNightAudit',
    method: 'POST',
    path: '/api/v1/tenants/{tenantId}/properties/{propertyId}/night-audits/runs/{runId}/retry',
    access: 'permission',
    permission: 'business_day.close',
    csrf: true,
  },
  {
    operationId: 'ResolveNightAuditException',
    method: 'POST',
    path: '/api/v1/tenants/{tenantId}/properties/{propertyId}/night-audits/exceptions/{exceptionId}/resolution',
    access: 'permission',
    permission: 'business_day.close',
    csrf: true,
  },
];
