import { useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Stack,
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
import { EmptyBlock } from '../identity/TenantSelectPage.js';
import {
  ErrorAlert,
  ForbiddenPanel,
  PageHeader,
  useApiAction,
} from '../identity/shared.js';
import { ApiError } from '../api/client.js';
import { nightAuditApi } from '../api/nightAudit.js';
import type {
  NightAuditException,
  NightAuditOverview,
} from '../api/nightAudit.js';

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : '-';
}

function stateColor(
  state: string,
): 'default' | 'info' | 'success' | 'warning' | 'error' {
  if (['CLOSED', 'SUCCEEDED', 'DONE'].includes(state)) return 'success';
  if (['CLOSING', 'FAILED', 'VALIDATION_FAILED'].includes(state))
    return 'error';
  if (
    ['RUNNING', 'PENDING', 'AUDIT_PREPARING', 'AUDIT_VALIDATION'].includes(
      state,
    )
  )
    return 'info';
  return 'default';
}

function ChipLabel({
  group,
  value,
}: {
  group: string;
  value: string | null | undefined;
}) {
  const { t } = useTranslation();
  if (!value) return <Chip size="small" variant="outlined" label="-" />;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={stateColor(value)}
      label={t(`${group}.${value}`, value)}
    />
  );
}

export function NightAuditPage() {
  const { t, i18n } = useTranslation();
  const { propertyId } = useParams();
  const { activeTenantId, hasPermission } = useAuth();
  const canRead = hasPermission('folio.read');
  const canClose = hasPermission('business_day.close');
  const [date, setDate] = useState('');
  const [ackTarget, setAckTarget] = useState<NightAuditException | null>(null);
  const [ownerLabel, setOwnerLabel] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const action = useApiAction();

  const overviewQuery = useQuery({
    queryKey: ['night-audit', activeTenantId, propertyId, date],
    queryFn: () =>
      nightAuditApi.getOverview(
        activeTenantId!,
        propertyId!,
        date || undefined,
      ),
    enabled: Boolean(canRead && activeTenantId && propertyId),
    refetchInterval: (query) => {
      const state = (query.state.data as NightAuditOverview | undefined)?.run
        ?.state;
      return state === 'PENDING' || state === 'RUNNING' ? 2000 : false;
    },
  });

  if (!canRead) return <ForbiddenPanel />;
  const data = overviewQuery.data;

  const formatTime = (value: string | null | undefined) => {
    if (!value) return '-';
    try {
      return formatInstant(
        value,
        (data?.timezone ?? 'Asia/Jakarta') as Zone,
        i18n.language as Locale,
      );
    } catch {
      return value;
    }
  };

  const start = () =>
    action
      .run(
        async () => {
          const target = date || data?.active_business_date || data?.date;
          if (!target || !activeTenantId || !propertyId) return null;
          return nightAuditApi.start(activeTenantId, propertyId, target);
        },
        { refreshQueries: false },
      )
      .then((result) => {
        if (result) {
          setNotice(t('nightAuditStarted'));
          void overviewQuery.refetch();
        }
      });

  const retry = () =>
    action
      .run(
        async () => {
          if (!activeTenantId || !propertyId || !data?.run) return null;
          return nightAuditApi.retry(activeTenantId, propertyId, data.run.id);
        },
        { refreshQueries: false },
      )
      .then((result) => {
        if (result) {
          setNotice(t('nightAuditRetried'));
          void overviewQuery.refetch();
        }
      });

  const acknowledge = () =>
    action
      .run(
        async () => {
          if (!ackTarget || !activeTenantId || !propertyId) return null;
          return nightAuditApi.resolveException(
            activeTenantId,
            propertyId,
            ackTarget.id,
            { owner_label: ownerLabel.trim(), reason: reason.trim() },
          );
        },
        { refreshQueries: false },
      )
      .then((result) => {
        if (result) {
          setNotice(t('nightAuditAcknowledged'));
          setAckTarget(null);
          setOwnerLabel('');
          setReason('');
          void overviewQuery.refetch();
        }
      });

  const busyHint =
    action.error instanceof ApiError &&
    ['BUSINESS_DAY_BUSY', 'AUDIT_EXCEPTIONS_OPEN'].includes(action.error.code);

  return (
    <Stack spacing={3}>
      <PageHeader
        title={t('nightAuditTitle')}
        description={t('nightAuditDescription')}
        action={
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              type="date"
              label={t('nightAuditBusinessDate')}
              value={date}
              onChange={(event) => setDate(event.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <Button
              variant="outlined"
              onClick={() => void overviewQuery.refetch()}
              disabled={overviewQuery.isFetching}
            >
              {t('nightAuditRefresh')}
            </Button>
            {canClose ? (
              <Button
                variant="contained"
                onClick={() => void start()}
                disabled={action.busy || data?.run?.state === 'RUNNING'}
              >
                {t('nightAuditStart')}
              </Button>
            ) : null}
            {canClose &&
            (data?.run?.state === 'FAILED' ||
              data?.run?.state === 'VALIDATION_FAILED') ? (
              <Button
                variant="outlined"
                color="warning"
                onClick={() => void retry()}
                disabled={action.busy}
              >
                {t('nightAuditRetry')}
              </Button>
            ) : null}
          </Stack>
        }
      />

      {overviewQuery.isError ? (
        <ErrorAlert error={overviewQuery.error} />
      ) : null}
      {action.error ? <ErrorAlert error={action.error} /> : null}
      {busyHint ? (
        <Alert severity="info">{t('nightAuditBusyHint')}</Alert>
      ) : null}
      {notice ? (
        <Alert severity="success" role="status">
          {notice}
        </Alert>
      ) : null}

      {overviewQuery.isLoading ? (
        <CircularProgress aria-label={t('loading')} />
      ) : !data ? (
        <EmptyBlock message={t('nightAuditNoRun')} />
      ) : (
        <>
          <Paper sx={{ p: 2 }}>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={2}
              alignItems={{ xs: 'flex-start', md: 'center' }}
            >
              <Stack spacing={0.5}>
                <Typography variant="body2" color="text.secondary">
                  {t('nightAuditBusinessDate')}
                </Typography>
                <Typography variant="h6">{data.date}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('nightAuditTimezone')}: {data.timezone}
                </Typography>
              </Stack>
              <Stack spacing={0.5}>
                <Typography variant="body2" color="text.secondary">
                  {t('nightAuditDay')}
                </Typography>
                <ChipLabel
                  group="businessDayState"
                  value={data.business_day?.state}
                />
                {data.business_day?.closed_at ? (
                  <Typography variant="caption" color="text.secondary">
                    {t('nightAuditClosed')}:{' '}
                    {formatTime(data.business_day.closed_at)}
                  </Typography>
                ) : null}
              </Stack>
              <Stack spacing={0.5}>
                <Typography variant="body2" color="text.secondary">
                  {t('nightAuditRun')}
                </Typography>
                <ChipLabel group="nightAuditState" value={data.run?.state} />
                {data.run ? (
                  <Typography variant="caption" color="text.secondary">
                    {t('nightAuditCurrentStep')}:{' '}
                    {data.run.current_step
                      ? t(
                          `nightAuditStepName.${data.run.current_step}`,
                          data.run.current_step,
                        )
                      : '-'}
                  </Typography>
                ) : null}
              </Stack>
              <Stack spacing={0.5} sx={{ minWidth: 220, flex: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  {t('nightAuditProgress', {
                    done: data.run?.steps_done ?? 0,
                    total: data.run?.steps_total ?? 10,
                  })}
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={
                    data.run && data.run.steps_total > 0
                      ? Math.round(
                          (data.run.steps_done / data.run.steps_total) * 100,
                        )
                      : 0
                  }
                />
                {data.run?.last_error_code ? (
                  <Typography variant="caption" color="error">
                    {t(
                      `errors.${data.run.last_error_code}`,
                      data.run.last_error_code,
                    )}
                  </Typography>
                ) : null}
              </Stack>
            </Stack>
          </Paper>

          <Paper sx={{ p: 2 }}>
            <Typography variant="h3" component="h3" gutterBottom>
              {t('nightAuditSteps')}
            </Typography>
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('nightAuditStep')}</TableCell>
                    <TableCell>{t('status')}</TableCell>
                    <TableCell>{t('nightAuditAttempts')}</TableCell>
                    <TableCell>{t('nightAuditCheckpoint')}</TableCell>
                    <TableCell>{t('nightAuditWhen')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.steps.map((step) => (
                    <TableRow key={step.step_key}>
                      <TableCell>
                        {t(
                          `nightAuditStepName.${step.step_key}`,
                          step.step_key,
                        )}
                      </TableCell>
                      <TableCell>
                        <ChipLabel
                          group="nightAuditStepState"
                          value={step.state}
                        />
                      </TableCell>
                      <TableCell>{step.attempts}</TableCell>
                      <TableCell
                        sx={{ maxWidth: 280, wordBreak: 'break-word' }}
                      >
                        {step.checkpoint
                          ? Object.entries(step.checkpoint)
                              .slice(0, 4)
                              .map(([key, value]) => `${key}=${String(value)}`)
                              .join(', ')
                          : '-'}
                      </TableCell>
                      <TableCell>{formatTime(step.finished_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>

          <Paper sx={{ p: 2 }}>
            <Typography variant="h3" component="h3" gutterBottom>
              {t('nightAuditExceptions')}
            </Typography>
            {data.exceptions.length === 0 ? (
              <EmptyBlock message={t('nightAuditNoExceptions')} />
            ) : (
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('nightAuditException')}</TableCell>
                      <TableCell>{t('nightAuditSeverity')}</TableCell>
                      <TableCell>{t('status')}</TableCell>
                      <TableCell>{t('nightAuditSubject')}</TableCell>
                      <TableCell>{t('nightAuditMessage')}</TableCell>
                      <TableCell>{t('nightAuditOwnerLabel')}</TableCell>
                      <TableCell>{t('nightAuditReason')}</TableCell>
                      {canClose ? <TableCell /> : null}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.exceptions.map((exception) => (
                      <TableRow key={exception.id}>
                        <TableCell>
                          {t(
                            `nightAuditException.${exception.code}`,
                            exception.code,
                          )}
                        </TableCell>
                        <TableCell>
                          <ChipLabel
                            group="nightAuditSeverity"
                            value={exception.severity}
                          />
                        </TableCell>
                        <TableCell>
                          <ChipLabel
                            group="nightAuditExceptionState"
                            value={exception.state}
                          />
                        </TableCell>
                        <TableCell>
                          {exception.subject_type}:
                          {shortId(exception.subject_id)}
                        </TableCell>
                        <TableCell
                          sx={{ maxWidth: 260, wordBreak: 'break-word' }}
                        >
                          {exception.message}
                        </TableCell>
                        <TableCell>{exception.owner_label ?? '-'}</TableCell>
                        <TableCell
                          sx={{ maxWidth: 220, wordBreak: 'break-word' }}
                        >
                          {exception.resolution_reason ?? '-'}
                        </TableCell>
                        {canClose ? (
                          <TableCell>
                            {exception.state === 'OPEN' ? (
                              <Button
                                size="small"
                                onClick={() => setAckTarget(exception)}
                              >
                                {t('nightAuditAcknowledge')}
                              </Button>
                            ) : null}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>

          <Paper sx={{ p: 2 }}>
            <Typography variant="h3" component="h3" gutterBottom>
              {t('nightAuditRunLog')}
            </Typography>
            {data.events.length === 0 ? (
              <EmptyBlock message={t('nightAuditNoEvents')} />
            ) : (
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('nightAuditWhen')}</TableCell>
                      <TableCell>{t('nightAuditLevel')}</TableCell>
                      <TableCell>{t('nightAuditEvent')}</TableCell>
                      <TableCell>{t('nightAuditStep')}</TableCell>
                      <TableCell>{t('nightAuditMessage')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.events.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell>{formatTime(event.created_at)}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={
                              event.level === 'ERROR'
                                ? 'error'
                                : event.level === 'WARN'
                                  ? 'warning'
                                  : 'info'
                            }
                            label={event.level}
                          />
                        </TableCell>
                        <TableCell>{event.event}</TableCell>
                        <TableCell>
                          {event.step_key
                            ? t(
                                `nightAuditStepName.${event.step_key}`,
                                event.step_key,
                              )
                            : '-'}
                        </TableCell>
                        <TableCell
                          sx={{ maxWidth: 320, wordBreak: 'break-word' }}
                        >
                          {event.message ?? '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </>
      )}

      <Dialog
        open={Boolean(ackTarget)}
        onClose={() => setAckTarget(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('nightAuditAcknowledgeTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {ackTarget ? (
              <Alert severity="info">
                {t(`nightAuditException.${ackTarget.code}`, ackTarget.code)} —{' '}
                {ackTarget.message}
              </Alert>
            ) : null}
            <TextField
              label={t('nightAuditOwner')}
              value={ownerLabel}
              onChange={(event) => setOwnerLabel(event.target.value)}
              placeholder={t('nightAuditOwnerPlaceholder')}
              required
              inputProps={{ maxLength: 200 }}
            />
            <TextField
              label={t('nightAuditReason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t('nightAuditReasonPlaceholder')}
              required
              multiline
              minRows={2}
              inputProps={{ maxLength: 500 }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAckTarget(null)}>
            {t('nightAuditCancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void acknowledge()}
            disabled={
              action.busy || ownerLabel.trim() === '' || reason.trim() === ''
            }
          >
            {t('nightAuditConfirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
