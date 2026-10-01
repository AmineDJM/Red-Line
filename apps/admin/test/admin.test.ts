/**
 * Logique du back-office : introspection des schémas, formats, couleurs, recherche, client d'API,
 * graphe de recherche et routes du serveur factice des phases 2 à 6.
 */
import { describe, expect, it } from 'vitest';
import {
  BalanceSchema,
  WeaponSystemSchema,
  type Balance,
  type ResearchNode,
} from '@redline/shared';
import { ApiError, createApi, query, type HttpMethod, type Transport } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { colorDistance, isVioletLike } from '../src/lib/colors';
import { compact, hours, pct, usd } from '../src/lib/format';
import {
  describe as describeSchema,
  initialValue,
  nodeAt,
  rangeLabel,
  type SNode,
} from '../src/lib/schema';
import { matches, rank } from '../src/lib/search';
import { findCycle, layout, relatives } from '../src/lib/researchGraph';
import { issueMap, validateWith } from '../src/lib/validation';
import { fromLocalInput, toLocalInput } from '../src/lib/dates';
import { href, parseHash } from '../src/lib/router';
import { deepMerge } from '../src/screens/Scenarios';
import { helpKeyOf, ruleLabel } from '../src/screens/Rules';
import { RULE_HELP, RULE_SECTIONS } from '../src/i18n/rules';
import { targetRoute } from '../src/screens/Audit';

describe('introspection des schémas zod', () => {
  const root = describeSchema(BalanceSchema) as SNode & { t: 'object' };
  it('décrit toutes les sections, facultatives comprises', () => {
    expect(Object.keys(root.shape)).toContain('combat');
    expect(root.shape.money!.optional).toBe(true);
    const variance = nodeAt(root, ['combat', 'variance'])!;
    expect(variance).toMatchObject({ t: 'number', min: 0, max: 1 });
    expect(rangeLabel(variance)).toBe('0 à 1');
    const thresholds = nodeAt(root, ['alert', 'thresholds'])!;
    expect(thresholds).toMatchObject({ t: 'array', length: 4, hasDefault: true });
  });
  it('les valeurs initiales d’une section facultative sont valides', () => {
    for (const k of [
      'money',
      'industry',
      'intel',
      'diplomacy',
      'stability',
      'buildings',
      'morale',
    ] as const) {
      const sec = root.shape[k]!;
      const v = initialValue(sec);
      const r = (
        BalanceSchema.shape[k] as unknown as { safeParse: (x: unknown) => { success: boolean } }
      ).safeParse(v);
      expect(r.success, k).toBe(true);
    }
  });
  it('fiche d’arme : blocs facultatifs activables', () => {
    const w = describeSchema(WeaponSystemSchema) as SNode & { t: 'object' };
    const air = initialValue(w.shape.air!);
    expect(WeaponSystemSchema.shape.air.safeParse(air).success).toBe(true);
    expect(w.shape.requiresBuilding).toMatchObject({ t: 'enum', optional: true });
  });
});

describe('formats et couleurs', () => {
  it('dollars abrégés à la française', () => {
    expect(usd(1_200_000_000)).toBe('$1,2 Md');
    expect(usd(450_000_000)).toBe('$450 M');
    expect(usd(85_000)).toBe('$85 k');
    expect(usd(950)).toBe('$950');
    expect(usd(null)).toBe('—');
    expect(compact(130_000)).toBe('130 k');
    expect(pct(0.25)).toBe('25 %');
    expect(hours(54)).toBe('2 j 6 h');
  });
  it('violet réservé au joueur, voisins distincts', () => {
    expect(isVioletLike('#9b6bff')).toBe(true);
    expect(isVioletLike('#3a86ff')).toBe(false);
    expect(isVioletLike('#b5e04a')).toBe(false);
    expect(colorDistance('#123456', '#123456')).toBe(0);
    expect(colorDistance('#000000', '#ffffff')).toBeGreaterThan(600);
  });
  it('datetime-local ↔ ISO', () => {
    const iso = '2026-09-30T18:45:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
  });
});

