import { createInstance } from 'i18next';
import ar from './locales/ar.json' with { type: 'json' };
import id from './locales/id-ID.json' with { type: 'json' };
import en from './locales/en-US.json' with { type: 'json' };

export const locales = ['id-ID', 'en-US', 'ar'] as const;
export type Locale = (typeof locales)[number];
export const zones = [
  'Asia/Jakarta',
  'Asia/Makassar',
  'Asia/Jayapura',
] as const;
export type Zone = (typeof zones)[number];
export type Currency = 'IDR' | 'USD';
export interface Preferences {
  language: Locale;
  currency: Currency;
  timezone: Zone;
}
export const defaults: Preferences = {
  language: 'id-ID',
  currency: 'IDR',
  timezone: 'Asia/Makassar',
};
export const storageKey = 'hotel.preferences.v1';
export function readPreferences(
  storage?: Pick<Storage, 'getItem'>,
): Preferences {
  try {
    const data = JSON.parse(storage?.getItem(storageKey) ?? 'null');
    if (!data || typeof data !== 'object') return { ...defaults };
    return {
      language: locales.includes(data.language)
        ? data.language
        : defaults.language,
      currency: ['IDR', 'USD'].includes(data.currency)
        ? data.currency
        : defaults.currency,
      timezone: zones.includes(data.timezone)
        ? data.timezone
        : defaults.timezone,
    };
  } catch {
    return { ...defaults };
  }
}
export function writePreferences(
  value: Preferences,
  storage?: Pick<Storage, 'setItem'>,
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function createI18n(language: Locale = defaults.language) {
  const instance = createInstance();
  void instance.init({
    lng: language,
    fallbackLng: 'id-ID',
    supportedLngs: [...locales],
    resources: {
      ar: { translation: ar },
      'id-ID': { translation: id },
      'en-US': { translation: en },
    },
    initImmediate: false,
    showSupportNotice: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}
export function formatMoney(
  amount: string,
  currency: Currency,
  locale: Locale,
): string {
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(amount)) throw new Error('INVALID_AMOUNT');
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format as unknown as (value: string) => string;
  return format(amount);
}
export function formatInstant(
  instant: string,
  timezone: Zone,
  locale: Locale,
): string {
  if (
    !/Z$|[+-]\d{2}:\d{2}$/.test(instant) ||
    !Number.isFinite(Date.parse(instant))
  )
    throw new Error('INVALID_INSTANT');
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: timezone,
  }).format(new Date(instant));
}
