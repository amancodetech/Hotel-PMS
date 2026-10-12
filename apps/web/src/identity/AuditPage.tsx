import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Chip } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import type { AuditEvent } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  actionLabel,
  formatAuditDetails,
  formatDateTime,
  resourceLabel,
} from './shared.js';
import { DataTable, LoadingBlock } from './TenantSelectPage.js';

export function AuditPage() {
  const { t } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const query = useInfiniteQuery({
    queryKey: ['audit', activeTenantId],
    enabled: Boolean(activeTenantId) && hasPermission('audit.read'),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<{ events: AuditEvent[] }>(
        `/api/v1/tenants/${activeTenantId}/audit-events?limit=50${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    getNextPageParam: (last) =>
      last.events.length === 50
        ? `${last.events.at(-1)!.created_at}|${last.events.at(-1)!.id}`
        : null,
  });

  if (!activeTenantId) return <LoadingBlock />;
  if (!hasPermission('audit.read'))
    return (
      <div>
        <PageHeader title={t('auditTitle')} />
        <ForbiddenPanel />
      </div>
    );
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <div>
      <PageHeader title={t('auditTitle')} description={t('auditDescription')} />
      <ErrorAlert error={query.error} />
      {query.isLoading ? (
        <LoadingBlock />
      ) : (
        <>
          <DataTable
            headers={[
              t('date'),
              t('actor'),
              t('action'),
              t('resource'),
              t('outcome'),
              t('details'),
            ]}
            empty={t('noAuditEvents')}
            rows={events.map((event) => [
              formatDateTime(event.created_at),
              event.actor_label ?? event.actor_id ?? event.actor_type,
              actionLabel(t, event.action),
              `${resourceLabel(t, event.resource_type)}${
                event.resource_id ? ` · ${event.resource_id.slice(0, 8)}…` : ''
              }`,
              <Chip
                size="small"
                variant="outlined"
                color={event.outcome === 'SUCCESS' ? 'success' : 'error'}
                label={t(`auditOutcome.${event.outcome}`)}
              />,
              <span className="audit-details">
                {formatAuditDetails(
                  t,
                  event.before_safe,
                  event.after_safe,
                  event.reason,
                )}
              </span>,
            ])}
          />
          {query.hasNextPage ? (
            <Button
              className="load-more"
              variant="outlined"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
