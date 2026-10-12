import { useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Tab,
  Table,
  TableBody,
  TableContainer,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { SetupProductSimulation } from './SetupProductSimulation.js';
import { UnitLocationPath } from './UnitLocationPath.js';
import { LocationBrowser } from './LocationBrowser.js';
import { LocationResourcesPanel } from './LocationResourcesPanel.js';
import type { LocationNode } from './LocationBrowser.js';
import { ApiError } from '../api/client.js';
import { ArchiveEntityDialog } from './ArchiveEntityDialog.js';
import { inventoryApi } from '../api/inventory.js';
import { propertyApi, resourceKinds } from '../api/property.js';
import type {
  Composition,
  Product,
  Property,
  Resource,
} from '../api/property.js';
import {
  CompositionChangeDialog,
  SettingsOverviewPanel,
} from './SetupInsightsPanels.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  ReasonDialog,
  useApiAction,
} from '../identity/shared.js';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';

interface PanelProps {
  tenantId: string;
  propertyId: string;
  property: Property;
}

function ChipFor({ prefix, value }: { prefix: string; value: string }) {
  const { t } = useTranslation();
  return (
    <Chip size="small" variant="outlined" label={t(`${prefix}.${value}`)} />
  );
}

function LocationsPanel({ tenantId, propertyId, property }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, setError, busy } = useApiAction();
  const canManage =
    useAuth().hasPermission('property.resource.manage') &&
    property.status !== 'ARCHIVED';
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LocationNode | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<NonNullable<LocationNode['kind']> | ''>('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [displayOrder, setDisplayOrder] = useState('0');
  const [archiveLocation, setArchiveLocation] = useState<{
    id: string;
    name: string;
  } | null>(null);
  type LocationValues = {
    name: string;
    kind: LocationNode['kind'];
    parent_id: string | null;
    display_order: number;
  };
  const [createIntent, setCreateIntent] = useState<{
    key: string;
    body: LocationValues & { code: string };
  } | null>(null);
  const [updateIntent, setUpdateIntent] = useState<{
    id: string;
    version: number;
    body: LocationValues;
  } | null>(null);
  const locked = busy || Boolean(createIntent || updateIntent);
  useEffect(() => {
    if (!locked) return;
    const guard = (event: Event) => event.preventDefault();
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('hotel:before-context-change', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('hotel:before-context-change', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [locked]);
  const order = Number(displayOrder);
  const validOrder =
    displayOrder.trim() !== '' &&
    Number.isInteger(order) &&
    order >= 0 &&
    order <= 2147483647;
  const unchanged =
    editing &&
    name.trim() === editing.name &&
    (kind || null) === (editing.kind ?? null) &&
    parentId === (editing.parent_id ?? null) &&
    order === (editing.display_order ?? 0);
  function fill(node: LocationNode | null) {
    setEditing(node);
    setCode(node?.code ?? '');
    setName(node?.name ?? '');
    setKind(node?.kind ?? '');
    setParentId(node?.parent_id ?? null);
    setDisplayOrder(String(node?.display_order ?? 0));
    setError(null);
    setCreateIntent(null);
    setUpdateIntent(null);
  }
  function close() {
    setOpen(false);
    fill(null);
  }
  async function readCurrent(id: string) {
    const page = await propertyApi.listLocationChildren(tenantId, propertyId, {
      parent_id: id,
      limit: 1,
    });
    const current = page.ancestors.find((node) => node.id === id);
    if (!current) throw new ApiError('NOT_FOUND', 404, {});
    return current;
  }
  function matches(node: LocationNode, values: LocationValues) {
    return (
      node.name === values.name &&
      (node.kind ?? null) === values.kind &&
      (node.parent_id ?? null) === values.parent_id &&
      (node.display_order ?? 0) === values.display_order
    );
  }
  async function save() {
    const values: LocationValues = {
      name: name.trim(),
      kind: kind || null,
      parent_id: parentId,
      display_order: order,
    };
    if (editing) {
      const intent = updateIntent ?? {
        id: editing.id,
        version: editing.version,
        body: values,
      };
      const recovering = Boolean(updateIntent);
      let attemptedWrite = false;
      try {
        if (updateIntent) {
          const current = await run(() => readCurrent(intent.id), {
            refreshQueries: false,
            rethrow: true,
          });
          if (!current) return;
          if (matches(current, intent.body)) {
            await run(async () => current);
            close();
            return;
          }
          if (current.version !== intent.version) {
            setEditing(current);
            setUpdateIntent(null);
            setError(new ApiError('STALE_VERSION', 409, {}));
            return;
          }
        }
        setUpdateIntent(intent);
        attemptedWrite = true;
        await run(
          () =>
            propertyApi.updateLocation(tenantId, propertyId, intent.id, {
              version: intent.version,
              ...intent.body,
            }),
          { rethrow: true },
        );
        close();
      } catch (caught) {
        setError(caught);
        if (
          !recovering &&
          attemptedWrite &&
          caught instanceof ApiError &&
          caught.status >= 400 &&
          caught.status < 500 &&
          caught.status !== 408
        )
          setUpdateIntent(null);
      }
    } else {
      const intent = createIntent ?? {
        key: crypto.randomUUID(),
        body: { code: code.trim(), ...values },
      };
      setCreateIntent(intent);
      try {
        await run(
          () =>
            propertyApi.createTreeLocation(
              tenantId,
              propertyId,
              intent.body,
              intent.key,
            ),
          { rethrow: true },
        );
        close();
      } catch (caught) {
        setError(caught);
        if (
          caught instanceof ApiError &&
          caught.status >= 400 &&
          caught.status < 500 &&
          caught.status !== 408
        )
          setCreateIntent(null);
      }
    }
  }
  return (
    <div>
      <ErrorAlert error={error} />
      <div className="row-actions">
        {canManage ? (
          <Button
            variant="outlined"
            disabled={locked}
            onClick={() => {
              fill(null);
              setOpen(true);
            }}
          >
            {t('newLocation')}
          </Button>
        ) : null}
      </div>
      <LocationBrowser
        tenantId={tenantId}
        propertyId={propertyId}
        currentLocationContent={(path) => (
          <LocationResourcesPanel
            tenantId={tenantId}
            propertyId={propertyId}
            path={path}
          />
        )}
        rowActions={(node) =>
          canManage && node.status === 'ACTIVE' ? (
            <>
              <Button
                size="small"
                disabled={locked}
                onClick={() => {
                  fill(node);
                  setOpen(true);
                }}
              >
                {t('edit')}
              </Button>
              <Button
                size="small"
                color="warning"
                disabled={locked}
                onClick={() => setArchiveLocation(node)}
              >
                {t('psrSetup.archive.action')}
              </Button>
            </>
          ) : null
        }
      />
      <Dialog
        open={open}
        onClose={() => {
          if (!locked) close();
        }}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {t(editing ? 'locationSetup.edit' : 'newLocation')}
        </DialogTitle>
        <DialogContent className="dialog-form">
          <ErrorAlert error={error} />
          {(createIntent || updateIntent) && !busy ? (
            <p role="status">{t('psrSetup.uncertain')}</p>
          ) : null}
          <TextField
            fullWidth
            margin="dense"
            label={t('locationCode')}
            value={code}
            disabled={locked || Boolean(editing)}
            inputProps={{ maxLength: 40 }}
            onChange={(event) => setCode(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('locationName')}
            value={name}
            disabled={locked}
            inputProps={{ maxLength: 160 }}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('locationSetup.kind')}
            value={kind}
            disabled={locked}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <MenuItem value="">{t('locationSetup.unspecified')}</MenuItem>
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
          <TextField
            fullWidth
            margin="dense"
            type="number"
            label={t('locationSetup.displayOrder')}
            value={displayOrder}
            disabled={locked}
            error={!validOrder}
            helperText={!validOrder ? t('locationSetup.orderRange') : undefined}
            inputProps={{ min: 0, max: 2147483647, step: 1 }}
            onChange={(event) => setDisplayOrder(event.target.value)}
          />
          <p>{t('psrSetup.parent')}</p>
          <UnitLocationPath
            tenantId={tenantId}
            propertyId={propertyId}
            locationId={parentId}
          />
          <Button disabled={locked} onClick={() => setParentId(null)}>
            {t('psrSetup.root')}
          </Button>
          <LocationBrowser
            key={editing?.id ?? 'create'}
            tenantId={tenantId}
            propertyId={propertyId}
            excludedAncestorId={editing?.id}
            selectionDisabled={locked}
            onSelect={(path) => setParentId(path.at(-1)?.id ?? null)}
          />
        </DialogContent>
        <DialogActions>
          {editing ? (
            <Button
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  const current = await readCurrent(editing.id);
                  fill(current);
                  return current;
                })
              }
            >
              {t('locationSetup.reload')}
            </Button>
          ) : null}
          <Button disabled={locked} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="contained"
            disabled={
              busy ||
              (!createIntent &&
                !updateIntent &&
                (!code.trim() ||
                  !name.trim() ||
                  !validOrder ||
                  Boolean(unchanged)))
            }
            onClick={() => void save()}
          >
            {t(createIntent || updateIntent ? 'psrSetup.retry' : 'save')}
          </Button>
        </DialogActions>
      </Dialog>
      {archiveLocation ? (
        <ArchiveEntityDialog
          key={archiveLocation.id}
          tenantId={tenantId}
          propertyId={propertyId}
          kind="LOCATION"
          id={archiveLocation.id}
          name={archiveLocation.name}
          onClose={() => setArchiveLocation(null)}
        />
      ) : null}
    </div>
  );
}

