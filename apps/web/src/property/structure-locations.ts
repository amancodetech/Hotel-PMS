import type { SetupDraftInputV2 } from '../api/setup.js';
import type { LocationNode } from './LocationBrowser.js';
type DraftLocation = SetupDraftInputV2['locations'][number];

/** Preserve stable draft references and include every ancestor required by scoped validation. */
export function mergeLocationPath(
  current: DraftLocation[],
  path: LocationNode[],
): DraftLocation[] {
  const next = [...current];
  for (const node of path) {
    const index = next.findIndex((l) => l.existing_location_id === node.id);
    const value: DraftLocation = {
      client_ref: index >= 0 ? next[index]!.client_ref : crypto.randomUUID(),
      existing_location_id: node.id,
      code: node.code,
      name: node.name,
      kind: node.kind ?? null,
      display_order: node.display_order ?? 0,
      parent_ref: node.parent_id
        ? (next.find((l) => l.existing_location_id === node.parent_id)
            ?.client_ref ?? null)
        : null,
    };
    if (node.parent_id && !value.parent_ref)
      throw new Error('Incomplete location path');
    if (index >= 0) next[index] = value;
    else next.push(value);
  }
  return next;
}

export function locationLabel(locations: DraftLocation[], ref: string): string {
  const path: string[] = [];
  const seen = new Set<string>();
  let node = locations.find((l) => l.client_ref === ref);
  while (node && !seen.has(node.client_ref)) {
    seen.add(node.client_ref);
    path.unshift(node.name || node.code);
    node = locations.find((l) => l.client_ref === node!.parent_ref);
  }
  return path.join(' / ');
}
