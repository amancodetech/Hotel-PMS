import { buildSetupPlanV2 } from './setup-plan-v2.js';
import { expandSetupPattern } from './setup.js';
import type { SetupDraftInputV2 } from './setup-v2.js';

/** Never split a category or a composition: its identity and exclusivity must remain intact. */
export function setupBatchChunks(
  input: SetupDraftInputV2,
  limit: number,
): SetupDraftInputV2[] | null {
  const atoms: SetupDraftInputV2['unit_groups'] = [];
  for (const group of input.unit_groups) {
    if (
      group.booking_mode === 'WHOLE_ONLY' &&
      group.selection_mode === 'EXACT'
    ) {
      const units =
        group.units ??
        expandSetupPattern(group.pattern ?? '')
          .codes.filter((code) => !group.exclusions?.includes(code))
          .map((code) => ({ unit_ref: code, code, display_label: code }));
      for (const unit of units) {
        const { pattern: _pattern, exclusions: _exclusions, ...rest } = group;
        atoms.push({ ...rest, units: [unit] });
      }
    } else atoms.push(group);
  }
  const chunks: SetupDraftInputV2[] = [];
  let groups: SetupDraftInputV2['unit_groups'] = [];
  const cost = (
    candidate: SetupDraftInputV2['unit_groups'],
    first: boolean,
  ) => {
    const p = buildSetupPlanV2({ ...input, unit_groups: candidate });
    return (
      p.counts.resources +
      p.counts.products +
      p.counts.leaves +
      (first
        ? input.locations.filter((l) => !l.existing_location_id).length
        : 0)
    );
  };
  // Merge atoms back into their group to preserve group_ref uniqueness within a request.
  const append = (source: typeof groups, atom: (typeof groups)[number]) => {
    const next = structuredClone(source);
    const match = next.find((g) => g.group_ref === atom.group_ref);
    if (match) match.units = [...(match.units ?? []), ...(atom.units ?? [])];
    else next.push(structuredClone(atom));
    return next;
  };
  for (const atom of atoms) {
    const candidate = append(groups, atom);
    if (cost(candidate, chunks.length === 0) <= limit) {
      groups = candidate;
      continue;
    }
    if (!groups.length) return null;
    chunks.push({ ...structuredClone(input), unit_groups: groups });
    groups = [structuredClone(atom)];
    if (cost(groups, false) > limit) return null;
  }
  if (groups.length)
    chunks.push({ ...structuredClone(input), unit_groups: groups });
  return chunks.length ? chunks : null;
}
