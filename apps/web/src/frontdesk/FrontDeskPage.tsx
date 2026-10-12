import { resourceLabel } from '../property/resource-label.js';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Radio,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useAuth } from '../auth/AuthProvider.js';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  useApiAction,
} from '../identity/shared.js';
import { reservationsApi } from '../api/reservations.js';
import { frontdeskApi } from '../api/frontdesk.js';
import { propertyApi } from '../api/property.js';
import type {
  BoardCandidate,
  BoardRoom,
  BoardStay,
  StayCapability,
} from '../api/frontdesk.js';

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shortId(value: string | null) {
  return value ? value.slice(0, 8) : '-';
}

function formatStayPeriod(arrival: string, departure: string, locale: string) {
  const formatter = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  });
  const start = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  const nights = Math.max(
    0,
    Math.round((end.getTime() - start.getTime()) / 86_400_000),
  );
  return {
    dates: `${formatter.format(start)} – ${formatter.format(end)}`,
    nights,
  };
}

function HousekeepingChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color =
    state === 'CLEAN' ? 'success' : state === 'DIRTY' ? 'warning' : 'default';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`housekeepingState.${state}`)}
    />
  );
}

function MaintenanceChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color =
    state === 'NONE' ? 'default' : state === 'OOO' ? 'error' : 'warning';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`maintenanceState.${state}`)}
    />
  );
}

function candidateLabel(t: (key: string) => string, candidate: BoardCandidate) {
  return candidate.reason
    ? `${resourceLabel(candidate)} · ${t(`boardReason.${candidate.reason}`)}`
    : resourceLabel(candidate);
}

function ResourceTypeChip({ type }: { type: string }) {
  const { t } = useTranslation();
  return (
    <Chip
      size="small"
      variant="outlined"
      label={t(`resourceTypes.${type}`, { defaultValue: type })}
    />
  );
}

function CapabilityButton({
  capability,
  label,
  onClick,
}: {
  capability: StayCapability;
  label: string;
  onClick: () => void;
}) {
  if (capability.supported)
    return (
      <Button size="small" onClick={onClick}>
        {label}
      </Button>
    );
  return (
    <Button size="small" disabled>
      {label}
    </Button>
  );
}

