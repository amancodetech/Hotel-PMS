import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { chromium } from 'playwright';
import {
  addMemberWithRole,
  createOrm,
  findTenantBySlug,
  provisionTenant,
} from '../packages/backend/dist/index.js';

const env = { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };
const baseUrl = env.WEB_URL ?? `http://127.0.0.1:${env.WEB_PORT ?? '5173'}`;
const apiUrl = env.API_URL ?? `http://127.0.0.1:${env.API_PORT ?? '4100'}`;
const outDir = '.local/verification/sagara-demo-2026-09-20';
mkdirSync(outDir, { recursive: true, mode: 0o700 });

const account = {
  username: 'sagara-owner',
  email: 'sagara-owner@local.test',
  displayName: 'مالك ساجارا',
  password: `Sg!${randomBytes(12).toString('base64url')}9a`,
};
const tenantSpec = {
  name: 'Sagara Vista Hospitality',
  slug: 'sagara-vista-demo',
};

function date(offset) {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

async function keycloakUser() {
  const issuer = new URL(env.KEYCLOAK_ISSUER);
  const realm = issuer.pathname.split('/').filter(Boolean).at(-1);
  const tokenResponse = await fetch(
    `${issuer.origin}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'local-admin',
        password: env.KEYCLOAK_ADMIN_PASSWORD,
      }),
    },
  );
  if (!tokenResponse.ok)
    throw new Error(`Keycloak admin login failed: ${tokenResponse.status}`);
  const token = (await tokenResponse.json()).access_token;
  const kc = async (method, path, body) => {
    const response = await fetch(
      `${issuer.origin}/admin/realms/${realm}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(`Keycloak ${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const matches = await kc(
    'GET',
    `/users?username=${encodeURIComponent(account.username)}&exact=true`,
  );
  let user = matches[0];
  const profile = {
    username: account.username,
    email: account.email,
    firstName: 'Sagara',
    lastName: 'Owner',
    enabled: true,
    emailVerified: true,
    requiredActions: [],
  };
  if (!user) {
    const response = await fetch(
      `${issuer.origin}/admin/realms/${realm}/users`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(profile),
      },
    );
    if (!response.ok)
      throw new Error(`Keycloak user create: ${response.status}`);
    user = (
      await kc(
        'GET',
        `/users?username=${encodeURIComponent(account.username)}&exact=true`,
      )
    )[0];
  } else {
    await kc('PUT', `/users/${user.id}`, { ...user, ...profile });
  }
  await kc('PUT', `/users/${user.id}/reset-password`, {
    type: 'password',
    value: account.password,
    temporary: false,
  });
  return { id: user.id, issuer: env.KEYCLOAK_ISSUER.replace(/\/$/, '') };
}

async function ensureTenant(identity) {
  const orm = await createOrm(env.DATABASE_URL);
  try {
    const existing = await orm.em
      .fork()
      .transactional((em) => findTenantBySlug(em, tenantSpec.slug));
    const user = {
      identitySubject: identity.id,
      issuer: identity.issuer,
      email: account.email,
      displayName: account.displayName,
    };
    const provisioned = !existing
      ? await provisionTenant(orm, { ...tenantSpec, owner: user })
      : { tenantId: existing.id };
    if (existing)
      await addMemberWithRole(orm, {
        tenantId: existing.id,
        user,
        roleCode: 'TENANT_OWNER',
      });
    const identities = JSON.parse(
      readFileSync('.local/identity-users.json', 'utf8'),
    );
    const seeder = identities.users['admin-a'];
    await addMemberWithRole(orm, {
      tenantId: provisioned.tenantId,
      user: {
        identitySubject: seeder.id,
        issuer: identities.issuer,
        email: seeder.email,
        displayName: 'Local setup administrator',
      },
      roleCode: 'TENANT_ADMIN',
    });
    await orm.em.getConnection().execute(
      `update membership m
          set status = 'ACTIVE', revoked_at = null, updated_at = now(),
              authz_version = authz_version + 1
         from app_user u
        where m.user_id = u.id and m.tenant_id = ?
          and u.email = 'admin-a@local.test'`,
      [provisioned.tenantId],
    );
    return provisioned;
  } finally {
    await orm.close(true);
  }
}

async function revokeSeederMembership(tenantId) {
  const orm = await createOrm(env.DATABASE_URL);
  try {
    await orm.em.getConnection().execute(
      `update membership m
          set status = 'REVOKED', revoked_at = now(), updated_at = now(),
              authz_version = authz_version + 1
         from app_user u
        where m.user_id = u.id and m.tenant_id = ?
          and u.email = 'admin-a@local.test'`,
      [tenantId],
    );
  } finally {
    await orm.close(true);
  }
}

function totp(key) {
  const counter = BigInt(Math.floor(Date.now() / 30000));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', Buffer.from(key, 'utf8'))
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

async function signIn(context, username, password, totpKey = null) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.click('a[href^="/api/v1/auth/login"]');
  await page.waitForURL(/\/realms\//, { timeout: 20000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  if (totpKey) {
    await page.waitForSelector('#otp', { timeout: 20000 });
    await page.fill('#otp', totp(totpKey));
    await page.click('#kc-login');
  }
  await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')), {
    timeout: 30000,
  });
  return page;
}

async function api(page, method, path, body) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'hotel_csrf',
  )?.value;
  const response = await page.request.fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
      'x-csrf-token': csrf ?? '',
      ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
    },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok())
    throw new Error(
      `${method} ${path} failed ${response.status()}: ${JSON.stringify(payload)}`,
    );
  return payload;
}

const hotelResources = [
  ...[15, 16, 17].map((number) => ({
    code: `VILLA-${number}`,
    type: 'VILLA',
    capacity: 6,
    location: 'VILLA-WING',
  })),
  { code: 'GLAMPING-1', type: 'TENT', capacity: 2, location: 'GLAMPING' },
  ...Array.from({ length: 16 }, (_, index) => ({
    code: String(101 + index),
    type: 'ROOM',
    capacity: 2,
    location: 'FLOOR-1',
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    code: String(201 + index),
    type: 'ROOM',
    capacity: 2,
    location: 'FLOOR-2',
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    code: String(301 + index),
    type: 'ROOM',
    capacity: 2,
    location: 'FLOOR-3',
  })),
  ...Array.from({ length: 7 }, (_, index) => ({
    code: String(401 + index),
    type: 'ROOM',
    capacity: 2,
    location: 'FLOOR-4',
  })),
];

const villaBedrooms = [
  4, 4, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 3, 3, 2, 2, 1, 1,
];
const villaPrices = [
  1500000,
  1500000,
  1200000,
  900000,
  ...Array(13).fill(1200000),
  900000,
  1200000,
  1200000,
  900000,
  900000,
  650000,
  650000,
];

async function createLocationMap(page, base, definitions) {
  const result = {};
  for (const [code, name] of definitions) {
    const created = await api(page, 'POST', `${base}/locations`, {
      code,
      name,
    });
    result[code] = created.location.id;
  }
  return result;
}

async function createResource(page, base, spec, locations) {
  const created = await api(page, 'POST', `${base}/resources`, {
    code: spec.code,
    type: spec.type,
    capacity: spec.capacity,
    location_id: locations[spec.location],
  });
  return created.resource;
}

async function createProduct(page, base, spec, resources, composition = false) {
  const created = await api(page, 'POST', `${base}/products`, {
    code: spec.code,
    name: spec.name,
    kind: spec.kind,
    occupancy_adults_min: 1,
    occupancy_adults_max: spec.adults,
    occupancy_children_max: Math.min(6, spec.adults),
    meal_plan: spec.mealPlan ?? 'BREAKFAST',
  });
  const product = created.product;
  if (composition) {
    const version = await api(page, 'POST', `${base}/compositions`, {
      product_id: product.id,
      effective_period: { arrival: date(0), departure: date(120) },
      resource_ids: resources.map((resource) => resource.id),
      nested_version_ids: [],
    });
    await api(
      page,
      'POST',
      `${base}/compositions/${version.composition.id}/activate`,
      { reason: 'Initial synthetic resort configuration' },
    );
  } else {
    for (const resource of resources)
      await api(page, 'POST', `${base}/products/${product.id}/candidates`, {
        resource_id: resource.id,
      });
  }
  const active = await api(page, 'PATCH', `${base}/products/${product.id}`, {
    version: product.version,
    status: 'ACTIVE',
  });
  const plan = await api(page, 'POST', `${base}/rate-plans`, {
    code: `${spec.code}-BAR`,
    name: `${spec.name} - Best Available Rate`,
    product_id: product.id,
    currency: 'IDR',
    occupancy_basis: Math.min(2, spec.adults),
    meal_plan: spec.mealPlan ?? 'BREAKFAST',
    inclusions: ['Breakfast', 'Wi-Fi', 'Daily housekeeping'],
    cancellation_policy: { flexible_until_days: 3, after: 'first_night' },
  });
  await api(page, 'PATCH', `${base}/rate-plans/${plan.rate_plan.id}`, {
    version: plan.rate_plan.version,
    status: 'ACTIVE',
  });
  return {
    ...active.product,
    ratePlanId: plan.rate_plan.id,
    price: spec.price,
  };
}

async function setSixtyDayRates(page, base, products) {
  const cells = [];
  for (const product of products)
    for (let offset = 0; offset < 60; offset += 1) {
      const day = new Date(`${date(offset)}T00:00:00Z`).getUTCDay();
      const multiplier = day === 5 || day === 6 ? 1.15 : 1;
      cells.push({
        rate_plan_id: product.ratePlanId,
        date: date(offset),
        occupancy: Math.min(2, product.occupancy_adults_max ?? 2),
        money: {
          amount: String(
            Math.round((product.price * multiplier) / 10000) * 10000,
          ),
          currency: 'IDR',
        },
      });
    }
  for (let offset = 0; offset < cells.length; offset += 100)
    await api(page, 'POST', `${base}/rates/batch`, {
      cells: cells.slice(offset, offset + 100),
    });
  return cells.length;
}

const guestNames = [
  'Alya Pratama',
  'Bima Santoso',
  'Citra Lestari',
  'Dewi Anggraini',
  'Eka Wijaya',
  'Farah Ramadhani',
  'Gilang Saputra',
  'Hana Permata',
  'Indra Kurniawan',
  'Jasmine Putri',
  'Khalid Rahman',
  'Lina Maharani',
  'Maya Sari',
  'Nadia Hapsari',
  'Omar Hidayat',
  'Putri Ananda',
  'Rafi Nugroho',
  'Salsa Amelia',
  'Tari Kusuma',
  'Yusuf Hakim',
];

async function createGuests(page, tenantId) {
  const guests = [];
  for (const [index, name] of guestNames.entries()) {
    const result = await api(
      page,
      'POST',
      `/api/v1/tenants/${tenantId}/guests`,
      {
        full_name: name,
        email: `sagara.guest.${index + 1}@example.test`,
        phone: `+62812000${String(index + 1).padStart(4, '0')}`,
        country_code: 'ID',
        language: index % 3 === 0 ? 'en' : 'id',
        notes: 'Synthetic demonstration guest; no real personal data.',
      },
    );
    guests.push(result.guest);
  }
  return guests;
}

async function book(page, base, product, guest, index) {
  const arrivalOffset = index === 0 ? 0 : 2 + index * 3;
  const arrival = date(arrivalOffset);
  const departure = date(arrivalOffset + (index % 3) + 2);
  const quote = await api(page, 'POST', `${base}/quotes`, {
    product_id: product.id,
    rate_plan_id: product.ratePlanId,
    period: { arrival, departure },
    occupancy: {
      adults: Math.min(2, product.occupancy_adults_max ?? 2),
      child_ages: [],
    },
    quantity: 1,
  });
  const draft = await api(page, 'POST', `${base}/reservations/drafts`, {
    source: 'DIRECT',
    items: [
      {
        product_id: product.id,
        period: { arrival, departure },
        occupancy: {
          adults: Math.min(2, product.occupancy_adults_max ?? 2),
          child_ages: [],
        },
        quantity: 1,
      },
    ],
    guests: [{ guest_id: guest.id, role: 'LEAD' }],
  });
  const reservationId = draft.reservation.id;
  const detail = await api(
    page,
    'GET',
    `${base}/reservations/${reservationId}`,
  );
  const calendar = await api(
    page,
    'GET',
    `${base}/rates?from=${arrival}&to=${departure}`,
  );
  await api(page, 'POST', `${base}/reservations`, {
    reservation_id: reservationId,
    inventory_version: calendar.inventory_version,
    items: [{ item_id: detail.items[0].id, price_snapshot_id: quote.quote.id }],
  });
  return {
    id: reservationId,
    itemId: detail.items[0].id,
    guest,
    arrival,
    departure,
  };
}

async function seedFinance(page, base, reservations, label) {
  const business = await api(page, 'GET', `${base}/finance/business-day`);
  for (const [index, reservation] of reservations.slice(0, 4).entries()) {
    const opened = await api(page, 'POST', `${base}/folios`, {
      reservation_id: reservation.id,
      kind: 'GUEST',
      payer_label: reservation.guest.full_name,
      currency: 'IDR',
    });
    const folio = opened.folio ?? opened;
    const amount = String(450000 + index * 150000);
    await api(page, 'POST', `${base}/charges`, {
      folio_id: folio.id,
      business_date: business.date,
      money: { amount, currency: 'IDR' },
      tax_money: {
        amount: String(Math.round(Number(amount) * 0.11)),
        currency: 'IDR',
      },
      tax_policy: { name: 'Synthetic VAT demo', rate: 0.11 },
      account_code: 'REVENUE_ROOM',
      source_ref: `${label}-ROOM-${index + 1}`,
      memo: 'Synthetic room revenue',
    });
    if (index < 3)
      await api(page, 'POST', `${base}/payments`, {
        folio_id: folio.id,
        method: 'CASH',
        money: { amount, currency: 'IDR' },
        business_date: business.date,
        external_reference: `${label}-PAY-${index + 1}`,
        source_ref: `${label}-PAYMENT-${index + 1}`,
        certainty: 'CONFIRMED',
      });
  }
}

async function seedOperations(page, base, resources, membershipId, label) {
  await api(page, 'POST', `${base}/tasks`, {
    type: 'HOUSEKEEPING',
    description: 'تنظيف وتجهيز قبل وصول الضيف التالي',
    resource_id: resources[0].id,
    assignee_membership_id: membershipId,
    priority: 5,
    due_date: date(0),
  });
  await api(page, 'POST', `${base}/tasks`, {
    type: 'GUEST_REQUEST',
    description: 'تجهيز سرير إضافي ومناشف',
    resource_id: resources[1].id,
    priority: 3,
    due_date: date(1),
  });
  await api(page, 'POST', `${base}/work-orders`, {
    resource_id: resources.at(-1).id,
    category: 'ELECTRICAL',
    severity: 'LOW',
    impact: 'NONE',
    description: 'فحص الإضاءة الوقائي المجدول',
    assignee_membership_id: membershipId,
  });
  await api(page, 'POST', `${base}/shift-handovers`, {
    shift_date: date(0),
    to_membership_id: membershipId,
    follow_up_membership_id: membershipId,
    exceptions_text: 'متابعة وصول المساء وطلب السرير الإضافي.',
    note: `Synthetic ${label} morning-to-evening handover.`,
  });
}

async function seedProperty(
  page,
  tenantId,
  groupId,
  kind,
  guests,
  membershipId,
) {
  const isHotel = kind === 'hotel';
  const code = isHotel ? 'SV-HOTEL' : 'SV-RESORT';
  const name = isHotel ? 'Sagara Grand Hotel' : 'Sagara Villas Resort';
  const root = `/api/v1/tenants/${tenantId}/properties`;
  const created = await api(page, 'POST', root, {
    code,
    name,
    timezone: 'Asia/Makassar',
    base_currency: 'IDR',
    group_id: groupId,
  });
  const property = created.property;
  const base = `${root}/${property.id}`;
  let resources = [];
  let products = [];
  if (isHotel) {
    const locations = await createLocationMap(page, base, [
      ['VILLA-WING', 'جناح الفلل'],
      ['GLAMPING', 'حديقة الغلامبينغ'],
      ['FLOOR-1', 'الطابق الأول'],
      ['FLOOR-2', 'الطابق الثاني'],
      ['FLOOR-3', 'الطابق الثالث'],
      ['FLOOR-4', 'الطابق الرابع'],
    ]);
    for (const spec of hotelResources)
      resources.push(await createResource(page, base, spec, locations));
    const specs = [
      ['HOTEL-VILLA', 'فيلا الفندق', 'VILLA-WING', 'VILLA', 6, 1200000],
      ['GLAMPING', 'خيمة غلامبينغ', 'GLAMPING', 'TENT', 2, 650000],
      ['ROOM-F1', 'غرفة الطابق الأول', 'FLOOR-1', 'ROOM', 2, 400000],
      ['ROOM-F2', 'غرفة الطابق الثاني', 'FLOOR-2', 'ROOM', 2, 450000],
      ['ROOM-F3', 'غرفة الطابق الثالث', 'FLOOR-3', 'ROOM', 2, 500000],
      ['ROOM-F4', 'غرفة الطابق الرابع', 'FLOOR-4', 'ROOM', 2, 550000],
    ];
    for (const [
      productCode,
      productName,
      location,
      productKind,
      adults,
      price,
    ] of specs)
      products.push(
        await createProduct(
          page,
          base,
          {
            code: productCode,
            name: productName,
            kind: productKind,
            adults,
            price,
          },
          resources.filter(
            (resource) =>
              hotelResources.find((entry) => entry.code === resource.code)
                ?.location === location,
          ),
        ),
      );
  } else {
    const locations = await createLocationMap(page, base, [
      ['ZONE-A', 'منطقة الفلل A (1-8)'],
      ['ZONE-B', 'منطقة الفلل B (9-16)'],
      ['ZONE-C', 'منطقة الفلل C (17-24)'],
      ['INDEPENDENT', 'الغرف المستقلة'],
    ]);
    for (let villaIndex = 0; villaIndex < 24; villaIndex += 1) {
      const villaNumber = villaIndex + 1;
      const location =
        villaNumber <= 8 ? 'ZONE-A' : villaNumber <= 16 ? 'ZONE-B' : 'ZONE-C';
      const bedrooms = [];
      for (let room = 1; room <= villaBedrooms[villaIndex]; room += 1) {
        const resource = await createResource(
          page,
          base,
          {
            code: `V${String(villaNumber).padStart(2, '0')}-R${room}`,
            type: 'ROOM',
            capacity: 2,
            location,
          },
          locations,
        );
        bedrooms.push(resource);
        resources.push(resource);
      }
      products.push(
        await createProduct(
          page,
          base,
          {
            code: `VILLA-${String(villaNumber).padStart(2, '0')}`,
            name: `فيلا ${villaNumber} - ${villaBedrooms[villaIndex]} غرف`,
            kind: 'VILLA',
            adults: villaBedrooms[villaIndex] * 2,
            price: villaPrices[villaIndex],
          },
          bedrooms,
          true,
        ),
      );
    }
    const independent = [];
    for (let index = 1; index <= 6; index += 1) {
      const resource = await createResource(
        page,
        base,
        {
          code: `INDEP-${index}`,
          type: 'ROOM',
          capacity: 2,
          location: 'INDEPENDENT',
        },
        locations,
      );
      independent.push(resource);
      resources.push(resource);
    }
    products.push(
      await createProduct(
        page,
        base,
        {
          code: 'INDEPENDENT-ROOM',
          name: 'غرفة مستقلة',
          kind: 'ROOM',
          adults: 2,
          price: 400000,
        },
        independent,
      ),
    );
  }
  const rateCells = await setSixtyDayRates(page, base, products);
  const reservations = [];
  for (let index = 0; index < 12; index += 1)
    reservations.push(
      await book(
        page,
        base,
        products[index % products.length],
        guests[(index + (isHotel ? 0 : 8)) % guests.length],
        index,
      ),
    );
  await seedFinance(page, base, reservations, code);
  await seedOperations(page, base, resources, membershipId, code);
  const connection = await api(page, 'POST', `${base}/connections`, {
    provider_key: 'channex',
    environment: 'sandbox',
    channel_key: 'booking-com',
    external_property_id: `${code}-SYNTHETIC`,
    secret_ref: `secret:local-demo/${code.toLowerCase()}`,
  });
  await api(
    page,
    'PUT',
    `${base}/connections/${connection.connection.id}/mapping`,
    {
      channel_key: 'booking-com',
      external_room_ref: `${code}-ROOM-1`,
      external_rate_ref: `${code}-BAR-1`,
      occupancy: 2,
      meal_plan_ref: 'BREAKFAST',
      internal_product_ref: products[0].id,
      internal_rate_ref: products[0].ratePlanId,
    },
  );
  await api(page, 'POST', `${base}/reports/snapshots`, {
    reference_date: date(0),
  });
  const active = await api(page, 'PATCH', base, {
    version: property.version,
    status: 'ACTIVE',
  });
  return {
    id: property.id,
    code,
    name,
    resources: resources.length,
    products: products.length,
    rateCells,
    reservations: reservations.length,
    status: active.property.status,
  };
}

async function summarizeExistingProperty(page, tenantId, property) {
  const base = `/api/v1/tenants/${tenantId}/properties/${property.id}`;
  const [resources, products, rates, reservations] = await Promise.all([
    api(page, 'GET', `${base}/resources?limit=100`),
    api(page, 'GET', `${base}/products`),
    api(page, 'GET', `${base}/rates?from=${date(0)}&to=${date(59)}`),
    api(page, 'GET', `${base}/reservations?limit=100`),
  ]);
  return {
    id: property.id,
    code: property.code,
    name: property.name,
    resources: resources.items.length,
    products: products.items.length,
    rateCells: rates.prices.length,
    reservations: reservations.items.length,
    status: property.status,
  };
}

async function main() {
  const identity = await keycloakUser();
  const provisioned = await ensureTenant(identity);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ar',
  });
  const page = await signIn(
    context,
    'admin-a',
    env.KEYCLOAK_TEST_USER_PASSWORD,
    env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  try {
    await api(
      page,
      'POST',
      `/api/v1/tenants/${provisioned.tenantId}/select`,
      {},
    );
    const session = await api(page, 'GET', '/api/v1/auth/session');
    const tenantId = session.session?.active_tenant_id ?? provisioned.tenantId;
    const existing = await api(
      page,
      'GET',
      `/api/v1/tenants/${tenantId}/properties`,
    );
    const existingHotel = existing.items.find(
      (property) => property.code === 'SV-HOTEL',
    );
    const existingResort = existing.items.find(
      (property) => property.code === 'SV-RESORT',
    );
    const memberships = await api(
      page,
      'GET',
      `/api/v1/tenants/${tenantId}/memberships`,
    );
    const membershipId = memberships.memberships.find(
      (entry) => entry.user_email === account.email,
    )?.id;
    if (!membershipId)
      throw new Error('Owner membership was not visible after provisioning.');
    let hotel;
    let resort;
    let guestCount;
    if (existingHotel && existingResort) {
      hotel = await summarizeExistingProperty(page, tenantId, existingHotel);
      resort = await summarizeExistingProperty(page, tenantId, existingResort);
      const guests = await api(
        page,
        'GET',
        `/api/v1/tenants/${tenantId}/guests?limit=100`,
      );
      guestCount = guests.items.length;
    } else {
      if (existingHotel || existingResort)
        throw new Error(
          'Only one Sagara property exists; manual repair required.',
        );
      const group = await api(
        page,
        'POST',
        `/api/v1/tenants/${tenantId}/property-groups`,
        { code: 'SAGARA-COLLECTION', name: 'Sagara Collection' },
      );
      const guests = await createGuests(page, tenantId);
      guestCount = guests.length;
      hotel = await seedProperty(
        page,
        tenantId,
        group.group.id,
        'hotel',
        guests,
        membershipId,
      );
      resort = await seedProperty(
        page,
        tenantId,
        group.group.id,
        'resort',
        guests,
        membershipId,
      );
    }
    const pages = [
      'setup',
      'rates',
      'reservations',
      'front-desk',
      'finance',
      'operations',
      'night-audit',
      'reports',
    ];
    const pageChecks = [];
    for (const property of [hotel, resort])
      for (const route of pages) {
        const errors = [];
        const listener = (response) => {
          if (response.status() >= 500)
            errors.push(`${response.status()} ${response.url()}`);
        };
        page.on('response', listener);
        await page.goto(`${baseUrl}/properties/${property.id}/${route}`, {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
        page.off('response', listener);
        const body = await page.locator('body').innerText();
        const ok =
          !errors.length &&
          !body.includes('Internal Server Error') &&
          !body.includes('ليس لديك صلاحية');
        pageChecks.push({ property: property.code, route, ok, errors });
        if (
          [
            'setup',
            'reservations',
            'front-desk',
            'finance',
            'operations',
            'reports',
          ].includes(route)
        )
          await page.screenshot({
            path: `${outDir}/${property.code.toLowerCase()}-${route}.png`,
            fullPage: true,
          });
      }
    const portfolio = await api(
      page,
      'POST',
      `/api/v1/tenants/${tenantId}/reports/query`,
      {
        kind: 'PORTFOLIO',
        period: { date_from: date(0), date_to: date(59) },
        currency: 'IDR',
        property_ids: [hotel.id, resort.id],
      },
    );
    await revokeSeederMembership(tenantId);
    const ownerContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'ar',
    });
    const ownerPage = await signIn(
      ownerContext,
      account.username,
      account.password,
    );
    await ownerPage.goto(`${baseUrl}/preferences`, {
      waitUntil: 'domcontentloaded',
    });
    await ownerPage.getByRole('combobox').first().click();
    await ownerPage.getByRole('option', { name: /العربية|Arabic/ }).click();
    await ownerPage.waitForTimeout(500);
    await ownerPage.goto(`${baseUrl}/properties`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    const ownerBody = await ownerPage.locator('body').innerText();
    const ownerVerified =
      ownerBody.includes('Sagara Grand Hotel') &&
      ownerBody.includes('Sagara Villas Resort');
    await ownerPage.screenshot({
      path: `${outDir}/owner-properties.png`,
      fullPage: true,
    });
    await ownerPage.goto(`${baseUrl}/properties/${resort.id}/front-desk`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    const ownerFrontDeskBody = await ownerPage.locator('body').innerText();
    const ownerFrontDeskVerified =
      ownerFrontDeskBody.includes('فيلا 1 - 4 غرف') &&
      ownerFrontDeskBody.includes('غير مخصصة') &&
      ownerFrontDeskBody.includes('غرف جاهزة');
    await ownerPage.screenshot({
      path: `${outDir}/owner-front-desk.png`,
      fullPage: true,
    });
    await ownerContext.close();
    const evidence = {
      generated_at: new Date().toISOString(),
      tenant: { id: tenantId, ...tenantSpec },
      account: {
        username: account.username,
        email: account.email,
        password_recorded: false,
      },
      source_templates: [
        'Laporan Harian Hotel.xlsx',
        'Laporan Harian Villa.xlsx',
      ],
      synthetic_data_only: true,
      period: { from: date(0), to: date(59) },
      guests: guestCount,
      properties: [hotel, resort],
      pageChecks,
      portfolioGenerated: Boolean(portfolio),
      ownerVerified,
      ownerFrontDeskVerified,
    };
    writeFileSync(
      `${outDir}/result.json`,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (
      pageChecks.some((entry) => !entry.ok) ||
      !ownerVerified ||
      !ownerFrontDeskVerified
    )
      throw new Error('One or more application pages failed verification.');
    console.log(JSON.stringify({ ...evidence, credentials: account }, null, 2));
  } finally {
    await browser.close();
  }
}

await main();
