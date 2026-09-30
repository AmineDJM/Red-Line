import { useEffect, useState } from 'react';
import type { GameNotification, LngLat, NationId, PlayerView, WeaponSystem } from '@redline/shared';
import type { WeaponCardLabels } from '@redline/ui';
import { countryName, t } from '../i18n/index.js';
import { gameNow, useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';

/** Temps de jeu courant, rafraîchi toutes les `ms` millisecondes. */
export function useGameTime(ms = 1000): number {
  const clock = useGame((s) => s.clock);
  const [now, setNow] = useState(() => gameNow());
  useEffect(() => {
    setNow(gameNow());
    const id = setInterval(() => setNow(gameNow()), ms);
    return () => clearInterval(id);
  }, [ms, clock]);
  return now;
}

export function weaponLabels(): WeaponCardLabels {
  return {
    engine: t('weapon.engine'),
    length: t('weapon.length'),
    wingspan: t('weapon.wingspan'),
    mtow: t('weapon.mtow'),
    warhead: t('weapon.warhead'),
    speed: t('weapon.speed'),
    range: t('weapon.range'),
    weaponRange: t('weapon.weaponRange'),
    units: { m: t('weapon.units.m'), kg: t('weapon.units.kg'), km: t('weapon.units.km') },
  };
}

export function weaponSubtitle(s: WeaponSystem): string {
  return t('weapon.subtitle', {
    category: t(`categories.${s.category}`),
    country: countryName(s.origin),
  });
}

export interface NotificationInfo {
  text: string;
  critical: boolean;
  major: boolean;
  at: LngLat | null;
}

/** Texte, gravité et position d'une notification. Rouge réservé aux menaces critiques. */
export function describeNotification(
  n: GameNotification,
  view: PlayerView | null,
  me: NationId | null,
): NotificationInfo {
  const w = useWorld.getState();
  const nation = (id: NationId) =>
    view?.nations[id]?.name ?? w.nations[id]?.name ?? id.toUpperCase();
  const province = (id: string) => w.provinces[id]?.name ?? id;
  const unitName = (systemId?: string) =>
    (systemId && w.catalog[systemId]?.name) || t('game.selection.unknownType');
  const at = 'at' in n ? n.at : null;
  switch (n.kind) {
    case 'combat_started':
      return { text: t('game.alerts.kinds.combat_started'), critical: false, major: true, at };
    case 'unit_destroyed': {
      const own = n.owner === me;
      return {
        text: t(own ? 'game.alerts.kinds.unit_destroyed_own' : 'game.alerts.kinds.unit_destroyed', {
          unit: unitName(n.systemId),
        }),
        critical: own,
        major: true,
        at,
      };
    }
    case 'unit_detected':
      return { text: t('game.alerts.kinds.unit_detected'), critical: false, major: false, at };
    case 'province_capture_started': {
      const provOwner = view?.provinces[n.provinceId]?.owner;
      if (n.by === me)
        return {
          text: t('game.alerts.kinds.province_capture_started_own', {
            province: province(n.provinceId),
          }),
          critical: false,
          major: true,
          at,
        };
      if (provOwner === me)
        return {
          text: t('game.alerts.kinds.province_capture_started_threat', {
            province: province(n.provinceId),
            nation: nation(n.by),
          }),
          critical: true,
          major: true,
          at,
        };
      return {
        text: t('game.alerts.kinds.province_capture_started', {
          province: province(n.provinceId),
          nation: nation(n.by),
        }),
        critical: false,
        major: false,
        at,
      };
    }
    case 'province_captured':
      if (n.by === me)
        return {
          text: t('game.alerts.kinds.province_captured_own', { province: province(n.provinceId) }),
          critical: false,
          major: true,
          at,
        };
      if (n.from === me)
        return {
          text: t('game.alerts.kinds.province_lost', { province: province(n.provinceId) }),
          critical: true,
          major: true,
          at,
        };
      return {
        text: t('game.alerts.kinds.province_captured', {
          province: province(n.provinceId),
          nation: nation(n.by),
        }),
        critical: false,
        major: false,
        at,
      };
    case 'production_complete':
      return {
        text: t('game.alerts.kinds.production_complete', { unit: unitName(n.systemId) }),
        critical: false,
        major: false,
        at,
      };
    case 'arrived':
      return { text: t('game.alerts.kinds.arrived'), critical: false, major: false, at };
    case 'nation_defeated':
      return {
        text: t('game.alerts.kinds.nation_defeated', { nation: nation(n.nationId) }),
        critical: n.nationId === me,
        major: true,
        at: null,
      };
    case 'victory':
      return {
        text: t('game.alerts.kinds.victory', { nation: nation(n.winner) }),
        critical: n.winner !== me,
        major: true,
        at: null,
      };
    case 'generic':
      return {
        text: n.title ? `${n.title} : ${n.text}` : n.text,
        critical: n.severity === 'critical',
        major: n.severity !== 'info',
        at: n.at,
      };
    case 'missile_launch':
      return {
        text: t('game.alerts.kinds.missile_launch', { defaultValue: 'Tir de missile détecté' }),
        critical: true,
        major: true,
        at,
      };
    default:
      // Notifications des phases 2+ : libellé générique en attendant leurs écrans dédiés.
      return {
        text: t(`game.alerts.kinds.${n.kind}`, { defaultValue: n.kind }),
        critical: false,
        major: false,
        at,
      };
  }
}
