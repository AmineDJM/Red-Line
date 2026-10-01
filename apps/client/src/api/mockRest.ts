/**
 * Mode démonstration : réponses REST des phases 5 et 6 (lobby, statistiques, chronologie des
 * frontières, rapports de bataille détaillés, boutique, classements, textes légaux, fiches nations).
 * Contenus de démonstration uniquement (jamais utilisés avec un vrai serveur).
 */
import {
  HOUR,
  destination,
  distanceKm,
  type Balance,
  type BattleReport,
  type BattleReportSummary,
  type CosmeticItem,
  type GameMeta,
  type GameStatsView,
  type LegalDoc,
  type LobbyGame,
  type MyGame,
  type NationDef,
  type NationId,
  type NationInfo,
  type ProvinceDef,
  type RankingEntry,
  type SeasonView,
  type ShopPack,
  type TimelapseView,
  type WalletEntry,
  type WeaponSystem,
} from '@redline/shared';

import { flagIso2 } from '@redline/ui';

const orbatFiles = import.meta.glob('../../../../data/orbat/2025/*.json', { import: 'default' });

/** PRNG déterministe (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ——— Fiches nations ———

/** Budgets de défense (SIPRI 2024, dollars courants, arrondis) pour la démonstration. */
const BUDGETS: Record<string, [number, number | null, string]> = {
  usa: [997e9, 1_330_000, 'us'],
  chn: [314e9, 2_035_000, 'cn'],
  rus: [149e9, 1_320_000, 'ru'],
  deu: [88.5e9, 181_000, 'eu'],
  ind: [86.1e9, 1_475_000, 'ru'],
  gbr: [81.8e9, 141_000, 'eu'],
  sau: [80.3e9, 257_000, 'us'],
  ukr: [64.7e9, 900_000, 'ru'],
  fra: [64.7e9, 203_000, 'eu'],
  jpn: [55.3e9, 247_000, 'us'],
  kor: [47.6e9, 500_000, 'us'],
  isr: [46.5e9, 169_500, 'us'],
  pol: [38e9, 164_000, 'eu'],
  ita: [38e9, 161_000, 'eu'],
  aus: [33.8e9, 58_000, 'us'],
  can: [29.3e9, 63_000, 'us'],
  tur: [25e9, 355_000, 'other'],
  esp: [24.6e9, 122_000, 'eu'],
  nld: [22.9e9, 33_000, 'eu'],
  dza: [21.8e9, 130_000, 'ru'],
  bra: [20.9e9, 366_500, 'other'],
  mex: [16.7e9, 216_000, 'us'],
  twn: [16.5e9, 169_000, 'us'],
  irn: [7.9e9, 610_000, 'ru'],
  pak: [10.2e9, 660_000, 'cn'],
  egy: [2.8e9, 438_500, 'us'],
  mar: [5.5e9, 195_800, 'us'],
  tun: [1.2e9, 35_800, 'eu'],
  lby: [1.9e9, 32_000, 'ru'],
  nga: [1.4e9, 143_000, 'other'],
  zaf: [2.8e9, 73_000, 'eu'],
  are: [23e9, 63_000, 'us'],
  grc: [8.1e9, 132_000, 'eu'],
  swe: [12e9, 14_600, 'eu'],
  nor: [9.4e9, 25_400, 'eu'],
  fin: [6.9e9, 24_000, 'eu'],
  vnm: [7.4e9, 450_000, 'ru'],
  idn: [9.2e9, 404_500, 'other'],
  prk: [4e9, 1_280_000, 'ru'],
  mli: [0.9e9, 21_000, 'ru'],
  ner: [0.3e9, 33_000, 'other'],
};

