import { PropertyError } from './errors.js';
import type { ResourceKind } from './lifecycle.js';
import { expandSetupPattern } from './setup.js';
import { parseSetupV2, type SetupDraftInputV2 } from './setup-v2.js';

type Group = SetupDraftInputV2['unit_groups'][number];
type Details = NonNullable<Group['details']>;
export interface SetupPlanResource {
  code: string;
  displayLabel: string;
  kind: ResourceKind;
  capacity: number;
  parentCode: string | null;
  locationRef: string | null;
  details: Details;
  groupRef: string;
  sellable: boolean;
}
export type SetupPlanReference =
  { code: string } | { existingResourceId: string };
export interface SetupPlanProduct {
  key: string;
  groupRef: string;
  capacity: number;
  kind: ResourceKind;
  candidates: SetupPlanReference[];
  leaves: SetupPlanReference[];
  sharingScope: 'MIXED' | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}
export interface SetupPlanIssue {
  code: string;
  field_path: string;
  group_ref: string;
}
export interface SetupPlanV2 {
  resources: SetupPlanResource[];
  products: SetupPlanProduct[];
  blockers: SetupPlanIssue[];
  counts: {
    resources: number;
    sellableResources: number;
    containers: number;
    products: number;
    compositions: number;
    leaves: number;
    candidates: number;
  };
}

/** Pure inventory plan, not authorization, availability or permission to apply.
 * References to existing resources must be resolved under the property lock.
 * A blocked plan deliberately contains no executable writes.
 */
