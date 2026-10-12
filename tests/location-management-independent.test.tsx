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
import { propertyApi } from '../apps/web/src/api/property.js';
import { ApiError } from '../apps/web/src/api/client.js';
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
          tree_revision: 1,
        };
      if (options.parent_id === second.id)
        return {
          ancestors: [currentBuilding, second],
          items: [],
          next_cursor: null,
          tree_revision: 1,
        };
      return {
        ancestors: [],
        items: [currentBuilding],
        next_cursor: null,
        tree_revision: 1,
      };
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

test('independent: stale PATCH retains user input and requires explicit reload before new version', async () => {
  const user = userEvent.setup();
  const update = jest
    .spyOn(propertyApi, 'updateLocation')
    .mockRejectedValue(new ApiError('STALE_VERSION', 412, {}));
  mount();
  await user.click(
    await screen.findByRole('button', { name: 'Edit', exact: true }),
  );
  const dialog = screen.getByRole('dialog');
  await user.clear(within(dialog).getByLabelText('Location name'));
  await user.type(
    within(dialog).getByLabelText('Location name'),
    'Unsaved intention',
  );
  await user.click(
    within(dialog).getByRole('button', { name: 'Save', exact: true }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', {
        name: 'Reload saved location',
        exact: true,
      }),
    ).toBeEnabled(),
  );
  expect(update).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByLabelText('Location name')).toHaveValue(
    'Unsaved intention',
  );
  expect(update.mock.calls[0]?.[3]).toEqual({
    version: 1,
    name: 'Unsaved intention',
    parent_id: null,
    kind: 'BUILDING',
    display_order: 0,
  });
  currentBuilding = { ...building, version: 2, name: 'Concurrent saved name' };
  await user.click(
    within(dialog).getByRole('button', {
      name: 'Reload saved location',
      exact: true,
    }),
  );
  await waitFor(() =>
    expect(within(dialog).getByLabelText('Location name')).toHaveValue(
      'Concurrent saved name',
    ),
  );
  expect(update).toHaveBeenCalledTimes(1);
});

test('independent: descendants stay forbidden as parents on every loaded page', async () => {
  const user = userEvent.setup();
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
  await user.click(
    within(dialog).getByRole('button', {
      name: 'Browse children',
      exact: true,
    }),
  );
  await within(dialog).findByText('First floor · F1');
  await user.click(
    await within(dialog).findByRole('button', {
      name: 'Load more places',
      exact: true,
    }),
  );
  await within(dialog).findByText('Second floor · F2');
  const choices = within(dialog).getAllByRole('button', {
    name: 'Use this place',
    exact: true,
  });
  expect(choices).toHaveLength(2);
  for (const choice of choices) expect(choice).toBeDisabled();
});
