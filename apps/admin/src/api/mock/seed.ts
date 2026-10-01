/**
 * Données du serveur factice : fichiers réels de data/ (catalogue, règles, recherche, scénarios, carte,
 * ORBAT et photos s'ils existent) et jeux d'exemple pour les écrans d'exploitation (parties, messagerie,
 * utilisateurs, boutique…). Chargé uniquement avec ?mock=1 et dans les tests.
 */
import {
  BalanceSchema,
  CatalogFileSchema,
  DisputedAreaSchema,
  NationDefSchema,
  OrbatSchema,
  ProvinceDefSchema,
  ResearchFileSchema,
  ScenarioFileSchema,
  type AdminGame,
  type Balance,
  type DisputedArea,
  type NationDef,
  type Orbat,
  type ProvinceDef,
  type ResearchNode,
  type ScenarioFile,
  type WeaponSystem,
} from '@redline/shared';
import type {
  AdminChatMessage,
  AdminPack,
  AdminUser,
  Anomaly,
  AuditEntry,
  PhotoEntry,
  Promotion,
  Purchase,
  SuspiciousPair,
} from '../types';

const catalogFiles = import.meta.glob('../../../../../data/catalog/*.json', {
  eager: true,
  import: 'default',
});
const balanceFiles = import.meta.glob('../../../../../data/balance/default.json', {
  eager: true,
  import: 'default',
});
const researchFiles = import.meta.glob('../../../../../data/research/*.json', {
  eager: true,
  import: 'default',
});
const scenarioFiles = import.meta.glob('../../../../../data/scenarios/*.json', {
  eager: true,
  import: 'default',
});
const mapFiles = import.meta.glob(
  [
    '../../../../../data/map/nations.json',
    '../../../../../data/map/provinces.json',
    '../../../../../data/map/disputed.json',
  ],
  { eager: true, import: 'default' },
);
const orbatFiles = import.meta.glob('../../../../../data/orbat/*/*.json', {
  eager: true,
  import: 'default',
});
const photoFiles = import.meta.glob('../../../../../data/art/photos.json', {
  eager: true,
  import: 'default',
});

const pick = (files: Record<string, unknown>, suffix: string) =>
  Object.entries(files).find(([k]) => k.endsWith(suffix))?.[1];

export function loadSystems(): WeaponSystem[] {
  const out: WeaponSystem[] = [];
  for (const raw of Object.values(catalogFiles)) {
    const parsed = CatalogFileSchema.safeParse(raw);
    if (parsed.success) out.push(...parsed.data.systems);
  }
  return out;
}

export function loadBalance(): Balance | null {
  const r = BalanceSchema.safeParse(Object.values(balanceFiles)[0]);
  return r.success ? r.data : null;
}

export function loadResearch(): ResearchNode[] {
  const out: ResearchNode[] = [];
  for (const raw of Object.values(researchFiles)) {
    const r = ResearchFileSchema.safeParse(raw);
    if (r.success) out.push(...r.data.nodes);
  }
  return out;
}

export function loadScenarios(): ScenarioFile[] {
  return Object.values(scenarioFiles)
    .map((raw) => ScenarioFileSchema.safeParse(raw))
    .filter((r) => r.success)
    .map((r) => r.data!);
}

export function loadMap(): {
  nations: NationDef[];
  provinces: ProvinceDef[];
  disputed: DisputedArea[];
} {
  const arr = <T>(v: unknown, schema: { safeParse: (x: unknown) => { success: boolean } }) =>
    (Array.isArray(v) ? v : []).filter((x) => schema.safeParse(x).success) as T[];
  return {
    nations: arr<NationDef>(pick(mapFiles, 'nations.json'), NationDefSchema),
    provinces: (Array.isArray(pick(mapFiles, 'provinces.json'))
      ? (pick(mapFiles, 'provinces.json') as unknown[])
      : []
    )
      .map((x) => ProvinceDefSchema.safeParse(x))
      .filter((r) => r.success)
      .map((r) => r.data!),
    disputed: arr<DisputedArea>(pick(mapFiles, 'disputed.json'), DisputedAreaSchema),
  };
}

