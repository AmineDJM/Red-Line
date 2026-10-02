/**
 * Console de commande : analyse et autocomplétion (fonctions pures, testées).
 *
 *   move <unités> <lieu>           déplacer (unités : u12, u12,u14, sel, ou nom de système)
 *   attack <unités> <cible>        attaquer une unité ennemie (identifiant)
 *   stop [unités]                  arrêter
 *   produce [n] <système> [lieu]   produire (province à vous ; défaut : capitale)
 *   research <nœud>                lancer une recherche (aero.gen5, ou nom)
 *   goto <lieu>                    centrer la carte (province, ville, nation, « lat,lng »)
 *   speed <n> · pause · resume     temps (solo)
 *   intel <opération> <cible>      opération de renseignement (nation ou province)
 *   peace|ceasefire|war <nation>   diplomatie
 *   open <fenêtre>                 ouvrir un domaine (armée, production…)
 *   select <unités> · mobilize on|off · help · clear
 * Alias français : deplacer, attaquer, produire, rechercher, aller, vitesse, reprendre, paix,
 * cessez-le-feu, guerre, ouvrir, selectionner, mobiliser, aide, effacer.
 */
import {
  INTEL_OPS,
  frForms,
  frLe,
  type LngLat,
  type NationDef,
  type NationId,
  type Order,
  type PlayerView,
  type ProvinceDef,
  type ResearchNode,
  type UnitId,
  type WeaponSystem,
} from '@redline/shared';
import type { CommandSuggestion } from '@redline/ui';
import { WINDOW_IDS, type WindowId } from '../store/ui.js';
import { LOCALE, isFrench } from '../i18n/index.js';

/** Formes du nom de pays : grammaire française, ou nom seul dans les autres langues. */
const forms = (n: NationDef) =>
  isFrench
    ? frForms(n.name, n.article)
    : { nation: n.name, nationLe: n.name, NationLe: n.name, deNation: n.name, aNation: n.name };

export interface CommandCtx {
  view: PlayerView;
  me: NationId;
  catalog: Record<string, WeaponSystem>;
  provinces: Record<string, ProvinceDef>;
  nations: Record<string, NationDef>;
  research: Record<string, ResearchNode>;
  selection: UnitId[];
  /** Libellés traduits (fenêtres, opérations, aide). */
  label: (key: string, opts?: Record<string, unknown>) => string;
}

export type CommandAction =
  | { type: 'order'; order: Order; summary: string }
  | { type: 'goto'; at: LngLat; zoom: number; summary: string }
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'open'; window: WindowId }
  | { type: 'select'; unitIds: UnitId[] }
  | { type: 'help' }
  | { type: 'clear' }
  | { type: 'error'; message: string };

type Cmd =
  | 'move'
  | 'attack'
  | 'stop'
  | 'produce'
  | 'research'
  | 'goto'
  | 'speed'
  | 'pause'
  | 'resume'
  | 'intel'
  | 'peace'
  | 'ceasefire'
  | 'war'
  | 'open'
  | 'select'
  | 'mobilize'
  | 'help'
  | 'clear';

export const COMMANDS: { id: Cmd; aliases: string[]; args: ArgKind[] }[] = [
  { id: 'move', aliases: ['deplacer', 'mv'], args: ['units', 'place'] },
  { id: 'attack', aliases: ['attaquer', 'atk'], args: ['units', 'target'] },
  { id: 'stop', aliases: ['arreter'], args: ['units'] },
  { id: 'produce', aliases: ['produire', 'prod'], args: ['count', 'system', 'place'] },
  { id: 'research', aliases: ['rechercher', 'rd'], args: ['node'] },
  { id: 'goto', aliases: ['aller', 'go'], args: ['place'] },
  { id: 'speed', aliases: ['vitesse'], args: ['speed'] },
  { id: 'pause', aliases: [], args: [] },
  { id: 'resume', aliases: ['reprendre', 'play'], args: [] },
  { id: 'intel', aliases: ['renseignement'], args: ['op', 'nation'] },
  { id: 'peace', aliases: ['paix'], args: ['nation'] },
  { id: 'ceasefire', aliases: ['cessez-le-feu', 'treve'], args: ['nation'] },
  { id: 'war', aliases: ['guerre'], args: ['nation'] },
  { id: 'open', aliases: ['ouvrir'], args: ['window'] },
  { id: 'select', aliases: ['selectionner', 'sel'], args: ['units'] },
  { id: 'mobilize', aliases: ['mobiliser'], args: ['onoff'] },
  { id: 'help', aliases: ['aide', '?'], args: [] },
  { id: 'clear', aliases: ['effacer', 'cls'], args: [] },
];

