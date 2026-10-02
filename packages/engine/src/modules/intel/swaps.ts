import { DAY, HOUR, loc, type NationId, type SwapItemView, type SwapView } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { atWar, notify, sortedKeys } from '../../state/access.js';
import { noteLoc } from '../../state/loc.js';
import { scheduleMod } from '../kit.js';
import { signal } from '../registry.js';
import { addReputation, addStability, ds, isRegular, pairKey } from '../diplo/state.js';
import { endResolution } from '../diplo/council.js';
import { dzcfg } from './dzconfig.js';
import { hash01 } from './levels.js';
import { addTie, agentValue, exchanged, isLive, ownerKind, tie } from './detainees.js';
import { ist, nextId, type Agent, type Swap } from './state.js';
import { nationName, natLe } from './text.js';

/**
 * Négociations : échange d'agents détenus (1 contre 1, plusieurs contre plusieurs), libération contre
 * argent, accord de non-ingérence ou allègement des sanctions que l'on parraine. Propositions et
 * réponses par ordres (`proposeSwap`, `answerSwap`), comme les propositions de paix. Les IA évaluent
 * la valeur des agents (officier > source, accès), leurs relations et la guerre ; elles acceptent,
 * refusent, contre-proposent en faisant monter les enchères, et prennent l'initiative d'échanges.
 * Échanges possibles en guerre.
 */

function fail(error: NonNullable<OrderResult['error']>, message: string): OrderResult {
  return { ok: false, error, message };
}

function hasDiplo(state: EngineState): boolean {
  return !!state.mods.diplo;
}

function regular(state: EngineState, n: NationId): boolean {
  return !!state.nations[n]?.alive && (!hasDiplo(state) || isRegular(state, n));
}

function isPlayer(state: EngineState, n: NationId): boolean {
  return !!state.nations[n]?.isPlayer;
}

/** Fin de l'accord de non-ingérence entre deux nations (0 : aucun). */
export function accordUntil(state: EngineState, a: NationId, b: NationId): number {
  return ist(state).na?.[pairKey(a, b)] ?? 0;
}

/** Résolutions de sanctions ou d'embargo en vigueur contre `target`, parrainées par `sponsor`. */
function sponsoredSanctions(state: EngineState, sponsor: NationId, target: NationId): string[] {
  if (!hasDiplo(state)) return [];
  return ds(state)
    .inForce.filter(
      (f) =>
        f.proposer === sponsor &&
        f.target.nationId === target &&
        (f.type === 'economic_sanctions' || f.type === 'arms_embargo'),
    )
    .map((f) => f.id)
    .sort();
}

function agent(state: EngineState, id: string): Agent | undefined {
  return ist(state).agents[id];
}

/** `give` : détenus de `from` appartenant à `to` ; `get` : agents de `from` détenus par `to`. */
function validItems(
  state: EngineState,
  from: NationId,
  to: NationId,
  give: readonly string[],
  get: readonly string[],
): string | null {
  if (new Set([...give, ...get]).size !== give.length + get.length) return 'Agent en double.';
  for (const id of give) {
    const a = agent(state, id);
    if (!a || a.host !== from || a.owner !== to || !isLive(a)) return 'Détenu invalide.';
  }
  for (const id of get) {
    const a = agent(state, id);
    if (!a || a.owner !== from || a.host !== to || !isLive(a)) return 'Agent détenu invalide.';
  }
  return null;
}

export interface SwapTerms {
  give: string[];
  get: string[];
  money: number;
  accordDays: number;
  liftSanctions: boolean;
}

/** Ordre `proposeSwap`. */
export function orderProposeSwap(
  state: EngineState,
  n: NationId,
  to: NationId,
  t: SwapTerms,
): OrderResult {
  return propose(state, n, to, t);
}

