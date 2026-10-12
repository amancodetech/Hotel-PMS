import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useAuth } from '../auth/AuthProvider.js';
import { ApiError, errorKey } from '../api/client.js';
import { platformApi } from '../api/platform.js';
import type { PlatformTenantRow, SupportGrant } from '../api/platform.js';

type LifecycleAction = 'suspend' | 'reactivate' | 'close';

function StateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color =
    state === 'ACTIVE'
      ? 'success'
      : state === 'SUSPENDED'
        ? 'warning'
        : state === 'CLOSED'
          ? 'error'
          : 'default';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`platformState${state}`)}
    />
  );
}

function UsageSummary({ row }: { row: PlatformTenantRow }) {
  const { t } = useTranslation();
  if (row.usage.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        {t('platformNoUsage')}
      </Typography>
    );
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {row.usage.map((entry) => (
        <Chip
          key={entry.metric}
          size="small"
          label={`${entry.metric}: ${entry.used}/${entry.limit_value}`}
          color={entry.used >= entry.limit_value ? 'error' : 'default'}
          variant="outlined"
        />
      ))}
    </Stack>
  );
}

function ActionDialog({
  action,
  tenant,
  onClose,
  onDone,
}: {
  action: LifecycleAction | null;
  tenant: PlatformTenantRow | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [resumeSales, setResumeSales] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!action || !tenant) throw new Error('missing');
      if (action === 'suspend')
        return platformApi.suspendTenant(
          tenant.tenant_id,
          tenant.version,
          reason,
        );
      if (action === 'reactivate')
        return platformApi.reactivateTenant(
          tenant.tenant_id,
          tenant.version,
          reason,
          {
            acknowledgePolicyVersion: acknowledge,
            resumeSales,
          },
        );
      return platformApi.closeTenant(tenant.tenant_id, tenant.version, reason);
    },
    onSuccess: () => {
      onDone(
        t(
          `platform${action === 'suspend' ? 'Suspend' : action === 'reactivate' ? 'Reactivate' : 'Close'}Done`,
        ),
      );
      onClose();
    },
    onError: (caught: unknown) => {
      if (caught instanceof ApiError) {
        const details = caught.details as Record<string, unknown>;
        setError(
          caught.code === 'POLICY_VERSION_STALE'
            ? `${t('errors.POLICY_VERSION_STALE')} (${String(details.pinned)} → ${String(details.current)})`
            : errorKey(caught),
        );
      } else setError('errors.INTERNAL_ERROR');
    },
  });
  return (
    <Dialog open={action !== null} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {t(
          `platform${action === 'suspend' ? 'Suspend' : action === 'reactivate' ? 'Reactivate' : 'Close'}`,
        )}
        {tenant ? ` — ${tenant.customer_label}` : ''}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error ? <Alert severity="error">{t(error)}</Alert> : null}
          <TextField
            label={t('platformReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            multiline
            minRows={2}
            inputProps={{ maxLength: 500 }}
          />
          {action === 'reactivate' ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="platform-ack-label">
                  {t('platformAcknowledgePolicy')}
                </InputLabel>
                <Select
                  labelId="platform-ack-label"
                  label={t('platformAcknowledgePolicy')}
                  value={acknowledge ? 'yes' : 'no'}
                  onChange={(event) =>
                    setAcknowledge(event.target.value === 'yes')
                  }
                >
                  <MenuItem value="no">{t('no')}</MenuItem>
                  <MenuItem value="yes">{t('yes')}</MenuItem>
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="platform-resume-label">
                  {t('platformResumeSales')}
                </InputLabel>
                <Select
                  labelId="platform-resume-label"
                  label={t('platformResumeSales')}
                  value={resumeSales ? 'yes' : 'no'}
                  onChange={(event) =>
                    setResumeSales(event.target.value === 'yes')
                  }
                >
                  <MenuItem value="no">{t('no')}</MenuItem>
                  <MenuItem value="yes">{t('yes')}</MenuItem>
                </Select>
              </FormControl>
            </>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('platformCancel')}</Button>
        <Button
          variant="contained"
          disabled={reason.trim().length < 3 || mutation.isPending}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {t('platformConfirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SupportGrantDialog({
  tenant,
  onClose,
  onDone,
}: {
  tenant: PlatformTenantRow | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [scopes, setScopes] = useState<string[]>(['tenant.read']);
  const [minutes, setMinutes] = useState('15');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('missing');
      const duration = Number(minutes);
      if (!Number.isFinite(duration) || duration < 1 || duration > 1440)
        throw new ApiError('INVALID_REQUEST', 400, { field: 'minutes' });
      return platformApi.createSupportGrant({
        tenant_id: tenant.tenant_id,
        platform_user_email: email,
        scopes,
        reason,
        expires_at: new Date(Date.now() + duration * 60_000).toISOString(),
      });
    },
    onSuccess: () => {
      onDone(t('platformSupportGranted'));
      onClose();
    },
    onError: (caught: unknown) => setError(errorKey(caught)),
  });
  return (
    <Dialog open={tenant !== null} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {t('platformSupportCreate')}
        {tenant ? ` — ${tenant.customer_label}` : ''}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error ? <Alert severity="error">{t(error)}</Alert> : null}
          <TextField
            label={t('platformSupportGrantee')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
          />
          <FormControl fullWidth>
            <InputLabel id="platform-scopes-label">
              {t('platformSupportScopes')}
            </InputLabel>
            <Select
              labelId="platform-scopes-label"
              multiple
              label={t('platformSupportScopes')}
              value={scopes}
              onChange={(event) =>
                setScopes(
                  typeof event.target.value === 'string'
                    ? event.target.value.split(',')
                    : event.target.value,
                )
              }
            >
              <MenuItem value="tenant.read">
                {t('platformScopeTenantRead')}
              </MenuItem>
              <MenuItem value="audit.read">
                {t('platformScopeAuditRead')}
              </MenuItem>
            </Select>
          </FormControl>
          <TextField
            label={t('platformSupportDuration')}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            type="number"
            inputProps={{ min: 1, max: 1440 }}
          />
          <TextField
            label={t('platformReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            multiline
            minRows={2}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('platformCancel')}</Button>
        <Button
          variant="contained"
          disabled={
            scopes.length === 0 ||
            reason.trim().length < 3 ||
            email.length < 5 ||
            mutation.isPending
          }
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {t('platformConfirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SupportReadPanel({ tenant }: { tenant: PlatformTenantRow | null }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profile = useMutation({
    mutationFn: () => platformApi.readSupportProfile(tenant!.tenant_id),
    onSuccess: (data) => {
      setError(null);
      setResult(
        `${data.tenant.name} (${data.tenant.slug}) — ${data.tenant.status}`,
      );
    },
    onError: (caught: unknown) => {
      setResult(null);
      setError(errorKey(caught));
    },
  });
  const audit = useMutation({
    mutationFn: () => platformApi.readSupportAudit(tenant!.tenant_id),
    onSuccess: (data) => {
      setError(null);
      setResult(
        `${data.events.length} × ${t('platformAuditTitle')} (${data.scope})`,
      );
    },
    onError: (caught: unknown) => {
      setResult(null);
      setError(errorKey(caught));
    },
  });
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          variant="outlined"
          disabled={!tenant || profile.isPending}
          onClick={() => profile.mutate()}
        >
          {t('platformReadProfile')}
        </Button>
        <Button
          variant="outlined"
          disabled={!tenant || audit.isPending}
          onClick={() => audit.mutate()}
        >
          {t('platformReadAudit')}
        </Button>
      </Stack>
      <Typography variant="body2" data-testid="platform-support-result">
        {result ?? (error ? t(error) : t('platformSupportHint'))}
      </Typography>
    </Stack>
  );
}

export function PlatformPage() {
  const { t } = useTranslation();
  const { platform, hasPlatformPermission } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<LifecycleAction | null>(null);
  const [actionTenant, setActionTenant] = useState<PlatformTenantRow | null>(
    null,
  );
  const [grantTenant, setGrantTenant] = useState<PlatformTenantRow | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const tenants = useQuery({
    queryKey: ['platform-tenants'],
    queryFn: platformApi.listTenants,
    enabled: Boolean(platform),
  });
  const plans = useQuery({
    queryKey: ['platform-plans'],
    queryFn: platformApi.listPlans,
    enabled: Boolean(platform),
  });
  const grants = useQuery({
    queryKey: ['platform-grants', selected],
    queryFn: () => platformApi.listSupportGrants(selected ?? undefined),
    enabled: Boolean(platform),
  });
  const audit = useQuery({
    queryKey: ['platform-audit'],
    queryFn: () => platformApi.listAudit(),
    enabled: Boolean(platform),
  });
  const revoke = useMutation({
    mutationFn: (grant: SupportGrant) =>
      platformApi.revokeSupportGrant(grant.id, 'revoked from platform console'),
    onSuccess: () => {
      setNotice(t('platformSupportRevoked'));
      void queryClient.invalidateQueries({ queryKey: ['platform-grants'] });
    },
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-tenants'] });
    void queryClient.invalidateQueries({ queryKey: ['platform-audit'] });
  };
  const selectedTenant = useMemo(
    () => tenants.data?.items.find((row) => row.tenant_id === selected) ?? null,
    [tenants.data, selected],
  );
  const canManage = hasPlatformPermission('subscription.manage');
  const canSupport = hasPlatformPermission('platform.support.manage');

  if (!platform)
    return (
      <Alert severity="warning" data-testid="platform-forbidden">
        {t('platformForbidden')}
      </Alert>
    );
  return (
    <Stack spacing={3} data-testid="platform-page">
      <Typography variant="h2" component="h2">
        {t('platformTitle')}
      </Typography>
      <Alert severity="info">{t('platformMinimumData')}</Alert>
      {notice ? (
        <Alert severity="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}
      <Paper sx={{ p: 2 }}>
        <Typography variant="h3" component="h3" gutterBottom>
          {t('platformTenantDirectory')}
        </Typography>
        {tenants.isLoading ? (
          <CircularProgress aria-label={t('loading')} />
        ) : tenants.isError ? (
          <Alert severity="error">{t('requestError')}</Alert>
        ) : (
          <TableContainer>
            <Table size="small" data-testid="platform-tenants-table">
              <TableHead>
                <TableRow>
                  <TableCell>{t('platformCustomer')}</TableCell>
                  <TableCell>{t('platformState')}</TableCell>
                  <TableCell>{t('platformPlan')}</TableCell>
                  <TableCell>{t('platformUsage')}</TableCell>
                  <TableCell>{t('platformLifecycle')}</TableCell>
                  <TableCell align="right">{t('platformActions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(tenants.data?.items ?? []).map((row) => (
                  <TableRow
                    key={row.tenant_id}
                    hover
                    selected={row.tenant_id === selected}
                    onClick={() => setSelected(row.tenant_id)}
                  >
                    <TableCell>{row.customer_label}</TableCell>
                    <TableCell>
                      <StateChip state={row.state} />
                    </TableCell>
                    <TableCell>
                      {row.plan_code} v{row.policy_version}
                    </TableCell>
                    <TableCell>
                      <UsageSummary row={row} />
                    </TableCell>
                    <TableCell>{row.lifecycle_events}</TableCell>
                    <TableCell align="right">
                      {canManage ? (
                        <Stack
                          direction="row"
                          spacing={0.5}
                          justifyContent="flex-end"
                        >
                          <Button
                            size="small"
                            disabled={row.state !== 'ACTIVE'}
                            onClick={(event) => {
                              event.stopPropagation();
                              setActionTenant(row);
                              setAction('suspend');
                            }}
                          >
                            {t('platformSuspend')}
                          </Button>
                          <Button
                            size="small"
                            disabled={row.state !== 'SUSPENDED'}
                            onClick={(event) => {
                              event.stopPropagation();
                              setActionTenant(row);
                              setAction('reactivate');
                            }}
                          >
                            {t('platformReactivate')}
                          </Button>
                          <Button
                            size="small"
                            color="error"
                            disabled={row.state === 'CLOSED'}
                            onClick={(event) => {
                              event.stopPropagation();
                              setActionTenant(row);
                              setAction('close');
                            }}
                          >
                            {t('platformClose')}
                          </Button>
                        </Stack>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h3" component="h3" gutterBottom>
          {t('platformPlans')}
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {(plans.data?.items ?? []).map((plan) => (
            <Chip
              key={plan.code}
              label={`${plan.code} (${plan.policy_versions})`}
              variant="outlined"
            />
          ))}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
          useFlexGap
        >
          <Typography variant="h3" component="h3">
            {t('platformSupportGrants')}
          </Typography>
          {canSupport ? (
            <Button
              variant="contained"
              size="small"
              disabled={!selectedTenant}
              onClick={() => setGrantTenant(selectedTenant)}
            >
              {t('platformSupportCreate')}
            </Button>
          ) : null}
        </Stack>
        <Divider sx={{ my: 1 }} />
        {grants.isLoading ? (
          <CircularProgress aria-label={t('loading')} />
        ) : (
          <TableContainer>
            <Table size="small" data-testid="platform-grants-table">
              <TableHead>
                <TableRow>
                  <TableCell>{t('platformSupportGrantee')}</TableCell>
                  <TableCell>{t('platformSupportScopes')}</TableCell>
                  <TableCell>{t('platformGrantStatus')}</TableCell>
                  <TableCell>{t('platformSupportDuration')}</TableCell>
                  <TableCell align="right">{t('platformActions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(grants.data?.items ?? []).map((grant) => (
                  <TableRow key={grant.id}>
                    <TableCell>{grant.platform_user_email ?? '—'}</TableCell>
                    <TableCell>{grant.scopes.join(', ')}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={t(`platformGrant${grant.status}`)}
                        color={
                          grant.status === 'ACTIVE'
                            ? 'success'
                            : grant.status === 'EXPIRED'
                              ? 'warning'
                              : 'default'
                        }
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      {new Date(grant.expires_at).toISOString().slice(11, 16)}
                    </TableCell>
                    <TableCell align="right">
                      {canSupport && grant.status === 'ACTIVE' ? (
                        <Button
                          size="small"
                          color="error"
                          onClick={() => revoke.mutate(grant)}
                        >
                          {t('platformSupportRevoke')}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        <Divider sx={{ my: 1 }} />
        <SupportReadPanel tenant={selectedTenant} />
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h3" component="h3" gutterBottom>
          {t('platformAuditTitle')}
        </Typography>
        <TableContainer>
          <Table size="small" data-testid="platform-audit-table">
            <TableHead>
              <TableRow>
                <TableCell>{t('platformAuditAction')}</TableCell>
                <TableCell>{t('platformAuditActor')}</TableCell>
                <TableCell>{t('platformAuditTenant')}</TableCell>
                <TableCell>{t('platformAuditWhen')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(audit.data?.items ?? []).slice(0, 20).map((event) => (
                <TableRow key={event.id}>
                  <TableCell>{event.action}</TableCell>
                  <TableCell>{event.actor_role ?? '—'}</TableCell>
                  <TableCell>{event.tenant_id ?? '—'}</TableCell>
                  <TableCell>
                    {new Date(event.created_at).toISOString().slice(0, 19)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <ActionDialog
        action={action}
        tenant={actionTenant}
        onClose={() => setAction(null)}
        onDone={(message) => {
          setNotice(message);
          invalidate();
        }}
      />
      <SupportGrantDialog
        tenant={grantTenant}
        onClose={() => setGrantTenant(null)}
        onDone={(message) => {
          setNotice(message);
          void queryClient.invalidateQueries({ queryKey: ['platform-grants'] });
        }}
      />
    </Stack>
  );
}
