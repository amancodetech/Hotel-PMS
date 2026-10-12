/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../apps/web/src/App.js';

const ready = {
  status: 'ready',
  checked_at: '2026-09-12T16:00:00Z',
  checks: { database: 'up', redis: 'up', identity: 'up' },
};
function mount(path = '/preferences') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ready,
  })) as typeof fetch;
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('language controls switch all three locales and persist without changing currency', async () => {
  const user = userEvent.setup();
  mount();
  const choose = async (name: string) => {
    await screen.findAllByRole('combobox');
    await user.click(screen.getAllByRole('combobox')[0]!);
    await user.click(screen.getByRole('option', { name }));
  };
  await choose('العربية');
  await waitFor(() =>
    expect(document.documentElement).toHaveAttribute('dir', 'rtl'),
  );
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
    'التفضيلات',
  );
  expect(
    JSON.parse(localStorage.getItem('hotel.preferences.v1')!),
  ).toMatchObject({ language: 'ar', currency: 'IDR' });
  await choose('English');
  expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
    'Preferences',
  );
  await choose('Bahasa Indonesia');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
    'Preferensi',
  );
});
test('amount validation and keyboard focus on implemented controls', async () => {
  const user = userEvent.setup();
  mount();
  await user.tab();
  expect(screen.getByRole('link', { name: 'Ke konten utama' })).toHaveFocus();
  const amount = await screen.findByRole('textbox');
  await user.clear(amount);
  await user.type(amount, '1e3');
  expect(amount).toHaveAttribute('aria-invalid', 'true');
  await user.clear(amount);
  await user.type(amount, '12.50');
  expect(amount).toHaveAttribute('aria-invalid', 'false');
});
test('status reports dependency failures without claiming readiness', async () => {
  globalThis.fetch = jest.fn(async () => ({
    ok: false,
    status: 503,
    json: async () => ({
      code: 'DEPENDENCY_UNAVAILABLE',
      details: {
        ...ready,
        status: 'unavailable',
        checks: { ...ready.checks, database: 'down' },
      },
    }),
  })) as typeof fetch;
  mount('/');
  await waitFor(() =>
    expect(screen.getAllByText('Tidak tersedia')).toHaveLength(2),
  );
  expect(screen.getAllByText('Terputus')).toHaveLength(2);
});
test('network error and retry control are available', async () => {
  globalThis.fetch = jest.fn(async () => {
    throw new Error('raw-secret-error');
  }) as typeof fetch;
  const user = userEvent.setup();
  mount('/');
  await waitFor(() =>
    expect(screen.getAllByText('Status tidak dapat diambil')).toHaveLength(2),
  );
  expect(screen.queryByText('raw-secret-error')).not.toBeInTheDocument();
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ready,
  })) as typeof fetch;
  await user.click(screen.getByRole('button', { name: 'Periksa kembali API' }));
  expect(await screen.findByText('Siap')).toBeInTheDocument();
});
test('unknown route has a working return link', () => {
  mount('/missing');
  expect(
    screen.getByRole('link', { name: 'Kembali ke status' }),
  ).toHaveAttribute('href', '/');
});
