import { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Step,
  StepButton,
  Stepper,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.js';
import {
  currencyOptions,
  propertyApi,
  timezoneOptions,
} from '../api/property.js';
import { setupApi } from '../api/setup.js';
import type {
  SetupApplyResult,
  SetupDraftInput,
  VersionedSetupInput,
  SetupPreview,
  SetupSimulation,
} from '../api/setup.js';
import { useAuth } from '../auth/AuthProvider.js';
import { ErrorAlert, ForbiddenPanel, PageHeader } from '../identity/shared.js';

const TEMPLATES = [
  'ROOM',
  'CABIN',
  'TENT',
  'VILLA',
  'APARTMENT',
  'DORM',
  'SITE',
  'SUITE',
] as const;
type Template = (typeof TEMPLATES)[number];
type RentalMode = 'EXCLUSIVE' | 'WHOLE_OR_PARTS' | 'BEDS';
// Restricted scopes are enforced by the server at sale/check-in: the guests
// attached to a FEMALE/MALE bed must declare a matching gender.
const SHARING_SCOPES = ['MIXED', 'FEMALE', 'MALE'] as const;
const SPECS = ['KING', 'TWIN'] as const;
const STEP_KEYS = [
  'setupWizard.stepProperty',
  'setupWizard.stepUnits',
  'setupWizard.stepRental',
  'setupWizard.stepOperations',
  'setupWizard.stepPricing',
  'setupWizard.stepReview',
] as const;

interface UnitPart {
  label: string;
  capacity: string;
}

interface UnitGroup {
  id: string;
  template: Template;
  pattern: string;
  exclusions: string;
  capacity: string;
  location: string;
  rentalMode: RentalMode | '';
  privacyAck: boolean;
  sharingScope: string;
  bedCount: string;
  specs: string[];
  parts: UnitPart[];
  connectedCodes: string;
}

interface SetupDraft {
  updatedAt: string;
  step: number;
  property: {
    name: string;
    code: string;
    country: string;
    timezone: string;
    currency: string;
    types: Template[];
  };
  groups: UnitGroup[];
  operations: {
    checkIn: string;
    checkOut: string;
    inspection: boolean;
    explicitStates: boolean;
  };
  pricing: {
    planName: string;
    from: string;
    to: string;
    basePrice: string;
    postponed: boolean;
  };
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

let groupSequence = 0;
function newGroup(template: Template = 'ROOM'): UnitGroup {
  groupSequence += 1;
  return {
    id: `g${Date.now().toString(36)}${groupSequence}`,
    template,
    pattern: '',
    exclusions: '',
    capacity: '2',
    location: '',
    rentalMode: '',
    privacyAck: false,
    sharingScope: 'MIXED',
    bedCount: '1',
    specs: [],
    parts: [],
    connectedCodes: '',
  };
}

function emptyDraft(): SetupDraft {
  return {
    updatedAt: new Date(0).toISOString(),
    step: 0,
    property: {
      name: '',
      code: '',
      country: 'Indonesia',
      timezone: '',
      currency: '',
      types: [],
    },
    groups: [newGroup()],
    operations: {
      checkIn: '14:00',
      checkOut: '12:00',
      inspection: false,
      explicitStates: false,
    },
    pricing: {
      planName: '',
      from: '',
      to: '',
      basePrice: '',
      postponed: false,
    },
  };
}

function draftKey(tenantId: string): string {
  return `hotel:setup-wizard-preview:${tenantId}`;
}

function isLocalDraft(value: unknown): value is SetupDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as SetupDraft;
  const strings = (record: unknown, keys: string[]) =>
    Boolean(record && typeof record === 'object') &&
    keys.every(
      (key) => typeof (record as Record<string, unknown>)[key] === 'string',
    );
  return (
    typeof candidate.updatedAt === 'string' &&
    Number.isInteger(candidate.step) &&
    candidate.step >= 0 &&
    candidate.step < STEP_KEYS.length &&
    strings(candidate.property, [
      'name',
      'code',
      'country',
      'timezone',
      'currency',
    ]) &&
    Array.isArray(candidate.property.types) &&
    candidate.property.types.every((type) => typeof type === 'string') &&
    Array.isArray(candidate.groups) &&
    candidate.groups.every(
      (group) =>
        strings(group, [
          'id',
          'template',
          'pattern',
          'exclusions',
          'capacity',
          'location',
          'rentalMode',
          'sharingScope',
          'bedCount',
          'connectedCodes',
        ]) &&
        typeof group.privacyAck === 'boolean' &&
        Array.isArray(group.specs) &&
        group.specs.every((spec) => typeof spec === 'string') &&
        Array.isArray(group.parts) &&
        group.parts.every((part) => strings(part, ['label', 'capacity'])),
    ) &&
    strings(candidate.operations, ['checkIn', 'checkOut']) &&
    typeof candidate.operations.inspection === 'boolean' &&
    typeof candidate.operations.explicitStates === 'boolean' &&
    strings(candidate.pricing, ['planName', 'from', 'to', 'basePrice']) &&
    typeof candidate.pricing.postponed === 'boolean'
  );
}

function parseCodes(pattern: string): {
  codes: string[];
  invalid: boolean;
} {
  const match = /^\s*(\d{1,6})\s*-\s*(\d{1,6})\s*$/.exec(pattern);
  if (!match) return { codes: [], invalid: true };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end < start || end - start > 2000) return { codes: [], invalid: true };
  const width = (match[1] ?? '').length;
  const codes: string[] = [];
  for (let value = start; value <= end; value += 1) {
    codes.push(String(value).padStart(width, '0'));
  }
  return { codes, invalid: false };
}

function parseExclusions(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

interface GroupPreview {
  invalid: boolean;
  codes: string[];
  empty: boolean;
  excluded: string[];
  outside: string[];
  duplicates: string[];
}

function previewGroup(group: UnitGroup): GroupPreview {
  const parsed = parseCodes(group.pattern);
  const excluded = parseExclusions(group.exclusions);
  const codes = parsed.codes.filter((code) => !excluded.includes(code));
  return {
    invalid: parsed.invalid,
    codes,
    empty: codes.length === 0,
    excluded: excluded.filter((code) => parsed.codes.includes(code)),
    outside: excluded.filter((code) => !parsed.codes.includes(code)),
    duplicates: codes.filter((code, index) => codes.indexOf(code) !== index),
  };
}

function futureDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function stepErrors(
  draft: SetupDraft,
  step: number,
  previews: GroupPreview[],
): string[] {
  const errors: string[] = [];
  if (step === 0) {
    if (!draft.property.name.trim()) errors.push('nameRequired');
    if (!draft.property.code.trim()) errors.push('codeRequired');
    else if (!/^[A-Z0-9-]{2,20}$/.test(draft.property.code.trim()))
      errors.push('codeInvalid');
    if (!draft.property.timezone) errors.push('timezoneRequired');
    if (!draft.property.currency) errors.push('currencyRequired');
    if (draft.property.types.length === 0) errors.push('typesRequired');
  }
  if (step === 1) {
    if (draft.groups.length === 0) errors.push('unitsRequired');
    const seen = new Set<string>();
    for (const [index, group] of draft.groups.entries()) {
      const preview = previews[index] ?? previewGroup(group);
      if (preview.invalid) errors.push(`patternInvalid:${index}`);
      else if (preview.empty) errors.push(`patternEmpty:${index}`);
      if (preview.outside.length > 0) errors.push(`exclusionOutside:${index}`);
      if (preview.duplicates.length > 0)
        errors.push(`duplicateInGroup:${index}`);
      for (const code of preview.codes) {
        if (seen.has(code)) errors.push(`duplicateAcrossGroups:${code}`);
        seen.add(code);
      }
      const capacity = Number(group.capacity);
      if (
        group.capacity !== '' &&
        (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)
      )
        errors.push(`capacityInvalid:${index}`);
    }
  }
  if (step === 2) {
    for (const [index, group] of draft.groups.entries()) {
      if (!group.rentalMode) errors.push(`modeRequired:${index}`);
      if (group.rentalMode === 'WHOLE_OR_PARTS' && !group.privacyAck)
        errors.push(`privacyRequired:${index}`);
      if (group.rentalMode === 'BEDS') {
        if (!group.sharingScope) errors.push(`scopeRequired:${index}`);
        const beds = Number(group.bedCount);
        if (!Number.isInteger(beds) || beds < 1 || beds > 50)
          errors.push(`bedsRequired:${index}`);
      }
      if (
        (group.template === 'VILLA' || group.template === 'APARTMENT') &&
        group.rentalMode === 'WHOLE_OR_PARTS'
      ) {
        if (group.parts.length === 0) errors.push(`partsRequired:${index}`);
        const labels = new Set<string>();
        for (const part of group.parts) {
          const label = part.label.trim().toUpperCase();
          if (!/^[A-Z0-9-]{1,16}$/.test(label))
            errors.push(`partLabelInvalid:${index}`);
          else if (labels.has(label))
            errors.push(`partLabelDuplicate:${index}`);
          else labels.add(label);
          if (part.capacity !== '') {
            const capacity = Number(part.capacity);
            if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)
              errors.push(`partCapacityInvalid:${index}`);
          }
        }
      }
      if (group.template === 'SUITE') {
        const codes = group.connectedCodes
          .split(/[,\n]/)
          .map((value) => value.trim())
          .filter(Boolean);
        if (codes.length < 2) errors.push(`linksRequired:${index}`);
        else if (new Set(codes).size !== codes.length)
          errors.push(`connectionDuplicate:${index}`);
      }
    }
  }
  if (step === 3) {
    if (!draft.operations.checkIn || !draft.operations.checkOut)
      errors.push('timesRequired');
    if (!draft.operations.explicitStates) errors.push('explicitStatesRequired');
  }
  if (step === 4 && !draft.pricing.postponed) {
    if (
      !draft.pricing.planName.trim() ||
      !draft.pricing.from ||
      !draft.pricing.to ||
      !draft.pricing.basePrice.trim()
    )
      errors.push('priceRequired');
    else if (draft.pricing.to <= draft.pricing.from)
      errors.push('periodInvalid');
  }
  return errors;
}

