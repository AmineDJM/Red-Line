import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NationId } from '@redline/shared';
import {
  Badge,
  Button,
  Flag,
  Icon,
  Prompt,
  SearchInput,
  WeaponPhoto,
  formatCompact,
  formatMoney,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { WorldPicker } from './WorldPicker.js';
import { norm } from '../lib/commands.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { useIsMobile } from '../shell/useMedia.js';
import { useWorld } from '../store/world.js';

export interface NationPickerProps {
  /** Chemin de l'invite (`nouvelle-partie`, `lobby\partie`). */
  path: string[];
  title: string;
  subtitle?: string;
  /** Nations jouables (défaut : toutes celles qui ont des provinces). */
  playable?: (id: NationId) => boolean;
  /** Nations déjà prises → pseudonyme du joueur (non sélectionnables). */
  takenBy?: Record<NationId, string>;
  /** Réglages de la partie (vitesse, difficulté…) au-dessus de la liste. */
  options?: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: ReactNode;
  onBack: () => void;
  onConfirm: (nationId: NationId) => void;
  /** Informations en tête (nom de la partie, joueurs). */
  headerExtra?: ReactNode;
}

/**
 * Sélection de la nation façon Conflict of Nations : grande carte colorée (clic = sélection),
 * liste avec drapeaux (nations prises : pseudo du joueur), fiche de la nation choisie
 * (description, doctrine, budget, effectifs, principaux systèmes) et actions.
 */
export function NationPicker({
  path,
  title,
  subtitle,
  playable,
  takenBy = {},
  options,
  confirmLabel,
  busy,
  error,
  onBack,
  onConfirm,
  headerExtra,
}: NationPickerProps) {
  const { t } = useTranslation();
  const world = useWorld();
  const mobile = useIsMobile();
  const photos = usePhotos();
  const [query, setQuery] = useState('');
  const [nation, setNation] = useState<NationId | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    void getApi().then((api) => world.loadNationInfo(api));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of Object.values(world.provinces)) m.set(p.nationId, (m.get(p.nationId) ?? 0) + 1);
    return m;
  }, [world.provinces]);

  const all = useMemo(
    () =>
      Object.values(world.nations)
        .filter((n) => (counts.get(n.id) ?? 0) > 0 && (!playable || playable(n.id)))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [world.nations, counts, playable],
  );
  const list = useMemo(() => {
    const q = norm(query);
    return all.filter((n) => !q || norm(n.name).includes(q) || n.id.includes(q));
  }, [all, query]);

  const free = all.filter((n) => !takenBy[n.id]);
  const pick = (id: NationId) => {
    if (takenBy[id]) return;
    setNation(id);
  };
  const random = () => {
    const n = free[Math.floor(Math.random() * free.length)];
    if (n) setNation(n.id);
  };

  useEffect(() => {
    if (!nation) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-nation="${nation}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [nation]);

  const picked = nation ? world.nations[nation] : null;
  const info = nation ? world.nationInfo[nation] : undefined;
  const takenCount = Object.keys(takenBy).length;

  return (
    <div className={mobile ? 'picker picker--mobile' : 'picker'}>
      <header className="picker__bar">
        <span className="rl-win__lights" aria-hidden>
          <i />
        </span>
        <Prompt path={path} />
        <div className="picker__heading">
          <h1>{title}</h1>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        {headerExtra ? <div className="picker__extra">{headerExtra}</div> : null}
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="chevronLeft" size={13} />}
          onClick={onBack}
        >
          {t('app.back')}
        </Button>
      </header>

      <div className="picker__main">
        <div className="picker__map">
          <WorldPicker
            picked={nation}
            onPick={pick}
            takenBy={takenBy}
            playable={playable}
            label={t('newGame.mapLabel')}
          />
          <div className="picker__maphint" aria-hidden>
            <Icon name="mapPin" size={13} /> {t('newGame.pickOnMap')}
          </div>
        </div>
        <aside className="picker__side">
          {options ? <div className="picker__options">{options}</div> : null}
          <div className="picker__search">
            <SearchInput
              value={query}
              onChange={setQuery}
              label={t('app.search')}
              placeholder={t('newGame.searchPlaceholder')}
              clearLabel={t('app.clear')}
            />
            <span className="picker__count">
              {t('newGame.count', { count: list.length })}
              {takenCount ? ` · ${t('newGame.taken', { count: takenCount })}` : ''}
            </span>
          </div>
          <ul
            className="picker__list"
            role="listbox"
            aria-label={t('newGame.nation')}
            ref={listRef}
          >
            {list.map((n) => {
              const player = takenBy[n.id];
              const sel = nation === n.id;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={sel}
                    aria-disabled={!!player}
                    data-nation={n.id}
                    className={[
                      'nation-row',
                      sel ? 'nation-row--sel' : '',
                      player ? 'nation-row--taken' : '',
                    ].join(' ')}
                    onClick={() => pick(n.id)}
                  >
                    <Flag nationId={n.id} size={15} color={n.color} />
                    <span className="nation-row__name">
                      {n.name}
                      {player ? <span className="nation-row__player"> ({player})</span> : null}
                    </span>
                    <span className="nation-row__sub">
                      {player
                        ? t('newGame.human')
                        : t('newGame.provinces', { count: counts.get(n.id) ?? 0 })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      <footer
        className={picked ? 'picker__band' : 'picker__band picker__band--empty'}
        aria-live="polite"
      >
        <div className="picker__selected">
          {picked ? (
            <>
              <Flag
                nationId={picked.id}
                size={mobile ? 30 : 54}
                color={picked.color}
                title={picked.name}
                className="picker__flag"
                eager
              />
              <div className="picker__who">
                <span className="picker__label">{t('newGame.selected')}</span>
                <strong className="picker__name">{picked.name}</strong>
                <span className="picker__badges">
                  {info ? (
                    <Badge tone="cyan" variant="outline">
                      {t(`doctrines.${info.doctrine}`, { defaultValue: info.doctrine })}
                    </Badge>
                  ) : null}
                  <Badge tone="neutral">
                    {t('newGame.provinces', { count: counts.get(picked.id) ?? 0 })}
                  </Badge>
                </span>
              </div>
            </>
          ) : (
            <div className="picker__who">
              <span className="picker__label">{t('newGame.selected')}</span>
              <strong className="picker__name picker__name--none">{t('newGame.none')}</strong>
              <span className="muted small">{t('newGame.pickHint')}</span>
            </div>
          )}
        </div>
        {picked && !mobile ? (
          <div className="picker__info">
            <div className="picker__stats">
              <div>
                <span>{t('newGame.budget')}</span>
                <b className="rl-money">{info ? formatMoney(info.defenseBudgetUsd) : '—'}</b>
              </div>
              <div>
                <span>{t('newGame.personnel')}</span>
                <b>{info?.activePersonnel ? formatCompact(info.activePersonnel) : '—'}</b>
              </div>
            </div>
            <p className="picker__desc">{info?.description ?? t('newGame.loadingInfo')}</p>
            {info?.doctrineText ? (
              <p className="picker__doctrine">
                <span>{t('newGame.doctrine')}</span> {info.doctrineText}
              </p>
            ) : null}
          </div>
        ) : null}
        {picked && !mobile && info?.highlights.length ? (
          <ul className="picker__highlights" aria-label={t('newGame.highlights')}>
            {info.highlights.slice(0, 4).map((h) => {
              const s = world.catalog[h.systemId];
              return (
                <li key={h.systemId}>
                  {s ? (
                    <WeaponPhoto
                      system={s}
                      photo={photoFor(s, photos)}
                      variant="thumb"
                      showCredit={false}
                    />
                  ) : null}
                  <span className="picker__hl-name">{s?.name ?? h.systemId}</span>
                  <span className="picker__hl-count">×{h.count}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="picker__actions">
          {error ? <div className="error-text">{error}</div> : null}
          <Button variant="subtle" icon={<Icon name="refresh" size={13} />} onClick={random}>
            {t('newGame.random')}
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!nation || busy}
            onClick={() => nation && onConfirm(nation)}
            data-testid="picker-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </footer>
    </div>
  );
}
