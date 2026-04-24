import { useEffect, useState } from 'react';
import { Locale, getBrowserLocale, normalizeLocale } from '../lib/locale';

const LOCALE_STORAGE_KEY = 'thingNatureLocaleOverrideV1';

function getQueryLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  return normalizeLocale(new URLSearchParams(window.location.search).get('lang'));
}

function resolveInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  return (
    getQueryLocale() ||
    normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY)) ||
    getBrowserLocale()
  );
}

function getStoredLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
}

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);

  const setLocale = (nextLocale: Locale) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
      const url = new URL(window.location.href);
      url.searchParams.set('lang', nextLocale);
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }

    setLocaleState(nextLocale);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const queryLocale = getQueryLocale();
    if (queryLocale) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, queryLocale);
      setLocaleState(queryLocale);
      return;
    }

    const storedLocale = getStoredLocale();
    if (storedLocale) {
      setLocaleState(storedLocale);
      return;
    }

    void fetch('/api/locale', {
      headers: {
        'accept-language': window.navigator.language,
      },
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { locale?: string };
        return normalizeLocale(data.locale);
      })
      .then((resolvedLocale) => {
        if (resolvedLocale) {
          setLocaleState(resolvedLocale);
        }
      })
      .catch((error) => {
        console.warn('Locale detection failed, falling back to browser locale.', error);
      });
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  return { locale, setLocale };
}