const DESCRIPTIONS: Record<string, [string, string]> = {
  dza: [
    "Plus grand pays d'Afrique, puissance énergétique du Maghreb. Budget de défense le plus élevé du continent, armées modernisées depuis vingt ans, façade méditerranéenne et profondeur saharienne.",
    'Doctrine défensive d’origine soviétique : défense aérienne dense (S-300, Pantsir), aviation Su-30MKA, forces terrestres lourdes. Achats russes majoritaires, diversification chinoise et européenne.',
  ],
  fra: [
    'Puissance nucléaire membre permanent du Conseil de sécurité. Industrie d’armement complète, présence outre-mer et projection de forces en Afrique et au Moyen-Orient.',
    'Armée expéditionnaire complète : dissuasion océanique et aéroportée, Rafale, porte-avions nucléaire, forces spéciales. Autonomie stratégique et industrie nationale.',
  ],
  usa: [
    'Première puissance militaire mondiale, budget de défense supérieur aux neuf suivants réunis. Réseau mondial de bases et d’alliances.',
    'Supériorité aérienne et navale, onze groupes aéronavals, furtivité de cinquième génération, triade nucléaire, capacités spatiales et cyber sans égales.',
  ],
  rus: [
    'Plus vaste pays du monde, puissance nucléaire. Industrie d’armement autonome, forces terrestres et aériennes nombreuses, engagement prolongé en Ukraine.',
    'Masse et feu : artillerie, missiles de croisière et balistiques, défense aérienne en couches (S-400), guerre électronique, dissuasion nucléaire.',
  ],
  chn: [
    'Deuxième budget de défense mondial, marine la plus nombreuse au monde, modernisation rapide et industrie nationale.',
    'Déni d’accès : missiles antinavires et balistiques, J-20 furtifs, flotte en croissance rapide, forces des fusées stratégiques.',
  ],
  mar: [
    'Royaume d’Afrique du Nord, façade atlantique et méditerranéenne, allié majeur non-OTAN des États-Unis.',
    'Modernisation d’origine occidentale : F-16, chars Abrams, drones turcs et israéliens, défense aérienne en renforcement.',
  ],
};

function genericDescription(n: NationDef, provinces: number): [string, string] {
  return [
    `${n.name} : ${provinces} province${provinces > 1 ? 's' : ''} sur la carte. Nation contrôlée par une IA si aucun joueur ne la choisit.`,
    'Forces armées estimées à partir des sources ouvertes ; arsenal et budget réels chargés au lancement.',
  ];
}

export async function demoNationsInfo(
  nations: NationDef[],
  provinces: ProvinceDef[],
  catalog: WeaponSystem[],
): Promise<NationInfo[]> {
  const counts = new Map<string, number>();
  for (const p of provinces) counts.set(p.nationId, (counts.get(p.nationId) ?? 0) + 1);
  const orbats = new Map<string, Record<string, unknown>>();
  for (const [path, load] of Object.entries(orbatFiles)) {
    const id = path
      .split('/')
      .pop()!
      .replace(/\.json$/, '');
    try {
      orbats.set(id, (await load()) as Record<string, unknown>);
    } catch {
      /* fichier illisible */
    }
  }
  const KEY = ['fighter', 'tank', 'air_defense', 'surface_ship', 'submarine', 'artillery'];
  const byDoctrine = (d: string, iso2: string | null) => {
    const national = catalog.filter(
      (s) => iso2 && s.origin.toLowerCase() === iso2 && KEY.includes(s.category),
    );
    const pool =
      national.length >= 3
        ? national
        : catalog.filter((s) => s.doctrine === d && KEY.includes(s.category));
    // Un système par catégorie, le plus récent d'abord.
    const seen = new Set<string>();
    return [...pool]
      .sort((a, b) => b.generation - a.generation)
      .filter((s) => (seen.has(s.category) ? false : (seen.add(s.category), true)));
  };
  return nations
    .filter((n) => (counts.get(n.id) ?? 0) > 0)
    .map((n) => {
      const o = orbats.get(n.id);
      const b = BUDGETS[n.id];
      const doctrine = (o?.doctrine as string) ?? b?.[2] ?? 'other';
      const [description, doctrineText] =
        DESCRIPTIONS[n.id] ?? genericDescription(n, counts.get(n.id) ?? 0);
      const inv = (o?.inventory as { systemId: string; count: number }[] | undefined) ?? null;
      const rnd = prng(hash(n.id));
      const highlights = inv
        ? [...inv].sort((a, c) => c.count - a.count).slice(0, 4)
        : byDoctrine(doctrine, flagIso2(n.id))
            .slice(0, 4)
            .map((s) => ({ systemId: s.id, count: 4 + Math.floor(rnd() * 60) }));
      return {
        id: n.id,
        name: n.name,
        description: (o?.description as string) ?? description,
        doctrine,
        doctrineText: (o?.doctrineText as string) ?? doctrineText,
        defenseBudgetUsd:
          (o?.defenseBudgetUsd as number) ?? b?.[0] ?? Math.round((0.2 + rnd() * 2) * 1e9),
        activePersonnel: (o?.activePersonnel as number) ?? b?.[1] ?? null,
        provinceCount: counts.get(n.id) ?? 0,
        highlights,
      };
    });
}