describe('recherche', () => {
  it('sans accents ni casse, tous les mots', () => {
    expect(matches('Défense aérienne S-400', 'defense s-400')).toBe(true);
    expect(matches('Rafale', 'raf mig')).toBe(false);
    const r = rank(['MiG-29', 'Rafale', 'Su-27 Flanker'], 'ra', (x) => x);
    expect(r[0]).toBe('Rafale');
  });
});

describe('routes', () => {
  it('toutes les sections', () => {
    for (const h of [
      '#/rules/combat',
      '#/research/research.aero.gen5',
      '#/orbat/2025/dza',
      '#/map/provinces/dza-26',
      '#/shop/purchases',
      '#/games/abc',
      '#/chat/abc',
      '#/users/u1',
      '#/audit',
      '#/data',
    ])
      expect(href(parseHash(h))).toBe(h);
    expect(parseHash('#/map')).toEqual({ name: 'map', tab: 'nations' });
    expect(parseHash('#/shop/xyz')).toEqual({ name: 'shop', tab: 'packs' });
  });
  it('lien vers la cible d’une entrée d’audit', () => {
    expect(targetRoute('orbat:2025/fra')).toEqual({ name: 'orbat', set: '2025', nation: 'fra' });
    expect(targetRoute('system:us.f-16')).toEqual({ name: 'system', id: 'us.f-16' });
    expect(targetRoute('pack:x')).toBeNull();
  });
});

describe('règles : libellés et fusion', () => {
  it('monde vivant (ai.world) : intensité, rythme par niveau, rivalités et blocs libellés', () => {
    expect(ruleLabel('ai.world.intensity')).toBe('Intelligence artificielle › Intensité du monde');
    expect(ruleLabel('ai.world.levels.normal.rivalryChancePerDay')).toBe(
      'Intelligence artificielle › Probabilité d’une guerre de rivalité',
    );
    expect(RULE_HELP[helpKeyOf('ai.world.rivalries.3.motive')]?.[0]).toBe('Motif');
    expect(RULE_HELP[helpKeyOf('ai.world.blocs.0.mutualDefense')]?.[0]).toBe('Défense mutuelle');
  });
  it('clé d’aide sans index', () => {
    expect(helpKeyOf('combat.veterancyXp.1')).toBe('combat.veterancyXp');
    expect(helpKeyOf('buildings.levels.mine.2.costUsd')).toBe('buildings.levels.costUsd');
    expect(ruleLabel('combat.variance')).toBe('Combat › Variance des dégâts');
  });
  it('sections entretien, budget et IA : libellés et aides en français pour chaque clé', () => {
    const root = describeSchema(BalanceSchema) as SNode & { t: 'object' };
    const keys: string[] = [];
    const walk = (n: SNode, k: string) => {
      keys.push(k);
      if (n.t === 'object') for (const [c, v] of Object.entries(n.shape)) walk(v, `${k}.${c}`);
    };
    for (const sec of ['money', 'upkeep', 'ai']) walk(root.shape[sec]!, sec);
    expect(keys.length).toBeGreaterThan(150);
    expect(keys.filter((k) => k.includes('.') && !RULE_HELP[k])).toEqual([]);
    expect(RULE_SECTIONS.ai![0]).toBe('Intelligence artificielle');
    expect(ruleLabel('ai.levels.hard.warRatio')).toBe(
      'Intelligence artificielle › Rapport de force pour une guerre',
    );
    expect(ruleLabel('upkeep.localShare.infantry')).toBe(
      'Entretien des forces › Part locale par catégorie',
    );
  });
  it('surcharges de scénario fusionnées en profondeur', () => {
    const m = deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { b: 3 }, l: [9] });
    expect(m).toEqual({ a: { b: 3, c: 2 }, l: [9] });
  });
  it('validation lisible et regroupée par chemin', () => {
    const r = validateWith<Balance>(BalanceSchema, { version: 1 });
    expect(r.ok).toBe(false);
    const m = issueMap(r.issues);
    expect(m.has('time')).toBe(true);
  });
});

