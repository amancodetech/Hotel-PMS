import type { ResourceKind } from './lifecycle.js';

export const SETUP_TEMPLATE_CODES = [
  'ROOM',
  'CABIN',
  'TENT',
  'VILLA',
  'APARTMENT',
  'DORM',
  'SITE',
  'SUITE',
] as const;
export type SetupTemplateCode = (typeof SETUP_TEMPLATE_CODES)[number];

export const SETUP_RENTAL_MODES = [
  'EXCLUSIVE',
  'WHOLE_OR_PARTS',
  'BEDS',
] as const;
export type SetupRentalMode = (typeof SETUP_RENTAL_MODES)[number];

export const SETUP_SHARING_SCOPES = ['MIXED', 'FEMALE', 'MALE'] as const;
export type SetupSharingScope = (typeof SETUP_SHARING_SCOPES)[number];

export const SETUP_SPEC_CODES = ['KING', 'TWIN'] as const;
export type SetupSpecCode = (typeof SETUP_SPEC_CODES)[number];

export interface SetupTemplate {
  code: SetupTemplateCode;
  resourceType: ResourceKind;
  defaultRentalMode: SetupRentalMode;
  supportsParts: boolean;
  supportsBeds: boolean;
  defaultCapacity: number | null;
  guaranteedSetupOptions: SetupSpecCode[];
}

const template = (
  code: SetupTemplateCode,
  resourceType: ResourceKind,
  defaultRentalMode: SetupRentalMode,
  supportsParts: boolean,
  supportsBeds: boolean,
  defaultCapacity: number | null,
  guaranteedSetupOptions: SetupSpecCode[] = [],
): SetupTemplate => ({
  code,
  resourceType,
  defaultRentalMode,
  supportsParts,
  supportsBeds,
  defaultCapacity,
  guaranteedSetupOptions,
});

export const SETUP_TEMPLATES: readonly SetupTemplate[] = [
  template('ROOM', 'ROOM', 'EXCLUSIVE', false, false, 2, ['KING', 'TWIN']),
  template('CABIN', 'CABIN', 'EXCLUSIVE', false, false, 2, ['KING', 'TWIN']),
  template('TENT', 'TENT', 'EXCLUSIVE', false, false, 2),
  template('VILLA', 'VILLA', 'WHOLE_OR_PARTS', true, false, 4, [
    'KING',
    'TWIN',
  ]),
  template('APARTMENT', 'APARTMENT', 'WHOLE_OR_PARTS', true, false, 4, [
    'KING',
    'TWIN',
  ]),
  template('DORM', 'BED', 'BEDS', false, true, 1),
  template('SITE', 'SITE', 'EXCLUSIVE', false, false, 4),
  template('SUITE', 'ROOM', 'EXCLUSIVE', false, false, 4),
];

export function isSetupTemplateCode(
  value: unknown,
): value is SetupTemplateCode {
  return (
    typeof value === 'string' &&
    (SETUP_TEMPLATE_CODES as readonly string[]).includes(value)
  );
}

export function isSetupRentalMode(value: unknown): value is SetupRentalMode {
  return (
    typeof value === 'string' &&
    (SETUP_RENTAL_MODES as readonly string[]).includes(value)
  );
}

export function isSetupSharingScope(
  value: unknown,
): value is SetupSharingScope {
  return (
    typeof value === 'string' &&
    (SETUP_SHARING_SCOPES as readonly string[]).includes(value)
  );
}

export function isSetupSpecCode(value: unknown): value is SetupSpecCode {
  return (
    typeof value === 'string' &&
    (SETUP_SPEC_CODES as readonly string[]).includes(value)
  );
}

export const SETUP_TIMEZONES = [
  'Asia/Jakarta',
  'Asia/Makassar',
  'Asia/Jayapura',
] as const;
export const SETUP_CURRENCIES = ['IDR', 'USD'] as const;

export interface SetupPartInput {
  label: string;
  capacity?: number | null;
}

export interface SetupUnitGroupInput {
  id?: string | null;
  template_code: SetupTemplateCode;
  pattern: string;
  exclusions?: string[];
  capacity?: number | null;
  location_code?: string | null;
  rental_mode: SetupRentalMode;
  privacy_ack?: boolean;
  sharing_scope?: SetupSharingScope | null;
  beds_per_unit?: number | null;
  guaranteed_specs?: SetupSpecCode[];
  parts?: SetupPartInput[];
  connected_codes?: string[];
}

