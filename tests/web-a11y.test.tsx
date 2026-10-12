/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../apps/web/src/auth/AuthProvider.js';
import { SetupWizardPreviewPage } from '../apps/web/src/property/SetupWizardPreviewPage.js';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../packages/i18n/src/index.js';

const ready = {
  status: 'ready',
  checked_at: '2026-09-12T16:00:00Z',
  checks: { database: 'up', redis: 'up', identity: 'up' },
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
  permissions: [
    { permission: 'property.manage', granted: true, denied: false },
  ],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    'hotel.preferences.v1',
    JSON.stringify({
      language: 'en-US',
      currency: 'IDR',
      timezone: 'Asia/Makassar',
    }),
  );
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const body = String(input).includes('/api/v1/auth/session')
      ? session
      : ready;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('index.html applies the stored locale before React mounts', () => {
  const html = readFileSync(
    new URL('../apps/web/index.html', import.meta.url),
    'utf8',
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  expect(script).toContain('hotel.preferences.v1');
  document.documentElement.lang = 'id-ID';
  document.documentElement.dir = 'ltr';

  localStorage.setItem(
    'hotel.preferences.v1',
    JSON.stringify({ language: 'ar', currency: 'IDR' }),
  );
  new Function(script)();
  expect(document.documentElement).toHaveAttribute('lang', 'ar');
  expect(document.documentElement).toHaveAttribute('dir', 'rtl');

  localStorage.setItem(
    'hotel.preferences.v1',
    JSON.stringify({ language: 'en-US', currency: 'IDR' }),
  );
  new Function(script)();
  expect(document.documentElement).toHaveAttribute('lang', 'en-US');
  expect(document.documentElement).toHaveAttribute('dir', 'ltr');

  localStorage.setItem('hotel.preferences.v1', '{not-json');
  document.documentElement.dir = 'ltr';
  new Function(script)();
  expect(document.documentElement).toHaveAttribute('dir', 'ltr');
});

async function mountWizard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/setup-preview']}>
        <I18nextProvider i18n={createI18n('en-US')}>
          <AuthProvider>
            <SetupWizardPreviewPage />
          </AuthProvider>
        </I18nextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByTestId('setup-wizard-preview');
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  option: string,
) {
  const trigger = screen
    .getByTestId(testId)
    .closest('.MuiFormControl-root')
    ?.querySelector('[role="combobox"]');
  expect(trigger).not.toBeNull();
  await user.click(trigger as HTMLElement);
  await user.click(await screen.findByRole('option', { name: option }));
}

test('wizard surfaces field errors, moves focus to the summary and keeps codes LTR', async () => {
  const user = userEvent.setup();
  await mountWizard();

  await user.click(screen.getByTestId('next-step'));
  const summary = await screen.findByTestId('setup-errors');
  await waitFor(() => expect(summary).toHaveFocus());
  expect(screen.getByTestId('property-name')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(
    screen
      .getByTestId('property-name')
      .closest('.MuiFormControl-root')
      ?.querySelector('.MuiFormHelperText-root.Mui-error'),
  ).not.toBeNull();

  await user.type(screen.getByTestId('property-name'), 'A11y Inn');
  await waitFor(() =>
    expect(screen.getByTestId('property-name')).toHaveAttribute(
      'aria-invalid',
      'false',
    ),
  );

  await user.clear(screen.getByTestId('property-code'));
  await user.type(screen.getByTestId('property-code'), 'a');
  await waitFor(() =>
    expect(screen.getByTestId('property-code')).toHaveAttribute(
      'aria-invalid',
      'true',
    ),
  );
  await user.clear(screen.getByTestId('property-code'));
  await user.type(screen.getByTestId('property-code'), 'A11Y');
  await waitFor(() =>
    expect(screen.getByTestId('property-code')).toHaveAttribute(
      'aria-invalid',
      'false',
    ),
  );
  await pick(user, 'property-timezone', 'Asia/Jakarta');
  await pick(user, 'property-currency', 'IDR');
  await user.click(screen.getByTestId('property-type-ROOM'));
  await user.click(screen.getByTestId('next-step'));
  await screen.findByTestId('setup-step-units');

  await user.click(screen.getByTestId('next-step'));
  await waitFor(() => expect(screen.getByTestId('setup-errors')).toHaveFocus());
  const pattern = screen.getByTestId('group-pattern-0');
  expect(pattern).toHaveAttribute('aria-invalid', 'true');
  expect(pattern).toHaveAttribute('dir', 'ltr');
  await user.type(pattern, '101-102');
  await waitFor(() => expect(pattern).toHaveAttribute('aria-invalid', 'false'));
});
