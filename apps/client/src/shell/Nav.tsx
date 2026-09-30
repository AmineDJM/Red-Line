import { useTranslation } from 'react-i18next';
import { Icon, IconButton, Kbd } from '@redline/ui';
import { useGame } from '../store/game.js';
import { useUi, type WindowId } from '../store/ui.js';
import { SECTIONS } from './sections.js';

/** Compteurs d'attention par domaine (nouveaux rapports, votes, messages…). */
function useBadges(): Partial<Record<WindowId, number>> {
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const chat = useGame((s) => s.chat);
  const chatRead = useGame((s) => s.chatRead);
  const flash = view?.intel?.reports.filter((r) => r.kind === 'flash').length ?? 0;
  const votes =
    view?.council?.session?.resolutions.filter((r) => me && !r.votes[me] && r.status === 'voting')
      .length ?? 0;
  const pendingPeace = view?.diplomacy?.relations.filter((r) => r.pending && r.pending.from !== me)
    .length ?? 0;
  const ongoing = view?.battleReports?.filter((b) => b.outcome === 'ongoing').length ?? 0;
  const unreadChat = chat.filter(
    (m) => m.from.nationId !== me && m.id > (chatRead[m.channel] ?? 0),
  ).length;
  return {
    intel: flash,
    council: votes,
    diplomacy: pendingPeace + (view?.diplomacy?.invitations.length ?? 0),
    battles: ongoing,
    chat: unreadChat,
  };
}

/** Barre latérale (ordinateur) : un bouton par domaine, raccourci clavier dans l'infobulle. */
export function SideNav() {
  const { t } = useTranslation();
  const windows = useUi((s) => s.windows);
  const toggleWindow = useUi((s) => s.toggleWindow);
  const legendOpen = useUi((s) => s.legendOpen);
  const setLegendOpen = useUi((s) => s.setLegendOpen);
  const badges = useBadges();
  const top = windows.reduce((m, w) => Math.max(m, w.z), 0);
  const item = (s: (typeof SECTIONS)[number]) => {
    const w = windows.find((x) => x.id === s.id);
    return (
      <li key={s.id}>
        <IconButton
          className={w && w.z !== top ? 'sidenav__btn sidenav__btn--open' : 'sidenav__btn'}
          label={t(`sections.${s.id}`)}
          shortcut={s.key}
          icon={<Icon name={s.icon} size={19} />}
          badge={badges[s.id]}
          badgeTone={s.id === 'intel' || s.id === 'battles' ? 'red' : 'cyan'}
          active={!!w && w.z === top}
          onClick={() => toggleWindow(s.id)}
          data-testid={`nav-${s.id}`}
        />
        <span className="sidenav__tip" aria-hidden>
          {t(`sections.${s.id}`)} <Kbd>{s.key}</Kbd>
        </span>
      </li>
    );
  };
  return (
    <nav className="sidenav" aria-label={t('game.toolbar.menu')} data-map-avoid>
      <ul className="sidenav__list">{SECTIONS.filter((s) => s.group === 'main').map(item)}</ul>
      <ul className="sidenav__list sidenav__list--tools">
        {SECTIONS.filter((s) => s.group === 'tools').map(item)}
        <li>
          <IconButton
            className="sidenav__btn"
            label={t('game.toolbar.legend')}
            shortcut="L"
            icon={<Icon name="legend" size={19} />}
            active={legendOpen}
            onClick={() => setLegendOpen(!legendOpen)}
          />
          <span className="sidenav__tip" aria-hidden>
            {t('game.toolbar.legend')} <Kbd>L</Kbd>
          </span>
        </li>
      </ul>
    </nav>
  );
}

/** Barre de navigation mobile (bas de l'écran) : 3 domaines, console, « Plus ». */
export function MobileNav() {
  const { t } = useTranslation();
  const windows = useUi((s) => s.windows);
  const openWindow = useUi((s) => s.openWindow);
  const closeAll = useUi((s) => s.closeAllWindows);
  const moreOpen = useUi((s) => s.moreOpen);
  const setMoreOpen = useUi((s) => s.setMoreOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const badges = useBadges();
  const current = windows.reduce<WindowId | null>(
    (m, w) => (m === null || w.z > (windows.find((x) => x.id === m)?.z ?? 0) ? w.id : m),
    null,
  );
  const main = SECTIONS.filter((s) => s.mobile);
  const others = SECTIONS.filter((s) => !s.mobile);
  const moreBadge = others.reduce((s, x) => s + (badges[x.id] ?? 0), 0);
  return (
    <>
      <nav className="mobnav" aria-label={t('game.toolbar.menu')} data-map-avoid>
        <IconButton
          label={t('game.toolbar.map')}
          icon={<Icon name="map" size={20} />}
          showLabel
          active={!current && !moreOpen}
          onClick={() => {
            closeAll();
            setMoreOpen(false);
          }}
        />
        {main.slice(0, 2).map((s) => (
          <IconButton
            key={s.id}
            label={t(`sections.${s.id}`)}
            icon={<Icon name={s.icon} size={20} />}
            showLabel
            badge={badges[s.id]}
            active={current === s.id}
            onClick={() => openWindow(s.id)}
            data-testid={`nav-${s.id}`}
          />
        ))}
        <button
          type="button"
          className="mobnav__console"
          onClick={() => setPaletteOpen(true)}
          aria-label={t('console.open')}
        >
          <Icon name="terminal" size={20} />
        </button>
        {main.slice(2).map((s) => (
          <IconButton
            key={s.id}
            label={t(`sections.${s.id}`)}
            icon={<Icon name={s.icon} size={20} />}
            showLabel
            badge={badges[s.id]}
            badgeTone="red"
            active={current === s.id}
            onClick={() => openWindow(s.id)}
            data-testid={`nav-${s.id}`}
          />
        ))}
        <IconButton
          label={t('game.toolbar.more')}
          icon={<Icon name="grid" size={20} />}
          showLabel
          badge={moreBadge}
          active={moreOpen}
          onClick={() => setMoreOpen(!moreOpen)}
          data-testid="nav-more"
        />
      </nav>
      {moreOpen ? (
        <div className="moresheet" role="dialog" aria-label={t('game.toolbar.more')} data-map-avoid>
          <div className="moresheet__title">{t('game.toolbar.allSections')}</div>
          <ul className="moresheet__grid">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="moresheet__item"
                  onClick={() => openWindow(s.id)}
                  data-testid={`more-${s.id}`}
                >
                  <Icon name={s.icon} size={22} />
                  <span>{t(`sections.${s.id}`)}</span>
                  {badges[s.id] ? <i className="moresheet__badge">{badges[s.id]}</i> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
