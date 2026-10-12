import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createI18n, locales } from '../packages/i18n/src/index.js';
import {
  SETUP_RENTAL_MODES,
  SETUP_SHARING_SCOPES,
  SETUP_SPEC_CODES,
  SETUP_TEMPLATE_CODES,
} from '../packages/backend/src/modules/property/domain/setup.js';

type Table = Map<string, string>;

function flatten(value: unknown, prefix = '', out: Table = new Map()): Table {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      flatten(child, prefix === '' ? key : `${prefix}.${key}`, out);
    return out;
  }
  out.set(prefix, String(value));
  return out;
}

const instance = createI18n('en-US');
const tables = Object.fromEntries(
  locales.map((locale) => [
    locale,
    flatten(instance.getResourceBundle(locale, 'translation')),
  ]),
) as Record<(typeof locales)[number], Table>;
const reference = tables['en-US'];
const referenceKeys = [...reference.keys()].sort();

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([\w.]+)/g)]
    .map((match) => match[1]!)
    .sort();
}

const wizardClientValidationKeys = [
  'nameRequired',
  'codeRequired',
  'codeInvalid',
  'timezoneRequired',
  'currencyRequired',
  'typesRequired',
  'unitsRequired',
  'patternInvalid',
  'patternEmpty',
  'exclusionOutside',
  'duplicateInGroup',
  'duplicateAcrossGroups',
  'capacityInvalid',
  'modeRequired',
  'privacyRequired',
  'scopeRequired',
  'bedsRequired',
  'partsRequired',
  'partLabelInvalid',
  'partLabelDuplicate',
  'partCapacityInvalid',
  'linksRequired',
  'connectionDuplicate',
  'timesRequired',
  'explicitStatesRequired',
  'priceRequired',
  'periodInvalid',
  'fixErrors',
];

const setupDomainSource = readFileSync(
  new URL(
    '../packages/backend/src/modules/property/domain/setup.ts',
    import.meta.url,
  ),
  'utf8',
);
const serverIssueCodes = [
  ...new Set(
    [...setupDomainSource.matchAll(/issue\(\s*'([a-z][a-z0-9_]*)'/g)].map(
      (match) => match[1]!,
    ),
  ),
].sort();

test('nested translation trees keep full key parity across the three locales', () => {
  expect(referenceKeys.length).toBeGreaterThan(1000);
  for (const locale of locales) {
    const table = tables[locale];
    expect({
      locale,
      missing: referenceKeys.filter((key) => !table.has(key)),
      extra: [...table.keys()].filter((key) => !reference.has(key)).sort(),
    }).toEqual({ locale, missing: [], extra: [] });
  }
});

test('every nested value stays non-empty and keeps its placeholders', () => {
  const problems: string[] = [];
  for (const locale of locales)
    for (const key of referenceKeys) {
      const value = tables[locale].get(key)!;
      if (value.trim() === '') problems.push(`${locale}:${key}:empty`);
      if (
        placeholders(value).join() !== placeholders(reference.get(key)!).join()
      )
        problems.push(`${locale}:${key}:placeholders`);
    }
  expect(problems).toEqual([]);
});

test('every setup template, rental mode, sharing scope and spec resolves in all locales', () => {
  const keys = [
    ...SETUP_TEMPLATE_CODES.map((code) => `setupWizard.templates.${code}`),
    ...SETUP_RENTAL_MODES.map((mode) => `setupWizard.rental.mode.${mode}`),
    ...SETUP_SHARING_SCOPES.map(
      (scope) => `setupWizard.rental.sharing.${scope}`,
    ),
    ...SETUP_SPEC_CODES.map((spec) => `setupWizard.rental.spec.${spec}`),
    'setupWizard.groupNumber',
  ];
  for (const locale of locales)
    expect({
      locale,
      missing: keys.filter((key) => !tables[locale].has(key)),
    }).toEqual({ locale, missing: [] });
});

test('every wizard and server setup code has localized copy in all locales', () => {
  expect(serverIssueCodes.length).toBeGreaterThan(40);
  const keys = [
    ...wizardClientValidationKeys.map((key) => `setupWizard.validation.${key}`),
    ...serverIssueCodes.map((code) => `setupWizard.validation.${code}`),
  ];
  for (const locale of locales)
    expect({
      locale,
      missing: keys.filter((key) => !tables[locale].has(key)),
    }).toEqual({ locale, missing: [] });
});