function propose(
  state: EngineState,
  from: NationId,
  to: NationId,
  t: SwapTerms,
  counter?: Swap,
): OrderResult {
  if (!state.nations[from]?.alive) return fail('not_allowed', 'Nation vaincue.');
  if (to === from || !regular(state, to)) return fail('invalid_target', 'Nation invalide.');
  const give = [...new Set(t.give)].sort();
  const get = [...new Set(t.get)].sort();
  if (!give.length && !get.length)
    return fail('invalid_target', 'Aucun agent dans la proposition.');
  const bad = validItems(state, from, to, give, get);
  if (bad) return fail('invalid_target', bad);
  const m = Math.round(Number.isFinite(t.money) ? t.money : 0);
  if (m > 0 && state.nations[from]!.money < m)
    return fail('insufficient_funds', 'Fonds insuffisants.');
  const d = Math.max(0, Math.min(365, Math.round(t.accordDays || 0)));
  if (t.liftSanctions && !sponsoredSanctions(state, from, to).length)
    return fail('invalid_target', 'Aucune sanction parrainée contre cette nation.');
  const st = ist(state);
  const sw = (st.sw ??= {});
  // Une seule proposition ouverte par sens : la nouvelle remplace l'ancienne.
  for (const id of sortedKeys(sw)) {
    const x = sw[id]!;
    if (x.st === 'open' && x.from === from && x.to === to) {
      x.st = 'void';
      x.end = state.time;
    }
  }
  const c = dzcfg(state);
  const s: Swap = {
    id: nextId(state, 'w'),
    from,
    to,
    at: state.time,
    exp: state.time + c.swapDays * DAY,
    give,
    get,
    m,
    d,
    st: 'open',
  };
  if (t.liftSanctions) s.ls = 1;
  if (counter) {
    s.c = 1;
    s.re = counter.id;
  }
  sw[s.id] = s;
  if (isPlayer(state, to))
    notify(
      state,
      {
        kind: 'generic',
        time: state.time,
        at: null,
        category: 'detainee',
        title: counter ? 'Contre-proposition' : "Proposition d'échange",
        text: counter
          ? `${natLe(state, from, true)} fait une contre-proposition.`
          : `${natLe(state, from, true)} propose un échange d'agents.`,
        severity: 'info',
        loc: noteLoc(counter ? 'swapCounter' : 'swapProposal', { nation: { nation: from } }),
      },
      [to],
    );
  else
    scheduleMod(state, {
      t: state.time + c.aiAnswerHours * HOUR,
      m: 'intel',
      e: 'sw_ai',
      d: { id: s.id },
    });
  return { ok: true };
}

/** Ordre `answerSwap`. */
export function orderAnswerSwap(
  state: EngineState,
  n: NationId,
  id: string,
  accept: boolean,
): OrderResult {
  const s = ist(state).sw?.[id];
  if (!s || s.to !== n || s.st !== 'open')
    return fail('invalid_target', 'Aucune proposition en attente.');
  if (!accept) {
    refuse(state, s);
    return { ok: true };
  }
  return conclude(state, s);
}

function refuse(state: EngineState, s: Swap): void {
  s.st = 'refused';
  s.end = state.time;
  if (isPlayer(state, s.from))
    notify(
      state,
      {
        kind: 'generic',
        time: state.time,
        at: null,
        category: 'detainee',
        title: 'Échange refusé',
        text: `${natLe(state, s.to, true)} refuse votre proposition d'échange.`,
        severity: 'info',
        loc: noteLoc('swapRefused', { nation: { nation: s.to } }),
      },
      [s.from],
    );
}

/** Exécution d'un accord : agents libérés, argent versé, accord, sanctions levées, relations. */
function conclude(state: EngineState, s: Swap): OrderResult {
  const bad = validItems(state, s.from, s.to, s.give, s.get);
  if (bad) {
    s.st = 'void';
    s.end = state.time;
    return fail('invalid_target', 'Proposition caduque : un des agents n’est plus détenu.');
  }
  const payer = s.m > 0 ? s.from : s.to;
  const payee = s.m > 0 ? s.to : s.from;
  const amount = Math.abs(s.m);
  if (amount > 0 && state.nations[payer]!.money < amount)
    return fail('insufficient_funds', 'Fonds insuffisants.');
  if (amount > 0) {
    state.nations[payer]!.money -= amount;
    state.nations[payee]!.money += amount;
  }
  for (const id of [...s.give, ...s.get]) exchanged(state, agent(state, id)!);
  const st = ist(state);
  if (s.d > 0) {
    const k = pairKey(s.from, s.to);
    const na = (st.na ??= {});
    na[k] = Math.max(na[k] ?? 0, state.time + s.d * DAY);
  }
  if (s.ls) for (const r of sponsoredSanctions(state, s.from, s.to)) endResolution(state, r);
  const c = dzcfg(state).actions.exchange;
  addTie(state, s.from, s.to, c.relations);
  if (hasDiplo(state))
    for (const x of [s.from, s.to]) {
      if (c.reputation) addReputation(state, x, c.reputation);
      if (c.stability) addStability(state, x, c.stability, "Retour d'agents");
    }
  s.st = 'accepted';
  s.end = state.time;
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at: null,
      category: 'detainee',
      title: 'Échange conclu',
      text: `Accord sur les agents détenus entre ${nationName(state, s.from)} et ${nationName(state, s.to)}.`,
      severity: 'info',
      loc: noteLoc('swapAccepted', { a: { nation: s.from }, b: { nation: s.to } }),
    },
    [s.from, s.to].filter((x) => isPlayer(state, x)),
  );
  if (s.give.length + s.get.length > 0)
    signal(state, 'news', {
      category: 'event',
      headline: `Échange d'agents entre ${nationName(state, s.from)} et ${nationName(state, s.to)}`,
      body: `${natLe(state, s.from, true)} et ${natLe(state, s.to)} ont procédé à un échange de prisonniers : ${s.give.length + s.get.length} agent(s) libéré(s).`,
      at: null,
      nations: [s.from, s.to],
      loc: {
        headline: loc('engine.spyNews.swapH', { a: { nation: s.from }, b: { nation: s.to } }),
        body: loc('engine.spyNews.swapB', {
          a: { nation: s.from },
          b: { nation: s.to },
          n: s.give.length + s.get.length,
        }),
      },
    });
  return { ok: true };
}

