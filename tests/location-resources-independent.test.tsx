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

test('independent: failed later subtree page hides empty and partial rooms until explicit retry', async () => {
  let fail = true;
  jest.spyOn(propertyApi, 'listResourcePage').mockResolvedValue({
    items: [room('DIRECT', floor.id), room('DESCENDANT', villa.id)],
    next_cursor: null,
  });
  jest
    .mocked(propertyApi.listLocationChildren)
    .mockImplementation(async (_t, _p, options = {}) => {
      if (options.parent_id !== floor.id)
        return { items: [], ancestors: [floor, villa], next_cursor: null };
      if (!options.cursor)
        return { items: [], ancestors: [floor], next_cursor: 'tail' };
      if (fail) throw new ApiError('INTERNAL_ERROR', 500, {});
      return { items: [villa], ancestors: [floor], next_cursor: null };
    });
  await mount();
  const retry = await screen.findByRole('button', {
    name: 'Reload rooms and locations',
  });
  expect(screen.queryByText('Room DIRECT')).not.toBeInTheDocument();
  expect(screen.queryByText(/Room count:/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      'No rooms are linked to this location or its descendants.',
    ),
  ).not.toBeInTheDocument();
  fail = false;
  await userEvent.click(retry);
  expect(await screen.findByText('Room DESCENDANT')).toBeVisible();
  expect(screen.getByText('Room DIRECT')).toBeVisible();
  expect(screen.getByText('Room count: 2')).toBeVisible();
});

test('independent: tenant/property switch never reuses same-location-id cached rooms', async () => {
  const i18n = createI18n('en-US');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let release!: (value: { items: Resource[]; next_cursor: null }) => void;
  const delayed = new Promise<{ items: Resource[]; next_cursor: null }>(
    (resolve) => {
      release = resolve;
    },
  );
  const list = jest
    .spyOn(propertyApi, 'listResourcePage')
    .mockImplementation(async (tenant, property) => {
      if (tenant === 'tenant-a' && property === 'property-a')
        return { items: [room('OLD', floor.id)], next_cursor: null };
      return delayed;
    });
  const view = (tenantId: string, propertyId: string) => (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <LocationResourcesPanel
          tenantId={tenantId}
          propertyId={propertyId}
          path={[floor]}
        />
      </I18nextProvider>
    </QueryClientProvider>
  );
  const rendered = render(view('tenant-a', 'property-a'));
  expect(await screen.findByText('Room OLD')).toBeVisible();
  rendered.rerender(view('tenant-b', 'property-b'));
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith('tenant-b', 'property-b', null, {
      limit: 100,
    }),
  );
  expect(screen.queryByText('Room OLD')).not.toBeInTheDocument();
  expect(screen.queryByText(/Room count:/)).not.toBeInTheDocument();
  release({ items: [room('NEW', floor.id)], next_cursor: null });
  expect(await screen.findByText('Room NEW')).toBeVisible();
  expect(screen.queryByText('Room OLD')).not.toBeInTheDocument();
  expect(propertyApi.listLocationChildren).toHaveBeenCalledWith(
    'tenant-b',
    'property-b',
    expect.objectContaining({ parent_id: floor.id }),
  );
});
