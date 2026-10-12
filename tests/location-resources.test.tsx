/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../packages/i18n/src/index.js';
import { propertyApi } from '../apps/web/src/api/property.js';
import type { Resource } from '../apps/web/src/api/property.js';
import type { LocationNode } from '../apps/web/src/property/LocationBrowser.js';
import { LocationResourcesPanel } from '../apps/web/src/property/LocationResourcesPanel.js';
import { ApiError } from '../apps/web/src/api/client.js';

const floor: LocationNode = {
  id: 'floor',
  version: 1,
  code: 'F2',
  name: 'Second floor',
  parent_id: 'building',
  kind: 'FLOOR',
  status: 'ACTIVE',
  display_order: 2,
};
const villa: LocationNode = {
  ...floor,
  id: 'villa',
  code: 'V12',
  name: 'Villa 12',
  parent_id: floor.id,
  kind: null,
};
const room = (
  id: string,
  location = 'elsewhere',
  type: Resource['type'] = 'ROOM',
): Resource => ({
  id,
  code: id,
  version: 1,
  display_label: `Room ${id}`,
  type,
  capacity: 3,
  state: 'ACTIVE',
  location_id: location,
  parent_resource_id: null,
  housekeeping_state: 'CLEAN',
  maintenance_state: 'NONE',
});
async function mount(path = [floor]) {
  const i18n = createI18n();
  await i18n.changeLanguage('en-US');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <LocationResourcesPanel
          tenantId="tenant"
          propertyId="property"
          path={path}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  jest
    .spyOn(propertyApi, 'listLocationChildren')
    .mockImplementation(async (_tenant, _property, options = {}) => ({
      items: options.parent_id === floor.id ? [villa] : [],
      ancestors: [floor],
      next_cursor: null,
    }));
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('reads past 100 resources and includes rooms under descendant villas while separating containers', async () => {
  const list = jest
    .spyOn(propertyApi, 'listResourcePage')
    .mockImplementation(async (_tenant, _property, cursor) =>
      cursor
        ? {
            items: [
              room('LAST', villa.id),
              room('CONTAINER', villa.id, 'VILLA'),
            ],
            next_cursor: null,
          }
        : {
            items: Array.from({ length: 100 }, (_, i) => room(`OTHER-${i}`)),
            next_cursor: 'page-two',
          },
    );
  await mount();
  expect(await screen.findByText('Room LAST')).toBeVisible();
  expect(screen.getByText('Room count: 1')).toBeVisible();
  expect(screen.getAllByText('Second floor / Villa 12')).toHaveLength(2);
  expect(
    screen.getByText('Villa containers and other units — not additional rooms'),
  ).toBeVisible();
  expect(screen.getByText('Room CONTAINER')).toBeVisible();
  expect(screen.queryByText('Room OTHER-0')).not.toBeInTheDocument();
  expect(list).toHaveBeenNthCalledWith(2, 'tenant', 'property', 'page-two', {
    limit: 100,
  });
});

test('a later resource page error never reports empty rooms and retry loads the missing page', async () => {
  let failed = true;
  jest
    .spyOn(propertyApi, 'listResourcePage')
    .mockImplementation(async (_tenant, _property, cursor) => {
      if (!cursor) return { items: [room('UNRELATED')], next_cursor: 'next' };
      if (failed) throw new ApiError('INTERNAL_ERROR', 500, {});
      return { items: [room('RECOVERED', floor.id)], next_cursor: null };
    });
  await mount();
  const retry = await screen.findByRole('button', {
    name: 'Reload rooms and locations',
  });
  expect(
    screen.queryByText(
      'No rooms are linked to this location or its descendants.',
    ),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Room count:/)).not.toBeInTheDocument();
  failed = false;
  await userEvent.click(retry);
  expect(await screen.findByText('Room RECOVERED')).toBeVisible();
});

test('no empty-room result until descendant location pagination is complete', async () => {
  jest
    .spyOn(propertyApi, 'listResourcePage')
    .mockResolvedValue({ items: [room('DEEP', villa.id)], next_cursor: null });
  let release!: (value: {
    items: LocationNode[];
    ancestors: LocationNode[];
    next_cursor: string | null;
  }) => void;
  const delayed = new Promise<{
    items: LocationNode[];
    ancestors: LocationNode[];
    next_cursor: string | null;
  }>((resolve) => {
    release = resolve;
  });
  jest
    .mocked(propertyApi.listLocationChildren)
    .mockImplementation(async (_tenant, _property, options = {}) => {
      if (options.parent_id === floor.id && !options.cursor)
        return { items: [], ancestors: [floor], next_cursor: 'later' };
      if (options.parent_id === floor.id) return delayed;
      return { items: [], ancestors: [floor, villa], next_cursor: null };
    });
  await mount();
  await waitFor(() =>
    expect(propertyApi.listLocationChildren).toHaveBeenCalledWith(
      'tenant',
      'property',
      expect.objectContaining({ cursor: 'later' }),
    ),
  );
  expect(
    screen.queryByText(
      'No rooms are linked to this location or its descendants.',
    ),
  ).not.toBeInTheDocument();
  release({ items: [villa], ancestors: [floor], next_cursor: null });
  expect(await screen.findByText('Room DEEP')).toBeVisible();
});

test('root prompts for a location and performs no resource or subtree reads', async () => {
  const list = jest.spyOn(propertyApi, 'listResourcePage');
  await mount([]);
  expect(
    screen.getByText('Choose a building, floor or villa to view its rooms.'),
  ).toBeVisible();
  expect(list).not.toHaveBeenCalled();
  expect(propertyApi.listLocationChildren).not.toHaveBeenCalled();
});

test('orders room codes naturally with a stable ID tie without changing cached input', async () => {
  const items = [
    { ...room('ten', floor.id), code: 'KL10' },
    { ...room('two-b', floor.id), code: 'KL2' },
    { ...room('one', floor.id), code: 'KL1' },
    { ...room('two-a', floor.id), code: 'KL2' },
  ];
  jest.spyOn(propertyApi, 'listResourcePage').mockResolvedValue({
    items,
    next_cursor: null,
  });
  await mount();
  await screen.findByText('Room count: 4');
  expect(
    screen
      .getAllByText(/^Room (one|two-a|two-b|ten)$/)
      .map((node) => node.textContent),
  ).toEqual(['Room one', 'Room two-a', 'Room two-b', 'Room ten']);
  expect(items.map((item) => item.id)).toEqual([
    'ten',
    'two-b',
    'one',
    'two-a',
  ]);
});