export function buildSetupPlanV2(source: unknown): SetupPlanV2 {
  const input = parseSetupV2(source);
  const resources: SetupPlanResource[] = [];
  const products: SetupPlanProduct[] = [];
  const blockers: SetupPlanIssue[] = [];
  const allCodes = new Set<string>();
  for (const [index, group] of input.unit_groups.entries()) {
    const path = `unit_groups.${index}`;
    const block = (field: string, code: string) =>
      blockers.push({
        code,
        field_path: `${path}.${field}`,
        group_ref: group.group_ref,
      });
    const mode = group.booking_mode;
    if (!mode) block('booking_mode', 'required');
    if (!group.selection_mode) block('selection_mode', 'required');
    const units =
      group.units ??
      (group.pattern
        ? expandSetupPattern(group.pattern)
            .codes.filter((code) => !group.exclusions?.includes(code))
            .map((code) => ({ code, display_label: code, unit_ref: code }))
        : []);
    if (mode !== 'CONNECTED_UNITS' && !units.length) block('units', 'required');
    const parts = mode === 'PARTS_ONLY' || mode === 'WHOLE_AND_PARTS';
    const beds = mode === 'BEDS_ONLY' || mode === 'BEDS_AND_PRIVATE';
    const composite =
      mode === 'WHOLE_AND_PARTS' ||
      mode === 'BEDS_AND_PRIVATE' ||
      mode === 'CONNECTED_UNITS';
    if (mode !== 'PARTS_ONLY' && mode !== 'BEDS_ONLY' && group.capacity == null)
      block('capacity', 'required');
    if (parts && !group.parts?.length) block('parts', 'required');
    for (const [partIndex, part] of (group.parts ?? []).entries())
      if (part.capacity == null)
        block(`parts.${partIndex}.capacity`, 'required');
    if (mode === 'WHOLE_AND_PARTS' && group.privacy_ack !== true)
      block('privacy_ack', 'required');
    if (beds && !group.sharing_scope) block('sharing_scope', 'required');
    if (beds && !group.beds?.length && !group.beds_per_unit)
      block('beds', 'required');
    if (composite && !group.effective_from) block('effective_from', 'required');
    if (mode === 'CONNECTED_UNITS') {
      if ((group.connected_resource_ids?.length ?? 0) < 2)
        block('connected_resource_ids', 'minimum_two');
      if (group.connection_ack !== true) block('connection_ack', 'required');
      if (units.length) block('units', 'connections_do_not_create_units');
    }
    // Drafts may be incomplete. Never substitute a guessed sellable capacity.
    if (blockers.some((issue) => issue.group_ref === group.group_ref)) continue;
    const kind: ResourceKind =
      group.physical_template === 'SUITE_STANDALONE' ||
      group.physical_template === 'SUITE_CONNECTED' ||
      group.physical_template === 'DORM'
        ? 'ROOM'
        : group.physical_template;
    const resource = (
      code: string,
      label: string,
      resourceKind: ResourceKind,
      capacity: number,
      parentCode: string | null,
      sellable: boolean,
      details: Details = {},
    ): SetupPlanReference => {
      const canonical = code.toUpperCase();
      if (code.length > 40) block('units', 'generated_code_too_long');
      if (allCodes.has(canonical)) block('units', 'generated_code_duplicate');
      allCodes.add(canonical);
      resources.push({
        code,
        displayLabel: label,
        kind: resourceKind,
        capacity,
        parentCode,
        sellable,
        details: structuredClone(details),
        locationRef: group.location_ref ?? null,
        groupRef: group.group_ref,
      });
      return { code };
    };
    const product = (
      key: string,
      capacity: number,
      productKind: ResourceKind,
      candidates: SetupPlanReference[],
      leaves: SetupPlanReference[] = [],
      sharingScope: 'MIXED' | null = null,
    ) =>
      products.push({
        key: `${group.group_ref}:${key}`,
        groupRef: group.group_ref,
        capacity,
        kind: productKind,
        candidates,
        leaves,
        sharingScope,
        effectiveFrom: leaves.length ? group.effective_from! : null,
        effectiveTo: leaves.length ? (group.effective_to ?? null) : null,
      });
    if (mode === 'CONNECTED_UNITS') {
      product(
        'connected',
        group.capacity!,
        'ROOM',
        [],
        group.connected_resource_ids!.map((existingResourceId) => ({
          existingResourceId,
        })),
      );
      continue;
    }
    const category: SetupPlanReference[] = [];
    for (const unit of units) {
      if (parts || beds) {
        const children = parts
          ? group.parts!
          : (group.beds ??
            Array.from({ length: group.beds_per_unit! }, (_, i) => ({
              code: `B${i + 1}`,
              display_label: `B${i + 1}`,
            })));
        // Containment identity only. No product ever points at this parent.
        const containerCapacity = parts
          ? Math.max(...group.parts!.map((part) => part.capacity!))
          : children.length;
        resource(
          unit.code,
          unit.display_label,
          kind,
          group.capacity ?? containerCapacity,
          null,
          false,
          group.details,
        );
        const leaves: SetupPlanReference[] = [];
        for (const child of children) {
          const part = parts
            ? group.parts!.find((p) => p.code === child.code)!
            : null;
          const leaf = resource(
            `${unit.code}-${child.code}`,
            child.display_label,
            beds ? 'BED' : 'ROOM',
            part?.capacity ?? 1,
            unit.code,
            true,
            part?.details,
          );
          leaves.push(leaf);
          if (parts)
            product(`${unit.code}-${child.code}`, part!.capacity!, 'ROOM', [
              leaf,
            ]);
        }
        if (beds) product(`${unit.code}:beds`, 1, 'BED', leaves, [], 'MIXED');
        if (composite)
          product(`${unit.code}:whole`, group.capacity!, kind, [], leaves);
      } else {
        const ref = resource(
          unit.code,
          unit.display_label,
          kind,
          group.capacity!,
          null,
          true,
          group.details,
        );
        if (group.selection_mode === 'CATEGORY') category.push(ref);
        else product(unit.code, group.capacity!, kind, [ref]);
      }
    }
    if (category.length) product('category', group.capacity!, kind, category);
  }
  if (!input.unit_groups.length)
    blockers.push({
      code: 'required',
      field_path: 'unit_groups',
      group_ref: '',
    });
  if (blockers.length) {
    resources.length = 0;
    products.length = 0;
  }
  const containers = resources.filter((resource) => !resource.sellable).length;
  return {
    resources,
    products,
    blockers,
    counts: {
      resources: resources.length,
      sellableResources: resources.length - containers,
      containers,
      products: products.length,
      compositions: products.filter((product) => product.leaves.length > 0)
        .length,
      leaves: products.reduce((sum, product) => sum + product.leaves.length, 0),
      candidates: products.reduce(
        (sum, product) => sum + product.candidates.length,
        0,
      ),
    },
  };
}

export function assertSetupPlanReady(plan: SetupPlanV2): void {
  if (plan.blockers.length)
    throw new PropertyError('SETUP_READINESS_BLOCKED', {
      issues: plan.blockers,
    });
}
