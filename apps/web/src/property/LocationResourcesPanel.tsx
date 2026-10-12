import { useQuery } from '@tanstack/react-query';
import { Button, Paper, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { propertyApi } from '../api/property.js';
import type { Resource } from '../api/property.js';
import type { LocationNode } from './LocationBrowser.js';
import { ErrorAlert } from '../identity/shared.js';
import { LoadingBlock } from '../identity/TenantSelectPage.js';

async function readAllResources(tenantId: string, propertyId: string) {
  const result: Resource[] = [],
    ids = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await propertyApi.listResourcePage(
      tenantId,
      propertyId,
      cursor,
      { limit: 100 },
    );
    for (const row of page.items) {
      if (ids.has(row.id)) throw new Error('Duplicate resource page entry');
      ids.add(row.id);
      result.push(row);
    }
    cursor = page.next_cursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('Resource cursor loop');
      cursors.add(cursor);
    }
  } while (cursor);
  return result;
}

async function readSubtree(
  tenantId: string,
  propertyId: string,
  selected: LocationNode[],
) {
  const root = selected.at(-1)!;
  const paths = new Map<string, LocationNode[]>([[root.id, selected]]);
  const queue = [root.id];
  for (const parent of queue) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await propertyApi.listLocationChildren(
        tenantId,
        propertyId,
        { parent_id: parent, limit: 200, cursor },
      );
      for (const node of page.items) {
        if (node.parent_id !== parent || paths.has(node.id))
          throw new Error('Invalid location subtree');
        paths.set(node.id, [...paths.get(parent)!, node]);
        queue.push(node.id);
      }
      cursor = page.next_cursor ?? undefined;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error('Location cursor loop');
        cursors.add(cursor);
      }
    } while (cursor);
  }
  return paths;
}

export function LocationResourcesPanel({
  tenantId,
  propertyId,
  path,
}: {
  tenantId: string;
  propertyId: string;
  path: LocationNode[];
}) {
  const { t } = useTranslation();
  const selected = path.at(-1);
  const resources = useQuery({
    queryKey: ['resources', tenantId, propertyId, 'location-browser-all'],
    queryFn: () => readAllResources(tenantId, propertyId),
    enabled: !!selected,
    staleTime: 30_000,
    retry: false,
  });
  const subtree = useQuery({
    queryKey: [
      'location-resource-subtree',
      tenantId,
      propertyId,
      ...path.map((node) => node.id),
    ],
    queryFn: () => readSubtree(tenantId, propertyId, path),
    enabled: !!selected,
    staleTime: 30_000,
    retry: false,
  });
  if (!selected)
    return <Typography>{t('locationRooms.selectLocation')}</Typography>;
  const error = resources.error ?? subtree.error;
  const fetching = resources.isFetching || subtree.isFetching;
  const complete =
    resources.isSuccess && subtree.isSuccess && !error && !fetching;
  const visible = complete
    ? resources.data.filter(
        (row) => row.location_id !== null && subtree.data.has(row.location_id),
      )
    : [];
  const rooms = visible
    .filter((row) => row.type === 'ROOM')
    .sort(
      (a, b) =>
        a.code.localeCompare(b.code, 'en', { numeric: true }) ||
        a.id.localeCompare(b.id, 'en'),
    );
  const others = visible.filter((row) => row.type !== 'ROOM');
  const renderUnit = (row: Resource) => (
    <Paper key={row.id} variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
      <Typography sx={{ overflowWrap: 'anywhere' }}>
        {row.display_label || row.code}
      </Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {row.code} · {t(`resourceTypes.${row.type}`)} ·{' '}
        {t('locationRooms.capacity', { count: row.capacity })}
      </Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {subtree.data
          ?.get(row.location_id!)
          ?.map((node) => node.name)
          .join(' / ')}
      </Typography>
    </Paper>
  );
  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Typography component="h3" variant="h6">
        {t('locationRooms.title', { name: selected.name })}
      </Typography>
      <Typography variant="body2">
        {t('locationRooms.includesDescendants')}
      </Typography>
      <ErrorAlert error={error} />
      {!error ? (
        <Button
          disabled={fetching}
          onClick={() => {
            void resources.refetch();
            void subtree.refetch();
          }}
        >
          {t('locationRooms.refresh')}
        </Button>
      ) : null}
      {error ? (
        <Button
          disabled={fetching}
          onClick={() => {
            void resources.refetch();
            void subtree.refetch();
          }}
        >
          {t('locationRooms.retry')}
        </Button>
      ) : null}
      {!error && !complete ? <LoadingBlock /> : null}
      {complete ? (
        <>
          <Typography>
            {t('locationRooms.roomCount', { count: rooms.length })}
          </Typography>
          {rooms.length ? (
            rooms.map(renderUnit)
          ) : (
            <Typography>{t('locationRooms.noRooms')}</Typography>
          )}
          {others.length ? (
            <>
              <Typography component="h4" variant="subtitle1">
                {t('locationRooms.otherUnits')}
              </Typography>
              {others.map(renderUnit)}
            </>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}
