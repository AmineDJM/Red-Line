import { useEffect, useState } from 'react';
import type { GameNotification, LngLat, NationId, PlayerView, WeaponSystem } from '@redline/shared';
import type { IconName, WeaponCardLabels } from '@redline/ui';
import { countryName, t } from '../i18n/index.js';
import { gameNow, useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';
import type { WindowId, WindowParams } from '../store/ui.js';
import { nationForms, nationPair } from '../lib/game.js';
import { battleTitle, newsHeadline, renderLoc, reportTitle } from '../lib/loc.js';

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
    photo: t('weapon.photo'),
    noPhoto: t('weapon.noPhoto'),
    generation: t('weapon.gen'),
    sheet: t('weapon.sheet'),
  };
}

export function weaponSubtitle(s: WeaponSystem): string {
  // Système générique (infanterie, satellites…) : la doctrine, pas un pays d'origine trompeur.
  if (s.generic && (s.doctrine !== 'other' || s.origin.toUpperCase() === 'XX'))
    return t('weapon.subtitleDoctrine', {
      category: t(`categories.${s.category}`),
      doctrine: t(`weapon.doctrineAdj.${s.doctrine}`),
    });
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
  icon: IconName;
  /** Fenêtre à ouvrir au clic (rapport, recherche…). */
  open?: { id: WindowId; params?: WindowParams };
}

