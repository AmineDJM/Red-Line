import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { UnitStance, UnitView } from '@redline/shared';
import {
  Badge,
  Button,
  Gauge,
  Icon,
  KeyValue,
  Segmented,
  UnitMarker,
  WeaponPhoto,
  formatInt,
  pictogramFor,
} from '@redline/ui';
import { fmtDuration, fmtKm } from '../i18n/index.js';
import { fuelLeft, nationName, relationOf } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useGameTime, weaponLabels, weaponSubtitle } from './helpers.js';
import { useMapSel } from '../map/mapSel.js';
import { BattlePanel } from './BattlePanel.js';
import { ProvincePanel } from './ProvincePanel.js';

const STANCES: UnitStance[] = ['hold', 'defend', 'aggressive'];

function toneOf(u: UnitView, me: string | null, view: ReturnType<typeof useGame.getState>['view']) {
  if (u.level === 'detected') return 'unknown' as const;
  if (u.owner === me) return 'own' as const;
  const r = relationOf(view, u.owner);
  return r === 'war' ? ('enemy' as const) : r === 'ally' ? ('ally' as const) : ('neutral' as const);
}

function UnitPanel({ u, compact }: { u: UnitView; compact: boolean }) {
  const { t } = useTranslation();
  const selection = useUi((s) => s.selection);
  const clear = useUi((s) => s.clearSelection);
  const openWindow = useUi((s) => s.openWindow);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const conn = useGame((s) => s.connection);
  const catalog = useWorld((s) => s.catalog);
  const photos = usePhotos();
  const now = useGameTime(2000);
  const sys = u.systemId ? catalog[u.systemId] : undefined;
  const own = u.level === 'own';
  const ids = selection.length ? selection : [u.id];
  const tone = toneOf(u, me, view);
  const general = u.generalId ? view?.generals?.find((g) => g.id === u.generalId) : null;
  const send = async (order: Parameters<NonNullable<typeof conn>['sendOrder']>[0]) => {
    const res = await conn?.sendOrder(order);
    if (res && !res.ok)
      toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  };

  const rows: {
    label: string;
    value: ReactNode;
    tone?: 'amber' | 'green' | 'red' | 'cyan' | 'dim';
  }[] = [];
  if (!own) rows.push({ label: t('game.selection.owner'), value: nationName(u.owner) });
  if (u.count !== undefined)
    rows.push({
      label: t('game.selection.count'),
      value: `${formatInt(u.count)} ${sys?.unitLabel ?? ''}`.trim(),
    });
  if (u.status)
    rows.push({
      label: t('game.selection.status'),
      value: t(`game.status.${u.status}`),
      tone: u.status === 'combat' ? 'red' : u.status === 'moving' ? 'cyan' : undefined,
    });
  if (own && u.supply)
    rows.push({
      label: t('game.selection.supply'),
      value: t(`army.supplyState.${u.supply}`),
      tone: u.supply === 'supplied' ? 'green' : u.supply === 'limited' ? 'amber' : 'red',
    });
  if (own && u.mission && u.mission.kind !== 'none') {
    const fuel = fuelLeft(u.mission, now);
    rows.push({
      label: t('game.selection.mission'),
      value: `${t(`army.mission.${u.mission.kind}`)}${fuel !== null ? ` · ${t('army.fuel', { value: fuel.toFixed(1) })}` : ''}`,
      tone: fuel !== null && fuel < 1 ? 'red' : undefined,
    });
  }
  if (own && u.mission?.readyAt && u.mission.readyAt > now)
    rows.push({
      label: t('game.selection.ready'),
      value: fmtDuration(u.mission.readyAt - now),
      tone: 'amber',
    });
  if (own && u.mission?.ammo !== undefined && u.mission.ammo !== null)
    rows.push({ label: t('game.selection.ammo'), value: formatInt(u.mission.ammo) });
  if (general) rows.push({ label: t('game.selection.general'), value: general.name });
  if (sys && u.level !== 'detected') {
    if (sys.weaponRangeKm.max > 0)
      rows.push({
        label: t('weapon.weaponRange'),
        value: fmtKm(sys.weaponRangeKm.max),
        tone: 'amber',
      });
    if (sys.speedKmh > 0)
      rows.push({
        label: t('weapon.speed'),
        value: `${formatInt(sys.speedKmh)} km/h`,
        tone: 'amber',
      });
  }
  if (!own && u.level !== 'precise') {
    if (now - u.lastSeen > 60_000)
      rows.push({
        label: t('game.selection.lastSeenLabel'),
        value: fmtDuration(now - u.lastSeen),
        tone: 'dim',
      });
    if (u.uncertaintyKm > 0)
      rows.push({
        label: t('game.selection.uncertaintyLabel'),
        value: `±${fmtKm(u.uncertaintyKm)}`,
        tone: 'dim',
      });
  }

  const name = sys && u.level !== 'detected' ? sys.name : t('game.legend.detected');
  return (
    <section
      className={compact ? 'selpanel selpanel--compact' : 'selpanel'}
      aria-label={name}
      data-map-avoid
      data-testid="selection-panel"
    >
      <header className="selpanel__head">
        {sys && u.level !== 'detected' && !compact ? (
          <div className="selpanel__photo">
            <WeaponPhoto
              system={sys}
              photo={photoFor(sys, photos)}
              variant="thumb"
              labels={weaponLabels()}
            />
          </div>
        ) : null}
        <div className="selpanel__titles">
          <div className="selpanel__kicker">
            <UnitMarker
              pictogram={sys && u.level !== 'detected' ? pictogramFor(sys) : 'unknown'}
              nationId={u.level === 'detected' ? undefined : u.owner}
              count={u.count}
              tone={tone}
              size="sm"
            />
            <span className="selpanel__id">{u.id}</span>
            {selection.length > 1 ? (
              <Badge tone="cyan">{t('game.selection.multi', { count: selection.length })}</Badge>
            ) : null}
          </div>
          <h2 className="selpanel__name">{name}</h2>
          <div className="selpanel__sub">
            {sys && u.level !== 'detected' ? weaponSubtitle(sys) : t(`game.level.${u.level}`)}
          </div>
          <div className="selpanel__badges">
            {!own ? (
              <Badge tone={tone === 'enemy' ? 'red' : tone === 'ally' ? 'green' : 'neutral'}>
                {t(`game.level.${u.level}`)}
              </Badge>
            ) : null}
            {sys && u.level !== 'detected' ? (
              <Badge tone="amber" variant="outline">
                {t('weapon.gen')} {sys.generation}
              </Badge>
            ) : null}
            {u.veterancy ? (
              <Badge tone="violet" variant="outline">
                {'★'.repeat(u.veterancy)} {t('army.veterancy')}
              </Badge>
            ) : null}
            {u.jamming ? <Badge tone="blue">{t('army.jamming')}</Badge> : null}
          </div>
        </div>
        <button
          type="button"
          className="selpanel__close"
          onClick={clear}
          aria-label={t('game.selection.deselect')}
          title={`${t('game.selection.deselect')} · Échap`}
        >
          <Icon name="close" size={15} />
        </button>
      </header>
      {u.hpRatio !== undefined ? (
        <div className="selpanel__hp">
          <span>{t('game.selection.hp')}</span>
          <Gauge
            value={u.hpRatio}
            tone="auto"
            cells={compact ? 12 : 16}
            label={t('game.selection.hp')}
          />
        </div>
      ) : null}
      <KeyValue items={compact ? rows.slice(0, 4) : rows} columns={compact ? 1 : 1} />
      {own ? (
        <>
          {!compact ? (
            <div className="selpanel__stance">
              <span className="selpanel__label">{t('game.selection.stance')}</span>
              <Segmented
                size="sm"
                label={t('game.selection.stance')}
                value={u.stance ?? 'defend'}
                options={STANCES.map((s) => ({ value: s, label: t(`game.stance.${s}`) }))}
                onChange={(stance) => void send({ kind: 'stance', unitIds: ids, stance })}
              />
            </div>
          ) : null}
          <div className="selpanel__actions">
            {u.status === 'moving' || u.status === 'combat' ? (
              <Button
                size="sm"
                icon={<Icon name="stop" size={12} />}
                onClick={() => void send({ kind: 'stop', unitIds: ids })}
              >
                {t('game.selection.stop')}
              </Button>
            ) : null}
            {sys?.movement === 'air' ? (
              <Button
                size="sm"
                icon={<Icon name="home" size={13} />}
                onClick={() => void send({ kind: 'rtb', unitIds: ids })}
              >
                {t('army.rtb')}
              </Button>
            ) : null}
            {sys ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon name="encyclopedia" size={13} />}
                onClick={() => openSheet(sys.id, u.id)}
              >
                {t('game.selection.sheet')}
              </Button>
            ) : null}
          </div>
          {!compact ? <p className="selpanel__hint">{t('game.selection.hint')}</p> : null}
        </>
      ) : sys ? (
        <div className="selpanel__actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="encyclopedia" size={13} />}
            onClick={() => openSheet(sys.id, u.id)}
          >
            {t('game.selection.sheet')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="intel" size={13} />}
            onClick={() => openWindow('intel')}
          >
            {t('intel.title')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Panneau de sélection (bas gauche) : unité sélectionnée ou inspectée, bataille, sinon province. */
export function SelectionPanel({ compact }: { compact: boolean }) {
  const selection = useUi((s) => s.selection);
  const inspected = useUi((s) => s.inspected);
  const province = useUi((s) => s.selectedProvince);
  const battle = useMapSel((s) => s.battle);
  const view = useGame((s) => s.view);
  const id = selection[0] ?? inspected;
  const u = id ? view?.units[id] : undefined;
  if (u && view) return <UnitPanel u={u} compact={compact} />;
  if (battle && view) return <BattlePanel compact={compact} />;
  if (province && view?.provinces[province])
    return <ProvincePanel id={province} compact={compact} />;
  return null;
}
