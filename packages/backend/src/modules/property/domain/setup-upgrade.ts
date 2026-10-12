import type { SetComponents } from '@hotel/contracts';
import {
  expandSetupGroup,
  validateSetupDraftInput,
  type SetupDraftInput,
} from './setup.js';

type InputV2 = SetComponents['schemas']['SetupDraftInputV2'];
type Issue = SetComponents['schemas']['SetupIssueV2'];

export type SetupUpgradeProposal =
  | {
      status: 'READ_ONLY';
      original: SetupDraftInput;
      candidate: null;
      issues: [];
    }
  | {
      status: 'REVIEW_REQUIRED';
      original: SetupDraftInput;
      candidate: null;
      issues: Issue[];
    }
  | {
      status: 'PROPOSED';
      original: SetupDraftInput;
      candidate: InputV2;
      issues: [];
    };

/** Pure proposal for a validated v1 draft. Never saves, resolves IDs or executes inventory.
 * A proposal still requires v2 DTO validation, readiness and scoped reference checks.
 */
export function proposeSetupDraftUpgrade(
  input: SetupDraftInput,
  completed: boolean,
): SetupUpgradeProposal {
  const original = structuredClone(input);
  if (completed)
    return { status: 'READ_ONLY', original, candidate: null, issues: [] };
  const issues: Issue[] = validateSetupDraftInput(input).map((issue) => ({
    code: 'LEGACY_INPUT_REVIEW_REQUIRED',
    field_path:
      issue.group_index === undefined
        ? (issue.field ?? issue.step.toLowerCase())
        : `unit_groups.${issue.group_index}.${issue.field ?? ''}`,
    ...(issue.group_index === undefined
      ? {}
      : { group_ref: `legacy-${issue.group_index + 1}` }),
  }));
  const candidate: InputV2 = {
    schema_version: 2,
    property: structuredClone(input.property),
    locations: [],
    unit_groups: [],
    operations: structuredClone(input.operations),
    ...(input.pricing === undefined
      ? {}
      : { pricing: structuredClone(input.pricing) }),
  };
  input.unit_groups.forEach((group, index) => {
    const groupRef = `legacy-${index + 1}`;
    const problem = (code: string, field: string) =>
      issues.push({
        code,
        field_path: `unit_groups.${index}.${field}`,
        group_ref: groupRef,
      });
    if (group.location_code)
      problem('LOCATION_RESOLUTION_REQUIRED', 'location_code');
    if (group.template_code === 'SUITE') {
      problem('CONNECTED_RESOURCE_RESOLUTION_REQUIRED', 'connected_codes');
      return;
    }
    const isBeds =
      group.template_code === 'DORM' && group.rental_mode === 'BEDS';
    const isParts =
      (group.template_code === 'VILLA' ||
        group.template_code === 'APARTMENT') &&
      group.rental_mode === 'WHOLE_OR_PARTS';
    if (
      !isBeds &&
      !isParts &&
      (group.rental_mode !== 'EXCLUSIVE' || group.template_code === 'DORM')
    ) {
      problem('LEGACY_MODE_REVIEW_REQUIRED', 'rental_mode');
    }
    // Old defaults must not become silent v2 capacities. Preserve null/omitted and
    // require an explicit user decision before converting the draft.
    if (!isBeds && group.capacity == null)
      problem('LEGACY_CAPACITY_REVIEW_REQUIRED', 'capacity');
    if (isParts && (group.parts ?? []).some((part) => part.capacity == null)) {
      problem('LEGACY_CAPACITY_REVIEW_REQUIRED', 'parts');
    }
    if (isBeds && expandSetupGroup(group).codes.length !== 1) {
      problem('LEGACY_CROSS_ROOM_BED_POOL', 'pattern');
    }
    if (isBeds && group.capacity !== group.beds_per_unit) {
      problem('LEGACY_PRIVATE_CAPACITY_REVIEW_REQUIRED', 'capacity');
    }
    if (group.sharing_scope && group.sharing_scope !== 'MIXED') {
      problem('RESTRICTED_SHARING_UNSUPPORTED', 'sharing_scope');
    }
    // v1 ignored non-empty fields for other modes. Do not silently lose them.
    if (!isParts && (group.parts ?? []).length)
      problem('UNUSED_LEGACY_PARTS', 'parts');
    if ((group.connected_codes ?? []).length)
      problem('UNUSED_LEGACY_CONNECTIONS', 'connected_codes');
    if (!isBeds && group.beds_per_unit != null)
      problem('UNUSED_LEGACY_BEDS', 'beds_per_unit');
    candidate.unit_groups.push({
      group_ref: groupRef,
      ...(group.id === undefined ? {} : { legacy_id: group.id }),
      physical_template: group.template_code,
      booking_mode: isBeds
        ? 'BEDS_AND_PRIVATE'
        : isParts
          ? 'WHOLE_AND_PARTS'
          : 'WHOLE_ONLY',
      // EXCLUSIVE v1 created one category product per group, even for one unit.
      selection_mode: isParts ? 'EXACT' : 'CATEGORY',
      pattern: group.pattern,
      ...(group.exclusions === undefined
        ? {}
        : { exclusions: [...group.exclusions] }),
      ...(group.capacity === undefined ? {} : { capacity: group.capacity }),
      ...(group.privacy_ack === undefined
        ? {}
        : { privacy_ack: group.privacy_ack }),
      ...(group.sharing_scope === undefined
        ? {}
        : { sharing_scope: group.sharing_scope === 'MIXED' ? 'MIXED' : null }),
      ...(group.beds_per_unit === undefined
        ? {}
        : { beds_per_unit: group.beds_per_unit }),
      ...(group.guaranteed_specs === undefined
        ? {}
        : { guaranteed_specs: [...group.guaranteed_specs] }),
      ...(group.parts === undefined
        ? {}
        : {
            parts: group.parts.map((part, partIndex) => ({
              part_ref: `${groupRef}-part-${partIndex + 1}`,
              code: part.label.trim().toUpperCase(),
              display_label: part.label,
              ...(part.capacity === undefined
                ? {}
                : { capacity: part.capacity }),
            })),
          }),
    });
  });
  if (issues.length)
    return { status: 'REVIEW_REQUIRED', original, candidate: null, issues };
  return { status: 'PROPOSED', original, candidate, issues: [] };
}
