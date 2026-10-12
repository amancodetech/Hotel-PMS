import { useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Paper,
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
import {
  reservationsApi,
  type Guest,
  type ReservationSummary,
} from '../api/reservations.js';
import { ImportExceptionsTab } from './ImportExceptionsTab.js';

const sources = ['DIRECT', 'OTA', 'IMPORT'] as const;

function today(offsetDays: number) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function ReservationsPage() {
  const { t } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const { propertyId } = useParams<{ propertyId: string }>();
  const [tab, setTab] = useState('reservations');
  const [calendarDays] = useState(14);
  const canRead = hasPermission('reservation.read');
  const canCreate = hasPermission('reservation.create');
  const canGuestRead = hasPermission('guest.read');
  const canGuestManage = hasPermission('guest.manage');
  const canReprocess = hasPermission('channel.reprocess');
  const canImportTab = canCreate || canReprocess;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [guestOpen, setGuestOpen] = useState(false);
  const [search, setSearch] = useState('');

  const reservations = useQuery({
    queryKey: ['reservations', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () =>
      reservationsApi.listReservations(activeTenantId!, propertyId!, {
        limit: 50,
      }),
  });

  const guests = useQuery({
    queryKey: ['guests', activeTenantId, search],
    enabled: Boolean(activeTenantId && canGuestRead && tab === 'guests'),
    queryFn: () =>
      reservationsApi.listGuests(activeTenantId!, {
        search: search || undefined,
        limit: 50,
      }),
  });

  const calendar = useQuery({
    queryKey: ['reservation-calendar', activeTenantId, propertyId],
    enabled: Boolean(
      activeTenantId && propertyId && canRead && tab === 'calendar',
    ),
    queryFn: async () => {
      const list = await reservationsApi.listReservations(
        activeTenantId!,
        propertyId!,
        { limit: 20 },
      );
      const details = await Promise.all(
        list.items
          .slice(0, 20)
          .map((row) =>
            reservationsApi
              .getReservation(activeTenantId!, propertyId!, row.id)
              .catch(() => null),
          ),
      );
      const days: Array<{ date: string; count: number }> = [];
      for (let offset = 0; offset < calendarDays; offset += 1) {
        const date = new Date();
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() + offset);
        const key = date.toISOString().slice(0, 10);
        let count = 0;
        for (const entry of details) {
          if (!entry) continue;
          for (const item of entry.items) {
            if (item.state === 'CANCELLED' || item.state === 'NO_SHOW')
              continue;
            if (item.period.arrival <= key && key < item.period.departure)
              count += 1;
          }
        }
        days.push({ date: key, count });
      }
      return days;
    },
  });

  const detail = useQuery({
    queryKey: ['reservation', activeTenantId, propertyId, selectedId],
    enabled: Boolean(activeTenantId && propertyId && selectedId),
    queryFn: () =>
      reservationsApi.getReservation(activeTenantId!, propertyId!, selectedId!),
  });

  if (!canRead) return <ForbiddenPanel />;

  return (
    <>
      <PageHeader
        title={t('reservationsTitle')}
        description={t('reservationsDescription')}
        action={
          canCreate ? (
            <Button variant="contained" onClick={() => setDraftOpen(true)}>
              {t('createDraft')}
            </Button>
          ) : undefined
        }
      />
      <Tabs
        value={tab}
        onChange={(_event, value: string) => setTab(value)}
        aria-label={t('reservationsTitle')}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab value="reservations" label={t('reservationsSection')} />
        <Tab value="calendar" label={t('calendarSection')} />
        {canGuestRead ? (
          <Tab value="guests" label={t('guestsSection')} />
        ) : null}
        {canImportTab ? (
          <Tab value="import" label={t('importSection')} />
        ) : null}
      </Tabs>
      {tab === 'import' ? (
        <ImportExceptionsTab
          tenantId={activeTenantId!}
          propertyId={propertyId!}
          canImport={canCreate}
          canReprocess={canReprocess}
        />
      ) : tab === 'calendar' ? (
        <>
          <ErrorAlert error={calendar.error} />
          {calendar.isLoading ? (
            <LoadingBlock />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('calendarDate')}</TableCell>
                    <TableCell>{t('calendarOccupancy')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(calendar.data ?? []).map((day) => (
                    <TableRow key={day.date}>
                      <TableCell>{day.date}</TableCell>
                      <TableCell>{day.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      ) : tab === 'reservations' ? (
        <>
          <ErrorAlert error={reservations.error} />
          {reservations.isLoading ? (
            <LoadingBlock />
          ) : (
            <TableContainer
              className="reservation-table-container"
              component={Paper}
              variant="outlined"
            >
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('reservationState')}</TableCell>
                    <TableCell>{t('reservationSource')}</TableCell>
                    <TableCell>{t('reservationItems')}</TableCell>
                    <TableCell>{t('reservationCreatedAt')}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(reservations.data?.items ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <EmptyBlock message={t('reservationsEmpty')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    reservations.data!.items.map((row: ReservationSummary) => (
                      <TableRow key={row.id}>
                        <TableCell data-label={t('reservationState')}>
                          <Chip
                            size="small"
                            label={t(`reservationState.${row.state}`)}
                          />
                        </TableCell>
                        <TableCell data-label={t('reservationSource')}>
                          {row.source}
                        </TableCell>
                        <TableCell data-label={t('reservationItems')}>
                          {row.item_count} · {row.item_states.join(', ')}
                        </TableCell>
                        <TableCell data-label={t('reservationCreatedAt')}>
                          {row.created_at.slice(0, 16)}
                        </TableCell>
                        <TableCell data-label={t('actions')}>
                          <Button
                            size="small"
                            onClick={() => setSelectedId(row.id)}
                          >
                            {t('viewDetails')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      ) : (
        <>
          <TextField
            margin="dense"
            fullWidth
            label={t('guestSearch')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ErrorAlert error={guests.error} />
          {guests.isLoading ? (
            <LoadingBlock />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('guestName')}</TableCell>
                    <TableCell>{t('guestGenderLabel')}</TableCell>
                    <TableCell>{t('guestEmail')}</TableCell>
                    <TableCell>{t('guestPhone')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(guests.data?.items ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <EmptyBlock message={t('guestsEmpty')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    guests.data!.items.map((guest: Guest) => (
                      <TableRow key={guest.id}>
                        <TableCell>{guest.full_name}</TableCell>
                        <TableCell>
                          {guest.gender
                            ? t(`guestGender.${guest.gender}`)
                            : t('guestGender.UNKNOWN')}
                        </TableCell>
                        <TableCell>{guest.email ?? '-'}</TableCell>
                        <TableCell>{guest.phone ?? '-'}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {canGuestManage ? (
            <Button
              variant="outlined"
              sx={{ mt: 1 }}
              onClick={() => setGuestOpen(true)}
            >
              {t('createGuest')}
            </Button>
          ) : null}
        </>
      )}
      {selectedId ? (
        <Dialog
          open
          onClose={() => setSelectedId(null)}
          fullWidth
          maxWidth="md"
        >
          <DialogTitle>{t('reservationDetails')}</DialogTitle>
          <DialogContent>
            <ErrorAlert error={detail.error} />
            {detail.isLoading || !detail.data ? (
              <LoadingBlock />
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  {t('reservationSource')}: {detail.data.reservation.source} ·{' '}
                  {t('reservationState')}:{' '}
                  {t(`reservationState.${detail.data.reservation.state}`)} · v
                  {detail.data.reservation.version}
                </Typography>
                <Table size="small" sx={{ mt: 1 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('reservationItemPeriod')}</TableCell>
                      <TableCell>{t('reservationGuests')}</TableCell>
                      <TableCell>{t('reservationState')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {detail.data.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          {item.period.arrival} → {item.period.departure}
                        </TableCell>
                        <TableCell>
                          {item.occupancy.adults}
                          {item.occupancy.child_ages.length > 0
                            ? ` + ${item.occupancy.child_ages.length}`
                            : ''}
                        </TableCell>
                        <TableCell>
                          {t(`reservationState.${item.state}`)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {detail.data.guests === null ? (
                  <EmptyBlock message={t('guestsHidden')} />
                ) : detail.data.guests.length === 0 ? (
                  <EmptyBlock message={t('guestsEmpty')} />
                ) : (
                  <ul>
                    {detail.data.guests.map((guest) => (
                      <li key={`${guest.guest_id}-${guest.role}`}>
                        {guest.full_name} · {t(`guestRole.${guest.role}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setSelectedId(null)}>{t('close')}</Button>
          </DialogActions>
        </Dialog>
      ) : null}
      {draftOpen ? (
        <DraftDialog
          tenantId={activeTenantId!}
          propertyId={propertyId!}
          canGuestRead={canGuestRead}
          onClose={() => setDraftOpen(false)}
          onCreated={(id) => {
            setDraftOpen(false);
            setSelectedId(id);
          }}
        />
      ) : null}
      {guestOpen ? (
        <GuestDialog
          tenantId={activeTenantId!}
          onClose={() => setGuestOpen(false)}
        />
      ) : null}
    </>
  );
}

function DraftDialog({
  tenantId,
  propertyId,
  canGuestRead,
  onClose,
  onCreated,
}: {
  tenantId: string;
  propertyId: string;
  canGuestRead: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [source, setSource] = useState<(typeof sources)[number]>('DIRECT');
  const [arrival, setArrival] = useState(today(1));
  const [departure, setDeparture] = useState(today(3));
  const [adults, setAdults] = useState(2);
  const [quantity, setQuantity] = useState(1);
  const [guestId, setGuestId] = useState('');
  const guests = useQuery({
    queryKey: ['guests', tenantId, 'draft-picker'],
    enabled: canGuestRead,
    queryFn: () => reservationsApi.listGuests(tenantId, { limit: 100 }),
  });
  const valid = arrival < departure && adults >= 1;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('createDraft')}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          select
          margin="dense"
          fullWidth
          label={t('reservationSource')}
          value={source}
          onChange={(event) =>
            setSource(event.target.value as (typeof sources)[number])
          }
        >
          {sources.map((value) => (
            <MenuItem key={value} value={value}>
              {value}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          margin="dense"
          fullWidth
          type="date"
          label={t('arrival')}
          value={arrival}
          onChange={(event) => setArrival(event.target.value)}
        />
        <TextField
          margin="dense"
          fullWidth
          type="date"
          label={t('departure')}
          value={departure}
          onChange={(event) => setDeparture(event.target.value)}
        />
        <TextField
          margin="dense"
          fullWidth
          type="number"
          label={t('adults')}
          value={adults}
          onChange={(event) => setAdults(Number(event.target.value))}
        />
        <TextField
          margin="dense"
          fullWidth
          type="number"
          label={t('quantity')}
          value={quantity}
          onChange={(event) => setQuantity(Number(event.target.value))}
        />
        {canGuestRead ? (
          <TextField
            select
            margin="dense"
            fullWidth
            label={t('leadGuest')}
            value={guestId}
            onChange={(event) => setGuestId(event.target.value)}
          >
            <MenuItem value="">-</MenuItem>
            {(guests.data?.items ?? []).map((guest) => (
              <MenuItem key={guest.id} value={guest.id}>
                {guest.full_name}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
        <ErrorAlert error={error} />
        <Typography variant="caption" color="text.secondary">
          {t('draftUnconfirmedNotice')}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !valid}
          onClick={() =>
            void run(async () => {
              const result = await reservationsApi.createReservationDraft(
                tenantId,
                propertyId,
                {
                  source,
                  items: [
                    {
                      period: { arrival, departure },
                      occupancy: { adults, child_ages: [] },
                      quantity,
                    },
                  ],
                  guests: guestId
                    ? [{ guest_id: guestId, role: 'LEAD' }]
                    : undefined,
                },
              );
              onCreated(result.reservation.id);
            })
          }
        >
          {t('save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function GuestDialog({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<'' | 'FEMALE' | 'MALE'>('');
  const valid = fullName.trim().length > 1;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('createGuest')}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          autoFocus
          margin="dense"
          fullWidth
          label={t('guestName')}
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
        />
        <TextField
          margin="dense"
          fullWidth
          label={t('guestEmail')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          margin="dense"
          fullWidth
          label={t('guestPhone')}
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <TextField
          margin="dense"
          fullWidth
          select
          label={t('guestGenderLabel')}
          value={gender}
          onChange={(event) =>
            setGender(event.target.value as '' | 'FEMALE' | 'MALE')
          }
        >
          <MenuItem value="">{t('guestGender.UNKNOWN')}</MenuItem>
          <MenuItem value="FEMALE">{t('guestGender.FEMALE')}</MenuItem>
          <MenuItem value="MALE">{t('guestGender.MALE')}</MenuItem>
        </TextField>
        <ErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !valid}
          onClick={() =>
            void run(async () => {
              await reservationsApi.createGuest(tenantId, {
                full_name: fullName.trim(),
                email: email.trim() || null,
                phone: phone.trim() || null,
                gender: gender || null,
              });
              onClose();
            })
          }
        >
          {t('save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
