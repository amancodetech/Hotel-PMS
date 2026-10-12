import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  Link as RouterLink,
  useParams,
  useBlocker,
  useSearchParams,
} from 'react-router';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider.js';
import { ErrorAlert, ForbiddenPanel } from '../identity/shared.js';
import { LoadingBlock } from '../identity/TenantSelectPage.js';
import { type SetupDraftInputV2 } from '../api/setup.js';
import { ApiError } from '../api/client.js';
import { propertyApi } from '../api/property.js';
import { SetupProductSimulation } from './SetupProductSimulation.js';
import { LocationBrowser } from './LocationBrowser.js';
import { mergeLocationPath, locationLabel } from './structure-locations.js';
import { useStructureSetup } from './useStructureSetup.js';

type Group = SetupDraftInputV2['unit_groups'][number];
const templates: Group['physical_template'][] = [
  'ROOM',
  'VILLA',
  'APARTMENT',
  'HOUSE',
  'CABIN',
  'TENT',
  'SITE',
  'DORM',
  'SUITE_STANDALONE',
  'SUITE_CONNECTED',
];
const steps = ['property', 'units', 'booking', 'review'] as const;
const id = () => crypto.randomUUID();
const number = (value: string) => (value === '' ? null : Number(value));
const modes = (g: Group): NonNullable<Group['booking_mode']>[] =>
  g.physical_template === 'DORM'
    ? ['BEDS_ONLY', 'BEDS_AND_PRIVATE']
    : g.physical_template === 'SUITE_CONNECTED'
      ? ['CONNECTED_UNITS']
      : ['VILLA', 'APARTMENT', 'HOUSE'].includes(g.physical_template)
        ? ['WHOLE_ONLY', 'PARTS_ONLY', 'WHOLE_AND_PARTS']
        : ['WHOLE_ONLY'];

