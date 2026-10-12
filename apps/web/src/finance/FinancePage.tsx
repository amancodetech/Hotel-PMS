import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
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
import { formatMoney } from '@hotel/i18n';
import type { Locale } from '@hotel/i18n';
import { useAuth } from '../auth/AuthProvider.js';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';
import {
  ForbiddenPanel,
  PageHeader,
  useApiAction,
} from '../identity/shared.js';
import { ApiError } from '../api/client.js';
import { financeApi } from '../api/finance.js';
import type {
  CashierSession,
  ClearanceBasis,
  Currency,
  ExternalSettlement,
  Folio,
  FolioCharge,
  FolioDeposit,
  FolioDetail,
  FolioInvoice,
  FolioPayment,
  FolioRefund,
  PaymentMethod,
  ReservationClearance,
} from '../api/finance.js';

const moneyPattern = /^\d{1,18}(\.\d{1,6})?$/;
const paymentMethods: PaymentMethod[] = [
  'CASH',
  'BANK_TRANSFER',
  'EXTERNAL_POS',
  'OTA_SETTLEMENT',
];
const depositMethods: Array<FolioDeposit['method']> = [
  'CASH',
  'BANK_TRANSFER',
  'EXTERNAL_POS',
];
const folioKinds: Array<Folio['kind']> = ['GUEST', 'COMPANY', 'HOUSE', 'OWNER'];
const currencies: Currency[] = ['IDR', 'USD'];

function positiveMoney(value: string) {
  return moneyPattern.test(value) && !/^0+(\.0+)?$/.test(value);
}

function nonNegativeMoney(value: string) {
  return moneyPattern.test(value);
}

function formatAmount(
  amount: string | null | undefined,
  currency: string,
  locale: string,
): string {
  if (amount === null || amount === undefined || amount === '') return '-';
  const negative = amount.startsWith('-');
  const value = negative ? amount.slice(1) : amount;
  const withSign = (text: string) => (negative ? `-${text}` : text);
  try {
    if (/^\d{1,18}(\.\d{1,2})?$/.test(value))
      return withSign(
        formatMoney(value, currency as Currency, locale as Locale),
      );
  } catch {
    /* fall through to the wider formatter */
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return amount;
  return withSign(
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(numeric),
  );
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : '-';
}

function sourceRef(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

function FinanceErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  if (error instanceof ApiError) {
    const key = `errors.${error.code}`;
    const translated = t(key);
    const details = Object.entries(error.details ?? {})
      .filter(([, value]) =>
        ['string', 'number', 'boolean'].includes(typeof value),
      )
      .slice(0, 4)
      .map(([name, value]) => `${name}: ${String(value)}`)
      .join(' · ');
    return (
      <Alert severity="error" role="alert">
        {`${error.status} ${error.code}`}
        {translated !== key ? ` — ${translated}` : ''}
        {details ? ` (${details})` : ''}
      </Alert>
    );
  }
  return (
    <Alert severity="error" role="alert">
      {t('errors.INTERNAL_ERROR')}
    </Alert>
  );
}

function AmountField({
  label,
  value,
  onChange,
  required = true,
  helperText,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  helperText?: string;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      autoFocus={autoFocus}
      fullWidth
      margin="dense"
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={required && value !== '' && !positiveMoney(value)}
      helperText={helperText}
    />
  );
}

function useMoney(locale: string) {
  return (amount: string | null | undefined, currency: string) =>
    formatAmount(amount, currency, locale);
}

function FolioStateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  return (
    <Chip
      size="small"
      variant="outlined"
      color={state === 'OPEN' ? 'success' : 'default'}
      label={t(`folioState.${state}`)}
    />
  );
}

function PaymentStateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color =
    state === 'SUCCEEDED'
      ? 'success'
      : state === 'FAILED'
        ? 'error'
        : 'warning';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`paymentState.${state}`)}
    />
  );
}

function RefundStateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color =
    state === 'SUCCEEDED'
      ? 'success'
      : state === 'FAILED'
        ? 'error'
        : state === 'PENDING'
          ? 'warning'
          : 'default';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`refundState.${state}`)}
    />
  );
}

function CashierStateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color =
    state === 'OPEN'
      ? 'success'
      : state === 'CLOSED'
        ? 'default'
        : state === 'RECONCILED'
          ? 'info'
          : 'warning';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`cashierState.${state}`)}
    />
  );
}

function ClearanceStateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color =
    state === 'CLEARED'
      ? 'success'
      : state === 'NOT_REQUIRED'
        ? 'default'
        : 'warning';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={t(`clearanceState.${state}`)}
    />
  );
}

