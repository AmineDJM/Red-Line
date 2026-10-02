import { useTranslation } from 'react-i18next';
import { LOCALES, LOCALE_NAMES, type Locale, type PublicUser } from '@redline/shared';
import { Icon, Select } from '@redline/ui';
import type { Api } from '../api/types.js';
import { getApi } from '../api/index.js';
import { chooseLanguage, lang, langSource, storedLocale } from '../i18n/index.js';

/**
 * Langue du compte : le choix fait sur cet appareil (localStorage) l'emporte et est enregistré dans
 * le compte ; sur un nouvel appareil sans choix, la langue du compte s'applique (rechargement).
 * Une langue imposée par l'adresse (`/en/…`, `?lang=`) ne modifie pas le compte.
 */
export async function syncAccountLocale(api: Api, user: PublicUser | null): Promise<void> {
  if (!user || !api.setLocale) return;
  if (langSource === 'path' || langSource === 'query') return;
  const stored = storedLocale();
  if (!stored && user.locale && user.locale !== lang) {
    chooseLanguage(user.locale);
    return;
  }
  if (user.locale !== lang) await api.setLocale(lang).catch(() => undefined);
}

/** Sélecteur de langue (accueil, réglages) : noms des langues dans leur propre écriture. */
export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const change = async (l: Locale) => {
    if (l === lang) return;
    try {
      const api = await getApi();
      // Compte connecté : la langue suit le joueur (notifications push comprises).
      if (api.setLocale && (await api.me().catch(() => null)))
        await api.setLocale(l).catch(() => undefined);
    } finally {
      chooseLanguage(l);
    }
  };
  return (
    <span className={compact ? 'langsel langsel--compact' : 'langsel'} data-testid="lang-select">
      <Icon name="globe" size={14} />
      <Select<Locale>
        value={lang}
        label={t('language.choose')}
        onChange={(l) => void change(l)}
        options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
      />
    </span>
  );
}