function missingTasks(draft: SetupDraft, previews: GroupPreview[]): string[] {
  const missing: string[] = [];
  for (let step = 0; step <= 4; step += 1) {
    for (const error of stepErrors(draft, step, previews)) {
      if (!missing.includes(error)) missing.push(error);
    }
  }
  return missing;
}

function countUnits(
  draft: SetupDraft,
  previews: GroupPreview[],
): { units: number; beds: number; sites: number; rooms: number } {
  let units = 0;
  let beds = 0;
  let sites = 0;
  let rooms = 0;
  for (const [index, group] of draft.groups.entries()) {
    const count = previews[index]?.codes.length ?? 0;
    units += count;
    if (group.template === 'SITE') sites += count;
    if (group.template === 'ROOM' || group.template === 'DORM') rooms += count;
    if (
      (group.template === 'VILLA' || group.template === 'APARTMENT') &&
      group.rentalMode === 'WHOLE_OR_PARTS'
    ) {
      rooms += count * group.parts.length;
    }
    if (group.rentalMode === 'BEDS') {
      const perRoom = Number(group.bedCount);
      beds += Number.isFinite(perRoom) ? count * perRoom : 0;
    }
  }
  return { units, beds, sites, rooms };
}

function localToServerInput(draft: SetupDraft): SetupDraftInput {
  return {
    property: {
      name: draft.property.name.trim() === '' ? null : draft.property.name,
      code: draft.property.code.trim() === '' ? null : draft.property.code,
      country:
        draft.property.country.trim() === '' ? null : draft.property.country,
      timezone:
        draft.property.timezone === ''
          ? null
          : (draft.property.timezone as NonNullable<
              SetupDraftInput['property']['timezone']
            >),
      base_currency:
        draft.property.currency === ''
          ? null
          : (draft.property.currency as NonNullable<
              SetupDraftInput['property']['base_currency']
            >),
      types: draft.property.types,
    },
    unit_groups: draft.groups.map((group) => ({
      id: group.id,
      template_code: group.template,
      pattern: group.pattern,
      exclusions: parseExclusions(group.exclusions),
      capacity: group.capacity === '' ? null : Number(group.capacity),
      location_code: group.location === '' ? null : group.location,
      rental_mode:
        group.rentalMode === ''
          ? null
          : (group.rentalMode as SetupDraftInput['unit_groups'][number]['rental_mode']),
      privacy_ack: group.privacyAck,
      sharing_scope:
        group.sharingScope === ''
          ? null
          : (group.sharingScope as NonNullable<
              SetupDraftInput['unit_groups'][number]['sharing_scope']
            >),
      beds_per_unit: group.bedCount === '' ? null : Number(group.bedCount),
      guaranteed_specs: group.specs,
      parts: group.parts.map((part) => ({
        label: part.label.trim().toUpperCase(),
        capacity: part.capacity === '' ? null : Number(part.capacity),
      })),
      connected_codes: group.connectedCodes
        .split(/[,\n]/)
        .map((value) => value.trim())
        .filter(Boolean),
    })),
    operations: {
      check_in: draft.operations.checkIn || null,
      check_out: draft.operations.checkOut || null,
      inspection_required: draft.operations.inspection,
      explicit_states: draft.operations.explicitStates,
    },
    pricing: {
      postponed: draft.pricing.postponed,
      plan_name: draft.pricing.planName || null,
      sell_from: draft.pricing.from || null,
      sell_to: draft.pricing.to || null,
      base_price: draft.pricing.basePrice || null,
    },
  };
}

function serverInputToLocal(input: VersionedSetupInput): SetupDraft {
  if ('schema_version' in input)
    throw new ApiError('SETUP_MODE_UNSUPPORTED', 422, {
      reason: 'use_structure_editor',
    });
  return {
    updatedAt: new Date().toISOString(),
    step: 0,
    property: {
      name: input.property?.name ?? '',
      code: input.property?.code ?? '',
      country: input.property?.country ?? '',
      timezone: input.property?.timezone ?? '',
      currency: input.property?.base_currency ?? '',
      types: input.property?.types ?? [],
    },
    groups: (input.unit_groups ?? []).map((group, index) => ({
      id: group.id ?? `server-${index}`,
      template: group.template_code,
      pattern: group.pattern ?? '',
      exclusions: (group.exclusions ?? []).join(', '),
      capacity:
        group.capacity === null || group.capacity === undefined
          ? ''
          : String(group.capacity),
      location: group.location_code ?? '',
      rentalMode: group.rental_mode ?? '',
      privacyAck: group.privacy_ack === true,
      sharingScope: group.sharing_scope ?? 'MIXED',
      bedCount:
        group.beds_per_unit === null || group.beds_per_unit === undefined
          ? '1'
          : String(group.beds_per_unit),
      specs: group.guaranteed_specs ?? [],
      parts: (group.parts ?? []).map((part) => ({
        label: part.label ?? '',
        capacity:
          part.capacity === null || part.capacity === undefined
            ? ''
            : String(part.capacity),
      })),
      connectedCodes: (group.connected_codes ?? []).join(', '),
    })),
    operations: {
      checkIn: input.operations?.check_in ?? '14:00',
      checkOut: input.operations?.check_out ?? '12:00',
      inspection: input.operations?.inspection_required === true,
      explicitStates: input.operations?.explicit_states === true,
    },
    pricing: {
      planName: input.pricing?.plan_name ?? '',
      from: input.pricing?.sell_from ?? '',
      to: input.pricing?.sell_to ?? '',
      basePrice: input.pricing?.base_price ?? '',
      postponed: input.pricing?.postponed === true,
    },
  };
}

