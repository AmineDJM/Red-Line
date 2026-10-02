import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Order, UnitView } from '@redline/shared';
import { Button, Icon, Pictogram, Slider, formatInt, pictogramFor } from '@redline/ui';
import {
  canSplit,
  detachOrder,
  isMixed,
  mergeOrder,
  splitByTypeOrder,
  splitHalfOrder,
  stackParts,
} from '../lib/stacks.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useGameTime } from './helpers.js';
import './stacks.css';

/**
 * Piles : composition et actions rapides (« Diviser en 2 », « Détacher… », « Séparer par type »,
 * « Fusionner la sélection »). Composants autonomes, réutilisables ailleurs (fenêtre Armée, menu de
 * choix de pile, carte) : ils ne demandent que l'unité et, pour la fusion, les identifiants choisis.
 * La logique (ordres, vérifications) est dans lib/stacks.ts.
 */

/** Envoi d'un ordre de pile avec retour d'erreur (toast), comme le panneau de sélection. */
export function useSendStackOrder(): (order: Order | null) => Promise<boolean> {
  const { t } = useTranslation();
  const conn = useGame((s) => s.connection);
  const toast = useUi((s) => s.toast);
  return async (order) => {
    if (!order || !conn) return false;
    const res = await conn.sendOrder(order);
    if (res && !res.ok) {
      toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
      return false;
    }
    return true;
  };
}

/** Composition d'une pile mixte : effectif par matériel (rien pour une pile d'un seul matériel). */
export function StackComposition({ u, compact = false }: { u: UnitView; compact?: boolean }) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  if (!isMixed(u)) return null;
  const parts = stackParts(u);
  const shown = compact ? parts.slice(0, 3) : parts;
  return (
    <div className="stackcomp" data-testid="stack-composition">
      <div className="stackcomp__title">{t('stacks.composition', { count: parts.length })}</div>
      <ul className="stackcomp__list">
        {shown.map((p) => {
          const s = catalog[p.systemId];
          return (
            <li key={p.systemId} className="stackcomp__row">
              {s ? <Pictogram id={pictogramFor(s)} size={14} /> : null}
              <span className="stackcomp__name">{s?.name ?? p.systemId}</span>
              <span className="stackcomp__count">{formatInt(p.count)}</span>
            </li>
          );
        })}
      </ul>
      {shown.length < parts.length ? (
        <div className="stackcomp__more">
          {t('stacks.more', { count: parts.length - shown.length })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Actions rapides d'une pile à soi. `ids` : la sélection (fusion proposée dès deux piles).
 * Ordinateur et mobile : boutons tactiles (≥ 44 px), curseur de quantité pour « Détacher… ».
 */
export function StackActions({
  u,
  ids,
  compact = false,
}: {
  u: UnitView;
  ids: string[];
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const catalog = useWorld((s) => s.catalog);
  const balance = useWorld((s) => s.balance);
  const now = useGameTime(2000);
  const send = useSendStackOrder();
  const [detach, setDetach] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  if (u.level !== 'own') return null;
  const selected = ids.map((id) => view?.units[id]).filter((x): x is UnitView => !!x);
  const merge = selected.length >= 2 ? mergeOrder(selected, catalog, balance, now) : null;
  const total = u.count ?? 0;
  const splittable = canSplit(u);
  if (!splittable && !merge && !isMixed(u)) return null;
  // Mobile : une seule touche dans la rangée d'actions ; le détail ne s'ouvre qu'à la demande, pour
  // que le panneau de sélection ne recouvre pas la carte.
  const toggle = compact ? (
    <Button
      size="sm"
      pressed={open}
      icon={<Icon name="army" size={12} />}
      onClick={() => setOpen((o) => !o)}
      data-testid="stack-toggle"
    >
      {t('stacks.manage')}
    </Button>
  ) : null;
  if (compact && !open) return toggle;
  const body = (
    <div className={compact ? 'stackact stackact--wide' : 'stackact'} data-testid="stack-actions">
      {compact ? <StackComposition u={u} /> : null}
      <div className="stackact__row">
        {merge ? (
          <Button
            size="sm"
            variant="primary"
            icon={<Icon name="plus" size={12} />}
            disabled={!merge.order}
            title={merge.block ? t(`stacks.block.${merge.block}`) : undefined}
            onClick={() => void send(merge.order)}
            data-testid="stack-merge"
          >
            {t('stacks.merge', { count: selected.length })}
          </Button>
        ) : null}
        {splittable ? (
          <>
            <Button
              size="sm"
              icon={<Icon name="copy" size={12} />}
              onClick={() => void send(splitHalfOrder(u))}
              data-testid="stack-split-half"
            >
              {t('stacks.half')}
            </Button>
            <Button
              size="sm"
              pressed={detach !== null}
              icon={<Icon name="minus" size={12} />}
              onClick={() =>
                setDetach((d) => (d === null ? Math.max(1, Math.floor(total / 2)) : null))
              }
              data-testid="stack-detach"
            >
              {t('stacks.detach')}
            </Button>
          </>
        ) : null}
        {isMixed(u) ? (
          <Button
            size="sm"
            icon={<Icon name="filter" size={12} />}
            onClick={() => void send(splitByTypeOrder(u))}
            data-testid="stack-split-type"
          >
            {compact ? t('stacks.byTypeShort') : t('stacks.byType')}
          </Button>
        ) : null}
      </div>
      {merge?.block ? <p className="stackact__note">{t(`stacks.block.${merge.block}`)}</p> : null}
      {detach !== null && splittable ? (
        <div className="stackact__detach">
          <Slider
            label={t('stacks.detachCount')}
            min={1}
            max={Math.max(1, total - 1)}
            value={Math.min(detach, Math.max(1, total - 1))}
            onChange={setDetach}
            format={(v) => t('stacks.detachOf', { count: v, total })}
          />
          <div className="stackact__row">
            <Button
              size="sm"
              variant="primary"
              icon={<Icon name="check" size={12} />}
              onClick={() => {
                void send(detachOrder(u, detach)).then((ok) => ok && setDetach(null));
              }}
              data-testid="stack-detach-confirm"
            >
              {t('stacks.detachConfirm', { count: detach })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDetach(null)}>
              {t('game.orders.cancel')}
            </Button>
          </div>
          {isMixed(u) ? <p className="stackact__note">{t('stacks.detachHint')}</p> : null}
        </div>
      ) : null}
    </div>
  );
  return compact ? (
    <>
      {toggle}
      {body}
    </>
  ) : (
    body
  );
}
