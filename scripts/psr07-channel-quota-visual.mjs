import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:3000';
const out = '.local/verification/PSR-07.2';
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
      if (!r.ok) throw Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json();
    }
    const key = window.crypto.randomUUID().slice(0, 8);
    const property = (
      await call(`/tenants/${tenant}/properties`, 'POST', {
        code: `P7Q-${key}`,
        name: 'PSR07 quota synthetic',
        timezone: 'Asia/Jakarta',
      })
    ).property;
    const base = `/tenants/${tenant}/properties/${property.id}`;
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
    }).format(new Date());
    const day = (n) => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + n);
      return date.toISOString().slice(0, 10);
    };
    const period = { arrival: day(1), departure: day(3) };
    const draft = await call(`${base}/setup-draft`, 'PUT', {
      schema_version: 2,
      property: {
        name: 'PSR07 quota synthetic',
        timezone: 'Asia/Jakarta',
        base_currency: 'IDR',
        types: ['VILLA'],
      },
      locations: [],
      unit_groups: [
        {
          group_ref: 'g',
          physical_template: 'VILLA',
          booking_mode: 'WHOLE_AND_PARTS',
          selection_mode: 'EXACT',
          capacity: 2,
          units: [{ unit_ref: 'u', code: 'V1', display_label: 'Villa' }],
          privacy_ack: true,
          parts: [
            { part_ref: 'a', code: 'A', display_label: '101', capacity: 2 },
            { part_ref: 'b', code: 'B', display_label: '102', capacity: 2 },
          ],
          effective_from: today,
          effective_to: day(30),
        },
      ],
      operations: {
        check_in: '14:00',
        check_out: '12:00',
        explicit_states: true,
      },
      pricing: { postponed: true },
    });
    const preview = await call(`${base}/setup-draft/preview`, 'POST');
    if (preview.blockers.length) throw Error(JSON.stringify(preview.blockers));
    const apply = await fetch(`/api/v1${base}/setup-draft/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': window.crypto.randomUUID(),
        'if-match': `"${draft.draft.draft_id}:${draft.draft.revision}"`,
      },
      body: JSON.stringify({ preview_version: preview.preview_version }),
    });
    if (!apply.ok) throw Error(`apply: ${apply.status} ${await apply.text()}`);
    const products = (await call(`${base}/products`)).items;
    const resources = (await call(`${base}/resources`)).items;
    const full = products.find((p) => p.kind === 'VILLA');
    const part = products.find((p) => p.kind === 'ROOM');
    const leaves = resources.filter((r) => r.type === 'ROOM');
    const connections = [];
    for (const channel_key of ['TIKET_COM', 'BOOKING_COM']) {
      const connection = (
        await call(`${base}/connections`, 'POST', {
          provider_key: 'CHANNEX',
          environment: 'STAGING',
          channel_key,
          external_property_id: `P7Q-${key}-${channel_key}`,
          secret_ref: 'local:hotel/psr07-quota-browser',
        })
      ).connection.id;
      connections.push(connection);
      for (const product of [full, part]) {
        const plan = (
          await call(`${base}/rate-plans`, 'POST', {
            code: `R-${window.crypto.randomUUID().slice(0, 8)}`,
            name: 'Quota synthetic',
            product_id: product.id,
            currency: 'IDR',
          })
        ).rate_plan;
        await call(`${base}/rate-plans/${plan.id}`, 'PATCH', {
          version: plan.version,
          status: 'ACTIVE',
        });
        await call(`${base}/rates/batch`, 'POST', {
          cells: [1, 2].map((n) => ({
            rate_plan_id: plan.id,
            date: day(n),
            occupancy: 2,
            money: { amount: '100000', currency: 'IDR' },
          })),
        });
        await call(`${base}/connections/${connection}/mapping`, 'PUT', {
          channel_key,
          external_room_ref: `ROOM-${product.id}`,
          external_rate_ref: `RATE-${plan.id}`,
          occupancy: 2,
          internal_product_ref: product.id,
          internal_rate_ref: plan.id,
        });
      }
    }
    const version = (
      await call(`${base}/rates?from=${period.arrival}&to=${period.departure}`)
    ).inventory_version;
    const exposure = await call(`${base}/exposures/preview`, 'POST', {
      connection_id: connections[0],
      product_id: full.id,
      resource_ids: leaves.map((r) => r.id),
      period,
      inventory_version: version,
    });
    if (!exposure.allowed) throw Error(JSON.stringify(exposure.reason_codes));
    await call(`${base}/exposures`, 'POST', {
      preview_id: exposure.preview_id,
      preview_version: exposure.preview_version,
    });
    const candidates = (await call(`${base}/products/${part.id}/candidates`))
      .items;
    const partResource = leaves.find((r) =>
      candidates.some((c) => c.resource_id === r.id),
    );
    if (!partResource)
      throw Error('Generated part must have an exact leaf candidate');
    return {
      propertyId: property.id,
      base,
      period,
      part,
      partResource,
      leaves,
      connections,
    };
  });
  for (const [name, code, locale] of [
    ['English', 'en-US', 'en-US'],
    ['العربية', 'ar', 'ar'],
  ]) {
    await language(name, code);
    await page.setViewportSize(
      locale === 'ar'
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
    );
    const t = JSON.parse(
      readFileSync(`packages/i18n/src/locales/${locale}.json`, 'utf8'),
    );
    await page.goto(`${baseUrl}/properties/${fixture.propertyId}/rates`);
    await page
      .getByRole('tab', { name: t.exposuresSection, exact: true })
      .click();
    await page.getByLabel(t.selectConnection, { exact: true }).click();
    await page
      .getByRole('option', { name: 'BOOKING_COM · STAGING', exact: true })
      .click();
    await page
      .getByRole('button', { name: t.previewExposure, exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t.product, { exact: true }).click();
    await page
      .getByRole('option', {
        name: `${fixture.part.code} · ${fixture.part.name}`,
        exact: true,
      })
      .click();
    await dialog
      .getByLabel(t.arrivalDate, { exact: true })
      .fill(fixture.period.arrival);
    await dialog
      .getByLabel(t.departureDate, { exact: true })
      .fill(fixture.period.departure);
    await dialog.getByLabel(t.resources, { exact: true }).click();
    await page
      .getByRole('option', { name: fixture.partResource.code, exact: true })
      .click();
    await page.keyboard.press('Escape');
    await dialog
      .getByRole('button', { name: t.previewExposure, exact: true })
      .click();
    await dialog
      .getByText(t.reason.EXPOSURE_PROTECTED, { exact: true })
      .waitFor();
    check(
      `${locale} preview explains channel quota blocker`,
      await dialog
        .getByText(t.reason.EXPOSURE_PROTECTED, { exact: true })
        .isVisible(),
    );
    check(
      `${locale} blocked exposure cannot publish`,
      await dialog
        .getByRole('button', { name: t.publishExposure, exact: true })
        .isDisabled(),
    );
    if (locale === 'ar')
      check(
        'Arabic mobile RTL',
        await page.evaluate(() => document.documentElement.dir === 'rtl'),
      );
    await page.screenshot({
      path: `${out}/quota-${locale}.png`,
      fullPage: true,
    });
  }
  check('no browser exceptions', errors.length === 0);
  writeFileSync(
    `${out}/browser.json`,
    JSON.stringify({ checks, errors, fixture }, null, 2),
  );
  console.log(`PSR07.2 browser ${checks.length}/${checks.length}`);
} finally {
  await browser.close();
}
