/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../packages/i18n/src/index.js';
import { AuthProvider } from '../apps/web/src/auth/AuthProvider.js';
import { LegacySetupEntryPage } from '../apps/web/src/property/LegacySetupEntryPage.js';
import { setupApi } from '../apps/web/src/api/setup.js';
import type { SetupDraft } from '../apps/web/src/api/setup.js';

const propertyId = '00000000-0000-4000-8000-000000000010';
const localKey = 'hotel:setup-wizard-preview:tenant-a';
const localDraft = {
  updatedAt: '2026-10-08T00:00:00Z',
  step: 0,
  property: {
    name: 'Saved legacy draft',
    code: 'LEGACY',
    country: 'Indonesia',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
    types: ['ROOM'],
  },
  groups: [],
  operations: {
    checkIn: '14:00',
    checkOut: '12:00',
    inspection: false,
    explicitStates: true,
  },
  pricing: { planName: '', from: '', to: '', basePrice: '', postponed: true },
};
const serverDraft: SetupDraft = {
  draft_id: '00000000-0000-4000-8000-000000000020',
  revision: 1,
  property_id: propertyId,
  tenant_id: 'tenant-a',
  completed: false,
  updated_at: '2026-10-08T00:00:00Z',
  updated_by_user_id: null,
  input: {
    property: {
      name: 'Saved server draft',
      code: 'LEGACY',
      country: 'Indonesia',
      timezone: 'Asia/Jakarta' as const,
      base_currency: 'IDR' as const,
      types: [],
    },
    unit_groups: [
      {
        id: 'pool-a',
        template_code: 'DORM',
        pattern: '1-2',
        rental_mode: 'BEDS',
        beds_per_unit: 3,
        sharing_scope: 'MIXED',
      },
    ],
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      inspection_required: false,
      explicit_states: true,
    },
    pricing: { postponed: true },
  },
};

const session = {
  authenticated: true,
  session: {
    id: 'session-a',
    active_tenant_id: 'tenant-a',
    expires_at: '2030-01-01T00:00:00Z',
    auth_methods: ['pwd'],
    mfa: false,
  },
  memberships: [],
  permissions: ['property.read', 'property.manage'].map((permission) => ({
    permission,
    granted: true,
    denied: false,
  })),
};

beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = jest.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => session,
        text: async () => JSON.stringify(session),
      }) as Response,
  ) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function mount(entry = '/setup-preview') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <I18nextProvider i18n={createI18n('en-US')}>
          <AuthProvider>
            <Routes>
              <Route path="/setup-preview" element={<LegacySetupEntryPage />} />
              <Route
                path="/properties"
                element={<div>Current properties entry</div>}
              />
              <Route
                path="/properties/:propertyId/structure"
                element={<div>Current structure editor</div>}
              />
            </Routes>
          </AuthProvider>
        </I18nextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('empty old entry redirects after authentication without creating a draft', async () => {
  const getDraft = jest.spyOn(setupApi, 'getDraft');
  mount();
  await screen.findByText('Current properties entry');
  expect(getDraft).not.toHaveBeenCalled();
  expect(localStorage.getItem(localKey)).toBeNull();
});

test('existing local v1 draft opens its saved contents and explicit discard returns to current entry', async () => {
  const raw = JSON.stringify(localDraft);
  localStorage.setItem(localKey, raw);
  localStorage.setItem('another-tenant-draft', 'keep');
  mount();
  await waitFor(() =>
    expect(screen.getByTestId('property-name')).toHaveValue(
      localDraft.property.name,
    ),
  );
  expect(localStorage.getItem(localKey)).toBe(raw);
  await userEvent.click(screen.getByTestId('setup-start-over'));
  await screen.findByText('Current properties entry');
  expect(localStorage.getItem(localKey)).toBeNull();
  expect(localStorage.getItem('another-tenant-draft')).toBe('keep');
});

test.each(['{invalid', ''])(
  'corrupt local draft %p stays recoverable without exposing a blank old creation form',
  async (raw) => {
    localStorage.setItem(localKey, raw);
    mount();
    await screen.findByTestId('setup-corrupt-draft');
    expect(localStorage.getItem(localKey)).toBe(raw);
    expect(screen.queryByTestId('property-name')).not.toBeInTheDocument();
  },
);