function ResourcesPanel({ tenantId, propertyId, property }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, setError, busy } = useApiAction();
  const canManage = useAuth().hasPermission('property.resource.manage');
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchSort, setSearchSort] = useState<'code' | 'label' | 'capacity'>(
    'code',
  );
  const [searchType, setSearchType] = useState('');
  const [minCapacity, setMinCapacity] = useState('');
  const [bedrooms, setBedrooms] = useState('');
  const [bathrooms, setBathrooms] = useState('');
  const searchFilters = {
    q: search,
    sort: searchSort,
    ...(searchType ? { type: searchType } : {}),
    ...(minCapacity ? { min_capacity: Number(minCapacity) } : {}),
    ...(bedrooms ? { bedrooms_count: Number(bedrooms) } : {}),
    ...(bathrooms ? { bathrooms_count: Number(bathrooms) } : {}),
    limit: 25,
  };
  const [type, setType] = useState<Resource['type']>('ROOM');
  const [capacity, setCapacity] = useState('2');
  const [locationId, setLocationId] = useState('');
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const [archiveResource, setArchiveResource] = useState<Resource | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editLocationId, setEditLocationId] = useState<string | null>(null);
  const resources = useInfiniteQuery({
    queryKey: ['resources', tenantId, propertyId, 'pages', searchFilters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      propertyApi.listResourcePage(
        tenantId,
        propertyId,
        pageParam,
        searchFilters,
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = resources.data?.pages.flatMap((page) => page.items) ?? [];
  void property;
  return (
    <div>
      <ErrorAlert error={error ?? resources.error} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchInput.trim());
        }}
      >
        <div className="row-actions">
          <TextField
            fullWidth
            sx={{ width: { xs: '100%', sm: 360 }, flexShrink: 0 }}
            InputLabelProps={{ shrink: true }}
            label={t('psrSearch.query')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            inputProps={{ maxLength: 100 }}
          />
          <Button type="submit">{t('psrSearch.search')}</Button>
          <TextField
            fullWidth
            sx={{ width: { xs: '100%', sm: 220 }, flexShrink: 0 }}
            InputLabelProps={{ shrink: true }}
            select
            label={t('psrSearch.sort')}
            value={searchSort}
            onChange={(e) =>
              setSearchSort(e.target.value as 'code' | 'label' | 'capacity')
            }
          >
            {(['code', 'label', 'capacity'] as const).map((value) => (
              <MenuItem key={value} value={value}>
                {t(`psrSearch.${value}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            sx={{ width: { xs: '100%', sm: 220 }, flexShrink: 0 }}
            InputLabelProps={{ shrink: true }}
            select
            label={t('resourceType')}
            value={searchType}
            onChange={(e) => setSearchType(e.target.value)}
          >
            <MenuItem value="">{t('psrSearch.all')}</MenuItem>
            {resourceKinds.map((value) => (
              <MenuItem key={value} value={value}>
                {t(`resourceTypes.${value}`)}
              </MenuItem>
            ))}
          </TextField>
          {(
            [
              ['minCapacity', minCapacity, setMinCapacity],
              ['bedrooms', bedrooms, setBedrooms],
              ['bathrooms', bathrooms, setBathrooms],
            ] as const
          ).map(([name, value, set]) => (
            <TextField
              fullWidth
              sx={{ width: { xs: '100%', sm: 220 }, flexShrink: 0 }}
              InputLabelProps={{ shrink: true }}
              key={name}
              type="number"
              label={t(`psrSearch.${name}`)}
              value={value}
              onChange={(e) => set(e.target.value)}
              inputProps={{ min: name === 'minCapacity' ? 1 : 0, max: 100 }}
            />
          ))}
        </div>
      </form>
      {resources.isError && (
        <Button onClick={() => void resources.refetch()}>
          {t('psrSetup.retry')}
        </Button>
      )}
      <div className="row-actions">
        {canManage ? (
          <Button variant="outlined" onClick={() => setOpen(true)}>
            {t('newResource')}
          </Button>
        ) : null}
      </div>
      {resources.isLoading ? (
        <LoadingBlock />
      ) : !resources.isError && rows.length === 0 ? (
        <EmptyBlock message={t('noResources')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('psrSetup.unitLabel')}</TableCell>
                <TableCell>{t('resourceCode')}</TableCell>
                <TableCell>{t('psrSetup.placePath')}</TableCell>
                <TableCell>{t('psrSetup.unitDetails')}</TableCell>
                <TableCell>{t('resourceType')}</TableCell>
                <TableCell>{t('capacity')}</TableCell>
                <TableCell>{t('status')}</TableCell>
                <TableCell>{t('actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((resource) => (
                <TableRow key={resource.id}>
                  <TableCell>
                    {resource.display_label || resource.code}
                  </TableCell>
                  <TableCell>{resource.code}</TableCell>
                  <TableCell>
                    <UnitLocationPath
                      tenantId={tenantId}
                      propertyId={propertyId}
                      locationId={resource.location_id}
                    />
                  </TableCell>
                  <TableCell>
                    {resource.unit_details?.bedrooms_count ?? '—'} /{' '}
                    {resource.unit_details?.bathrooms_count ?? '—'}
                  </TableCell>
                  <TableCell>
                    <ChipFor prefix="resourceTypes" value={resource.type} />
                  </TableCell>
                  <TableCell>{resource.capacity}</TableCell>
                  <TableCell>
                    <ChipFor prefix="resourceState" value={resource.state} />
                  </TableCell>
                  <TableCell className="row-actions">
                    {canManage && resource.state !== 'RETIRED' ? (
                      <>
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() => {
                            setEditingResource(resource);
                            setEditLabel(resource.display_label ?? '');
                            setEditLocationId(resource.location_id);
                          }}
                        >
                          {t('psrSetup.editUnit')}
                        </Button>
                        <Button
                          size="small"
                          color="warning"
                          disabled={busy}
                          onClick={() => setArchiveResource(resource)}
                        >
                          {t('psrSetup.archive.action')}
                        </Button>
                      </>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {resources.hasNextPage && (
        <Button
          disabled={resources.isFetchingNextPage}
          onClick={() => void resources.fetchNextPage()}
        >
          {t('psrSetup.moreResources')}
        </Button>
      )}
      {archiveResource ? (
        <ArchiveEntityDialog
          key={archiveResource.id}
          tenantId={tenantId}
          propertyId={propertyId}
          kind="RESOURCE"
          id={archiveResource.id}
          name={archiveResource.display_label || archiveResource.code}
          onClose={() => setArchiveResource(null)}
        />
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t('newResource')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            fullWidth
            margin="dense"
            label={t('resourceCode')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('resourceType')}
            value={type}
            onChange={(event) => {
              const selected = resourceKinds.find(
                (kind) => kind === event.target.value,
              );
              if (selected) setType(selected);
            }}
          >
            {resourceKinds.map((option) => (
              <MenuItem key={option} value={option}>
                {t(`resourceTypes.${option}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            type="number"
            label={t('capacity')}
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
          />
          <p>{t('location')}</p>
          <UnitLocationPath
            tenantId={tenantId}
            propertyId={propertyId}
            locationId={locationId || null}
          />
          <Button disabled={busy} onClick={() => setLocationId('')}>
            {t('noLocation')}
          </Button>
          <LocationBrowser
            tenantId={tenantId}
            propertyId={propertyId}
            selectionDisabled={busy}
            onSelect={(path) => setLocationId(path.at(-1)?.id ?? '')}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={busy || !code.trim()}
            onClick={async () => {
              const created = await run(() =>
                propertyApi.createResource(tenantId, propertyId, {
                  code: code.trim(),
                  type,
                  capacity: Number(capacity),
                  location_id: locationId || null,
                }),
              );
              if (created) {
                setOpen(false);
                setCode('');
              }
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={editingResource !== null}
        onClose={() => setEditingResource(null)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>{t('psrSetup.editUnit')}</DialogTitle>
        <DialogContent className="dialog-form">
          <ErrorAlert error={error} />
          <TextField
            fullWidth
            margin="dense"
            label={t('psrSetup.unitLabel')}
            value={editLabel}
            inputProps={{ maxLength: 160 }}
            onChange={(event) => setEditLabel(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('resourceCode')}
            value={editingResource?.code ?? ''}
            disabled
          />
          <div>
            <UnitLocationPath
              tenantId={tenantId}
              propertyId={propertyId}
              locationId={editLocationId}
            />
            <Button size="small" onClick={() => setEditLocationId(null)}>
              {t('psrSetup.clearLocation')}
            </Button>
          </div>
          <LocationBrowser
            tenantId={tenantId}
            propertyId={propertyId}
            onSelect={(path) => setEditLocationId(path.at(-1)?.id ?? null)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingResource(null)}>
            {t('cancel')}
          </Button>
          <Button
            variant="contained"
            disabled={
              busy ||
              !editingResource ||
              ((editLabel.trim() || null) === editingResource.display_label &&
                editLocationId === editingResource.location_id)
            }
            onClick={async () => {
              const current = editingResource;
              if (!current) return;
              const desiredLabel = editLabel.trim() || null;
              try {
                await run(
                  () =>
                    propertyApi.updateResource(
                      tenantId,
                      propertyId,
                      current.id,
                      {
                        version: current.version,
                        display_label: desiredLabel,
                        location_id: editLocationId,
                      },
                    ),
                  { rethrow: true },
                );
                setEditingResource(null);
              } catch (caught) {
                // A lost response can follow a successful PATCH. Read back the scoped
                // resource pages and close only when the exact requested state landed.
                const refreshed = await resources.refetch();
                const latest = refreshed.data?.pages
                  .flatMap((page) => page.items)
                  .find((item) => item.id === current.id);
                if (
                  latest &&
                  latest.version > current.version &&
                  latest.display_label === desiredLabel &&
                  latest.location_id === editLocationId
                ) {
                  setEditingResource(null);
                  return;
                }
                setError(caught);
              }
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

function CandidatesDialog({
  tenantId,
  propertyId,
  product,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  product: Product | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const [resourceId, setResourceId] = useState('');
  const open = product !== null;
  const candidates = useQuery({
    queryKey: ['candidates', tenantId, propertyId, product?.id],
    enabled: open,
    queryFn: () =>
      propertyApi.listCandidates(tenantId, propertyId, product!.id),
  });
  const resources = useQuery({
    queryKey: ['resources', tenantId, propertyId],
    enabled: open,
    queryFn: () => propertyApi.listResources(tenantId, propertyId),
  });
  const eligible =
    resources.data?.items.filter(
      (resource) =>
        resource.type === product?.kind && resource.state !== 'RETIRED',
    ) ?? [];
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{`${t('candidates')} · ${product?.code ?? ''}`}</DialogTitle>
      <DialogContent className="dialog-form">
        <ErrorAlert error={error ?? candidates.error} />
        {candidates.isLoading ? (
          <LoadingBlock />
        ) : candidates.data && candidates.data.items.length === 0 ? (
          <EmptyBlock message={t('noCandidates')} />
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('resourceCode')}</TableCell>
                  <TableCell>{t('actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {candidates.data?.items.map((candidate) => (
                  <TableRow key={candidate.resource_id}>
                    <TableCell>
                      {resources.data?.items.find(
                        (resource) => resource.id === candidate.resource_id,
                      )?.code ?? candidate.resource_id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            propertyApi.removeCandidate(
                              tenantId,
                              propertyId,
                              product!.id,
                              candidate.resource_id,
                            ),
                          )
                        }
                      >
                        {t('remove')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('addCandidate')}
          value={resourceId}
          onChange={(event) => setResourceId(event.target.value)}
        >
          {eligible.map((resource) => (
            <MenuItem key={resource.id} value={resource.id}>
              {resource.code}
            </MenuItem>
          ))}
        </TextField>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('close')}</Button>
        <Button
          variant="contained"
          disabled={busy || !resourceId}
          onClick={async () => {
            const added = await run(() =>
              propertyApi.addCandidate(
                tenantId,
                propertyId,
                product!.id,
                resourceId,
              ),
            );
            if (added) setResourceId('');
          }}
        >
          {t('add')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ProductsPanel({ tenantId, propertyId, property }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canManage = useAuth().hasPermission('property.resource.manage');
  const [open, setOpen] = useState(false);
  const [candidateFor, setCandidateFor] = useState<Product | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('ROOM');
  const [adultsMax, setAdultsMax] = useState('2');
  const [mealPlan, setMealPlan] = useState('NONE');
  const products = useQuery({
    queryKey: ['products', tenantId, propertyId],
    queryFn: () => propertyApi.listProducts(tenantId, propertyId),
  });
  void property;
  return (
    <div>
      <ErrorAlert error={error ?? products.error} />
      <div className="row-actions">
        {canManage ? (
          <Button variant="outlined" onClick={() => setOpen(true)}>
            {t('newProduct')}
          </Button>
        ) : null}
      </div>
      {products.isLoading ? (
        <LoadingBlock />
      ) : products.data && products.data.items.length === 0 ? (
        <EmptyBlock message={t('noProducts')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('productCode')}</TableCell>
                <TableCell>{t('productName')}</TableCell>
                <TableCell>{t('resourceType')}</TableCell>
                <TableCell>{t('mealPlan')}</TableCell>
                <TableCell>{t('status')}</TableCell>
                <TableCell>{t('actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {products.data?.items.map((product) => (
                <TableRow key={product.id}>
                  <TableCell>{product.code}</TableCell>
                  <TableCell>{product.name}</TableCell>
                  <TableCell>
                    <ChipFor prefix="resourceTypes" value={product.kind} />
                  </TableCell>
                  <TableCell>
                    <ChipFor prefix="mealPlans" value={product.meal_plan} />
                  </TableCell>
                  <TableCell>
                    <ChipFor prefix="productStatus" value={product.status} />
                  </TableCell>
                  <TableCell className="row-actions">
                    <Button
                      size="small"
                      onClick={() => setCandidateFor(product)}
                    >
                      {t('candidates')}
                    </Button>
                    {canManage && product.status !== 'ACTIVE' ? (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            propertyApi.updateProduct(
                              tenantId,
                              propertyId,
                              product.id,
                              { version: product.version, status: 'ACTIVE' },
                            ),
                          )
                        }
                      >
                        {t('activate')}
                      </Button>
                    ) : null}
                    {canManage && product.status === 'ACTIVE' ? (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            propertyApi.updateProduct(
                              tenantId,
                              propertyId,
                              product.id,
                              { version: product.version, status: 'SUSPENDED' },
                            ),
                          )
                        }
                      >
                        {t('suspend')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <CandidatesDialog
        tenantId={tenantId}
        propertyId={propertyId}
        product={candidateFor}
        onClose={() => setCandidateFor(null)}
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t('newProduct')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            fullWidth
            margin="dense"
            label={t('productCode')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('productName')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('resourceType')}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            {resourceKinds.map((option) => (
              <MenuItem key={option} value={option}>
                {t(`resourceTypes.${option}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            type="number"
            label={t('adultsMax')}
            value={adultsMax}
            onChange={(event) => setAdultsMax(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('mealPlan')}
            value={mealPlan}
            onChange={(event) => setMealPlan(event.target.value)}
          >
            <MenuItem value="NONE">{t('mealPlans.NONE')}</MenuItem>
            <MenuItem value="BREAKFAST">{t('mealPlans.BREAKFAST')}</MenuItem>
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={busy || !code.trim() || !name.trim()}
            onClick={async () => {
              const created = await run(() =>
                propertyApi.createProduct(tenantId, propertyId, {
                  code: code.trim(),
                  name: name.trim(),
                  kind,
                  occupancy_adults_max: Number(adultsMax),
                  meal_plan: mealPlan,
                }),
              );
              if (created) {
                setOpen(false);
                setCode('');
                setName('');
              }
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

function CompositionsPanel({ tenantId, propertyId, property }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canManage = useAuth().hasPermission('composition.manage');
  const [open, setOpen] = useState(false);
  const [activateFor, setActivateFor] = useState<string | null>(null);
  const [changeFor, setChangeFor] = useState<Composition | null>(null);
  const [productId, setProductId] = useState('');
  const [arrival, setArrival] = useState('');
  const [departure, setDeparture] = useState('');
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [nestedIds, setNestedIds] = useState<string[]>([]);
  const products = useQuery({
    queryKey: ['products', tenantId, propertyId],
    queryFn: () => propertyApi.listProducts(tenantId, propertyId),
  });
  const resources = useQuery({
    queryKey: ['resources', tenantId, propertyId],
    queryFn: () => propertyApi.listResources(tenantId, propertyId),
  });
  const compositions = useQuery({
    queryKey: ['compositions', tenantId, propertyId],
    queryFn: () => propertyApi.listCompositions(tenantId, propertyId),
  });
  void property;
  return (
    <div>
      <ErrorAlert error={error ?? compositions.error} />
      <div className="row-actions">
        {canManage ? (
          <Button variant="outlined" onClick={() => setOpen(true)}>
            {t('newComposition')}
          </Button>
        ) : null}
      </div>
      {compositions.isLoading ? (
        <LoadingBlock />
      ) : compositions.data && compositions.data.items.length === 0 ? (
        <EmptyBlock message={t('noCompositions')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('productCode')}</TableCell>
                <TableCell>{t('versionNumber')}</TableCell>
                <TableCell>{t('effectiveFrom')}</TableCell>
                <TableCell>{t('effectiveTo')}</TableCell>
                <TableCell>{t('status')}</TableCell>
                <TableCell>{t('actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {compositions.data?.items.map((composition) => (
                <TableRow key={composition.id}>
                  <TableCell>
                    {products.data?.items.find(
                      (product) => product.id === composition.product_id,
                    )?.code ?? composition.product_id.slice(0, 8)}
                  </TableCell>
                  <TableCell>{composition.version_number}</TableCell>
                  <TableCell>{composition.effective_from}</TableCell>
                  <TableCell>{composition.effective_to}</TableCell>
                  <TableCell>
                    <ChipFor
                      prefix="compositionStatus"
                      value={composition.status}
                    />
                  </TableCell>
                  <TableCell className="row-actions">
                    {canManage && composition.status === 'DRAFT' ? (
                      <Button
                        size="small"
                        onClick={() => setActivateFor(composition.id)}
                      >
                        {t('activate')}
                      </Button>
                    ) : null}
                    {canManage && composition.status === 'ACTIVE' ? (
                      <Button
                        size="small"
                        onClick={() => setChangeFor(composition)}
                      >
                        {t('setupInsights.change')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {changeFor ? (
        <CompositionChangeDialog
          tenantId={tenantId}
          propertyId={propertyId}
          composition={changeFor}
          resources={resources.data?.items ?? []}
          onClose={() => setChangeFor(null)}
        />
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('newComposition')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('product')}
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
          >
            {products.data?.items.map((product) => (
              <MenuItem key={product.id} value={product.id}>
                {product.code} · {product.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            type="date"
            label={t('effectiveFrom')}
            InputLabelProps={{ shrink: true }}
            value={arrival}
            onChange={(event) => setArrival(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            type="date"
            label={t('effectiveTo')}
            InputLabelProps={{ shrink: true }}
            value={departure}
            onChange={(event) => setDeparture(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('resources')}
            SelectProps={{ multiple: true }}
            value={resourceIds}
            onChange={(event) =>
              setResourceIds(
                Array.isArray(event.target.value)
                  ? event.target.value
                  : [event.target.value],
              )
            }
          >
            {resources.data?.items
              .filter((resource) => resource.state !== 'RETIRED')
              .map((resource) => (
                <MenuItem key={resource.id} value={resource.id}>
                  {resource.code}
                </MenuItem>
              ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('nestedVersions')}
            SelectProps={{ multiple: true }}
            value={nestedIds}
            onChange={(event) =>
              setNestedIds(
                Array.isArray(event.target.value)
                  ? event.target.value
                  : [event.target.value],
              )
            }
          >
            {compositions.data?.items
              .filter((composition) => composition.status === 'ACTIVE')
              .map((composition) => (
                <MenuItem key={composition.id} value={composition.id}>
                  {products.data?.items.find(
                    (product) => product.id === composition.product_id,
                  )?.code ?? composition.product_id.slice(0, 8)}
                  {` · v${composition.version_number}`}
                </MenuItem>
              ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={
              busy ||
              !productId ||
              !arrival ||
              !departure ||
              resourceIds.length + nestedIds.length === 0
            }
            onClick={async () => {
              const created = await run(() =>
                propertyApi.createComposition(tenantId, propertyId, {
                  product_id: productId,
                  effective_period: { arrival, departure },
                  resource_ids: resourceIds,
                  nested_version_ids: nestedIds,
                }),
              );
              if (created) {
                setOpen(false);
                setResourceIds([]);
                setNestedIds([]);
              }
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
      <ReasonDialog
        open={activateFor !== null}
        title={t('activateComposition')}
        confirmLabel={t('activate')}
        onClose={() => setActivateFor(null)}
        onSubmit={(reason) => {
          const id = activateFor;
          setActivateFor(null);
          if (id)
            void run(() =>
              propertyApi.activateComposition(tenantId, propertyId, id, reason),
            );
        }}
      />
    </div>
  );
}

function ConnectionsPanel({ tenantId, propertyId, property }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canManage = useAuth().hasPermission('channel.connection.manage');
  const canMap = useAuth().hasPermission('channel.mapping.manage');
  const canRead = useAuth().hasPermission('channel.read');
  const canRates = useAuth().hasPermission('rate.manage');
  const [open, setOpen] = useState(false);
  const [mappingFor, setMappingFor] = useState<string | null>(null);
  const [providerKey, setProviderKey] = useState('channex');
  const [environment, setEnvironment] = useState('simulator');
  const [channelKey, setChannelKey] = useState('tiket-com');
  const [externalPropertyId, setExternalPropertyId] = useState('');
  const [secretRef, setSecretRef] = useState('');
  const [externalRoomRef, setExternalRoomRef] = useState('');
  const [externalRateRef, setExternalRateRef] = useState('');
  const [occupancy, setOccupancy] = useState('2');
  const [internalProductId, setInternalProductId] = useState('');
  const [internalRatePlanId, setInternalRatePlanId] = useState('');
  const connections = useQuery({
    queryKey: ['connections', tenantId, propertyId],
    enabled: canRead,
    queryFn: () => propertyApi.listConnections(tenantId, propertyId),
  });
  const products = useQuery({
    queryKey: ['products', tenantId, propertyId],
    enabled: canMap,
    queryFn: () => propertyApi.listProducts(tenantId, propertyId),
  });
  const ratePlans = useQuery({
    queryKey: ['rate-plans', tenantId, propertyId],
    enabled: canMap && canRates,
    queryFn: () => inventoryApi.listRatePlans(tenantId, propertyId),
  });
  const mappings = useQuery({
    queryKey: ['mappings', tenantId, propertyId, mappingFor],
    enabled: mappingFor !== null,
    queryFn: () => propertyApi.listMappings(tenantId, propertyId, mappingFor!),
  });
  void property;
  if (!canRead) return <ForbiddenPanel />;
  return (
    <div>
      <ErrorAlert error={error ?? connections.error} />
      <div className="row-actions">
        {canManage ? (
          <Button variant="outlined" onClick={() => setOpen(true)}>
            {t('newConnection')}
          </Button>
        ) : null}
      </div>
      {connections.isLoading ? (
        <LoadingBlock />
      ) : connections.data && connections.data.items.length === 0 ? (
        <EmptyBlock message={t('noConnections')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('providerKey')}</TableCell>
                <TableCell>{t('channelKey')}</TableCell>
                <TableCell>{t('environment')}</TableCell>
                <TableCell>{t('status')}</TableCell>
                <TableCell>{t('actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connections.data?.items.map((connection) => (
                <TableRow key={connection.id}>
                  <TableCell>{connection.provider_key}</TableCell>
                  <TableCell>{connection.channel_key}</TableCell>
                  <TableCell>{connection.environment}</TableCell>
                  <TableCell>
                    <ChipFor
                      prefix="connectionStatus"
                      value={connection.status}
                    />
                  </TableCell>
                  <TableCell className="row-actions">
                    <Button
                      size="small"
                      onClick={() => setMappingFor(connection.id)}
                    >
                      {t('mappings')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t('newConnection')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            fullWidth
            margin="dense"
            label={t('providerKey')}
            value={providerKey}
            onChange={(event) => setProviderKey(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('environment')}
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('channelKey')}
            value={channelKey}
            onChange={(event) => setChannelKey(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('externalPropertyId')}
            value={externalPropertyId}
            onChange={(event) => setExternalPropertyId(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('secretRef')}
            helperText={t('secretRefHelp')}
            value={secretRef}
            onChange={(event) => setSecretRef(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={busy || !providerKey || !environment || !channelKey}
            onClick={async () => {
              const created = await run(() =>
                propertyApi.createConnection(tenantId, propertyId, {
                  provider_key: providerKey,
                  environment,
                  channel_key: channelKey,
                  external_property_id: externalPropertyId || null,
                  secret_ref: secretRef,
                }),
              );
              if (created) {
                setOpen(false);
                setSecretRef('');
              }
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={mappingFor !== null}
        onClose={() => setMappingFor(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('mappings')}</DialogTitle>
        <DialogContent className="dialog-form">
          <ErrorAlert error={error ?? mappings.error} />
          {mappings.isLoading ? (
            <LoadingBlock />
          ) : mappings.data && mappings.data.items.length === 0 ? (
            <EmptyBlock message={t('noMappings')} />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('externalRoomRef')}</TableCell>
                    <TableCell>{t('externalRateRef')}</TableCell>
                    <TableCell>{t('occupancy')}</TableCell>
                    <TableCell>{t('status')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {mappings.data?.items.map((mapping) => (
                    <TableRow key={mapping.id}>
                      <TableCell>{mapping.external_room_ref}</TableCell>
                      <TableCell>{mapping.external_rate_ref}</TableCell>
                      <TableCell>{mapping.occupancy}</TableCell>
                      <TableCell>
                        <ChipFor
                          prefix="mappingStatus"
                          value={mapping.status}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {canMap ? (
            <>
              <TextField
                fullWidth
                margin="dense"
                label={t('externalRoomRef')}
                value={externalRoomRef}
                onChange={(event) => setExternalRoomRef(event.target.value)}
              />
              <TextField
                fullWidth
                margin="dense"
                label={t('externalRateRef')}
                value={externalRateRef}
                onChange={(event) => setExternalRateRef(event.target.value)}
              />
              <TextField
                fullWidth
                margin="dense"
                type="number"
                label={t('occupancy')}
                value={occupancy}
                onChange={(event) => setOccupancy(event.target.value)}
              />
              <TextField
                select
                fullWidth
                margin="dense"
                label={t('internalProduct')}
                value={internalProductId}
                onChange={(event) => {
                  setInternalProductId(event.target.value);
                  setInternalRatePlanId('');
                }}
              >
                {products.data?.items.map((product) => (
                  <MenuItem key={product.id} value={product.id}>
                    {product.code}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                fullWidth
                margin="dense"
                label={t('mappingInternalRate')}
                value={internalRatePlanId}
                onChange={(event) => setInternalRatePlanId(event.target.value)}
              >
                <MenuItem value="">{t('noRatePlan')}</MenuItem>
                {ratePlans.data?.items
                  .filter(
                    (plan) =>
                      !internalProductId ||
                      plan.product_id === internalProductId,
                  )
                  .map((plan) => (
                    <MenuItem key={plan.id} value={plan.id}>
                      {plan.code}
                    </MenuItem>
                  ))}
              </TextField>
            </>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMappingFor(null)}>{t('close')}</Button>
          {canMap ? (
            <Button
              variant="contained"
              disabled={
                busy ||
                !externalRoomRef ||
                !externalRateRef ||
                !internalProductId
              }
              onClick={async () => {
                const saved = await run(() =>
                  propertyApi.saveMapping(tenantId, propertyId, mappingFor!, {
                    channel_key: channelKey,
                    external_room_ref: externalRoomRef,
                    external_rate_ref: externalRateRef,
                    occupancy: Number(occupancy),
                    internal_product_ref: internalProductId,
                    internal_rate_ref: internalRatePlanId || null,
                  }),
                );
                if (saved) {
                  setExternalRoomRef('');
                  setExternalRateRef('');
                  setInternalRatePlanId('');
                }
              }}
            >
              {t('saveMapping')}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </div>
  );
}

export function PropertySetupPage() {
  const { t } = useTranslation();
  const { propertyId } = useParams<{ propertyId: string }>();
  const { activeTenantId, hasPermission } = useAuth();
  const [tab, setTab] = useState(0);
  const property = useQuery({
    queryKey: ['property', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId),
    queryFn: () => propertyApi.getProperty(activeTenantId!, propertyId!),
  });

  if (!activeTenantId || !propertyId) return <LoadingBlock />;
  if (!hasPermission('property.read'))
    return (
      <div>
        <PageHeader title={t('propertySetup')} />
        <ForbiddenPanel />
      </div>
    );
  if (property.isLoading) return <LoadingBlock />;
  if (!property.data)
    return (
      <div>
        <PageHeader title={t('propertySetup')} />
        <ErrorAlert error={property.error} />
      </div>
    );
  const panelProps = {
    tenantId: activeTenantId,
    propertyId,
    property: property.data.property,
  };
  return (
    <div>
      <PageHeader
        title={`${property.data.property.name} (${property.data.property.code})`}
        description={t('propertySetupDescription')}
        action={
          <div className="row-actions">
            <Button
              variant="contained"
              component={RouterLink}
              to={`/properties/${propertyId}/structure`}
            >
              {t('psrSetup.title')}
            </Button>
            {['SETUP', 'ACTIVE'].includes(property.data.property.status) && (
              <Button
                component={RouterLink}
                to={`/properties/${propertyId}/structure?addition=1`}
              >
                {t('psrSetup.additionTitle')}
              </Button>
            )}
            <ChipFor
              prefix="propertyStatus"
              value={property.data.property.status}
            />
            <Button
              variant="outlined"
              component={RouterLink}
              to={`/properties/${propertyId}/rates`}
            >
              {t('ratesInventoryNav')}
            </Button>
          </div>
        }
      />
      {['SETUP', 'ACTIVE'].includes(property.data.property.status) && (
        <SetupProductSimulation
          key={`${activeTenantId}:${propertyId}`}
          tenantId={activeTenantId}
          propertyId={propertyId}
        />
      )}
      <Tabs
        value={tab}
        onChange={(_event, value: number) => setTab(value)}
        variant="scrollable"
        allowScrollButtonsMobile
      >
        <Tab label={t('locationsTab')} />
        <Tab label={t('resourcesTab')} />
        <Tab label={t('productsTab')} />
        <Tab label={t('compositionsTab')} />
        <Tab label={t('channelsTab')} />
        <Tab label={t('settingsTab')} />
      </Tabs>
      {tab === 0 ? (
        <LocationsPanel
          key={`locations:${activeTenantId}:${propertyId}`}
          {...panelProps}
        />
      ) : null}
      {tab === 1 ? (
        <ResourcesPanel
          key={`resources:${activeTenantId}:${propertyId}`}
          {...panelProps}
        />
      ) : null}
      {tab === 2 ? <ProductsPanel {...panelProps} /> : null}
      {tab === 3 ? <CompositionsPanel {...panelProps} /> : null}
      {tab === 4 ? <ConnectionsPanel {...panelProps} /> : null}
      {tab === 5 ? (
        <SettingsOverviewPanel
          tenantId={panelProps.tenantId}
          propertyId={panelProps.propertyId}
        />
      ) : null}
    </div>
  );
}
