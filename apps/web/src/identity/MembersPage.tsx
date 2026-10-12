import { useState } from 'react';
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
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../api/client.js';
import type { Invitation, Membership, Role } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  ErrorAlert,
  PageHeader,
  ReasonDialog,
  formatDateTime,
  useApiAction,
} from './shared.js';
import {
  DataTable,
  LoadingBlock,
  MemberStatusChip,
  useTenantQuery,
} from './TenantSelectPage.js';
import { roleCodeLabel, roleLabel } from './shared.js';

interface InviteResult {
  invitation: Invitation;
}

function InviteDialog({
  open,
  roles,
  tenantId,
  basePath,
  onClose,
  onCreated,
}: {
  open: boolean;
  roles: Role[];
  tenantId: string;
  basePath: string;
  onClose: () => void;
  onCreated: (result: InviteResult) => void;
}) {
  const { t } = useTranslation();
  const { run, error, setError, busy } = useApiAction();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scopeType, setScopeType] = useState<'TENANT' | 'PROPERTIES'>('TENANT');
  const [propertyRefs, setPropertyRefs] = useState('');
  const [expires, setExpires] = useState(72);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const refs = () =>
    propertyRefs
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('inviteMember')}</DialogTitle>
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
        <TextField
          autoFocus
          required
          fullWidth
          margin="dense"
          type="email"
          label={t('email')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <FormControl fullWidth margin="dense">
          <InputLabel id="invite-role">{t('roleOptional')}</InputLabel>
          <Select
            labelId="invite-role"
            label={t('roleOptional')}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
          >
            <MenuItem value="">{t('noRole')}</MenuItem>
            {roles.map((role) => (
              <MenuItem key={role.id} value={role.id}>
                {roleLabel(t, role)} ({role.code})
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth margin="dense">
          <InputLabel id="invite-scope">{t('scope')}</InputLabel>
          <Select
            labelId="invite-scope"
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
          type="number"
          label={t('expiresInHours')}
          value={expires}
          onChange={(event) => setExpires(Number(event.target.value))}
          slotProps={{ htmlInput: { min: 1, max: 168 } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        {needsApproval && !approvalId ? (
          <Button
            variant="outlined"
            disabled={busy || !email.includes('@') || !roleId}
            onClick={async () => {
              const result = await run<{ approval_request: { id: string } }>(
                () =>
                  api<{ approval_request: { id: string } }>(
                    `/api/v1/tenants/${tenantId}/approval-requests`,
                    {
                      method: 'POST',
                      body: {
                        action: 'role.grant',
                        payload: {
                          email,
                          role_id: roleId,
                          scope_type: scopeType,
                          property_refs: refs(),
                        },
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
          disabled={busy || !email.includes('@')}
          onClick={async () => {
            try {
              const result = await run<InviteResult>(
                () =>
                  api<InviteResult>(`${basePath}/invitations`, {
                    method: 'POST',
                    headers: approvalId ? { 'x-approval-id': approvalId } : {},
                    body: {
                      email,
                      role_id: roleId || null,
                      scope_type: scopeType,
                      scope_refs: refs(),
                      expires_in_hours: expires,
                    },
                  }),
                { refreshQueries: false, rethrow: true },
              );
              if (result) {
                setEmail('');
                setRoleId('');
                setApprovalId(null);
                setNeedsApproval(false);
                onCreated(result);
              }
            } catch (caught) {
              if (
                caught instanceof ApiError &&
                caught.code === 'APPROVAL_REQUIRED'
              ) {
                setNeedsApproval(true);
                setError(null);
              } else {
                setError(caught);
              }
            }
          }}
        >
          {t('sendInvitation')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function MembersPage() {
  const { t } = useTranslation();
  const { activeTenantId, hasPermission, session } = useAuth();
  const memberships = useTenantQuery<{ memberships: Membership[] }>(
    'memberships',
    activeTenantId,
    `/api/v1/tenants/${activeTenantId}/memberships`,
  );
  const invitations = useTenantQuery<{ invitations: Invitation[] }>(
    'invitations',
    activeTenantId,
    `/api/v1/tenants/${activeTenantId}/invitations`,
  );
  const roles = useTenantQuery<{ roles: Role[] }>(
    'roles',
    activeTenantId,
    `/api/v1/tenants/${activeTenantId}/roles`,
  );
  const { run, error, busy } = useApiAction();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [statusTarget, setStatusTarget] = useState<{
    membership: Membership;
    status: 'SUSPENDED' | 'REVOKED';
  } | null>(null);
  const myId = session.authenticated
    ? session.memberships?.find(
        (membership) => membership.tenant_id === activeTenantId,
      )?.id
    : null;

  if (!activeTenantId) return <LoadingBlock />;
  const path = (suffix: string) => `/api/v1/tenants/${activeTenantId}${suffix}`;
  return (
    <div>
      <PageHeader
        title={t('membersTitle')}
        description={t('membersDescription')}
        action={
          hasPermission('membership.invite') ? (
            <Button variant="contained" onClick={() => setInviteOpen(true)}>
              {t('inviteMember')}
            </Button>
          ) : null
        }
      />
      <ErrorAlert error={error} />
      {createdToken ? (
        <Alert
          severity="info"
          onClose={() => setCreatedToken(null)}
          className="token-alert"
        >
          <Typography variant="body2">{t('invitationTokenOnce')}</Typography>
          <code>{createdToken}</code>
        </Alert>
      ) : null}
      <Typography component="h3" variant="h2" className="section-title">
        {t('membersTitle')}
      </Typography>
      {memberships.isLoading ? (
        <LoadingBlock />
      ) : memberships.error ? (
        <ErrorAlert error={memberships.error} />
      ) : (
        <DataTable
          headers={[t('name'), t('email'), t('status'), t('actions')]}
          empty={t('noMembers')}
          rows={(memberships.data?.memberships ?? []).map((membership) => [
            <>
              {membership.user_display_name ?? membership.user_email}
              {membership.id === myId ? ` (${t('selfLabel')})` : ''}
            </>,
            membership.user_email ?? '-',
            <MemberStatusChip membership={membership} />,
            <div className="row-actions">
              {membership.status === 'ACTIVE' &&
              hasPermission('membership.manage') ? (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    setStatusTarget({ membership, status: 'SUSPENDED' })
                  }
                >
                  {t('suspend')}
                </Button>
              ) : null}
              {membership.status === 'SUSPENDED' &&
              hasPermission('membership.manage') ? (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api(path(`/memberships/${membership.id}/reactivate`), {
                        method: 'POST',
                        body: {},
                      }),
                    )
                  }
                >
                  {t('reactivate')}
                </Button>
              ) : null}
              {membership.status !== 'REVOKED' &&
              hasPermission('membership.revoke') ? (
                <Button
                  size="small"
                  color="error"
                  disabled={busy}
                  onClick={() =>
                    setStatusTarget({ membership, status: 'REVOKED' })
                  }
                >
                  {t('revoke')}
                </Button>
              ) : null}
            </div>,
          ])}
        />
      )}

      <Typography component="h3" variant="h2" className="section-title">
        {t('invitationsTitle')}
      </Typography>
      {invitations.isLoading ? (
        <LoadingBlock />
      ) : invitations.error ? (
        <ErrorAlert error={invitations.error} />
      ) : (
        <DataTable
          headers={[
            t('email'),
            t('role'),
            t('scope'),
            t('status'),
            t('expiresAt'),
            t('actions'),
          ]}
          empty={t('noInvitations')}
          rows={(invitations.data?.invitations ?? []).map((invitation) => [
            invitation.email,
            invitation.role_code ? roleCodeLabel(t, invitation.role_code) : '-',
            invitation.scope_type === 'TENANT'
              ? t('scopeTenant')
              : t('scopeProperties'),
            <Chip
              size="small"
              variant="outlined"
              label={t(`invitationStatus.${invitation.status}`)}
            />,
            formatDateTime(invitation.expires_at),
            invitation.status === 'PENDING' &&
            hasPermission('membership.invite') ? (
              <Button
                size="small"
                color="error"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api(path(`/invitations/${invitation.id}/revoke`), {
                      method: 'POST',
                      body: { reason: t('revokedByAdmin') },
                    }),
                  )
                }
              >
                {t('revoke')}
              </Button>
            ) : null,
          ])}
        />
      )}

      <InviteDialog
        open={inviteOpen}
        roles={roles.data?.roles ?? []}
        tenantId={activeTenantId ?? ''}
        basePath={`/api/v1/tenants/${activeTenantId}`}
        onClose={() => setInviteOpen(false)}
        onCreated={(result) => {
          setInviteOpen(false);
          if (result.invitation.token) setCreatedToken(result.invitation.token);
        }}
      />
      <ReasonDialog
        open={statusTarget !== null}
        title={
          statusTarget?.status === 'REVOKED'
            ? t('confirmRevoke')
            : t('confirmSuspend')
        }
        confirmLabel={
          statusTarget?.status === 'REVOKED' ? t('revoke') : t('suspend')
        }
        onClose={() => setStatusTarget(null)}
        onSubmit={(reason) => {
          const target = statusTarget;
          setStatusTarget(null);
          if (!target) return;
          void run(() =>
            api(
              path(
                `/memberships/${target.membership.id}/${target.status === 'REVOKED' ? 'revoke' : 'suspend'}`,
              ),
              { method: 'POST', body: { reason } },
            ),
          );
        }}
      />
      <FormControlLabel
        checked
        disabled
        control={<Checkbox />}
        label={t('serverEnforced')}
        className="server-enforced"
      />
    </div>
  );
}