export interface SetupDraftInput {
  property: {
    name?: string | null;
    code?: string | null;
    country?: string | null;
    timezone?: (typeof SETUP_TIMEZONES)[number] | null;
    base_currency?: (typeof SETUP_CURRENCIES)[number] | null;
    types?: SetupTemplateCode[];
  };
  unit_groups: SetupUnitGroupInput[];
  operations: {
    check_in?: string | null;
    check_out?: string | null;
    inspection_required?: boolean;
    explicit_states?: boolean;
  };
  pricing?: {
    postponed: boolean;
    plan_name?: string | null;
    sell_from?: string | null;
    sell_to?: string | null;
    base_price?: string | null;
  } | null;
}

export type SetupStep =
  'PROPERTY' | 'UNITS' | 'RENTAL' | 'OPERATIONS' | 'PRICING' | 'REVIEW';

export interface SetupIssue {
  code: string;
  step: SetupStep;
  field?: string;
  group_index?: number;
  message: string;
}

const codePattern = /^[A-Z0-9-]{2,20}$/;
const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const moneyPattern = /^[0-9]{1,14}(\.[0-9]{1,6})?$/;

export interface ExpandedGroup {
  codes: string[];
  excluded: string[];
  outside: string[];
  duplicates: string[];
  invalid: boolean;
  empty: boolean;
}