// ——— Lobby et parties ———

const PLAYERS = [
  'Kestrel',
  'Atlas_7',
  'N0madSahel',
  'VektorPrime',
  'Mistral',
  'Orca',
  'Tariq',
  'Solveig',
  'Ghostline',
  'Yuki',
  'Commandant_R',
  'Bellatrix',
];

function meta(id: string, name: string, patch: Partial<GameMeta> = {}): GameMeta {
  return {
    id,
    name,
    mode: 'multi',
    scenarioId: 'world-today',
    status: 'lobby',
    speeds: [1, 2, 4],
    maxPlayers: 64,
    playerCount: 0,
    shopPolicy: { mode: 'open' },
    victory: { provinceShare: 0.6, allEnemyCapitals: false },
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    startedAt: null,
    ...patch,
  };
}

export function demoLobby(nations: NationDef[]): LobbyGame[] {
  const pick = (seed: number, n: number) => {
    const rnd = prng(seed);
    const pool = nations.filter((x) => x.kind === 'state');
    const out: NationId[] = [];
    while (out.length < n && pool.length)
      out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]!.id);
    return out;
  };
  const make = (
    id: string,
    name: string,
    seed: number,
    taken: number,
    patch: Partial<GameMeta>,
    speed: number,
  ) => {
    const t = pick(seed, taken);
    return {
      game: meta(id, name, { playerCount: taken, ...patch }),
      scenarioName: 'Le monde aujourd’hui',
      takenNations: t,
      takenBy: Object.fromEntries(t.map((n, i) => [n, PLAYERS[(i + seed) % PLAYERS.length]!])),
      creator: PLAYERS[seed % PLAYERS.length]!,
      speed,
    } satisfies LobbyGame;
  };
  return [
    make('lobby-1', 'Guerre mondiale · 64 joueurs', 3, 41, { shopPolicy: { mode: 'open' } }, 1),
    make(
      'lobby-2',
      'Méditerranée en feu',
      5,
      9,
      { maxPlayers: 24, shopPolicy: { mode: 'limited', capPerPlayer: 500 } },
      2,
    ),
    make(
      'lobby-3',
      'Compétitif · saison 3',
      8,
      57,
      { shopPolicy: { mode: 'disabled' }, victory: { provinceShare: 0.5, allEnemyCapitals: true } },
      1,
    ),
    make('lobby-4', 'Blitz ×4 débutants', 11, 4, { maxPlayers: 16, speeds: [4] }, 4),
  ];
}

export function demoMyGames(me: NationId): MyGame[] {
  const now = Date.now();
  return [
    {
      game: {
        ...meta('demo', 'Démonstration', {
          mode: 'solo',
          status: 'running',
          speeds: [1, 2, 4, 8, 16],
          playerCount: 1,
        }),
        startedAt: new Date(now - 2 * 86400_000).toISOString(),
      },
      nationId: me,
      createdAt: new Date(now - 2 * 86400_000).toISOString(),
    },
    {
      game: meta('lobby-2', 'Méditerranée en feu', {
        status: 'running',
        playerCount: 18,
        maxPlayers: 24,
      }),
      nationId: 'ita',
      createdAt: new Date(now - 9 * 86400_000).toISOString(),
    },
    {
      game: meta('old-1', 'Pacifique 2025', { status: 'ended', playerCount: 32 }),
      nationId: 'jpn',
      createdAt: new Date(now - 40 * 86400_000).toISOString(),
    },
  ];
}

