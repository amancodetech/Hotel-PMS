import { useState } from 'react';
import type { ReactNode } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client.js';
import {
  Button,
  Paper,
  Stack,
  Typography,
  TextField,
  MenuItem,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { Phase4Components } from '@hotel/contracts';
import { propertyApi } from '../api/property.js';
import { ErrorAlert } from '../identity/shared.js';
import { LoadingBlock } from '../identity/TenantSelectPage.js';

export type LocationNode = Phase4Components['schemas']['LocationTreeNodeV2'];
type LocationBrowserProps = {
  tenantId: string;
  propertyId: string;
  onSelect?: (path: LocationNode[]) => void;
  rowActions?: (node: LocationNode) => ReactNode;
  excludedAncestorId?: string;
  selectionDisabled?: boolean;
  currentLocationContent?: (path: LocationNode[]) => ReactNode;
};

export function LocationBrowser(props: LocationBrowserProps) {
  return (
    <ScopedLocationBrowser
      key={`${props.tenantId}:${props.propertyId}`}
      {...props}
    />
  );
}

function ScopedLocationBrowser({
  tenantId,
  propertyId,
  onSelect,
  rowActions,
  excludedAncestorId,
  selectionDisabled = false,
  currentLocationContent,
}: LocationBrowserProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [parent, setParent] = useState<string>();
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'display_order' | 'code' | 'name'>(
    'display_order',
  );
  const [kind, setKind] = useState<NonNullable<LocationNode['kind']> | ''>('');
  const treeKey = [
    'location-tree',
    tenantId,
    propertyId,
    parent ?? null,
    query,
    sort,
    kind,
  ];
  const nodes = useInfiniteQuery({
    queryKey: treeKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      propertyApi.listLocationChildren(tenantId, propertyId, {
        parent_id: parent,
        limit: 25,
        cursor: pageParam,
        q: query,
        sort,
        ...(kind ? { kind } : {}),
      }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const ancestors = nodes.data?.pages[0]?.ancestors ?? [];
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography component="h3" variant="h6">
          {t('psrSetup.existingPlaces')}
        </Typography>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(queryInput.trim());
          }}
        >
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            flexWrap="wrap"
            gap={1}
          >
            <TextField
              fullWidth
              sx={{ width: { xs: '100%', sm: 360 }, flexShrink: 0 }}
              InputLabelProps={{ shrink: true }}
              label={t('psrSearch.placeQuery')}
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              inputProps={{ maxLength: 100 }}
            />
            <Button type="submit">{t('psrSearch.search')}</Button>
            <TextField
              fullWidth
              sx={{ width: { xs: '100%', sm: 220 }, flexShrink: 0 }}
              InputLabelProps={{ shrink: true }}
              select
              label={t('psrSearch.sort')}
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
            >
              {(['display_order', 'code', 'name'] as const).map((value) => (
                <MenuItem value={value} key={value}>
                  {t(`psrSearch.${value}`)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              fullWidth
              sx={{ width: { xs: '100%', sm: 220 }, flexShrink: 0 }}
              InputLabelProps={{ shrink: true }}
              select
              label={t('psrSearch.placeKind')}
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <MenuItem value="">{t('psrSearch.all')}</MenuItem>
              {(
                [
                  'ZONE',
                  'BUILDING',
                  'WING',
                  'FLOOR',
                  'CLUSTER',
                  'SERVICE_AREA',
                ] as const
              ).map((value) => (
                <MenuItem value={value} key={value}>
                  {t(`psrSetup.${value}`)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </form>
        <Stack
          direction="row"
          flexWrap="wrap"
          gap={1}
          aria-label={t('psrSetup.placePath')}
        >
          <Button onClick={() => setParent(undefined)}>
            {t('psrSetup.root')}
          </Button>
          {ancestors.map((node) => (
            <Button key={node.id} onClick={() => setParent(node.id)}>
              {node.name} · {node.code}
            </Button>
          ))}
        </Stack>
        <ErrorAlert error={nodes.error} />
        {nodes.isLoading && <LoadingBlock />}
        {nodes.isError && (
          <Button
            onClick={() =>
              void queryClient.resetQueries({ queryKey: treeKey, exact: true })
            }
          >
            {t(
              nodes.error instanceof ApiError && nodes.error.status === 412
                ? 'locationSetup.reloadTree'
                : 'psrSetup.retry',
            )}
          </Button>
        )}
        {!nodes.isLoading &&
          !nodes.isError &&
          nodes.data?.pages.every((page) => page.items.length === 0) && (
            <Typography>{t('locationRooms.noChildPlaces')}</Typography>
          )}
        {nodes.data?.pages
          .flatMap((page) => page.items)
          .map((node) => (
            <Stack
              key={node.id}
              direction={{ xs: 'column', sm: 'row' }}
              gap={1}
              alignItems={{ sm: 'center' }}
            >
              <Typography sx={{ flex: 1, overflowWrap: 'anywhere' }}>
                {node.name} · {node.code}
                <Typography component="span" variant="body2" display="block">
                  {node.kind
                    ? t(`psrSetup.${node.kind}`)
                    : t('locationSetup.unspecified')}
                  {' · '}
                  {t('locationSetup.displayOrder')}: {node.display_order ?? 0}
                  {' · '}
                  {t(`locationStatus.${node.status}`)}
                </Typography>
              </Typography>
              <Button
                disabled={nodes.isError}
                onClick={() => setParent(node.id)}
              >
                {t('psrSetup.browseChildren')}
              </Button>
              {onSelect ? (
                <Button
                  disabled={
                    selectionDisabled ||
                    nodes.isError ||
                    node.id === excludedAncestorId ||
                    ancestors.some((a) => a.id === excludedAncestorId) ||
                    node.status !== 'ACTIVE' ||
                    ancestors.some((a) => a.status !== 'ACTIVE')
                  }
                  onClick={() => onSelect([...ancestors, node])}
                >
                  {t('psrSetup.usePlace')}
                </Button>
              ) : null}
              {!nodes.isError ? rowActions?.(node) : null}
            </Stack>
          ))}
        {nodes.hasNextPage && (
          <Button
            disabled={nodes.isFetchingNextPage}
            onClick={() => void nodes.fetchNextPage()}
          >
            {t('psrSetup.morePlaces')}
          </Button>
        )}
        {!nodes.isLoading &&
          !nodes.isError &&
          (parent ? ancestors.at(-1)?.id === parent : ancestors.length === 0) &&
          currentLocationContent?.(ancestors)}
      </Stack>
    </Paper>
  );
}