export function SetupWizardPreviewPage({
  resumeOnly = false,
}: {
  resumeOnly?: boolean;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { activeTenantId, hasPermission } = useAuth();
  const canManage = hasPermission('property.manage');
  const [draft, setDraft] = useState<SetupDraft>(emptyDraft);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [stored, setStored] = useState<SetupDraft | null>(null);
  const [corrupt, setCorrupt] = useState(false);
  const [resumeVisible, setResumeVisible] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [simulation, setSimulation] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] =
    useState<SetupSimulation | null>(null);
  const [simulationBusy, setSimulationBusy] = useState(false);
  const [resourceOptions, setResourceOptions] = useState<string[] | null>(null);
  const saveTimer = useRef<number | null>(null);
  const [searchParams] = useSearchParams();
  const serverPropertyId = searchParams.get('propertyId');
  const serverMode = Boolean(serverPropertyId) && canManage;
  const [localReadReady, setLocalReadReady] = useState(!resumeOnly);
  const [serverRevision, setServerRevision] = useState<number | null>(null);
  const [serverDraftId, setServerDraftId] = useState<string | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverReadOnly, setServerReadOnly] = useState<
    'completed' | 'version' | null
  >(null);
  const [serverError, setServerError] = useState<unknown>(null);
  const [serverReadAttempt, setServerReadAttempt] = useState(0);
  const pendingKey = useRef<string | null>(null);
  const [previewResult, setPreviewResult] = useState<SetupPreview | null>(null);
  const [applyResult, setApplyResult] = useState<SetupApplyResult | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const applyKey = useRef<string | null>(null);

  const previews = useMemo(
    () => draft.groups.map((group) => previewGroup(group)),
    [draft.groups],
  );
  const counts = useMemo(() => countUnits(draft, previews), [draft, previews]);
  const missing = useMemo(
    () => missingTasks(draft, previews),
    [draft, previews],
  );
  const liveErrors = useMemo(
    () => stepErrors(draft, step, previews),
    [draft, step, previews],
  );
  const shownErrors = errors.length === 0 ? [] : liveErrors;
  const errorsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (errors.length > 0) errorsRef.current?.focus();
  }, [errors]);

  useEffect(() => {
    if (!activeTenantId || serverMode) return;
    try {
      const raw = window.localStorage.getItem(draftKey(activeTenantId));
      if (raw === null) {
        if (resumeOnly) navigate('/properties', { replace: true });
        setStored(null);
        setCorrupt(false);
        setResumeVisible(false);
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isLocalDraft(parsed)) {
        setCorrupt(true);
        setStored(null);
        setResumeVisible(false);
        return;
      }
      setStored(parsed);
      if (resumeOnly) {
        setDraft(parsed);
        setStep(parsed.step ?? 0);
      }
      setCorrupt(false);
      setResumeVisible(true);
    } catch {
      setCorrupt(true);
      setStored(null);
      setResumeVisible(false);
    } finally {
      setLocalReadReady(true);
    }
  }, [activeTenantId, serverMode, resumeOnly, navigate]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!serverMode || !activeTenantId || !serverPropertyId) return;
    let cancelled = false;
    setServerLoading(true);
    setServerError(null);
    setServerReadOnly(null);
    setupApi
      .getDraft(activeTenantId, serverPropertyId)
      .then((response) => {
        if (cancelled) return;
        if (response.draft) {
          if (resumeOnly && 'schema_version' in response.draft.input) {
            navigate(`/properties/${serverPropertyId}/structure`, {
              replace: true,
            });
            return;
          }
          if (
            response.draft.completed ||
            'schema_version' in response.draft.input
          ) {
            setServerReadOnly(
              response.draft.completed ? 'completed' : 'version',
            );
            return;
          }
          setDraft(serverInputToLocal(response.draft.input));
          setServerRevision(response.draft.revision);
          setServerDraftId(response.draft.draft_id);
          setSavedAt(response.draft.updated_at);
          setSaveState('saved');
        } else if (resumeOnly) {
          navigate(`/properties/${serverPropertyId}/structure`, {
            replace: true,
          });
        }
      })
      .catch((caught) => {
        if (!cancelled) setServerError(caught);
      })
      .finally(() => {
        if (!cancelled) setServerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    serverMode,
    activeTenantId,
    serverPropertyId,
    serverReadAttempt,
    resumeOnly,
    navigate,
  ]);

  const update = (mutate: (current: SetupDraft) => SetupDraft) => {
    setDraft((current) => ({ ...mutate(current) }));
    setPreviewResult(null);
    setSaveState((state) =>
      state === 'conflict' || state === 'error' ? state : 'idle',
    );
  };

  const runPreview = () => {
    if (!serverMode || !serverPropertyId || !activeTenantId) return;
    setApplyBusy(true);
    setServerError(null);
    setupApi
      .previewDraft(activeTenantId, serverPropertyId)
      .then((preview) => setPreviewResult(preview))
      .catch((caught) => setServerError(caught))
      .finally(() => setApplyBusy(false));
  };

  const runApply = () => {
    if (
      !serverMode ||
      !serverPropertyId ||
      !activeTenantId ||
      !previewResult ||
      !serverEtag
    )
      return;
    const key = applyKey.current ?? crypto.randomUUID();
    applyKey.current = key;
    setApplyBusy(true);
    setServerError(null);
    setupApi
      .applyDraft(
        activeTenantId,
        serverPropertyId,
        previewResult.preview_version,
        {
          idempotencyKey: key,
          ifMatch: serverEtag!,
        },
      )
      .then((response) => {
        applyKey.current = null;
        setApplyResult(response.result);
      })
      .catch((caught) => {
        if (caught instanceof ApiError && caught.status === 412) {
          applyKey.current = null;
          setPreviewResult(null);
        }
        if (caught instanceof ApiError && caught.status < 500)
          applyKey.current = null;
        setServerError(caught);
      })
      .finally(() => setApplyBusy(false));
  };

  useEffect(() => {
    if (!serverMode || !serverPropertyId || !activeTenantId || step !== 2)
      return;
    if (resourceOptions !== null) return;
    let cancelled = false;
    propertyApi
      .listResources(activeTenantId, serverPropertyId)
      .then((response) => {
        if (cancelled) return;
        setResourceOptions(
          response.items
            .filter((resource) => resource.state === 'ACTIVE')
            .map((resource) => resource.code),
        );
      })
      .catch(() => {
        if (!cancelled) setResourceOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverMode, serverPropertyId, activeTenantId, step, resourceOptions]);

  const runSimulation = (scope: 'WHOLE' | 'PART' | 'BED') => {
    const group = draft.groups[0];
    if (!serverMode || !serverPropertyId || !activeTenantId) {
      if (scope === 'BED') {
        setSimulation(
          t('setupWizard.review.resultBed', { count: group?.bedCount ?? '' }),
        );
      } else if (
        scope === 'WHOLE' &&
        (group?.template === 'VILLA' || group?.template === 'APARTMENT') &&
        group?.rentalMode === 'WHOLE_OR_PARTS'
      ) {
        setSimulation(
          t('setupWizard.review.resultWhole', {
            parts:
              group.parts
                .map((part) => part.label.trim().toUpperCase())
                .filter(Boolean)
                .join(', ') || 'A, B, C',
          }),
        );
      } else if (scope === 'PART') {
        setSimulation(t('setupWizard.review.resultPart'));
      } else {
        setSimulation(t('setupWizard.review.resultExclusive'));
      }
      return;
    }
    const codes = group ? previewGroup(group).codes : [];
    const unitCode = codes[0] ?? group?.pattern.trim() ?? '';
    const from = draft.pricing.from || futureDate(10);
    const to = draft.pricing.to || futureDate(12);
    setSimulationBusy(true);
    setServerError(null);
    setupApi
      .simulate(activeTenantId, serverPropertyId, { scope, unitCode, from, to })
      .then((result) => setSimulationResult(result))
      .catch((caught) => setServerError(caught))
      .finally(() => setSimulationBusy(false));
  };

  const updateGroup = (index: number, patch: Partial<UnitGroup>) => {
    update((current) => ({
      ...current,
      groups: current.groups.map((group, position) =>
        position === index ? { ...group, ...patch } : group,
      ),
    }));
  };

  const updatePart = (
    index: number,
    partIndex: number,
    patch: Partial<UnitPart>,
  ) => {
    update((current) => ({
      ...current,
      groups: current.groups.map((group, position) =>
        position === index
          ? {
              ...group,
              parts: group.parts.map((part, partPosition) =>
                partPosition === partIndex ? { ...part, ...patch } : part,
              ),
            }
          : group,
      ),
    }));
  };

  const addPart = (index: number) => {
    update((current) => ({
      ...current,
      groups: current.groups.map((group, position) =>
        position === index
          ? {
              ...group,
              parts: [...group.parts, { label: '', capacity: '' }],
            }
          : group,
      ),
    }));
  };

  const removePart = (index: number, partIndex: number) => {
    update((current) => ({
      ...current,
      groups: current.groups.map((group, position) =>
        position === index
          ? {
              ...group,
              parts: group.parts.filter(
                (_, partPosition) => partPosition !== partIndex,
              ),
            }
          : group,
      ),
    }));
  };

  const saveDraft = () => {
    if (!activeTenantId) return;
    if (serverMode && serverPropertyId) {
      const key = pendingKey.current ?? crypto.randomUUID();
      pendingKey.current = key;
      setSaveState('saving');
      setServerError(null);
      setupApi
        .saveDraft(
          activeTenantId,
          serverPropertyId,
          localToServerInput(draft),
          { idempotencyKey: key, ifMatch: serverEtag },
        )
        .then((response) => {
          pendingKey.current = null;
          setServerRevision(response.draft.revision);
          setServerDraftId(response.draft.draft_id);
          setSavedAt(response.draft.updated_at);
          setSaveState('saved');
        })
        .catch(async (caught) => {
          if (caught instanceof ApiError && caught.status === 412) {
            try {
              const latest = await setupApi.getDraft(
                activeTenantId,
                serverPropertyId,
              );
              if (latest.draft) {
                setStored(serverInputToLocal(latest.draft.input));
                setServerRevision(latest.draft.revision);
              }
            } catch {
              /* Keep the local edits for comparison. */
            }
            setSaveState('conflict');
            return;
          }
          if (caught instanceof ApiError && caught.status < 500) {
            pendingKey.current = null;
            setServerError(caught);
            setSaveState('error');
            return;
          }
          setSaveState('error');
        });
      return;
    }
    setSaveState('saving');
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (simulateFailure) {
        setSaveState('error');
        return;
      }
      const next = { ...draft, step, updatedAt: new Date().toISOString() };
      try {
        window.localStorage.setItem(
          draftKey(activeTenantId),
          JSON.stringify(next),
        );
        setStored(next);
        setSavedAt(next.updatedAt);
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 450);
  };

  const resumeDraft = () => {
    if (!stored) return;
    setDraft(stored);
    setStep(stored.step ?? 0);
    setResumeVisible(false);
    setErrors([]);
    setSaveState('saved');
    setSavedAt(stored.updatedAt);
  };

  const startOver = () => {
    if (resumeOnly) {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (serverMode && serverPropertyId && activeTenantId) {
        void setupApi
          .discardDraft(activeTenantId, serverPropertyId, serverEtag)
          .then(() =>
            navigate(`/properties/${serverPropertyId}/structure`, {
              replace: true,
            }),
          )
          .catch((caught) => setServerError(caught));
      } else if (activeTenantId) {
        try {
          window.localStorage.removeItem(draftKey(activeTenantId));
          navigate('/properties', { replace: true });
        } catch (caught) {
          setServerError(caught);
        }
      }
      return;
    }
    if (activeTenantId)
      window.localStorage.removeItem(draftKey(activeTenantId));
    if (serverMode && serverPropertyId && activeTenantId) {
      pendingKey.current = null;
      setServerRevision(null);
      void setupApi
        .discardDraft(activeTenantId, serverPropertyId, serverEtag)
        .catch((caught) => setServerError(caught));
    }
    setDraft(emptyDraft());
    setStep(0);
    setStored(null);
    setResumeVisible(false);
    setCorrupt(false);
    setErrors([]);
    setSaveState('idle');
    setSavedAt(null);
    setSimulation(null);
  };

  const goTo = (target: number) => {
    if (target > step && errorsFor(step).length > 0) {
      setErrors(errorsFor(step));
      return;
    }
    setStep(target);
    setErrors([]);
  };

  function errorsFor(target: number): string[] {
    return stepErrors(draft, target, previews);
  }

  const next = () => {
    const current = errorsFor(step);
    if (current.length > 0) {
      setErrors(current);
      return;
    }
    setStep((value) => Math.min(value + 1, 5));
    setErrors([]);
  };

  const back = () => {
    setStep((value) => Math.max(value - 1, 0));
    setErrors([]);
  };

  if (!activeTenantId) return null;
  if (!canManage)
    return (
      <div>
        <PageHeader title={t('setupWizard.title')} />
        <ForbiddenPanel />
      </div>
    );

  const saveStateLabel = (): string => {
    if (saveState === 'saving') return t('setupWizard.saveStateSaving');
    if (saveState === 'saved')
      return `${t('setupWizard.saveStateSaved')} — ${t('setupWizard.savedAt', { time: (savedAt ?? '').slice(11, 16) })}`;
    if (saveState === 'error') return t('setupWizard.saveStateError');
    if (saveState === 'conflict') return t('setupWizard.saveStateConflict');
    return t('setupWizard.saveStateIdle');
  };

  const errorLabel = (key: string): string => {
    const [name, detail] = key.split(':');
    if (detail && /^\d+$/.test(detail))
      return `${t(`setupWizard.validation.${name}`)} (${t('setupWizard.groupNumber', { number: Number(detail) + 1 })})`;
    if (detail) return `${t(`setupWizard.validation.${name}`)}: ${detail}`;
    return t(`setupWizard.validation.${name}`);
  };

  const fieldState = (
    ...names: string[]
  ): { invalid: boolean; message: string | null } => {
    if (errors.length === 0) return { invalid: false, message: null };
    const key = names.find((name) => liveErrors.includes(name)) ?? null;
    return {
      invalid: key !== null,
      message: key === null ? null : errorLabel(key),
    };
  };

  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const suggestionTimezone =
    detectedTimezone !== draft.property.timezone &&
    timezoneOptions.some((option) => option === detectedTimezone)
      ? detectedTimezone
      : null;

  const firstGroup = draft.groups[0];
  const modesFor = (template: Template): readonly RentalMode[] => {
    if (template === 'VILLA' || template === 'APARTMENT')
      return ['EXCLUSIVE', 'WHOLE_OR_PARTS'];
    if (template === 'DORM') return ['EXCLUSIVE', 'BEDS'];
    return ['EXCLUSIVE'];
  };
  const serverEtag =
    serverDraftId && serverRevision !== null
      ? `"${serverDraftId}:${serverRevision}"`
      : null;

  if (serverReadOnly)
    return (
      <div data-testid="setup-read-only">
        <PageHeader
          title={t('setupWizard.title')}
          action={
            <Button component={RouterLink} to="/properties" variant="outlined">
              {t('back')}
            </Button>
          }
        />
        <Alert severity="info">
          {t(
            serverReadOnly === 'completed'
              ? 'setupWizard.completedReadOnly'
              : 'setupWizard.versionReadOnly',
          )}
        </Alert>
      </div>
    );
  if (resumeOnly && !serverMode && !localReadReady)
    return <Alert severity="info">{t('loading')}</Alert>;
  if (resumeOnly && serverMode && (serverLoading || !serverDraftId))
    return (
      <div data-testid="setup-wizard-preview">
        <PageHeader title={t('setupWizard.title')} />
        {serverLoading ? <Alert severity="info">{t('loading')}</Alert> : null}
        <ErrorAlert error={serverError} />
        {serverError ? (
          <Button
            onClick={() => setServerReadAttempt((attempt) => attempt + 1)}
          >
            {t('psrSetup.reload')}
          </Button>
        ) : null}
      </div>
    );
  if (resumeOnly && corrupt)
    return (
      <div data-testid="setup-wizard-preview">
        <PageHeader title={t('setupWizard.title')} />
        <ErrorAlert error={serverError} />
        <Alert severity="error" data-testid="setup-corrupt-draft">
          {t('setupWizard.corruptDraft')}
          <Button onClick={startOver} sx={{ ms: 1 }} size="small">
            {t('setupWizard.resetDraft')}
          </Button>
        </Alert>
      </div>
    );
  return (
    <div data-testid="setup-wizard-preview">
      <PageHeader
        title={t('setupWizard.title')}
        description={t('setupWizard.description')}
        action={
          <Button component={RouterLink} to="/properties" variant="outlined">
            {t('back')}
          </Button>
        }
      />
      {serverMode ? (
        <Alert severity="info" data-testid="setup-server-banner">
          <AlertTitle>{t('setupWizard.serverTitle')}</AlertTitle>
          {t('setupWizard.serverBanner', { revision: serverRevision ?? 0 })}
        </Alert>
      ) : (
        <Alert severity="info" data-testid="setup-prototype-banner">
          <AlertTitle>{t('setupWizard.prototypeTitle')}</AlertTitle>
          {t('setupWizard.prototypeBanner')}
        </Alert>
      )}
      {serverLoading ? (
        <Alert severity="info" data-testid="setup-server-loading">
          {t('loading')}
        </Alert>
      ) : null}
      <ErrorAlert error={serverError} />

      {corrupt ? (
        <Alert severity="error" data-testid="setup-corrupt-draft">
          {t('setupWizard.corruptDraft')}
          <Button onClick={startOver} sx={{ ms: 1 }} size="small">
            {t('setupWizard.resetDraft')}
          </Button>
        </Alert>
      ) : null}

      {!serverMode && resumeVisible && stored ? (
        <Alert severity="warning" data-testid="setup-resume-banner">
          <AlertTitle>{t('setupWizard.resumeTitle')}</AlertTitle>
          {t('setupWizard.resumeBody', {
            name: stored.property.name || t('setupWizard.untitled'),
            time: stored.updatedAt.slice(0, 16).replace('T', ' '),
          })}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button
              size="small"
              variant="contained"
              onClick={resumeDraft}
              data-testid="setup-resume"
            >
              {t('setupWizard.resume')}
            </Button>
            <Button
              size="small"
              onClick={startOver}
              data-testid="setup-start-over"
            >
              {t('setupWizard.startOver')}
            </Button>
          </Stack>
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, my: 2 }}>
        <Stepper
          nonLinear
          activeStep={step}
          alternativeLabel
          data-testid="setup-stepper"
          sx={{ display: { xs: 'none', sm: 'flex' } }}
        >
          {STEP_KEYS.map((key, index) => (
            <Step key={key} completed={index < step}>
              <StepButton onClick={() => goTo(index)}>{t(key)}</StepButton>
            </Step>
          ))}
        </Stepper>
        <Typography
          variant="subtitle1"
          data-testid="setup-stepper-compact"
          sx={{ display: { xs: 'block', sm: 'none' } }}
        >
          {t('setupWizard.stepOf', {
            current: step + 1,
            total: STEP_KEYS.length,
            label: t(STEP_KEYS[step] ?? STEP_KEYS[0]),
          })}
        </Typography>
      </Paper>

      {shownErrors.length > 0 ? (
        <Alert
          severity="error"
          data-testid="setup-errors"
          role="alert"
          tabIndex={-1}
          ref={errorsRef}
          sx={{ outline: 'none' }}
        >
          <AlertTitle>{t('setupWizard.validation.fixErrors')}</AlertTitle>
          <ul>
            {shownErrors.map((error) => (
              <li key={error}>{errorLabel(error)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
        {step === 0 ? (
          <Stack spacing={2} data-testid="setup-step-property">
            <Typography variant="h6">
              {t('setupWizard.stepProperty')}
            </Typography>
            <TextField
              label={t('setupWizard.property.name')}
              value={draft.property.name}
              onChange={(event) =>
                update((current) => ({
                  ...current,
                  property: { ...current.property, name: event.target.value },
                }))
              }
              error={fieldState('nameRequired').invalid}
              helperText={fieldState('nameRequired').message ?? undefined}
              inputProps={{
                'data-testid': 'property-name',
                'aria-invalid': fieldState('nameRequired').invalid,
              }}
              fullWidth
            />
            <TextField
              label={t('setupWizard.property.code')}
              value={draft.property.code}
              onChange={(event) =>
                update((current) => ({
                  ...current,
                  property: {
                    ...current.property,
                    code: event.target.value.toUpperCase(),
                  },
                }))
              }
              error={fieldState('codeRequired', 'codeInvalid').invalid}
              helperText={
                fieldState('codeRequired', 'codeInvalid').message ??
                t('setupWizard.property.codeHint')
              }
              inputProps={{
                'data-testid': 'property-code',
                dir: 'ltr',
                'aria-invalid': fieldState('codeRequired', 'codeInvalid')
                  .invalid,
              }}
              fullWidth
            />
            <TextField
              label={t('setupWizard.property.country')}
              value={draft.property.country}
              onChange={(event) =>
                update((current) => ({
                  ...current,
                  property: {
                    ...current.property,
                    country: event.target.value,
                  },
                }))
              }
              fullWidth
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                select
                label={t('timezone')}
                value={draft.property.timezone}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    property: {
                      ...current.property,
                      timezone: event.target.value,
                    },
                  }))
                }
                error={fieldState('timezoneRequired').invalid}
                helperText={fieldState('timezoneRequired').message ?? undefined}
                inputProps={{
                  'data-testid': 'property-timezone',
                  'aria-invalid': fieldState('timezoneRequired').invalid,
                }}
                fullWidth
              >
                {timezoneOptions.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label={t('currency')}
                value={draft.property.currency}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    property: {
                      ...current.property,
                      currency: event.target.value,
                    },
                  }))
                }
                error={fieldState('currencyRequired').invalid}
                helperText={fieldState('currencyRequired').message ?? undefined}
                inputProps={{
                  'data-testid': 'property-currency',
                  'aria-invalid': fieldState('currencyRequired').invalid,
                }}
                fullWidth
              >
                {currencyOptions.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            {suggestionTimezone &&
            suggestionTimezone !== draft.property.timezone ? (
              <Alert severity="info">
                <Chip size="small" label={t('setupWizard.suggested')} />{' '}
                {suggestionTimezone}
                <Button
                  size="small"
                  onClick={() =>
                    update((current) => ({
                      ...current,
                      property: {
                        ...current.property,
                        timezone: suggestionTimezone,
                      },
                    }))
                  }
                  data-testid="use-timezone-suggestion"
                >
                  {t('setupWizard.useSuggestion')}
                </Button>
              </Alert>
            ) : null}
            <FormControl
              component="fieldset"
              error={fieldState('typesRequired').invalid}
              aria-invalid={fieldState('typesRequired').invalid}
            >
              <FormLabel component="legend">
                {t('setupWizard.property.types')}
              </FormLabel>
              <Stack direction="row" flexWrap="wrap" useFlexGap>
                {TEMPLATES.map((template) => (
                  <FormControlLabel
                    key={template}
                    data-testid={`property-type-${template}`}
                    control={
                      <Checkbox
                        checked={draft.property.types.includes(template)}
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            property: {
                              ...current.property,
                              types: event.target.checked
                                ? [...current.property.types, template]
                                : current.property.types.filter(
                                    (value) => value !== template,
                                  ),
                            },
                          }))
                        }
                      />
                    }
                    label={t(`setupWizard.templates.${template}`)}
                  />
                ))}
              </Stack>
              <FormHelperText>
                {fieldState('typesRequired').message ??
                  t('setupWizard.property.typesHint')}
              </FormHelperText>
            </FormControl>
          </Stack>
        ) : null}

        {step === 1 ? (
          <Stack spacing={2} data-testid="setup-step-units">
            <Typography variant="h6">{t('setupWizard.stepUnits')}</Typography>
            <Typography color="text.secondary" variant="body2">
              {t('setupWizard.units.intro')}
            </Typography>
            {draft.groups.length === 0 ? (
              <Alert severity="info">{t('setupWizard.units.none')}</Alert>
            ) : null}
            {draft.groups.map((group, index) => {
              const preview = previews[index] ?? previewGroup(group);
              const patternState = fieldState(
                `patternInvalid:${index}`,
                `patternEmpty:${index}`,
                `duplicateInGroup:${index}`,
              );
              const exclusionState = fieldState(`exclusionOutside:${index}`);
              const capacityState = fieldState(`capacityInvalid:${index}`);
              return (
                <Paper
                  key={group.id}
                  variant="outlined"
                  sx={{ p: 2 }}
                  data-testid={`unit-group-${index}`}
                >
                  <Stack spacing={2}>
                    <Stack
                      direction="row"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <Typography variant="subtitle1">
                        {t('setupWizard.units.groupTitle', {
                          number: index + 1,
                        })}
                      </Typography>
                      <Button
                        size="small"
                        color="error"
                        onClick={() =>
                          update((current) => ({
                            ...current,
                            groups: current.groups.filter(
                              (_, position) => position !== index,
                            ),
                          }))
                        }
                        data-testid={`remove-group-${index}`}
                      >
                        {t('remove')}
                      </Button>
                    </Stack>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <TextField
                        select
                        label={t('setupWizard.units.template')}
                        value={group.template}
                        onChange={(event) =>
                          updateGroup(index, {
                            template: event.target.value as Template,
                          })
                        }
                        data-testid={`group-template-${index}`}
                        fullWidth
                      >
                        {TEMPLATES.map((template) => (
                          <MenuItem key={template} value={template}>
                            {t(`setupWizard.templates.${template}`)}
                          </MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        label={t('setupWizard.units.pattern')}
                        value={group.pattern}
                        placeholder="101-116"
                        onChange={(event) =>
                          updateGroup(index, { pattern: event.target.value })
                        }
                        error={patternState.invalid}
                        helperText={
                          patternState.message ??
                          t('setupWizard.units.patternHint')
                        }
                        inputProps={{
                          'data-testid': `group-pattern-${index}`,
                          dir: 'ltr',
                          'aria-invalid': patternState.invalid,
                        }}
                        fullWidth
                      />
                      <TextField
                        label={t('setupWizard.units.exclusions')}
                        value={group.exclusions}
                        placeholder="113"
                        onChange={(event) =>
                          updateGroup(index, { exclusions: event.target.value })
                        }
                        error={exclusionState.invalid}
                        helperText={
                          exclusionState.message ??
                          t('setupWizard.units.exclusionsHint')
                        }
                        inputProps={{
                          'data-testid': `group-exclusions-${index}`,
                          dir: 'ltr',
                          'aria-invalid': exclusionState.invalid,
                        }}
                        fullWidth
                      />
                    </Stack>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <TextField
                        label={t('setupWizard.units.capacity')}
                        value={group.capacity}
                        onChange={(event) =>
                          updateGroup(index, { capacity: event.target.value })
                        }
                        error={capacityState.invalid}
                        helperText={capacityState.message ?? undefined}
                        inputProps={{
                          'data-testid': `group-capacity-${index}`,
                          inputMode: 'numeric',
                          dir: 'ltr',
                          'aria-invalid': capacityState.invalid,
                        }}
                        fullWidth
                      />
                      <TextField
                        label={t('location')}
                        value={group.location}
                        onChange={(event) =>
                          updateGroup(index, { location: event.target.value })
                        }
                        inputProps={{
                          'data-testid': `group-location-${index}`,
                        }}
                        fullWidth
                      />
                    </Stack>
                    {!preview.invalid ? (
                      <Alert
                        severity={preview.empty ? 'warning' : 'success'}
                        data-testid={`unit-preview-${index}`}
                      >
                        {t('setupWizard.units.preview', {
                          count: preview.codes.length,
                          codes:
                            preview.codes.slice(0, 8).join(', ') +
                            (preview.codes.length > 8 ? '…' : ''),
                        })}
                        {preview.excluded.length > 0
                          ? ` — ${t('setupWizard.units.excluded', { codes: preview.excluded.join(', ') })}`
                          : ''}
                      </Alert>
                    ) : null}
                  </Stack>
                </Paper>
              );
            })}
            <Button
              variant="outlined"
              onClick={() =>
                update((current) => ({
                  ...current,
                  groups: [...current.groups, newGroup()],
                }))
              }
              data-testid="add-group"
            >
              {t('setupWizard.units.addGroup')}
            </Button>
          </Stack>
        ) : null}

        {step === 2 ? (
          <Stack spacing={3} data-testid="setup-step-rental">
            <Typography variant="h6">{t('setupWizard.stepRental')}</Typography>
            <Typography color="text.secondary" variant="body2">
              {t('setupWizard.rental.intro')}
            </Typography>
            {draft.groups.length === 0 ? (
              <Alert severity="info">{t('setupWizard.units.none')}</Alert>
            ) : null}
            {draft.groups.map((group, index) => {
              const modeState = fieldState(`modeRequired:${index}`);
              const privacyState = fieldState(`privacyRequired:${index}`);
              const partsState = fieldState(`partsRequired:${index}`);
              const partLabelState = fieldState(
                `partLabelInvalid:${index}`,
                `partLabelDuplicate:${index}`,
              );
              const partCapacityState = fieldState(
                `partCapacityInvalid:${index}`,
              );
              const linksState = fieldState(
                `linksRequired:${index}`,
                `connectionDuplicate:${index}`,
              );
              const scopeState = fieldState(`scopeRequired:${index}`);
              const bedsState = fieldState(`bedsRequired:${index}`);
              return (
                <Paper
                  key={group.id}
                  variant="outlined"
                  sx={{ p: 2 }}
                  data-testid={`rental-group-${index}`}
                >
                  <Stack spacing={2}>
                    <Typography variant="subtitle1">
                      {t('setupWizard.units.groupTitle', { number: index + 1 })}{' '}
                      · {t(`setupWizard.templates.${group.template}`)}
                    </Typography>
                    <FormControl error={modeState.invalid}>
                      <FormLabel>{t('setupWizard.rental.modeLabel')}</FormLabel>
                      <RadioGroup
                        row
                        value={group.rentalMode}
                        onChange={(event) =>
                          updateGroup(index, {
                            rentalMode: event.target.value as RentalMode,
                          })
                        }
                        data-testid={`rental-mode-${index}`}
                        aria-invalid={modeState.invalid}
                      >
                        {modesFor(group.template).map((mode) => (
                          <FormControlLabel
                            key={mode}
                            value={mode}
                            control={<Radio />}
                            label={t(`setupWizard.rental.mode.${mode}`)}
                          />
                        ))}
                      </RadioGroup>
                      {modeState.message ? (
                        <FormHelperText>{modeState.message}</FormHelperText>
                      ) : null}
                    </FormControl>
                    {group.rentalMode === 'WHOLE_OR_PARTS' ? (
                      <FormControl error={!group.privacyAck}>
                        <FormControlLabel
                          data-testid={`privacy-ack-${index}`}
                          control={
                            <Checkbox
                              checked={group.privacyAck}
                              onChange={(event) =>
                                updateGroup(index, {
                                  privacyAck: event.target.checked,
                                })
                              }
                              inputProps={{
                                'aria-invalid': privacyState.invalid,
                              }}
                            />
                          }
                          label={t('setupWizard.rental.privacyAck')}
                        />
                        <FormHelperText>
                          {privacyState.message ??
                            t('setupWizard.rental.privacyHint')}
                        </FormHelperText>
                      </FormControl>
                    ) : null}
                    {(group.template === 'VILLA' ||
                      group.template === 'APARTMENT') &&
                    group.rentalMode === 'WHOLE_OR_PARTS' ? (
                      <Box data-testid={`parts-editor-${index}`}>
                        <FormLabel>{t('setupWizard.rental.parts')}</FormLabel>
                        <FormHelperText
                          sx={{ mb: 1 }}
                          error={
                            partsState.invalid ||
                            partLabelState.invalid ||
                            partCapacityState.invalid
                          }
                        >
                          {partsState.message ??
                            partLabelState.message ??
                            partCapacityState.message ??
                            t('setupWizard.rental.partsHint')}
                        </FormHelperText>
                        {group.parts.map((part, partIndex) => (
                          <Stack
                            key={`${group.id}-part-${partIndex}`}
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={2}
                            sx={{ mb: 1 }}
                          >
                            <TextField
                              label={t('setupWizard.rental.partLabel')}
                              value={part.label}
                              onChange={(event) =>
                                updatePart(index, partIndex, {
                                  label: event.target.value,
                                })
                              }
                              error={partLabelState.invalid}
                              helperText={partLabelState.message ?? undefined}
                              inputProps={{
                                'data-testid': `part-label-${index}-${partIndex}`,
                                'aria-invalid': partLabelState.invalid,
                              }}
                              fullWidth
                            />
                            <TextField
                              label={t('setupWizard.rental.partCapacity')}
                              value={part.capacity}
                              onChange={(event) =>
                                updatePart(index, partIndex, {
                                  capacity: event.target.value,
                                })
                              }
                              error={partCapacityState.invalid}
                              helperText={
                                partCapacityState.message ?? undefined
                              }
                              inputProps={{
                                'data-testid': `part-capacity-${index}-${partIndex}`,
                                inputMode: 'numeric',
                                dir: 'ltr',
                                'aria-invalid': partCapacityState.invalid,
                              }}
                              fullWidth
                            />
                            <Button
                              variant="text"
                              color="error"
                              onClick={() => removePart(index, partIndex)}
                              data-testid={`remove-part-${index}-${partIndex}`}
                            >
                              {t('setupWizard.rental.removePart')}
                            </Button>
                          </Stack>
                        ))}
                        <Button
                          variant="outlined"
                          onClick={() => addPart(index)}
                          data-testid={`add-part-${index}`}
                        >
                          {t('setupWizard.rental.addPart')}
                        </Button>
                      </Box>
                    ) : null}
                    {group.template === 'SUITE' ? (
                      serverMode &&
                      resourceOptions &&
                      resourceOptions.length > 0 ? (
                        <FormControl
                          component="fieldset"
                          error={linksState.invalid}
                          aria-invalid={linksState.invalid}
                        >
                          <FormLabel component="legend">
                            {t('setupWizard.rental.connectedUnits')}
                          </FormLabel>
                          <Stack direction="row" flexWrap="wrap" useFlexGap>
                            {resourceOptions.map((code) => {
                              const selected = group.connectedCodes
                                .split(/[,\n]/)
                                .map((value) => value.trim())
                                .filter(Boolean);
                              return (
                                <FormControlLabel
                                  key={code}
                                  data-testid={`connected-option-${index}-${code}`}
                                  control={
                                    <Checkbox
                                      checked={selected.includes(code)}
                                      onChange={(event) =>
                                        updateGroup(index, {
                                          connectedCodes: event.target.checked
                                            ? [...selected, code].join(', ')
                                            : selected
                                                .filter(
                                                  (value) => value !== code,
                                                )
                                                .join(', '),
                                        })
                                      }
                                    />
                                  }
                                  label={code}
                                />
                              );
                            })}
                          </Stack>
                          <FormHelperText>
                            {linksState.message ??
                              t('setupWizard.rental.connectedHint')}
                          </FormHelperText>
                        </FormControl>
                      ) : (
                        <TextField
                          label={t('setupWizard.rental.connectedUnits')}
                          value={group.connectedCodes}
                          onChange={(event) =>
                            updateGroup(index, {
                              connectedCodes: event.target.value,
                            })
                          }
                          error={linksState.invalid}
                          helperText={
                            linksState.message ??
                            t('setupWizard.rental.connectedHint')
                          }
                          inputProps={{
                            'data-testid': `connected-codes-${index}`,
                            dir: 'ltr',
                            'aria-invalid': linksState.invalid,
                          }}
                          fullWidth
                          multiline
                          minRows={1}
                        />
                      )
                    ) : null}
                    {group.rentalMode === 'BEDS' ? (
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={2}
                      >
                        <TextField
                          select
                          label={t('setupWizard.rental.sharingScope')}
                          value={group.sharingScope}
                          onChange={(event) =>
                            updateGroup(index, {
                              sharingScope: event.target.value,
                            })
                          }
                          error={scopeState.invalid}
                          helperText={scopeState.message ?? undefined}
                          inputProps={{ 'aria-invalid': scopeState.invalid }}
                          data-testid={`sharing-scope-${index}`}
                          fullWidth
                        >
                          {SHARING_SCOPES.map((scope) => (
                            <MenuItem key={scope} value={scope}>
                              {t(`setupWizard.rental.sharing.${scope}`)}
                            </MenuItem>
                          ))}
                        </TextField>
                        <FormHelperText>
                          {t('setupWizard.rental.sharingPolicyEnforced')}
                        </FormHelperText>
                        <TextField
                          label={t('setupWizard.rental.bedCount')}
                          value={group.bedCount}
                          onChange={(event) =>
                            updateGroup(index, { bedCount: event.target.value })
                          }
                          error={bedsState.invalid}
                          helperText={bedsState.message ?? undefined}
                          inputProps={{
                            'data-testid': `bed-count-${index}`,
                            inputMode: 'numeric',
                            dir: 'ltr',
                            'aria-invalid': bedsState.invalid,
                          }}
                          fullWidth
                        />
                      </Stack>
                    ) : null}
                    {group.template === 'ROOM' ||
                    group.template === 'CABIN' ||
                    group.template === 'VILLA' ||
                    group.template === 'APARTMENT' ? (
                      <FormControl component="fieldset">
                        <FormLabel component="legend">
                          {t('setupWizard.rental.specs')}
                        </FormLabel>
                        <Stack direction="row">
                          {SPECS.map((spec) => (
                            <FormControlLabel
                              key={spec}
                              data-testid={`spec-${index}-${spec}`}
                              control={
                                <Checkbox
                                  checked={group.specs.includes(spec)}
                                  onChange={(event) =>
                                    updateGroup(index, {
                                      specs: event.target.checked
                                        ? [...group.specs, spec]
                                        : group.specs.filter(
                                            (value) => value !== spec,
                                          ),
                                    })
                                  }
                                />
                              }
                              label={t(`setupWizard.rental.spec.${spec}`)}
                            />
                          ))}
                        </Stack>
                        <FormHelperText>
                          {t('setupWizard.rental.specsHint')}
                        </FormHelperText>
                      </FormControl>
                    ) : null}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        ) : null}

        {step === 3 ? (
          <Stack spacing={3} data-testid="setup-step-operations">
            <Typography variant="h6">
              {t('setupWizard.stepOperations')}
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label={t('setupWizard.operations.checkIn')}
                type="time"
                value={draft.operations.checkIn}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    operations: {
                      ...current.operations,
                      checkIn: event.target.value,
                    },
                  }))
                }
                error={fieldState('timesRequired').invalid}
                helperText={fieldState('timesRequired').message ?? undefined}
                inputProps={{
                  'data-testid': 'check-in-time',
                  dir: 'ltr',
                  'aria-invalid': fieldState('timesRequired').invalid,
                }}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
              <TextField
                label={t('setupWizard.operations.checkOut')}
                type="time"
                value={draft.operations.checkOut}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    operations: {
                      ...current.operations,
                      checkOut: event.target.value,
                    },
                  }))
                }
                error={fieldState('timesRequired').invalid}
                helperText={fieldState('timesRequired').message ?? undefined}
                inputProps={{
                  'data-testid': 'check-out-time',
                  dir: 'ltr',
                  'aria-invalid': fieldState('timesRequired').invalid,
                }}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
            </Stack>
            <FormControlLabel
              data-testid="inspection-required"
              control={
                <Checkbox
                  checked={draft.operations.inspection}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      operations: {
                        ...current.operations,
                        inspection: event.target.checked,
                      },
                    }))
                  }
                />
              }
              label={t('setupWizard.operations.inspection')}
            />
            <FormControlLabel
              data-testid="explicit-states"
              control={
                <Checkbox
                  checked={draft.operations.explicitStates}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      operations: {
                        ...current.operations,
                        explicitStates: event.target.checked,
                      },
                    }))
                  }
                  inputProps={{
                    'aria-invalid': fieldState('explicitStatesRequired')
                      .invalid,
                  }}
                />
              }
              label={t('setupWizard.operations.explicitStates')}
            />
            {fieldState('explicitStatesRequired').message ? (
              <FormHelperText error>
                {fieldState('explicitStatesRequired').message}
              </FormHelperText>
            ) : null}
            <Alert severity="info">
              {t('setupWizard.operations.statesHint')}
            </Alert>
          </Stack>
        ) : null}

        {step === 4 ? (
          <Stack spacing={2} data-testid="setup-step-pricing">
            <Typography variant="h6">{t('setupWizard.stepPricing')}</Typography>
            <FormControlLabel
              data-testid="postpone-pricing"
              control={
                <Checkbox
                  checked={draft.pricing.postponed}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      pricing: {
                        ...current.pricing,
                        postponed: event.target.checked,
                      },
                    }))
                  }
                />
              }
              label={t('setupWizard.pricing.postpone')}
            />
            {draft.pricing.postponed ? (
              <Alert severity="warning">
                {t('setupWizard.pricing.postponeHint')}
              </Alert>
            ) : (
              <>
                <TextField
                  label={t('setupWizard.pricing.planName')}
                  value={draft.pricing.planName}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      pricing: {
                        ...current.pricing,
                        planName: event.target.value,
                      },
                    }))
                  }
                  error={fieldState('priceRequired').invalid}
                  helperText={fieldState('priceRequired').message ?? undefined}
                  inputProps={{
                    'data-testid': 'rate-plan-name',
                    'aria-invalid': fieldState('priceRequired').invalid,
                  }}
                  fullWidth
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField
                    label={t('setupWizard.pricing.from')}
                    type="date"
                    value={draft.pricing.from}
                    onChange={(event) =>
                      update((current) => ({
                        ...current,
                        pricing: {
                          ...current.pricing,
                          from: event.target.value,
                        },
                      }))
                    }
                    error={fieldState('priceRequired').invalid}
                    helperText={
                      fieldState('priceRequired').message ?? undefined
                    }
                    inputProps={{
                      'data-testid': 'sell-from',
                      dir: 'ltr',
                      'aria-invalid': fieldState('priceRequired').invalid,
                    }}
                    InputLabelProps={{ shrink: true }}
                    fullWidth
                  />
                  <TextField
                    label={t('setupWizard.pricing.to')}
                    type="date"
                    value={draft.pricing.to}
                    onChange={(event) =>
                      update((current) => ({
                        ...current,
                        pricing: {
                          ...current.pricing,
                          to: event.target.value,
                        },
                      }))
                    }
                    error={fieldState('priceRequired', 'periodInvalid').invalid}
                    helperText={
                      fieldState('priceRequired', 'periodInvalid').message ??
                      undefined
                    }
                    inputProps={{
                      'data-testid': 'sell-to',
                      dir: 'ltr',
                      'aria-invalid': fieldState(
                        'priceRequired',
                        'periodInvalid',
                      ).invalid,
                    }}
                    InputLabelProps={{ shrink: true }}
                    fullWidth
                  />
                  <TextField
                    label={`${t('setupWizard.pricing.basePrice')} (${draft.property.currency || t('currency')})`}
                    value={draft.pricing.basePrice}
                    onChange={(event) =>
                      update((current) => ({
                        ...current,
                        pricing: {
                          ...current.pricing,
                          basePrice: event.target.value,
                        },
                      }))
                    }
                    error={fieldState('priceRequired').invalid}
                    helperText={
                      fieldState('priceRequired').message ?? undefined
                    }
                    inputProps={{
                      'data-testid': 'base-price',
                      inputMode: 'decimal',
                      dir: 'ltr',
                      'aria-invalid': fieldState('priceRequired').invalid,
                    }}
                    fullWidth
                  />
                </Stack>
                <Alert severity="info">
                  {t('setupWizard.pricing.currencyNote')}
                </Alert>
              </>
            )}
          </Stack>
        ) : null}

        {step === 5 ? (
          <Stack spacing={3} data-testid="setup-step-review">
            <Typography variant="h6">{t('setupWizard.stepReview')}</Typography>
            <Box data-testid="review-counts">
              <Typography variant="subtitle2">
                {t('setupWizard.review.counts')}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip
                  label={`${t('setupWizard.review.units')}: ${counts.units}`}
                  data-testid="review-units"
                />
                <Chip
                  label={`${t('setupWizard.review.rooms')}: ${counts.rooms}`}
                  data-testid="review-rooms"
                />
                <Chip
                  label={`${t('setupWizard.review.beds')}: ${counts.beds}`}
                  data-testid="review-beds"
                />
                <Chip
                  label={`${t('setupWizard.review.sites')}: ${counts.sites}`}
                  data-testid="review-sites"
                />
              </Stack>
              <Typography color="text.secondary" variant="caption">
                {t('setupWizard.review.separateDenominators')}
              </Typography>
            </Box>
            <Divider />
            <Box data-testid="review-missing">
              <Typography variant="subtitle2">
                {t('setupWizard.review.missing')}
              </Typography>
              {missing.length === 0 ? (
                <Alert severity="success">
                  {t('setupWizard.review.missingNone')}
                </Alert>
              ) : (
                <Alert severity="warning">
                  <ul>
                    {missing.map((error) => (
                      <li key={error}>{errorLabel(error)}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </Box>
            <Divider />
            <Box data-testid="review-simulation">
              <Typography variant="subtitle2">
                {t('setupWizard.review.simulation')}
              </Typography>
              <Typography color="text.secondary" variant="body2">
                {t('setupWizard.review.simulationHint')}
              </Typography>
              <Stack
                direction="row"
                spacing={1}
                sx={{ my: 1 }}
                flexWrap="wrap"
                useFlexGap
              >
                {firstGroup?.rentalMode === 'WHOLE_OR_PARTS' ? (
                  <>
                    <Button
                      variant="outlined"
                      onClick={() => runSimulation('WHOLE')}
                      disabled={simulationBusy}
                      data-testid="simulate-whole"
                    >
                      {t('setupWizard.review.simulateWhole')}
                    </Button>
                    <Button
                      variant="outlined"
                      onClick={() => runSimulation('PART')}
                      disabled={simulationBusy}
                      data-testid="simulate-part"
                    >
                      {t('setupWizard.review.simulatePart')}
                    </Button>
                  </>
                ) : null}
                {firstGroup?.rentalMode === 'BEDS' ? (
                  <Button
                    variant="outlined"
                    onClick={() => runSimulation('BED')}
                    disabled={simulationBusy}
                    data-testid="simulate-bed"
                  >
                    {t('setupWizard.review.simulateBed')}
                  </Button>
                ) : null}
                {firstGroup?.rentalMode === 'EXCLUSIVE' ? (
                  <Button
                    variant="outlined"
                    onClick={() => runSimulation('WHOLE')}
                    disabled={simulationBusy}
                    data-testid="simulate-exclusive"
                  >
                    {t('setupWizard.review.simulateExclusive')}
                  </Button>
                ) : null}
              </Stack>
              {simulationResult ? (
                <Alert
                  severity={simulationResult.allowed ? 'info' : 'warning'}
                  data-testid="simulation-result"
                >
                  {t(
                    simulationResult.allowed
                      ? 'setupWizard.review.simAllowed'
                      : 'setupWizard.review.simBlocked',
                  )}
                  {simulationResult.blocked.length > 0
                    ? ` · ${t('setupWizard.review.simBlockedList')}: ${simulationResult.blocked
                        .map((entry) => `${entry.kind} ${entry.code}`)
                        .join(', ')}`
                    : ''}
                  {simulationResult.available_after.length > 0
                    ? ` · ${t('setupWizard.review.simAvailableAfter')}: ${simulationResult.available_after.join(', ')}`
                    : ''}
                </Alert>
              ) : simulation ? (
                <Alert severity="info" data-testid="simulation-result">
                  {simulation}
                </Alert>
              ) : null}
            </Box>
            {serverMode ? (
              <Box data-testid="server-apply">
                <Typography variant="subtitle2">
                  {t('setupWizard.apply.title')}
                </Typography>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ my: 1 }}
                  flexWrap="wrap"
                  useFlexGap
                >
                  <Button
                    variant="outlined"
                    onClick={runPreview}
                    disabled={
                      applyBusy || saveState !== 'saved' || Boolean(applyResult)
                    }
                    data-testid="preview-apply"
                  >
                    {t('setupWizard.apply.preview')}
                  </Button>
                  {previewResult &&
                  previewResult.blockers.length === 0 &&
                  !applyResult ? (
                    <Button
                      variant="contained"
                      onClick={runApply}
                      disabled={applyBusy}
                      data-testid="apply-draft"
                    >
                      {t('setupWizard.apply.execute')}
                    </Button>
                  ) : null}
                </Stack>
                {saveState !== 'saved' && !applyResult ? (
                  <Typography color="text.secondary" variant="caption">
                    {t('setupWizard.apply.saveFirst')}
                  </Typography>
                ) : null}
                {previewResult ? (
                  <Alert
                    severity={
                      previewResult.blockers.length === 0
                        ? 'success'
                        : 'warning'
                    }
                    data-testid="preview-result"
                  >
                    {t('setupWizard.apply.generated', {
                      count: previewResult.generated.total_units,
                    })}
                    {previewResult.blockers.length > 0 ? (
                      <ul>
                        {previewResult.blockers.map((blocker) => (
                          <li
                            key={`${blocker.code}-${blocker.group_index ?? ''}`}
                          >
                            {t(`setupWizard.validation.${blocker.code}`, {
                              defaultValue: blocker.code,
                            })}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div>{t('setupWizard.apply.ready')}</div>
                    )}
                    {previewResult.warnings.length > 0 ? (
                      <ul data-testid="preview-warnings">
                        {previewResult.warnings.map((warning) => (
                          <li
                            key={`${warning.code}-${warning.group_index ?? ''}`}
                          >
                            {t(`setupWizard.validation.${warning.code}`, {
                              defaultValue: warning.code,
                            })}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </Alert>
                ) : null}
                {applyResult ? (
                  <Alert severity="success" data-testid="apply-result">
                    {t('setupWizard.apply.result', {
                      units: applyResult.created_units,
                      products: applyResult.created_products,
                    })}
                    {applyResult.follow_up_tasks.length > 0
                      ? ` ${t('setupWizard.apply.followUp')}`
                      : ''}
                  </Alert>
                ) : null}
              </Box>
            ) : null}
            <Divider />
            <Alert severity={missing.length === 0 ? 'success' : 'warning'}>
              {missing.length === 0
                ? t('setupWizard.review.finishReady')
                : t('setupWizard.review.finishBlocked', {
                    count: missing.length,
                  })}
            </Alert>
          </Stack>
        ) : null}

        <Divider sx={{ my: 3 }} />
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          justifyContent="space-between"
          alignItems={{ xs: 'stretch', sm: 'center' }}
        >
          <Stack direction="row" spacing={1}>
            <Button
              onClick={back}
              disabled={step === 0}
              data-testid="back-step"
            >
              {t('back')}
            </Button>
            <Button
              variant="contained"
              onClick={next}
              disabled={step === 5}
              data-testid="next-step"
            >
              {t('setupWizard.next')}
            </Button>
            <Button
              variant="outlined"
              onClick={saveDraft}
              data-testid="save-draft"
            >
              {t('save')}
            </Button>
            <Typography
              variant="body2"
              color={
                saveState === 'error' || saveState === 'conflict'
                  ? 'error'
                  : 'text.secondary'
              }
              data-testid="save-state"
              sx={{ alignSelf: 'center' }}
            >
              {saveStateLabel()}
            </Typography>
          </Stack>
          {serverMode ? null : (
            <Stack direction="row" spacing={1} data-testid="prototype-controls">
              <Button
                size="small"
                color="warning"
                onClick={() => setSaveState('conflict')}
                data-testid="simulate-conflict"
              >
                {t('setupWizard.simulateConflict')}
              </Button>
              <Button
                size="small"
                color="warning"
                onClick={() => setSimulateFailure((value) => !value)}
                data-testid="simulate-failure"
              >
                {simulateFailure
                  ? t('setupWizard.failureOn')
                  : t('setupWizard.failureOff')}
              </Button>
            </Stack>
          )}
        </Stack>
      </Paper>

      {saveState === 'error' ? (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          data-testid="save-error"
          action={
            <Button color="inherit" size="small" onClick={saveDraft}>
              {t('setupWizard.retrySave')}
            </Button>
          }
        >
          {t('setupWizard.saveFailed')}
        </Alert>
      ) : null}
      {saveState === 'conflict' ? (
        <Alert severity="warning" sx={{ mt: 2 }} data-testid="save-conflict">
          <AlertTitle>{t('setupWizard.conflictTitle')}</AlertTitle>
          {t('setupWizard.conflictBody')}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" onClick={() => setSaveState('idle')}>
              {t('setupWizard.conflictKeepMine')}
            </Button>
            {stored ? (
              <Button
                size="small"
                variant="contained"
                onClick={() => {
                  setDraft(stored);
                  setStep(stored.step ?? 0);
                  setSaveState('saved');
                  setSavedAt(stored.updatedAt);
                }}
              >
                {t('setupWizard.conflictLoadSaved')}
              </Button>
            ) : null}
          </Stack>
        </Alert>
      ) : null}
    </div>
  );
}