// ——— Fin de partie ———

export function demoTimelapse(provinces: ProvinceDef[], me: NationId, days = 36): TimelapseView {
  const owners: Record<string, NationId> = Object.fromEntries(
    provinces.map((p) => [p.id, p.nationId]),
  );
  const byId = new Map(provinces.map((p) => [p.id, p]));
  const rnd = prng(hash(me) ^ 0x5eed);
  const frames: TimelapseView['frames'] = [{ day: 0, owners: { ...owners } }];
  // Deux IA voisines grignotent aussi quelques provinces.
  const mine = provinces.find((p) => p.nationId === me);
  const rivals = mine
    ? [
        ...new Set(
          provinces
            .filter((p) => p.nationId !== me)
            .sort(
              (a, b) =>
                distanceKm(a.cityPoint, mine.cityPoint) - distanceKm(b.cityPoint, mine.cityPoint),
            )
            .map((p) => p.nationId),
        ),
      ].slice(0, 4)
    : [];
  const actors = [me, me, me, rivals[2], rivals[3]].filter(Boolean) as NationId[];
  for (let d = 1; d <= days; d++) {
    for (const actor of actors) {
      const frontier = Object.entries(owners)
        .filter(([, o]) => o === actor)
        .flatMap(([pid]) => byId.get(pid)?.neighbors ?? [])
        .filter(
          (n) => owners[n] && owners[n] !== actor && (actor !== me || rivals.includes(owners[n]!)),
        );
      const steps = actor === me ? 1 + Math.floor(rnd() * 3) : rnd() < 0.4 ? 1 : 0;
      for (let k = 0; k < steps && frontier.length; k++) {
        const target = frontier.splice(Math.floor(rnd() * frontier.length), 1)[0]!;
        owners[target] = actor;
      }
    }
    frames.push({ day: d, owners: { ...owners } });
  }
  return { frames };
}

export function demoStats(
  me: NationId,
  timelapse: TimelapseView,
  catalog: WeaponSystem[],
): GameStatsView {
  const first = timelapse.frames[0]!.owners;
  const last = timelapse.frames[timelapse.frames.length - 1]!.owners;
  const count = (o: Record<string, NationId>, n: NationId) =>
    Object.values(o).filter((x) => x === n).length;
  const involved = [
    ...new Set([
      me,
      ...Object.keys(first)
        .filter((p) => first[p] !== last[p])
        .flatMap((p) => [first[p]!, last[p]!]),
    ]),
  ];
  const rnd = prng(42);
  const top = catalog.filter((s) =>
    ['fighter', 'tank', 'artillery', 'strike_missile'].includes(s.category),
  );
  return {
    winner: me,
    durationDays: timelapse.frames.length - 1,
    nations: involved.slice(0, 8).map((n, i) => ({
      nationId: n,
      player: n === me ? 'Vous' : i % 3 === 0 ? PLAYERS[i % PLAYERS.length]! : null,
      provincesStart: count(first, n),
      provincesEnd: count(last, n),
      conquered: Object.keys(last).filter((p) => last[p] === n && first[p] !== n).length,
      kills: Math.round((n === me ? 480 : 120) * (0.5 + rnd())),
      losses: Math.round((n === me ? 160 : 260) * (0.5 + rnd())),
      spentUsd: Math.round((n === me ? 38e9 : 12e9) * (0.6 + rnd())),
      bestUnits: top
        .slice(i, i + 3)
        .map((s) => ({ systemId: s.id, kills: Math.round(20 + rnd() * 90) })),
    })),
  };
}

// ——— Rapport de bataille détaillé ———

