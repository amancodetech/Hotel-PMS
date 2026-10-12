import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../api/client.js';
import type {
  ApprovalRequest,
  Membership,
  Permission,
  Role,
  RoleGrant,
} from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { DataTable, LoadingBlock, useTenantQuery } from './TenantSelectPage.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  ReasonDialog,
  actionLabel,
  formatDateTime,
  permissionCodeLabel,
  roleCodeLabel,
  roleLabel,
  useApiAction,
} from './shared.js';

function permissionLabel(
  t: (key: string) => string,
  permission: Permission,
): string {
  const translated = t(permission.description_key);
  return translated.startsWith('permissions.') ? permission.code : translated;
}

function PermissionPicker({
  catalog,
  selected,
  disabled,
  onChange,
}: {
  catalog: Permission[];
  selected: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const { t } = useTranslation();
  const grouped = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const permission of catalog) {
      const group = permission.code.split('.')[0] ?? 'other';
      map.set(group, [...(map.get(group) ?? []), permission]);
    }
    return [...map.entries()];
  }, [catalog]);
  return (
    <div className="permission-picker">
      {grouped.map(([group, permissions]) => (
        <fieldset key={group}>
          <legend>{t(`permissionGroup.${group}`)}</legend>
          {permissions.map((permission) => (
            <FormControlLabel
              key={permission.code}
              control={
                <Checkbox
                  checked={selected.includes(permission.code)}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, permission.code]
                        : selected.filter((code) => code !== permission.code),
                    )
                  }
                />
              }
              label={
                <span title={permission.code}>
                  {permissionLabel(t, permission)}
                </span>
              }
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function RoleDialog({
  open,
  role,
  catalog,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: Role | null;
  catalog: Permission[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const { run, error, busy } = useApiAction();
  const [code, setCode] = useState(role?.code ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<string[]>(
    role?.permission_codes ?? [],
  );
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{role ? t('editRole') : t('createRole')}</DialogTitle>
      <DialogContent className="dialog-form">
        <ErrorAlert error={error} />
        <TextField
          autoFocus
          required
          margin="dense"
          label={t('roleCode')}
          value={code}
          disabled={Boolean(role)}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          helperText={t('roleCodeHelp')}
        />
        <TextField
          required
          margin="dense"
          label={t('name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          margin="dense"
          label={t('description')}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <PermissionPicker
          catalog={catalog}
          selected={selected}
          disabled={busy || !hasPermission('role.manage')}
          onChange={setSelected}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !name.trim()}
          onClick={async () => {
            const result = await run(() =>
              role
                ? api(`/api/v1/tenants/${activeTenantId}/roles/${role.id}`, {
                    method: 'PATCH',
                    body: {
                      name,
                      description: description || null,
                      permission_codes: selected,
                    },
                  })
                : api(`/api/v1/tenants/${activeTenantId}/roles`, {
                    method: 'POST',
                    body: {
                      code,
                      name,
                      description: description || null,
                      permission_codes: selected,
                    },
                  }),
            );
            if (result) {
              onSaved();
              onClose();
            }
          }}
        >
          {t('save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function GrantDialog({
  open,
  memberships,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean;
  memberships: Membership[];
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { activeTenantId } = useAuth();
  const { run, error, setError, busy } = useApiAction();
  const [membershipId, setMembershipId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [effect, setEffect] = useState<'GRANT' | 'DENY'>('GRANT');
  const [scopeType, setScopeType] = useState<'TENANT' | 'PROPERTIES'>('TENANT');
  const [propertyRefs, setPropertyRefs] = useState('');
  const [reason, setReason] = useState('');
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);

  const body = () => ({
    membership_id: membershipId,
    role_id: roleId,
    effect,
    scope_type: scopeType,
    property_refs: propertyRefs
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    reason: reason || undefined,
  });

  const submit = async () => {
    try {
      const result = await run(
        () =>
          api(`/api/v1/tenants/${activeTenantId}/role-grants`, {
            method: 'POST',
            headers: approvalId ? { 'x-approval-id': approvalId } : {},
            body: body(),
          }),
        { refreshQueries: false, rethrow: true },
      );
      if (result) {
        onSaved();
        onClose();
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'APPROVAL_REQUIRED') {
        setNeedsApproval(true);
        setError(null);
      } else {
        setError(caught);
      }
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('grantRole')}</DialogTitle>
      <DialogContent className="dialog-form">
        <ErrorAlert error={error} />
        {needsApproval ? (
          <Alert severity="info">{t('approvalRequiredHelp')}</Alert>
        ) : null}
        {approvalId ? (
          <Alert severity="success">
            {t('approvalReady')} <code>{approvalId}</code>
          </Alert>
        ) : null}
        <FormControl fullWidth margin="dense">
          <InputLabel id="grant-member">{t('member')}</InputLabel>
          <Select
            labelId="grant-member"
            label={t('member')}
            value={membershipId}
            onChange={(event) => setMembershipId(event.target.value)}
          >
            {memberships.map((membership) => (
              <MenuItem key={membership.id} value={membership.id}>
                {membership.user_display_name ?? membership.user_email}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth margin="dense">
          <InputLabel id="grant-role">{t('role')}</InputLabel>
          <Select
            labelId="grant-role"
            label={t('role')}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
          >
            {roles.map((role) => (
              <MenuItem key={role.id} value={role.id}>
                {role.name} ({role.code})
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth margin="dense">
          <InputLabel id="grant-effect">{t('effect')}</InputLabel>
          <Select
            labelId="grant-effect"
            label={t('effect')}
            value={effect}
            onChange={(event) =>
              setEffect(event.target.value as 'GRANT' | 'DENY')
            }
          >
            <MenuItem value="GRANT">{t('effectGrant')}</MenuItem>
            <MenuItem value="DENY">{t('effectDeny')}</MenuItem>
          </Select>
        </FormControl>
        <FormControl fullWidth margin="dense">
          <InputLabel id="grant-scope">{t('scope')}</InputLabel>
          <Select
            labelId="grant-scope"
            label={t('scope')}
            value={scopeType}
            onChange={(event) =>
              setScopeType(event.target.value as 'TENANT' | 'PROPERTIES')
            }
          >
            <MenuItem value="TENANT">{t('scopeTenant')}</MenuItem>
            <MenuItem value="PROPERTIES">{t('scopeProperties')}</MenuItem>
          </Select>
        </FormControl>
        {scopeType === 'PROPERTIES' ? (
          <TextField
            fullWidth
            margin="dense"
            label={t('propertyRefs')}
            value={propertyRefs}
            onChange={(event) => setPropertyRefs(event.target.value)}
            helperText={t('propertyRefsHelp')}
          />
        ) : null}
        <TextField
          fullWidth
          margin="dense"
          label={t('reasonLabel')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        {needsApproval && !approvalId ? (
          <Button
            variant="outlined"
            disabled={busy}
            onClick={async () => {
              const result = await run(
                () =>
                  api<{ approval_request: ApprovalRequest }>(
                    `/api/v1/tenants/${activeTenantId}/approval-requests`,
                    {
                      method: 'POST',
                      body: {
                        action: 'role.grant',
                        payload: body(),
                        reason: reason || undefined,
                      },
                    },
                  ),
                { refreshQueries: false },
              );
              if (result) {
                setApprovalId(result.approval_request.id);
                setNeedsApproval(false);
              }
            }}
          >
            {t('requestApproval')}
          </Button>
        ) : null}
        <Button
          variant="contained"
          disabled={busy || !membershipId || !roleId}
          onClick={() => void submit()}
        >
          {t('grantRole')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function RolesPage() {
  const { t } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const [tab, setTab] = useState(0);
  const roles = useTenantQuery<{ roles: Role[] }>(
    'roles',
    activeTenantId,
    `/api/v1/tenants/${activeTenantId}/roles`,
  );
  const grants = useTenantQuery<{ grants: RoleGrant[] }>(
    'grants',
    activeTenantId,
    `/api/v1/tenants/${activeTenantId}/role-grants`,
  );
  const approvals = useTenantQuery<{ approval_requests: ApprovalRequest[] }>(
    'approvals',
    activeTenantId,
    `/api/v1/tenants/${activeTenantId}/approval-requests`,
  );
  const memberships = useTenantQuery<{ memberships: Membership[] }>(
    'memberships',
    activeTenantId,
    `/api/v1/tenants/${activeTenantId}/memberships`,
  );
  const permissions = useTenantQuery<{ permissions: Permission[] }>(
    'permission-catalog',
    activeTenantId ?? 'none',
    '/api/v1/permissions',
  );
  const { run, error, busy } = useApiAction();
  const [roleDialog, setRoleDialog] = useState<{
    open: boolean;
    role: Role | null;
  }>({ open: false, role: null });
  const [grantOpen, setGrantOpen] = useState(false);
  const [decision, setDecision] = useState<{
    approval: ApprovalRequest;
    decision: 'APPROVED' | 'REJECTED';
  } | null>(null);

  if (!activeTenantId) return <LoadingBlock />;
  if (!hasPermission('role.read'))
    return (
      <div>
        <PageHeader title={t('rolesTitle')} />
        <ForbiddenPanel />
      </div>
    );
  const catalog = permissions.data?.permissions ?? [];
  return (
    <div>
      <PageHeader
        title={t('rolesTitle')}
        description={t('rolesDescription')}
        action={
          tab === 0 && hasPermission('role.manage') ? (
            <Button
              variant="contained"
              onClick={() => setRoleDialog({ open: true, role: null })}
            >
              {t('createRole')}
            </Button>
          ) : tab === 1 && hasPermission('role.grant') ? (
            <Button variant="contained" onClick={() => setGrantOpen(true)}>
              {t('grantRole')}
            </Button>
          ) : null
        }
      />
      <ErrorAlert error={error} />
      <Tabs
        value={tab}
        onChange={(_event, value) => setTab(value)}
        aria-label={t('rolesTabs')}
      >
        <Tab label={t('rolesTab')} />
        <Tab label={t('grantsTab')} />
        <Tab label={t('approvalsTab')} />
      </Tabs>
      {tab === 0 ? (
        roles.isLoading ? (
          <LoadingBlock />
        ) : roles.error ? (
          <ErrorAlert error={roles.error} />
        ) : (
          <DataTable
            headers={[
              t('roleCode'),
              t('name'),
              t('type'),
              t('status'),
              t('permissionLabel'),
              t('actions'),
            ]}
            empty={t('noRoles')}
            rows={(roles.data?.roles ?? []).map((role) => [
              role.code,
              roleLabel(t, role),
              role.is_system ? t('systemRole') : t('customRole'),
              t(`roleStatus.${role.status}`),
              <div className="chip-row">
                {role.permission_codes.slice(0, 4).map((code) => (
                  <Chip
                    key={code}
                    size="small"
                    variant="outlined"
                    label={permissionCodeLabel(t, code)}
                    title={code}
                  />
                ))}
                {role.permission_codes.length > 4 ? (
                  <Chip
                    size="small"
                    label={`+${role.permission_codes.length - 4}`}
                  />
                ) : null}
              </div>,
              role.is_system ? (
                <Typography variant="caption">{t('systemLocked')}</Typography>
              ) : (
                <div className="row-actions">
                  <Button
                    size="small"
                    onClick={() => setRoleDialog({ open: true, role })}
                  >
                    {t('edit')}
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(t('confirmDeleteRole'))) return;
                      void run(() =>
                        api(
                          `/api/v1/tenants/${activeTenantId}/roles/${role.id}`,
                          { method: 'DELETE' },
                        ),
                      );
                    }}
                  >
                    {t('delete')}
                  </Button>
                </div>
              ),
            ])}
          />
        )
      ) : null}
      {tab === 1 ? (
        grants.isLoading ? (
          <LoadingBlock />
        ) : grants.error ? (
          <ErrorAlert error={grants.error} />
        ) : (
          <DataTable
            headers={[
              t('member'),
              t('role'),
              t('effect'),
              t('scope'),
              t('propertyRefs'),
              t('expiresAt'),
              t('actions'),
            ]}
            empty={t('noGrants')}
            rows={(grants.data?.grants ?? []).map((grant) => [
              memberships.data?.memberships.find(
                (membership) => membership.id === grant.membership_id,
              )?.user_email ?? grant.membership_id,
              grant.role_code
                ? roleCodeLabel(t, grant.role_code)
                : grant.role_id.slice(0, 8),
              grant.effect === 'GRANT' ? t('effectGrant') : t('effectDeny'),
              grant.scope_type === 'TENANT'
                ? t('scopeTenant')
                : t('scopeProperties'),
              grant.property_refs.join(', ') || '-',
              grant.revoked_at
                ? t('revoked')
                : formatDateTime(grant.expires_at),
              grant.revoked_at ? null : (
                <Button
                  size="small"
                  color="error"
                  disabled={busy || !hasPermission('role.grant')}
                  onClick={() =>
                    void run(() =>
                      api(
                        `/api/v1/tenants/${activeTenantId}/role-grants/${grant.id}/revoke`,
                        {
                          method: 'POST',
                          body: { reason: t('revokedByAdmin') },
                        },
                      ),
                    )
                  }
                >
                  {t('revoke')}
                </Button>
              ),
            ])}
          />
        )
      ) : null}
      {tab === 2 ? (
        approvals.isLoading ? (
          <LoadingBlock />
        ) : approvals.error ? (
          <ErrorAlert error={approvals.error} />
        ) : (
          <DataTable
            headers={[
              t('action'),
              t('requestedBy'),
              t('status'),
              t('expiresAt'),
              t('requestHash'),
              t('actions'),
            ]}
            empty={t('noApprovals')}
            rows={(approvals.data?.approval_requests ?? []).map((approval) => [
              actionLabel(t, approval.action),
              approval.requested_by,
              <Chip
                size="small"
                variant="outlined"
                label={t(`approvalStatus.${approval.status}`)}
              />,
              formatDateTime(approval.expires_at),
              <code title={approval.request_hash}>
                {approval.request_hash.slice(0, 12)}…
              </code>,
              approval.status === 'PENDING' &&
              hasPermission('approval.approve') ? (
                <div className="row-actions">
                  <Button
                    size="small"
                    onClick={() =>
                      setDecision({ approval, decision: 'APPROVED' })
                    }
                  >
                    {t('approve')}
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    onClick={() =>
                      setDecision({ approval, decision: 'REJECTED' })
                    }
                  >
                    {t('reject')}
                  </Button>
                </div>
              ) : null,
            ])}
          />
        )
      ) : null}

      <RoleDialog
        open={roleDialog.open}
        role={roleDialog.role}
        catalog={catalog}
        onClose={() => setRoleDialog({ open: false, role: null })}
        onSaved={() => void roles.refetch()}
      />
      <GrantDialog
        open={grantOpen}
        memberships={memberships.data?.memberships ?? []}
        roles={roles.data?.roles ?? []}
        onClose={() => setGrantOpen(false)}
        onSaved={() => {
          void grants.refetch();
          void approvals.refetch();
        }}
      />
      <ReasonDialog
        open={decision !== null}
        title={decision?.decision === 'APPROVED' ? t('approve') : t('reject')}
        confirmLabel={
          decision?.decision === 'APPROVED' ? t('approve') : t('reject')
        }
        required={false}
        onClose={() => setDecision(null)}
        onSubmit={(reason) => {
          const target = decision;
          setDecision(null);
          if (!target) return;
          void run(() =>
            api(
              `/api/v1/tenants/${activeTenantId}/approval-requests/${target.approval.id}/decide`,
              {
                method: 'POST',
                body: {
                  decision: target.decision,
                  permission: 'role.grant',
                  reason: reason || undefined,
                },
              },
            ),
          );
        }}
      />
    </div>
  );
}