/** Photos : manifeste réel s'il existe, sinon quelques illustrations de démonstration. */
export function loadPhotos(): Record<string, PhotoEntry> {
  const raw = Object.values(photoFiles)[0] as Record<string, unknown> | undefined;
  const dict = (raw && typeof raw === 'object' && 'photos' in raw ? raw.photos : raw) as
    Record<string, PhotoEntry> | undefined;
  if (dict && Object.keys(dict).length) return dict;
  const demo = (label: string, hue: number) =>
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},35%,32%)"/><stop offset="1" stop-color="hsl(${hue},30%,12%)"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/><path d="M110 230 L300 205 L360 150 L385 150 L370 205 L520 214 L560 190 L575 192 L562 232 L575 272 L560 274 L520 250 L370 258 L385 312 L360 312 L300 258 L110 236 Z" fill="hsl(${hue},12%,78%)" opacity=".85"/><text x="24" y="376" font-family="monospace" font-size="18" fill="#d6dde6" opacity=".7">${label}</text></svg>`,
    );
  const entry = (label: string, hue: number): PhotoEntry => ({
    file: demo(label, hue),
    credit: 'Illustration de démonstration (mode ?mock=1)',
    license: 'Domaine public',
    sourceUrl: 'https://commons.wikimedia.org/',
  });
  return {
    'eu.rafale': entry('RAFALE', 205),
    'us.f-35': entry('F-35', 215),
    'ru.su-57': entry('SU-57', 195),
    'us.f-16': entry('F-16', 210),
    'cn.j-20': entry('J-20', 200),
  };
}