export function demoBattleReport(
  s: BattleReportSummary,
  catalog: Map<string, WeaponSystem>,
): BattleReport {
  const rnd = prng(hash(s.id));
  const t0 = s.startedAt;
  const t1 = s.endedAt ?? s.startedAt + 3 * HOUR;
  const frames: BattleReport['replay']['frames'] = [];
  const shots: BattleReport['replay']['shots'] = [];
  const mk = (side: 'a' | 'd') => {
    const b = side === 'a' ? s.attacker : s.defender;
    const bearing0 = side === 'a' ? 250 + rnd() * 40 : 60 + rnd() * 40;
    return b.engaged.flatMap((e, gi) =>
      Array.from({ length: Math.min(4, Math.max(1, Math.round(e.count / 3))) }, (_, k) => ({
        id: `${side}${gi}-${k}`,
        owner: b.nations[0]!,
        systemId: e.systemId,
        start: destination(s.at, bearing0 + (k - 1.5) * 14 + gi * 9, 22 + rnd() * 14),
        dies:
          rnd() <
          (b.losses.find((l) => l.systemId === e.systemId)?.count ?? 0) / Math.max(1, e.count),
      })),
    );
  };
  const units = [...mk('a'), ...mk('d')];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const t = t0 + (t1 - t0) * f;
    frames.push({
      t,
      units: units
        .filter((u) => !(u.dies && f > 0.35 + (hash(u.id) % 50) / 100))
        .map((u) => {
          const adv = u.id.startsWith('a') ? Math.min(0.75, f * 1.1) : Math.min(0.25, f * 0.4);
          const lng = u.start[0] + (s.at[0] - u.start[0]) * adv;
          const lat = u.start[1] + (s.at[1] - u.start[1]) * adv;
          return {
            id: u.id,
            owner: u.owner,
            systemId: u.systemId,
            at: [lng, lat] as [number, number],
            hp: Math.max(0.1, 1 - f * (u.dies ? 0.9 : 0.35 * rnd())),
          };
        }),
    });
    if (i > 1 && i < N) {
      const fr = frames[frames.length - 1]!.units;
      const as = fr.filter((u) => u.id.startsWith('a'));
      const ds = fr.filter((u) => u.id.startsWith('d'));
      for (let k = 0; k < 2; k++) {
        const a = as[Math.floor(rnd() * as.length)];
        const d = ds[Math.floor(rnd() * ds.length)];
        if (!a || !d) continue;
        const fromA = rnd() < 0.55;
        const shooter = fromA ? a : d;
        const target = fromA ? d : a;
        shots.push({
          t,
          from: shooter.at,
          to: target.at,
          cls: catalog.get(target.systemId)?.targetClass ?? 'armor',
          hit: rnd() < 0.6,
        });
      }
    }
  }
  const name = (id: string) => catalog.get(id)?.name ?? id;
  const al = s.attacker.losses[0];
  const dl = s.defender.losses[0];
  return {
    ...s,
    countermeasures: [
      { kind: 'jamming', text: 'Brouillage radar : précision des tirs adverses réduite', count: 3 },
      {
        kind: 'interception',
        text: 'Missiles interceptés par la défense aérienne',
        count: 5 + Math.floor(rnd() * 6),
      },
      { kind: 'decoy', text: 'Leurres engagés par l’adversaire', count: 2 },
    ],
    timeline: [
      { t: t0, text: 'Contact établi par la reconnaissance avancée.' },
      { t: t0 + (t1 - t0) * 0.15, text: 'Préparation d’artillerie sur les positions adverses.' },
      {
        t: t0 + (t1 - t0) * 0.32,
        text: `Premières pertes : ${dl ? name(dl.systemId) : 'unité adverse'} détruit.`,
      },
      { t: t0 + (t1 - t0) * 0.5, text: 'Brouillage actif : liaisons adverses dégradées.' },
      {
        t: t0 + (t1 - t0) * 0.7,
        text: `Contre-attaque : ${al ? name(al.systemId) : 'unité alliée'} touché.`,
      },
      {
        t: t1,
        text:
          s.outcome === 'ongoing'
            ? 'Combats en cours.'
            : 'Fin des combats, position tenue par le vainqueur.',
      },
    ],
    replay: { t0, t1, frames, shots },
  };
}

