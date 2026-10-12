/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../packages/i18n/src/index.js';
import { AuthProvider } from '../apps/web/src/auth/AuthProvider.js';
import { PropertySetupPage } from '../apps/web/src/property/PropertySetupPage.js';
import { ApiError } from '../apps/web/src/api/client.js';
import { propertyApi } from '../apps/web/src/api/property.js';
import type { LocationNode } from '../apps/web/src/property/LocationBrowser.js';
const pid = '00000000-0000-4000-8000-000000000001';
const building: LocationNode = {
  id: 'building-a',
  version: 1,
  code: 'B1',
  name: 'Building A',
  kind: 'BUILDING',
  parent_id: null,
  display_order: 0,
  status: 'ACTIVE',
};
const first: LocationNode = {
  id: 'floor-a',
  version: 1,
  code: 'F1',
  name: 'First floor',
  kind: 'FLOOR',
  parent_id: building.id,
  display_order: 1,
  status: 'ACTIVE',
};
const second: LocationNode = {
  ...first,
  id: 'floor-b',
  code: 'F2',
  name: 'Second floor',
  display_order: 2,
};
let currentBuilding = building;
beforeEach(() => {
  currentBuilding = building;
  localStorage.clear();
  globalThis.fetch = jest.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            authenticated: true,
            session: {
              id: 'session',
              active_tenant_id: 'tenant-a',
              auth_methods: ['pwd'],
              mfa: false,
            },
            memberships: [],
            permissions: ['property.read', 'property.resource.manage'].map(
              (permission) => ({ permission, granted: true, denied: false }),
            ),
          }),
      }) as Response,
  ) as unknown as typeof fetch;
  jest.spyOn(propertyApi, 'getProperty').mockResolvedValue({
    property: {
      id: pid,
      version: 1,
      code: 'P1',
      name: 'Property A',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      status: 'SETUP',
      inventory_version: 1,
      group_id: null,
      limits_profile_code: 'PERF-01',
    },
  });
  jest
    .spyOn(propertyApi, 'listResourcePage')
    .mockResolvedValue({ items: [], next_cursor: null });
  jest
    .spyOn(propertyApi, 'listLocationChildren')
    .mockImplementation(async (_tenant, _property, options = {}) => {
      if (options.parent_id === building.id)
        return {
          ancestors: [currentBuilding],
          items: options.cursor ? [second] : [first],
          next_cursor: options.cursor ? null : 'page-2',
        };
      if (options.parent_id === first.id || options.parent_id === second.id)
        return {
          ancestors: [
            currentBuilding,
            options.parent_id === first.id ? first : second,
          ],
          items: [],
          next_cursor: null,
        };
      return { ancestors: [], items: [currentBuilding], next_cursor: null };
    });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/properties/${pid}`]}>
        <I18nextProvider i18n={createI18n('en-US')}>
          <AuthProvider>
            <Routes>
              <Route
                path="/properties/:propertyId"
                element={<PropertySetupPage />}
              />
            </Routes>
          </AuthProvider>
        </I18nextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('resource creation selects a nested second-page location and sends its exact id', async () => {
  const user = userEvent.setup();
  const flat = jest.spyOn(propertyApi, 'listLocations');
  const create = jest.spyOn(propertyApi, 'createResource').mockResolvedValue({
    resource: {
      id: 'new-room',
      version: 1,
      code: 'R1',
      type: 'ROOM',
      capacity: 2,
      location_id: second.id,
      state: 'ACTIVE',
      housekeeping_state: 'CLEAN',
      maintenance_state: 'NONE',
      display_label: null,
      unit_details: {},
    },
  });
  mount();
  await user.click(
    await screen.findByRole('tab', { name: 'Resources', exact: true }),
  );
  await user.click(
    await screen.findByRole('button', { name: 'New resource', exact: true }),
  );
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByLabelText('Resource code'), 'R1');
  await user.click(
    await within(dialog).findByRole('button', {
      name: 'Browse children',
      exact: true,
    }),
  );
  await user.click(
    await within(dialog).findByRole('button', {
      name: 'Load more places',
      exact: true,
    }),
  );
  const row = (await within(dialog).findByText('Second floor · F2')).closest(
    '.MuiStack-root',
  )!;
  await user.click(
    within(row as HTMLElement).getByRole('button', {
      name: 'Use this place',
      exact: true,
    }),
  );
  await user.click(
    within(dialog).getByRole('button', { name: 'Save', exact: true }),
  );
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      'tenant-a',
      pid,
      expect.objectContaining({ location_id: second.id }),
    ),
  );
  expect(flat).not.toHaveBeenCalled();
  expect(propertyApi.listLocationChildren).toHaveBeenCalledWith(
    'tenant-a',
    pid,
    expect.objectContaining({ parent_id: building.id, cursor: 'page-2' }),
  );
});

test('unknown create outcome freezes input and close controls and replays the same key/body', async () => {
  const user = userEvent.setup();
  const create = jest
    .spyOn(propertyApi, 'createTreeLocation')
    .mockRejectedValueOnce(new Error('response lost after commit'))
    .mockResolvedValueOnce({
      location: { ...building, code: 'NEW', name: 'New building' },
    });
  mount();
  await user.click(
    await screen.findByRole('button', { name: 'New location', exact: true }),
  );
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByLabelText('Location code'), 'NEW');
  await user.type(
    within(dialog).getByLabelText('Location name'),
    'New building',
  );
  await user.click(within(dialog).getByLabelText('Location type'));
  await user.click(
    screen.getByRole('option', { name: 'Building', exact: true }),
  );
  await user.clear(
    within(dialog).getByRole('spinbutton', { name: 'Display order' }),
  );
  await user.type(
    within(dialog).getByRole('spinbutton', { name: 'Display order' }),
    '7',
  );
  await user.click(
    within(dialog).getByRole('button', { name: 'Save', exact: true }),
  );
  const retry = await within(dialog).findByRole('button', {
    name: 'Retry',
    exact: true,
  });
  expect(within(dialog).getByLabelText('Location name')).toBeDisabled();
  expect(
    within(dialog).getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(retry);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  expect(create.mock.calls[0]?.[2]).toEqual({
    code: 'NEW',
    name: 'New building',
    kind: 'BUILDING',
    parent_id: null,
    display_order: 7,
  });
});

test('unknown PATCH is reconciled by readback without a second write; own parent is disabled', async () => {
  const user = userEvent.setup();
  const update = jest
    .spyOn(propertyApi, 'updateLocation')
    .mockImplementation(async () => {
      currentBuilding = { ...building, version: 2, name: 'Renamed building' };
      throw new Error('response lost after commit');
    });
  mount();
  await user.click(
    await screen.findByRole('button', { name: 'Edit', exact: true }),
  );
  const dialog = screen.getByRole('dialog');
  expect(
    await within(dialog).findByRole('button', {
      name: 'Use this place',
      exact: true,
    }),
  ).toBeDisabled();
  await user.clear(within(dialog).getByLabelText('Location name'));
  await user.type(
    within(dialog).getByLabelText('Location name'),
    'Renamed building',
  );
  await user.click(
    within(dialog).getByRole('button', { name: 'Save', exact: true }),
  );
  const retry = await within(dialog).findByRole('button', {
    name: 'Retry',
    exact: true,
  });
  expect(
    within(dialog).getByRole('button', {
      name: 'Reload saved location',
      exact: true,
    }),
  ).toBeDisabled();
  await user.click(retry);
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]?.[3]).toEqual({
    version: 1,
    name: 'Renamed building',
    parent_id: null,
    kind: 'BUILDING',
    display_order: 0,
  });
});

test('a 412 child-page conflict discards its cursor before loading the refreshed tree', async () => {
  const user = userEvent.setup();
  let stale = true;
  jest
    .mocked(propertyApi.listLocationChildren)
    .mockImplementation(async (_tenant, _property, options = {}) => {
      if (options.parent_id === first.id || options.parent_id === second.id)
        return {
          ancestors: [
            building,
            options.parent_id === first.id ? first : second,
          ],
          items: [],
          next_cursor: null,
        };
      if (options.parent_id !== building.id)
        return { ancestors: [], items: [building], next_cursor: null };
      if (options.limit === 25 && options.cursor && stale) {
        stale = false;
        throw new ApiError('STALE_VERSION', 412, {});
      }
      return {
        ancestors: [building],
        items: options.cursor ? [second] : [first],
        next_cursor: options.cursor ? null : 'page-2',
      };
    });
  mount();
  await user.click(
    await screen.findByRole('button', { name: 'Browse children', exact: true }),
  );
  await user.click(
    await screen.findByRole('button', {
      name: 'Load more places',
      exact: true,
    }),
  );
  await user.click(
    await screen.findByRole('button', {
      name: 'Reload updated location tree',
      exact: true,
    }),
  );
  await screen.findByText('First floor · F1');
  const calls = jest
    .mocked(propertyApi.listLocationChildren)
    .mock.calls.filter(
      (call) => call[2]?.limit === 25 && call[2]?.parent_id === building.id,
    );
  expect(calls.at(-1)?.[2]?.cursor).toBeUndefined();
  await user.click(
    await screen.findByRole('button', {
      name: 'Load more places',
      exact: true,
    }),
  );
  await screen.findByText('Second floor · F2');
});
