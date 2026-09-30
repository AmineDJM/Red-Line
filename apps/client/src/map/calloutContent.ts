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
import { fmtKm, t } from '../i18n/index.js';
import type { PendingOrder } from '../store/ui.js';
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
}

/** Sous-ensemble limité d'éléments qui méritent une étiquette cartouche (critique 6.4). */
export function buildCallouts(a: CalloutArgs): CalloutContent[] {
  const out: CalloutContent[] = [];
  const pos = (id: UnitId) => a.positions.get(id) ?? a.view.units[id]?.pos;

  a.selection.slice(0, 4).forEach((id, i) => {
    const u = a.view.units[id];
    const at = pos(id);
    if (!u || !at) return;
    const sys = u.systemId ? a.catalog[u.systemId] : undefined;
    const lines: string[] = [];
    const status = u.status ? t(`game.status.${u.status}`) : null;
    lines.push([u.count !== undefined ? t('game.army.count', { count: u.count }) : null, status].filter(Boolean).join(' · '));
    const dest = u.move ? movementDestination(u.move) : undefined;
    if (dest && u.status === 'moving') lines.push(t('game.callout.moving', { value: fmtKm(distanceKm(at, dest)) }));
    out.push({ id: `sel:${id}`, at, title: sys?.name ?? t('game.selection.unknownType'), lines: lines.filter(Boolean), priority: 100 - i, tone: 'violet' });
  });

  const targetId = a.pending?.kind === 'attack' ? a.pending.targetId : a.inspected;
  if (targetId) {
    const u = a.view.units[targetId];
    const at = pos(targetId);
    if (u && at) {
      const sys = u.systemId ? a.catalog[u.systemId] : undefined;
      out.push({
        id: `tgt:${targetId}`,
        at,
        title: sys?.name ?? t('game.selection.unknownType'),
        lines: [a.view.nations[u.owner]?.name ?? u.owner, t(`game.level.${u.level}`)],
        priority: 95,
        tone: 'red',
      });
    }
  }

  for (const p of Object.values(a.view.provinces)) {
    const def = a.defs[p.id];
    if (!def) continue;
    if (p.capture) {
      const span = Math.max(1, p.capture.completesAt - p.capture.startedAt);
      const pct = Math.max(0, Math.min(100, Math.round(((a.t - p.capture.startedAt) / span) * 100)));
      const threat = p.owner === a.me;
      out.push({
        id: `cap:${p.id}`,
        at: def.cityPoint,
        title: def.name,
        lines: [t('game.callout.capture', { value: pct })],
        priority: threat ? 85 : 70,
        tone: threat ? 'red' : 'orange',
      });
      continue;
    }
    if (a.zoom >= 3.8 && p.owner === a.me && p.buildings.length) {
      out.push({
        id: `bld:${p.id}`,
        at: def.cityPoint,
        title: def.isCapital ? `${def.name} · ${t('game.callout.capital')}` : def.name,
        lines: p.buildings.map((b) => t(`buildings.${b}`)),
        priority: (def.isCapital ? 60 : 40) + p.buildings.length,
      });
    }
  }
  return out;
}
