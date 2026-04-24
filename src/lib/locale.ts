export const SUPPORTED_LOCALES = ['en', 'zh', 'fr', 'es', 'vi', 'de', 'ja'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

const SUPPORTED_LOCALE_SET = new Set<string>(SUPPORTED_LOCALES);

export const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ja', label: '日本語' },
];

const COUNTRY_TO_LOCALE: Record<string, Locale> = {
  CN: 'zh',
  HK: 'zh',
  TW: 'zh',
  MO: 'zh',
  SG: 'zh',
  FR: 'fr',
  BE: 'fr',
  LU: 'fr',
  MC: 'fr',
  DE: 'de',
  AT: 'de',
  ES: 'es',
  MX: 'es',
  AR: 'es',
  CL: 'es',
  CO: 'es',
  PE: 'es',
  VE: 'es',
  EC: 'es',
  UY: 'es',
  PY: 'es',
  BO: 'es',
  CR: 'es',
  PA: 'es',
  GT: 'es',
  HN: 'es',
  SV: 'es',
  NI: 'es',
  DO: 'es',
  VN: 'vi',
  JP: 'ja',
  US: 'en',
  GB: 'en',
  AU: 'en',
  NZ: 'en',
  IE: 'en',
  IN: 'en',
  PH: 'en',
  MY: 'en',
};

export function normalizeLocale(value?: string | null): Locale | null {
  if (!value) return null;
  const normalized = value.toLowerCase().trim().replace('_', '-');

  if (SUPPORTED_LOCALE_SET.has(normalized)) {
    return normalized as Locale;
  }

  const base = normalized.split('-')[0];
  if (SUPPORTED_LOCALE_SET.has(base)) {
    return base as Locale;
  }

  if (base === 'zh') return 'zh';
  if (base === 'fr') return 'fr';
  if (base === 'es') return 'es';
  if (base === 'vi') return 'vi';
  if (base === 'de') return 'de';
  if (base === 'ja') return 'ja';
  if (base === 'en') return 'en';

  return null;
}

export function parseAcceptLanguage(header?: string | null): Locale[] {
  if (!header) return [];

  const entries = header
    .split(',')
    .map((part) => {
      const [tag, qPart] = part.trim().split(';');
      const weight = qPart?.startsWith('q=') ? Number(qPart.slice(2)) : 1;
      return {
        locale: normalizeLocale(tag),
        weight: Number.isFinite(weight) ? weight : 1,
      };
    })
    .filter((entry): entry is { locale: Locale; weight: number } => Boolean(entry.locale))
    .sort((a, b) => b.weight - a.weight);

  const seen = new Set<Locale>();
  const locales: Locale[] = [];

  for (const entry of entries) {
    if (!seen.has(entry.locale)) {
      seen.add(entry.locale);
      locales.push(entry.locale);
    }
  }

  return locales;
}

export function resolveLocaleFromCountry(country?: string | null): Locale | null {
  if (!country) return null;
  return COUNTRY_TO_LOCALE[country.toUpperCase()] || null;
}

export function resolvePreferredLocale(options: {
  queryLocale?: string | null;
  country?: string | null;
  acceptLanguage?: string | null;
  browserLanguage?: string | null;
  fallback?: Locale;
}): Locale {
  return (
    normalizeLocale(options.queryLocale) ||
    resolveLocaleFromCountry(options.country) ||
    parseAcceptLanguage(options.acceptLanguage)[0] ||
    normalizeLocale(options.browserLanguage) ||
    options.fallback ||
    'en'
  );
}

export function getBrowserLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  return resolvePreferredLocale({
    browserLanguage: window.navigator.language,
    fallback: 'en',
  });
}