// ——— Boutique, classements, légal ———

export const DEMO_PACKS: ShopPack[] = [
  {
    id: 'pack-s',
    name: 'Paquetage',
    amount: 500,
    bonus: 0,
    priceCents: 499,
    currency: 'eur',
    promo: null,
  },
  {
    id: 'pack-m',
    name: 'Dotation',
    amount: 1200,
    bonus: 100,
    priceCents: 999,
    currency: 'eur',
    promo: null,
  },
  {
    id: 'pack-l',
    name: 'Budget spécial',
    amount: 2600,
    bonus: 400,
    priceCents: 1999,
    currency: 'eur',
    promo: {
      label: 'Offre de saison',
      percentOff: 20,
      until: new Date(Date.now() + 5 * 86400_000).toISOString(),
    },
  },
  {
    id: 'pack-xl',
    name: 'Loi de programmation',
    amount: 7000,
    bonus: 1500,
    priceCents: 4999,
    currency: 'eur',
    promo: null,
  },
];

export const DEMO_COSMETICS: CosmeticItem[] = [
  {
    id: 'theme-amber',
    kind: 'terminal_theme',
    name: 'Terminal ambre (1983)',
    price: 300,
    preview: 'amber',
  },
  {
    id: 'theme-green',
    kind: 'terminal_theme',
    name: 'Phosphore vert',
    price: 300,
    preview: 'green',
  },
  { id: 'map-night', kind: 'map_theme', name: 'Carte nocturne', price: 450, preview: 'night' },
  { id: 'skin-desert', kind: 'unit_skin', name: 'Pions « Désert »', price: 250, preview: 'desert' },
  {
    id: 'skin-arctic',
    kind: 'unit_skin',
    name: 'Pions « Arctique »',
    price: 250,
    preview: 'arctic',
  },
  {
    id: 'flag-frame',
    kind: 'flag',
    name: 'Cadre de drapeau « Vétéran »',
    price: 150,
    preview: 'veteran',
  },
];

export function demoWallet(balance: number): { balance: number; history: WalletEntry[] } {
  const d = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  return {
    balance,
    history: [
      {
        id: 4,
        delta: -120,
        reason: 'accelerate',
        ref: 'research:research.aero.gen5',
        createdAt: d(5),
      },
      { id: 3, delta: -300, reason: 'cosmetic', ref: 'theme-amber', createdAt: d(30) },
      { id: 2, delta: 1300, reason: 'purchase', ref: 'pack-m', createdAt: d(52) },
      { id: 1, delta: 200, reason: 'admin', ref: 'bienvenue', createdAt: d(200) },
    ],
  };
}

export const DEMO_SEASONS: SeasonView[] = [
  {
    id: 's3',
    name: 'Saison 3 · Ligne rouge',
    startsAt: '2026-09-01T00:00:00Z',
    endsAt: '2026-11-30T23:59:59Z',
    rewards: [
      { rank: 1, cosmeticId: 'flag-frame' },
      { rank: 10, cosmeticId: 'theme-green' },
    ],
  },
  {
    id: 's2',
    name: 'Saison 2 · Dissuasion',
    startsAt: '2026-06-01T00:00:00Z',
    endsAt: '2026-08-31T23:59:59Z',
    rewards: [],
  },
];

export function demoRankings(): RankingEntry[] {
  const rnd = prng(3);
  let pts = 4820;
  return PLAYERS.concat([
    'Hoplite',
    'Invité-4412',
    'Rook',
    'Sentinelle',
    'Kairos',
    'Ibis',
    'Moraine',
    'Pax',
  ]).map((name, i) => {
    pts -= Math.round(90 + rnd() * 260);
    const games = 12 + Math.round(rnd() * 40);
    return {
      rank: i + 1,
      userId: `u${i}`,
      name,
      points: pts,
      wins: Math.round(games * (0.15 + rnd() * 0.35)),
      games,
    };
  });
}

