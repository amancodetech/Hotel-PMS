import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Switch,
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
import { useTranslation } from 'react-i18next';
import { currencyOptions, propertyApi } from '../api/property.js';
import type { Property } from '../api/property.js';
import { inventoryApi } from '../api/inventory.js';
import type {
  ExposurePreview,
  ExposureOperationResult,
  Hold,
  Money,
  PriceQuote,
  RatePlan,
  ReconcileResult,
  SaleResult,
  SearchResult,
} from '../api/inventory.js';
import { useAuth } from '../auth/AuthProvider.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  ReasonDialog,
  formatDateTime,
  translatedOrFallback,
  useApiAction,
} from '../identity/shared.js';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';

const amountPattern = /^\d{1,18}(\.\d{1,6})?$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    return dates;
  const cursor = start;
  while (cursor < end && dates.length < 62) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function moneyText(money: Money): string {
  return `${money.amount} ${money.currency}`;
}

function ValueChip({
  prefix,
  value,
  color,
}: {
  prefix: string;
  value: string;
  color?: 'success' | 'warning' | 'error' | 'default' | 'info';
}) {
  const { t } = useTranslation();
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={translatedOrFallback(t, `${prefix}.${value}`, value)}
    />
  );
}

function ReasonChips({ codes }: { codes: string[] }) {
  const { t } = useTranslation();
  if (codes.length === 0) return null;
  return (
    <span className="chip-row">
      {codes.map((code) => (
        <Chip
          key={code}
          size="small"
          variant="outlined"
          color="warning"
          label={translatedOrFallback(t, `reason.${code}`, code)}
        />
      ))}
    </span>
  );
}

interface PanelProps {
  tenantId: string;
  propertyId: string;
  property: Property;
}

