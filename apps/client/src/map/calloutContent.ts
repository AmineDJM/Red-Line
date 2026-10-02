import {
  distanceKm,
  movementDestination,
  type GameTime,
  type LngLat,
  type NationId,
  type PlayerView,
  type ProvinceDef,
  type SystemId,
  type UnitId,
  type WeaponSystem,
} from '@redline/shared';
import { fmtDuration, fmtKm, t } from '../i18n/index.js';
import { pendingTargetId, type PendingOrder } from '../store/ui.js';
import type { CalloutContent } from './overlay.js';

export interface CalloutArgs {
  view: PlayerView;
  me: NationId | null;
  catalog: Record<SystemId, WeaponSystem>;
  defs: Record<string, ProvinceDef>;
  selection: UnitId[];
  inspected: UnitId | null;
  pending: PendingOrder | null;
  positions: ReadonlyMap<UnitId, LngLat>;
  zoom: number;
  t: GameTime;
  /** Filtre de visibilité (étendue de la carte). */
  inView?: (p: LngLat) => boolean;
  /** Provinces en cours de capture (évite de parcourir toutes les provinces). */
  captures?: string[];
}

/**
 * Sous-ensemble limité d'éléments qui méritent une étiquette cartouche : unités sélectionnées,
 * cible, provinces en cours de capture (avec jauge). Le reste passe par les infobulles.
 */
export function buildCallouts(a: CalloutArgs): CalloutContent[] {
  const out: CalloutContent[] = [];
  const pos = (id: UnitId) => a.positions.get(id) ?? a.view.units[id]?.pos;

  a.selection.slice(0, 3).forEach((id, i) => {
    const u = a.view.units[id];
    const at = pos(id);
    if (!u || !at) return;
    const sys = u.systemId ? a.catalog[u.systemId] : undefined;
    const lines: string[] = [];
    const status = u.status ? t(`map.status.${u.status}`) : null;
    lines.push([u.count !== undefined ? `×${u.count}` : null, status].filter(Boolean).join(' · '));
    const dest = u.move ? movementDestination(u.move) : undefined;
    if (dest && u.status === 'moving') {
      const km = distanceKm(at, dest);
      const end = u.move!.legs[u.move!.legs.length - 1]!.t1;
      lines.push(`→ ${fmtKm(km)} · ${fmtDuration(Math.max(0, end - a.t))}`);
    }
    out.push({
      id: `sel:${id}`,
      at,
      title: sys?.name ?? t('map.tip.unknownType'),
      lines: lines.filter(Boolean),
      priority: 100 - i,
      tone: 'cyan',
    });
  });

  const targetId = pendingTargetId(a.pending) ?? a.inspected;
  if (targetId) {
    const u = a.view.units[targetId];
    const at = pos(targetId);
    if (u && at) {
      const sys = u.systemId ? a.catalog[u.systemId] : undefined;
      out.push({
        id: `tgt:${targetId}`,
        at,
        title: sys?.name ?? t('map.tip.unknown'),
        lines: [
          [a.view.nations[u.owner]?.name ?? u.owner, u.count !== undefined ? `×${u.count}` : null]
            .filter(Boolean)
            .join(' · '),
        ],
        priority: 95,
        tone: 'red',
      });
    }
  }

  // Captures : étiquettes à partir de l'échelle régionale (à l'échelle du monde, le contour suffit).
  const capturing =
    a.zoom < 3.4
      ? []
      : a.captures
        ? a.captures.map((id) => a.view.provinces[id]).filter((p) => !!p)
        : Object.values(a.view.provinces);
  for (const p of capturing) {
    if (!p.capture) continue;
    const def = a.defs[p.id];
    if (!def || (a.inView && !a.inView(def.cityPoint))) continue;
    const span = Math.max(1, p.capture.completesAt - p.capture.startedAt);
    const f = Math.max(0, Math.min(1, (a.t - p.capture.startedAt) / span));
    const threat = p.owner === a.me;
    out.push({
      id: `cap:${p.id}`,
      at: def.cityPoint,
      title: def.cityName ?? def.name,
      lines: [
        `${t('map.tip.capture')} ${Math.round(f * 100)} % · ${fmtDuration(Math.max(0, p.capture.completesAt - a.t))}`,
      ],
      progress: f,
      priority: threat ? 85 : 70,
      tone: threat ? 'red' : 'amber',
    });
  }
  return out;
}
