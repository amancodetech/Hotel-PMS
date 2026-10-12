import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { Client } from 'pg';

// Read back the completed source3 trial. Root owns services and execution.
const database = 'hotel_np_operational_trial_20261009';
const tenant = '4e4da283-994c-41af-93ce-54b7fa89814e';
const property = 'f5651217-3100-4da5-91ec-d3fe1775db7c';
const base = `/api/v1/tenants/${tenant}/properties/${property}`;
const env = (key) => {
  assert.ok(process.env[key], `${key} required`);
  return process.env[key];
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function target(value) {
  const url = new URL(value);
  assert.equal(
    url.pathname,
    `/${database}`,
    'Only the operational clone is allowed',
  );
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Local DB only');
  return `${url.hostname.replace('localhost', '127.0.0.1')}:${url.port || '5432'}${url.pathname}`;
}
const dbTarget = target(env('TEST_DATABASE_URL'));
assert.equal(env('IDENTITY_TEST_DB'), database);
for (const key of ['DATABASE_URL', 'API_DATABASE_URL', 'WORKER_DATABASE_URL'])
  assert.equal(target(env(key)), dbTarget);
function processGuard(pidKey, service, dbKey, portKey, requestedPortKey) {
  const pid = env(pidKey);
  assert.match(pid, /^\d+$/);
  assert.ok(
    readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(
      `apps/${service}/dist/main.js`,
    ),
  );
  const runtime = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const value = (key) =>
    runtime.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.ok(value(dbKey), `${service} runtime DB required`);
  assert.equal(target(value(dbKey)), dbTarget);
  const port = env(requestedPortKey);
  assert.match(port, /^\d+$/);
  assert.ok(Number(port) >= 1024 && Number(port) <= 65535);
  assert.equal(value(portKey), port, `${service} runtime port`);
  assert.equal(value('API_HOST'), '127.0.0.1');
  if (service === 'api') assert.equal(value('WEB_PORT'), env('WEB_PORT'));
  const sockets = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = readlinkSync(`/proc/${pid}/fd/${fd}`).match(
        /^socket:\[(\d+)\]$/,
      );
      if (match) sockets.add(match[1]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const address = `0100007F:${Number(port).toString(16).toUpperCase().padStart(4, '0')}`;
  assert.ok(
    readFileSync(`/proc/${pid}/net/tcp`, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        return (
          fields[1] === address && fields[3] === '0A' && sockets.has(fields[9])
        );
      }),
    `${service} PID must own the requested loopback listener`,
  );
}
function guard() {
  processGuard(
    'NP_TRIAL_API_PID',
    'api',
    'API_DATABASE_URL',
    'API_PORT',
    'API_PORT',
  );
  processGuard(
    'NP_TRIAL_WORKER_PID',
    'worker',
    'WORKER_DATABASE_URL',
    'WORKER_PORT',
    'NP_TRIAL_WORKER_PORT',
  );
}
guard();
const baselineBytes = readFileSync(env('NP_TRIAL_BASELINE'));
assert.equal(sha(baselineBytes), env('NP_TRIAL_BASELINE_SHA256'));
const root = '.local/verification/NP-operational-trial-20261009';
const journalBytes = readFileSync(`${root}/journal-source3.json`);
const journal = JSON.parse(journalBytes);
assert.equal(journal.database, database);
assert.equal(journal.run_id, 'source3');
assert.equal(journal.status, 'PASS_API_TRIAL');
assert.equal(journal.baseline_sha, sha(baselineBytes));
const runId = env('NP_TRIAL_BROWSER_RUN_ID');
assert.match(runId, /^[a-z0-9][a-z0-9_-]{0,39}$/);
const folder = `${root}/browser-${runId}`;
// Exclusive directory: never replace a previous receipt or screenshot.
mkdirSync(folder, { mode: 0o700 });
const evidence = {
  status: 'RUNNING',
  database,
  tenant,
  property,
  journal_run_id: 'source3',
  journal_sha256: sha(journalBytes),
  script_sha256: sha(readFileSync(new URL(import.meta.url))),
  baseline_sha256: sha(baselineBytes),
  started_at: new Date().toISOString(),
  variants: [],
  blocked_mutations: [],
  failed_reads: [],
  page_errors: [],
  limits: [
    'Browser reads saved API trial outcomes; it does not perform the booking/payment journey.',
    'Reservation dialogs omit product/resource names; product identity is checked against browser GET responses.',
    'Checkout financial clearance remains PENDING; no settled folio, night audit, revenue or OTA claim.',
  ],
};
const normalizeText = (text) =>
  text
    .replace(/[\u200e\u200f\u061c]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const scenarios = [
  ['room-first', 'CANCELLED', 'quote-room-modified'],
  ['whole-first', 'CANCELLED', 'quote-whole-first'],
  ['stay', 'CHECKED_OUT', 'quote-stay'],
].map(([name, state, quote]) => ({
  name,
  state,
  id: journal.steps[`confirm-${name}`].response.reservation_id,
  product_id: journal.steps[quote].request.body.product_id,
  period: journal.steps[quote].request.body.period,
}));
const payment = journal.finance_verification.payment;
assert.equal(payment.reservation_id, scenarios[2].id);
assert.equal(payment.method, 'CASH');
assert.equal(payment.currency, 'IDR');
assert.equal(Number(payment.amount), 500000);
const tables = [
  'property',
  'guest',
  'property_setup_draft',
  'property_operations_policy',
  'location',
  'resource',
  'product',
  'product_resource_candidate',
  'composition_version',
  'composition_edge',
  'composition_leaf',
  'rate_plan',
  'rate_policy_version',
  'nightly_price',
  'price_quote',
  'reservation',
  'reservation_item',
  'reservation_guest',
  'stay_segment',
  'commitment',
  'plan_allocation',
  'room_assignment',
  'stay_event',
  'folio',
  'folio_payment',
  'journal',
  'journal_line',
];
const db = new Client({ connectionString: env('TEST_DATABASE_URL') });
let harness;
let before;
async function snapshot() {
  const result = {};
  for (const table of tables) {
    const scope =
      table === 'property'
        ? 'tenant_id=$1 AND id=$2'
        : table === 'guest'
          ? 'tenant_id=$1'
          : 'tenant_id=$1 AND property_id=$2';
    result[table] = (
      await db.query(
        `SELECT count(*)::int AS count, md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) AS hash FROM "${table}" t WHERE ${scope}`,
        table === 'guest' ? [tenant] : [tenant, property],
      )
    ).rows[0];
  }
  return result;
}
const web = `http://127.0.0.1:${env('WEB_PORT')}`;
const api = `http://127.0.0.1:${env('API_PORT')}`;
const responseFor = (page, path) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === path,
    { timeout: 30000 },
  );
async function body(responsePromise) {
  const response = await responsePromise;
  assert.equal(
    response.status(),
    200,
    `GET ${new URL(response.url()).pathname}`,
  );
  return response.json();
}
async function screenshot(page, name) {
  const path = `${folder}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  chmodSync(path, 0o600);
  return `${name}.png`;
}
try {
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  before = await snapshot();
  assert.equal(before.reservation.count, 3);
  assert.equal(before.folio_payment.count, 1);
  assert.equal(
    (
      await db.query(
        'SELECT status FROM property WHERE tenant_id=$1 AND id=$2',
        [tenant, property],
      )
    ).rows[0]?.status,
    'ACTIVE',
  );
  process.env.HARNESS_SESSION_CACHE = 'off';
  harness = await import('../tests/property/support/harness.mjs');
  const account = await harness.loginAs(env('NP_TRIAL_LOGIN'));
  assert.equal(account.session.body.session.active_tenant_id, tenant);
  assert.equal(typeof account.context.newPage, 'function');
  // Login is authorized. All subsequent HTTP writes are blocked before dispatch.
  await account.context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      evidence.blocked_mutations.push({
        method: request.method(),
        path: url.pathname,
      });
      await route.abort('blockedbyclient');
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      await route.continue();
      return;
    }
    if (![web, api].includes(url.origin)) {
      await route.abort('blockedbyclient');
      return;
    }
    const scope = url.pathname.match(
      /^\/api\/v1\/tenants\/([^/]+)(?:\/properties\/([^/]+))?/,
    );
    if (scope && (scope[1] !== tenant || (scope[2] && scope[2] !== property))) {
      await route.abort('blockedbyclient');
      return;
    }
    guard();
    await route.continue();
  });
  for (const language of ['en-US', 'ar', 'id-ID']) {
    const dictionary = JSON.parse(
      readFileSync(`packages/i18n/src/locales/${language}.json`),
    );
    const t = (key) =>
      dictionary[key] ??
      key.split('.').reduce((value, part) => value?.[part], dictionary);
    for (const width of [1440, 390]) {
      evidence.stage = { language, width, view: 'reservations-list' };
      const page = await account.context.newPage();
      page.setDefaultTimeout(30000);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        ({ language, tenant, property, web }) => {
          if (window.location.origin !== web) return;
          localStorage.setItem(
            'hotel.preferences.v1',
            JSON.stringify({
              language,
              currency: 'IDR',
              timezone: 'Asia/Jakarta',
            }),
          );
          localStorage.setItem(`hotel:selected-property:${tenant}`, property);
        },
        { language, tenant, property, web },
      );
      page.on('pageerror', (error) =>
        evidence.page_errors.push({ language, width, name: error.name }),
      );
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/v1/') && response.status() >= 400)
          evidence.failed_reads.push({
            language,
            width,
            status: response.status(),
            path: url.pathname,
          });
      });
      const listPromise = body(responseFor(page, `${base}/reservations`));
      await page.goto(`${web}/properties/${property}/reservations`, {
        waitUntil: 'domcontentloaded',
      });
      const list = await listPromise;
      assert.deepEqual(
        list.items.map((item) => item.id).sort(),
        scenarios.map((item) => item.id).sort(),
      );
      await page
        .locator('.reservation-table-container tbody tr')
        .first()
        .waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), language);
      assert.equal(
        await page.locator('html').getAttribute('dir'),
        language === 'ar' ? 'rtl' : 'ltr',
      );
      const variant = { language, width, reservations: [], screenshots: [] };
      if (language === 'en-US' && width === 1440)
        variant.screenshots.push(
          await screenshot(page, 'en-US-1440-reservations'),
        );
      for (const expected of scenarios) {
        evidence.stage = {
          language,
          width,
          view: `reservation-${expected.name}`,
        };
        const index = list.items.findIndex((row) => row.id === expected.id);
        assert.equal(list.items[index].state, expected.state);
        const row = page
          .locator('.reservation-table-container tbody tr')
          .nth(index);
        assert.ok(
          normalizeText(await row.innerText()).includes(
            normalizeText(t(`reservationState.${expected.state}`)),
          ),
        );
        const detailPromise = body(
          responseFor(page, `${base}/reservations/${expected.id}`),
        );
        await row
          .getByRole('button', { name: t('viewDetails'), exact: true })
          .click();
        const detail = await detailPromise;
        assert.equal(detail.reservation.id, expected.id);
        assert.equal(detail.reservation.state, expected.state);
        assert.equal(detail.items.length, 1);
        assert.equal(detail.items[0].product_id, expected.product_id);
        assert.deepEqual(detail.items[0].period, expected.period);
        assert.equal(detail.items[0].state, expected.state);
        const dialog = page.getByRole('dialog');
        await dialog
          .getByText('NP Synthetic Trial Guest', { exact: false })
          .waitFor();
        const text = normalizeText(await dialog.innerText());
        for (const visible of [
          t(`reservationState.${expected.state}`),
          expected.period.arrival,
          expected.period.departure,
        ])
          assert.ok(text.includes(normalizeText(visible)));
        variant.reservations.push({
          ...expected,
          identity_evidence: 'browser GET response',
          state_period_guest_visible: true,
        });
        if (expected.name === 'stay')
          variant.screenshots.push(
            await screenshot(page, `${language}-${width}-checked-out`),
          );
        await dialog
          .getByRole('button', { name: t('close'), exact: true })
          .click();
        await dialog.waitFor({ state: 'hidden' });
      }
      const paymentsPromise = body(responseFor(page, `${base}/payments`));
      evidence.stage = { language, width, view: 'finance-payments' };
      await page.goto(`${web}/properties/${property}/finance`, {
        waitUntil: 'domcontentloaded',
      });
      const payments = await paymentsPromise;
      const actual = payments.payments.find((entry) => entry.id === payment.id);
      assert.ok(actual);
      for (const key of [
        'folio_id',
        'method',
        'currency',
        'state',
        'business_date',
      ])
        assert.equal(actual[key], payment[key]);
      assert.equal(Number(actual.amount), 500000);
      await page
        .getByRole('tab', { name: t('paymentsTab'), exact: true })
        .click();
      const cashRow = page
        .getByRole('table', { name: t('paymentsSection'), exact: true })
        .locator('tbody tr')
        .filter({ hasText: 'np-trial-cash' });
      await cashRow.waitFor();
      assert.equal(await cashRow.count(), 1);
      const cashText = normalizeText(await cashRow.innerText());
      const money = new Intl.NumberFormat(language, {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(500000);
      for (const visible of [
        'NP Synthetic Trial Guest',
        t('paymentMethod.CASH'),
        t('paymentState.SUCCEEDED'),
        payment.business_date,
        money,
      ])
        assert.ok(
          cashText.includes(normalizeText(visible)),
          `Cash row missing ${visible}`,
        );
      variant.payment = {
        id: payment.id,
        folio_id: payment.folio_id,
        amount: 500000,
        currency: 'IDR',
        method: 'CASH',
        formatted_amount: money,
        visible: true,
      };
      variant.screenshots.push(
        await screenshot(page, `${language}-${width}-cash`),
      );
      evidence.variants.push(variant);
      await page.close();
    }
  }
  assert.equal(
    evidence.blocked_mutations.length,
    0,
    'UI attempted a blocked write',
  );
  assert.equal(evidence.failed_reads.length, 0, 'UI read failed');
  assert.equal(evidence.page_errors.length, 0, 'UI page error');
  evidence.after = await snapshot();
  assert.deepEqual(
    evidence.after,
    before,
    'Business rows changed during readback',
  );
  evidence.status = 'PASS_BROWSER_READBACK';
} catch (error) {
  evidence.status = 'FAILED_BROWSER_READBACK';
  // Do not serialize network/driver messages that can contain URLs or credentials.
  evidence.failure = { name: error.name, code: error.code ?? null };
  if (error.name === 'AssertionError')
    evidence.failure.assertion = error.message;
  process.exitCode = 1;
} finally {
  evidence.before = before ?? null;
  if (before && !evidence.after) {
    try {
      evidence.after = await snapshot();
      evidence.business_unchanged =
        JSON.stringify(evidence.after) === JSON.stringify(before);
    } catch {
      evidence.post_snapshot_failed = true;
    }
  } else if (before)
    evidence.business_unchanged =
      JSON.stringify(evidence.after) === JSON.stringify(before);
  try {
    guard();
  } catch {
    evidence.status = 'FAILED_BROWSER_READBACK';
    evidence.final_guard_failed = true;
    process.exitCode = 1;
  }
  if (harness) {
    await harness.closeSessions();
    await harness.closeBrowser();
  }
  await db.end();
  evidence.finished_at = new Date().toISOString();
  writeFileSync(
    `${folder}/result.json`,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      status: evidence.status,
      evidence: `${folder}/result.json`,
      variants: evidence.variants.length,
    }),
  );
}