test('existing server v1 remains on its editor without loading the local draft', async () => {
  jest.spyOn(setupApi, 'getDraft').mockResolvedValue({ draft: serverDraft });
  localStorage.setItem(localKey, '{invalid');
  mount(`/setup-preview?propertyId=${propertyId}`);
  await waitFor(() =>
    expect(screen.getByTestId('property-name')).toHaveValue(
      'Saved server draft',
    ),
  );
  expect(screen.queryByTestId('setup-corrupt-draft')).not.toBeInTheDocument();
  expect(localStorage.getItem(localKey)).toBe('{invalid');
});

test.each([null, { ...serverDraft, input: { schema_version: 2 } }])(
  'absent or v2 server draft redirects to current structure editor',
  async (draft) => {
    jest
      .spyOn(setupApi, 'getDraft')
      .mockResolvedValue({ draft } as Awaited<
        ReturnType<typeof setupApi.getDraft>
      >);
    mount(`/setup-preview?propertyId=${propertyId}`);
    await screen.findByText('Current structure editor');
    expect(
      screen.queryByTestId('setup-wizard-preview'),
    ).not.toBeInTheDocument();
  },
);

test('server read failure remains visible and retry succeeds without local fallback', async () => {
  const getDraft = jest
    .spyOn(setupApi, 'getDraft')
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValue({ draft: null });
  localStorage.setItem(localKey, JSON.stringify(localDraft));
  mount(`/setup-preview?propertyId=${propertyId}`);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Reload draft' }),
  );
  await screen.findByText('Current structure editor');
  expect(getDraft).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('setup-wizard-preview')).not.toBeInTheDocument();
});

test('invalid property ID never reads a server draft or opens a tenant local draft', async () => {
  const getDraft = jest.spyOn(setupApi, 'getDraft');
  localStorage.setItem(localKey, JSON.stringify(localDraft));
  mount('/setup-preview?propertyId=invalid');
  await screen.findByText('Current properties entry');
  expect(getDraft).not.toHaveBeenCalled();
  expect(localStorage.getItem(localKey)).not.toBeNull();
});

test('corrupt-draft discard redirects and removes only the explicit tenant key', async () => {
  localStorage.setItem(localKey, '{invalid');
  localStorage.setItem('hotel:setup-wizard-preview:tenant-b', 'keep');
  mount();
  await screen.findByTestId('setup-corrupt-draft');
  await userEvent.click(screen.getByRole('button'));
  await screen.findByText('Current properties entry');
  expect(localStorage.getItem(localKey)).toBeNull();
  expect(localStorage.getItem('hotel:setup-wizard-preview:tenant-b')).toBe(
    'keep',
  );
});

test('failure of the retained editor server read blocks blank creation and remains retryable', async () => {
  jest
    .spyOn(setupApi, 'getDraft')
    .mockResolvedValueOnce({ draft: serverDraft })
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValue({ draft: serverDraft });
  mount(`/setup-preview?propertyId=${propertyId}`);
  const retry = await screen.findByRole('button', { name: 'Reload draft' });
  expect(screen.queryByTestId('property-name')).not.toBeInTheDocument();
  await userEvent.click(retry);
  await waitFor(() =>
    expect(screen.getByTestId('property-name')).toHaveValue(
      'Saved server draft',
    ),
  );
});

test('unreadable local storage is shown as recovery rather than assumed absent', async () => {
  const original = Storage.prototype.getItem;
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    if (key === localKey) throw new Error('Storage unavailable');
    return original.call(this, key);
  });
  mount();
  await screen.findByTestId('setup-corrupt-draft');
  expect(
    screen.queryByText('Current properties entry'),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId('property-name')).not.toBeInTheDocument();
});

test('failure to discard a local draft retains its contents and recovery view', async () => {
  localStorage.setItem(localKey, '{invalid');
  jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  mount();
  await screen.findByTestId('setup-corrupt-draft');
  await userEvent.click(screen.getByRole('button'));
  expect(localStorage.getItem(localKey)).toBe('{invalid');
  expect(screen.getByTestId('setup-corrupt-draft')).toBeInTheDocument();
  expect(
    screen.queryByText('Current properties entry'),
  ).not.toBeInTheDocument();
});
