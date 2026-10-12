import { test, expect } from '@jest/globals';
import {
  mergeLocationPath,
  locationLabel,
} from '../apps/web/src/property/structure-locations.js';
import type { LocationNode } from '../apps/web/src/property/LocationBrowser.js';
const building: LocationNode = {
  id: 'building',
  version: 1,
  code: 'B',
  name: 'Building',
  status: 'ACTIVE',
};
const floor: LocationNode = {
  id: 'floor',
  version: 1,
  code: 'F',
  name: 'Floor',
  status: 'ACTIVE',
  parent_id: 'building',
};
test('existing child imports its ancestors once and preserves references on refresh', () => {
  const first = mergeLocationPath([], [building, floor]);
  const second = mergeLocationPath(first, [
    building,
    { ...floor, name: 'Floor renamed' },
  ]);
  expect(second).toHaveLength(2);
  expect(second[1]?.parent_ref).toBe(second[0]?.client_ref);
  expect(second[1]?.client_ref).toBe(first[1]?.client_ref);
  expect(locationLabel(second, second[1]!.client_ref)).toBe(
    'Building / Floor renamed',
  );
});
test('incomplete ancestor path cannot silently attach a nested location at root', () => {
  expect(() => mergeLocationPath([], [floor])).toThrow(
    'Incomplete location path',
  );
});
test('draft cycle cannot hang path rendering', () => {
  const locations = mergeLocationPath([], [building, floor]);
  locations[0]!.parent_ref = locations[1]!.client_ref;
  expect(locationLabel(locations, locations[1]!.client_ref)).toBe(
    'Building / Floor',
  );
});