export function PropertyStructureSetupPage() {
  const { propertyId } = useParams();
  const [params] = useSearchParams();
  const addition = params.get('addition') === '1';
  const { activeTenantId, hasPermission, session } = useAuth();
  if (!activeTenantId || !propertyId) return <LoadingBlock />;
  if (!hasPermission('property.read')) return <ForbiddenPanel />;
  return (
    <StructureEditor
      key={`${session.session?.id}:${activeTenantId}:${propertyId}:${addition}`}
      addition={addition}
      tenantId={activeTenantId}
      propertyId={propertyId}
    />
  );
}
export function StructureEditor({
  tenantId,
  propertyId,
  addition = false,
}: {
  tenantId: string;
  propertyId: string;
  addition?: boolean;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`psrSetup.${key}`);
  const auth = useAuth();
  const model = useStructureSetup(
    tenantId,
    propertyId,
    auth.session.session?.id,
    addition,
  );
  const navigation = useBlocker(model.dirty || model.uncertain || model.busy);
  useEffect(() => {
    const guard = (event: Event) => {
      if (
        model.busy ||
        ((model.dirty || model.uncertain) &&
          !window.confirm(
            t(
              model.uncertain ? 'psrSetup.leavePending' : 'psrSetup.leaveDirty',
            ),
          ))
      )
        event.preventDefault();
    };
    window.addEventListener('hotel:before-context-change', guard);
    return () =>
      window.removeEventListener('hotel:before-context-change', guard);
  }, [model.busy, model.dirty, model.uncertain, t]);
  const [step, setStep] = useState(0);
  const [confirmation, setConfirmation] = useState<(() => void) | null>(null);
  const [confirmationDetails, setConfirmationDetails] = useState<string[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const input = model.input;
  const connected =
    input?.unit_groups.some((g) => g.booking_mode === 'CONNECTED_UNITS') ??
    false;
  const resources = useInfiniteQuery({
    queryKey: ['structure-resources', tenantId, propertyId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      propertyApi.listResourcePage(tenantId, propertyId, pageParam),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: connected,
  });
  if (model.loading) return <LoadingBlock />;
  if (model.legacy)
    return (
      <Stack spacing={2}>
        <Alert severity="info">{label('legacy')}</Alert>
        <Button
          component={RouterLink}
          to={`/setup-preview?propertyId=${propertyId}`}
        >
          {label('legacyLink')}
        </Button>
      </Stack>
    );
  if (!input)
    return (
      <Stack>
        <ErrorAlert error={model.error} />
        <Button onClick={model.reload}>{label('reload')}</Button>
      </Stack>
    );
  const readOnly =
    Boolean(model.batch) ||
    model.stored?.completed ||
    Boolean(model.result) ||
    (addition
      ? !['SETUP', 'ACTIVE'].includes(model.status)
      : model.status !== 'SETUP') ||
    !auth.hasPermission(
      addition ? 'property.resource.manage' : 'property.manage',
    );
  const disabled = Boolean(readOnly || model.busy || model.uncertain);
  const serverIssues =
    model.error instanceof ApiError && Array.isArray(model.error.details.issues)
      ? model.error.details.issues.filter(
          (v): v is { field_path: string } =>
            typeof v === 'object' &&
            v !== null &&
            typeof v.field_path === 'string',
        )
      : [];
  const issuePaths = [
    ...serverIssues.map((v) => v.field_path),
    ...(model.preview?.blockers
      .map((v) => v.field)
      .filter((v): v is string => Boolean(v)) ?? []),
  ];
  function fieldLabel(path?: string) {
    const field = path?.split('.').at(-1) ?? '';
    const keys: Record<string, string> = {
      capacity: 'psrPreview.capacity',
      units: 'psrPreview.units',
      pattern: 'psrSetup.range',
      name: 'psrPreview.name',
      booking_mode: 'psrPreview.booking',
      selection_mode: 'psrSetup.selection',
      parts: 'psrSetup.addPart',
      beds_per_unit: 'psrSetup.bedCount',
      connected_resource_ids: 'psrSetup.connected',
      effective_from: 'psrSetup.effective_from',
      effective_to: 'psrSetup.effective_to',
      privacy_ack: 'psrSetup.privacy',
      connection_ack: 'psrSetup.connectionAck',
      code: 'psrSetup.code',
    };
    return keys[field] ? t(keys[field]) : label('incomplete');
  }
  function validation(path: string) {
    const error = issuePaths.some(
      (v) => v === path || v.startsWith(path + '.'),
    );
    return { error, ...(error ? { helperText: label('incomplete') } : {}) };
  }

  function change(patch: Partial<SetupDraftInputV2>) {
    model.change({ ...input!, ...patch });
  }
  function updateGroup(index: number, patch: Partial<Group>) {
    change({
      unit_groups: input!.unit_groups.map((g, i) =>
        i === index ? { ...g, ...patch } : g,
      ),
    });
  }
  function changeMode(
    index: number,
    mode: Group['booking_mode'],
    template?: Group['physical_template'],
  ) {
    const g = input!.unit_groups[index]!;
    const perform = () => {
      const {
        parts: _parts,
        beds: _beds,
        beds_per_unit: _count,
        sharing_scope: _scope,
        connected_resource_ids: _ids,
        connection_ack: _ack,
        privacy_ack: _privacy,
        ...kept
      } = g;
      void [_parts, _beds, _count, _scope, _ids, _ack, _privacy];
      const next: Group = {
        ...kept,
        physical_template: template ?? g.physical_template,
        booking_mode: mode,
        selection_mode: mode?.startsWith('BEDS') ? 'CATEGORY' : 'EXACT',
      };
      if (mode?.startsWith('BEDS')) next.sharing_scope = 'MIXED';
      if (mode === 'CONNECTED_UNITS') {
        delete next.units;
        delete next.pattern;
        delete next.exclusions;
      }
      change({
        unit_groups: input!.unit_groups.map((item, i) =>
          i === index ? next : item,
        ),
      });
    };
    if (
      g.parts?.length ||
      g.beds?.length ||
      g.beds_per_unit ||
      g.connected_resource_ids?.length ||
      (mode === 'CONNECTED_UNITS' && (g.units?.length || g.pattern))
    ) {
      setConfirmationDetails([
        ...(g.parts ?? []).map(
          (p) => `${label('addPart')}: ${p.display_label || p.code}`,
        ),
        ...(g.beds ?? []).map(
          (b) => `${label('bedCount')}: ${b.display_label || b.code}`,
        ),
        ...(g.beds_per_unit
          ? [`${label('bedCount')}: ${g.beds_per_unit}`]
          : []),
        ...(g.connected_resource_ids?.length
          ? [`${label('connected')}: ${g.connected_resource_ids.length}`]
          : []),
        ...(mode === 'CONNECTED_UNITS'
          ? [
              g.pattern ?? '',
              ...(g.units ?? []).map((u) => u.display_label || u.code),
            ].filter(Boolean)
          : []),
      ]);
      setConfirmation(() => perform);
    } else perform();
  }
  function closeConfirmation() {
    setConfirmation(null);
    setConfirmationDetails([]);
  }
  const go = (next: number) => {
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const canApply =
    auth.hasPermission('property.resource.manage') &&
    (addition || auth.hasPermission('property.manage')) &&
    (!input.unit_groups.some((g) =>
      ['WHOLE_AND_PARTS', 'BEDS_AND_PRIVATE', 'CONNECTED_UNITS'].includes(
        g.booking_mode ?? '',
      ),
    ) ||
      auth.hasPermission('composition.manage')) &&
    (addition ||
      input.pricing?.postponed !== false ||
      auth.hasPermission('rate.manage')) &&
    (addition ||
      typeof input.operations.inspection_required !== 'boolean' ||
      auth.hasPermission('task.manage'));
  return (
    <Stack
      spacing={3}
      sx={{
        maxWidth: 1040,
        mx: 'auto',
        '& .MuiButton-root': { minHeight: 44 },
        '& input': { fontSize: 16 },
      }}
    >
      <Typography component="h1" variant="h4">
        {label(addition ? 'additionTitle' : 'title')}
      </Typography>
      <Alert severity="info">
        {label(addition ? 'additionNotice' : 'notice')}
      </Alert>
      <ErrorAlert error={model.error} />
      {serverIssues.length > 0 && (
        <Alert severity="warning">
          {serverIssues.map((issue, index) => (
            <Typography key={index}>{fieldLabel(issue.field_path)}</Typography>
          ))}
        </Alert>
      )}
      {model.uncertain && (
        <Alert
          severity="warning"
          action={
            <Button onClick={model.retry} disabled={model.busy}>
              {label('retry')}
            </Button>
          }
        >
          {label('uncertain')}
        </Alert>
      )}
      {model.batch && (
        <Alert severity={model.batch.completed ? 'success' : 'info'}>
          <Typography role="status" aria-live="polite">
            {t('psrSetup.batchProgress', {
              done: model.batch.created_units,
              total: model.batch.total_units,
              step: model.batch.completed_batches,
              count: model.batch.total_batches,
            })}
          </Typography>
          {!model.batch.completed && (
            <>
              <Typography>{label('batchNotice')}</Typography>
              {model.batch.blockers.map((b, i) => (
                <Typography key={i}>
                  {t(`errors.${b.code}`, { defaultValue: label('incomplete') })}
                </Typography>
              ))}
              <Button
                onClick={model.runBatch}
                disabled={model.busy || model.uncertain}
              >
                {label('batchResume')}
              </Button>
            </>
          )}
        </Alert>
      )}
      {readOnly && !model.batch && (
        <Alert severity="info">
          {label(
            addition && model.result
              ? 'additionCompleted'
              : model.stored?.completed
                ? 'completed'
                : 'readOnly',
          )}
        </Alert>
      )}
      {model.result && (
        <Alert severity="success">
          {t('psrSetup.created', {
            units: model.result.created_units,
            products: model.result.created_products,
          })}
          {model.result.follow_up_tasks?.length > 0 && (
            <Typography>{t('setupWizard.apply.followUp')}</Typography>
          )}
        </Alert>
      )}
      {(model.stored?.completed || model.result) && (
        <SetupProductSimulation
          key={`${tenantId}:${propertyId}`}
          tenantId={tenantId}
          propertyId={propertyId}
        />
      )}
      <Stepper
        activeStep={step}
        alternativeLabel
        sx={{ display: { xs: 'none', sm: 'flex' } }}
      >
        {steps.map((s) => (
          <Step key={s}>
            <StepLabel>
              {addition && s === 'review'
                ? label('additionReview')
                : t(`psrPreview.${s}`)}
            </StepLabel>
          </Step>
        ))}
      </Stepper>
      <Typography component="h2" variant="h5" tabIndex={-1} ref={heading}>
        {step + 1}.{' '}
        {addition && step === 3
          ? label('additionReview')
          : t(`psrPreview.${steps[step]}`)}
      </Typography>
      <Box
        component="fieldset"
        inert={disabled}
        disabled={disabled}
        sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
      >
        {step === 0 && (
          <Stack spacing={2}>
            <TextField
              required
              label={t('psrPreview.name')}
              {...validation('property.name')}
              disabled={addition}
              value={input.property.name ?? ''}
              onChange={(e) =>
                change({
                  property: { ...input.property, name: e.target.value },
                })
              }
              inputProps={{ maxLength: 120 }}
            />
            <TextField
              select
              label={t('timezone')}
              {...validation('property.timezone')}
              disabled={addition}
              value={input.property.timezone ?? ''}
              onChange={(e) =>
                change({
                  property: {
                    ...input.property,
                    timezone: e.target
                      .value as SetupDraftInputV2['property']['timezone'],
                  },
                })
              }
            >
              {['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'].map((v) => (
                <MenuItem key={v} value={v}>
                  {v}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label={t('baseCurrency')}
              {...validation('property.base_currency')}
              disabled={addition}
              value={input.property.base_currency ?? ''}
              onChange={(e) =>
                change({
                  property: {
                    ...input.property,
                    base_currency: e.target.value as 'IDR' | 'USD',
                  },
                })
              }
            >
              {['IDR', 'USD'].map((v) => (
                <MenuItem key={v} value={v}>
                  {v}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="h6">{label('places')}</Typography>
            {!readOnly && (
              <LocationBrowser
                tenantId={tenantId}
                propertyId={propertyId}
                onSelect={(path) =>
                  change({
                    locations: mergeLocationPath(input.locations, path),
                  })
                }
              />
            )}
            {input.locations.map((l, i) => (
              <Paper variant="outlined" sx={{ p: 2 }} key={l.client_ref}>
                <Stack spacing={2}>
                  <TextField
                    label={label('placeName')}
                    {...validation(`locations.${i}.name`)}
                    value={l.name}
                    disabled={Boolean(l.existing_location_id)}
                    onChange={(e) =>
                      change({
                        locations: input.locations.map((x, j) =>
                          j === i ? { ...x, name: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <TextField
                    label={label('code')}
                    value={l.code}
                    disabled={Boolean(l.existing_location_id)}
                    onChange={(e) =>
                      change({
                        locations: input.locations.map((x, j) =>
                          j === i ? { ...x, code: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <TextField
                    select
                    label={label('placeType')}
                    value={l.kind ?? ''}
                    disabled={Boolean(l.existing_location_id)}
                    onChange={(e) =>
                      change({
                        locations: input.locations.map((x, j) =>
                          j === i
                            ? { ...x, kind: e.target.value as typeof l.kind }
                            : x,
                        ),
                      })
                    }
                  >
                    {[
                      'ZONE',
                      'BUILDING',
                      'WING',
                      'FLOOR',
                      'CLUSTER',
                      'SERVICE_AREA',
                    ].map((k) => (
                      <MenuItem key={k} value={k}>
                        {label(k)}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label={label('parent')}
                    value={l.parent_ref ?? ''}
                    disabled={Boolean(l.existing_location_id)}
                    onChange={(e) =>
                      change({
                        locations: input.locations.map((x, j) =>
                          j === i
                            ? { ...x, parent_ref: e.target.value || null }
                            : x,
                        ),
                      })
                    }
                  >
                    <MenuItem value="">{label('root')}</MenuItem>
                    {input.locations
                      .filter((x) => x.client_ref !== l.client_ref)
                      .map((x) => (
                        <MenuItem key={x.client_ref} value={x.client_ref}>
                          {locationLabel(input.locations, x.client_ref)}
                        </MenuItem>
                      ))}
                  </TextField>
                  {!l.existing_location_id && (
                    <Button
                      disabled={
                        input.locations.some(
                          (x) => x.parent_ref === l.client_ref,
                        ) ||
                        input.unit_groups.some(
                          (g) => g.location_ref === l.client_ref,
                        )
                      }
                      onClick={() =>
                        change({
                          locations: input.locations.filter(
                            (x) => x.client_ref !== l.client_ref,
                          ),
                        })
                      }
                    >
                      {t('psrPreview.remove')}
                    </Button>
                  )}
                </Stack>
              </Paper>
            ))}
            <Button
              variant="outlined"
              onClick={() =>
                change({
                  locations: [
                    ...input.locations,
                    {
                      client_ref: id(),
                      code: `L${input.locations.length + 1}`,
                      name: '',
                      kind: 'ZONE',
                      display_order: input.locations.length,
                    },
                  ],
                })
              }
            >
              {label('addPlace')}
            </Button>
          </Stack>
        )}
        {step === 1 && (
          <Stack spacing={2}>
            {input.unit_groups.map((g, i) => (
              <Paper variant="outlined" sx={{ p: 2 }} key={g.group_ref}>
                <Stack spacing={2}>
                  <Typography component="h3" variant="h6">
                    {t('psrPreview.group', { number: i + 1 })}
                  </Typography>
                  <TextField
                    select
                    label={t('psrPreview.type')}
                    value={g.physical_template}
                    onChange={(e) => {
                      const template = e.target
                        .value as Group['physical_template'];
                      changeMode(
                        i,
                        modes({ ...g, physical_template: template })[0],
                        template,
                      );
                    }}
                  >
                    {templates.map((v) => (
                      <MenuItem key={v} value={v}>
                        {label(v)}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label={t('psrPreview.location')}
                    value={g.location_ref ?? ''}
                    onChange={(e) =>
                      updateGroup(i, { location_ref: e.target.value || null })
                    }
                  >
                    <MenuItem value="">{label('root')}</MenuItem>
                    {input.locations.map((l) => (
                      <MenuItem key={l.client_ref} value={l.client_ref}>
                        {locationLabel(input.locations, l.client_ref)}
                      </MenuItem>
                    ))}
                  </TextField>
                  {g.physical_template !== 'SUITE_CONNECTED' && (
                    <>
                      <TextField
                        label={label('range')}
                        {...validation(`unit_groups.${i}.pattern`)}
                        value={g.pattern ?? ''}
                        disabled={Boolean(g.units?.length)}
                        helperText={
                          validation(`unit_groups.${i}.pattern`).helperText ??
                          label('rangeHelp')
                        }
                        onChange={(e) =>
                          updateGroup(i, {
                            pattern: e.target.value || undefined,
                            units: undefined,
                          })
                        }
                      />
                      {g.pattern && (
                        <TextField
                          label={label('exclude')}
                          value={(g.exclusions ?? []).join(',')}
                          onChange={(e) =>
                            updateGroup(i, {
                              exclusions: e.target.value
                                .split(',')
                                .map((x) => x.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      )}
                      {(g.units ?? []).map((u, j) => (
                        <Stack
                          key={u.unit_ref}
                          direction={{ xs: 'column', sm: 'row' }}
                          spacing={1}
                        >
                          <TextField
                            label={label('code')}
                            value={u.code}
                            onChange={(e) =>
                              updateGroup(i, {
                                units: g.units!.map((x, k) =>
                                  k === j ? { ...x, code: e.target.value } : x,
                                ),
                              })
                            }
                          />
                          <TextField
                            label={label('unitName')}
                            value={u.display_label}
                            onChange={(e) =>
                              updateGroup(i, {
                                units: g.units!.map((x, k) =>
                                  k === j
                                    ? { ...x, display_label: e.target.value }
                                    : x,
                                ),
                              })
                            }
                          />
                          <Button
                            onClick={() =>
                              updateGroup(i, {
                                units: g.units!.filter((_, k) => k !== j),
                              })
                            }
                          >
                            {t('psrPreview.remove')}
                          </Button>
                        </Stack>
                      ))}
                      <Button
                        disabled={Boolean(g.pattern)}
                        onClick={() =>
                          updateGroup(i, {
                            units: [
                              ...(g.units ?? []),
                              { unit_ref: id(), code: '', display_label: '' },
                            ],
                            pattern: undefined,
                            exclusions: undefined,
                          })
                        }
                      >
                        {label('addUnit')}
                      </Button>
                    </>
                  )}
                  <TextField
                    type="number"
                    label={t('psrPreview.capacity')}
                    {...validation(`unit_groups.${i}.capacity`)}
                    value={g.capacity ?? ''}
                    inputProps={{ min: 1, max: 100 }}
                    onChange={(e) =>
                      updateGroup(i, { capacity: number(e.target.value) })
                    }
                  />
                  <TextField
                    type="number"
                    label={t('psrPreview.bedrooms')}
                    helperText={t('psrPreview.bedroomHelp')}
                    value={g.details?.bedrooms_count ?? ''}
                    inputProps={{ min: 0, max: 100 }}
                    onChange={(e) =>
                      updateGroup(i, {
                        details: {
                          ...g.details,
                          bedrooms_count:
                            e.target.value === ''
                              ? undefined
                              : Number(e.target.value),
                        },
                      })
                    }
                  />
                  <Button
                    onClick={() =>
                      setConfirmation(
                        () => () =>
                          change({
                            unit_groups: input.unit_groups.filter(
                              (_, j) => j !== i,
                            ),
                          }),
                      )
                    }
                  >
                    {label('removeGroup')}
                  </Button>
                </Stack>
              </Paper>
            ))}
            <Button
              variant="outlined"
              disabled={input.unit_groups.length >= 20}
              onClick={() =>
                change({
                  unit_groups: [
                    ...input.unit_groups,
                    {
                      group_ref: id(),
                      physical_template: 'ROOM',
                      booking_mode: 'WHOLE_ONLY',
                      selection_mode: 'EXACT',
                      capacity: null,
                      units: [],
                    },
                  ],
                })
              }
            >
              {t('psrPreview.add')}
            </Button>
          </Stack>
        )}
        {step === 2 && (
          <Stack spacing={2}>
            {input.unit_groups.map((g, i) => (
              <Paper key={g.group_ref} variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={2}>
                  <Typography component="h3" variant="h6">
                    {i + 1}. {label(g.physical_template)}
                  </Typography>
                  <TextField
                    select
                    label={t('psrPreview.booking')}
                    value={g.booking_mode ?? ''}
                    onChange={(e) =>
                      changeMode(i, e.target.value as Group['booking_mode'])
                    }
                  >
                    {modes(g).map((m) => (
                      <MenuItem key={m} value={m}>
                        {label(m)}
                      </MenuItem>
                    ))}
                  </TextField>
                  {g.booking_mode === 'WHOLE_ONLY' && (
                    <TextField
                      select
                      label={label('selection')}
                      value={g.selection_mode ?? 'EXACT'}
                      onChange={(e) =>
                        updateGroup(i, {
                          selection_mode: e.target
                            .value as Group['selection_mode'],
                        })
                      }
                    >
                      {['EXACT', 'CATEGORY'].map((m) => (
                        <MenuItem key={m} value={m}>
                          {t(`psrPreview.${m.toLowerCase()}`)}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                  {['PARTS_ONLY', 'WHOLE_AND_PARTS'].includes(
                    g.booking_mode ?? '',
                  ) && (
                    <>
                      {(g.parts ?? []).map((p, j) => (
                        <Stack
                          key={p.part_ref}
                          direction={{ xs: 'column', sm: 'row' }}
                          spacing={1}
                        >
                          <TextField
                            label={label('code')}
                            value={p.code}
                            onChange={(e) =>
                              updateGroup(i, {
                                parts: g.parts!.map((x, k) =>
                                  k === j ? { ...x, code: e.target.value } : x,
                                ),
                              })
                            }
                          />
                          <TextField
                            label={label('unitName')}
                            value={p.display_label}
                            onChange={(e) =>
                              updateGroup(i, {
                                parts: g.parts!.map((x, k) =>
                                  k === j
                                    ? { ...x, display_label: e.target.value }
                                    : x,
                                ),
                              })
                            }
                          />
                          <TextField
                            type="number"
                            label={t('psrPreview.capacity')}
                            {...validation(
                              `unit_groups.${i}.parts.${j}.capacity`,
                            )}
                            value={p.capacity ?? ''}
                            onChange={(e) =>
                              updateGroup(i, {
                                parts: g.parts!.map((x, k) =>
                                  k === j
                                    ? { ...x, capacity: number(e.target.value) }
                                    : x,
                                ),
                              })
                            }
                          />
                          <Button
                            onClick={() =>
                              updateGroup(i, {
                                parts: g.parts!.filter((_, k) => k !== j),
                              })
                            }
                          >
                            {t('psrPreview.remove')}
                          </Button>
                        </Stack>
                      ))}
                      <Button
                        onClick={() =>
                          updateGroup(i, {
                            parts: [
                              ...(g.parts ?? []),
                              {
                                part_ref: id(),
                                code: '',
                                display_label: '',
                                capacity: null,
                              },
                            ],
                          })
                        }
                      >
                        {label('addPart')}
                      </Button>
                    </>
                  )}
                  {g.booking_mode?.startsWith('BEDS') && (
                    <>
                      <Alert severity="info">{label('mixed')}</Alert>
                      <TextField
                        type="number"
                        label={label('bedCount')}
                        {...validation(`unit_groups.${i}.beds_per_unit`)}
                        value={g.beds_per_unit ?? g.beds?.length ?? ''}
                        disabled={Boolean(g.beds)}
                        inputProps={{ min: 1, max: 50 }}
                        onChange={(e) =>
                          updateGroup(i, {
                            beds_per_unit: number(e.target.value),
                          })
                        }
                      />
                    </>
                  )}
                  {g.booking_mode === 'CONNECTED_UNITS' && (
                    <>
                      <ErrorAlert error={resources.error} />
                      <TextField
                        select
                        SelectProps={{ multiple: true }}
                        label={label('connected')}
                        {...validation(
                          `unit_groups.${i}.connected_resource_ids`,
                        )}
                        value={g.connected_resource_ids ?? []}
                        onChange={(e) =>
                          updateGroup(i, {
                            connected_resource_ids:
                              typeof e.target.value === 'string'
                                ? e.target.value.split(',')
                                : e.target.value,
                          })
                        }
                      >
                        {resources.data?.pages
                          .flatMap((page) => page.items)
                          .filter((r) => r.state === 'ACTIVE')
                          .map((r) => (
                            <MenuItem key={r.id} value={r.id}>
                              {r.display_label || r.code} · {r.code}
                            </MenuItem>
                          ))}
                      </TextField>
                      {resources.hasNextPage && (
                        <Button
                          disabled={resources.isFetchingNextPage}
                          onClick={() => void resources.fetchNextPage()}
                        >
                          {label('moreResources')}
                        </Button>
                      )}
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={g.connection_ack ?? false}
                            onChange={(e) =>
                              updateGroup(i, {
                                connection_ack: e.target.checked,
                              })
                            }
                          />
                        }
                        label={label('connectionAck')}
                      />
                    </>
                  )}
                  {g.booking_mode === 'WHOLE_AND_PARTS' && (
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={g.privacy_ack ?? false}
                          onChange={(e) =>
                            updateGroup(i, { privacy_ack: e.target.checked })
                          }
                        />
                      }
                      label={label('privacy')}
                    />
                  )}
                  {[
                    'WHOLE_AND_PARTS',
                    'BEDS_AND_PRIVATE',
                    'CONNECTED_UNITS',
                  ].includes(g.booking_mode ?? '') && (
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      {(['effective_from', 'effective_to'] as const).map(
                        (field) => (
                          <TextField
                            key={field}
                            type="date"
                            label={label(field)}
                            InputLabelProps={{ shrink: true }}
                            value={g[field] ?? ''}
                            onChange={(e) =>
                              updateGroup(i, {
                                [field]: e.target.value || null,
                              })
                            }
                          />
                        ),
                      )}
                    </Stack>
                  )}
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
        {step === 3 && (
          <Stack spacing={2}>
            <Typography variant="h6">{input.property.name}</Typography>
            {input.unit_groups.map((g, i) => (
              <Paper key={g.group_ref} variant="outlined" sx={{ p: 2 }}>
                <Typography>
                  {i + 1}. {label(g.physical_template)} —{' '}
                  {label(g.booking_mode ?? 'WHOLE_ONLY')}
                </Typography>
                <Typography sx={{ overflowWrap: 'anywhere' }}>
                  {g.pattern ||
                    g.units?.map((u) => u.display_label || u.code).join('، ')}
                </Typography>
              </Paper>
            ))}
            {!addition && (
              <>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={input.pricing?.postponed ?? true}
                      onChange={(e) =>
                        change({
                          pricing: {
                            ...input.pricing,
                            postponed: e.target.checked,
                          },
                        })
                      }
                    />
                  }
                  label={label('pricingLater')}
                />
                {input.pricing?.postponed === false && (
                  <Stack spacing={2}>
                    {(
                      [
                        'plan_name',
                        'base_price',
                        'sell_from',
                        'sell_to',
                      ] as const
                    ).map((field) => (
                      <TextField
                        key={field}
                        label={label(field)}
                        type={field.startsWith('sell_') ? 'date' : 'text'}
                        InputLabelProps={{ shrink: true }}
                        {...validation(`pricing.${field}`)}
                        value={input.pricing?.[field] ?? ''}
                        onChange={(e) =>
                          change({
                            pricing: {
                              ...input.pricing!,
                              [field]: e.target.value || null,
                            },
                          })
                        }
                      />
                    ))}
                  </Stack>
                )}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  {(['check_in', 'check_out'] as const).map((field) => (
                    <TextField
                      key={field}
                      label={label(field)}
                      type="time"
                      InputLabelProps={{ shrink: true }}
                      value={input.operations[field] ?? ''}
                      onChange={(e) =>
                        change({
                          operations: {
                            ...input.operations,
                            [field]: e.target.value,
                          },
                        })
                      }
                    />
                  ))}
                </Stack>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={input.operations.inspection_required ?? false}
                      onChange={(e) =>
                        change({
                          operations: {
                            ...input.operations,
                            inspection_required: e.target.checked,
                          },
                        })
                      }
                    />
                  }
                  label={label('inspection')}
                />
              </>
            )}
            <Button
              variant="outlined"
              onClick={model.requestPreview}
              disabled={!addition && (!model.stored || model.dirty)}
            >
              {label(addition ? 'additionPreview' : 'preview')}
            </Button>
            {model.preview && (
              <>
                <Alert
                  severity={
                    model.preview.blockers.length ? 'warning' : 'success'
                  }
                >
                  {t('psrSetup.previewCount', {
                    count: model.preview.generated.total_units,
                  })}
                </Alert>
                {model.preview.batch_plan && (
                  <Alert severity="info">
                    <Typography>
                      {t('psrSetup.batchAvailable', {
                        count: model.preview.batch_plan.total_batches,
                      })}
                    </Typography>
                    <Typography>{label('batchNotice')}</Typography>
                    <Button
                      variant="contained"
                      disabled={!canApply}
                      onClick={() => setConfirmation(() => model.runBatch)}
                    >
                      {label('batchStart')}
                    </Button>
                  </Alert>
                )}
                {model.preview.blockers
                  .filter(
                    (b) =>
                      !model.preview?.batch_plan ||
                      b.code !== 'SETUP_BATCH_TASK_REQUIRED',
                  )
                  .map((b, i) => (
                    <Alert key={i} severity="warning">
                      {b.group_index !== undefined
                        ? `${b.group_index + 1}. `
                        : ''}
                      {fieldLabel(b.field)}
                      {' — '}
                      {t(`errors.${b.code}`, {
                        defaultValue: label('incomplete'),
                      })}
                      <Button
                        onClick={() =>
                          go(
                            b.step === 'PROPERTY'
                              ? 0
                              : b.step === 'UNITS'
                                ? 1
                                : b.step === 'RENTAL'
                                  ? 2
                                  : 3,
                          )
                        }
                      >
                        {label('correct')}
                      </Button>
                    </Alert>
                  ))}
                <Button
                  variant="contained"
                  disabled={!canApply || model.preview.blockers.length > 0}
                  onClick={() => setConfirmation(() => model.apply)}
                >
                  {label(addition ? 'additionApply' : 'apply')}
                </Button>
              </>
            )}
          </Stack>
        )}
      </Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        justifyContent="space-between"
      >
        <Button
          disabled={step === 0 || model.busy}
          onClick={() => go(step - 1)}
        >
          {t('psrPreview.back')}
        </Button>
        {!readOnly && !addition && (
          <Button variant="outlined" disabled={disabled} onClick={model.save}>
            {label('save')}
          </Button>
        )}
        {step < 3 && (
          <Button
            variant="contained"
            disabled={model.busy}
            onClick={() => go(step + 1)}
          >
            {t('psrPreview.next')}
          </Button>
        )}
        {Boolean(model.error) && !model.uncertain && (
          <Button onClick={() => setConfirmation(() => model.reload)}>
            {label('reload')}
          </Button>
        )}
      </Stack>
      {model.stored && !model.dirty && !model.uncertain && (
        <Typography role="status">{label('saved')}</Typography>
      )}
      <Button component={RouterLink} to={`/properties/${propertyId}`}>
        {label('manage')}
      </Button>
      <Dialog
        open={navigation.state === 'blocked'}
        onClose={() => navigation.state === 'blocked' && navigation.reset()}
        aria-labelledby="structure-leave"
      >
        <DialogTitle id="structure-leave">{label('leaveTitle')}</DialogTitle>
        <DialogContent>
          {label(model.uncertain || model.busy ? 'leavePending' : 'leaveDirty')}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => navigation.state === 'blocked' && navigation.reset()}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={model.busy}
            onClick={() =>
              navigation.state === 'blocked' && navigation.proceed()
            }
          >
            {label('leave')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={confirmation !== null}
        onClose={() => closeConfirmation()}
        aria-labelledby="structure-confirm"
      >
        <DialogTitle id="structure-confirm">{label('confirm')}</DialogTitle>
        <DialogContent>
          <Typography>{label('confirmText')}</Typography>
          {confirmationDetails.length > 0 && (
            <>
              <Typography>{label('removedDraftItems')}</Typography>
              <ul>
                {confirmationDetails.map((detail, i) => (
                  <li key={i}>{detail}</li>
                ))}
              </ul>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => closeConfirmation()}>{t('cancel')}</Button>
          <Button
            onClick={() => {
              confirmation?.();
              closeConfirmation();
            }}
          >
            {label('confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
