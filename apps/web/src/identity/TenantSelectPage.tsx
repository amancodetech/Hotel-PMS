import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import type { Membership } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { ErrorAlert, PageHeader, formatDateTime } from './shared.js';

export function TenantSelectPage() {
  const { t } = useTranslation();
  const { session, activeTenantId, selectTenant } = useAuth();
  const memberships =
    session.authenticated && session.memberships ? session.memberships : [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (memberships.length === 0)
    return (
      <div>
        <PageHeader title={t('selectTenant')} />
        <Alert severity="info">{t('noMemberships')}</Alert>
      </div>
    );
  return (
    <div>
      <PageHeader
        title={t('selectTenant')}
        description={t('selectTenantHelp')}
      />
      <ErrorAlert error={error} />
      <div className="tenant-grid">
        {memberships.map((membership) => (
          <Paper
            key={membership.id}
            component="section"
            className="tenant-card"
            elevation={0}
            variant="outlined"
          >
            <Typography component="h3" variant="h2">
              {membership.tenant_name}
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={t(`membershipStatus.${membership.status}`)}
              color={membership.status === 'ACTIVE' ? 'success' : 'default'}
            />
            <Button
              variant={
                membership.tenant_id === activeTenantId
                  ? 'outlined'
                  : 'contained'
              }
              disabled={membership.status !== 'ACTIVE' || busy !== null}
              onClick={async () => {
                setBusy(membership.tenant_id);
                setError(null);
                try {
                  await selectTenant(membership.tenant_id);
                } catch (caught) {
                  setError(caught);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {membership.tenant_id === activeTenantId
                ? t('currentTenant')
                : t('activateTenant')}
            </Button>
          </Paper>
        ))}
      </div>
      {activeTenantId ? (
        <Button component={Link} to="/members" className="tenant-continue">
          {t('continueToMembers')}
        </Button>
      ) : null}
    </div>
  );
}

export function useTenantQuery<T>(
  key: string,
  tenantId: string | null,
  path: string,
) {
  return useQuery({
    queryKey: [key, tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => api<T>(path),
  });
}

export function MemberStatusChip({ membership }: { membership: Membership }) {
  const { t } = useTranslation();
  return (
    <Chip
      size="small"
      variant="outlined"
      label={t(`membershipStatus.${membership.status}`)}
      color={membership.status === 'ACTIVE' ? 'success' : 'default'}
    />
  );
}

export function LoadingBlock() {
  const { t } = useTranslation();
  return (
    <div className="loading-block">
      <CircularProgress aria-label={t('loading')} size={28} />
    </div>
  );
}

export function EmptyBlock({ message }: { message: string }) {
  return (
    <Typography color="text.secondary" role="status">
      {message}
    </Typography>
  );
}

export function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: Array<Array<React.ReactNode>>;
  empty: string;
}) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            {headers.map((header, headerIndex) => (
              <TableCell key={`${header}-${headerIndex}`}>{header}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={headers.length}>
                <EmptyBlock message={empty} />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, index) => (
              <TableRow key={index}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={cellIndex}>{cell}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export { formatDateTime };