describe('graphe de recherche', () => {
  const n = (
    id: string,
    tier: number,
    requires: string[] = [],
    branch: ResearchNode['branch'] = 'aero',
  ): ResearchNode => ({
    id,
    name: id,
    description: '',
    branch,
    tier,
    cost: { money: 1, resources: {} },
    durationH: 1,
    requires,
    effects: {},
  });
  const nodes = [
    n('research.a', 0),
    n('research.b', 1, ['research.a']),
    n('research.c', 2, ['research.b']),
    n('research.d', 1, [], 'land'),
  ];
  it('couloirs par branche et colonnes par rang', () => {
    const g = layout(nodes);
    expect(g.lanes.map((l) => l.branch)).toEqual(['aero', 'land']);
    expect(g.placed.get('research.c')!.x).toBeGreaterThan(g.placed.get('research.b')!.x);
  });
  it('ancêtres, descendants et cycles', () => {
    const r = relatives(nodes, 'research.b');
    expect([...r.ancestors]).toEqual(['research.a']);
    expect([...r.descendants]).toEqual(['research.c']);
    expect(findCycle(nodes, { ...nodes[0]!, requires: ['research.c'] })).toEqual([
      'research.a',
      'research.c',
      'research.b',
      'research.a',
    ]);
    expect(findCycle(nodes, nodes[2]!)).toBeNull();
  });
});

describe('client d’API', () => {
  const recorder = () => {
    const calls: { method: HttpMethod; path: string; body?: unknown }[] = [];
    const t: Transport = {
      async request<T>(method: HttpMethod, path: string, body?: unknown) {
        calls.push({ method, path, body });
        return {} as T;
      },
    };
    return { calls, api: createApi(t) };
  };
  it('chemins et corps exacts', async () => {
    const { calls, api } = recorder();
    await api.orbat.save('2025/fra', {} as never, {
      message: ' x ',
      scope: 'new_games',
      playerMessage: 'ignoré',
    });
    await api.rulesHistory();
    await api.nation.merge('xkx', 'srb', { scope: 'running_games', playerMessage: 'Fusion' });
    await api.listChat({ gameId: 'g', q: 'a b', limit: 5 });
    await api.research.revert('research.aero.gen5', 7);
    await api.setPlayerAi('g-1', 'dza', true, 'hard');
    await api.nation.reset('fra', { message: 'Annulation' });
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: '/admin/api/orbat/2025/fra',
        body: { data: {}, message: 'x', scope: 'new_games' },
      },
      { method: 'GET', path: '/admin/api/rules/history', body: undefined },
      {
        method: 'PUT',
        path: '/admin/api/map/nations/xkx',
        body: { mergeInto: 'srb', scope: 'running_games', playerMessage: 'Fusion' },
      },
      { method: 'GET', path: '/admin/api/chat?gameId=g&q=a%20b&limit=5', body: undefined },
      {
        method: 'POST',
        path: '/admin/api/research/research.aero.gen5/revert',
        body: { revisionId: 7 },
      },
      {
        method: 'POST',
        path: '/admin/api/games/g-1/players/dza/ai',
        body: { ai: true, aiLevel: 'hard' },
      },
      {
        method: 'POST',
        path: '/admin/api/map/nations/fra/reset',
        body: { message: 'Annulation' },
      },
    ]);
    expect(query({ a: '', b: undefined, c: 0 })).toBe('?c=0');
  });
  it('un 401 sur une route admin déconnecte, pas sur /api/me', async () => {
    let out = 0;
    const t: Transport = {
      request: async () => {
        throw new ApiError(401, 'x');
      },
    };
    const api = createApi(t, () => out++);
    await api.me().catch(() => undefined);
    expect(out).toBe(0);
    await api.getRules().catch(() => undefined);
    expect(out).toBe(1);
  });
});