const LEGAL_BODY: Record<LegalDoc['id'], [string, string]> = {
  cgu: [
    'Conditions générales d’utilisation',
    `# Conditions générales d’utilisation

**Version de démonstration — texte à faire valider par un professionnel.**

## 1. Objet
Red Line est un jeu de stratégie en ligne. Les présentes conditions encadrent l’accès au jeu et son utilisation.

## 2. Compte
Un compte invité est conservé sur l’appareil. Un compte inscrit permet de retrouver ses parties sur plusieurs appareils.

## 3. Comportement
Le respect des autres joueurs est obligatoire dans la messagerie. Les messages abusifs peuvent être masqués par la modération.

## 4. Contenu
Toutes les cibles stratégiques du jeu sont génériques. Aucun site réel n’est représenté.`,
  ],
  cgv: [
    'Conditions générales de vente',
    `# Conditions générales de vente

**Version de démonstration.**

## 1. Monnaie premium
La monnaie premium s’achète par paquets via Stripe Checkout. Elle n’a pas de valeur monétaire hors du jeu.

## 2. Aucune loot box
Tout achat indique précisément ce qui est obtenu. Aucun achat aléatoire n’est proposé.

## 3. Serveurs compétitifs
Certaines parties limitent ou désactivent les achats en jeu.`,
  ],
  privacy: [
    'Politique de confidentialité',
    `# Politique de confidentialité

**Version de démonstration.**

Données traitées : identifiant de compte, adresse e-mail (comptes inscrits), historique de parties, achats. Aucune donnée n’est revendue. Droit d’accès, de rectification et d’effacement : depuis les réglages du compte.`,
  ],
  withdrawal: [
    'Droit de rétractation',
    `# Droit de rétractation

**Version de démonstration.**

Le contenu numérique fourni immédiatement après l’achat entraîne, avec votre accord exprès, la renonciation au droit de rétractation de quatorze jours.`,
  ],
};

export function demoLegal(id: LegalDoc['id']): LegalDoc {
  const [title, markdown] = LEGAL_BODY[id];
  return { id, version: 3, title, markdown, updatedAt: '2026-09-01T00:00:00Z' };
}

/**
 * Démo : coûts (dollars, niveau 1) et durées (heures) de construction tant que data/balance n'a pas
 * de section `buildings`. Le client multiplie par le niveau visé.
 */
const DEMO_BUILD: Record<string, [usd: number, hours: number]> = {
  refinery: [18e6, 36],
  power_plant: [14e6, 30],
  port: [12e6, 30],
  air_base: [26e6, 42],
  military_base: [15e6, 30],
  arms_factory: [32e6, 48],
  research_center: [22e6, 40],
  oil_field: [9e6, 24],
  mine: [6e6, 20],
  farm: [2.5e6, 12],
  electronics_plant: [24e6, 40],
  local_industry: [4.5e6, 16],
  recruiting_office: [2e6, 10],
  naval_base: [38e6, 48],
  bunker: [3e6, 12],
  air_defense_site: [16e6, 28],
  coastal_battery: [11e6, 24],
  radar_station: [8.5e6, 20],
  missile_silo: [90e6, 72],
  hospital: [5.5e6, 18],
  secret_lab: [48e6, 60],
  forward_base: [4e6, 8],
};

export function withDemoBuildings(balance: Balance | null): Balance | null {
  if (!balance) return balance;
  const b: NonNullable<Balance['buildings']> = balance.buildings ?? {
    effects: {},
    repairHours: 48,
    buildHours: {},
    buildCostUsd: {},
    levels: {},
    maxLevel: 5,
    levelCostGrowth: 1.6,
    levelTimeGrowth: 0.25,
    distribute: true,
  };
  const buildCostUsd = { ...b.buildCostUsd };
  const buildHours = { ...b.buildHours };
  for (const [type, [usd, hours]] of Object.entries(DEMO_BUILD)) {
    buildCostUsd[type] ??= usd;
    buildHours[type] ??= hours;
  }
  return { ...balance, buildings: { ...b, buildCostUsd, buildHours } };
}
