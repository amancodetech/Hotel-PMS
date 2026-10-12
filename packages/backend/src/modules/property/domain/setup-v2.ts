import { z } from 'zod';
import type { SetComponents } from '@hotel/contracts';
import type { SetupDraftInput } from './setup.js';
import { expandSetupPattern } from './setup.js';
import { PropertyError } from './errors.js';

export type SetupDraftInputV2 = SetComponents['schemas']['SetupDraftInputV2'];
export type VersionedSetupInput = SetupDraftInput | SetupDraftInputV2;
const ref = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const code = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9-]+$/);
const capacity = z.number().int().min(1).max(100).nullable().optional();
const details = z
  .object({
    bedrooms_count: z.number().int().min(0).max(100).optional(),
    bathrooms_count: z.number().int().min(0).max(100).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();
const text = (max: number) => z.string().max(max).nullable().optional();
const date = z.iso.date().nullable().optional();
const physicalTemplate = z.enum([
  'ROOM',
  'VILLA',
  'APARTMENT',
  'CABIN',
  'TENT',
  'HOUSE',
  'SITE',
  'DORM',
  'SUITE_STANDALONE',
  'SUITE_CONNECTED',
]);
const group = z
  .object({
    group_ref: ref,
    legacy_id: text(64),
    physical_template: physicalTemplate,
    booking_mode: z
      .enum([
        'WHOLE_ONLY',
        'PARTS_ONLY',
        'WHOLE_AND_PARTS',
        'BEDS_ONLY',
        'BEDS_AND_PRIVATE',
        'CONNECTED_UNITS',
      ])
      .nullable()
      .optional(),
    selection_mode: z.enum(['EXACT', 'CATEGORY']).nullable().optional(),
    location_ref: ref.nullable().optional(),
    units: z
      .array(
        z
          .object({
            unit_ref: ref,
            code,
            display_label: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(2000)
      .optional(),
    pattern: z.string().max(32).optional(),
    exclusions: z.array(z.string().max(16)).max(200).optional(),
    capacity,
    details: details.optional(),
    privacy_ack: z.boolean().optional(),
    sharing_scope: z.literal('MIXED').nullable().optional(),
    beds_per_unit: z.number().int().min(1).max(50).nullable().optional(),
    beds: z
      .array(
        z
          .object({
            bed_ref: ref,
            code: code.max(16),
            display_label: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    guaranteed_specs: z
      .array(z.enum(['KING', 'TWIN']))
      .max(2)
      .optional(),
    parts: z
      .array(
        z
          .object({
            part_ref: ref,
            code: code.max(16),
            display_label: z.string().min(1).max(120),
            capacity,
            details: details.optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    connected_resource_ids: z.array(z.string().uuid()).max(20).optional(),
    connection_ack: z.boolean().optional(),
    effective_from: date,
    effective_to: date,
  })
  .strict();
export const setupDraftV2Schema = z
  .object({
    schema_version: z.literal(2),
    property: z
      .object({
        name: z.string().min(2).max(120).nullable().optional(),
        code: text(20),
        country: text(60),
        timezone: z
          .enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'])
          .nullable()
          .optional(),
        base_currency: z.enum(['IDR', 'USD']).nullable().optional(),
        types: z
          .array(
            z.enum([
              'ROOM',
              'CABIN',
              'TENT',
              'VILLA',
              'APARTMENT',
              'DORM',
              'SITE',
              'SUITE',
            ]),
          )
          .max(8)
          .optional(),
      })
      .strict(),
    locations: z
      .array(
        z
          .object({
            client_ref: ref,
            existing_location_id: z.string().uuid().optional(),
            parent_ref: ref.nullable().optional(),
            code,
            name: z.string().min(1).max(120),
            kind: z
              .enum([
                'ZONE',
                'BUILDING',
                'WING',
                'FLOOR',
                'CLUSTER',
                'SERVICE_AREA',
              ])
              .nullable(),
            display_order: z.number().int().min(0).max(2147483647),
          })
          .strict(),
      )
      .max(200),
    unit_groups: z.array(group).max(20),
    operations: z
      .object({
        check_in: z
          .string()
          .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
          .nullable()
          .optional(),
        check_out: z
          .string()
          .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
          .nullable()
          .optional(),
        inspection_required: z.boolean().optional(),
        explicit_states: z.boolean().optional(),
      })
      .strict(),
    pricing: z
      .object({
        postponed: z.boolean(),
        plan_name: text(80),
        sell_from: date,
        sell_to: date,
        base_price: z
          .string()
          .regex(/^[0-9]{1,14}(\.[0-9]{1,6})?$/)
          .nullable()
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export function isSetupV2(
  input: VersionedSetupInput,
): input is SetupDraftInputV2 {
  return 'schema_version' in input && input.schema_version === 2;
}
export function requireLegacySetup(
  input: VersionedSetupInput,
): asserts input is SetupDraftInput {
  if (isSetupV2(input))
    throw new PropertyError('SETUP_MODE_UNSUPPORTED', {
      reason: 'v2_execution_pending',
    });
}

export function parseSetupV2(input: unknown): SetupDraftInputV2 {
  const parsed = setupDraftV2Schema.safeParse(input);
  if (!parsed.success)
    throw new PropertyError('SETUP_DRAFT_INVALID', {
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        field_path: issue.path.join('.'),
      })),
    });
  const value = parsed.data;
  const issues: Array<{
    code: string;
    field_path: string;
    group_ref?: string;
  }> = [];
  const issue = (path: string, reason: string, groupRef?: string) =>
    issues.push({
      code: reason,
      field_path: path,
      ...(groupRef ? { group_ref: groupRef } : {}),
    });
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) issue(path, 'duplicate');
  };
  unique(
    value.locations.map((l) => l.client_ref),
    'locations',
  );
  unique(
    value.locations.map((l) => l.code.toUpperCase()),
    'locations.code',
  );
  unique(
    value.locations.flatMap((l) =>
      l.existing_location_id ? [l.existing_location_id] : [],
    ),
    'locations.existing_location_id',
  );
  unique(
    value.unit_groups.map((g) => g.group_ref),
    'unit_groups',
  );
  const locations = new Map(value.locations.map((l) => [l.client_ref, l]));
  for (const location of value.locations) {
    const seen = new Set<string>([location.client_ref]);
    let parent = location.parent_ref;
    while (parent) {
      if (!locations.has(parent)) {
        issue('locations.parent_ref', 'missing_reference');
        break;
      }
      if (seen.has(parent)) {
        issue('locations.parent_ref', 'cycle');
        break;
      }
      seen.add(parent);
      parent = locations.get(parent)!.parent_ref;
    }
  }
  const codes: string[] = [];
  for (const [index, g] of value.unit_groups.entries()) {
    const path = `unit_groups.${index}`;
    if (g.units !== undefined && g.pattern !== undefined)
      issue(path, 'units_and_pattern', g.group_ref);
    if (g.beds !== undefined && g.beds_per_unit !== undefined)
      issue(path, 'beds_and_count', g.group_ref);
    if (g.location_ref && !locations.has(g.location_ref))
      issue(`${path}.location_ref`, 'missing_reference', g.group_ref);
    if (g.units) {
      unique(
        g.units.map((u) => u.unit_ref),
        `${path}.units`,
      );
      codes.push(...g.units.map((u) => u.code.toUpperCase()));
    }
    if (g.pattern) {
      const expanded = expandSetupPattern(g.pattern);
      if (expanded.invalid)
        issue(`${path}.pattern`, 'pattern_invalid', g.group_ref);
      if (g.exclusions?.some((c) => !expanded.codes.includes(c)))
        issue(`${path}.exclusions`, 'exclusion_outside', g.group_ref);
      codes.push(...expanded.codes.filter((c) => !g.exclusions?.includes(c)));
    }
    if (g.exclusions?.length && g.pattern === undefined)
      issue(`${path}.exclusions`, 'pattern_required', g.group_ref);
    unique(
      (g.parts ?? []).map((p) => p.part_ref),
      `${path}.parts`,
    );
    unique(
      (g.parts ?? []).map((p) => p.code.toUpperCase()),
      `${path}.parts.code`,
    );
    unique(
      (g.beds ?? []).map((b) => b.bed_ref),
      `${path}.beds`,
    );
    unique(
      (g.beds ?? []).map((b) => b.code.toUpperCase()),
      `${path}.beds.code`,
    );
    unique(g.connected_resource_ids ?? [], `${path}.connected_resource_ids`);
    if (g.effective_from && g.effective_to && g.effective_to < g.effective_from)
      issue(path, 'period_invalid', g.group_ref);
    const mode = g.booking_mode;
    if (!mode) continue; // Incomplete drafts are supported.
    const beds = mode === 'BEDS_ONLY' || mode === 'BEDS_AND_PRIVATE';
    const parts = mode === 'PARTS_ONLY' || mode === 'WHOLE_AND_PARTS';
    const connected = mode === 'CONNECTED_UNITS';
    if (
      (g.physical_template === 'DORM') !== beds ||
      (g.physical_template === 'SUITE_CONNECTED') !== connected ||
      (parts && !['VILLA', 'APARTMENT', 'HOUSE'].includes(g.physical_template))
    )
      issue(path, 'template_mode_mismatch', g.group_ref);
    if ((parts || connected) && g.selection_mode === 'CATEGORY')
      issue(path, 'selection_unsupported', g.group_ref);
    if (beds && g.selection_mode === 'EXACT')
      issue(path, 'selection_unsupported', g.group_ref);
    if (!parts && g.parts?.length)
      issue(path, 'parts_not_allowed', g.group_ref);
    if (
      !beds &&
      (g.beds?.length || g.beds_per_unit != null || g.sharing_scope != null)
    )
      issue(path, 'beds_not_allowed', g.group_ref);
    if (!connected && g.connected_resource_ids?.length)
      issue(path, 'connections_not_allowed', g.group_ref);
  }
  unique(codes, 'unit_groups.codes');
  if (issues.length) throw new PropertyError('SETUP_DRAFT_INVALID', { issues });
  return value;
}

/** Canonicalize sets for idempotency only; never reorder the saved user input.
 * Group/unit/part/bed order is presentation order and remains meaningful.
 */
export function setupV2HashInput(input: SetupDraftInputV2): SetupDraftInputV2 {
  const result = structuredClone(input);
  result.locations.sort((a, b) =>
    a.client_ref < b.client_ref ? -1 : a.client_ref > b.client_ref ? 1 : 0,
  );
  for (const group of result.unit_groups) {
    group.exclusions?.sort();
    group.connected_resource_ids?.sort();
    group.guaranteed_specs?.sort();
  }
  return result;
}
