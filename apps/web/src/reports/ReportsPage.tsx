import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { formatInstant } from '@hotel/i18n';
import type { Locale, Zone } from '@hotel/i18n';
import { useAuth } from '../auth/AuthProvider.js';
import { ErrorAlert, ForbiddenPanel, PageHeader } from '../identity/shared.js';
import { ApiError } from '../api/client.js';
import { reportsApi } from '../api/reports.js';
import type {
  ReportExport,
  ReportKind,
  ReportQueryInput,
  ReportResult,
} from '../api/reports.js';

const propertyKinds: ReportKind[] = [
  'OCCUPANCY',
  'ADR_REVPAR',
  'ARRIVALS',
  'DEPARTURES',
  'PICKUP',
  'REVENUE',
  'TAX',
  'SETTLEMENTS',
  'CHANNEL_PERFORMANCE',
];
const financialKinds: ReportKind[] = [
  'ADR_REVPAR',
  'REVENUE',
  'TAX',
  'SETTLEMENTS',
  'CHANNEL_PERFORMANCE',
];

function localToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Metric labels are localized by their declared base key; the dotted suffix
 * (resource type, product kind, product state...) stays as declared data and
 * is localized separately when a translation exists. Server-generated
 * families keep their state embedded in the key
 * (`housekeeping_dirty.ROOM`, `arrivals_state_confirmed`), so those are
 * reconstructed from the base label plus the declared state labels. Unknown
 * keys keep the raw declared label instead of hiding the number.
 */
