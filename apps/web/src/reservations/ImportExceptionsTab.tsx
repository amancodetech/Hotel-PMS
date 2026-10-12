import { useState } from 'react';
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
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';
import { ErrorAlert, PageHeader, useApiAction } from '../identity/shared.js';
import { reservationsApi } from '../api/reservations.js';
import type { ChannelException, ImportResult } from '../api/reservations.js';

const modes = ['DRY_RUN', 'APPLY'] as const;
const sources = ['UPLOAD', 'FEED'] as const;

function ReprocessDialog({
  tenantId,
  propertyId,
  row,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  row: ChannelException;
  onClose: () => void;
}) {
  const { run, error, busy, t } = useApiAction();
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('reprocessAction')}</DialogTitle>
      <DialogContent className="dialog-form">
        <Typography variant="body2">{t('confirmReprocess')}</Typography>
        <Typography variant="caption" color="text.secondary">
          {t('exceptionRevision')}: {row.inbox_revision_id ?? '-'}
        </Typography>
        <ErrorAlert error={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={busy || !row.inbox_revision_id}
          onClick={() =>
            void run(async () => {
              await reservationsApi.reprocessChannelEvent(
                tenantId,
                propertyId,
                row.inbox_revision_id!,
              );
              onClose();
            })
          }
        >
          {t('reprocessAction')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ImportExceptionsTab({
  tenantId,
  propertyId,
  canImport,
  canReprocess,
}: {
  tenantId: string;
  propertyId: string;
  canImport: boolean;
  canReprocess: boolean;
}) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const [mode, setMode] = useState<(typeof modes)[number]>('DRY_RUN');
  const [source, setSource] = useState<(typeof sources)[number]>('UPLOAD');
  const [fileName, setFileName] = useState('');
  const [contentType, setContentType] = useState('text/csv');
  const [content, setContent] = useState('');
  const [externalId, setExternalId] = useState('');
  const [report, setReport] = useState<ImportResult | null>(null);
  const [reprocessRow, setReprocessRow] = useState<ChannelException | null>(
    null,
  );

  const exceptions = useQuery({
    queryKey: ['channel-exceptions', tenantId, propertyId],
    enabled: canReprocess,
    queryFn: () => reservationsApi.listChannelExceptions(tenantId, propertyId),
  });

  const valid = fileName.trim().length > 0 && content.length > 0;

  return (
    <>
      {canImport ? (
        <section>
          <PageHeader title={t('importTitle')} />
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('importMode')}
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as (typeof modes)[number])
            }
          >
            {modes.map((value) => (
              <MenuItem key={value} value={value}>
                {t(
                  value === 'DRY_RUN' ? 'importModeDryRun' : 'importModeApply',
                )}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            margin="dense"
            label={t('importSource')}
            value={source}
            onChange={(event) =>
              setSource(event.target.value as (typeof sources)[number])
            }
          >
            {sources.map((value) => (
              <MenuItem key={value} value={value}>
                {t(
                  value === 'UPLOAD'
                    ? 'importSourceUpload'
                    : 'importSourceFeed',
                )}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            margin="dense"
            label={t('fileName')}
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('contentType')}
            value={contentType}
            onChange={(event) => setContentType(event.target.value)}
          />
          <TextField
            fullWidth
            margin="dense"
            label={t('importExternalId')}
            value={externalId}
            onChange={(event) => setExternalId(event.target.value)}
          />
          <TextField
            fullWidth
            multiline
            minRows={4}
            margin="dense"
            label={t('csvContent')}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <Typography variant="caption" color="text.secondary">
            {t('importNoContentNotice')}
          </Typography>
          <ErrorAlert error={error} />
          <Button
            variant="contained"
            sx={{ mt: 1 }}
            disabled={busy || !valid}
            onClick={() =>
              void run(async () => {
                const result = await reservationsApi.importReservations(
                  tenantId,
                  propertyId,
                  {
                    mode,
                    source,
                    file_name: fileName.trim(),
                    content_type: contentType.trim(),
                    content,
                    external_id: externalId.trim() || null,
                  },
                );
                setReport(result);
                setContent('');
              })
            }
          >
            {t('runImport')}
          </Button>
          {report ? (
            <>
              <Typography variant="h3" component="h3" sx={{ mt: 2 }}>
                {t('importReport')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('importSummary')}: {report.rows_total} ·{' '}
                {t('importStatus.ACCEPTED')}: {report.rows_accepted} ·{' '}
                {t('importStatus.REJECTED')}: {report.rows_rejected} ·{' '}
                {t('importStatus.DUPLICATE')}: {report.rows_duplicate}
              </Typography>
              {report.replayed ? (
                <Chip
                  size="small"
                  color="info"
                  label={t('importReplayed')}
                  sx={{ mt: 1 }}
                />
              ) : null}
              <TableContainer
                component={Paper}
                variant="outlined"
                sx={{ mt: 1 }}
              >
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('importLine')}</TableCell>
                      <TableCell>{t('importExternalKey')}</TableCell>
                      <TableCell>{t('status')}</TableCell>
                      <TableCell>{t('importErrorCode')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {report.rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4}>
                          <EmptyBlock message={t('noImportRows')} />
                        </TableCell>
                      </TableRow>
                    ) : (
                      report.rows.map((row) => (
                        <TableRow key={row.line_no}>
                          <TableCell>{row.line_no}</TableCell>
                          <TableCell>{row.external_key ?? '-'}</TableCell>
                          <TableCell>
                            {t(`importStatus.${row.status}`)}
                          </TableCell>
                          <TableCell>{row.error_code ?? '-'}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          ) : null}
        </section>
      ) : null}
      {canReprocess ? (
        <section>
          <PageHeader
            title={t('exceptionsTitle')}
            action={
              <Button
                size="small"
                onClick={() => void exceptions.refetch()}
                disabled={exceptions.isFetching}
              >
                {t('refreshList')}
              </Button>
            }
          />
          <ErrorAlert error={exceptions.error} />
          {exceptions.isLoading ? (
            <LoadingBlock />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('exceptionType')}</TableCell>
                    <TableCell>{t('status')}</TableCell>
                    <TableCell>{t('exceptionRevision')}</TableCell>
                    <TableCell>{t('exceptionErrorCode')}</TableCell>
                    <TableCell>{t('exceptionCreatedAt')}</TableCell>
                    <TableCell>{t('exceptionOwner')}</TableCell>
                    <TableCell>{t('actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(exceptions.data?.items ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <EmptyBlock message={t('exceptionsEmpty')} />
                      </TableCell>
                    </TableRow>
                  ) : (
                    exceptions.data!.items.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.type}</TableCell>
                        <TableCell>
                          {t(`exceptionState.${row.state}`)}
                        </TableCell>
                        <TableCell>{row.inbox_revision_id ?? '-'}</TableCell>
                        <TableCell>
                          {String(row.details_safe['error_code'] ?? '-')}
                        </TableCell>
                        <TableCell>{row.created_at.slice(0, 16)}</TableCell>
                        <TableCell>{row.owner ?? '-'}</TableCell>
                        <TableCell>
                          {row.state === 'OPEN' && row.inbox_revision_id ? (
                            <Button
                              size="small"
                              onClick={() => setReprocessRow(row)}
                            >
                              {t('reprocessAction')}
                            </Button>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </section>
      ) : null}
      {reprocessRow ? (
        <ReprocessDialog
          tenantId={tenantId}
          propertyId={propertyId}
          row={reprocessRow}
          onClose={() => setReprocessRow(null)}
        />
      ) : null}
    </>
  );
}