function OpenFolioDialog({
  tenantId,
  propertyId,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [reservationId, setReservationId] = useState('');
  const [kind, setKind] = useState<Folio['kind']>('GUEST');
  const [payerLabel, setPayerLabel] = useState('');
  const [currency, setCurrency] = useState<Currency>('IDR');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('openFolioAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label={t('reservationIdLabel')}
          value={reservationId}
          onChange={(event) => setReservationId(event.target.value)}
          helperText={t('reservationIdOptional')}
        />
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('folioKindLabel')}
          value={kind}
          onChange={(event) => setKind(event.target.value as Folio['kind'])}
        >
          {folioKinds.map((option) => (
            <MenuItem key={option} value={option}>
              {t(`folioKind.${option}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          margin="dense"
          label={t('payerLabel')}
          value={payerLabel}
          onChange={(event) => setPayerLabel(event.target.value)}
        />
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('currencyLabel')}
          value={currency}
          onChange={(event) => setCurrency(event.target.value as Currency)}
        >
          {currencies.map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </TextField>
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || payerLabel.trim().length === 0}
          onClick={() =>
            void run(async () => {
              await financeApi.openFolio(tenantId, propertyId, {
                reservation_id: reservationId.trim() || undefined,
                kind,
                payer_label: payerLabel.trim(),
                currency,
              });
              onClose();
            })
          }
        >
          {t('openFolioAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PostChargeDialog({
  tenantId,
  propertyId,
  folio,
  businessDate,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  folio: Folio;
  businessDate: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [date, setDate] = useState(businessDate);
  const [amount, setAmount] = useState('');
  const [tax, setTax] = useState('');
  const [accountCode, setAccountCode] = useState('');
  const [reference, setReference] = useState(sourceRef('charge'));
  const [memo, setMemo] = useState('');
  const validTax = tax === '' || positiveMoney(tax);
  const canSubmit =
    positiveMoney(amount) && validTax && date.length === 10 && !busy;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{`${t('postChargeAction')} · ${folio.payer_label}`}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          fullWidth
          margin="dense"
          type="date"
          label={t('businessDate')}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <AmountField
          autoFocus
          label={`${t('netAmount')} (${folio.currency})`}
          value={amount}
          onChange={setAmount}
          helperText={t('moneyHint')}
        />
        <AmountField
          label={`${t('taxAmount')} (${folio.currency})`}
          value={tax}
          onChange={setTax}
          required={false}
          helperText={t('optionalMoneyHint')}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('accountCode')}
          value={accountCode}
          onChange={(event) => setAccountCode(event.target.value.toUpperCase())}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('sourceRef')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('memo')}
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={!canSubmit}
          onClick={() =>
            void run(async () => {
              await financeApi.postCharge(tenantId, propertyId, {
                folio_id: folio.id,
                business_date: date,
                money: { amount, currency: folio.currency },
                tax_money: tax
                  ? { amount: tax, currency: folio.currency }
                  : undefined,
                account_code: accountCode.trim() || undefined,
                source_ref: reference.trim(),
                memo: memo.trim() || undefined,
              });
              onClose();
            })
          }
        >
          {t('postChargeAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RouteChargeDialog({
  tenantId,
  propertyId,
  charge,
  folios,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  charge: FolioCharge;
  folios: Folio[];
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const targets = folios.filter(
    (folio) =>
      folio.id !== charge.folio_id &&
      folio.currency === charge.currency &&
      folio.state === 'OPEN',
  );
  const [payerFolioId, setPayerFolioId] = useState(targets[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('routeChargeAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {`${t('chargeLabel')}: ${shortId(charge.id)} · ${formatAmount(charge.net_amount, charge.currency, 'en-US')}`}
        </Typography>
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('payerFolio')}
          value={payerFolioId}
          onChange={(event) => setPayerFolioId(event.target.value)}
        >
          {targets.length === 0 ? (
            <MenuItem value="" disabled>
              {t('noRouteTargets')}
            </MenuItem>
          ) : (
            targets.map((folio) => (
              <MenuItem key={folio.id} value={folio.id}>
                {`${folio.payer_label} · ${folio.currency}`}
              </MenuItem>
            ))
          )}
        </TextField>
        <AmountField
          label={`${t('routeAmount')} (${charge.currency})`}
          value={amount}
          onChange={setAmount}
          helperText={t('moneyHint')}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || payerFolioId === '' || !positiveMoney(amount)}
          onClick={() =>
            void run(async () => {
              await financeApi.routeCharge(tenantId, propertyId, charge.id, {
                allocations: [
                  {
                    payer_folio_id: payerFolioId,
                    money: { amount, currency: charge.currency },
                  },
                ],
              });
              onClose();
            })
          }
        >
          {t('routeChargeAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CollectDepositDialog({
  tenantId,
  propertyId,
  folio,
  businessDate,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  folio: Folio;
  businessDate: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [kind, setKind] = useState<FolioDeposit['kind']>('DEPOSIT');
  const [method, setMethod] = useState<FolioDeposit['method']>('CASH');
  const [date, setDate] = useState(businessDate);
  const [amount, setAmount] = useState('');
  const [externalReference, setExternalReference] = useState(
    sourceRef('deposit'),
  );
  const [reference, setReference] = useState(sourceRef('deposit'));
  const canSubmit =
    positiveMoney(amount) &&
    externalReference.trim().length > 0 &&
    reference.trim().length > 0 &&
    !busy;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{`${t('collectDepositAction')} · ${folio.payer_label}`}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('depositKindLabel')}
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as FolioDeposit['kind'])
          }
        >
          {(['DEPOSIT', 'DAMAGE'] as const).map((option) => (
            <MenuItem key={option} value={option}>
              {t(`depositKind.${option}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('paymentMethodLabel')}
          value={method}
          onChange={(event) =>
            setMethod(event.target.value as FolioDeposit['method'])
          }
        >
          {depositMethods.map((option) => (
            <MenuItem key={option} value={option}>
              {t(`paymentMethod.${option}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          margin="dense"
          type="date"
          label={t('businessDate')}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <AmountField
          label={`${t('depositAmount')} (${folio.currency})`}
          value={amount}
          onChange={setAmount}
          helperText={t('moneyHint')}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('externalReference')}
          value={externalReference}
          onChange={(event) => setExternalReference(event.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('sourceRef')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={!canSubmit}
          onClick={() =>
            void run(async () => {
              await financeApi.collectDeposit(tenantId, propertyId, folio.id, {
                kind,
                method,
                money: { amount, currency: folio.currency },
                business_date: date,
                external_reference: externalReference.trim(),
                source_ref: reference.trim(),
              });
              onClose();
            })
          }
        >
          {t('collectDepositAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RecordPaymentDialog({
  tenantId,
  propertyId,
  folios,
  defaultFolioId,
  businessDate,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  folios: Folio[];
  defaultFolioId: string | null;
  businessDate: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const openFolios = folios.filter((folio) => folio.state === 'OPEN');
  const [folioId, setFolioId] = useState(
    defaultFolioId ?? openFolios[0]?.id ?? '',
  );
  const folio = openFolios.find((row) => row.id === folioId);
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [date, setDate] = useState(businessDate);
  const [amount, setAmount] = useState('');
  const [gross, setGross] = useState('');
  const [commission, setCommission] = useState('');
  const [externalReference, setExternalReference] = useState(
    sourceRef('payment'),
  );
  const [evidenceRef, setEvidenceRef] = useState('');
  const [reference, setReference] = useState(sourceRef('payment'));
  const [certainty, setCertainty] = useState<'CONFIRMED' | 'UNKNOWN'>(
    'CONFIRMED',
  );
  const evidenceRequired = method !== 'CASH';
  const ota = method === 'OTA_SETTLEMENT';
  const validOptional = (value: string) => value === '' || positiveMoney(value);
  const canSubmit =
    Boolean(folio) &&
    positiveMoney(amount) &&
    externalReference.trim().length > 0 &&
    reference.trim().length > 0 &&
    date.length === 10 &&
    (!evidenceRequired || evidenceRef.trim().length > 0) &&
    (!ota || (validOptional(gross) && validOptional(commission))) &&
    !busy;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('recordPaymentAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('folioLabel')}
          value={folioId}
          onChange={(event) => setFolioId(event.target.value)}
        >
          {openFolios.length === 0 ? (
            <MenuItem value="" disabled>
              {t('noOpenFolios')}
            </MenuItem>
          ) : (
            openFolios.map((row) => (
              <MenuItem key={row.id} value={row.id}>
                {`${row.payer_label} · ${row.currency}`}
              </MenuItem>
            ))
          )}
        </TextField>
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('paymentMethodLabel')}
          value={method}
          onChange={(event) => setMethod(event.target.value as PaymentMethod)}
        >
          {paymentMethods.map((option) => (
            <MenuItem key={option} value={option}>
              {t(`paymentMethod.${option}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          margin="dense"
          type="date"
          label={t('businessDate')}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <AmountField
          label={`${t('paymentAmount')} (${folio?.currency ?? 'IDR'})`}
          value={amount}
          onChange={setAmount}
          helperText={t('moneyHint')}
        />
        {ota ? (
          <>
            <AmountField
              label={`${t('grossAmount')} (${folio?.currency ?? 'IDR'})`}
              value={gross}
              onChange={setGross}
              required={false}
              helperText={t('otaSplitHint')}
            />
            <AmountField
              label={`${t('commissionAmount')} (${folio?.currency ?? 'IDR'})`}
              value={commission}
              onChange={setCommission}
              required={false}
              helperText={t('otaSplitHint')}
            />
          </>
        ) : null}
        <TextField
          fullWidth
          margin="dense"
          label={t('externalReference')}
          value={externalReference}
          onChange={(event) => setExternalReference(event.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('evidenceRef')}
          value={evidenceRef}
          onChange={(event) => setEvidenceRef(event.target.value)}
          helperText={
            evidenceRequired ? t('evidenceRequired') : t('evidenceOptional')
          }
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('sourceRef')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('certaintyLabel')}
          value={certainty}
          onChange={(event) =>
            setCertainty(event.target.value as 'CONFIRMED' | 'UNKNOWN')
          }
        >
          <MenuItem value="CONFIRMED">{t('certaintyState.CONFIRMED')}</MenuItem>
          <MenuItem value="UNKNOWN">{t('certaintyState.UNKNOWN')}</MenuItem>
        </TextField>
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={!canSubmit}
          onClick={() =>
            void run(async () => {
              if (!folio) return;
              await financeApi.recordPayment(tenantId, propertyId, {
                folio_id: folio.id,
                method,
                money: { amount, currency: folio.currency },
                gross_money:
                  ota && gross
                    ? { amount: gross, currency: folio.currency }
                    : undefined,
                commission_money:
                  ota && commission
                    ? { amount: commission, currency: folio.currency }
                    : undefined,
                business_date: date,
                external_reference: externalReference.trim(),
                evidence_ref: evidenceRef.trim() || undefined,
                source_ref: reference.trim(),
                certainty,
              });
              onClose();
            })
          }
        >
          {t('recordPaymentAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RequestRefundDialog({
  tenantId,
  propertyId,
  payment,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  payment: FolioPayment;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('requestRefundAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {`${t('paymentLabel')}: ${shortId(payment.id)} · ${formatAmount(payment.amount, payment.currency, 'en-US')}`}
        </Typography>
        <AmountField
          autoFocus
          label={`${t('refundAmount')} (${payment.currency})`}
          value={amount}
          onChange={setAmount}
          helperText={t('moneyHint')}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('refundReason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !positiveMoney(amount) || reason.trim().length < 3}
          onClick={() =>
            void run(async () => {
              await financeApi.requestRefund(tenantId, propertyId, payment.id, {
                money: { amount, currency: payment.currency },
                reason: reason.trim(),
              });
              onClose();
            })
          }
        >
          {t('requestRefundAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ResolveRefundDialog({
  tenantId,
  propertyId,
  refund,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  refund: FolioRefund;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [outcome, setOutcome] = useState<FolioRefund['state']>('FAILED');
  const [approvalId, setApprovalId] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{`${t('resolveRefundAction')} · ${shortId(refund.id)}`}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {`${formatAmount(refund.amount, refund.currency, 'en-US')} · ${t(`refundState.${refund.state}`)}`}
        </Typography>
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('resolveOutcome')}
          value={outcome}
          onChange={(event) =>
            setOutcome(event.target.value as FolioRefund['state'])
          }
        >
          {(['PENDING', 'SUCCEEDED', 'FAILED'] as const).map((option) => (
            <MenuItem key={option} value={option}>
              {t(`refundState.${option}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          margin="dense"
          label={t('approvalId')}
          value={approvalId}
          onChange={(event) => setApprovalId(event.target.value)}
          helperText={t('approvalIdHint')}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('evidenceRef')}
          value={evidenceRef}
          onChange={(event) => setEvidenceRef(event.target.value)}
          helperText={t('evidenceOptional')}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={
            busy || (outcome === 'SUCCEEDED' && approvalId.trim().length === 0)
          }
          onClick={() =>
            void run(async () => {
              await financeApi.resolveRefund(tenantId, propertyId, refund.id, {
                outcome,
                approval_id: approvalId.trim() || undefined,
                evidence_ref: evidenceRef.trim() || undefined,
              });
              onClose();
            })
          }
        >
          {t('resolveRefundAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function IssueInvoiceDialog({
  tenantId,
  propertyId,
  folio,
  businessDate,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  folio: Folio;
  businessDate: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [series, setSeries] = useState('INV');
  const [kind, setKind] = useState<FolioInvoice['kind']>('SYNTHETIC');
  const [date, setDate] = useState(businessDate);
  const [amount, setAmount] = useState('');
  const [tax, setTax] = useState('');
  const [reference, setReference] = useState(sourceRef('invoice'));
  const validTax = tax === '' || positiveMoney(tax);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{`${t('issueInvoiceAction')} · ${folio.payer_label}`}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label={t('seriesLabel')}
          value={series}
          onChange={(event) => setSeries(event.target.value.toUpperCase())}
        />
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('invoiceKindLabel')}
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as FolioInvoice['kind'])
          }
        >
          {(['SYNTHETIC', 'PRODUCTION'] as const).map((option) => (
            <MenuItem key={option} value={option}>
              {t(`invoiceKind.${option}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          margin="dense"
          type="date"
          label={t('businessDate')}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <AmountField
          label={`${t('netAmount')} (${folio.currency})`}
          value={amount}
          onChange={setAmount}
          helperText={t('moneyHint')}
        />
        <AmountField
          label={`${t('taxAmount')} (${folio.currency})`}
          value={tax}
          onChange={setTax}
          required={false}
          helperText={t('optionalMoneyHint')}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('sourceRef')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        {kind === 'PRODUCTION' ? (
          <Alert severity="info">{t('ex03Notice')}</Alert>
        ) : null}
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={
            busy ||
            series.trim().length === 0 ||
            !positiveMoney(amount) ||
            !validTax ||
            date.length !== 10
          }
          onClick={() =>
            void run(async () => {
              await financeApi.issueInvoice(tenantId, propertyId, {
                folio_id: folio.id,
                series: series.trim(),
                kind,
                source_ref: reference.trim(),
                business_date: date,
                money: { amount, currency: folio.currency },
                tax_money: tax
                  ? { amount: tax, currency: folio.currency }
                  : undefined,
              });
              onClose();
            })
          }
        >
          {t('issueInvoiceAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function IssueCreditNoteDialog({
  tenantId,
  propertyId,
  invoice,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  invoice: FolioInvoice;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState(sourceRef('credit-note'));
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{`${t('issueCreditNoteAction')} · ${invoice.series} ${invoice.number}`}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {`${t('invoiceTotal')}: ${formatAmount(invoice.total_amount, invoice.currency, 'en-US')}`}
        </Typography>
        <AmountField
          autoFocus
          label={`${t('creditNoteAmount')} (${invoice.currency})`}
          value={amount}
          onChange={setAmount}
          helperText={t('creditNoteHint')}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('creditNoteReason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          label={t('sourceRef')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={
            busy ||
            !positiveMoney(amount) ||
            reason.trim().length < 3 ||
            reference.trim().length === 0
          }
          onClick={() =>
            void run(async () => {
              await financeApi.issueCreditNote(
                tenantId,
                propertyId,
                invoice.id,
                {
                  money: { amount, currency: invoice.currency },
                  reason: reason.trim(),
                  source_ref: reference.trim(),
                },
              );
              onClose();
            })
          }
        >
          {t('issueCreditNoteAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function OpenCashierDialog({
  tenantId,
  propertyId,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [currency, setCurrency] = useState<Currency>('IDR');
  const [openingFloat, setOpeningFloat] = useState('0');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('openCashierAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('currencyLabel')}
          value={currency}
          onChange={(event) => setCurrency(event.target.value as Currency)}
        >
          {currencies.map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </TextField>
        <AmountField
          autoFocus
          label={`${t('openingFloat')} (${currency})`}
          value={openingFloat}
          onChange={setOpeningFloat}
          required={false}
          helperText={t('optionalMoneyHint')}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !nonNegativeMoney(openingFloat)}
          onClick={() =>
            void run(async () => {
              await financeApi.openCashierSession(tenantId, propertyId, {
                currency,
                opening_float: openingFloat === '' ? '0' : openingFloat,
              });
              onClose();
            })
          }
        >
          {t('openCashierAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CountCashierDialog({
  tenantId,
  propertyId,
  session,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  session: CashierSession;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [counted, setCounted] = useState('');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('countCashierAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {`${t('openingFloat')}: ${formatAmount(session.opening_float, session.currency, 'en-US')}`}
        </Typography>
        <AmountField
          autoFocus
          label={`${t('countedAmount')} (${session.currency})`}
          value={counted}
          onChange={setCounted}
          helperText={t('moneyHint')}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !nonNegativeMoney(counted)}
          onClick={() =>
            void run(async () => {
              await financeApi.countCashierSession(
                tenantId,
                propertyId,
                session.id,
                { counted_money: counted },
              );
              onClose();
            })
          }
        >
          {t('countCashierAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CloseCashierDialog({
  tenantId,
  propertyId,
  session,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  session: CashierSession;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('closeCashierAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2">
          {`${t('varianceLabel')}: ${formatAmount(session.variance, session.currency, 'en-US')}`}
        </Typography>
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          color="warning"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await financeApi.closeCashierSession(
                tenantId,
                propertyId,
                session.id,
              );
              onClose();
            })
          }
        >
          {t('closeCashierAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SettleClearanceDialog({
  tenantId,
  propertyId,
  clearance,
  folios,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  clearance: ReservationClearance;
  folios: Folio[];
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  const [basis, setBasis] = useState<ClearanceBasis>('SETTLED');
  const [payerFolioId, setPayerFolioId] = useState('');
  const [planRef, setPlanRef] = useState('');
  const [reason, setReason] = useState('');
  const outstandingCurrencies = new Set(
    clearance.folios
      .filter((folio) => positiveMoney(folio.totals.balance_due))
      .map((folio) => folio.folio.currency),
  );
  const payers = folios.filter(
    (folio) =>
      folio.kind === 'COMPANY' &&
      folio.state === 'OPEN' &&
      folio.reservation_id === null &&
      outstandingCurrencies.has(folio.currency),
  );
  const transfer = basis === 'TRANSFER_TO_PAYER';
  const canSubmit =
    !busy && (!transfer || (payerFolioId !== '' && planRef.trim().length > 0));
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('settleClearanceAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2" color="text.secondary">
          {`${t('reservationIdLabel')}: ${shortId(clearance.reservation.id)} · ${t(
            `clearanceState.${clearance.reservation.financial_clearance_state}`,
          )}`}
        </Typography>
        {clearance.outstanding ? (
          <Alert severity="warning">{t('clearanceOutstandingNotice')}</Alert>
        ) : null}
        {clearance.credit ? (
          <Alert severity="warning">{t('clearanceCreditNotice')}</Alert>
        ) : null}
        <TextField
          select
          fullWidth
          margin="dense"
          label={t('settleBasisLabel')}
          value={basis}
          onChange={(event) => setBasis(event.target.value as ClearanceBasis)}
        >
          <MenuItem value="SETTLED">{t('clearanceBasis.SETTLED')}</MenuItem>
          <MenuItem value="TRANSFER_TO_PAYER">
            {t('clearanceBasis.TRANSFER_TO_PAYER')}
          </MenuItem>
        </TextField>
        {basis === 'SETTLED' ? (
          <Typography variant="caption" color="text.secondary">
            {t('settleBalancedHint')}
          </Typography>
        ) : (
          <>
            <TextField
              select
              fullWidth
              margin="dense"
              label={t('companyPayerLabel')}
              value={payerFolioId}
              onChange={(event) => setPayerFolioId(event.target.value)}
            >
              {payers.length === 0 ? (
                <MenuItem value="" disabled>
                  {t('noCompanyPayers')}
                </MenuItem>
              ) : (
                payers.map((folio) => (
                  <MenuItem key={folio.id} value={folio.id}>
                    {`${folio.payer_label} · ${folio.currency}`}
                  </MenuItem>
                ))
              )}
            </TextField>
            <TextField
              fullWidth
              margin="dense"
              label={t('collectionPlanRef')}
              value={planRef}
              onChange={(event) => setPlanRef(event.target.value)}
              helperText={t('collectionPlanHint')}
            />
          </>
        )}
        <TextField
          fullWidth
          margin="dense"
          label={t('memo')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <FinanceErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={!canSubmit}
          onClick={() =>
            void run(async () => {
              await financeApi.settleClearance(
                tenantId,
                propertyId,
                clearance.reservation.id,
                {
                  version: clearance.reservation.version,
                  basis,
                  ...(transfer
                    ? {
                        payer_folio_id: payerFolioId,
                        collection_plan_ref: planRef.trim(),
                      }
                    : {}),
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                },
              );
              onClose();
            })
          }
        >
          {t('settleClearanceAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function TotalsGrid({
  detail,
  locale,
}: {
  detail: FolioDetail;
  locale: string;
}) {
  const { t } = useTranslation();
  const money = useMoney(locale);
  const rows: Array<Array<[string, string]>> = [
    [
      [
        t('chargesTotal'),
        money(detail.totals.charges_total, detail.folio.currency),
      ],
      [t('routedOut'), money(detail.totals.routed_out, detail.folio.currency)],
      [t('routedIn'), money(detail.totals.routed_in, detail.folio.currency)],
      [
        t('balanceDue'),
        money(detail.totals.balance_due, detail.folio.currency),
      ],
    ],
    [
      [
        t('paymentsTotal'),
        money(detail.totals.payments_total, detail.folio.currency),
      ],
      [
        t('refundsTotal'),
        money(detail.totals.refunds_total, detail.folio.currency),
      ],
      [
        t('depositsHeld'),
        money(detail.totals.deposits_held, detail.folio.currency),
      ],
      [
        t('depositsApplied'),
        money(detail.totals.deposits_applied, detail.folio.currency),
      ],
    ],
  ];
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small" aria-label={t('folioTotals')}>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {row.map(([label, value]) => (
                <TableCell key={label}>
                  <Typography variant="caption" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography variant="body2">{value}</Typography>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function FinancePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const money = useMoney(locale);
  const {
    run: runAction,
    error: actionError,
    busy: actionBusy,
  } = useApiAction();
  const { activeTenantId, hasPermission } = useAuth();
  const { propertyId } = useParams<{ propertyId: string }>();
  const [tab, setTab] = useState(0);
  const [selectedFolioId, setSelectedFolioId] = useState<string | null>(null);
  const [paymentFilter, setPaymentFilter] = useState('');
  const [openFolio, setOpenFolio] = useState(false);
  const [postCharge, setPostCharge] = useState(false);
  const [routeCharge, setRouteCharge] = useState<FolioCharge | null>(null);
  const [depositDialog, setDepositDialog] = useState(false);
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [refundDialog, setRefundDialog] = useState<FolioPayment | null>(null);
  const [resolveDialog, setResolveDialog] = useState<FolioRefund | null>(null);
  const [invoiceDialog, setInvoiceDialog] = useState(false);
  const [creditNoteDialog, setCreditNoteDialog] = useState<FolioInvoice | null>(
    null,
  );
  const [cashierOpen, setCashierOpen] = useState(false);
  const [cashierCount, setCashierCount] = useState<CashierSession | null>(null);
  const [cashierClose, setCashierClose] = useState<CashierSession | null>(null);
  const [clearanceReservationInput, setClearanceReservationInput] =
    useState('');
  const [clearanceReservationId, setClearanceReservationId] = useState<
    string | null
  >(null);
  const [settleDialog, setSettleDialog] = useState(false);

  const canRead = hasPermission('folio.read');
  const canCharge = hasPermission('folio.charge');
  const canRecord = hasPermission('payment.record');
  const canRefund = hasPermission('payment.refund.request');
  const canInvoice = hasPermission('invoice.issue');
  const canCashier = hasPermission('cashier.operate');

  const businessDay = useQuery({
    queryKey: ['finance-business-day', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () => financeApi.getBusinessDay(activeTenantId!, propertyId!),
  });
  const folios = useQuery({
    queryKey: ['finance-folios', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () => financeApi.listFolios(activeTenantId!, propertyId!),
  });
  const folioDetail = useQuery({
    queryKey: ['finance-folio', activeTenantId, propertyId, selectedFolioId],
    enabled: Boolean(
      activeTenantId && propertyId && canRead && selectedFolioId,
    ),
    queryFn: () =>
      financeApi.getFolio(activeTenantId!, propertyId!, selectedFolioId!),
  });
  const payments = useQuery({
    queryKey: ['finance-payments', activeTenantId, propertyId, paymentFilter],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () =>
      financeApi.listPayments(activeTenantId!, propertyId!, {
        folio_id: paymentFilter || undefined,
      }),
  });
  const invoices = useQuery({
    queryKey: ['finance-invoices', activeTenantId, propertyId, selectedFolioId],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () =>
      financeApi.listInvoices(activeTenantId!, propertyId!, {
        folio_id: selectedFolioId ?? undefined,
      }),
  });
  const cashier = useQuery({
    queryKey: ['finance-cashier', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () => financeApi.listCashierSessions(activeTenantId!, propertyId!),
  });
  const clearance = useQuery({
    queryKey: [
      'finance-clearance',
      activeTenantId,
      propertyId,
      clearanceReservationId,
    ],
    enabled: Boolean(
      activeTenantId && propertyId && canRead && clearanceReservationId,
    ),
    queryFn: () =>
      financeApi.getReservationClearance(
        activeTenantId!,
        propertyId!,
        clearanceReservationId!,
      ),
  });
  const externalSettlements = useQuery({
    queryKey: ['finance-external-settlements', activeTenantId, propertyId],
    enabled: Boolean(activeTenantId && propertyId && canRead),
    queryFn: () =>
      financeApi.listExternalSettlements(activeTenantId!, propertyId!),
  });

  useEffect(() => {
    if (!selectedFolioId && folios.data && folios.data.folios.length > 0)
      setSelectedFolioId(folios.data.folios[0]!.id);
  }, [selectedFolioId, folios.data]);

  if (!canRead)
    return (
      <div>
        <PageHeader title={t('financeTitle')} />
        <ForbiddenPanel />
      </div>
    );

  const day = businessDay.data?.business_day;
  const businessDate = day?.business_date ?? businessDay.data?.date ?? '';
  const selectedFolio =
    folioDetail.data?.folio ??
    folios.data?.folios.find((folio) => folio.id === selectedFolioId) ??
    null;
  const allFolios = folios.data?.folios ?? [];
  const clearanceData = clearance.data ?? null;

  return (
    <>
      <PageHeader
        title={t('financeTitle')}
        description={
          businessDay.data?.timezone
            ? `${t('financeDescription')} · ${businessDay.data.timezone}`
            : t('financeDescription')
        }
        action={
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              size="small"
              variant="outlined"
              color={
                day?.state === 'OPEN'
                  ? 'success'
                  : day?.state === 'CLOSED'
                    ? 'default'
                    : 'warning'
              }
              label={`${t('businessDayLabel')}: ${businessDay.data?.date ?? '-'}${
                day ? ` · ${t(`businessDayState.${day.state}`)}` : ''
              }`}
            />
            {canCharge ? (
              <Button variant="contained" onClick={() => setOpenFolio(true)}>
                {t('openFolioAction')}
              </Button>
            ) : null}
          </Stack>
        }
      />
      <Tabs
        value={tab}
        onChange={(_event, value: number) => setTab(value)}
        aria-label={t('financeTitle')}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab label={t('foliosTab')} />
        <Tab label={t('paymentsTab')} />
        <Tab label={t('invoicesTab')} />
        <Tab label={t('cashierTab')} />
        <Tab label={t('clearanceTab')} />
      </Tabs>
      <FinanceErrorAlert
        error={
          actionError ??
          businessDay.error ??
          folios.error ??
          folioDetail.error ??
          payments.error ??
          invoices.error ??
          cashier.error ??
          clearance.error ??
          externalSettlements.error
        }
      />
      {tab === 0 ? (
        folios.isLoading ? (
          <LoadingBlock />
        ) : allFolios.length === 0 ? (
          <EmptyBlock message={t('noFolios')} />
        ) : (
          <Stack spacing={3}>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('foliosTab')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('payerLabel')}</TableCell>
                    <TableCell>{t('folioKindLabel')}</TableCell>
                    <TableCell>{t('currencyLabel')}</TableCell>
                    <TableCell>{t('folioStateLabel')}</TableCell>
                    <TableCell>{t('reservationIdLabel')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {allFolios.map((folio) => (
                    <TableRow
                      key={folio.id}
                      selected={folio.id === selectedFolioId}
                    >
                      <TableCell>{folio.payer_label}</TableCell>
                      <TableCell>{t(`folioKind.${folio.kind}`)}</TableCell>
                      <TableCell>{folio.currency}</TableCell>
                      <TableCell>
                        <FolioStateChip state={folio.state} />
                      </TableCell>
                      <TableCell>{shortId(folio.reservation_id)}</TableCell>
                      <TableCell className="row-actions">
                        <Button
                          size="small"
                          onClick={() => setSelectedFolioId(folio.id)}
                        >
                          {t('selectFolio')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {folioDetail.isLoading && selectedFolioId ? (
              <LoadingBlock />
            ) : folioDetail.data && selectedFolio ? (
              <Stack spacing={2}>
                <Typography variant="h3" component="h3">
                  {`${t('folioDetailTitle')} · ${selectedFolio.payer_label}`}
                </Typography>
                <TotalsGrid detail={folioDetail.data} locale={locale} />
                <div className="page-header">
                  <Typography variant="h4" component="h4">
                    {t('chargesSection')}
                  </Typography>
                  {canCharge && selectedFolio.state === 'OPEN' ? (
                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => setPostCharge(true)}
                    >
                      {t('postChargeAction')}
                    </Button>
                  ) : null}
                </div>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small" aria-label={t('chargesSection')}>
                    <TableHead>
                      <TableRow>
                        <TableCell>{t('businessDate')}</TableCell>
                        <TableCell>{t('chargeKindLabel')}</TableCell>
                        <TableCell>{t('accountCode')}</TableCell>
                        <TableCell>{t('netAmount')}</TableCell>
                        <TableCell>{t('taxAmount')}</TableCell>
                        <TableCell>{t('sourceRef')}</TableCell>
                        <TableCell>{t('actions')}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {folioDetail.data.charges.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7}>
                            <EmptyBlock message={t('noCharges')} />
                          </TableCell>
                        </TableRow>
                      ) : (
                        folioDetail.data.charges.map((charge) => (
                          <TableRow key={charge.id}>
                            <TableCell>{charge.business_date}</TableCell>
                            <TableCell>
                              {t(`chargeKind.${charge.kind}`)}
                            </TableCell>
                            <TableCell>{charge.account_code}</TableCell>
                            <TableCell>
                              {money(charge.net_amount, charge.currency)}
                            </TableCell>
                            <TableCell>
                              {money(charge.tax_amount, charge.currency)}
                            </TableCell>
                            <TableCell>{charge.source_ref}</TableCell>
                            <TableCell className="row-actions">
                              {canCharge && selectedFolio.state === 'OPEN' ? (
                                <Button
                                  size="small"
                                  onClick={() => setRouteCharge(charge)}
                                >
                                  {t('routeChargeAction')}
                                </Button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
                {folioDetail.data.allocations.length > 0 ? (
                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small" aria-label={t('routingSection')}>
                      <TableHead>
                        <TableRow>
                          <TableCell>{t('chargeLabel')}</TableCell>
                          <TableCell>{t('payerFolio')}</TableCell>
                          <TableCell>{t('routeAmount')}</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {folioDetail.data.allocations.map((allocation) => (
                          <TableRow key={allocation.id}>
                            <TableCell>
                              {shortId(allocation.charge_id)}
                            </TableCell>
                            <TableCell>
                              {shortId(allocation.payer_folio_id)}
                            </TableCell>
                            <TableCell>
                              {money(allocation.amount, selectedFolio.currency)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        )
      ) : null}
      {tab === 1 ? (
        <Stack spacing={2}>
          <div className="page-header">
            <TextField
              select
              size="small"
              label={t('folioFilter')}
              value={paymentFilter}
              onChange={(event) => setPaymentFilter(event.target.value)}
              sx={{ minWidth: 240 }}
            >
              <MenuItem value="">{t('allFolios')}</MenuItem>
              {allFolios.map((folio) => (
                <MenuItem key={folio.id} value={folio.id}>
                  {`${folio.payer_label} · ${folio.currency}`}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1}>
              {canRecord ? (
                <Button
                  variant="contained"
                  onClick={() => setPaymentDialog(true)}
                >
                  {t('recordPaymentAction')}
                </Button>
              ) : null}
              {canCharge ? (
                <Button
                  onClick={() => setDepositDialog(true)}
                  disabled={!selectedFolio || selectedFolio.state !== 'OPEN'}
                >
                  {t('collectDepositAction')}
                </Button>
              ) : null}
            </Stack>
          </div>
          <Typography variant="h4" component="h4">
            {t('paymentsSection')}
          </Typography>
          {payments.isLoading ? (
            <LoadingBlock />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('paymentsSection')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('folioLabel')}</TableCell>
                    <TableCell>{t('paymentMethodLabel')}</TableCell>
                    <TableCell>{t('paymentAmount')}</TableCell>
                    <TableCell>{t('paymentStateLabel')}</TableCell>
                    <TableCell>{t('businessDate')}</TableCell>
                    <TableCell>{t('externalReference')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(payments.data?.payments ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <EmptyBlock message={t('noPayments')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    payments.data!.payments.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell>
                          {allFolios.find(
                            (folio) => folio.id === payment.folio_id,
                          )?.payer_label ?? shortId(payment.folio_id)}
                        </TableCell>
                        <TableCell>
                          {t(`paymentMethod.${payment.method}`)}
                        </TableCell>
                        <TableCell>
                          {money(payment.amount, payment.currency)}
                        </TableCell>
                        <TableCell>
                          <PaymentStateChip state={payment.state} />
                        </TableCell>
                        <TableCell>{payment.business_date}</TableCell>
                        <TableCell>{payment.external_reference}</TableCell>
                        <TableCell className="row-actions">
                          {canRecord && payment.state === 'UNKNOWN' ? (
                            <Button
                              size="small"
                              disabled={actionBusy}
                              onClick={() =>
                                void runAction(() =>
                                  financeApi.reconcilePayment(
                                    activeTenantId!,
                                    propertyId!,
                                    payment.id,
                                    { outcome: 'SUCCEEDED' },
                                  ),
                                )
                              }
                            >
                              {t('reconcileAction')}
                            </Button>
                          ) : null}
                          {canRefund && payment.state === 'SUCCEEDED' ? (
                            <Button
                              size="small"
                              onClick={() => setRefundDialog(payment)}
                            >
                              {t('requestRefundAction')}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Typography variant="h4" component="h4">
            {t('depositsSection')}
          </Typography>
          {!selectedFolio ? (
            <EmptyBlock message={t('selectFolioHint')} />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('depositsSection')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('depositKindLabel')}</TableCell>
                    <TableCell>{t('paymentMethodLabel')}</TableCell>
                    <TableCell>{t('depositAmount')}</TableCell>
                    <TableCell>{t('depositsApplied')}</TableCell>
                    <TableCell>{t('releasedAmount')}</TableCell>
                    <TableCell>{t('heldAmount')}</TableCell>
                    <TableCell>{t('externalReference')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(folioDetail.data?.deposits ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <EmptyBlock message={t('noDeposits')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    folioDetail.data!.deposits.map((deposit) => (
                      <TableRow key={deposit.id}>
                        <TableCell>
                          {t(`depositKind.${deposit.kind}`)}
                        </TableCell>
                        <TableCell>
                          {t(`paymentMethod.${deposit.method}`)}
                        </TableCell>
                        <TableCell>
                          {money(deposit.amount, deposit.currency)}
                        </TableCell>
                        <TableCell>
                          {money(deposit.applied, deposit.currency)}
                        </TableCell>
                        <TableCell>
                          {money(deposit.released, deposit.currency)}
                        </TableCell>
                        <TableCell>
                          {money(deposit.held, deposit.currency)}
                        </TableCell>
                        <TableCell>{deposit.external_reference}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Typography variant="h4" component="h4">
            {t('refundsSection')}
          </Typography>
          {!selectedFolio ? (
            <EmptyBlock message={t('selectFolioHint')} />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('refundsSection')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('paymentLabel')}</TableCell>
                    <TableCell>{t('refundAmount')}</TableCell>
                    <TableCell>{t('refundReason')}</TableCell>
                    <TableCell>{t('refundStateLabel')}</TableCell>
                    <TableCell>{t('approvalId')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(folioDetail.data?.refunds ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <EmptyBlock message={t('noRefunds')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    folioDetail.data!.refunds.map((refund) => (
                      <TableRow key={refund.id}>
                        <TableCell>{shortId(refund.payment_id)}</TableCell>
                        <TableCell>
                          {money(refund.amount, refund.currency)}
                        </TableCell>
                        <TableCell>{refund.reason}</TableCell>
                        <TableCell>
                          <RefundStateChip state={refund.state} />
                        </TableCell>
                        <TableCell>{shortId(refund.approval_id)}</TableCell>
                        <TableCell className="row-actions">
                          {canRefund &&
                          ['RESERVED', 'PENDING'].includes(refund.state) ? (
                            <Button
                              size="small"
                              onClick={() => setResolveDialog(refund)}
                            >
                              {t('resolveRefundAction')}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      ) : null}
      {tab === 2 ? (
        <Stack spacing={2}>
          <div className="page-header">
            <TextField
              select
              size="small"
              label={t('folioFilter')}
              value={selectedFolioId ?? ''}
              onChange={(event) =>
                setSelectedFolioId(event.target.value || null)
              }
              sx={{ minWidth: 240 }}
            >
              <MenuItem value="">{t('allFolios')}</MenuItem>
              {allFolios.map((folio) => (
                <MenuItem key={folio.id} value={folio.id}>
                  {`${folio.payer_label} · ${folio.currency}`}
                </MenuItem>
              ))}
            </TextField>
            {canInvoice && selectedFolio && selectedFolio.state === 'OPEN' ? (
              <Button
                variant="contained"
                onClick={() => setInvoiceDialog(true)}
              >
                {t('issueInvoiceAction')}
              </Button>
            ) : null}
          </div>
          {invoices.isLoading ? (
            <LoadingBlock />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('invoicesTab')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('invoiceNumber')}</TableCell>
                    <TableCell>{t('invoiceKindLabel')}</TableCell>
                    <TableCell>{t('businessDate')}</TableCell>
                    <TableCell>{t('netAmount')}</TableCell>
                    <TableCell>{t('taxAmount')}</TableCell>
                    <TableCell>{t('invoiceTotal')}</TableCell>
                    <TableCell>{t('sourceRef')}</TableCell>
                    <TableCell>{t('creditNotesTitle')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(invoices.data?.invoices ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9}>
                        <EmptyBlock message={t('noInvoices')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    invoices.data!.invoices.map((invoice) => (
                      <TableRow key={invoice.id}>
                        <TableCell>{`${invoice.series} ${invoice.number}`}</TableCell>
                        <TableCell>
                          {t(`invoiceKind.${invoice.kind}`)}
                        </TableCell>
                        <TableCell>{invoice.business_date}</TableCell>
                        <TableCell>
                          {money(invoice.net_amount, invoice.currency)}
                        </TableCell>
                        <TableCell>
                          {money(invoice.tax_amount, invoice.currency)}
                        </TableCell>
                        <TableCell>
                          {money(invoice.total_amount, invoice.currency)}
                        </TableCell>
                        <TableCell>{invoice.source_ref}</TableCell>
                        <TableCell>
                          {(invoice.credit_notes ?? []).length === 0
                            ? '-'
                            : invoice
                                .credit_notes!.map(
                                  (note) =>
                                    `${note.series} ${note.number} · ${money(note.amount, note.currency)}`,
                                )
                                .join(' | ')}
                        </TableCell>
                        <TableCell className="row-actions">
                          {canInvoice ? (
                            <Button
                              size="small"
                              onClick={() => setCreditNoteDialog(invoice)}
                            >
                              {t('issueCreditNoteAction')}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      ) : null}
      {tab === 3 ? (
        <Stack spacing={2}>
          <div className="page-header">
            <Typography variant="h4" component="h4">
              {t('cashierSessionsTitle')}
            </Typography>
            {canCashier ? (
              <Button variant="contained" onClick={() => setCashierOpen(true)}>
                {t('openCashierAction')}
              </Button>
            ) : null}
          </div>
          {cashier.isLoading ? (
            <LoadingBlock />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('cashierTab')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('currencyLabel')}</TableCell>
                    <TableCell>{t('cashierStateLabel')}</TableCell>
                    <TableCell>{t('openingFloat')}</TableCell>
                    <TableCell>{t('expectedAmount')}</TableCell>
                    <TableCell>{t('countedAmount')}</TableCell>
                    <TableCell>{t('varianceLabel')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(cashier.data?.cashier_sessions ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <EmptyBlock message={t('noCashierSessions')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    cashier.data!.cashier_sessions.map((session) => (
                      <TableRow key={session.id}>
                        <TableCell>{session.currency}</TableCell>
                        <TableCell>
                          <CashierStateChip state={session.state} />
                        </TableCell>
                        <TableCell>
                          {money(session.opening_float, session.currency)}
                        </TableCell>
                        <TableCell>
                          {money(session.expected_amount, session.currency)}
                        </TableCell>
                        <TableCell>
                          {money(session.counted_amount, session.currency)}
                        </TableCell>
                        <TableCell>
                          {money(session.variance, session.currency)}
                        </TableCell>
                        <TableCell className="row-actions">
                          {canCashier &&
                          ['OPEN', 'COUNTING'].includes(session.state) ? (
                            <Button
                              size="small"
                              onClick={() => setCashierCount(session)}
                            >
                              {t('countCashierAction')}
                            </Button>
                          ) : null}
                          {canCashier && session.state === 'RECONCILED' ? (
                            <Button
                              size="small"
                              color="warning"
                              onClick={() => setCashierClose(session)}
                            >
                              {t('closeCashierAction')}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      ) : null}
      {tab === 4 ? (
        <Stack spacing={2}>
          <div className="page-header">
            <TextField
              size="small"
              label={t('clearanceReservationLabel')}
              value={clearanceReservationInput}
              onChange={(event) =>
                setClearanceReservationInput(event.target.value)
              }
              sx={{ minWidth: 320 }}
              helperText={t('clearanceReservationHint')}
            />
            <Button
              variant="contained"
              disabled={clearanceReservationInput.trim().length === 0}
              onClick={() =>
                setClearanceReservationId(clearanceReservationInput.trim())
              }
            >
              {t('loadClearanceAction')}
            </Button>
          </div>
          {!clearanceReservationId ? (
            <EmptyBlock message={t('clearanceSelectHint')} />
          ) : clearance.isLoading ? (
            <LoadingBlock />
          ) : clearanceData ? (
            <Stack spacing={2}>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  useFlexGap
                  flexWrap="wrap"
                >
                  <ClearanceStateChip
                    state={clearanceData.reservation.financial_clearance_state}
                  />
                  <Chip
                    size="small"
                    variant="outlined"
                    color={
                      clearanceData.reservation.departed ? 'default' : 'info'
                    }
                    label={
                      clearanceData.reservation.departed
                        ? t('clearanceDeparted')
                        : t('clearanceInHouse')
                    }
                  />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={clearanceData.reservation.state}
                  />
                  {clearanceData.reservation.financial_clearance_basis ? (
                    <Chip
                      size="small"
                      variant="outlined"
                      color="info"
                      label={`${t('clearanceBasisLabel')}: ${t(
                        `clearanceBasis.${clearanceData.reservation.financial_clearance_basis}`,
                      )}`}
                    />
                  ) : null}
                  {clearanceData.reservation.financial_clearance_reference ? (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${t('clearanceReference')}: ${
                        clearanceData.reservation.financial_clearance_reference
                      }`}
                    />
                  ) : null}
                </Stack>
                <Typography variant="h4" component="h4" sx={{ mt: 1 }}>
                  {`${t('clearanceTitle')} · ${shortId(clearanceData.reservation.id)}`}
                </Typography>
                {clearanceData.settled ? (
                  <Alert severity="success">
                    {t('clearanceSettledNotice')}
                  </Alert>
                ) : clearanceData.outstanding ? (
                  <Alert severity="warning">
                    {t('clearanceOutstandingNotice')}
                  </Alert>
                ) : clearanceData.credit ? (
                  <Alert severity="warning">{t('clearanceCreditNotice')}</Alert>
                ) : (
                  <Alert severity="info">{t('clearanceBalancedNotice')}</Alert>
                )}
              </Paper>
              <div className="page-header">
                <Typography variant="h4" component="h4">
                  {t('clearanceTotalsTitle')}
                </Typography>
                {canCharge &&
                clearanceData.reservation.financial_clearance_state ===
                  'PENDING' &&
                clearanceData.reservation.departed ? (
                  <Button
                    variant="contained"
                    onClick={() => setSettleDialog(true)}
                  >
                    {t('settleClearanceAction')}
                  </Button>
                ) : null}
              </div>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label={t('clearanceTotalsTitle')}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('currencyLabel')}</TableCell>
                      <TableCell>{t('chargesTotal')}</TableCell>
                      <TableCell>{t('adjustmentsTotal')}</TableCell>
                      <TableCell>{t('routedOut')}</TableCell>
                      <TableCell>{t('routedIn')}</TableCell>
                      <TableCell>{t('paymentsTotal')}</TableCell>
                      <TableCell>{t('refundsTotal')}</TableCell>
                      <TableCell>{t('depositsHeld')}</TableCell>
                      <TableCell>{t('depositsApplied')}</TableCell>
                      <TableCell>{t('balanceDue')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {clearanceData.totals_by_currency.map((row) => (
                      <TableRow key={row.currency}>
                        <TableCell>{row.currency}</TableCell>
                        <TableCell>
                          {money(row.charges_total, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.adjustments_total, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.routed_out, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.routed_in, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.payments_total, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.refunds_total, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.deposits_held, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.deposits_applied, row.currency)}
                        </TableCell>
                        <TableCell>
                          {money(row.balance_due, row.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <Typography variant="h4" component="h4">
                {t('clearanceFoliosTitle')}
              </Typography>
              {clearanceData.folios.map((folio) => (
                <Paper key={folio.folio.id} variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="body1">
                    {`${folio.folio.payer_label} · ${folio.folio.currency} · ${t(
                      `folioKind.${folio.folio.kind}`,
                    )}`}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {`${t('chargesTotal')}: ${money(
                      folio.totals.charges_total,
                      folio.folio.currency,
                    )} · ${t('paymentsTotal')}: ${money(
                      folio.totals.payments_total,
                      folio.folio.currency,
                    )} · ${t('balanceDue')}: ${money(
                      folio.totals.balance_due,
                      folio.folio.currency,
                    )}`}
                  </Typography>
                  {folio.schedules.map((schedule) => (
                    <Typography
                      key={schedule.id}
                      variant="caption"
                      display="block"
                      color="text.secondary"
                    >
                      {`${schedule.code} · ${t('postedPeriodsLabel')}: ${
                        schedule.posted_periods
                      } · ${t('nextPeriodLabel')}: ${
                        schedule.next_period_start ?? '-'
                      }`}
                    </Typography>
                  ))}
                  {folio.entitlements.map((entitlement) => (
                    <Typography
                      key={entitlement.id}
                      variant="caption"
                      display="block"
                      color="text.secondary"
                    >
                      {`${entitlement.code} · ${t('consumedLabel')}: ${
                        entitlement.quantity_consumed
                      }/${entitlement.quantity_total}`}
                    </Typography>
                  ))}
                </Paper>
              ))}
              <Typography variant="h4" component="h4">
                {t('externalSettlementsTitle')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('externalSettlementsHint')}
              </Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label={t('externalSettlementsTitle')}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('businessDate')}</TableCell>
                      <TableCell>{t('reservationIdLabel')}</TableCell>
                      <TableCell>{t('paymentMethodLabel')}</TableCell>
                      <TableCell>{t('netAmount')}</TableCell>
                      <TableCell>{t('grossAmount')}</TableCell>
                      <TableCell>{t('commissionAmount')}</TableCell>
                      <TableCell>{t('paymentStateLabel')}</TableCell>
                      <TableCell>{t('externalReference')}</TableCell>
                      <TableCell>{t('linkedExternalBooking')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(externalSettlements.data?.settlements ?? []).length ===
                    0 ? (
                      <TableRow>
                        <TableCell colSpan={9}>
                          <EmptyBlock message={t('noExternalSettlements')} />
                        </TableCell>
                      </TableRow>
                    ) : (
                      externalSettlements.data!.settlements.map(
                        (settlement: ExternalSettlement) => (
                          <TableRow key={settlement.id}>
                            <TableCell>{settlement.business_date}</TableCell>
                            <TableCell>
                              {shortId(
                                settlement.reservation?.id ??
                                  settlement.folio_reservation_id,
                              )}
                            </TableCell>
                            <TableCell>
                              {t(`paymentMethod.${settlement.method}`)}
                            </TableCell>
                            <TableCell>
                              {money(settlement.amount, settlement.currency)}
                            </TableCell>
                            <TableCell>
                              {money(
                                settlement.gross_amount,
                                settlement.currency,
                              )}
                            </TableCell>
                            <TableCell>
                              {money(
                                settlement.commission_amount,
                                settlement.currency,
                              )}
                            </TableCell>
                            <TableCell>
                              <PaymentStateChip state={settlement.state} />
                            </TableCell>
                            <TableCell>
                              {settlement.external_reference}
                            </TableCell>
                            <TableCell>
                              {settlement.linked_to_external_booking &&
                              settlement.external_booking
                                ? `${settlement.external_booking.channel_key} · ${
                                    settlement.external_booking
                                      .provider_booking_id ?? '-'
                                  }`
                                : t('notLinkedExternalBooking')}
                            </TableCell>
                          </TableRow>
                        ),
                      )
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Stack>
          ) : null}
        </Stack>
      ) : null}
      {openFolio && activeTenantId && propertyId ? (
        <OpenFolioDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          onClose={() => setOpenFolio(false)}
        />
      ) : null}
      {postCharge && activeTenantId && propertyId && selectedFolio ? (
        <PostChargeDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          folio={selectedFolio}
          businessDate={businessDate}
          onClose={() => setPostCharge(false)}
        />
      ) : null}
      {routeCharge && activeTenantId && propertyId ? (
        <RouteChargeDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          charge={routeCharge}
          folios={allFolios}
          onClose={() => setRouteCharge(null)}
        />
      ) : null}
      {depositDialog && activeTenantId && propertyId && selectedFolio ? (
        <CollectDepositDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          folio={selectedFolio}
          businessDate={businessDate}
          onClose={() => setDepositDialog(false)}
        />
      ) : null}
      {paymentDialog && activeTenantId && propertyId ? (
        <RecordPaymentDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          folios={allFolios}
          defaultFolioId={selectedFolioId}
          businessDate={businessDate}
          onClose={() => setPaymentDialog(false)}
        />
      ) : null}
      {refundDialog && activeTenantId && propertyId ? (
        <RequestRefundDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          payment={refundDialog}
          onClose={() => setRefundDialog(null)}
        />
      ) : null}
      {resolveDialog && activeTenantId && propertyId ? (
        <ResolveRefundDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          refund={resolveDialog}
          onClose={() => setResolveDialog(null)}
        />
      ) : null}
      {invoiceDialog && activeTenantId && propertyId && selectedFolio ? (
        <IssueInvoiceDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          folio={selectedFolio}
          businessDate={businessDate}
          onClose={() => setInvoiceDialog(false)}
        />
      ) : null}
      {creditNoteDialog && activeTenantId && propertyId ? (
        <IssueCreditNoteDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          invoice={creditNoteDialog}
          onClose={() => setCreditNoteDialog(null)}
        />
      ) : null}
      {cashierOpen && activeTenantId && propertyId ? (
        <OpenCashierDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          onClose={() => setCashierOpen(false)}
        />
      ) : null}
      {cashierCount && activeTenantId && propertyId ? (
        <CountCashierDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          session={cashierCount}
          onClose={() => setCashierCount(null)}
        />
      ) : null}
      {cashierClose && activeTenantId && propertyId ? (
        <CloseCashierDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          session={cashierClose}
          onClose={() => setCashierClose(null)}
        />
      ) : null}
      {settleDialog && activeTenantId && propertyId && clearanceData ? (
        <SettleClearanceDialog
          tenantId={activeTenantId}
          propertyId={propertyId}
          clearance={clearanceData}
          folios={allFolios}
          onClose={() => setSettleDialog(false)}
        />
      ) : null}
    </>
  );
}
