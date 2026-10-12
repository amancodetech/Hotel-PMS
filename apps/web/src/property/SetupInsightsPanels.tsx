import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
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
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { propertyApi } from '../api/property.js';
import type {
  Composition,
  CompositionChangeImpact,
  Resource,
  SetupChangeEvent,
} from '../api/property.js';
import { ErrorAlert, useApiAction } from '../identity/shared.js';
import { EmptyBlock, LoadingBlock } from '../identity/TenantSelectPage.js';

function addDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function checkLabel(code: string): string {
  if (code === 'WINDOW_OVERLAP') return 'setupInsights.checkWindowOverlap';
  if (code === 'SHARED_RESOURCE') return 'setupInsights.checkSharedResource';
  return 'setupInsights.checkCommitmentCoverage';
}

function checkStatusKey(status: string): string {
  if (status === 'PASS') return 'setupInsights.checkPass';
  if (status === 'FAIL') return 'setupInsights.checkFail';
  return 'setupInsights.checkWarn';
}

function checkColor(status: string): 'success' | 'warning' | 'error' {
  if (status === 'PASS') return 'success';
  if (status === 'FAIL') return 'error';
  return 'warning';
}

export function SettingsOverviewPanel({
  tenantId,
  propertyId,
}: {
  tenantId: string;
  propertyId: string;
}) {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ['setup-settings', tenantId, propertyId],
    queryFn: () => propertyApi.getSetupSettings(tenantId, propertyId),
  });
  const reconciliation = useQuery({
    queryKey: ['setup-reconciliation', tenantId, propertyId],
    queryFn: () => propertyApi.getSetupReconciliation(tenantId, propertyId),
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const [events, setEvents] = useState<SetupChangeEvent[]>([]);
  const log = useQuery({
    queryKey: ['setup-changes', tenantId, propertyId, cursor],
    queryFn: () => propertyApi.listSetupChanges(tenantId, propertyId, cursor),
  });
  useEffect(() => {
    if (!log.data) return;
    setEvents((previous) =>
      cursor === null ? log.data.items : [...previous, ...log.data.items],
    );
  }, [cursor, log.data]);

  if (settings.isLoading) return <LoadingBlock />;
  if (settings.error || !settings.data)
    return <ErrorAlert error={settings.error} />;
  const data = settings.data;
  return (
    <div>
      <Typography variant="h6">{t('setupInsights.overview')}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t('setupInsights.description')}
      </Typography>
      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Chip
          color={data.setup.draft_completed ? 'success' : 'default'}
          label={`${t('setupInsights.stateLabel')}: ${
            data.setup.draft_present
              ? data.setup.draft_completed
                ? t('setupInsights.draftCompleted')
                : t('setupInsights.draftPresent', {
                    revision: data.setup.draft_revision,
                  })
              : t('setupInsights.noDraft')
          }`}
        />
        <Chip
          label={`${t('setupInsights.locations')}: ${data.counts.locations}`}
        />
        <Chip
          label={`${t('setupInsights.resources')}: ${data.counts.resources}`}
        />
        <Chip
          label={`${t('setupInsights.products')}: ${data.counts.products}`}
        />
        <Chip
          label={`${t('setupInsights.compositions')}: ${data.counts.compositions_active}`}
        />
      </div>

      {reconciliation.data ? (
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Typography variant="subtitle2" sx={{ width: '100%' }}>
            {t('setupInsights.reconciliationTitle')}
          </Typography>
          {reconciliation.data.checks.map((check) => (
            <Chip
              key={check.code}
              color={checkColor(check.status)}
              variant="outlined"
              label={`${t(checkLabel(check.code))}: ${t(
                checkStatusKey(check.status),
              )}`}
            />
          ))}
        </div>
      ) : null}

      <Typography variant="subtitle1" sx={{ mt: 2 }}>
        {t('setupInsights.scheduledTitle')}
      </Typography>
      {data.scheduled_changes.length === 0 ? (
        <EmptyBlock message={t('setupInsights.scheduledEmpty')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('productCode')}</TableCell>
                <TableCell>{t('versionNumber')}</TableCell>
                <TableCell>{t('setupInsights.effectiveFrom')}</TableCell>
                <TableCell>{t('setupInsights.effectiveTo')}</TableCell>
                <TableCell>{t('status')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.scheduled_changes.map((row) => (
                <TableRow key={row.composition_id}>
                  <TableCell>{row.product_code}</TableCell>
                  <TableCell>{row.version_number}</TableCell>
                  <TableCell>{row.effective_from}</TableCell>
                  <TableCell>{row.effective_to}</TableCell>
                  <TableCell>
                    <ChipForValue
                      prefix="compositionStatus"
                      value={row.status}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Typography variant="subtitle1" sx={{ mt: 2 }}>
        {t('setupInsights.changeLogTitle')}
      </Typography>
      <ErrorAlert error={log.error} />
      {events.length === 0 ? (
        <EmptyBlock message={t('setupInsights.changeLogEmpty')} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('setupInsights.when')}</TableCell>
                <TableCell>{t('setupInsights.action')}</TableCell>
                <TableCell>{t('setupInsights.actor')}</TableCell>
                <TableCell>{t('setupInsights.outcome')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {new Date(row.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{row.action}</TableCell>
                  <TableCell>{row.actor_label ?? row.actor_type}</TableCell>
                  <TableCell>{row.outcome}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {log.data?.next_cursor ? (
        <Button
          variant="outlined"
          size="small"
          disabled={log.isFetching}
          onClick={() => setCursor(log.data?.next_cursor ?? null)}
        >
          {t('setupInsights.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function ChipForValue({ prefix, value }: { prefix: string; value: string }) {
  const { t } = useTranslation();
  return <Chip size="small" label={t(`${prefix}.${value}`)} />;
}

export function CompositionChangeDialog({
  tenantId,
  propertyId,
  composition,
  resources,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  composition: Composition;
  resources: Resource[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { run, error, busy } = useApiAction();
  const [effectiveFrom, setEffectiveFrom] = useState(addDays(1));
  const [effectiveTo, setEffectiveTo] = useState(
    composition.effective_to ?? '',
  );
  const [leafIds, setLeafIds] = useState<string[]>([]);
  const [impact, setImpact] = useState<CompositionChangeImpact | null>(null);
  const detail = useQuery({
    queryKey: ['composition', tenantId, propertyId, composition.id],
    queryFn: () =>
      propertyApi.getComposition(tenantId, propertyId, composition.id),
  });
  useEffect(() => {
    if (!detail.data) return;
    setLeafIds(detail.data.leaves.map((leaf) => leaf.resource_id));
  }, [detail.data]);

  const body = {
    effective_from: effectiveFrom,
    effective_to: effectiveTo === '' ? null : effectiveTo,
    resource_ids: leafIds,
  };
  const toggle = (resourceId: string) => {
    setLeafIds((previous) =>
      previous.includes(resourceId)
        ? previous.filter((value) => value !== resourceId)
        : [...previous, resourceId],
    );
    setImpact(null);
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{t('setupInsights.changeTitle')}</DialogTitle>
      <DialogContent>
        <ErrorAlert error={error} />
        {detail.isLoading ? <LoadingBlock /> : null}
        <div className="row-actions" style={{ gap: 12 }}>
          <TextField
            label={t('setupInsights.effectiveFrom')}
            type="date"
            value={effectiveFrom}
            onChange={(event) => {
              setEffectiveFrom(event.target.value);
              setImpact(null);
            }}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label={t('setupInsights.effectiveTo')}
            type="date"
            value={effectiveTo}
            onChange={(event) => {
              setEffectiveTo(event.target.value);
              setImpact(null);
            }}
            InputLabelProps={{ shrink: true }}
          />
        </div>
        <Typography variant="subtitle2" sx={{ mt: 2 }}>
          {t('setupInsights.leaves')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('setupInsights.leavesHint')}
        </Typography>
        <div style={{ maxHeight: 220, overflow: 'auto' }}>
          {resources
            .filter((resource) => resource.state !== 'RETIRED')
            .map((resource) => (
              <FormControlLabel
                key={resource.id}
                control={
                  <Checkbox
                    checked={leafIds.includes(resource.id)}
                    onChange={() => toggle(resource.id)}
                  />
                }
                label={`${resource.code} (${resource.type})`}
              />
            ))}
        </div>
        {impact ? (
          <div>
            <Chip
              color={impact.verdict === 'SAFE' ? 'success' : 'error'}
              label={`${t('setupInsights.verdict')}: ${
                impact.verdict === 'SAFE'
                  ? t('setupInsights.verdictSafe')
                  : t('setupInsights.verdictBlocked')
              }`}
            />
            <Typography variant="subtitle2" sx={{ mt: 1 }}>
              {t('setupInsights.conflicts')}
            </Typography>
            {impact.conflicts.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t('setupInsights.noImpact')}
              </Typography>
            ) : (
              <ul>
                {impact.conflicts.map((row) => (
                  <li key={row.commitment_id}>
                    {row.resource_code} · {row.source_kind} · {row.start_date} →{' '}
                    {row.end_date}
                  </li>
                ))}
              </ul>
            )}
            {impact.removed_leaves.length > 0 ? (
              <Typography variant="body2">
                {t('setupInsights.removed')}:{' '}
                {impact.removed_leaves.map((row) => row.code).join(', ')}
              </Typography>
            ) : null}
            {impact.retained_commitments.length > 0 ? (
              <Typography variant="body2">
                {t('setupInsights.retained')}:{' '}
                {impact.retained_commitments
                  .map((row) => row.resource_code)
                  .join(', ')}
              </Typography>
            ) : null}
            {impact.intersecting_blocks.length > 0 ? (
              <Typography variant="body2">
                {t('setupInsights.blocks')}:{' '}
                {impact.intersecting_blocks
                  .map((row) => row.resource_code)
                  .join(', ')}
              </Typography>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          disabled={busy || leafIds.length === 0}
          onClick={() =>
            void run(async () => {
              const result = await propertyApi.previewCompositionChange(
                tenantId,
                propertyId,
                composition.id,
                body,
              );
              setImpact(result);
            })
          }
        >
          {t('setupInsights.preview')}
        </Button>
        <Button
          variant="contained"
          disabled={
            busy || !impact || impact.verdict !== 'SAFE' || leafIds.length === 0
          }
          onClick={() =>
            void run(async () => {
              await propertyApi.applyCompositionChange(
                tenantId,
                propertyId,
                composition.id,
                {
                  ...body,
                  preview_fingerprint: impact?.fingerprint,
                },
              );
              onClose();
            })
          }
        >
          {t('setupInsights.apply')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