type ArgKind =
  | 'units'
  | 'place'
  | 'target'
  | 'count'
  | 'system'
  | 'node'
  | 'speed'
  | 'op'
  | 'nation'
  | 'window'
  | 'onoff';

/** minuscules, sans accents, espaces normalisés. */
export function norm(s: string): string {
  return s
    .toLocaleLowerCase(LOCALE)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(s: string): string {
  return norm(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function findCommand(word: string) {
  const w = norm(word);
  return COMMANDS.find((c) => c.id === w || c.aliases.includes(w));
}

/** Score de correspondance : 3 exact, 2 préfixe, 1 inclusion, 0 aucune. */
function score(query: string, ...names: string[]): number {
  const q = slug(query);
  if (!q) return 1;
  let best = 0;
  for (const n of names) {
    const s = slug(n);
    if (s === q) return 3;
    if (s.startsWith(q)) best = Math.max(best, 2);
    else if (s.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

function bestOf<T>(items: T[], query: string, names: (x: T) => string[]): T | null {
  let best: T | null = null;
  let bs = 0;
  for (const it of items) {
    const s = score(query, ...names(it));
    if (s > bs) {
      bs = s;
      best = it;
    }
  }
  return bs > 0 ? best : null;
}

const provNames = (p: ProvinceDef) => [p.cityName ?? '', p.name, p.id];

// ——— Résolution des arguments ———

export function resolveUnits(token: string, ctx: CommandCtx): UnitId[] {
  const own = Object.values(ctx.view.units).filter(
    (u) => u.owner === ctx.me && u.level === 'own' && u.status !== 'destroyed',
  );
  const t = norm(token);
  if (!t || t === 'sel' || t === 'selection') return ctx.selection;
  if (t === 'all' || t === 'tout' || t === 'tous') return own.map((u) => u.id);
  const ids = t.split(',').filter(Boolean);
  const direct = ids.filter((id) => own.some((u) => u.id === id));
  if (direct.length === ids.length && direct.length) return direct;
  // Nom de système : toutes les unités de ce système.
  const sys = bestOf(
    [...new Set(own.map((u) => u.systemId).filter(Boolean) as string[])],
    token,
    (id) => [ctx.catalog[id]?.name ?? '', id, id.split('.')[1] ?? ''],
  );
  return sys ? own.filter((u) => u.systemId === sys).map((u) => u.id) : [];
}

export function resolvePlace(
  text: string,
  ctx: CommandCtx,
): { at: LngLat; name: string; provinceId?: string } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { at: [lng, lat], name: text.trim() };
  }
  if (!norm(text)) return null;
  const prov = bestOf(Object.values(ctx.provinces), text, provNames);
  const nat = bestOf(Object.values(ctx.nations), text, (n) => [n.name, n.id]);
  const ps = prov ? score(text, ...provNames(prov)) : 0;
  const ns = nat ? score(text, nat.name, nat.id) : 0;
  if (nat && ns >= ps) {
    const cap = ctx.provinces[nat.capitalProvinceId];
    if (cap) return { at: cap.cityPoint, name: nat.name, provinceId: cap.id };
  }
  if (prov) return { at: prov.cityPoint, name: prov.cityName ?? prov.name, provinceId: prov.id };
  return null;
}

function resolveSystem(token: string, ctx: CommandCtx): WeaponSystem | null {
  return bestOf(Object.values(ctx.catalog), token, (s) => [s.name, s.id, s.id.split('.')[1] ?? '']);
}

function resolveNation(text: string, ctx: CommandCtx): NationDef | null {
  return bestOf(
    Object.values(ctx.nations).filter((n) => n.id !== ctx.me),
    text,
    (n) => [n.name, n.id],
  );
}

function resolveNode(text: string, ctx: CommandCtx): ResearchNode | null {
  return bestOf(Object.values(ctx.research), text, (n) => [
    n.id,
    n.id.replace(/^research\./, ''),
    n.name,
  ]);
}

/** Noms d'une fenêtre : identifiant, titre, libellé court (« Armées », « Arsenal »…). */
const windowNames = (w: WindowId, ctx: CommandCtx) => [
  w,
  ctx.label(`sections.${w}`),
  ctx.label(`sections.short.${w}`),
];

function resolveWindow(text: string, ctx: CommandCtx): WindowId | null {
  return bestOf([...WINDOW_IDS], text, (w) => windowNames(w, ctx));
}

// ——— Analyse ———

export function parseCommand(input: string, ctx: CommandCtx): CommandAction {
  const line = input.trim().replace(/^[:>]\s*/, '');
  if (!line) return { type: 'error', message: ctx.label('console.errors.empty') };
  const [head = '', ...rest] = line.split(/\s+/);
  const cmd = findCommand(head);
  if (!cmd) {
    // Raccourci : « armée » seul ouvre la fenêtre, un lieu seul centre la carte.
    const w = resolveWindow(line, ctx);
    if (w && score(line, ...windowNames(w, ctx)) >= 2) return { type: 'open', window: w };
    return { type: 'error', message: ctx.label('console.errors.unknown', { cmd: head }) };
  }
  const err = (key: string, opts?: Record<string, unknown>): CommandAction => ({
    type: 'error',
    message: ctx.label(`console.errors.${key}`, opts),
  });
  switch (cmd.id) {
    case 'help':
      return { type: 'help' };
    case 'clear':
      return { type: 'clear' };
    case 'pause':
      return { type: 'pause', paused: true };
    case 'resume':
      return { type: 'pause', paused: false };
    case 'speed': {
      const n = Number((rest[0] ?? '').replace(/^[x×]/, ''));
      return n > 0 ? { type: 'speed', speed: n } : err('speed');
    }
    case 'open': {
      const w = resolveWindow(rest.join(' '), ctx);
      return w ? { type: 'open', window: w } : err('window');
    }
    case 'goto': {
      const p = resolvePlace(rest.join(' '), ctx);
      return p
        ? {
            type: 'goto',
            at: p.at,
            zoom: 6,
            summary: ctx.label('console.done.goto', { place: p.name }),
          }
        : err('place', { place: rest.join(' ') });
    }
    case 'select': {
      const ids = resolveUnits(rest.join(' '), ctx);
      return ids.length ? { type: 'select', unitIds: ids } : err('units');
    }
    case 'stop': {
      const ids = resolveUnits(rest.join(' ') || 'sel', ctx);
      return ids.length
        ? {
            type: 'order',
            order: { kind: 'stop', unitIds: ids },
            summary: ctx.label('console.done.stop', { count: ids.length }),
          }
        : err('units');
    }
    case 'move': {
      const ids = resolveUnits(rest[0] ?? '', ctx);
      if (!ids.length) return err('units');
      const p = resolvePlace(rest.slice(1).join(' '), ctx);
      if (!p) return err('place', { place: rest.slice(1).join(' ') });
      return {
        type: 'order',
        order: { kind: 'move', unitIds: ids, to: p.at },
        summary: ctx.label('console.done.move', { count: ids.length, place: p.name }),
      };
    }
    case 'attack': {
      const ids = resolveUnits(rest[0] ?? '', ctx);
      if (!ids.length) return err('units');
      const target = norm(rest[1] ?? '');
      const u = ctx.view.units[target];
      if (!u || u.owner === ctx.me) return err('target', { target: rest[1] ?? '' });
      return {
        type: 'order',
        order: { kind: 'attack', unitIds: ids, targetId: u.id },
        summary: ctx.label('console.done.attack', { count: ids.length, target: u.id }),
      };
    }
    case 'produce': {
      let args = rest;
      let count = 1;
      if (args[0] && /^\d+$/.test(args[0])) {
        count = Math.min(20, Math.max(1, Number(args[0])));
        args = args.slice(1);
      }
      const s = resolveSystem(args[0] ?? '', ctx);
      if (!s) return err('system', { system: args[0] ?? '' });
      const placeText = args
        .slice(1)
        .join(' ')
        .replace(/^(a|à|in|en)\s+/i, '');
      const mine = Object.values(ctx.provinces).filter(
        (p) => ctx.view.provinces[p.id]?.owner === ctx.me,
      );
      const prov = placeText
        ? bestOf(mine, placeText, provNames)
        : (mine.find((p) => p.isCapital) ?? mine[0] ?? null);
      if (!prov) return err('province', { place: placeText });
      return {
        type: 'order',
        order: { kind: 'produce', provinceId: prov.id, systemId: s.id, count },
        summary: ctx.label('console.done.produce', {
          count,
          system: s.name,
          place: prov.cityName ?? prov.name,
        }),
      };
    }
    case 'research': {
      const n = resolveNode(rest.join(' '), ctx);
      return n
        ? {
            type: 'order',
            order: { kind: 'research', nodeId: n.id },
            summary: ctx.label('console.done.research', { node: n.name }),
          }
        : err('node', { node: rest.join(' ') });
    }
    case 'intel': {
      const op = bestOf([...INTEL_OPS], rest[0] ?? '', (o) => [o, ctx.label(`intel.ops.${o}`)]);
      if (!op) return err('op', { op: rest[0] ?? '' });
      const targetText = rest.slice(1).join(' ');
      const nation = resolveNation(targetText, ctx);
      const place = nation ? null : resolvePlace(targetText, ctx);
      if (!nation && !place) return err('place', { place: targetText });
      return {
        type: 'order',
        order: {
          kind: 'intelOp',
          op,
          target: nation
            ? { nationId: nation.id }
            : { provinceId: place!.provinceId, at: place!.at, radiusKm: 100 },
        },
        summary: ctx.label('console.done.intel', {
          op: ctx.label(`intel.ops.${op}`),
          target: nation
            ? isFrench
              ? frLe(nation.name, nation.article)
              : nation.name
            : place!.name,
        }),
      };
    }
    case 'peace':
    case 'ceasefire':
    case 'war': {
      const n = resolveNation(rest.join(' '), ctx);
      if (!n) return err('nation', { nation: rest.join(' ') });
      const order: Order =
        cmd.id === 'war'
          ? { kind: 'declareWar', nationId: n.id }
          : {
              kind: 'proposePeace',
              nationId: n.id,
              type: cmd.id === 'peace' ? 'peace' : 'ceasefire',
            };
      return {
        type: 'order',
        order,
        summary: ctx.label(`console.done.${cmd.id}`, forms(n)),
      };
    }
    case 'mobilize': {
      const v = norm(rest[0] ?? 'on');
      const on = !['off', 'non', '0', 'fin'].includes(v);
      return {
        type: 'order',
        order: { kind: 'mobilize', on },
        summary: ctx.label(on ? 'console.done.mobilizeOn' : 'console.done.mobilizeOff'),
      };
    }
  }
}

// ——— Autocomplétion ———

function withToken(prefix: string, value: string): string {
  return `${prefix}${value} `;
}

export function suggest(input: string, ctx: CommandCtx, limit = 8): CommandSuggestion[] {
  const raw = input.replace(/^[:>]\s*/, '');
  const endsWithSpace = /\s$/.test(raw);
  const parts = raw.trim() ? raw.trim().split(/\s+/) : [];
  // Premier mot : commandes.
  if (parts.length === 0 || (parts.length === 1 && !endsWithSpace)) {
    const q = parts[0] ?? '';
    return COMMANDS.filter((c) => score(q, c.id, ...c.aliases) > 0)
      .sort((a, b) => score(q, b.id, ...b.aliases) - score(q, a.id, ...a.aliases))
      .slice(0, limit + 4)
      .map((c) => ({
        id: `cmd-${c.id}`,
        kind: ctx.label('console.kinds.cmd'),
        label: `${c.id}${c.args.length ? ' ' + c.args.map((a) => `<${ctx.label(`console.args.${a}`)}>`).join(' ') : ''}`,
        hint: ctx.label(`console.help.${c.id}`),
        insert: c.args.length ? `${c.id} ` : c.id,
        run: !c.args.length,
      }));
  }
  const cmd = findCommand(parts[0]!);
  if (!cmd) return [];
  // Position de l'argument en cours de saisie ; le dernier argument « lieu, nation, nœud,
  // fenêtre » absorbe la fin de la ligne (noms avec espaces).
  const head = parts[0]!;
  const tokens = parts.slice(1);
  let args = cmd.args;
  if (cmd.id === 'produce') {
    const numeric = /^\d+$/.test(tokens[0] ?? '') && (tokens.length > 1 || endsWithSpace);
    if (!numeric) args = args.filter((a) => a !== 'count');
  }
  if (!args.length) return [];
  const done = endsWithSpace ? tokens.length : tokens.length - 1;
  const greedy = ['place', 'nation', 'node', 'window'].includes(args[args.length - 1]!);
  let lastArg: ArgKind;
  let prefix: string;
  let q: string;
  if (greedy && done >= args.length - 1) {
    lastArg = args[args.length - 1]!;
    prefix = [head, ...tokens.slice(0, args.length - 1)].join(' ') + ' ';
    q = tokens.slice(args.length - 1).join(' ');
  } else if (done < args.length) {
    lastArg = args[done]!;
    prefix = [head, ...tokens.slice(0, done)].join(' ') + ' ';
    q = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '');
  } else return [];

  const own = Object.values(ctx.view.units).filter((u) => u.owner === ctx.me && u.level === 'own');
  const out: CommandSuggestion[] = [];
  const push = (s: CommandSuggestion) => out.length < limit && out.push(s);
  const rank = <T>(items: T[], names: (x: T) => string[]) =>
    items
      .map((x) => ({ x, s: score(q, ...names(x)) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.x);

  switch (lastArg) {
    case 'units': {
      if (ctx.selection.length && score(q, 'sel', 'selection') > 0)
        push({
          id: 'u-sel',
          kind: ctx.label('console.kinds.unit'),
          label: 'sel',
          detail: ctx.label('console.selection', { count: ctx.selection.length }),
          insert: withToken(prefix, 'sel'),
        });
      const systems = [...new Set(own.map((u) => u.systemId).filter(Boolean) as string[])];
      for (const id of rank(systems, (id) => [ctx.catalog[id]?.name ?? '', id]).slice(0, 4)) {
        const n = own.filter((u) => u.systemId === id).length;
        push({
          id: `s-${id}`,
          kind: ctx.label('console.kinds.unit'),
          label: slug(ctx.catalog[id]?.name ?? id),
          hint: ctx.catalog[id]?.name,
          detail: `×${n}`,
          insert: withToken(prefix, slug(ctx.catalog[id]?.name ?? id)),
        });
      }
      for (const u of rank(own, (u) => [u.id, ctx.catalog[u.systemId ?? '']?.name ?? '']).slice(
        0,
        4,
      ))
        push({
          id: `u-${u.id}`,
          kind: ctx.label('console.kinds.unit'),
          label: u.id,
          hint: ctx.catalog[u.systemId ?? '']?.name,
          insert: withToken(prefix, u.id),
        });
      break;
    }
    case 'target': {
      const enemies = Object.values(ctx.view.units).filter((u) => u.owner !== ctx.me);
      for (const u of rank(enemies, (u) => [u.id, ctx.catalog[u.systemId ?? '']?.name ?? '']).slice(
        0,
        limit,
      ))
        push({
          id: `t-${u.id}`,
          kind: ctx.label('console.kinds.target'),
          label: u.id,
          hint: u.systemId ? ctx.catalog[u.systemId]?.name : ctx.label('game.legend.detected'),
          detail: ctx.nations[u.owner]?.name,
          insert: withToken(prefix, u.id),
        });
      break;
    }
    case 'count':
    case 'system': {
      for (const s of rank(Object.values(ctx.catalog), (s) => [
        s.name,
        s.id,
        s.id.split('.')[1] ?? '',
      ]).slice(0, limit))
        push({
          id: `sys-${s.id}`,
          kind: ctx.label('console.kinds.system'),
          label: slug(s.name),
          hint: `${s.name} · ${ctx.label(`categories.${s.category}`)}`,
          insert: withToken(prefix, slug(s.name)),
        });
      break;
    }
    case 'place': {
      const mineOnly = cmd.id === 'produce';
      const provs = Object.values(ctx.provinces).filter(
        (p) => !mineOnly || ctx.view.provinces[p.id]?.owner === ctx.me,
      );
      if (!mineOnly)
        for (const n of rank(Object.values(ctx.nations), (n) => [n.name, n.id]).slice(0, 2))
          push({
            id: `n-${n.id}`,
            kind: ctx.label('console.kinds.nation'),
            label: n.name,
            insert: withToken(prefix, n.name),
          });
      for (const p of rank(provs, provNames).slice(0, limit))
        push({
          id: `p-${p.id}`,
          kind: ctx.label('console.kinds.place'),
          label: p.cityName ?? p.name,
          hint: p.cityName && p.cityName !== p.name ? p.name : undefined,
          detail: ctx.nations[p.nationId]?.name,
          insert: withToken(prefix, p.cityName ?? p.name),
        });
      break;
    }
    case 'node': {
      const done = new Set(ctx.view.research?.done ?? []);
      for (const n of rank(
        Object.values(ctx.research).filter((n) => !done.has(n.id)),
        (n) => [n.id.replace(/^research\./, ''), n.name],
      ).slice(0, limit))
        push({
          id: `r-${n.id}`,
          kind: ctx.label('console.kinds.node'),
          label: n.id.replace(/^research\./, ''),
          hint: n.name,
          insert: withToken(prefix, n.id.replace(/^research\./, '')),
        });
      break;
    }
    case 'speed':
      for (const s of [1, 2, 4, 8, 16])
        push({
          id: `sp-${s}`,
          kind: ctx.label('console.kinds.value'),
          label: `×${s}`,
          insert: `${prefix}${s}`,
          run: true,
        });
      break;
    case 'op':
      for (const o of rank([...INTEL_OPS], (o) => [o, ctx.label(`intel.ops.${o}`)]).slice(0, limit))
        push({
          id: `op-${o}`,
          kind: ctx.label('console.kinds.op'),
          label: o,
          hint: ctx.label(`intel.ops.${o}`),
          insert: withToken(prefix, o),
        });
      break;
    case 'nation':
      for (const n of rank(
        Object.values(ctx.nations).filter((n) => n.id !== ctx.me),
        (n) => [n.name, n.id],
      ).slice(0, limit))
        push({
          id: `n-${n.id}`,
          kind: ctx.label('console.kinds.nation'),
          label: n.name,
          insert: withToken(prefix, n.name),
        });
      break;
    case 'window':
      for (const w of rank([...WINDOW_IDS], (w) => windowNames(w, ctx)))
        push({
          id: `w-${w}`,
          kind: ctx.label('console.kinds.window'),
          label: w,
          hint: ctx.label(`sections.${w}`),
          insert: `${prefix}${w}`,
          run: true,
        });
      break;
    case 'onoff':
      push({
        id: 'on',
        kind: ctx.label('console.kinds.value'),
        label: 'on',
        insert: `${prefix}on`,
        run: true,
      });
      push({
        id: 'off',
        kind: ctx.label('console.kinds.value'),
        label: 'off',
        insert: `${prefix}off`,
        run: true,
      });
      break;
  }
  return out;
}
