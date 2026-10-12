import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { propertyApi } from '../api/property.js';
import { ErrorAlert, useApiAction } from '../identity/shared.js';
import { LoadingBlock } from '../identity/TenantSelectPage.js';

/** Mounted only for the selected entity. Parent panels are keyed by scope. */
export function ArchiveEntityDialog({
  tenantId,
  propertyId,
  kind,
  id,
  name,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  kind: 'LOCATION' | 'RESOURCE';
  id: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const preview = useQuery({
    queryKey: ['archive-impact', tenantId, propertyId, kind, id],
    queryFn: () =>
      kind === 'LOCATION'
        ? propertyApi.previewLocationArchive(tenantId, propertyId, id)
        : propertyApi.previewResourceArchive(tenantId, propertyId, id),
    staleTime: 0,
  });
  const impact = preview.data;
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <DialogTitle>{t('psrSetup.archive.title', { name })}</DialogTitle>
      <DialogContent>
        <Typography>{t('psrSetup.archive.description')}</Typography>
        <ErrorAlert error={error ?? preview.error} />
        {preview.isPending ? <LoadingBlock /> : null}
        {impact && !preview.isError ? (
          <>
            <Alert
              severity={impact.eligible ? 'info' : 'warning'}
              sx={{ my: 2 }}
            >
              {t(
                impact.eligible
                  ? 'psrSetup.archive.allowed'
                  : 'psrSetup.archive.blocked',
              )}
              {impact.blockers.map((blocker) => (
                <Typography key={blocker}>
                  {t(`psrSetup.archive.blockers.${blocker}`)}
                </Typography>
              ))}
            </Alert>
            <TableContainer>
              <Table
                size="small"
                aria-label={t('psrSetup.archive.title', { name })}
              >
                <TableBody>
                  {Object.entries(impact.counts)
                    .filter(
                      ([key]) =>
                        kind === 'RESOURCE' ||
                        ['children', 'resources'].includes(key),
                    )
                    .map(([key, count]) => (
                      <TableRow key={key}>
                        <TableCell component="th" scope="row">
                          {t(`psrSetup.archive.counts.${key}`)}
                        </TableCell>
                        <TableCell>{count}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          disabled={busy || preview.isFetching}
          onClick={() => void preview.refetch()}
        >
          {t('psrSetup.archive.refresh')}
        </Button>
        <Button
          color="warning"
          variant="contained"
          disabled={
            busy || preview.isFetching || preview.isError || !impact?.eligible
          }
          onClick={async () => {
            if (!impact) return;
            const result = await run(async () =>
              kind === 'LOCATION'
                ? propertyApi.updateLocation(tenantId, propertyId, id, {
                    version: impact.version,
                    status: 'INACTIVE',
                  })
                : propertyApi.updateResource(tenantId, propertyId, id, {
                    version: impact.version,
                    state: 'RETIRED',
                  }),
            );
            if (result) onClose();
            else await preview.refetch();
          }}
        >
          {t('psrSetup.archive.confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