describe('serveur factice : données versionnées', () => {
  const login = async (role?: 'moderator' | 'balance' | 'superadmin') => {
    const api = createApi(createMockTransport({ role, latencyMs: 0 }));
    await api.login({ email: 'a@b.fr', password: 'x' });
    return api;
  };
  it('règles : modification, historique, retour arrière, retour au dépôt', async () => {
    const api = await login();
    const r0 = await api.getRules();
    const repoVariance = r0.rules.combat.variance;
    const w = await api.saveRules(
      { ...r0.rules, combat: { ...r0.rules.combat, variance: 0.5 } },
      { message: 'test', scope: 'running_games' },
    );
    expect(w.runningGames).toBeGreaterThan(0);
    const r1 = await api.getRules();
    expect(r1.rules.combat.variance).toBe(0.5);
    expect(r1.source).toBe('admin');
    const prev = r1.revisions[1]!;
    await api.revertRules(prev.id);
    expect((await api.getRules()).rules.combat.variance).toBe(prev.data!.combat.variance);
    await api.resetRules();
    expect((await api.getRules()).rules.combat.variance).toBe(repoVariance);
    const bad = await api
      .saveRules({ ...r0.rules, combat: { ...r0.rules.combat, variance: 3 } })
      .catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 400 });
  });
  it('recherche, ORBAT, scénario, nation, province, territoire disputé', async () => {
    const api = await login('balance');
    const { nodes } = await api.listResearch();
    const node = nodes[0]!;
    await api.research.save(node.id, { ...node, durationH: 99 });
    expect((await api.research.get(node.id)).data.durationH).toBe(99);
    await expect(api.research.get('research.aero.inexistant')).rejects.toMatchObject({
      status: 404,
    });
    await api.research.save('research.aero.nouveau', {
      ...node,
      id: 'research.aero.nouveau',
      requires: [],
    });
    expect((await api.listResearch()).nodes.some((n) => n.id === 'research.aero.nouveau')).toBe(
      true,
    );

    const sets = (await api.orbatSets()).sets;
    expect(sets['2025']).toContain('dza');
    const o = (await api.orbat.get('2025/dza')).data;
    expect(o.inventory.some((i) => i.systemId === 'ru.su-57')).toBe(true);
    await expect(api.orbat.save('2025/dza', { ...o, nationId: 'fra' })).rejects.toMatchObject({
      status: 400,
      code: 'id_mismatch',
    });

    const { nations } = await api.listNations();
    const fra = nations.find((n) => n.id === 'fra')!;
    await api.nation.save('fra', { ...fra, color: '#2255aa' });
    expect((await api.nation.get('fra')).data.color).toBe('#2255aa');
    const { provinces } = await api.listProvinces();
    const xkx = provinces.filter((p) => p.nationId === 'xkx').length;
    const m = await api.nation.merge('xkx', 'srb');
    expect(m.merged).toBe(xkx);
    expect((await api.listProvinces()).provinces.filter((p) => p.nationId === 'xkx')).toHaveLength(
      0,
    );

    const d = {
      id: 'essai',
      name: 'Essai',
      provinceIds: ['fra-1'],
      claimants: ['fra', 'esp'],
      tension: 40,
      revoltRate: 0.01,
    };
    await api.disputed.save('essai', d);
    expect((await api.listDisputed()).disputed.some((x) => x.id === 'essai')).toBe(true);
    const sc = (await api.scenario.get('world-today')).data;
    await api.scenario.save('world-today', { ...sc, year: 2026 });
    expect((await api.scenario.get('world-today')).data.year).toBe(2026);
  });
  it('rôles : l’équilibrage ne gère ni utilisateurs ni boutique, la modération pas les données', async () => {
    const b = await login('balance');
    await expect(b.listUsers()).rejects.toMatchObject({ status: 403 });
    await expect(b.listPacks()).rejects.toMatchObject({ status: 403 });
    const m = await login('moderator');
    await expect(m.getRules()).rejects.toMatchObject({ status: 403 });
    expect((await m.suspicious()).pairs.length).toBeGreaterThan(0);
  });
});