/** Texte, gravité, icône et cible d'une notification. Rouge réservé aux menaces critiques. */
export function describeNotification(
  n: GameNotification,
  view: PlayerView | null,
  me: NationId | null,
): NotificationInfo {
  const w = useWorld.getState();
  const nation = (id: NationId) => nationForms(id);
  const province = (id: string) => w.provinces[id]?.cityName ?? w.provinces[id]?.name ?? id;
  const unitName = (systemId?: string) =>
    (systemId && w.catalog[systemId]?.name) || t('game.selection.unknownType');
  const at = 'at' in n ? n.at : null;
  const k = (key: string, opts?: Record<string, unknown>) => t(`game.alerts.kinds.${key}`, opts);
  switch (n.kind) {
    case 'combat_started':
      return { text: k('combat_started'), critical: false, major: true, at, icon: 'battle' };
    case 'unit_destroyed': {
      const own = n.owner === me;
      return {
        text: k(own ? 'unit_destroyed_own' : 'unit_destroyed', { unit: unitName(n.systemId) }),
        critical: own,
        major: true,
        at,
        icon: 'target',
      };
    }
    case 'unit_detected': {
      const u = view?.units[n.unitId];
      const text = u?.systemId
        ? k('unit_detected_known', { ...nation(u.owner), unit: unitName(u.systemId) })
        : k('unit_detected');
      return { text, critical: false, major: false, at, icon: 'radio' };
    }
    case 'province_capture_started': {
      const provOwner = view?.provinces[n.provinceId]?.owner;
      if (n.by === me)
        return {
          text: k('province_capture_started_own', { province: province(n.provinceId) }),
          critical: false,
          major: true,
          at,
          icon: 'flag',
        };
      if (provOwner === me)
        return {
          text: k('province_capture_started_threat', {
            ...nation(n.by),
            province: province(n.provinceId),
          }),
          critical: true,
          major: true,
          at,
          icon: 'warning',
        };
      return {
        text: k('province_capture_started', {
          ...nation(n.by),
          province: province(n.provinceId),
        }),
        critical: false,
        major: false,
        at,
        icon: 'flag',
      };
    }
    case 'province_captured':
      if (n.by === me)
        return {
          text: k('province_captured_own', { province: province(n.provinceId) }),
          critical: false,
          major: true,
          at,
          icon: 'flag',
        };
      if (n.from === me)
        return {
          text: k('province_lost', { province: province(n.provinceId) }),
          critical: true,
          major: true,
          at,
          icon: 'warning',
        };
      return {
        text: k('province_captured', { ...nation(n.by), province: province(n.provinceId) }),
        critical: false,
        major: false,
        at,
        icon: 'flag',
      };
    case 'production_complete':
      return {
        text: k('production_complete', { unit: unitName(n.systemId) }),
        critical: false,
        major: false,
        at,
        icon: 'production',
      };
    case 'arrived':
      return { text: k('arrived'), critical: false, major: false, at, icon: 'mapPin' };
    case 'nation_defeated':
      return {
        text: k('nation_defeated', nation(n.nationId)),
        critical: n.nationId === me,
        major: true,
        at: null,
        icon: 'flag',
      };
    case 'victory':
      return {
        text: k('victory', nation(n.winner)),
        critical: n.winner !== me,
        major: true,
        at: null,
        icon: 'trophy',
      };
    case 'research_complete':
      return {
        text: k('research_complete', {
          node:
            w.research[n.nodeId]?.name ??
            t(`researchNodes.${n.nodeId.replace(/^research\./, '').replace(/\./g, '_')}`, {
              defaultValue: n.nodeId,
            }),
        }),
        critical: false,
        major: false,
        at: null,
        icon: 'research',
        open: { id: 'research' },
      };
    case 'war_declared':
      return {
        text: k('war_declared', nationPair(n.by, n.against)),
        critical: n.against === me,
        major: true,
        at: null,
        icon: 'battle',
        open: { id: 'diplomacy' },
      };
    case 'peace_signed':
      return {
        text: k('peace_signed', nationPair(n.a, n.b)),
        critical: false,
        major: true,
        at: null,
        icon: 'handshake',
        open: { id: 'diplomacy' },
      };
    case 'missile_launch':
      return { text: k('missile_launch'), critical: true, major: true, at, icon: 'missile' };
    case 'building_hit':
      return {
        text: k('building_hit', {
          building: t(`buildings.${n.building}`),
          province: province(n.provinceId),
          health: Math.round(n.health * 100),
        }),
        critical: view?.provinces[n.provinceId]?.owner === me,
        major: true,
        at,
        icon: 'building',
      };
    case 'delivery':
      return {
        text: k(n.outcome === 'arrived' ? 'delivery_arrived' : 'delivery_intercepted'),
        critical: n.outcome === 'intercepted',
        major: n.outcome === 'intercepted',
        at,
        icon: 'truck',
        open: { id: 'economy', params: { tab: 'market' } },
      };
    case 'intel_report': {
      const r = view?.intel?.reports.find((x) => x.id === n.reportId);
      return {
        text: r ? reportTitle(r) : k('intel_report'),
        critical: n.flash,
        major: true,
        at: n.at,
        icon: 'intel',
        open: { id: 'intel', params: { reportId: n.reportId } },
      };
    }
    case 'battle_report': {
      const r = view?.battleReports?.find((x) => x.id === n.reportId);
      return {
        text: r ? k('battle_report_named', { title: battleTitle(r) }) : k('battle_report'),
        critical: false,
        major: true,
        at,
        icon: 'battle',
        open: { id: 'battles', params: { reportId: n.reportId } },
      };
    }
    case 'operation':
      return {
        text: k('operation', {
          status: t(`army.ops.status.${n.status}`, { defaultValue: n.status }),
        }),
        critical: n.status === 'failed',
        major: true,
        at: null,
        icon: 'clock',
        open: { id: 'army', params: { tab: 'operations' } },
      };
    case 'alert_level':
      return {
        text: k('alert_level', { level: n.level }),
        critical: n.level <= 2,
        major: true,
        at: null,
        icon: 'warning',
      };
    case 'council':
      return {
        text: renderLoc(n.loc, n.text),
        critical: false,
        major: true,
        at: null,
        icon: 'council',
        open: { id: 'council' },
      };
    case 'news': {
      const item = view?.news?.find((x) => x.id === n.newsId);
      return {
        text: item ? newsHeadline(item) : k('news'),
        critical: false,
        major: false,
        at: n.at,
        icon: 'news',
        open: { id: 'news' },
      };
    }
    case 'generic': {
      const title = renderLoc(n.loc?.title, n.title);
      const text = renderLoc(n.loc?.text, n.text);
      return {
        text: title ? t('game.alerts.titled', { title, text }) : text,
        critical: n.severity === 'critical',
        major: n.severity !== 'info',
        at: n.at,
        icon: n.severity === 'info' ? 'info' : 'warning',
      };
    }
  }
}

/** Ton d'une notification pour les listes (rouge critique, ambre majeure). */
export function notificationTone(d: NotificationInfo): 'red' | 'amber' | 'cyan' {
  return d.critical ? 'red' : d.major ? 'amber' : 'cyan';
}