export function expandSetupPattern(pattern: string): {
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

export function expandSetupGroup(group: SetupUnitGroupInput): ExpandedGroup {
  const parsed = expandSetupPattern(group.pattern);
  const excluded = (group.exclusions ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const codes = parsed.codes.filter((code) => !excluded.includes(code));
  return {
    codes,
    invalid: parsed.invalid,
    empty: codes.length === 0,
    excluded: excluded.filter((code) => parsed.codes.includes(code)),
    outside: excluded.filter((code) => !parsed.codes.includes(code)),
    duplicates: codes.filter((code, index) => codes.indexOf(code) !== index),
  };
}

function issue(
  code: string,
  step: SetupStep,
  message: string,
  extra: { field?: string; group_index?: number } = {},
): SetupIssue {
  return { code, step, message, ...extra };
}

export function validateSetupDraftInput(input: SetupDraftInput): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const property = input.property;
  if (
    property.name !== undefined &&
    property.name !== null &&
    property.name.trim() !== '' &&
    property.name.trim().length < 2
  )
    issues.push(issue('name_invalid', 'PROPERTY', 'name is too short'));
  if (property.code && !codePattern.test(property.code.trim()))
    issues.push(issue('code_invalid', 'PROPERTY', 'code format is invalid'));
  if (
    property.timezone !== undefined &&
    property.timezone !== null &&
    !(SETUP_TIMEZONES as readonly string[]).includes(property.timezone)
  )
    issues.push(issue('timezone_invalid', 'PROPERTY', 'timezone is invalid'));
  if (
    property.base_currency !== undefined &&
    property.base_currency !== null &&
    !(SETUP_CURRENCIES as readonly string[]).includes(property.base_currency)
  )
    issues.push(
      issue('currency_invalid', 'PROPERTY', 'base currency is invalid'),
    );
  if (property.types !== undefined) {
    if (property.types.length > 8)
      issues.push(issue('types_limit', 'PROPERTY', 'too many types'));
    if (property.types.some((value) => !isSetupTemplateCode(value)))
      issues.push(issue('types_invalid', 'PROPERTY', 'type value is invalid'));
  }

  if (!Array.isArray(input.unit_groups))
    issues.push(issue('units_invalid', 'UNITS', 'unit groups must be a list'));
  else {
    if (input.unit_groups.length > 20)
      issues.push(issue('units_limit', 'UNITS', 'too many groups'));
    const seen = new Set<string>();
    input.unit_groups.forEach((group, index) => {
      if (!isSetupTemplateCode(group.template_code))
        issues.push(
          issue('template_invalid', 'UNITS', 'template is invalid', {
            group_index: index,
            field: 'template_code',
          }),
        );
      const pattern = group.pattern?.trim() ?? '';
      const expanded = expandSetupGroup(group);
      if (pattern !== '') {
        if (expanded.invalid)
          issues.push(
            issue('pattern_invalid', 'UNITS', 'pattern is invalid', {
              group_index: index,
              field: 'pattern',
            }),
          );
        else if (expanded.empty)
          issues.push(
            issue('pattern_empty', 'UNITS', 'pattern yields no unit', {
              group_index: index,
              field: 'pattern',
            }),
          );
        if (expanded.outside.length > 0)
          issues.push(
            issue('exclusion_outside', 'UNITS', 'exclusion is outside range', {
              group_index: index,
              field: 'exclusions',
            }),
          );
        if (expanded.duplicates.length > 0)
          issues.push(
            issue('duplicate_in_group', 'UNITS', 'duplicate number in group', {
              group_index: index,
              field: 'exclusions',
            }),
          );
        for (const code of expanded.codes) {
          if (seen.has(code))
            issues.push(
              issue(
                'duplicate_across_groups',
                'UNITS',
                'duplicate number across groups',
                { group_index: index, field: 'pattern' },
              ),
            );
          seen.add(code);
        }
      }
      if (
        group.capacity !== undefined &&
        group.capacity !== null &&
        (!Number.isInteger(group.capacity) ||
          group.capacity < 1 ||
          group.capacity > 100)
      )
        issues.push(
          issue('capacity_invalid', 'UNITS', 'capacity is invalid', {
            group_index: index,
            field: 'capacity',
          }),
        );
      if (!isSetupRentalMode(group.rental_mode))
        issues.push(
          issue('mode_invalid', 'RENTAL', 'rental mode is invalid', {
            group_index: index,
            field: 'rental_mode',
          }),
        );
      if (
        group.privacy_ack !== undefined &&
        typeof group.privacy_ack !== 'boolean'
      )
        issues.push(
          issue(
            'privacy_invalid',
            'RENTAL',
            'privacy acknowledgment is invalid',
            {
              group_index: index,
              field: 'privacy_ack',
            },
          ),
        );
      if (
        group.sharing_scope !== undefined &&
        group.sharing_scope !== null &&
        !isSetupSharingScope(group.sharing_scope)
      )
        issues.push(
          issue('scope_invalid', 'RENTAL', 'sharing scope is invalid', {
            group_index: index,
            field: 'sharing_scope',
          }),
        );
      if (
        group.beds_per_unit !== undefined &&
        group.beds_per_unit !== null &&
        (!Number.isInteger(group.beds_per_unit) ||
          group.beds_per_unit < 1 ||
          group.beds_per_unit > 50)
      )
        issues.push(
          issue('beds_invalid', 'RENTAL', 'beds per unit is invalid', {
            group_index: index,
            field: 'beds_per_unit',
          }),
        );
      if ((group.guaranteed_specs ?? []).some((spec) => !isSetupSpecCode(spec)))
        issues.push(
          issue('spec_invalid', 'RENTAL', 'guaranteed setup is invalid', {
            group_index: index,
            field: 'guaranteed_specs',
          }),
        );
      const template = setupTemplateFor(group.template_code);
      if (group.parts !== undefined) {
        if (!Array.isArray(group.parts))
          issues.push(
            issue('parts_invalid', 'UNITS', 'parts must be a list', {
              group_index: index,
              field: 'parts',
            }),
          );
        else if (group.parts.length > 0) {
          if (
            template?.supportsParts !== true ||
            group.rental_mode !== 'WHOLE_OR_PARTS'
          ) {
            issues.push(
              issue(
                'parts_not_allowed',
                'UNITS',
                'parts are only accepted for whole-or-parts rentals',
                { group_index: index, field: 'parts' },
              ),
            );
          } else if (group.parts.length > 20) {
            issues.push(
              issue('parts_invalid', 'UNITS', 'parts count is invalid', {
                group_index: index,
                field: 'parts',
              }),
            );
          }
          const labels = new Set<string>();
          for (const part of group.parts) {
            const label = part.label?.trim() ?? '';
            if (!/^[A-Za-z0-9-]{1,16}$/.test(label))
              issues.push(
                issue('part_label_invalid', 'UNITS', 'part label is invalid', {
                  group_index: index,
                  field: 'parts',
                }),
              );
            else if (labels.has(label.toUpperCase()))
              issues.push(
                issue(
                  'part_label_duplicate',
                  'UNITS',
                  'part label is duplicated in the group',
                  { group_index: index, field: 'parts' },
                ),
              );
            else labels.add(label.toUpperCase());
            if (
              part.capacity !== undefined &&
              part.capacity !== null &&
              (!Number.isInteger(part.capacity) ||
                part.capacity < 1 ||
                part.capacity > 100)
            )
              issues.push(
                issue(
                  'part_capacity_invalid',
                  'UNITS',
                  'part capacity is invalid',
                  { group_index: index, field: 'parts' },
                ),
              );
          }
        }
      }
      if (group.connected_codes !== undefined) {
        if (!Array.isArray(group.connected_codes))
          issues.push(
            issue(
              'connections_invalid',
              'UNITS',
              'connected units must be a list',
              { group_index: index, field: 'connected_codes' },
            ),
          );
        else if (group.connected_codes.length > 0) {
          if (group.template_code !== 'SUITE') {
            issues.push(
              issue(
                'connections_not_allowed',
                'UNITS',
                'connected units are only accepted for suites',
                { group_index: index, field: 'connected_codes' },
              ),
            );
          } else {
            if (
              group.connected_codes.length < 2 ||
              group.connected_codes.length > 20
            )
              issues.push(
                issue(
                  'connections_invalid',
                  'UNITS',
                  'a suite connects at least two units',
                  { group_index: index, field: 'connected_codes' },
                ),
              );
            const codes = new Set<string>();
            for (const raw of group.connected_codes) {
              const value = raw?.trim() ?? '';
              if (value === '' || value.length > 80)
                issues.push(
                  issue(
                    'connection_code_invalid',
                    'UNITS',
                    'connected unit code is invalid',
                    { group_index: index, field: 'connected_codes' },
                  ),
                );
              else if (codes.has(value))
                issues.push(
                  issue(
                    'connection_duplicate',
                    'UNITS',
                    'connected unit code is duplicated',
                    { group_index: index, field: 'connected_codes' },
                  ),
                );
              else codes.add(value);
            }
          }
        }
      }
    });
  }

  const operations = input.operations ?? { explicit_states: false };
  if (
    operations.check_in !== undefined &&
    operations.check_in !== null &&
    !timePattern.test(operations.check_in)
  )
    issues.push(
      issue('check_in_invalid', 'OPERATIONS', 'check-in time is invalid', {
        field: 'check_in',
      }),
    );
  if (
    operations.check_out !== undefined &&
    operations.check_out !== null &&
    !timePattern.test(operations.check_out)
  )
    issues.push(
      issue('check_out_invalid', 'OPERATIONS', 'check-out time is invalid', {
        field: 'check_out',
      }),
    );

  const pricing = input.pricing;
  if (pricing) {
    if (
      pricing.plan_name !== undefined &&
      pricing.plan_name !== null &&
      pricing.plan_name.trim().length > 80
    )
      issues.push(
        issue('plan_name_invalid', 'PRICING', 'plan name is too long', {
          field: 'plan_name',
        }),
      );
    if (
      pricing.sell_from &&
      pricing.sell_to &&
      pricing.sell_to <= pricing.sell_from
    )
      issues.push(
        issue('period_invalid', 'PRICING', 'sellable period is invalid', {
          field: 'sell_to',
        }),
      );
    if (
      pricing.base_price !== undefined &&
      pricing.base_price !== null &&
      !moneyPattern.test(pricing.base_price)
    )
      issues.push(
        issue('price_invalid', 'PRICING', 'base price is invalid', {
          field: 'base_price',
        }),
      );
  }
  return issues;
}

export function setupTemplateFor(
  code: SetupTemplateCode,
): SetupTemplate | undefined {
  return SETUP_TEMPLATES.find((template) => template.code === code);
}

export interface SetupExpandedUnits {
  totalUnits: number;
  totalCompositions: number;
  codes: string[];
  excluded: string[];
  byTemplate: Array<{
    templateCode: SetupTemplateCode;
    units: number;
    rooms: number;
    beds: number;
    sites: number;
    parts: number;
    compositions: number;
  }>;
}

export function expandAllSetupUnits(
  input: SetupDraftInput,
): SetupExpandedUnits {
  const codes: string[] = [];
  const excluded: string[] = [];
  const byTemplate = new Map<
    SetupTemplateCode,
    {
      units: number;
      rooms: number;
      beds: number;
      sites: number;
      parts: number;
      compositions: number;
    }
  >();
  for (const group of input.unit_groups ?? []) {
    const expanded = expandSetupGroup(group);
    excluded.push(...expanded.excluded);
    const entry = byTemplate.get(group.template_code) ?? {
      units: 0,
      rooms: 0,
      beds: 0,
      sites: 0,
      parts: 0,
      compositions: 0,
    };
    entry.units += expanded.codes.length;
    if (
      group.template_code === 'VILLA' ||
      group.template_code === 'APARTMENT'
    ) {
      if (group.rental_mode === 'WHOLE_OR_PARTS') {
        const parts = group.parts ?? [];
        entry.parts += expanded.codes.length * parts.length;
        entry.rooms += expanded.codes.length * parts.length;
        entry.compositions += expanded.codes.length;
        for (const code of expanded.codes)
          for (const part of parts)
            codes.push(`${code}-${part.label.trim().toUpperCase()}`);
      } else {
        codes.push(...expanded.codes);
      }
    } else if (group.template_code === 'DORM') {
      entry.rooms += expanded.codes.length;
      if (group.rental_mode === 'BEDS') {
        const beds = group.beds_per_unit ?? 0;
        entry.beds += expanded.codes.length * beds;
        entry.compositions += expanded.codes.length;
        for (const code of expanded.codes) {
          codes.push(code);
          for (let index = 1; index <= beds; index += 1)
            codes.push(`${code}-B${index}`);
        }
      } else {
        codes.push(...expanded.codes);
      }
    } else if (group.template_code === 'SUITE') {
      entry.compositions += expanded.codes.length;
    } else if (group.template_code === 'ROOM') {
      entry.rooms += expanded.codes.length;
      codes.push(...expanded.codes);
    } else if (group.template_code === 'SITE') {
      entry.sites += expanded.codes.length;
      codes.push(...expanded.codes);
    } else {
      codes.push(...expanded.codes);
    }
    byTemplate.set(group.template_code, entry);
  }
  return {
    totalUnits: codes.length,
    totalCompositions: [...byTemplate.values()].reduce(
      (total, entry) => total + entry.compositions,
      0,
    ),
    codes,
    excluded,
    byTemplate: [...byTemplate.entries()].map(([templateCode, counts]) => ({
      templateCode,
      ...counts,
    })),
  };
}

export function setupPreviewWarnings(input: SetupDraftInput): SetupIssue[] {
  const warnings: SetupIssue[] = [];
  (input.unit_groups ?? []).forEach((group, index) => {
    if (group.template_code !== 'VILLA' && group.template_code !== 'APARTMENT')
      return;
    if (
      group.rental_mode === 'WHOLE_OR_PARTS' &&
      (group.parts ?? []).length > 0
    )
      return;
    warnings.push(
      issue(
        'parts_not_defined',
        'UNITS',
        'room count is not declared by the user and is not inferred',
        { group_index: index, field: 'template_code' },
      ),
    );
  });
  return warnings;
}

export function setupReadinessIssues(input: SetupDraftInput): SetupIssue[] {
  const issues: SetupIssue[] = [...validateSetupDraftInput(input)];
  const property = input.property ?? {};
  if (!property.name || property.name.trim() === '')
    issues.push(issue('name_required', 'PROPERTY', 'name is required'));
  if (!property.timezone)
    issues.push(issue('timezone_required', 'PROPERTY', 'timezone is required'));
  if (!property.base_currency)
    issues.push(
      issue('currency_required', 'PROPERTY', 'base currency is required'),
    );
  if (!property.types || property.types.length === 0)
    issues.push(issue('types_required', 'PROPERTY', 'types are required'));
  if (!input.unit_groups || input.unit_groups.length === 0)
    issues.push(issue('units_required', 'UNITS', 'one unit group is required'));
  for (const [index, group] of (input.unit_groups ?? []).entries()) {
    if (!group.rental_mode)
      issues.push(
        issue('mode_required', 'RENTAL', 'rental mode is required', {
          group_index: index,
        }),
      );
    if (!group.pattern || group.pattern.trim() === '')
      issues.push(
        issue('pattern_required', 'UNITS', 'unit numbers are required', {
          group_index: index,
        }),
      );
    if (group.rental_mode === 'WHOLE_OR_PARTS' && group.privacy_ack !== true)
      issues.push(
        issue(
          'privacy_required',
          'RENTAL',
          'privacy acknowledgment is required',
          { group_index: index },
        ),
      );
    if (group.rental_mode === 'BEDS') {
      if (!group.sharing_scope)
        issues.push(
          issue('scope_required', 'RENTAL', 'sharing scope is required', {
            group_index: index,
          }),
        );
      if (!group.beds_per_unit)
        issues.push(
          issue('beds_required', 'RENTAL', 'beds per unit is required', {
            group_index: index,
          }),
        );
    }
    const template = setupTemplateFor(group.template_code);
    if (
      template?.supportsParts === true &&
      group.rental_mode === 'WHOLE_OR_PARTS' &&
      (group.parts ?? []).length === 0
    )
      issues.push(
        issue('parts_required', 'RENTAL', 'at least one part is required', {
          group_index: index,
          field: 'parts',
        }),
      );
    if (
      template?.supportsParts === true &&
      group.rental_mode === 'WHOLE_OR_PARTS' &&
      (group.parts ?? []).length > 0
    ) {
      const wholeCapacity = group.capacity ?? template.defaultCapacity ?? null;
      const parts = group.parts ?? [];
      const declared = parts.every(
        (part) => part.capacity !== undefined && part.capacity !== null,
      );
      if (wholeCapacity !== null && declared) {
        const sum = parts.reduce(
          (total, part) => total + (part.capacity ?? 0),
          0,
        );
        if (sum < wholeCapacity)
          issues.push(
            issue(
              'capacity_exceeds_parts',
              'RENTAL',
              'whole capacity exceeds the declared part capacities',
              { group_index: index, field: 'parts' },
            ),
          );
      }
    }
    if (
      group.template_code === 'SUITE' &&
      (group.connected_codes ?? []).length < 2
    )
      issues.push(
        issue(
          'connections_required',
          'RENTAL',
          'a suite connects at least two existing units',
          { group_index: index, field: 'connected_codes' },
        ),
      );
  }
  const operations = input.operations ?? {};
  if (!operations.check_in || !operations.check_out)
    issues.push(
      issue('times_required', 'OPERATIONS', 'check times are required'),
    );
  if (operations.explicit_states !== true)
    issues.push(
      issue(
        'explicit_states_required',
        'OPERATIONS',
        'explicit readiness is required',
      ),
    );
  const pricing = input.pricing;
  if (!pricing || !pricing.postponed) {
    if (!pricing?.plan_name)
      issues.push(issue('price_required', 'PRICING', 'rate plan is required'));
    if (!pricing?.sell_from || !pricing.sell_to)
      issues.push(
        issue('period_required', 'PRICING', 'sellable period is required'),
      );
    if (!pricing?.base_price)
      issues.push(issue('price_required', 'PRICING', 'base price is required'));
  }
  return issues;
}

export function normalizeSetupDraftInput(
  input: SetupDraftInput,
): SetupDraftInput {
  return {
    property: {
      name: input.property?.name?.trim() ?? null,
      code: input.property?.code?.trim() ?? null,
      country: input.property?.country?.trim() ?? null,
      timezone: input.property?.timezone ?? null,
      base_currency: input.property?.base_currency ?? null,
      types: [...(input.property?.types ?? [])],
    },
    unit_groups: input.unit_groups.map((group) => ({
      id: group.id ?? null,
      template_code: group.template_code,
      pattern: group.pattern.trim(),
      exclusions: [...(group.exclusions ?? [])].map((value) => value.trim()),
      capacity: group.capacity ?? null,
      location_code: group.location_code?.trim() ?? null,
      rental_mode: group.rental_mode,
      privacy_ack: group.privacy_ack === true,
      sharing_scope: group.sharing_scope ?? null,
      beds_per_unit: group.beds_per_unit ?? null,
      guaranteed_specs: [...(group.guaranteed_specs ?? [])],
      parts: (group.parts ?? []).map((part) => ({
        label: (part.label ?? '').trim().toUpperCase(),
        capacity: part.capacity ?? null,
      })),
      connected_codes: [...(group.connected_codes ?? [])].map((code) =>
        code.trim(),
      ),
    })),
    operations: {
      check_in: input.operations.check_in ?? null,
      check_out: input.operations.check_out ?? null,
      inspection_required: input.operations.inspection_required === true,
      explicit_states: input.operations.explicit_states === true,
    },
    pricing: input.pricing
      ? {
          postponed: input.pricing.postponed === true,
          plan_name: input.pricing.plan_name?.trim() ?? null,
          sell_from: input.pricing.sell_from ?? null,
          sell_to: input.pricing.sell_to ?? null,
          base_price: input.pricing.base_price ?? null,
        }
      : null,
  };
}