export function metricLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  key: string,
  fallback: string,
): string {
  const exact = t(`metricLabels.${key}`, { defaultValue: '' });
  if (exact) return exact;
  const stateLabel = (scopes: string[], token: string): string => {
    const upper = token.toUpperCase();
    for (const scope of scopes) {
      const label = t(`${scope}.${upper}`, { defaultValue: '' });
      if (label) return label;
    }
    return token;
  };
  const condition = /^(housekeeping|maintenance)_([a-z]+)(?:\.(.+))?$/.exec(
    key,
  );
  if (condition) {
    const base = t(`metricLabels.${condition[1]}`, { defaultValue: '' });
    if (base) {
      const parts = [base, stateLabel([`${condition[1]}State`], condition[2]!)];
      if (condition[3]) parts.push(condition[3]);
      return parts.join(' · ');
    }
  }
  const stateCount = /^(arrivals|departures)_state_(.+)$/.exec(key);
  if (stateCount) {
    const base = t(`metricLabels.${stateCount[1]}_state`, { defaultValue: '' });
    if (base)
      return `${base} · ${stateLabel(
        ['reportStates', 'reservationState'],
        stateCount[2]!,
      )}`;
  }
  const separator = key.lastIndexOf('.');
  if (separator > 0) {
    const base = key.slice(0, separator);
    const qualifier = key.slice(separator + 1);
    const baseLabel = t(`metricLabels.${base}`, { defaultValue: '' });
    if (baseLabel) {
      const qualifierLabel = t(`reportStates.${qualifier}`, {
        defaultValue: '',
      });
      return `${baseLabel} · ${qualifierLabel || qualifier}`;
    }
  }
  return fallback;
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const { propertyId } = useParams();
  const { activeTenantId, hasPermission } = useAuth();
  const tenantId = activeTenantId ?? '';
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ReportKind>('OCCUPANCY');
  const [from, setFrom] = useState(localToday());
  const [to, setTo] = useState(addDays(localToday(), 1));
  const [currency, setCurrency] = useState<'IDR' | 'USD'>('IDR');
  const [resourceType, setResourceType] = useState('');
  const [referenceDate, setReferenceDate] = useState('');
  const [portfolio, setPortfolio] = useState(false);
  const [submitted, setSubmitted] = useState<ReportQueryInput | null>(null);
  const [submittedPortfolio, setSubmittedPortfolio] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const canRead = hasPermission('report.operational.view');
  const canFinancial = hasPermission('report.financial.view');
  const canExport = hasPermission('report.export');
  const language = i18n.language as Locale;

  const isFinancial = financialKinds.includes(kind);
  const query = useQuery({
    queryKey: ['report', tenantId, propertyId, submitted, submittedPortfolio],
    queryFn: () =>
      submittedPortfolio
        ? reportsApi.readPortfolio(tenantId, {
            kind: 'PORTFOLIO',
            period: { date_from: from, date_to: to },
            currency,
          })
        : reportsApi.read(tenantId, propertyId ?? '', submitted!),
    enabled:
      Boolean(tenantId) &&
      canRead &&
      (canFinancial ||
        !(submitted && financialKinds.includes(submitted.kind))) &&
      submitted !== null,
    retry: false,
  });

  const exportsQuery = useQuery({
    queryKey: ['report-exports', tenantId, propertyId],
    queryFn: () => reportsApi.listExports(tenantId, propertyId ?? ''),
    enabled: Boolean(tenantId && propertyId && canExport),
    retry: false,
    refetchInterval: (queryState) => {
      const items = queryState.state.data?.items ?? [];
      return items.some(
        (item) => item.state === 'PENDING' || item.state === 'RUNNING',
      )
        ? 2000
        : false;
    },
  });

  const createExport = useMutation({
    mutationFn: () =>
      reportsApi.createExport(tenantId, propertyId ?? '', submitted!),
    onSuccess: () => {
      setExportError(null);
      void queryClient.invalidateQueries({
        queryKey: ['report-exports', tenantId, propertyId],
      });
    },
    onError: (error: unknown) => {
      setExportError(
        error instanceof ApiError ? `errors.${error.code}` : 'requestError',
      );
    },
  });

  const revokeExport = useMutation({
    mutationFn: (exportId: string) =>
      reportsApi.revokeExport(tenantId, exportId),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ['report-exports', tenantId, propertyId],
      }),
  });

  const captureSnapshot = useMutation({
    mutationFn: () =>
      reportsApi.captureSnapshot(
        tenantId,
        propertyId ?? '',
        referenceDate || undefined,
      ),
  });

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const report: ReportResult | undefined = query.data;
  const lagSeconds = report
    ? Math.max(0, Math.round((now - Date.parse(report.generated_at)) / 1000))
    : 0;

  const metricRows = useMemo(() => report?.metrics ?? [], [report]);
  const rowRows = useMemo(() => report?.rows ?? [], [report]);

  if (!canRead) return <ForbiddenPanel />;

  const runQuery = () => {
    setSubmittedPortfolio(portfolio);
    setSubmitted({
      kind: portfolio ? 'REVENUE' : kind,
      period: { date_from: from, date_to: to },
      ...(isFinancial || portfolio ? { currency } : {}),
      ...(kind === 'OCCUPANCY' && resourceType
        ? { resource_type: resourceType }
        : {}),
      ...(kind === 'PICKUP' && referenceDate
        ? { reference_date: referenceDate }
        : {}),
    });
    if (!portfolio) {
      setSubmitted({
        kind,
        period: { date_from: from, date_to: to },
        ...(isFinancial ? { currency } : {}),
        ...(kind === 'OCCUPANCY' && resourceType
          ? { resource_type: resourceType }
          : {}),
        ...(kind === 'PICKUP' && referenceDate
          ? { reference_date: referenceDate }
          : {}),
      });
    }
  };

  const downloadExport = async (item: ReportExport) => {
    try {
      const file = await reportsApi.downloadExport(tenantId, item.id);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setExportError(null);
    } catch (error) {
      setExportError(
        error instanceof Error && error.message.startsWith('REPORT_EXPORT')
          ? `errors.${error.message}`
          : 'requestError',
      );
    }
  };

  return (
    <Stack spacing={2}>
      <PageHeader
        title={t('reportsTitle')}
        description={
          report
            ? t('reports.generatedAt', {
                value: formatInstant(
                  report.generated_at,
                  'Asia/Jakarta' as Zone,
                  language,
                ),
              })
            : undefined
        }
      />
      {!canFinancial ? (
        <Alert severity="info">
          {t('reports.financialPermissionRequired')}
        </Alert>
      ) : null}
      <Paper sx={{ p: 2 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          useFlexGap
          flexWrap="wrap"
        >
          <TextField
            select
            size="small"
            label={t('reports.kind')}
            value={kind}
            onChange={(event) => setKind(event.target.value as ReportKind)}
            sx={{ minWidth: 220 }}
            disabled={portfolio}
          >
            {propertyKinds
              .filter(
                (value) => canFinancial || !financialKinds.includes(value),
              )
              .map((value) => (
                <MenuItem key={value} value={value}>
                  {t(`reportKinds.${value}`, value)}
                </MenuItem>
              ))}
          </TextField>
          <TextField
            size="small"
            type="date"
            label={t('reports.periodFrom')}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            type="date"
            label={t('reports.periodTo')}
            value={to}
            onChange={(event) => setTo(event.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          {isFinancial || portfolio ? (
            <TextField
              select
              size="small"
              label={t('reports.currency')}
              value={currency}
              onChange={(event) =>
                setCurrency(event.target.value as 'IDR' | 'USD')
              }
              sx={{ minWidth: 120 }}
            >
              <MenuItem value="IDR">IDR</MenuItem>
              <MenuItem value="USD">USD</MenuItem>
            </TextField>
          ) : null}
          {kind === 'OCCUPANCY' && !portfolio ? (
            <TextField
              size="small"
              label={t('reports.resourceType')}
              value={resourceType}
              onChange={(event) => setResourceType(event.target.value)}
              sx={{ minWidth: 140 }}
            />
          ) : null}
          {kind === 'PICKUP' && !portfolio ? (
            <TextField
              size="small"
              type="date"
              label={t('reports.referenceDate')}
              value={referenceDate}
              onChange={(event) => setReferenceDate(event.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          ) : null}
          <FormControlLabel
            control={
              <Switch
                checked={portfolio}
                onChange={(event) => setPortfolio(event.target.checked)}
              />
            }
            label={t('reports.allProperties')}
          />
          <Button variant="contained" onClick={runQuery} disabled={!tenantId}>
            {t('reports.query')}
          </Button>
          {kind === 'PICKUP' && !portfolio ? (
            <Button
              variant="outlined"
              onClick={() => captureSnapshot.mutate()}
              disabled={captureSnapshot.isPending}
            >
              {t('reports.captureSnapshot')}
            </Button>
          ) : null}
        </Stack>
      </Paper>

      {query.isFetching ? <CircularProgress aria-label={t('loading')} /> : null}
      {query.isError ? <ErrorAlert error={query.error} /> : null}
      {query.data ? (
        <>
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <Chip
                size="small"
                variant="outlined"
                label={`${t('reports.cutoff')}: ${
                  report?.cutoff.business_date ?? '-'
                } (${report?.cutoff.state ?? '-'})`}
              />
              <Chip
                size="small"
                variant="outlined"
                label={`${t('reports.timezone')}: ${report?.cutoff.property_timezone}`}
              />
              <Chip
                size="small"
                variant="outlined"
                label={`${t('reports.dataBasis')}: ${report?.data_basis}`}
              />
              <Chip
                size="small"
                variant="outlined"
                label={`${t('reports.lag')}: ${lagSeconds}s`}
              />
              {report?.currency ? (
                <Chip size="small" variant="outlined" label={report.currency} />
              ) : null}
            </Stack>
          </Paper>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('reports.metrics')}</TableCell>
                  <TableCell>{t('reports.value')}</TableCell>
                  <TableCell>{t('reports.unit')}</TableCell>
                  <TableCell>{t('reports.basis')}</TableCell>
                  <TableCell>
                    {t('reports.numerator')}/{t('reports.denominator')}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {metricRows.map((metric) => (
                  <TableRow key={metric.key}>
                    <TableCell>
                      {metricLabel(t, metric.key, metric.label)}
                    </TableCell>
                    <TableCell>
                      {metric.value ?? (
                        <Alert severity="warning" sx={{ py: 0 }}>
                          {t(`reports.nullReasons.${metric.null_reason}`, '-')}
                        </Alert>
                      )}
                    </TableCell>
                    <TableCell>{metric.unit}</TableCell>
                    <TableCell>
                      {t(`reportBases.${metric.basis}`, metric.basis)}
                    </TableCell>
                    <TableCell>
                      {metric.denominator
                        ? `${metric.numerator ?? '-'} / ${metric.denominator}`
                        : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('reports.rows')}</TableCell>
                  <TableCell>{t('reports.value')}</TableCell>
                  <TableCell>{t('reports.unit')}</TableCell>
                  <TableCell>{t('reports.state')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rowRows.map((row, index) => (
                  <TableRow key={`${row.label}-${index}`}>
                    <TableCell>{row.label}</TableCell>
                    <TableCell>{row.value}</TableCell>
                    <TableCell>{row.unit}</TableCell>
                    <TableCell>{row.state ?? row.date ?? '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      ) : null}

      {canExport && propertyId ? (
        <Paper sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Typography variant="h3" component="h3">
              {t('reports.export')}
            </Typography>
            <Typography variant="body2">{t('reports.exportHint')}</Typography>
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                disabled={
                  !submitted || submittedPortfolio || createExport.isPending
                }
                onClick={() => createExport.mutate()}
              >
                {t('reports.createExport')}
              </Button>
              {exportError ? (
                <Alert severity="error">{t(exportError)}</Alert>
              ) : null}
            </Stack>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('reports.kind')}</TableCell>
                    <TableCell>{t('reports.state')}</TableCell>
                    <TableCell>{t('reports.expiresAt')}</TableCell>
                    <TableCell>{t('reports.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(exportsQuery.data?.items ?? []).map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        {t(`reportKinds.${item.kind}`, item.kind)}
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={t(
                            `reportExportStates.${item.state}`,
                            item.state,
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        {formatInstant(
                          item.expires_at,
                          'Asia/Jakarta' as Zone,
                          language,
                        )}
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          <Button
                            size="small"
                            disabled={item.state !== 'READY'}
                            onClick={() => void downloadExport(item)}
                          >
                            {t('reports.download')}
                          </Button>
                          <Button
                            size="small"
                            color="warning"
                            disabled={item.state !== 'READY'}
                            onClick={() => revokeExport.mutate(item.id)}
                          >
                            {t('reports.revoke')}
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        </Paper>
      ) : null}
      <Box />
    </Stack>
  );
}
