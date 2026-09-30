/**
 * Infobulles de la carte, style terminal : survol (ordinateur) ou appui long (mobile).
 * `tipModel` (pur) décrit le contenu ; `MapTooltip` l'affiche dans un élément DOM positionné.
 */
import { flagUrl } from '@redline/ui';
import type {
  GameTime,
  NationId,
  PlayerView,
  ProvinceDef,
  SystemId,
  UnitId,
  UnitView,
  WeaponSystem,
} from '@redline/shared';
import { fmtDuration, fmtInt, fmtKm, t } from '../i18n/index.js';
import { INTEL_STALE_MS } from './features.js';
import { REL_COLOR, relationOf, type Rel } from './palette.js';

export type TipTarget =
  | { kind: 'units'; ids: UnitId[] }
  | { kind: 'city'; provinceId: string }
  | { kind: 'building'; provinceId: string; type: string };

export interface TipRow {
  k: string;
  v: string;
  /** Couleur de la valeur (jeton CSS ou hex). */
  tone?: string;
  /** Jauge 0..1 affichée à la place/à côté de la valeur. */
  bar?: number;
}

export interface TipModel {
  /** Argument de l'invite (`inspect <arg>`). */
  arg: string;
  title: string;
  sub?: string;
  nation?: { id: NationId; name: string };
  rel?: Rel;
  rows: TipRow[];
  list?: string[];
}

export interface TipCtx {
  view: PlayerView;
  me: NationId | null;
  catalog: Record<SystemId, WeaponSystem>;
  defs: Record<string, ProvinceDef>;
  t: GameTime;
}

const AMBER = '#ffb020';
const RED = '#ff4d5e';
const GREEN = '#3ddc84';
const CYAN = '#4cc9f0';

function hpTone(r: number) {
  return r > 0.6 ? GREEN : r > 0.3 ? AMBER : RED;
}

function unitRows(u: UnitView, sys: WeaponSystem | undefined, ctx: TipCtx): TipRow[] {
  const rows: TipRow[] = [];
  if (u.count !== undefined) rows.push({ k: t('map.tip.count'), v: `×${fmtInt(u.count)}` });
  if (u.hpRatio !== undefined)
    rows.push({
      k: t('map.tip.hp'),
      v: `${Math.round(u.hpRatio * 100)} %`,
      bar: u.hpRatio,
      tone: hpTone(u.hpRatio),
    });
  if (u.status)
    rows.push({
      k: t('map.tip.state'),
      v: t(`map.status.${u.status}`),
      tone: u.status === 'combat' ? RED : u.status === 'moving' ? CYAN : undefined,
    });
  if (u.supply)
    rows.push({
      k: t('map.tip.supply'),
      v: t(`map.supply.${u.supply}`),
      tone: u.supply === 'cut' ? RED : u.supply === 'limited' ? AMBER : undefined,
    });
  if (u.mission && u.mission.kind !== 'none') {
    const fuel = u.mission.fuelH !== undefined ? ` · ${u.mission.fuelH.toFixed(1)} h` : '';
    rows.push({ k: t('map.tip.mission'), v: `${t(`map.mission.${u.mission.kind}`)}${fuel}` });
  }
  if (sys && u.level !== 'detected') {
    rows.push({ k: t('map.tip.range'), v: fmtKm(sys.weaponRangeKm.max), tone: AMBER });
  }
  if (u.level !== 'own') {
    const age = ctx.t - u.lastSeen;
    rows.push({
      k: t('map.tip.seen'),
      v: age < 60_000 ? t('map.tip.seenNow') : t('map.tip.seenAgo', { value: fmtDuration(age) }),
      tone: age > 30 * 60_000 ? AMBER : undefined,
    });
    if (u.uncertaintyKm >= 2)
      rows.push({
        k: t('map.tip.uncertainty'),
        v: t('map.tip.uncertaintyValue', { value: fmtKm(u.uncertaintyKm) }),
      });
  }
  return rows;
}

function unitFlags(u: UnitView, sys: WeaponSystem | undefined, rel: Rel): string[] {
  const out: string[] = [];
  if (u.decoy) out.push(t('map.flag.decoy'));
  if (sys?.category === 'submarine')
    out.push(t(rel === 'own' ? 'map.flag.submerged' : 'map.flag.sonar'));
  if (u.jamming) out.push(t('map.flag.jamming'));
  return out;
}