describe('serveur factice : exploitation', () => {
  it('événement mondial, messagerie, utilisateurs, boutique, audit', async () => {
    const api = createApi(createMockTransport({ latencyMs: 0 }));
    const { user: me } = await api.login({ email: 'a@b.fr', password: 'x' });
    const { games } = await api.listGames();
    const running = games.find((g) => g.game.status === 'running')!;
    await api.worldEvent(running.game.id, { event: 'oil_crisis', params: { days: 3 } });
    const lobby = games.find((g) => g.game.status === 'lobby')!;
    await expect(api.worldEvent(lobby.game.id, { event: 'pandemic' })).rejects.toMatchObject({
      status: 409,
    });

    // IA imposée puis nation rendue (joueur humain) ; nation sans joueur : 404.
    const human = running.players.find((p) => p.userId && !p.isAi)!;
    expect((await api.setPlayerAi(running.game.id, human.nationId, true)).player.aiForced).toBe(
      true,
    );
    const after = (await api.listGames()).games.find((g) => g.game.id === running.game.id)!;
    expect(after.players.find((p) => p.nationId === human.nationId)).toMatchObject({
      isAi: true,
      aiForced: true,
    });
    await api.setPlayerAi(running.game.id, human.nationId, false);
    const aiOnly = running.players.find((p) => !p.userId)!;
    await expect(api.setPlayerAi(running.game.id, aiOnly.nationId, true)).rejects.toMatchObject({
      status: 404,
    });

    const { messages } = await api.listChat({ q: 'pas cher' });
    expect(messages.length).toBeGreaterThan(0);
    await api.hideMessage(messages[0]!.id, true);
    expect((await api.listChat({ q: 'pas cher' })).messages[0]!.hidden).toBe(true);
    const muted = await api.mute(messages[0]!.from.userId, 24);
    expect(muted.mutedUntil).not.toBeNull();

    const { users } = await api.listUsers({ q: 'lynx' });
    await api.patchUser(users[0]!.id, { role: 'moderator' });
    expect((await api.getUser(users[0]!.id)).user.role).toBe('moderator');
    await expect(api.patchUser(me.id, { banned: true })).rejects.toMatchObject({
      status: 400,
      code: 'self_lockout',
    });

    const { purchases } = await api.listPurchases({ status: 'paid' });
    await api.refund(purchases[0]!.id);
    await expect(api.refund(purchases[0]!.id)).rejects.toMatchObject({ status: 409 });
    await api.createPack({
      id: 'test',
      name: 'Test',
      amount: 10,
      bonus: 0,
      priceCents: 100,
      currency: 'eur',
      active: true,
      sort: 5,
    });
    await expect(
      api.createPack({
        id: 'test',
        name: 'Test',
        amount: 10,
        bonus: 0,
        priceCents: 100,
        currency: 'eur',
        active: true,
        sort: 5,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const promo = await api.createPromotion({
      packId: 'test',
      label: 'Promo',
      percentOff: 50,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 86400_000).toISOString(),
      active: true,
    });
    expect(promo.promotion.id).toBeGreaterThan(0);
    expect((await api.listPacks()).packs.find((p) => p.id === 'test')!.view.priceCents).toBe(50);

    const { entries } = await api.audit();
    const actions = entries.map((e) => e.action);
    for (const a of [
      'game.world_event',
      'chat.hide',
      'chat.mute',
      'user.update',
      'shop.refund',
      'shop.pack.create',
      'shop.promo.create',
    ])
      expect(actions).toContain(a);
  });
});