// ——— Évaluation (IA) ———

/**
 * Gain d'un accord pour `ev` (destinataire de la proposition) : agents qui rentrent, détenus cédés
 * (avec une exigence accrue en relations hostiles ou en guerre), argent, accord, sanctions levées.
 */
export function swapGain(
  state: EngineState,
  ev: NationId,
  s: Pick<Swap, 'from' | 'to' | 'give' | 'get' | 'm' | 'd' | 'ls'>,
): { gain: number; stake: number } {
  const c = dzcfg(state);
  const partner = s.from === ev ? s.to : s.from;
  const mine = s.from === ev ? s.get : s.give;
  const theirs = s.from === ev ? s.give : s.get;
  let receive = 0;
  for (const id of mine) {
    const a = agent(state, id);
    if (a) receive += agentValue(state, a, ev);
  }
  let cede = 0;
  for (const id of theirs) {
    const a = agent(state, id);
    if (a) cede += agentValue(state, a, ev);
  }
  const premium =
    c.hostilePremium * (Math.max(0, -tie(state, ev, partner)) / 100) +
    (atWar(state, ev, partner) ? c.warPremium : 0);
  const money = s.from === ev ? -s.m : s.m;
  const gain =
    receive -
    cede * c.holdFactor * (1 + premium) +
    money / c.usdPerValue +
    s.d * c.accordValuePerDay +
    (s.ls ? c.sanctionsValue : 0);
  return { gain: Math.round(gain * 1000) / 1000, stake: receive + cede };
}

/** Réponse d'une IA : accepte, contre-propose (surenchère) ou refuse. */
export function aiAnswer(state: EngineState, id: string): void {
  const s = ist(state).sw?.[id];
  if (!s || s.st !== 'open' || isPlayer(state, s.to) || !state.nations[s.to]?.alive) return;
  if (validItems(state, s.from, s.to, s.give, s.get)) {
    s.st = 'void';
    s.end = state.time;
    return;
  }
  const c = dzcfg(state);
  const { gain, stake } = swapGain(state, s.to, s);
  const payer = s.m > 0 ? s.from : s.to;
  const funded = s.m === 0 || state.nations[payer]!.money >= Math.abs(s.m);
  if (gain >= 0 && funded && conclude(state, s).ok) return;
  const deficit = -gain;
  if (!s.c && gain < 0 && deficit <= c.counterMax * Math.max(1, stake)) {
    // Contre-proposition : mêmes agents, l'autre partie paie davantage.
    const extra = Math.ceil((deficit * c.usdPerValue * (1 + c.raise)) / 1e6) * 1e6;
    s.st = 'refused';
    s.end = state.time;
    const r = propose(
      state,
      s.to,
      s.from,
      {
        give: [...s.get],
        get: [...s.give],
        money: -(s.m + extra),
        accordDays: s.d,
        liftSanctions: false,
      },
      s,
    );
    if (r.ok) return;
  }
  refuse(state, s);
}