/** ORBAT : fichiers réels s'ils existent, sinon quelques nations d'exemple (ordres de grandeur). */
export function loadOrbats(systemIds: Set<string>): Record<string, Orbat[]> {
  const sets: Record<string, Orbat[]> = {};
  for (const [path, raw] of Object.entries(orbatFiles)) {
    const set = path.split('/').at(-2)!;
    const r = OrbatSchema.safeParse(raw);
    if (r.success) (sets[set] ??= []).push(r.data);
  }
  if (Object.keys(sets).length) return sets;
  const inv = (pairs: [string, number, string?][]) =>
    pairs
      .filter(([id]) => systemIds.has(id))
      .map(([systemId, count, variant]) => ({ systemId, count, ...(variant ? { variant } : {}) }));
  const make = (
    nationId: string,
    doctrine: Orbat['doctrine'],
    budget: number,
    personnel: number,
    items: [string, number, string?][],
    research: string[],
    description: string,
    doctrineText: string,
    confidence: Orbat['confidence'] = 'medium',
  ): Orbat => ({
    nationId,
    year: 2025,
    doctrine,
    defenseBudgetUsd: budget,
    activePersonnel: personnel,
    inventory: inv(items),
    research,
    licences: [],
    sources: ['SIPRI Military Expenditure Database 2025', 'IISS The Military Balance 2025'],
    confidence,
    description,
    doctrineText,
  });
  const aero = (...g: string[]) => g.map((x) => `research.aero.${x}`);
  const land = (...g: string[]) => g.map((x) => `research.land.${x}`);
  sets['2025'] = [
    make(
      'fra',
      'eu',
      64_000_000_000,
      203_000,
      [
        ['eu.rafale', 225, 'Rafale B/C/M'],
        ['eu.mirage-2000', 80, 'Mirage 2000D/-5F'],
        ['eu.tigre', 67],
        ['eu.nh90', 110],
        ['eu.caesar', 58],
        ['eu.vbci', 630],
        ['eu.samp-t', 10],
        ['eu.m51', 48],
        ['eu.infantry-mech', 120],
      ],
      [
        ...aero('gen2', 'gen3', 'gen4', 'gen4plus', 'helo1', 'helo2', 'helo3'),
        ...land('gen1', 'gen2', 'gen3', 'gen4'),
        'research.nuclear.weapons',
        'research.nuclear.slbm',
      ],
      'Puissance nucléaire européenne dotée d’une industrie de défense complète.',
      'Projection de forces expéditionnaires et dissuasion nucléaire autonome.',
      'high',
    ),
    make(
      'dza',
      'ru',
      21_800_000_000,
      130_000,
      [
        ['ru.su-57', 14, 'Su-57E'],
        ['ru.su-30', 58, 'Su-30MKA'],
        ['ru.mig-29', 30],
        ['ru.s-400', 8],
        ['ru.pantsir-s1', 38],
        ['ru.bmp-2', 680],
        ['ru.mi-24', 40],
        ['ru.infantry-mech', 90],
      ],
      [
        ...aero('gen2', 'gen3', 'gen4', 'gen4plus', 'helo1', 'helo2'),
        ...land('gen1', 'gen2', 'gen3'),
      ],
      'Premier budget de défense d’Afrique, équipement majoritairement d’origine russe.',
      'Défense du territoire et de l’espace aérien, forte composante sol-air.',
    ),
    make(
      'usa',
      'us',
      997_000_000_000,
      1_320_000,
      [
        ['us.f-35', 630],
        ['us.f-22', 183],
        ['us.f-16', 780],
        ['us.b-2-spirit', 19],
        ['us.ah-64-apache', 750],
        ['us.m2-bradley', 2500],
        ['us.patriot', 60],
        ['us.minuteman-iii', 400],
      ],
      [
        ...aero('gen2', 'gen3', 'gen4', 'gen4plus', 'gen5', 'stealth-bomber'),
        ...land('gen1', 'gen2', 'gen3', 'gen4', 'gen5'),
        'research.nuclear.weapons',
        'research.nuclear.icbm',
        'research.nuclear.slbm',
      ],
      'Première puissance militaire mondiale, présence sur tous les continents.',
      'Supériorité aérienne et navale globale, frappe de précision à longue distance.',
      'high',
    ),
    make(
      'rus',
      'ru',
      149_000_000_000,
      1_150_000,
      [
        ['ru.su-57', 32],
        ['ru.su-35', 110],
        ['ru.su-34', 125],
        ['ru.s-400', 56],
        ['ru.ka-52', 120],
        ['ru.bmp-3', 600],
        ['ru.yars', 200],
      ],
      [
        ...aero('gen2', 'gen3', 'gen4', 'gen4plus', 'gen5'),
        ...land('gen1', 'gen2', 'gen3', 'gen4'),
        'research.nuclear.weapons',
        'research.nuclear.icbm',
      ],
      'Puissance nucléaire continentale à l’industrie de défense autonome.',
      'Masse terrestre, déni d’accès sol-air et dissuasion stratégique.',
    ),
    make(
      'chn',
      'cn',
      314_000_000_000,
      2_035_000,
      [
        ['cn.j-20', 210],
        ['cn.j-16', 280],
        ['cn.j-10', 580],
        ['cn.hq-9b', 60],
        ['cn.z-10', 200],
        ['cn.df-41', 60],
      ],
      [
        ...aero('gen2', 'gen3', 'gen4', 'gen4plus', 'gen5'),
        ...land('gen1', 'gen2', 'gen3', 'gen4'),
        'research.nuclear.weapons',
        'research.nuclear.icbm',
      ],
      'Armée la plus nombreuse du monde, modernisation rapide.',
      'Déni d’accès régional et montée en puissance navale.',
      'low',
    ),
  ];
  sets['1985'] = [
    make(
      'fra',
      'eu',
      20_000_000_000,
      464_000,
      [
        ['eu.mirage-2000', 60],
        ['eu.mirage-f1', 180],
        ['eu.gazelle', 170],
        ['eu.vab', 3000],
      ],
      [
        ...aero('gen2', 'gen3', 'gen4'),
        ...land('gen1', 'gen2', 'gen3'),
        'research.nuclear.weapons',
      ],
      'France de la Guerre froide, hors commandement intégré de l’OTAN.',
      'Dissuasion nucléaire indépendante et corps de bataille en Allemagne.',
      'low',
    ),
  ];
  return sets;
}

