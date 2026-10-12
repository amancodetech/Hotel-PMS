import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink, useNavigate } from 'react-router';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import {
  propertyApi,
  timezoneOptions,
  currencyOptions,
} from '../api/property.js';
import type { Property } from '../api/property.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  useApiAction,
} from '../identity/shared.js';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';

function StatusChip({ status }: { status: Property['status'] }) {
  const { t } = useTranslation();
  const color =
    status === 'ACTIVE'
      ? 'success'
      : status === 'SETUP'
        ? 'warning'
        : status === 'SUSPENDED'
          ? 'default'
          : 'error';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`propertyStatus.${status}`)}
    />
  );
}

function PropertyActions({
  property,
  canManage,
  busy,
  onTransition,
}: {
  property: Property;
  canManage: boolean;
  busy: boolean;
  onTransition: (property: Property, status: Property['status']) => void;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  const transition = (status: Property['status']) => {
    close();
    onTransition(property, status);
  };
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : 'false'}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        {t('actions')}
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={close}>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}/front-desk`}
          onClick={close}
        >
          {t('frontDeskNav')}
        </MenuItem>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}/reservations`}
          onClick={close}
        >
          {t('reservationsNav')}
        </MenuItem>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}/rates`}
          onClick={close}
        >
          {t('ratesInventoryNav')}
        </MenuItem>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}/operations`}
          onClick={close}
        >
          {t('operationsNav')}
        </MenuItem>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}/finance`}
          onClick={close}
        >
          {t('financeNav')}
        </MenuItem>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}/night-audit`}
          onClick={close}
        >
          {t('nightAuditNav')}
        </MenuItem>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}/reports`}
          onClick={close}
        >
          {t('reportsNav')}
        </MenuItem>
        <MenuItem
          component={RouterLink}
          to={`/properties/${property.id}`}
          onClick={close}
        >
          {t('setup')}
        </MenuItem>
        {canManage && property.status === 'SETUP' ? (
          <MenuItem disabled={busy} onClick={() => transition('ACTIVE')}>
            {t('activate')}
          </MenuItem>
        ) : null}
        {canManage && property.status === 'ACTIVE' ? (
          <MenuItem disabled={busy} onClick={() => transition('SUSPENDED')}>
            {t('suspend')}
          </MenuItem>
        ) : null}
        {canManage && property.status === 'SUSPENDED' ? (
          <MenuItem disabled={busy} onClick={() => transition('ACTIVE')}>
            {t('reactivate')}
          </MenuItem>
        ) : null}
        {canManage && property.status !== 'ARCHIVED' ? (
          <MenuItem
            className="danger-menu-item"
            disabled={busy}
            onClick={() => transition('ARCHIVED')}
          >
            {t('archive')}
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}

export function PropertiesPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const { run, error, busy } = useApiAction();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState<string>('Asia/Jakarta');
  const [currency, setCurrency] = useState<string>('IDR');
  const [groupId, setGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const canManage = hasPermission('property.manage');
  const canRead = hasPermission('property.read');
  const properties = useQuery({
    queryKey: ['properties', activeTenantId],
    enabled: Boolean(activeTenantId) && canRead,
    staleTime: 60_000,
    queryFn: () => propertyApi.listProperties(activeTenantId!),
  });
  const groups = useQuery({
    queryKey: ['property-groups', activeTenantId],
    enabled: Boolean(activeTenantId) && canRead,
    queryFn: () => propertyApi.listGroups(activeTenantId!),
  });
  const filteredProperties = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    const items = properties.data?.items ?? [];
    if (!normalized) return items;
    return items.filter(
      (property) =>
        property.code.toLocaleLowerCase().includes(normalized) ||
        property.name.toLocaleLowerCase().includes(normalized),
    );
  }, [properties.data, search]);
  const pagedProperties = filteredProperties.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage,
  );

  if (!activeTenantId) return <LoadingBlock />;
  if (!canRead)
    return (
      <div>
        <PageHeader title={t('propertiesTitle')} />
        <ForbiddenPanel />
      </div>
    );

  const transition = (property: Property, status: Property['status']) =>
    run(() =>
      propertyApi.updateProperty(activeTenantId, property.id, {
        version: property.version,
        status,
      }),
    );

  return (
    <div>
      <PageHeader
        title={t('propertiesTitle')}
        description={t('propertiesDescription')}
        action={
          canManage ? (
            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={() => setOpen(true)}>
                {t('newProperty')}
              </Button>
            </Stack>
          ) : null
        }
      />
      <ErrorAlert error={error ?? properties.error} />
      {properties.isLoading ? (
        <LoadingBlock />
      ) : properties.data && properties.data.items.length === 0 ? (
        <EmptyBlock message={t('noProperties')} />
      ) : (
        <Paper variant="outlined" className="property-list-surface">
          <div className="property-list-tools">
            <TextField
              size="small"
              label={t('searchProperties')}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </div>
          <TableContainer>
            <Table size="small" aria-label={t('propertiesTitle')}>
              <TableHead>
                <TableRow>
                  <TableCell>{t('propertyCode')}</TableCell>
                  <TableCell>{t('propertyName')}</TableCell>
                  <TableCell>{t('timezone')}</TableCell>
                  <TableCell>{t('baseCurrency')}</TableCell>
                  <TableCell>{t('propertyStatusLabel')}</TableCell>
                  <TableCell>{t('actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pagedProperties.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <EmptyBlock message={t('noMatchingProperties')} />
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedProperties.map((property) => (
                    <TableRow key={property.id}>
                      <TableCell>{property.code}</TableCell>
                      <TableCell>
                        <RouterLink to={`/properties/${property.id}`}>
                          {property.name}
                        </RouterLink>
                      </TableCell>
                      <TableCell>{property.timezone}</TableCell>
                      <TableCell>{property.base_currency}</TableCell>
                      <TableCell>
                        <StatusChip status={property.status} />
                      </TableCell>
                      <TableCell>
                        <PropertyActions
                          property={property}
                          canManage={canManage}
                          busy={busy}
                          onTransition={(row, status) =>
                            void transition(row, status)
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={filteredProperties.length}
            page={page}
            rowsPerPage={rowsPerPage}
            rowsPerPageOptions={[10, 25, 50]}
            labelRowsPerPage={t('rowsPerPage')}
            labelDisplayedRows={({ from, to, count }) =>
              t('paginationRange', { from, to, count })
            }
            onPageChange={(_event, nextPage) => setPage(nextPage)}
            onRowsPerPageChange={(event) => {
              setRowsPerPage(Number(event.target.value));
              setPage(0);
            }}
          />
        </Paper>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('newProperty')}</DialogTitle>
        <DialogContent className="dialog-form">
          {!hasPermission('property.manage') ? (
            <Alert severity="info">{t('propertyManageMfaNote')}</Alert>
          ) : null}
          <TextField
            fullWidth
            margin="dense"
            label={t('propertyCode')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('propertyName')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('timezone')}
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {timezoneOptions.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('baseCurrency')}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {currencyOptions.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('propertyGroup')}
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
          >
            <MenuItem value="">{t('noGroup')}</MenuItem>
            {groups.data?.items.map((group) => (
              <MenuItem key={group.id} value={group.id}>
                {group.name}
              </MenuItem>
            ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={
              busy || code.trim().length === 0 || name.trim().length === 0
            }
            onClick={async () => {
              const created = await run(() =>
                propertyApi.createProperty(activeTenantId, {
                  code: code.trim(),
                  name: name.trim(),
                  timezone,
                  base_currency: currency,
                  group_id: groupId || null,
                }),
              );
              if (created) {
                setOpen(false);
                setCode('');
                setName('');
                setGroupId('');
                navigate(`/properties/${created.property.id}/structure`);
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
