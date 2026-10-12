import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  apiUrl,
  closeBrowser,
  getBrowser,
  loginAs,
  loginFresh,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantId;
let sessionId;
let csrfToken;

beforeAll(async () => {
  await startApi();
  const { context, session } = await loginAs('owner-a');
  expect(session.status).toBe(200);
  expect(session.body.authenticated).toBe(true);
  tenantId = session.body.session.active_tenant_id;
  sessionId = session.body.session.id;
  csrfToken = session.body.csrf_token;
  expect(context).toBeDefined();
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('session cookie is HttpOnly, SameSite=Lax and tokens stay out of browser storage', async () => {
  const { context } = await loginAs('owner-a');
  const cookies = await context.cookies(apiUrl);
  const sessionCookie = cookies.find(
    (cookie) => cookie.name === 'hotel_session',
  );
  const csrfCookie = cookies.find((cookie) => cookie.name === 'hotel_csrf');
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe('Lax');
  expect(sessionCookie?.path).toBe('/');
  expect(csrfCookie?.httpOnly).toBe(false);
  expect(csrfToken).toBe(csrfCookie?.value);

  const page = await context.newPage();
  await page.goto(`${apiUrl}/api/v1/system/health`);
  const visibleCookies = await page.evaluate(() => document.cookie);
  expect(visibleCookies).not.toContain('hotel_session');
  expect(visibleCookies).toContain('hotel_csrf');
  const storage = await page.evaluate(() => ({
    local: Object.keys(globalThis.localStorage),
    session: Object.keys(globalThis.sessionStorage),
  }));
  expect(storage.local).toEqual([]);
  expect(storage.session).toEqual([]);
  await page.close();
});

test('state-changing requests fail closed without valid CSRF and origin', async () => {
  const { context } = await loginAs('owner-a');
  const path = `/tenants/${tenantId}/select`;
  const missing = await apiRequest(context, 'POST', path, { csrf: false });
  expect(missing.status).toBe(403);
  expect(missing.body.code).toBe('CSRF_INVALID');
  const invalid = await apiRequest(context, 'POST', path, {
    headers: { 'x-csrf-token': 'f'.repeat(48) },
  });
  expect(invalid.status).toBe(403);
  expect(invalid.body.code).toBe('CSRF_INVALID');
  const badOrigin = await apiRequest(context, 'POST', path, {
    headers: { origin: 'https://untrusted.example' },
  });
  expect(badOrigin.status).toBe(403);
  expect(badOrigin.body.code).toBe('ORIGIN_INVALID');
  const valid = await apiRequest(context, 'POST', path);
  expect(valid.status).toBe(200);
});

test('re-login rotates the session id and revokes the previous one', async () => {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const signIn = async () => {
    const callback = page.waitForResponse(
      (response) => response.url().includes('/api/v1/auth/callback'),
      { timeout: 20000 },
    );
    await page
      .goto(`${apiUrl}/api/v1/auth/login`, { waitUntil: 'commit' })
      .catch(() => null);
    if (await page.locator('#username').count()) {
      await page.fill('#username', 'owner-a');
      await page.fill('#password', process.env.KEYCLOAK_TEST_USER_PASSWORD);
      await page.click('#kc-login');
    }
    await callback;
    await page.waitForTimeout(300);
  };
  await signIn();
  const first = await apiRequest(context, 'GET', '/auth/session');
  const firstId = first.body.session.id;
  await signIn();
  const second = await apiRequest(context, 'GET', '/auth/session');
  const secondId = second.body.session.id;
  expect(secondId).not.toBe(firstId);
  const rows = await withOwner(async (client) =>
    client.query(
      'select id, revoked_at, rotated_from from auth_session where id in ($1, $2)',
      [firstId, secondId],
    ),
  );
  const rotated = rows.rows.find((row) => row.id === secondId);
  expect(rotated.rotated_from).toBe(firstId);
  const revoked = rows.rows.find((row) => row.id === firstId);
  expect(revoked.revoked_at).not.toBeNull();
  await context.close();
});

test('expired sessions stop authorizing and report SESSION_EXPIRED', async () => {
  const fresh = await loginFresh('owner-a');
  const id = fresh.session.body.session.id;
  await withOwner(async (client) =>
    client.query(
      "update auth_session set expires_at = now() - interval '1 minute' where id = $1",
      [id],
    ),
  );
  const session = await apiRequest(fresh.context, 'GET', '/auth/session');
  expect(session.status).toBe(200);
  expect(session.body.authenticated).toBe(false);
  const denied = await apiRequest(
    fresh.context,
    'POST',
    `/tenants/${tenantId}/select`,
  );
  expect(denied.status).toBe(401);
  expect(denied.body.code).toBe('SESSION_EXPIRED');
  await fresh.context.close();
});

test('logout revokes the server session and clears cookies', async () => {
  const fresh = await loginFresh('owner-a');
  const logout = await apiRequest(fresh.context, 'POST', '/auth/logout');
  expect(logout.status).toBe(200);
  expect(logout.body.logged_out).toBe(true);
  const after = await apiRequest(fresh.context, 'GET', '/auth/session');
  expect(after.body.authenticated).toBe(false);
  const rows = await withOwner(async (client) =>
    client.query('select revoked_at from auth_session where id = $1', [
      fresh.session.body.session.id,
    ]),
  );
  expect(rows.rows[0].revoked_at).not.toBeNull();
  await fresh.context.close();
});

test('the current session id remains active for the cached login', async () => {
  const rows = await withOwner(async (client) =>
    client.query('select revoked_at from auth_session where id = $1', [
      sessionId,
    ]),
  );
  expect(rows.rows[0].revoked_at).toBeNull();
});

test('G03-R5: login callback is bound to the browser that started the flow', async () => {
  const browser = await getBrowser();
  const initiator = await browser.newContext();
  const recipient = await browser.newContext();
  const forged = await browser.newContext();
  try {
    const page = await initiator.newPage();
    await page.goto(`${apiUrl}/api/v1/auth/login`, {
      waitUntil: 'domcontentloaded',
    });
    const action = await page.locator('#kc-form-login').getAttribute('action');
    const cookies = (await initiator.cookies())
      .filter((entry) => entry.domain === new URL(action).hostname)
      .map((entry) => `${entry.name}=${entry.value}`)
      .join('; ');
    const submitted = await initiator.request.post(action, {
      headers: {
        cookie: cookies,
        origin: new URL(action).origin,
        referer: page.url(),
      },
      form: {
        username: 'member-a',
        password: process.env.KEYCLOAK_TEST_USER_PASSWORD,
        credentialId: '',
      },
      maxRedirects: 0,
    });
    const callbackUrl = submitted.headers().location;
    expect(typeof callbackUrl).toBe('string');

    const transferred = await recipient.request.get(callbackUrl, {
      maxRedirects: 0,
    });
    expect(transferred.status()).toBe(302);
    expect(transferred.headers().location).toContain(
      'error=OIDC_STATE_INVALID',
    );
    const recipientSession = await apiRequest(
      recipient,
      'GET',
      '/auth/session',
    );
    expect(recipientSession.body.authenticated).toBe(false);

    await forged.addCookies([
      {
        name: 'hotel_auth_flow',
        value: 'f'.repeat(64),
        url: `${apiUrl}/api/v1/auth`,
      },
    ]);
    const forgedResult = await forged.request.get(callbackUrl, {
      maxRedirects: 0,
    });
    expect(forgedResult.status()).toBe(302);
    expect(forgedResult.headers().location).toContain(
      'error=OIDC_STATE_INVALID',
    );
    const forgedSession = await apiRequest(forged, 'GET', '/auth/session');
    expect(forgedSession.body.authenticated).toBe(false);

    const completed = await initiator.request.get(callbackUrl, {
      maxRedirects: 0,
    });
    expect(completed.status()).toBe(302);
    const session = await apiRequest(initiator, 'GET', '/auth/session');
    expect(session.body.authenticated).toBe(true);
    expect(session.body.user.email).toBe('member-a@local.test');
    const csrf = (await initiator.cookies(apiUrl)).find(
      (entry) => entry.name === 'hotel_csrf',
    );
    await initiator.request.post(`${apiUrl}/api/v1/auth/logout`, {
      headers: { origin: apiUrl, 'x-csrf-token': csrf.value },
    });
  } finally {
    await initiator.close();
    await recipient.close();
    await forged.close();
  }
});