function RatePlansPanel({ tenantId, propertyId }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canManage = useAuth().hasPermission('rate.manage');
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [productId, setProductId] = useState('');
  const [currency, setCurrency] = useState('IDR');
  const [occupancyBasis, setOccupancyBasis] = useState('2');
  const [mealPlan, setMealPlan] = useState('NONE');
  const [freePolicy, setFreePolicy] = useState(false);
  const plans = useQuery({
    queryKey: ['rate-plans', tenantId, propertyId],
    enabled: canManage,
    queryFn: () => inventoryApi.listRatePlans(tenantId, propertyId),
  });
  const products = useQuery({
    queryKey: ['products', tenantId, propertyId],
    enabled: canManage,
    queryFn: () => propertyApi.listProducts(tenantId, propertyId),
  });
  if (!canManage) return <ForbiddenPanel />;
  const transition = (plan: RatePlan, status: RatePlan['status']) =>
    run(() =>
      inventoryApi.updateRatePlan(tenantId, propertyId, plan.id, {
        version: plan.version,
        status,
      }),
    );
  return (
    <div>
      <ErrorAlert error={error ?? plans.error} />
      <div className="row-actions">
        <Button variant="outlined" onClick={() => setOpen(true)}>
          {t('newRatePlan')}
        </Button>
      </div>
      {plans.isLoading ? (
        <LoadingBlock />
      ) : plans.data && plans.data.items.length === 0 ? (
        <EmptyBlock message={t('noRatePlans')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('ratePlanCode')}</TableCell>
                <TableCell>{t('ratePlanName')}</TableCell>
                <TableCell>{t('ratePlanCurrency')}</TableCell>
                <TableCell>{t('occupancyBasis')}</TableCell>
                <TableCell>{t('status')}</TableCell>
                <TableCell>{t('versionNumber')}</TableCell>
                <TableCell>{t('actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {plans.data?.items.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell>{plan.code}</TableCell>
                  <TableCell>{plan.name}</TableCell>
                  <TableCell>{plan.currency}</TableCell>
                  <TableCell>{plan.occupancy_basis}</TableCell>
                  <TableCell>
                    <ValueChip prefix="ratePlanStatus" value={plan.status} />
                  </TableCell>
                  <TableCell>{plan.version}</TableCell>
                  <TableCell className="row-actions">
                    {plan.status === 'DRAFT' || plan.status === 'SUSPENDED' ? (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => void transition(plan, 'ACTIVE')}
                      >
                        {t('activate')}
                      </Button>
                    ) : null}
                    {plan.status === 'ACTIVE' ? (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => void transition(plan, 'SUSPENDED')}
                      >
                        {t('suspend')}
                      </Button>
                    ) : null}
                    {plan.status !== 'RETIRED' ? (
                      <Button
                        size="small"
                        color="warning"
                        disabled={busy}
                        onClick={() => void transition(plan, 'RETIRED')}
                      >
                        {t('retire')}
                      </Button>
                    ) : null}
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
        <DialogTitle>{t('newRatePlan')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            fullWidth
            margin="dense"
            label={t('ratePlanCode')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('ratePlanName')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
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
            select
            fullWidth
            margin="dense"
            label={t('ratePlanCurrency')}
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
            fullWidth
            margin="dense"
            type="number"
            label={t('occupancyBasis')}
            value={occupancyBasis}
            onChange={(event) => setOccupancyBasis(event.target.value)}
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
          <FormControlLabel
            control={
              <Switch
                checked={freePolicy}
                onChange={(event) => setFreePolicy(event.target.checked)}
              />
            }
            label={t('freePolicy')}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={
              busy ||
              !code.trim() ||
              !name.trim() ||
              !productId ||
              !occupancyBasis
            }
            onClick={async () => {
              const created = await run(() =>
                inventoryApi.createRatePlan(tenantId, propertyId, {
                  code: code.trim(),
                  name: name.trim(),
                  product_id: productId,
                  currency: currency === 'USD' ? 'USD' : 'IDR',
                  occupancy_basis: Number(occupancyBasis),
                  meal_plan: mealPlan === 'BREAKFAST' ? 'BREAKFAST' : 'NONE',
                  free_policy: freePolicy,
                }),
              );
              if (created) {
                setOpen(false);
                setCode('');
                setName('');
                setProductId('');
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

function RateCalendarPanel({ tenantId, propertyId }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canManage = useAuth().hasPermission('rate.manage');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(shiftDate(todayIso(), 7));
  const [cell, setCell] = useState<{ plan: RatePlan; date: string } | null>(
    null,
  );
  const [amount, setAmount] = useState('');
  const [occupancy, setOccupancy] = useState('2');
  const [saved, setSaved] = useState(false);
  const calendar = useQuery({
    queryKey: ['rate-calendar', tenantId, propertyId, from, to],
    enabled: canManage && Boolean(from) && Boolean(to),
    queryFn: () => inventoryApi.getRateCalendar(tenantId, propertyId, from, to),
  });
  if (!canManage) return <ForbiddenPanel />;
  const dates = dateRange(from, to);
  const amountValid = amountPattern.test(amount.trim());
  const openCell = (plan: RatePlan, date: string) => {
    const existing = calendar.data?.prices.find(
      (price) => price.rate_plan_id === plan.id && price.date === date,
    );
    setCell({ plan, date });
    setOccupancy(String(existing?.occupancy ?? plan.occupancy_basis));
    setAmount(existing?.money.amount ?? '');
    setSaved(false);
  };
  return (
    <div>
      <ErrorAlert error={error ?? calendar.error} />
      <div className="row-actions">
        <TextField
          margin="dense"
          type="date"
          label={t('fromDate')}
          InputLabelProps={{ shrink: true }}
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <TextField
          margin="dense"
          type="date"
          label={t('toDate')}
          InputLabelProps={{ shrink: true }}
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      {saved ? <Alert severity="success">{t('ratesSaved')}</Alert> : null}
      <Typography color="text.secondary" variant="body2">
        {t('inventoryVersion')}: {calendar.data?.inventory_version ?? '-'}
      </Typography>
      {calendar.isLoading ? (
        <LoadingBlock />
      ) : dates.length === 0 || !calendar.data?.plans.length ? (
        <EmptyBlock message={t('noRates')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('nightDate')}</TableCell>
                {calendar.data?.plans.map((plan) => (
                  <TableCell key={plan.id}>{plan.code}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {dates.map((date) => (
                <TableRow key={date}>
                  <TableCell>{date}</TableCell>
                  {calendar.data?.plans.map((plan) => {
                    const price =
                      calendar.data?.prices.find(
                        (entry) =>
                          entry.rate_plan_id === plan.id &&
                          entry.date === date &&
                          entry.occupancy === plan.occupancy_basis,
                      ) ??
                      calendar.data?.prices.find(
                        (entry) =>
                          entry.rate_plan_id === plan.id && entry.date === date,
                      );
                    return (
                      <TableCell key={plan.id}>
                        <Button
                          size="small"
                          onClick={() => openCell(plan, date)}
                        >
                          {price ? moneyText(price.money) : '—'}
                        </Button>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Dialog
        open={cell !== null}
        onClose={() => setCell(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t('setRates')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('ratePlan')}
            value={cell?.plan.id ?? ''}
            onChange={(event) => {
              const plan = calendar.data?.plans.find(
                (entry) => entry.id === event.target.value,
              );
              if (plan) setCell({ plan, date: cell?.date ?? todayIso() });
            }}
          >
            {calendar.data?.plans.map((plan) => (
              <MenuItem key={plan.id} value={plan.id}>
                {plan.code}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            type="date"
            label={t('nightDate')}
            InputLabelProps={{ shrink: true }}
            value={cell?.date ?? ''}
            onChange={(event) => {
              if (cell) setCell({ ...cell, date: event.target.value });
            }}
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
            fullWidth
            margin="dense"
            label={t('amount')}
            value={amount}
            error={amount.length > 0 && !amountValid}
            helperText={`${t('ratePlanCurrency')}: ${cell?.plan.currency ?? '-'}`}
            onChange={(event) => setAmount(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCell(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={busy || !cell || !amountValid || !occupancy}
            onClick={async () => {
              if (!cell) return;
              const result = await run(() =>
                inventoryApi.setRates(tenantId, propertyId, [
                  {
                    rate_plan_id: cell.plan.id,
                    date: cell.date,
                    occupancy: Number(occupancy),
                    money: {
                      amount: amount.trim(),
                      currency: cell.plan.currency,
                    },
                  },
                ]),
              );
              if (result) {
                setCell(null);
                setSaved(true);
              }
            }}
          >
            {t('setRates')}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

function AvailabilityPanel({ tenantId, propertyId }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canRead = useAuth().hasPermission('reservation.read');
  const canHold = useAuth().hasPermission('reservation.create');
  const [productIds, setProductIds] = useState<string[]>([]);
  const [arrival, setArrival] = useState(todayIso());
  const [departure, setDeparture] = useState(shiftDate(todayIso(), 1));
  const [adults, setAdults] = useState('2');
  const [quantity, setQuantity] = useState('1');
  const [ttl, setTtl] = useState('900');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const products = useQuery({
    queryKey: ['products', tenantId, propertyId],
    enabled: canRead,
    queryFn: () => propertyApi.listProducts(tenantId, propertyId),
  });
  const resources = useQuery({
    queryKey: ['resources', tenantId, propertyId],
    enabled: canHold,
    queryFn: () => propertyApi.listResources(tenantId, propertyId),
  });
  if (!canRead) return <ForbiddenPanel />;
  const productLabel = (productId: string) =>
    products.data?.items.find((product) => product.id === productId)?.code ??
    shortId(productId);
  const search = async () => {
    const found = await run(() =>
      inventoryApi.searchAvailability(tenantId, propertyId, {
        product_ids: productIds,
        period: { arrival, departure },
        occupancy: { adults: Number(adults), child_ages: [] },
        quantity: Number(quantity),
      }),
    );
    if (found) {
      setResult(found);
      setQuote(null);
      setHold(null);
    }
  };
  return (
    <div>
      <ErrorAlert error={error ?? products.error} />
      <div className="dialog-form">
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('product')}
          SelectProps={{ multiple: true }}
          value={productIds}
          onChange={(event) =>
            setProductIds(
              Array.isArray(event.target.value)
                ? event.target.value
                : [event.target.value],
            )
          }
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
          label={t('arrivalDate')}
          InputLabelProps={{ shrink: true }}
          value={arrival}
          onChange={(event) => setArrival(event.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          type="date"
          label={t('departureDate')}
          InputLabelProps={{ shrink: true }}
          value={departure}
          onChange={(event) => setDeparture(event.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          type="number"
          label={t('adultsLabel')}
          value={adults}
          onChange={(event) => setAdults(event.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          type="number"
          label={t('quantity')}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </div>
      <div className="row-actions">
        <Button
          variant="contained"
          disabled={
            busy ||
            productIds.length === 0 ||
            !arrival ||
            !departure ||
            arrival >= departure
          }
          onClick={() => void search()}
        >
          {t('searchAvailability')}
        </Button>
      </div>
      {result ? (
        <div>
          <Typography className="section-title" component="h3" variant="h2">
            {t('availabilitySection')}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {t('inventoryVersion')}: {result.inventory_version}
          </Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('product')}</TableCell>
                  <TableCell>{t('status')}</TableCell>
                  <TableCell>{t('reasonCodes')}</TableCell>
                  <TableCell>{t('actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {result.offers.map((offer) => (
                  <TableRow key={offer.product_id}>
                    <TableCell>{productLabel(offer.product_id)}</TableCell>
                    <TableCell>
                      <ValueChip
                        prefix="availabilityResult"
                        value={offer.result}
                        color={
                          offer.result === 'AVAILABLE' ? 'success' : 'warning'
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <ReasonChips codes={offer.reason_codes} />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={async () => {
                          const quoted = await run(() =>
                            inventoryApi.quoteStay(tenantId, propertyId, {
                              product_id: offer.product_id,
                              period: { arrival, departure },
                              occupancy: {
                                adults: Number(adults),
                                child_ages: [],
                              },
                              quantity: Number(quantity),
                            }),
                          );
                          if (quoted) setQuote(quoted.quote);
                        }}
                      >
                        {t('quote')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {quote ? (
            <Alert severity="info" role="status">
              {t('totalAmount')}: {moneyText(quote.total_money)} ·{' '}
              {productLabel(quote.product_id)}
            </Alert>
          ) : null}
          {canHold ? (
            <div className="dialog-form">
              <TextField
                fullWidth
                margin="dense"
                type="number"
                label={t('holdTtl')}
                value={ttl}
                onChange={(event) => setTtl(event.target.value)}
              />
              <div className="row-actions">
                <Button
                  variant="outlined"
                  disabled={
                    busy ||
                    !Number.isInteger(Number(ttl)) ||
                    Number(ttl) < 30 ||
                    Number(ttl) > 900
                  }
                  onClick={async () => {
                    const created = await run(() =>
                      inventoryApi.createHold(tenantId, propertyId, {
                        items: productIds.map((productId) => ({
                          product_id: productId,
                          period: { arrival, departure },
                          occupancy: {
                            adults: Number(adults),
                            child_ages: [],
                          },
                          quantity: Number(quantity),
                          price_snapshot_id:
                            quote && quote.product_id === productId
                              ? quote.id
                              : null,
                        })),
                        inventory_version: result.inventory_version,
                        ttl_seconds: Number(ttl),
                      }),
                    );
                    if (created) setHold(created.hold);
                  }}
                >
                  {t('createHold')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {hold ? (
        <Paper variant="outlined" component="section">
          <Typography className="section-title" component="h3" variant="h2">
            {t('createHold')}
          </Typography>
          <Typography variant="body2">
            {t('status')}: <ValueChip prefix="holdState" value={hold.state} />
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {t('expiresAt')}: {formatDateTime(hold.expires_at)}
          </Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('resource')}</TableCell>
                  <TableCell>{t('fromDate')}</TableCell>
                  <TableCell>{t('toDate')}</TableCell>
                  <TableCell>{t('status')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {hold.allocations.map((allocation) => (
                  <TableRow key={allocation.id}>
                    <TableCell>
                      {resources.data?.items.find(
                        (resource) => resource.id === allocation.resource_id,
                      )?.code ?? shortId(allocation.resource_id)}
                    </TableCell>
                    <TableCell>{allocation.start_date}</TableCell>
                    <TableCell>{allocation.end_date}</TableCell>
                    <TableCell>
                      <ValueChip prefix="holdState" value={allocation.state} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <div className="row-actions">
            <Button
              variant="outlined"
              disabled={busy || hold.state !== 'ACTIVE'}
              onClick={async () => {
                const released = await run(() =>
                  inventoryApi.releaseHold(tenantId, propertyId, hold.id),
                );
                if (released) setHold(released.hold);
              }}
            >
              {t('release')}
            </Button>
          </div>
        </Paper>
      ) : null}
    </div>
  );
}

function HoldsBlocksPanel({ tenantId, propertyId }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canReserveRead = useAuth().hasPermission('reservation.read');
  const canHold = useAuth().hasPermission('reservation.create');
  const canBlock = useAuth().hasPermission('inventory.block');
  const canMaintain = useAuth().hasPermission('property.resource.manage');
  const emergency = useAuth().hasPermission('maintenance.emergency');
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockResourceIds, setBlockResourceIds] = useState<string[]>([]);
  const [blockArrival, setBlockArrival] = useState(todayIso());
  const [blockDeparture, setBlockDeparture] = useState(
    shiftDate(todayIso(), 1),
  );
  const [blockReason, setBlockReason] = useState('');
  const [blockMode, setBlockMode] = useState<'PLANNED' | 'EMERGENCY'>(
    'PLANNED',
  );
  const [releaseFor, setReleaseFor] = useState<string | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [maintenanceResourceId, setMaintenanceResourceId] = useState('');
  const [maintenanceMode, setMaintenanceMode] = useState<
    'NONE' | 'OOO' | 'OOS'
  >('NONE');
  const [maintenanceReason, setMaintenanceReason] = useState('');
  const holds = useQuery({
    queryKey: ['holds', tenantId, propertyId],
    enabled: canReserveRead,
    queryFn: () => inventoryApi.listHolds(tenantId, propertyId),
  });
  const blocks = useQuery({
    queryKey: ['blocks', tenantId, propertyId],
    enabled: true,
    queryFn: () => inventoryApi.listBlocks(tenantId, propertyId),
  });
  const resources = useQuery({
    queryKey: ['resources', tenantId, propertyId],
    enabled: canBlock || canMaintain,
    queryFn: () => propertyApi.listResources(tenantId, propertyId),
  });
  const maintenanceResource = resources.data?.items.find(
    (resource) => resource.id === maintenanceResourceId,
  );
  return (
    <div>
      <ErrorAlert error={error ?? holds.error ?? blocks.error} />
      {canReserveRead ? (
        <div>
          <Typography className="section-title" component="h3" variant="h2">
            {t('holdsSection')}
          </Typography>
          {holds.isLoading ? (
            <LoadingBlock />
          ) : holds.data && holds.data.items.length === 0 ? (
            <EmptyBlock message={t('noHolds')} />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('providerKey')}</TableCell>
                    <TableCell>{t('status')}</TableCell>
                    <TableCell>{t('expiresAt')}</TableCell>
                    <TableCell>{t('allocations')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {holds.data?.items.map((hold) => (
                    <TableRow key={hold.id}>
                      <TableCell>{shortId(hold.id)}</TableCell>
                      <TableCell>
                        <ValueChip prefix="holdState" value={hold.state} />
                      </TableCell>
                      <TableCell>{formatDateTime(hold.expires_at)}</TableCell>
                      <TableCell>
                        {hold.allocations
                          .map(
                            (allocation) =>
                              `${allocation.start_date} → ${allocation.end_date}`,
                          )
                          .join(', ') || '—'}
                      </TableCell>
                      <TableCell>
                        {canHold && hold.state === 'ACTIVE' ? (
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                inventoryApi.releaseHold(
                                  tenantId,
                                  propertyId,
                                  hold.id,
                                ),
                              )
                            }
                          >
                            {t('release')}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </div>
      ) : null}
      <Typography className="section-title" component="h3" variant="h2">
        {t('blocksSection')}
      </Typography>
      <div className="row-actions">
        {canBlock ? (
          <Button variant="outlined" onClick={() => setBlockOpen(true)}>
            {t('createBlock')}
          </Button>
        ) : null}
        {canMaintain ? (
          <Button variant="outlined" onClick={() => setMaintenanceOpen(true)}>
            {t('maintenanceAction')}
          </Button>
        ) : null}
      </div>
      {blocks.isLoading ? (
        <LoadingBlock />
      ) : blocks.data && blocks.data.items.length === 0 ? (
        <EmptyBlock message={t('noBlocks')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('blockMode')}</TableCell>
                <TableCell>{t('fromDate')}</TableCell>
                <TableCell>{t('toDate')}</TableCell>
                <TableCell>{t('resources')}</TableCell>
                <TableCell>{t('reasonLabel')}</TableCell>
                <TableCell>{t('status')}</TableCell>
                <TableCell>{t('actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {blocks.data?.items.map((block) => (
                <TableRow key={block.id}>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={block.mode === 'EMERGENCY' ? 'error' : 'default'}
                      label={t(
                        block.mode === 'PLANNED' ? 'planned' : 'emergency',
                      )}
                    />
                  </TableCell>
                  <TableCell>{block.start_date}</TableCell>
                  <TableCell>{block.end_date}</TableCell>
                  <TableCell>
                    {block.resource_ids
                      .map(
                        (resourceId) =>
                          resources.data?.items.find(
                            (resource) => resource.id === resourceId,
                          )?.code ?? shortId(resourceId),
                      )
                      .join(', ')}
                  </TableCell>
                  <TableCell>{block.reason}</TableCell>
                  <TableCell>
                    <ValueChip prefix="blockState" value={block.state} />
                  </TableCell>
                  <TableCell>
                    {canBlock && block.state === 'ACTIVE' ? (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => setReleaseFor(block.id)}
                      >
                        {t('releaseBlock')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Typography className="section-title" component="h3" variant="h2">
        {t('disruptions')}
      </Typography>
      {blocks.data && blocks.data.disruptions.length === 0 ? (
        <EmptyBlock message={t('noDisruptions')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('resource')}</TableCell>
                <TableCell>{t('fromDate')}</TableCell>
                <TableCell>{t('toDate')}</TableCell>
                <TableCell>{t('reasonLabel')}</TableCell>
                <TableCell>{t('status')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {blocks.data?.disruptions.map((disruption) => (
                <TableRow key={disruption.id}>
                  <TableCell>
                    {resources.data?.items.find(
                      (resource) => resource.id === disruption.resource_id,
                    )?.code ?? shortId(disruption.resource_id)}
                  </TableCell>
                  <TableCell>{disruption.start_date}</TableCell>
                  <TableCell>{disruption.end_date}</TableCell>
                  <TableCell>{disruption.note ?? '—'}</TableCell>
                  <TableCell>
                    <ValueChip
                      prefix="disruptionState"
                      value={disruption.state}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Dialog
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('createBlock')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('resources')}
            SelectProps={{ multiple: true }}
            value={blockResourceIds}
            onChange={(event) =>
              setBlockResourceIds(
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
            fullWidth
            margin="dense"
            type="date"
            label={t('fromDate')}
            InputLabelProps={{ shrink: true }}
            value={blockArrival}
            onChange={(event) => setBlockArrival(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            type="date"
            label={t('toDate')}
            InputLabelProps={{ shrink: true }}
            value={blockDeparture}
            onChange={(event) => setBlockDeparture(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('reasonLabel')}
            value={blockReason}
            onChange={(event) => setBlockReason(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('blockMode')}
            value={blockMode}
            onChange={(event) =>
              setBlockMode(
                event.target.value === 'EMERGENCY' ? 'EMERGENCY' : 'PLANNED',
              )
            }
          >
            <MenuItem value="PLANNED">{t('planned')}</MenuItem>
            <MenuItem value="EMERGENCY" disabled={!emergency}>
              {t('emergency')}
            </MenuItem>
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBlockOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={
              busy ||
              blockResourceIds.length === 0 ||
              !blockArrival ||
              !blockDeparture ||
              blockArrival >= blockDeparture ||
              blockReason.trim().length === 0 ||
              (blockMode === 'EMERGENCY' && !emergency)
            }
            onClick={async () => {
              const created = await run(() =>
                inventoryApi.createBlock(tenantId, propertyId, {
                  resource_ids: blockResourceIds,
                  period: {
                    arrival: blockArrival,
                    departure: blockDeparture,
                  },
                  reason: blockReason.trim(),
                  mode: blockMode,
                }),
              );
              if (created) {
                setBlockOpen(false);
                setBlockResourceIds([]);
                setBlockReason('');
              }
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
      <ReasonDialog
        open={releaseFor !== null}
        title={t('releaseBlock')}
        confirmLabel={t('releaseBlock')}
        onClose={() => setReleaseFor(null)}
        onSubmit={(reason) => {
          const id = releaseFor;
          setReleaseFor(null);
          if (id)
            void run(() =>
              inventoryApi.releaseBlock(tenantId, propertyId, id, reason),
            );
        }}
      />
      <Dialog
        open={maintenanceOpen}
        onClose={() => setMaintenanceOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t('maintenanceAction')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('resource')}
            value={maintenanceResourceId}
            onChange={(event) => setMaintenanceResourceId(event.target.value)}
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
            label={t('maintenanceAction')}
            value={maintenanceMode}
            onChange={(event) =>
              setMaintenanceMode(
                event.target.value === 'OOO'
                  ? 'OOO'
                  : event.target.value === 'OOS'
                    ? 'OOS'
                    : 'NONE',
              )
            }
          >
            <MenuItem value="NONE">{t('maintenanceNone')}</MenuItem>
            <MenuItem value="OOO" disabled={!emergency}>
              {t('maintenanceOoo')}
            </MenuItem>
            <MenuItem value="OOS" disabled={!emergency}>
              {t('maintenanceOos')}
            </MenuItem>
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            label={t('reasonLabel')}
            value={maintenanceReason}
            onChange={(event) => setMaintenanceReason(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMaintenanceOpen(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="contained"
            disabled={
              busy ||
              !maintenanceResource ||
              maintenanceReason.trim().length < 3 ||
              (maintenanceMode !== 'NONE' && !emergency)
            }
            onClick={async () => {
              if (!maintenanceResource) return;
              const updated = await run(() =>
                inventoryApi.setResourceMaintenance(
                  tenantId,
                  propertyId,
                  maintenanceResource.id,
                  {
                    version: maintenanceResource.version,
                    state: maintenanceMode,
                    reason: maintenanceReason.trim(),
                  },
                ),
              );
              if (updated) {
                setMaintenanceOpen(false);
                setMaintenanceReason('');
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

function ChannelPanel({ tenantId, propertyId, property }: PanelProps) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const canRead = useAuth().hasPermission('channel.read');
  const canSale = useAuth().hasPermission('channel.sale.manage');
  const canReconcile = useAuth().hasPermission('channel.reconcile');
  const [connectionId, setConnectionId] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewProductId, setPreviewProductId] = useState('');
  const [previewResourceIds, setPreviewResourceIds] = useState<string[]>([]);
  const [previewArrival, setPreviewArrival] = useState(todayIso());
  const [previewDeparture, setPreviewDeparture] = useState(
    shiftDate(todayIso(), 1),
  );
  const [preview, setPreview] = useState<ExposurePreview | null>(null);
  const [published, setPublished] = useState<ExposureOperationResult | null>(
    null,
  );
  const [withdrawFor, setWithdrawFor] = useState<string | null>(null);
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleAction, setSaleAction] = useState<'STOP_SELL' | 'OPEN'>(
    'STOP_SELL',
  );
  const [saleProductId, setSaleProductId] = useState('');
  const [saleArrival, setSaleArrival] = useState(todayIso());
  const [saleDeparture, setSaleDeparture] = useState(shiftDate(todayIso(), 1));
  const [saleRestrictionId, setSaleRestrictionId] = useState('');
  const [saleReason, setSaleReason] = useState('');
  const [saleResult, setSaleResult] = useState<SaleResult | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileResult, setReconcileResult] =
    useState<ReconcileResult | null>(null);
  const connections = useQuery({
    queryKey: ['connections', tenantId, propertyId],
    enabled: canRead,
    queryFn: () => propertyApi.listConnections(tenantId, propertyId),
  });
  const selectedId = connectionId || connections.data?.items[0]?.id || '';
  const mappings = useQuery({
    queryKey: ['mappings', tenantId, propertyId, selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => propertyApi.listMappings(tenantId, propertyId, selectedId),
  });
  const exposures = useQuery({
    queryKey: ['exposures', tenantId, propertyId, selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => inventoryApi.listExposures(tenantId, propertyId, selectedId),
  });
  const sync = useQuery({
    queryKey: ['sync', tenantId, propertyId, selectedId],
    enabled: Boolean(selectedId),
    queryFn: () =>
      inventoryApi.getSyncStatus(tenantId, propertyId, selectedId, true),
  });
  const products = useQuery({
    queryKey: ['products', tenantId, propertyId],
    queryFn: () => propertyApi.listProducts(tenantId, propertyId),
  });
  const resources = useQuery({
    queryKey: ['resources', tenantId, propertyId],
    queryFn: () => propertyApi.listResources(tenantId, propertyId),
  });
  if (!canRead) return <ForbiddenPanel />;
  const productLabel = (productId: string) =>
    products.data?.items.find((product) => product.id === productId)?.code ??
    shortId(productId);
  const previewProduct = products.data?.items.find(
    (product) => product.id === previewProductId,
  );
  const eligibleResources =
    resources.data?.items.filter(
      (resource) =>
        resource.state !== 'RETIRED' &&
        (!previewProduct || resource.type === previewProduct.kind),
    ) ?? [];
  return (
    <div>
      <ErrorAlert
        error={error ?? connections.error ?? mappings.error ?? sync.error}
      />
      {connections.isLoading ? (
        <LoadingBlock />
      ) : connections.data && connections.data.items.length === 0 ? (
        <EmptyBlock message={t('noConnections')} />
      ) : (
        <div>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('selectConnection')}
            value={selectedId}
            onChange={(event) => {
              setConnectionId(event.target.value);
              setPreview(null);
              setPublished(null);
              setSaleResult(null);
              setReconcileResult(null);
            }}
          >
            {connections.data?.items.map((connection) => (
              <MenuItem key={connection.id} value={connection.id}>
                {connection.channel_key} · {connection.environment}
              </MenuItem>
            ))}
          </TextField>
          <Typography className="section-title" component="h3" variant="h2">
            {t('mappings')}
          </Typography>
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
                    <TableCell>{t('internalProduct')}</TableCell>
                    <TableCell>{t('mappingInternalRate')}</TableCell>
                    <TableCell>{t('occupancy')}</TableCell>
                    <TableCell>{t('status')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {mappings.data?.items.map((mapping) => (
                    <TableRow key={mapping.id}>
                      <TableCell>{mapping.external_room_ref}</TableCell>
                      <TableCell>{mapping.external_rate_ref}</TableCell>
                      <TableCell>
                        {mapping.internal_product_ref
                          ? productLabel(mapping.internal_product_ref)
                          : '—'}
                      </TableCell>
                      <TableCell>{mapping.internal_rate_ref ?? '—'}</TableCell>
                      <TableCell>{mapping.occupancy}</TableCell>
                      <TableCell>
                        <ValueChip
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
          <Typography className="section-title" component="h3" variant="h2">
            {t('exposuresSection')}
          </Typography>
          <div className="row-actions">
            {canSale ? (
              <Button
                variant="outlined"
                onClick={() => {
                  setPreview(null);
                  setPublished(null);
                  setPreviewOpen(true);
                }}
              >
                {t('previewExposure')}
              </Button>
            ) : null}
            {canSale ? (
              <Button variant="outlined" onClick={() => setSaleOpen(true)}>
                {t('saleStatus')}
              </Button>
            ) : null}
          </div>
          {exposures.isLoading ? (
            <LoadingBlock />
          ) : exposures.data && exposures.data.items.length === 0 ? (
            <EmptyBlock message={t('noExposures')} />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('product')}</TableCell>
                    <TableCell>{t('fromDate')}</TableCell>
                    <TableCell>{t('toDate')}</TableCell>
                    <TableCell>{t('status')}</TableCell>
                    <TableCell>{t('allocations')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {exposures.data?.items.map((exposure) => (
                    <TableRow key={exposure.id}>
                      <TableCell>{productLabel(exposure.product_id)}</TableCell>
                      <TableCell>{exposure.start_date}</TableCell>
                      <TableCell>{exposure.end_date}</TableCell>
                      <TableCell>
                        <ValueChip
                          prefix="exposureState"
                          value={exposure.state}
                        />
                      </TableCell>
                      <TableCell>{exposure.allocations.length}</TableCell>
                      <TableCell>
                        {canSale &&
                        exposure.state !== 'RELEASED' &&
                        exposure.state !== 'WITHDRAWING' ? (
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() => setWithdrawFor(exposure.id)}
                          >
                            {t('withdrawExposure')}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {saleResult ? (
            <Alert severity="info" role="status">
              <div className="chip-row">
                <Chip
                  size="small"
                  label={`${t('effectiveOpen')}: ${
                    saleResult.effective_open ? t('openSale') : t('stopSell')
                  }`}
                />
                <ValueChip prefix="syncState" value={saleResult.sync_state} />
              </div>
              <Typography variant="body2">
                {t('operationId')}: {saleResult.operation_id}
              </Typography>
              <ReasonChips codes={saleResult.reason_codes} />
            </Alert>
          ) : null}
          <Typography className="section-title" component="h3" variant="h2">
            {t('syncSection')}
          </Typography>
          {sync.isLoading ? (
            <LoadingBlock />
          ) : sync.data ? (
            <div>
              <dl>
                <dt>{t('desiredVersion')}</dt>
                <dd>{sync.data.desired_version}</dd>
                <dt>{t('providerAcceptedVersion')}</dt>
                <dd>{sync.data.provider_accepted_version ?? '—'}</dd>
                <dt>{t('channelVerifiedVersion')}</dt>
                <dd>{sync.data.channel_verified_version ?? '—'}</dd>
                <dt>{t('status')}</dt>
                <dd>
                  <ValueChip prefix="syncState" value={sync.data.state} />
                </dd>
                <dt>{t('pending')}</dt>
                <dd>{sync.data.pending}</dd>
                <dt>{t('failedLabel')}</dt>
                <dd>{sync.data.failed}</dd>
                <dt>{t('unknownLabel')}</dt>
                <dd>{sync.data.unknown}</dd>
                <dt>{t('partialLabel')}</dt>
                <dd>{sync.data.partial}</dd>
                <dt>{t('observedAt')}</dt>
                <dd>{formatDateTime(sync.data.observed_at)}</dd>
              </dl>
              <div className="row-actions">
                {canReconcile ? (
                  <Button
                    variant="outlined"
                    onClick={() => setReconcileOpen(true)}
                  >
                    {t('reconcile')}
                  </Button>
                ) : null}
              </div>
              <Alert severity="info">{t('withdrawalReleaseBlocked')}</Alert>
              {reconcileResult ? (
                <Alert
                  severity={
                    reconcileResult.reconciling > 0 ? 'warning' : 'success'
                  }
                  role="status"
                >
                  {t('activated')}: {reconcileResult.activated} ·{' '}
                  {t('releasedCount')}: {reconcileResult.released} ·{' '}
                  {t('reconciling')}: {reconcileResult.reconciling}
                </Alert>
              ) : null}
              <Typography className="section-title" component="h4" variant="h2">
                {t('attempts')}
              </Typography>
              {sync.data.attempts.length === 0 ? (
                <EmptyBlock message={t('noAttempts')} />
              ) : (
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>{t('eventType')}</TableCell>
                        <TableCell>{t('status')}</TableCell>
                        <TableCell>{t('attemptCount')}</TableCell>
                        <TableCell>{t('certainty')}</TableCell>
                        <TableCell>{t('lastSafeErrorCode')}</TableCell>
                        <TableCell>{t('updatedAt')}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {sync.data.attempts.map((attempt) => (
                        <TableRow key={attempt.id}>
                          <TableCell>{attempt.event_type}</TableCell>
                          <TableCell>{attempt.status}</TableCell>
                          <TableCell>{attempt.attempt_count}</TableCell>
                          <TableCell>{attempt.certainty ?? '—'}</TableCell>
                          <TableCell>
                            {attempt.last_safe_error_code ?? '—'}
                          </TableCell>
                          <TableCell>
                            {formatDateTime(attempt.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </div>
          ) : null}
        </div>
      )}
      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('previewExposure')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('product')}
            value={previewProductId}
            onChange={(event) => {
              setPreviewProductId(event.target.value);
              setPreviewResourceIds([]);
              setPreview(null);
              setPublished(null);
            }}
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
            label={t('arrivalDate')}
            InputLabelProps={{ shrink: true }}
            value={previewArrival}
            onChange={(event) => setPreviewArrival(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            type="date"
            label={t('departureDate')}
            InputLabelProps={{ shrink: true }}
            value={previewDeparture}
            onChange={(event) => setPreviewDeparture(event.target.value)}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('resources')}
            SelectProps={{ multiple: true }}
            value={previewResourceIds}
            onChange={(event) =>
              setPreviewResourceIds(
                Array.isArray(event.target.value)
                  ? event.target.value
                  : [event.target.value],
              )
            }
          >
            {eligibleResources.map((resource) => (
              <MenuItem key={resource.id} value={resource.id}>
                {resource.code}
              </MenuItem>
            ))}
          </TextField>
          {preview ? (
            <div>
              <div className="chip-row">
                <Chip
                  size="small"
                  color={preview.allowed ? 'success' : 'error'}
                  label={preview.allowed ? t('allowed') : t('notAllowed')}
                />
              </div>
              <Typography variant="body2">
                {t('inventoryVersion')}: {preview.inventory_version}
              </Typography>
              <Typography variant="body2">
                {t('expiresAt')}: {formatDateTime(preview.expires_at)}
              </Typography>
              <Typography variant="body2">{t('reasonCodes')}:</Typography>
              <ReasonChips codes={preview.reason_codes} />
            </div>
          ) : null}
          {published ? (
            <Alert severity="info" role="status">
              <div className="chip-row">
                <ValueChip prefix="exposureState" value={published.state} />
              </div>
              <Typography variant="body2">
                {t('operationId')}: {published.operation_id}
              </Typography>
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreviewOpen(false)}>{t('close')}</Button>
          <Button
            variant="outlined"
            disabled={
              busy ||
              !previewProductId ||
              previewResourceIds.length === 0 ||
              !previewArrival ||
              !previewDeparture ||
              previewArrival >= previewDeparture
            }
            onClick={async () => {
              const result = await run(() =>
                inventoryApi.previewExposure(tenantId, propertyId, {
                  connection_id: selectedId,
                  product_id: previewProductId,
                  period: {
                    arrival: previewArrival,
                    departure: previewDeparture,
                  },
                  resource_ids: previewResourceIds,
                  inventory_version: property.inventory_version,
                }),
              );
              if (result) {
                setPreview(result);
                setPublished(null);
              }
            }}
          >
            {t('previewExposure')}
          </Button>
          <Button
            variant="contained"
            disabled={busy || !preview?.allowed}
            onClick={async () => {
              if (!preview) return;
              const result = await run(() =>
                inventoryApi.publishExposure(
                  tenantId,
                  propertyId,
                  preview.preview_id,
                  preview.preview_version,
                ),
              );
              if (result) setPublished(result);
            }}
          >
            {t('publishExposure')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={saleOpen}
        onClose={() => setSaleOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('saleStatus')}</DialogTitle>
        <DialogContent className="dialog-form">
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('action')}
            value={saleAction}
            onChange={(event) =>
              setSaleAction(
                event.target.value === 'OPEN' ? 'OPEN' : 'STOP_SELL',
              )
            }
          >
            <MenuItem value="STOP_SELL">{t('stopSell')}</MenuItem>
            <MenuItem value="OPEN">{t('openSale')}</MenuItem>
          </TextField>
          {saleAction === 'STOP_SELL' ? (
            <>
              <TextField
                select
                fullWidth
                margin="dense"
                label={t('product')}
                value={saleProductId}
                onChange={(event) => setSaleProductId(event.target.value)}
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
                label={t('arrivalDate')}
                InputLabelProps={{ shrink: true }}
                value={saleArrival}
                onChange={(event) => setSaleArrival(event.target.value)}
              />
              <TextField
                fullWidth
                margin="dense"
                type="date"
                label={t('departureDate')}
                InputLabelProps={{ shrink: true }}
                value={saleDeparture}
                onChange={(event) => setSaleDeparture(event.target.value)}
              />
            </>
          ) : (
            <TextField
              fullWidth
              margin="dense"
              label={t('restrictionId')}
              value={saleRestrictionId}
              onChange={(event) => setSaleRestrictionId(event.target.value)}
            />
          )}
          <TextField
            fullWidth
            margin="dense"
            label={t('restrictionReason')}
            value={saleReason}
            onChange={(event) => setSaleReason(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaleOpen(false)}>{t('close')}</Button>
          <Button
            variant="contained"
            disabled={
              busy ||
              saleReason.trim().length === 0 ||
              (saleAction === 'STOP_SELL' &&
                (!saleProductId ||
                  !saleArrival ||
                  !saleDeparture ||
                  saleArrival >= saleDeparture)) ||
              (saleAction === 'OPEN' && !saleRestrictionId)
            }
            onClick={async () => {
              const input =
                saleAction === 'STOP_SELL'
                  ? {
                      action: 'STOP_SELL' as const,
                      product_id: saleProductId,
                      period: {
                        arrival: saleArrival,
                        departure: saleDeparture,
                      },
                      reason: saleReason.trim(),
                    }
                  : {
                      action: 'OPEN' as const,
                      restriction_id: saleRestrictionId,
                      reason: saleReason.trim(),
                    };
              const result = await run(() =>
                inventoryApi.setSaleStatus(
                  tenantId,
                  propertyId,
                  selectedId,
                  input,
                ),
              );
              if (result) {
                setSaleResult(result);
                setSaleReason('');
                if (saleAction === 'STOP_SELL')
                  setSaleRestrictionId(result.operation_id);
              }
            }}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </Dialog>
      <ReasonDialog
        open={withdrawFor !== null}
        title={t('withdrawExposure')}
        confirmLabel={t('withdrawExposure')}
        onClose={() => setWithdrawFor(null)}
        onSubmit={(reason) => {
          const id = withdrawFor;
          setWithdrawFor(null);
          if (id)
            void run(() =>
              inventoryApi.withdrawExposure(tenantId, propertyId, id, reason),
            );
        }}
      />
      <ReasonDialog
        open={reconcileOpen}
        title={t('reconcile')}
        confirmLabel={t('reconcile')}
        onClose={() => setReconcileOpen(false)}
        onSubmit={(reason) => {
          setReconcileOpen(false);
          void run(async () => {
            const result = await inventoryApi.reconcileConnection(
              tenantId,
              propertyId,
              selectedId,
              reason,
            );
            setReconcileResult(result);
            return result;
          });
        }}
      />
    </div>
  );
}

export function RatesInventoryPage() {
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
        <PageHeader title={t('ratesInventoryTitle')} />
        <ForbiddenPanel />
      </div>
    );
  if (property.isLoading) return <LoadingBlock />;
  if (!property.data)
    return (
      <div>
        <PageHeader title={t('ratesInventoryTitle')} />
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
        title={t('ratesInventoryTitle')}
        description={`${property.data.property.name} (${property.data.property.code}) · ${t(
          'inventoryVersion',
        )} ${property.data.property.inventory_version}`}
      />
      <Tabs
        value={tab}
        onChange={(_event, value: number) => setTab(value)}
        variant="scrollable"
        allowScrollButtonsMobile
      >
        <Tab label={t('ratePlansSection')} />
        <Tab label={t('rateCalendarSection')} />
        <Tab label={t('availabilitySection')} />
        <Tab label={`${t('holdsSection')} · ${t('blocksSection')}`} />
        <Tab label={t('exposuresSection')} />
      </Tabs>
      {tab === 0 ? <RatePlansPanel {...panelProps} /> : null}
      {tab === 1 ? <RateCalendarPanel {...panelProps} /> : null}
      {tab === 2 ? <AvailabilityPanel {...panelProps} /> : null}
      {tab === 3 ? <HoldsBlocksPanel {...panelProps} /> : null}
      {tab === 4 ? <ChannelPanel {...panelProps} /> : null}
    </div>
  );
}