export function tipModel(target: TipTarget, ctx: TipCtx): TipModel | null {
  const { view } = ctx;
  if (target.kind === 'units') {
    const units = target.ids.map((id) => view.units[id]).filter((u): u is UnitView => !!u);
    const u = units[0];
    if (!u) return null;
    const sys = u.systemId ? ctx.catalog[u.systemId] : undefined;
    const rel = relationOf(u.owner, ctx.me, view.nations);
    const nation = { id: u.owner, name: view.nations[u.owner]?.name ?? u.owner };
    if (units.length === 1) {
      if (u.missile) {
        return {
          arg: u.id,
          title: sys?.name ?? t('map.tip.missile'),
          sub: t('map.tip.missile'),
          nation,
          rel,
          rows: [
            {
              k: t('map.tip.impact'),
              v: t('map.tip.impactIn', {
                value: fmtDuration(Math.max(0, u.missile.impactAt - ctx.t)),
              }),
              tone: RED,
            },
          ],
        };
      }
      return {
        arg: u.id,
        title: sys?.name ?? t('map.tip.unknown'),
        sub: `${t(`map.rel.${rel}`)}${sys ? ` · ${sys.unitLabel ?? ''}`.replace(/ · $/, '') : ''}`,
        nation,
        rel,
        rows: unitRows(u, sys, ctx),
        list: unitFlags(u, sys, rel),
      };
    }
    // Pile : synthèse et liste des premières unités.
    let total = 0;
    let known = 0;
    for (const x of units)
      if (x.count !== undefined) {
        total += x.count;
        known++;
      }
    const byType = new Map<string, number>();
    for (const x of units) {
      const n = x.systemId ? (ctx.catalog[x.systemId]?.name ?? '?') : t('map.tip.unknownType');
      byType.set(n, (byType.get(n) ?? 0) + (x.count ?? 1));
    }
    const list = [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([n, c]) => `×${c}  ${n}`);
    if (byType.size > 5) list.push(t('map.tip.stackMore', { count: byType.size - 5 }));
    const rows: TipRow[] = [
      { k: t('map.tip.stack'), v: t('map.tip.stackValue', { count: units.length }) },
    ];
    if (known) rows.push({ k: t('map.tip.count'), v: `×${fmtInt(total)}` });
    const combat = units.some((x) => x.status === 'combat');
    if (combat) rows.push({ k: t('map.tip.state'), v: t('map.status.combat'), tone: RED });
    return {
      arg: `${u.id}+${units.length - 1}`,
      title: sys?.name ?? t('map.tip.unknown'),
      sub: t(`map.rel.${rel}`),
      nation,
      rel,
      rows,
      list,
    };
  }
  const def = ctx.defs[target.provinceId];
  const p = view.provinces[target.provinceId];
  if (!def) return null;
  const owner = p?.owner ?? def.nationId;
  const rel = relationOf(owner, ctx.me, view.nations);
  const nation = { id: owner, name: view.nations[owner]?.name ?? owner };
  if (target.kind === 'building') {
    const st = p?.buildingState?.find((b) => b.type === target.type);
    const rows: TipRow[] = [{ k: t('map.tip.city'), v: def.cityName ?? def.name }];
    if (st) {
      rows.push({
        k: t('map.tip.hp'),
        v: `${Math.round(st.health * 100)} %`,
        bar: st.health,
        tone: hpTone(st.health),
      });
    }
    const state = !st
      ? null
      : st.health <= 0.02
        ? t('map.bld.down')
        : st.repairUntil && st.repairUntil > ctx.t
          ? t('map.bld.repair')
          : st.upgradeUntil && st.upgradeUntil > ctx.t
            ? t('map.bld.upgrade')
            : st.health < 0.95
              ? t('map.bld.damaged')
              : null;
    if (state) rows.push({ k: t('map.tip.state'), v: state, tone: AMBER });
    return {
      arg: `${def.id}/${target.type}`,
      title: `${t(`map.bld.${target.type}`)}${st?.level && st.level > 1 ? ` · ${t('map.bld.level', { value: st.level })}` : ''}`,
      sub: t(`map.rel.${rel}`),
      nation,
      rel,
      rows,
    };
  }
  const rows: TipRow[] = [];
  if (def.population) rows.push({ k: t('map.tip.population'), v: fmtInt(def.population) });
  if (p?.capture) {
    const span = Math.max(1, p.capture.completesAt - p.capture.startedAt);
    const f = Math.max(0, Math.min(1, (ctx.t - p.capture.startedAt) / span));
    rows.push({
      k: t('map.tip.capture'),
      v: `${Math.round(f * 100)} %`,
      bar: f,
      tone: owner === ctx.me ? RED : AMBER,
    });
  }
  if (p?.fortification?.level)
    rows.push({
      k: t('map.tip.fortification'),
      v: t('map.tip.fortLevel', { value: p.fortification.level }),
    });
  if (p?.intel) {
    const old = ctx.t - p.intel.updatedAt > INTEL_STALE_MS;
    rows.push({
      k: t('map.tip.intel'),
      v: `${p.intel.level}/3 · ${t(`map.intel.${p.intel.level}`)}${old ? ` (${t('map.intel.old')})` : ''}`,
      bar: p.intel.level / 3,
      tone: [RED, AMBER, CYAN, GREEN][p.intel.level],
    });
  }
  if (p?.unrest && p.unrest > 0)
    rows.push({
      k: t('map.tip.unrest'),
      v: `${Math.round(p.unrest)} %`,
      bar: p.unrest / 100,
      tone: RED,
    });
  const list: string[] = [];
  if (p?.blockaded) list.push(t('map.tip.blockaded'));
  if (p?.noFlyZone) list.push(t('map.tip.noFlyZone'));
  if (p?.disputedId) list.push(t('map.tip.disputed'));
  if (p?.buildings.length)
    list.push(
      `${t('map.tip.buildings')} : ${p.buildings.map((b) => t(`map.bld.${b}`)).join(', ')}`,
    );
  return {
    arg: def.id,
    title: def.cityName ?? def.name,
    sub:
      def.isCapital || def.cityRank === 1
        ? t('map.tip.capital')
        : def.name !== (def.cityName ?? def.name)
          ? def.name
          : t('map.tip.city'),
    nation,
    rel,
    rows,
    list,
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Élément d'infobulle unique, positionné près du pointeur sans sortir de la carte. */
export class MapTooltip {
  readonly el: HTMLDivElement;
  private visible = false;

  constructor(private readonly host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'rlm-tip';
    this.el.setAttribute('role', 'tooltip');
    host.appendChild(this.el);
  }

  show(m: TipModel, x: number, y: number) {
    const edge = m.rel ? REL_COLOR[m.rel] : CYAN;
    const flag = m.nation ? flagUrl(m.nation.id) : null;
    const rows = m.rows
      .map((r) => {
        const bar =
          r.bar !== undefined
            ? `<span class="rlm-tip__bar"><i style="width:${Math.round(Math.max(0, Math.min(1, r.bar)) * 100)}%;background:${r.tone ?? edge}"></i></span>`
            : '';
        return `<div class="rlm-tip__row"><span class="rlm-tip__k">${esc(r.k)}</span><span class="rlm-tip__v"${r.tone ? ` style="color:${r.tone}"` : ''}>${bar}${esc(r.v)}</span></div>`;
      })
      .join('');
    const list = m.list?.length
      ? `<ul class="rlm-tip__list">${m.list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
      : '';
    this.el.style.setProperty('--rlm-edge', edge);
    this.el.innerHTML =
      `<div class="rlm-tip__prompt"><span>map:\\&gt;</span> ${esc(t('map.tip.prompt'))} ${esc(m.arg)}</div>` +
      `<div class="rlm-tip__head">${flag ? `<img src="${flag}" alt="" />` : ''}<div><div class="rlm-tip__title">${esc(m.title)}</div>` +
      `<div class="rlm-tip__sub">${m.nation ? `${esc(m.nation.name)} · ` : ''}${esc(m.sub ?? '')}</div></div></div>` +
      rows +
      list;
    this.el.classList.add('rlm-tip--on');
    this.visible = true;
    this.place(x, y);
  }

  place(x: number, y: number) {
    if (!this.visible) return;
    const hw = this.host.clientWidth;
    const hh = this.host.clientHeight;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    let left = x + 16;
    let top = y + 14;
    if (left + w > hw - 6) left = x - w - 16;
    if (top + h > hh - 6) top = y - h - 14;
    this.el.style.transform = `translate(${Math.max(6, left)}px, ${Math.max(6, top)}px)`;
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove('rlm-tip--on');
  }

  get shown() {
    return this.visible;
  }

  destroy() {
    this.el.remove();
  }
}
