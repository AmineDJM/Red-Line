import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArmyView } from '@redline/shared';
import { Icon, Kbd } from '@redline/ui';
import { freePiles } from '../lib/command.js';
import { useCommandUi } from '../store/command.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

/**
 * Désignation sur la carte pour le centre de commandement : cible d'une mission (le prochain clic
 * sur la carte la désigne) ou piles de l'armée (sélection habituelle, puis « Valider »). Échap ou
 * « Annuler » rouvre l'assistant sans rien changer.
 */
export function CommandPickBanner() {
  const { t } = useTranslation();
  const picking = useCommandUi((s) => s.picking);
  const setPicking = useCommandUi((s) => s.setPicking);
  const patch = useCommandUi((s) => s.patch);
  const draft = useCommandUi((s) => s.draft);
  const selection = useUi((s) => s.selection);
  const openWindow = useUi((s) => s.openWindow);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  useEffect(() => {
    if (!picking) return;
    document.body.classList.toggle('rl-targeting', picking === 'target');
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setPicking(null);
      openWindow('command');
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      document.body.classList.remove('rl-targeting');
    };
  }, [picking, setPicking, openWindow]);
  if (!picking || !draft) return null;
  const free = new Set(freePiles(view, me, catalog).map((u) => u.id));
  const usable = selection.filter((id) => free.has(id));
  const cancel = () => {
    setPicking(null);
    openWindow('command');
  };
  return (
    <div className="targeting cmd-pickbar" data-map-avoid role="status" data-testid="command-pick">
      <Icon name={picking === 'target' ? 'target' : 'army'} size={14} />
      <span className="targeting__text">
        <b>{t('sections.command')}</b> ·{' '}
        {picking === 'target' ? t('command.pick.target') : t('command.pick.units')}
      </span>
      {picking === 'units' ? (
        <button
          type="button"
          className="targeting__cancel cmd-pickbar__ok"
          disabled={!usable.length}
          onClick={() => {
            patch({ unitIds: [...new Set([...draft.unitIds, ...usable])].sort() });
            setPicking(null);
            openWindow('command');
          }}
          data-testid="command-pick-ok"
        >
          {t('command.pick.validate', { count: usable.length })}
        </button>
      ) : null}
      <button type="button" className="targeting__cancel" onClick={cancel}>
        {t('game.orders.cancel')} <Kbd>{t('keys.escape')}</Kbd>
      </button>
    </div>
  );
}

/** Lien vers l'armée d'une pile (panneau de sélection) : ouvre sa fiche au centre de commandement. */
export function ArmyLink({ army }: { army: ArmyView }) {
  const { t } = useTranslation();
  const openWindow = useUi((s) => s.openWindow);
  const select = useCommandUi((s) => s.select);
  const setTab = useCommandUi((s) => s.setTab);
  const mission = army.mission
    ? t(`command.missions.${army.mission.type}.short`, { defaultValue: army.mission.type })
    : t('command.noMission');
  return (
    <button
      type="button"
      className="cmd-armylink"
      title={t('command.selection.open')}
      onClick={() => {
        select(army.id);
        setTab('armies');
        openWindow('command');
      }}
      data-testid="selection-army"
    >
      <Icon name="star" size={11} /> {army.name} · {mission}
    </button>
  );
}