function StayTable({
  rows,
  mode,
  emptyMessage,
  can,
  onAssign,
  onCheckIn,
  onCheckOut,
  onMove,
  onExtend,
  onSplit,
  onEarly,
  onPartial,
  guestNames,
  productNames,
}: {
  rows: BoardStay[];
  mode: 'ARRIVALS' | 'DEPARTURES' | 'IN_HOUSE';
  emptyMessage: string;
  can: {
    assign: boolean;
    checkIn: boolean;
    move: boolean;
    checkout: boolean;
  };
  onAssign: (row: BoardStay) => void;
  onCheckIn: (row: BoardStay) => void;
  onCheckOut: (row: BoardStay) => void;
  onMove: (row: BoardStay) => void;
  onExtend: (row: BoardStay) => void;
  onSplit: (row: BoardStay) => void;
  onEarly: (row: BoardStay) => void;
  onPartial: (row: BoardStay) => void;
  guestNames: Record<string, string | null>;
  productNames: Record<string, string>;
}) {
  const { t, i18n } = useTranslation();
  return (
    <TableContainer
      component={Paper}
      variant="outlined"
      className="frontdesk-table"
    >
      <Table size="small" aria-label={t('frontDeskTitle')}>
        <TableHead>
          <TableRow>
            <TableCell>{t('guestName')}</TableCell>
            <TableCell>{t('product')}</TableCell>
            <TableCell>{t('reservationItemPeriod')}</TableCell>
            <TableCell>{t('bookingReference')}</TableCell>
            <TableCell>{t('roomLabel')}</TableCell>
            <TableCell>{t('reservationState')}</TableCell>
            <TableCell>{t('actions')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7}>
                <EmptyBlock message={emptyMessage} />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const period = formatStayPeriod(
                row.arrival,
                row.departure,
                i18n.resolvedLanguage ?? i18n.language,
              );
              const assignedRooms = row.rooms ?? [];
              const allocatedRooms = row.allocated_rooms ?? [];
              const groupRooms =
                assignedRooms.length > 0 ? assignedRooms : allocatedRooms;
              const readinessByRoom = new Map(
                (row.allocation_readiness ?? []).map((entry) => [
                  entry.resource_id,
                  entry,
                ]),
              );
              const groupReady =
                row.allocation_readiness.length > 0 &&
                row.allocation_readiness.every(
                  (entry) => entry.eligible === true,
                );
              const groupBlocked = [
                row.capabilities.assign,
                row.capabilities.move,
                row.capabilities.split,
              ].some(
                (capability) =>
                  !capability.supported &&
                  capability.reason === 'GROUP_COMPONENT_SELECTION_REQUIRED',
              );
              const capabilityReason = (capability: StayCapability): string =>
                capability.reason
                  ? t(`frontDeskCapabilityReason.${capability.reason}`)
                  : t('frontDeskCapabilityUnavailable');
              return (
                <TableRow key={row.item_id} hover>
                  <TableCell>
                    <Typography variant="body2" fontWeight={700}>
                      {guestNames[row.reservation_id] ??
                        shortId(row.reservation_id)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t('adultsLabel')}: {row.adults}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {row.product_id
                      ? (productNames[row.product_id] ??
                        shortId(row.product_id))
                      : '-'}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{period.dates}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t('nightCount', { count: period.nights })}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    #{shortId(row.reservation_id).toUpperCase()}
                  </TableCell>
                  <TableCell>
                    {row.group_assignment ? (
                      <div className="frontdesk-room-group">
                        <Chip
                          size="small"
                          variant="outlined"
                          color={
                            mode === 'ARRIVALS'
                              ? groupReady
                                ? 'success'
                                : 'warning'
                              : 'default'
                          }
                          label={t('frontDeskGroupComponents', {
                            count: groupRooms.length,
                          })}
                        />
                        {row.product_kind ? (
                          <ResourceTypeChip type={row.product_kind} />
                        ) : null}
                        <Typography variant="caption" color="text.secondary">
                          {groupRooms
                            .map((room) => {
                              const readiness = readinessByRoom.get(
                                room.resource_id,
                              );
                              const detail = readiness?.reason
                                ? ` · ${t(`boardReason.${readiness.reason}`, { defaultValue: readiness.reason })}`
                                : '';
                              return `${resourceLabel(room)}${detail}`;
                            })
                            .join(' · ')}
                        </Typography>
                      </div>
                    ) : row.room ? (
                      <>
                        {resourceLabel(row.room)}{' '}
                        <ResourceTypeChip type={row.room.resource_type} />{' '}
                        <HousekeepingChip state={row.room.housekeeping_state} />{' '}
                        <MaintenanceChip state={row.room.maintenance_state} />
                      </>
                    ) : (
                      <Chip
                        size="small"
                        variant="outlined"
                        color="warning"
                        label={t('unassignedRoom')}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={row.state === 'IN_HOUSE' ? 'success' : 'default'}
                      label={t(`reservationState.${row.state}`)}
                    />
                  </TableCell>
                  <TableCell className="row-actions">
                    {mode === 'ARRIVALS' && can.assign ? (
                      <CapabilityButton
                        capability={row.capabilities.assign}
                        label={t('assignRoomAction')}
                        onClick={() => onAssign(row)}
                      />
                    ) : null}
                    {mode === 'ARRIVALS' &&
                    can.checkIn &&
                    (row.assignment || row.group_assignment) ? (
                      <Button
                        size="small"
                        variant="contained"
                        disabled={
                          !row.capabilities.check_in.supported ||
                          (row.group_assignment && !groupReady)
                        }
                        onClick={() => onCheckIn(row)}
                      >
                        {row.group_assignment
                          ? t('frontDeskCheckInGroupAction')
                          : t('checkInAction')}
                      </Button>
                    ) : null}
                    {mode === 'IN_HOUSE' && can.move ? (
                      <>
                        <CapabilityButton
                          capability={row.capabilities.move}
                          label={t('moveAction')}
                          onClick={() => onMove(row)}
                        />
                        <CapabilityButton
                          capability={row.capabilities.split}
                          label={t('splitAction')}
                          onClick={() => onSplit(row)}
                        />
                        <CapabilityButton
                          capability={row.capabilities.early_departure}
                          label={t('earlyDepartureAction')}
                          onClick={() => onEarly(row)}
                        />
                      </>
                    ) : null}
                    {mode === 'DEPARTURES' && can.move ? (
                      <CapabilityButton
                        capability={row.capabilities.extend}
                        label={t('extendAction')}
                        onClick={() => onExtend(row)}
                      />
                    ) : null}
                    {mode === 'IN_HOUSE' && can.move ? (
                      <CapabilityButton
                        capability={row.capabilities.extend}
                        label={t('extendAction')}
                        onClick={() => onExtend(row)}
                      />
                    ) : null}
                    {mode !== 'ARRIVALS' && can.checkout ? (
                      <>
                        <CapabilityButton
                          capability={row.capabilities.partial_departure}
                          label={t('partialDepartureAction')}
                          onClick={() => onPartial(row)}
                        />
                        <CapabilityButton
                          capability={row.capabilities.check_out}
                          label={t('checkOutAction')}
                          onClick={() => onCheckOut(row)}
                        />
                      </>
                    ) : null}
                    {groupBlocked ? (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                      >
                        {t(
                          'frontDeskTreatment.groupComponentSelectionRequired',
                        )}
                      </Typography>
                    ) : null}
                    {mode === 'IN_HOUSE' && can.move && !groupBlocked
                      ? [...Object.values(row.capabilities)]
                          .filter(
                            (capability) =>
                              !capability.supported && capability.reason,
                          )
                          .slice(0, 1)
                          .map((capability) => (
                            <Typography
                              key={capability.reason}
                              variant="caption"
                              color="text.secondary"
                              display="block"
                            >
                              {capabilityReason(capability)}
                            </Typography>
                          ))
                      : null}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
}) {
  const { run, error, busy, t } = useApiAction();
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2">{message}</Typography>
        <ErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await onConfirm();
              onClose();
            })
          }
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DateActionDialog({
  title,
  label,
  initialDate,
  minDate,
  confirmLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  initialDate: string;
  minDate?: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (date: string) => Promise<unknown>;
}) {
  const { run, error, busy, t } = useApiAction();
  const [date, setDate] = useState(initialDate);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          type="date"
          label={label}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: { min: minDate },
          }}
        />
        <ErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || date.length === 0}
          onClick={() =>
            void run(async () => {
              await onSubmit(date);
              onClose();
            })
          }
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AssignRoomDialog({
  tenantId,
  propertyId,
  row,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  row: BoardStay;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [resourceId, setResourceId] = useState('');
  const selected = row.candidates.find(
    (candidate) => candidate.resource_id === resourceId,
  );
  const valid = Boolean(selected?.eligible);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{t('assignRoomAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {t('reservationItemPeriod')}: {row.arrival} → {row.departure} ·{' '}
          {t('adultsLabel')}: {row.adults} · {t('quantity')}: {row.quantity}
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell />
              <TableCell>{t('roomLabel')}</TableCell>
              <TableCell>{t('housekeepingStateLabel')}</TableCell>
              <TableCell>{t('maintenanceStateLabel')}</TableCell>
              <TableCell>{t('eligibility')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {row.candidates.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <EmptyBlock message={t('noEligibleRooms')} />
                </TableCell>
              </TableRow>
            ) : (
              row.candidates.map((candidate) => (
                <TableRow key={candidate.resource_id}>
                  <TableCell padding="checkbox">
                    <Radio
                      checked={resourceId === candidate.resource_id}
                      onChange={() => setResourceId(candidate.resource_id)}
                      disabled={!candidate.eligible}
                      inputProps={{ 'aria-label': resourceLabel(candidate) }}
                    />
                  </TableCell>
                  <TableCell>{resourceLabel(candidate)}</TableCell>
                  <TableCell>
                    <HousekeepingChip state={candidate.housekeeping_state} />
                  </TableCell>
                  <TableCell>
                    <MaintenanceChip state={candidate.maintenance_state} />
                  </TableCell>
                  <TableCell>
                    {candidate.eligible
                      ? t('eligible')
                      : candidateLabel(t, candidate)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !valid}
          onClick={() =>
            void run(async () => {
              await frontdeskApi.assignRoom(
                tenantId,
                propertyId,
                row.reservation_id,
                row.item_id,
                { resource_id: resourceId, version: row.item_version },
              );
              onClose();
            })
          }
        >
          {t('assignRoomAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function MoveStayDialog({
  tenantId,
  propertyId,
  row,
  rooms,
  initialDate,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  row: BoardStay;
  rooms: BoardRoom[];
  initialDate: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [resourceId, setResourceId] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(initialDate);
  const eligible = rooms.filter(
    (room) =>
      room.maintenance_state === 'NONE' &&
      room.housekeeping_state !== 'DIRTY' &&
      room.assignment === null,
  );
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('moveAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {t('roomLabel')}: {row.room ? resourceLabel(row.room) : '-'} ·{' '}
          {row.arrival} → {row.departure}
        </Typography>
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('targetRoom')}
          value={resourceId}
          onChange={(event) => setResourceId(event.target.value)}
        >
          {eligible.length === 0 ? (
            <MenuItem value="" disabled>
              {t('noEligibleRooms')}
            </MenuItem>
          ) : (
            eligible.map((room) => (
              <MenuItem key={room.resource_id} value={room.resource_id}>
                {resourceLabel(room)} ·{' '}
                {t(`housekeepingState.${room.housekeeping_state}`)}
              </MenuItem>
            ))
          )}
        </TextField>
        <TextField
          fullWidth
          margin="dense"
          type="date"
          label={t('effectiveDate')}
          value={effectiveDate}
          onChange={(event) => setEffectiveDate(event.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <ErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || resourceId === '' || effectiveDate === ''}
          onClick={() =>
            void run(async () => {
              await frontdeskApi.moveStay(
                tenantId,
                propertyId,
                row.reservation_id,
                row.item_id,
                {
                  to_resource_id: resourceId,
                  effective_date: effectiveDate,
                  version: row.item_version,
                },
              );
              onClose();
            })
          }
        >
          {t('moveAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PartialDepartureDialog({
  tenantId,
  propertyId,
  row,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  row: BoardStay;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [selected, setSelected] = useState<string[]>([]);
  const detail = useQuery({
    queryKey: ['reservation', tenantId, propertyId, row.reservation_id],
    queryFn: () =>
      reservationsApi.getReservation(tenantId, propertyId, row.reservation_id),
  });
  const guests = detail.data?.guests ?? null;
  const toggle = (guestId: string) =>
    setSelected((current) =>
      current.includes(guestId)
        ? current.filter((id) => id !== guestId)
        : [...current, guestId],
    );
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('partialDepartureAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <ErrorAlert error={detail.error ?? error} />
        {detail.isLoading || !detail.data ? (
          <LoadingBlock />
        ) : guests === null ? (
          <EmptyBlock message={t('guestsHidden')} />
        ) : guests.length === 0 ? (
          <EmptyBlock message={t('guestsEmpty')} />
        ) : (
          guests.map((guest) => (
            <FormControlLabel
              key={`${guest.guest_id}-${guest.role}`}
              control={
                <Checkbox
                  checked={selected.includes(guest.guest_id)}
                  onChange={() => toggle(guest.guest_id)}
                />
              }
              label={`${guest.full_name} · ${t(`guestRole.${guest.role}`)}`}
            />
          ))
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || selected.length === 0}
          onClick={() =>
            void run(async () => {
              await frontdeskApi.partialDepartureStay(
                tenantId,
                propertyId,
                row.reservation_id,
                row.item_id,
                { guest_ids: selected, version: row.item_version },
              );
              onClose();
            })
          }
        >
          {t('partialDepartureAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function FrontDeskPage() {
  const { t, i18n } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const { propertyId } = useParams<{ propertyId: string }>();
  const [tab, setTab] = useState(0);
  const [date, setDate] = useState<string | null>(null);
  const [assignRow, setAssignRow] = useState<BoardStay | null>(null);
  const [checkInRow, setCheckInRow] = useState<BoardStay | null>(null);
  const [checkOutRow, setCheckOutRow] = useState<BoardStay | null>(null);
  const [moveRow, setMoveRow] = useState<BoardStay | null>(null);
  const [extendRow, setExtendRow] = useState<BoardStay | null>(null);
  const [splitRow, setSplitRow] = useState<BoardStay | null>(null);
  const [earlyRow, setEarlyRow] = useState<BoardStay | null>(null);
  const [partialRow, setPartialRow] = useState<BoardStay | null>(null);

  const canRead = hasPermission('frontdesk.read');
  const canAssign = hasPermission('assignment.manage');
  const canCheckIn = hasPermission('stay.checkin');
  const canMove = hasPermission('stay.move');
  const canCheckOut = hasPermission('stay.checkout');
  const canGuestRead = hasPermission('guest.read');

  const board = useQuery({
    queryKey: ['frontdesk-board', activeTenantId, propertyId, date],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () =>
      frontdeskApi.getBoard(activeTenantId!, propertyId!, date ?? undefined),
  });
  const products = useQuery({
    queryKey: ['products', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () => propertyApi.listProducts(activeTenantId!, propertyId!),
  });
  useEffect(() => {
    if (date === null && board.data?.date) setDate(board.data.date);
  }, [date, board.data?.date]);
  const boardDate = date ?? board.data?.date ?? '';
  const productNames = Object.fromEntries(
    (products.data?.items ?? []).map((product) => [product.id, product.name]),
  );
  const readyRooms = (board.data?.rooms ?? []).filter(
    (room) =>
      room.assignment === null &&
      room.maintenance_state === 'NONE' &&
      ['CLEAN', 'INSPECTED'].includes(room.housekeeping_state),
  ).length;

  const allRows = [
    ...(board.data?.arrivals ?? []),
    ...(board.data?.departures ?? []),
    ...(board.data?.inHouse ?? []),
  ];
  const reservationIds = [
    ...new Set(allRows.map((row) => row.reservation_id)),
  ].slice(0, 20);
  const guests = useQuery({
    queryKey: ['frontdesk-guests', activeTenantId, propertyId, reservationIds],
    enabled: Boolean(
      activeTenantId && propertyId && canGuestRead && reservationIds.length > 0,
    ),
    queryFn: async () => {
      const entries = await Promise.all(
        reservationIds.map(async (reservationId) => {
          const detail = await reservationsApi
            .getReservation(activeTenantId!, propertyId!, reservationId)
            .catch(() => null);
          const lead =
            detail?.guests?.find((guest) => guest.role === 'LEAD') ??
            detail?.guests?.[0];
          return [reservationId, lead?.full_name ?? null] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, string | null>;
    },
  });

  if (!canRead)
    return (
      <div>
        <PageHeader title={t('frontDeskTitle')} />
        <ForbiddenPanel />
      </div>
    );

  const actionPermissions = {
    assign: canAssign,
    checkIn: canCheckIn,
    move: canMove,
    checkout: canCheckOut,
  };

  return (
    <>
      <PageHeader
        title={t('frontDeskTitle')}
        description={
          board.data?.timezone
            ? `${t('frontDeskDescription')} · ${board.data.timezone}`
            : t('frontDeskDescription')
        }
        action={
          <TextField
            size="small"
            type="date"
            label={t('frontDeskDate')}
            value={boardDate}
            onChange={(event) => setDate(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        }
      />
      <div className="frontdesk-summary" aria-label={t('frontDeskSummary')}>
        {[
          [t('arrivalsTab'), board.data?.arrivals.length ?? 0],
          [t('departuresTab'), board.data?.departures.length ?? 0],
          [t('inHouseTab'), board.data?.inHouse.length ?? 0],
          [t('readyRooms'), readyRooms],
        ].map(([label, value]) => (
          <Paper
            className="frontdesk-summary-card"
            variant="outlined"
            key={label}
          >
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
            <Typography variant="h5" component="p">
              {value}
            </Typography>
          </Paper>
        ))}
      </div>
      <Tabs
        value={tab}
        onChange={(_event, value: number) => setTab(value)}
        aria-label={t('frontDeskTitle')}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab label={t('arrivalsTab')} />
        <Tab label={t('departuresTab')} />
        <Tab label={t('inHouseTab')} />
        <Tab label={t('roomRackTab')} />
      </Tabs>
      <ErrorAlert error={board.error ?? products.error} />
      {board.isLoading ? (
        <LoadingBlock />
      ) : tab === 0 ? (
        <StayTable
          rows={board.data?.arrivals ?? []}
          mode="ARRIVALS"
          emptyMessage={t('noArrivals')}
          can={actionPermissions}
          onAssign={setAssignRow}
          onCheckIn={setCheckInRow}
          onCheckOut={setCheckOutRow}
          onMove={setMoveRow}
          onExtend={setExtendRow}
          onSplit={setSplitRow}
          onEarly={setEarlyRow}
          onPartial={setPartialRow}
          guestNames={guests.data ?? {}}
          productNames={productNames}
        />
      ) : tab === 1 ? (
        <StayTable
          rows={board.data?.departures ?? []}
          mode="DEPARTURES"
          emptyMessage={t('noDepartures')}
          can={actionPermissions}
          onAssign={setAssignRow}
          onCheckIn={setCheckInRow}
          onCheckOut={setCheckOutRow}
          onMove={setMoveRow}
          onExtend={setExtendRow}
          onSplit={setSplitRow}
          onEarly={setEarlyRow}
          onPartial={setPartialRow}
          guestNames={guests.data ?? {}}
          productNames={productNames}
        />
      ) : tab === 2 ? (
        <StayTable
          rows={board.data?.inHouse ?? []}
          mode="IN_HOUSE"
          emptyMessage={t('noInHouse')}
          can={actionPermissions}
          onAssign={setAssignRow}
          onCheckIn={setCheckInRow}
          onCheckOut={setCheckOutRow}
          onMove={setMoveRow}
          onExtend={setExtendRow}
          onSplit={setSplitRow}
          onEarly={setEarlyRow}
          onPartial={setPartialRow}
          guestNames={guests.data ?? {}}
          productNames={productNames}
        />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label={t('roomRackTab')}>
            <TableHead>
              <TableRow>
                <TableCell>{t('roomLabel')}</TableCell>
                <TableCell>{t('resourceTypeLabel')}</TableCell>
                <TableCell>{t('roomState')}</TableCell>
                <TableCell>{t('housekeepingStateLabel')}</TableCell>
                <TableCell>{t('maintenanceStateLabel')}</TableCell>
                <TableCell>{t('assignmentLabel')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(board.data?.rooms ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyBlock message={t('noRooms')} />
                  </TableCell>
                </TableRow>
              ) : (
                board.data!.rooms.map((room) => (
                  <TableRow key={room.resource_id}>
                    <TableCell>{resourceLabel(room)}</TableCell>
                    <TableCell>
                      <ResourceTypeChip type={room.resource_type} />
                    </TableCell>
                    <TableCell>{t(`resourceState.${room.state}`)}</TableCell>
                    <TableCell>
                      <HousekeepingChip state={room.housekeeping_state} />
                    </TableCell>
                    <TableCell>
                      <MaintenanceChip state={room.maintenance_state} />
                    </TableCell>
                    <TableCell>
                      {room.assignment
                        ? `${t(`assignmentState.${room.assignment.state}`)} · #${shortId(room.assignment.item_id).toUpperCase()} · ${formatStayPeriod(room.assignment.start_date, room.assignment.end_date, i18n.resolvedLanguage ?? i18n.language).dates}`
                        : '-'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {assignRow && activeTenantId && propertyId ? (
        <AssignRoomDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          row={assignRow}
          onClose={() => setAssignRow(null)}
        />
      ) : null}
      {checkInRow && activeTenantId && propertyId ? (
        <ConfirmDialog
          title={
            checkInRow.group_assignment
              ? t('frontDeskCheckInGroupAction')
              : t('checkInAction')
          }
          message={
            checkInRow.group_assignment
              ? t('confirmGroupCheckIn', {
                  count: checkInRow.allocated_rooms?.length ?? 0,
                })
              : t('confirmCheckIn')
          }
          confirmLabel={
            checkInRow.group_assignment
              ? t('frontDeskCheckInGroupAction')
              : t('checkInAction')
          }
          onClose={() => setCheckInRow(null)}
          onConfirm={() =>
            frontdeskApi.checkInStay(
              activeTenantId,
              propertyId,
              checkInRow.reservation_id,
              checkInRow.item_id,
              {
                resource_id: checkInRow.group_assignment
                  ? undefined
                  : checkInRow.assignment?.resource_id,
                version: checkInRow.item_version,
              },
            )
          }
        />
      ) : null}
      {checkOutRow && activeTenantId && propertyId ? (
        <ConfirmDialog
          title={t('checkOutAction')}
          message={t('confirmCheckOut')}
          confirmLabel={t('checkOutAction')}
          onClose={() => setCheckOutRow(null)}
          onConfirm={() =>
            frontdeskApi.checkOutStay(
              activeTenantId,
              propertyId,
              checkOutRow.reservation_id,
              checkOutRow.item_id,
              { version: checkOutRow.item_version },
            )
          }
        />
      ) : null}
      {moveRow && activeTenantId && propertyId ? (
        <MoveStayDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          row={moveRow}
          rooms={board.data?.rooms ?? []}
          initialDate={boardDate || moveRow.arrival}
          onClose={() => setMoveRow(null)}
        />
      ) : null}
      {extendRow && activeTenantId && propertyId ? (
        <DateActionDialog
          title={t('extendAction')}
          label={t('newDeparture')}
          initialDate={shiftDate(extendRow.departure, 1)}
          minDate={shiftDate(extendRow.departure, 1)}
          confirmLabel={t('extendAction')}
          onClose={() => setExtendRow(null)}
          onSubmit={(value) =>
            frontdeskApi.extendStay(
              activeTenantId,
              propertyId,
              extendRow.reservation_id,
              extendRow.item_id,
              { new_departure: value, version: extendRow.item_version },
            )
          }
        />
      ) : null}
      {splitRow && activeTenantId && propertyId ? (
        <DateActionDialog
          title={t('splitAction')}
          label={t('splitDate')}
          initialDate={boardDate || splitRow.arrival}
          confirmLabel={t('splitAction')}
          onClose={() => setSplitRow(null)}
          onSubmit={(value) =>
            frontdeskApi.splitStay(
              activeTenantId,
              propertyId,
              splitRow.reservation_id,
              splitRow.item_id,
              { at_date: value, version: splitRow.item_version },
            )
          }
        />
      ) : null}
      {earlyRow && activeTenantId && propertyId ? (
        <DateActionDialog
          title={t('earlyDepartureAction')}
          label={t('effectiveDate')}
          initialDate={boardDate || earlyRow.arrival}
          confirmLabel={t('earlyDepartureAction')}
          onClose={() => setEarlyRow(null)}
          onSubmit={(value) =>
            frontdeskApi.earlyDepartureStay(
              activeTenantId,
              propertyId,
              earlyRow.reservation_id,
              earlyRow.item_id,
              { effective_date: value, version: earlyRow.item_version },
            )
          }
        />
      ) : null}
      {partialRow && activeTenantId && propertyId ? (
        <PartialDepartureDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          row={partialRow}
          onClose={() => setPartialRow(null)}
        />
      ) : null}
    </>
  );
}