/** Initiatives des IA : échanges équilibrés, rachat de leurs agents, libération contre rançon. */
function aiInitiatives(state: EngineState): void {
  const c = dzcfg(state);
  const st = ist(state);
  const pairs = new Map<string, { n: NationId; x: NationId }>();
  for (const id of sortedKeys(st.agents)) {
    const a = st.agents[id]!;
    if (!isLive(a)) continue;
    for (const [n, x] of [
      [a.host, a.owner],
      [a.owner, a.host],
    ] as const) {
      if (isPlayer(state, n) || !regular(state, n) || !regular(state, x)) continue;
      pairs.set(`${n}>${x}`, { n, x });
    }
  }
  const si = (st.si ??= {});
  const day = Math.floor(state.time / DAY);
  for (const key of [...pairs.keys()].sort()) {
    const { n, x } = pairs.get(key)!;
    if ((si[key] ?? -Infinity) + c.aiSwapEveryDays * DAY > state.time) continue;
    if (hash01('sw-ai', key, day) > 0.5) continue;
    if (tie(state, n, x) < c.aiSwapMinRelations) continue;
    const open = sortedKeys(st.sw ?? {}).some((id) => {
      const s = st.sw![id]!;
      return s.st === 'open' && ((s.from === n && s.to === x) || (s.from === x && s.to === n));
    });
    if (open) continue;
    si[key] = state.time;
    const held = liveList(state, n, x);
    const mine = liveList(state, x, n);
    const v = (ids: string[]) =>
      ids.reduce((t, id) => t + agentValue(state, agent(state, id)!, n), 0);
    const terms: SwapTerms = { give: [], get: [], money: 0, accordDays: 0, liftSanctions: false };
    if (held.length && mine.length) {
      // Échange équilibré : on cède le moins de détenus possible pour récupérer les nôtres.
      terms.get = mine;
      const want = v(mine);
      for (const id of held) {
        if (terms.give.length && v(terms.give) >= want) break;
        terms.give.push(id);
      }
    } else if (mine.length) {
      const price = Math.round((v(mine) * c.usdPerValue * 0.8) / 1e6) * 1e6;
      if (state.nations[n]!.money < price * 3) continue;
      terms.get = mine;
      terms.money = price;
    } else if (held.length && isPlayer(state, x)) {
      terms.give = held.slice(0, 1);
      terms.money = -Math.round((v(terms.give) * c.usdPerValue) / 1e6) * 1e6;
    } else continue;
    propose(state, n, x, terms);
  }
}

/** Détenus vivants de `host` appartenant à `owner`, par valeur décroissante. */
function liveList(state: EngineState, host: NationId, owner: NationId): string[] {
  const st = ist(state);
  return sortedKeys(st.agents)
    .map((k) => st.agents[k]!)
    .filter((a) => a.host === host && a.owner === owner && isLive(a))
    .sort(
      (a, b) => agentValue(state, b, host) - agentValue(state, a, host) || (a.id < b.id ? -1 : 1),
    )
    .map((a) => a.id);
}

/** Tour quotidien : propositions expirées, nettoyage, initiatives des IA. */
export function swapsDaily(state: EngineState): void {
  const st = ist(state);
  const sw = st.sw;
  if (sw) {
    for (const id of sortedKeys(sw)) {
      const s = sw[id]!;
      if (s.st === 'open' && s.exp <= state.time) {
        s.st = 'expired';
        s.end = state.time;
      } else if (s.st === 'open' && validItems(state, s.from, s.to, s.give, s.get)) {
        s.st = 'void';
        s.end = state.time;
      } else if (s.st !== 'open' && (s.end ?? s.at) < state.time - 10 * DAY) delete sw[id];
    }
  }
  const na = st.na;
  if (na) for (const k of sortedKeys(na)) if (na[k]! <= state.time) delete na[k];
  aiInitiatives(state);
}

// ——— Vue ———

function itemView(state: EngineState, id: string, viewer: NationId): SwapItemView | null {
  const a = agent(state, id);
  if (!a) return null;
  const own = a.owner === viewer;
  return {
    id: a.id,
    nationId: a.owner,
    label: own ? a.codename : `D-${a.id.replace(/^a/, '')}`,
    kind: own ? ownerKind(a) : (a.dn?.k ?? ownerKind(a)),
  };
}

export function swapsView(state: EngineState, n: NationId): SwapView[] {
  const sw = ist(state).sw;
  if (!sw) return [];
  const out: SwapView[] = [];
  for (const id of sortedKeys(sw)) {
    const s = sw[id]!;
    if (s.from !== n && s.to !== n) continue;
    if (s.st !== 'open' && (s.end ?? s.at) < state.time - 3 * DAY) continue;
    const v: SwapView = {
      id: s.id,
      from: s.from,
      to: s.to,
      at: s.at,
      expiresAt: s.exp,
      give: s.give.map((x) => itemView(state, x, n)).filter((x): x is SwapItemView => !!x),
      get: s.get.map((x) => itemView(state, x, n)).filter((x): x is SwapItemView => !!x),
      money: s.m,
      accordDays: s.d,
      status: s.st,
    };
    if (s.ls) v.liftSanctions = true;
    if (s.c) v.counter = true;
    out.push(v);
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}

/** Sanctions que `n` parraine contre `x` (allègement négociable). */
export function canLiftSanctions(state: EngineState, n: NationId, x: NationId): boolean {
  return sponsoredSanctions(state, n, x).length > 0;
}
