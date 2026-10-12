import { useState } from 'react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiError, errorKey } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-header">
      <div className="page-heading-copy">
        {eyebrow ? <span className="page-eyebrow">{eyebrow}</span> : null}
        <Typography component="h1" variant="h1">
          {title}
        </Typography>
        {description ? (
          <Typography color="text.secondary" variant="body2">
            {description}
          </Typography>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return <Alert severity="error">{t(errorKey(error))}</Alert>;
}

export function ForbiddenPanel() {
  const { t } = useTranslation();
  return (
    <Alert severity="warning" role="status">
      {t('permissionDenied')}
    </Alert>
  );
}

export function useApiAction() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(
    work: () => Promise<T>,
    options: {
      refreshSession?: boolean;
      refreshQueries?: boolean;
      rethrow?: boolean;
    } = {},
  ): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (options.refreshQueries !== false)
        await queryClient.invalidateQueries();
      if (options.refreshSession) await refresh();
      return result;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        window.dispatchEvent(new Event('hotel:session-changed'));
        void navigate('/login');
        if (options.rethrow) throw caught;
        return null;
      }
      if (options.rethrow) throw caught;
      setError(caught);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, setError, busy, t };
}

export function ReasonDialog({
  open,
  title,
  confirmLabel,
  required = true,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  required?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label={t('reasonLabel')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          helperText={required ? t('reasonRequired') : ' '}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={required && reason.trim().length < 3}
          onClick={() => {
            onSubmit(reason.trim());
            setReason('');
          }}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function translatedOrFallback(
  t: TFunction,
  key: string,
  fallback: string,
): string {
  const translated = t(key);
  return translated === key ? fallback : translated;
}

export function roleLabel(
  t: TFunction,
  role: { name: string; code: string },
): string {
  return translatedOrFallback(t, role.name, role.code);
}

export function roleCodeLabel(t: TFunction, code: string): string {
  return translatedOrFallback(t, `roles.${code}`, code);
}

export function permissionCodeLabel(t: TFunction, code: string): string {
  return translatedOrFallback(t, `permissions.${code}`, code);
}

export function actionLabel(t: TFunction, action: string): string {
  return translatedOrFallback(
    t,
    `auditAction.${action}`,
    action.replaceAll('.', ' / ').replaceAll('_', ' '),
  );
}

export function resourceLabel(t: TFunction, resource: string): string {
  return translatedOrFallback(
    t,
    `auditResource.${resource}`,
    resource.replaceAll('_', ' '),
  );
}

export function formatAuditDetails(
  t: TFunction,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  reason: string | null | undefined,
): string {
  const merged: Record<string, unknown> = {
    ...(before ?? {}),
    ...(after ?? {}),
    ...(reason ? { reason } : {}),
  };
  const parts: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined || value === '') continue;
    const keyName = `auditField.${key}`;
    const translatedKey = t(keyName);
    const label =
      translatedKey === keyName ? key.replaceAll('_', ' ') : translatedKey;
    let display = typeof value === 'string' ? value : JSON.stringify(value);
    for (const group of [
      'approvalStatus',
      'membershipStatus',
      'roleStatus',
      'invitationStatus',
      'auditOutcome',
      'auditFieldValue',
    ]) {
      const candidate = `${group}.${display}`;
      const translated = t(candidate);
      if (translated !== candidate) {
        display = translated;
        break;
      }
    }
    parts.push(`${label}: ${display}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '-';
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toISOString().replace('T', ' ').slice(0, 16);
}
