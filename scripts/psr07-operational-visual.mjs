import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const out = '.local/verification/PSR-07.1';
mkdirSync(out, { recursive: true });
const checks = [];
const errors = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};

function totp(secret) {
  const counter = BigInt(Math.floor(Date.now() / 30000));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8'))
    .update(buffer)
    .digest();
  const offset = digest[19] & 15;
  const value =
    (((digest[offset] & 127) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    1000000;
  return String(value).padStart(6, '0');
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.click('a[href^="/api/v1/auth/login"]');
  await page.waitForURL(/\/realms\//);
  await page.fill('#username', 'admin-a');
  await page.fill('#password', process.env.KEYCLOAK_TEST_USER_PASSWORD);
  await page.click('#kc-login');
  await page.waitForSelector('#otp');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!page.url().includes('/login-actions/authenticate')) break;
    await page.fill('#otp', totp(process.env.KEYCLOAK_ADMIN_TOTP_KEY));
    await page.click('#kc-login');
    try {
      await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')), {
        timeout: 6000,
      });
      break;
    } catch {
      await page.waitForTimeout(30000 - (Date.now() % 30000) + 600);
    }
  }
  await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')));
  return page;
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await signIn(context);
  page.on('pageerror', (e) => errors.push(e.message));
  const language = async (name, code) => {
    await page.goto(`${baseUrl}/preferences`);
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name, exact: true }).click();
    await page.waitForFunction(
      (code) => document.documentElement.lang === code,
      code,
    );
  };
  await language('English', 'en-US');
  const fixture = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const tenant = session.session.active_tenant_id;
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    async function call(path, method = 'GET', body) {
      const r = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'idempotency-key': window.crypto.randomUUID(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await r.json();
      if (!r.ok)
        throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(result)}`);
      return result;
    }
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const val = (t) => dateParts.find((p) => p.type === t).value;
    const today = `${val('year')}-${val('month')}-${val('day')}`;
    const next = new Date(`${today}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 2);
    const departure = next.toISOString().slice(0, 10);
    const property = (
      await call(`/tenants/${tenant}/properties`, 'POST', {
        code: `P7V-${window.crypto.randomUUID().slice(0, 8)}`,
        name: 'PSR07 visual synthetic',
        timezone: 'Asia/Jakarta',
      })
    ).property;
    const base = `/tenants/${tenant}/properties/${property.id}`;
    const rooms = [];
    for (const letter of ['A', 'B']) {
      const location = (
        await call(`${base}/locations`, 'POST', {
          code: letter,
          name: `Building ${letter}`,
          kind: 'BUILDING',
        })
      ).location;
      const room = (
        await call(`${base}/resources`, 'POST', {
          code: `${letter}101`,
          display_label: '101',
          location_id: location.id,
          type: 'ROOM',
          capacity: 2,
        })
      ).resource;
      rooms.push(room);
    }
    let product = (
      await call(`${base}/products`, 'POST', {
        code: 'CATEGORY',
        name: 'PSR07 room category',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      })
    ).product;
    for (const room of rooms)
      await call(`${base}/products/${product.id}/candidates`, 'POST', {
        resource_id: room.id,
      });
    product = (
      await call(`${base}/products/${product.id}`, 'PATCH', {
        version: product.version,
        status: 'ACTIVE',
      })
    ).product;
    const plan = (
      await call(`${base}/rate-plans`, 'POST', {
        code: 'RATE',
        name: 'PSR07 rate',
        product_id: product.id,
        currency: 'IDR',
      })
    ).rate_plan;
    await call(`${base}/rate-plans/${plan.id}`, 'PATCH', {
      version: plan.version,
      status: 'ACTIVE',
    });
    const second = new Date(`${today}T00:00:00Z`);
    second.setUTCDate(second.getUTCDate() + 1);
    await call(`${base}/rates/batch`, 'POST', {
      cells: [today, second.toISOString().slice(0, 10)].map((date) => ({
        rate_plan_id: plan.id,
        date,
        occupancy: 2,
        money: { amount: '100000', currency: 'IDR' },
      })),
    });
    const period = { arrival: today, departure },
      occupancy = { adults: 2, child_ages: [] };
    const draft = (
      await call(`${base}/reservations/drafts`, 'POST', {
        source: 'DIRECT',
        items: [{ product_id: product.id, period, occupancy, quantity: 1 }],
      })
    ).reservation;
    const item = (await call(`${base}/reservations/${draft.id}`)).items[0];
    const quote = (
      await call(`${base}/quotes`, 'POST', {
        product_id: product.id,
        rate_plan_id: plan.id,
        period,
        occupancy,
        quantity: 1,
      })
    ).quote;
    const version = (await call(`${base}/rates?from=${today}&to=${departure}`))
      .inventory_version;
    await call(`${base}/reservations`, 'POST', {
      reservation_id: draft.id,
      inventory_version: version,
      items: [{ item_id: item.id, price_snapshot_id: quote.id }],
    });
    return {
      propertyId: property.id,
      base,
      reservationId: draft.id,
      itemId: item.id,
      selected: rooms[1].id,
    };
  });
  await page.goto(`${baseUrl}/properties/${fixture.propertyId}/front-desk`);
  await page
    .getByRole('button', { name: 'Assign room', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('radio', { name: 'Building B / 101 (B101)', exact: true })
    .check();
  check(
    'assignment dialog distinguishes repeated labels by location and code',
    await dialog
      .getByText('Building A / 101 (A101)', { exact: true })
      .isVisible(),
  );
  await dialog
    .getByRole('button', { name: 'Assign room', exact: true })
    .click();
  await dialog.waitFor({ state: 'hidden' });
  const stored = await page.evaluate(
    async (f) =>
      (
        await (await fetch(`/api/v1${f.base}/front-desk/board`)).json()
      ).arrivals.find((r) => r.item_id === f.itemId),
    fixture,
  );
  check(
    'UI selection assigns the correct resource ID',
    stored.assignment.resource_id === fixture.selected,
  );
  check(
    'assigned stay renders the scoped path',
    await page
      .getByText('Building B / 101 (B101)', { exact: false })
      .first()
      .isVisible(),
  );
  await page.screenshot({ path: `${out}/frontdesk-en.png`, fullPage: true });
  await page.evaluate(async (f) => {
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    const detail = await (
      await fetch(`/api/v1${f.base}/reservations/${f.reservationId}`)
    ).json();
    for (const operation of ['check-in', 'check-out']) {
      const d =
        operation === 'check-in'
          ? detail
          : await (
              await fetch(`/api/v1${f.base}/reservations/${f.reservationId}`)
            ).json();
      const r = await fetch(
        `/api/v1${f.base}/reservations/${f.reservationId}/items/${f.itemId}/${operation}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': window.crypto.randomUUID(),
          },
          body: JSON.stringify({
            version: d.items.find((i) => i.id === f.itemId).version,
          }),
        },
      );
      if (!r.ok) throw Error(`${operation}: ${r.status} ${await r.text()}`);
    }
  }, fixture);
  await page.goto(`${baseUrl}/properties/${fixture.propertyId}/operations`);
  await page
    .getByText('Building B / 101 (B101)', { exact: true })
    .first()
    .waitFor();
  check(
    'checkout task shows its resource location and repeated label',
    await page
      .getByText('Building B / 101 (B101)', { exact: true })
      .first()
      .isVisible(),
  );
  await page.screenshot({ path: `${out}/operations-en.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await language('العربية', 'ar');
  for (const route of ['front-desk', 'operations']) {
    await page.goto(`${baseUrl}/properties/${fixture.propertyId}/${route}`);
    // The stay has checked out; the default arrivals tab no longer contains it.
    // Inspect the resource in the room rack while retaining the full path check.
    if (route === 'front-desk') {
      await page.getByRole('tab', { name: 'شبكة الغرف', exact: true }).click();
    }
    await page
      .getByRole('table')
      .getByText('Building B / 101 (B101)', { exact: true })
      .first()
      .waitFor();
    check(
      `${route} mobile RTL renders location path`,
      await page.evaluate(() => document.documentElement.dir === 'rtl'),
    );
    await page.screenshot({
      path: `${out}/${route}-ar-mobile.png`,
      fullPage: true,
    });
  }
  check('no browser exceptions', errors.length === 0);
  writeFileSync(
    `${out}/browser.json`,
    JSON.stringify({ checks, errors, fixture }, null, 2),
  );
  console.log(`PSR07.1 browser ${checks.length}/${checks.length}`);
} finally {
  await browser.close();
}
