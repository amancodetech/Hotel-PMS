import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  loadConfig,
  correlationId,
  inspectReadiness,
} from '../packages/backend/dist/index.js';
import {
  createI18n,
  defaults,
  readPreferences,
  writePreferences,
  formatMoney,
  formatInstant,
  locales,
  zones,
} from '../packages/i18n/dist/index.js';

const env = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '4100',
  WORKER_PORT: '4101',
  WEB_PORT: '5173',
  DATABASE_URL: 'postgresql://x:synthetic-secret@127.0.0.1:55432/hotel',
  API_DATABASE_URL: 'postgresql://x:synthetic-secret@127.0.0.1:55432/hotel',
  WORKER_DATABASE_URL: 'postgresql://x:synthetic-secret@127.0.0.1:55432/hotel',
  REDIS_URL: 'redis://127.0.0.1:56379',
  KEYCLOAK_HEALTH_URL: 'http://127.0.0.1:59000/health/ready',
  KEYCLOAK_ISSUER: 'http://127.0.0.1:58080/realms/hotel-local',
  KEYCLOAK_CLIENT_ID: 'hotel-api',
  KEYCLOAK_CLIENT_SECRET: 'synthetic-client-secret',
};

describe('G-01 configuration and safe identifiers', () => {
  test('log fields cannot include request bodies, credentials or arbitrary error objects', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {logEvent} from './packages/backend/dist/logging.js'; logEvent('request', {service:'api',status:400,password:'synthetic-secret',body:{guest:'synthetic-guest'},error:new Error('synthetic-error')});",
      ],
      { encoding: 'utf8' },
    );
    expect(output).not.toMatch(
      /synthetic-secret|synthetic-guest|synthetic-error/,
    );
    expect(Object.keys(JSON.parse(output)).sort()).toEqual([
      'event',
      'level',
      'service',
      'status',
      'time',
    ]);
  });
  test('coerces valid ports and freezes configuration', () => {
    expect(loadConfig(env).API_PORT).toBe(4100);
    expect(Object.isFrozen(loadConfig(env))).toBe(true);
  });
  test.each(['production', '', 'invalid'])(
    'rejects unsupported environment %s',
    (NODE_ENV) =>
      expect(() => loadConfig({ ...env, NODE_ENV })).toThrow('NODE_ENV'),
  );
  test('rejects external URLs without exposing credentials', () => {
    try {
      loadConfig({
        ...env,
        DATABASE_URL: 'postgresql://x:synthetic-secret@example.com/hotel',
      });
      throw new Error('unexpected success');
    } catch (error) {
      expect(error.message).toContain('DATABASE_URL');
      expect(error.message).not.toContain('synthetic-secret');
    }
  });
  test('rejects duplicate application ports', () =>
    expect(() => loadConfig({ ...env, API_PORT: '5173' })).toThrow('distinct'));
  test('preserves valid correlation IDs and replaces unsafe values', () => {
    const id = '4A303B08-98AA-4315-9313-401EFBF84CB2';
    expect(correlationId(id)).toBe(id.toLowerCase());
    for (const value of [
      null,
      ['header'],
      'secret\r\nheader',
      'x'.repeat(1000),
    ])
      expect(correlationId(value)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('G-01 dependency orchestration', () => {
  test('all eight dependency combinations fail closed', async () => {
    for (let mask = 0; mask < 8; mask++) {
      const probes = Object.fromEntries(
        ['database', 'redis', 'identity'].map((name, index) => [
          name,
          async () => {
            if (mask & (1 << index)) throw new Error('synthetic-secret');
          },
        ]),
      );
      const report = await inspectReadiness(probes);
      expect(report.status).toBe(mask === 0 ? 'ready' : 'unavailable');
      expect(JSON.stringify(report)).not.toContain('synthetic-secret');
      expect(
        Object.values(report.checks).filter((value) => value === 'down'),
      ).toHaveLength(mask.toString(2).replaceAll('0', '').length);
    }
  });
});

describe('G-01 localization foundation, not financial acceptance', () => {
  test('all translation keys match and resolve in all languages', () => {
    const tables = locales.map((locale) =>
      JSON.parse(
        readFileSync(
          new URL(
            `../packages/i18n/src/locales/${locale}.json`,
            import.meta.url,
          ),
        ),
      ),
    );
    for (const table of tables)
      expect(Object.keys(table).sort()).toEqual(Object.keys(tables[0]).sort());
    for (const locale of locales) {
      const i18n = createI18n(locale);
      for (const key of Object.keys(tables[0])) {
        expect(i18n.t(key)).not.toBe(key);
        expect(i18n.t(key).length).toBeGreaterThan(0);
      }
    }
  });
  test('all valid preference combinations roundtrip without currency coupling', () => {
    let serialized;
    const storage = {
      getItem: () => serialized,
      setItem: (_key, value) => {
        serialized = value;
      },
    };
    for (const language of locales)
      for (const currency of ['IDR', 'USD'])
        for (const timezone of zones) {
          const value = { language, currency, timezone };
          expect(writePreferences(value, storage)).toBe(true);
          expect(readPreferences(storage)).toEqual(value);
        }
  });
  test('blocked or corrupt storage falls back without crashing', () => {
    for (const value of [
      'null',
      '[]',
      'invalid',
      '{"language":"xx","currency":"EUR"}',
    ])
      expect(readPreferences({ getItem: () => value })).toEqual(defaults);
    const blocked = {
      getItem: () => {
        throw new Error();
      },
      setItem: () => {
        throw new Error();
      },
    };
    expect(readPreferences(blocked)).toEqual(defaults);
    expect(writePreferences(defaults, blocked)).toBe(false);
  });
  test('decimal strings retain precision beyond Number safe range', () =>
    expect(formatMoney('999999999999999999.99', 'USD', 'en-US')).toBe(
      '$999,999,999,999,999,999.99',
    ));
  test.each(['1e3', '-1', 'NaN', '0.001', '', '1,000'])(
    'rejects invalid amount %s',
    (amount) =>
      expect(() => formatMoney(amount, 'IDR', 'id-ID')).toThrow(
        'INVALID_AMOUNT',
      ),
  );
  test('currency formatting works in three languages', () => {
    for (const locale of locales)
      for (const currency of ['IDR', 'USD'])
        expect(formatMoney('125.50', currency, locale)).toBeTruthy();
  });
  test('display time respects Jakarta and Jayapura midnight', () => {
    const instant = '2026-09-12T16:00:00Z';
    expect(formatInstant(instant, 'Asia/Jakarta', 'en-US')).toContain('Sep 12');
    expect(formatInstant(instant, 'Asia/Jayapura', 'en-US')).toContain(
      'Sep 13',
    );
    expect(() =>
      formatInstant('2026-09-12T16:00:00', 'Asia/Jakarta', 'en-US'),
    ).toThrow('INVALID_INSTANT');
  });
});