// ——— Exploitation ———

const H = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const uuid = (n: number) =>
  `${((n * 2654435761) >>> 0).toString(16).padStart(8, '0')}-${(n % 65536).toString(16).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;

export function seedGames(): AdminGame[] {
  const g = (
    n: number,
    name: string,
    mode: 'solo' | 'multi',
    status: AdminGame['game']['status'],
    scenarioId: string,
    players: AdminGame['players'],
    gameTime: number,
    queueSize: number,
    unitCount: number,
  ): AdminGame => ({
    game: {
      id: uuid(9000 + n),
      name,
      mode,
      scenarioId,
      status,
      speeds: [1, 2, 4, 8, 16],
      maxPlayers: mode === 'multi' ? 64 : 1,
      playerCount: players.filter((p) => !p.isAi).length,
      createdAt: iso(n * 7 * H),
      startedAt: iso(n * 7 * H - H),
    },
    players: players.map((p, i) => ({
      ...p,
      userId: p.userName ? uuid(20_000 + n * 100 + i) : null,
      aiForced: false,
      connected: !p.isAi && i % 2 === 0,
      lastActiveAt: p.userName ? iso(i * H) : null,
    })),
    gameTime,
    queueSize,
    unitCount,
  });
  return [
    g(
      1,
      'Opération Levant',
      'multi',
      'running',
      'world-today',
      [
        { nationId: 'fra', userName: 'Amine', isAi: false },
        { nationId: 'dza', userName: 'Sahel_Hawk', isAi: false },
        { nationId: 'esp', userName: null, isAi: true },
        { nationId: 'ita', userName: 'Tenente', isAi: false },
        { nationId: 'egy', userName: null, isAi: true },
        { nationId: 'tur', userName: 'Bosphore', isAi: true },
      ],
      (2 * 24 + 14) * H + 20 * 60_000,
      4120,
      1386,
    ),
    g(
      2,
      'Test équilibrage chasseurs',
      'solo',
      'paused',
      'world-today',
      [
        { nationId: 'usa', userName: 'testeur', isAi: false },
        { nationId: 'chn', userName: null, isAi: true },
      ],
      9 * H + 45 * 60_000,
      880,
      474,
    ),
    g(
      3,
      'Pacifique — saison 1',
      'multi',
      'running',
      'pacific',
      [
        { nationId: 'jpn', userName: 'Kaze', isAi: false },
        { nationId: 'chn', userName: 'RedDragon', isAi: false },
        { nationId: 'kor', userName: null, isAi: true },
        { nationId: 'twn', userName: 'Formosa', isAi: false },
        { nationId: 'phl', userName: null, isAi: true },
      ],
      17 * 24 * H + 3 * H,
      12900,
      2402,
    ),
    g(
      4,
      'Guerre froide 1985',
      'solo',
      'running',
      'cold-war-1985',
      [
        { nationId: 'deu', userName: 'Invité 4821', isAi: false },
        { nationId: 'rus', userName: null, isAi: true },
      ],
      4 * 24 * H,
      2210,
      903,
    ),
    g(
      5,
      'Salon : Europe de l’Est',
      'multi',
      'lobby',
      'eastern-europe',
      [
        { nationId: 'pol', userName: 'Husarz', isAi: false },
        { nationId: 'ukr', userName: 'Kozak', isAi: false },
      ],
      0,
      0,
      0,
    ),
  ];
}

const NAMES = [
  'Amine',
  'Sahel_Hawk',
  'Tenente',
  'Bosphore',
  'Kaze',
  'RedDragon',
  'Formosa',
  'Husarz',
  'Kozak',
  'testeur',
  'Invité 4821',
  'Invité 9913',
  'Mistral',
  'Lynx',
  'Atlas',
  'Nordwind',
  'Condor',
  'Vostok',
  'Orca',
  'Sirocco',
  'Kestrel',
  'Tundra',
];

export function seedUsers(): AdminUser[] {
  return NAMES.map((name, i) => {
    const guest = name.startsWith('Invité');
    const role =
      i === 0 ? 'superadmin' : i === 9 ? 'balance' : i === 12 ? 'moderator' : ('player' as const);
    return {
      id: uuid(100 + i),
      displayName: name,
      email: guest
        ? null
        : `${name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[^a-z0-9]/g, '')}@exemple.fr`,
      role,
      isGuest: guest,
      // Le compte administrateur initial (ADMIN_EMAIL) est en mode illimité d'office.
      unlimited: i === 0,
      premiumBalance: (i * 137) % 2400,
      createdAt: iso((200 - i * 7) * 24 * H),
      lastSeenAt: iso(i * 1.7 * H),
      bannedAt: i === 17 ? iso(3 * 24 * H) : null,
      banReason: i === 17 ? 'Multi-comptes dans une partie classée' : null,
      chatMutedUntil: i === 5 ? new Date(Date.now() + 20 * H).toISOString() : null,
    };
  });
}

export function seedChat(games: AdminGame[], users: AdminUser[]): AdminChatMessage[] {
  const lines = [
    'Quelqu’un pour une alliance au Levant ?',
    'Nos radars détectent des Rafale au-dessus de la Méditerranée.',
    'Cessez-le-feu proposé, merci de répondre avant 18 h.',
    'Ton armée est ridicule, tu vas perdre toutes tes provinces',
    'GG pour la prise d’Alger, bien joué.',
    'Je vends 4 Su-30 au marché, prix à discuter.',
    'Arrête de spammer le canal, on essaie de négocier.',
    'On se retrouve sur le front nord à J4.',
    'Les S-400 ont intercepté trois missiles de croisière.',
    'Achète des crédits sur mon site pas cher !!!',
    'Le conseil de sécurité vote la résolution dans 2 h.',
    'Merci pour le soutien aérien, c’était décisif.',
  ];
  const out: AdminChatMessage[] = [];
  let id = 5000;
  for (let i = 0; i < 48; i++) {
    const g = games[i % 3 === 2 ? 2 : i % 2]!;
    const humans = g.players.filter((p) => !p.isAi);
    const p = humans[i % Math.max(1, humans.length)] ?? g.players[0]!;
    const u = users.find((x) => x.displayName === p.userName) ?? users[i % users.length]!;
    const text = lines[i % lines.length]!;
    const spam = /site pas cher|ridicule/.test(text);
    out.push({
      id: id++,
      gameId: g.game.id,
      channel: i % 5 === 0 ? 'alliance:a1' : i % 7 === 0 ? `private:${p.nationId}|dza` : 'game',
      from: { userId: u.id, nationId: p.nationId, name: u.displayName },
      text,
      sentAt: iso((48 - i) * 11 * 60_000),
      filtered: spam,
      ...(i === 9 ? { hidden: true } : {}),
    });
  }
  return out.reverse();
}

export function seedSecurity(users: AdminUser[], games: AdminGame[]) {
  const u = (i: number) => {
    const x = users[i]!;
    return {
      id: x.id,
      name: x.displayName,
      email: x.email,
      isGuest: x.isGuest,
      banned: !!x.bannedAt,
    };
  };
  const pairs: SuspiciousPair[] = [
    {
      users: [u(16), u(17)],
      score: 7,
      reasons: [
        'IP partagée (3)',
        'même navigateur',
        'horaires d’activité similaires (96 %)',
        'jouent dans la même partie (1)',
      ],
      sharedGames: [games[0]!.game.id],
    },
    {
      users: [u(10), u(11)],
      score: 4,
      reasons: ['IP partagée (1)', 'même navigateur', 'horaires d’activité similaires (92 %)'],
      sharedGames: [],
    },
    {
      users: [u(13), u(14)],
      score: 2,
      reasons: ['IP partagée (1)'],
      sharedGames: [],
    },
  ];
  const anomalies: Anomaly[] = [
    { kind: 'order_rate', userId: users[18]!.id, gameId: games[2]!.game.id, orders: 4210 },
    { kind: 'order_rate', userId: users[6]!.id, gameId: games[2]!.game.id, orders: 1720 },
  ];
  return { pairs, anomalies };
}

export function seedShop(users: AdminUser[]) {
  const packs: Omit<AdminPack, 'view'>[] = [
    ['recrue', 'Recrue', 500, 0, 499, 1],
    ['officier', 'Officier', 1200, 100, 999, 2],
    ['general', 'Général', 2600, 400, 1999, 3],
    ['etat-major', 'État-major', 7000, 1500, 4999, 4],
    ['ancien-pack', 'Pack lancement', 1000, 250, 799, 9],
  ].map(([id, name, amount, bonus, priceCents, sort]) => ({
    id: id as string,
    name: name as string,
    amount: amount as number,
    bonus: bonus as number,
    priceCents: priceCents as number,
    currency: 'eur' as const,
    active: id !== 'ancien-pack',
    sort: sort as number,
    updatedAt: iso(30 * 24 * H),
  }));
  const promotions: Promotion[] = [
    {
      id: 1,
      packId: 'general',
      label: 'Offre de rentrée',
      percentOff: 20,
      startsAt: iso(2 * 24 * H),
      endsAt: new Date(Date.now() + 5 * 24 * H).toISOString(),
      active: true,
      createdAt: iso(3 * 24 * H),
    },
    {
      id: 2,
      packId: null,
      label: 'Soldes d’été',
      percentOff: 15,
      startsAt: iso(80 * 24 * H),
      endsAt: iso(50 * 24 * H),
      active: true,
      createdAt: iso(81 * 24 * H),
    },
  ];
  const statuses: Purchase['status'][] = ['paid', 'paid', 'paid', 'refunded', 'pending', 'failed'];
  const purchases: Purchase[] = Array.from({ length: 16 }, (_, i) => {
    const p = packs[i % 4]!;
    const u = users[(i * 3) % users.length]!;
    const status = statuses[i % statuses.length]!;
    return {
      id: uuid(7000 + i),
      userId: u.id,
      packId: p.id,
      credits: p.amount + p.bonus,
      priceCents: p.priceCents,
      currency: 'eur',
      status,
      stripeSessionId: `cs_test_${(1e6 + i * 7919).toString(36)}`,
      paymentIntent: status === 'pending' ? null : `pi_${(2e6 + i * 104729).toString(36)}`,
      createdAt: iso(i * 13 * H),
      paidAt: status === 'paid' || status === 'refunded' ? iso(i * 13 * H - 60_000) : null,
      refundedAt: status === 'refunded' ? iso(i * 10 * H) : null,
      userName: u.displayName,
      userEmail: u.email,
    };
  });
  return { packs, promotions, purchases };
}

export function seedAudit(users: AdminUser[]): AuditEntry[] {
  const admin = users[0]!;
  const rows: [string, string, number][] = [
    ['system.update', 'system:us.f-16', 6],
    ['data.rules.update', 'rules:default', 20],
    ['game.pause', `game:${uuid(9002)}`, 26],
    ['chat.hide', 'chat:5009', 30],
    ['user.update', `user:${users[17]!.id}`, 72],
    ['shop.promo.create', 'promo:1', 74],
    ['data.nation.update', 'nation:fra', 90],
  ];
  return rows.map(([action, target, h], i) => ({
    id: 100 - i,
    adminId: admin.id,
    adminName: admin.displayName,
    action,
    target,
    before: action === 'data.nation.update' ? { color: '#2f6fd6' } : null,
    after: action === 'data.nation.update' ? { color: '#3a7be0' } : null,
    createdAt: iso(h * H),
  }));
}
