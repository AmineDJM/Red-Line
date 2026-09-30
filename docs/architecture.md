# Red Line — Proposition d'architecture (à valider)

> Statut : **proposition**, en attente de l'accord d'Amine avant d'écrire la moindre ligne de code.
> Couvre : architecture, structure des dossiers, modèle de données, critiques du cahier des charges, plan de la phase 1.

---

## 1. Vue d'ensemble

```
                 ┌────────────────────────┐        ┌────────────────────────┐
  Navigateur ──► │ redline-client (static)│        │ redline-admin (static) │ ◄── Admins
  mobile / PC    │ React + Vite + MapLibre│        │ React + Vite           │
                 └───────────┬────────────┘        └───────────┬────────────┘
                   HTTPS (REST) + WebSocket                    │ HTTPS (REST /admin/api)
                             ▼                                 ▼
                 ┌───────────────────────────────────────────────────────────┐
                 │ redline-server (Render Web Service, Node 22, Fastify)     │
                 │  ├─ API HTTP (auth, lobby, catalogue, admin, boutique)    │
                 │  ├─ Passerelle WebSocket (ordres entrants, diffs sortants)│
                 │  ├─ GameHost : N parties en mémoire, 1 ordonnanceur       │
                 │  │    └─ packages/engine (simulation pure, déterministe)  │
                 │  ├─ Persistance (instantanés + journal d'ordres)          │
                 │  └─ Tuiles PMTiles (requêtes HTTP Range)                  │
                 └──────────────┬──────────────────────────────┬─────────────┘
                                ▼                              ▼
                 ┌──────────────────────────┐      ┌────────────────────────┐
                 │ PostgreSQL (Render)      │      │ Stripe (Checkout +     │
                 │ comptes, catalogue, carte│      │ webhooks) — phase 6    │
                 │ parties, instantanés     │      └────────────────────────┘
                 └──────────────────────────┘
```

Principe directeur : **le moteur de simulation est une bibliothèque pure** (`packages/engine`) — aucune E/S, aucune horloge système, aucun `Math.random`. Il reçoit un état, des ordres horodatés en temps de jeu, et produit un nouvel état + des événements. Le serveur n'est qu'un hôte qui l'alimente, le persiste et diffuse ce que chaque joueur a le droit de voir. Conséquences :

- les tests du moteur tournent en millisecondes, sans base ni réseau ;
- le replay d'une bataille = état initial + graine + journal d'ordres ;
- le mode bac à sable et le replay animé peuvent réutiliser le même moteur côté client, sans rien dupliquer.

---

## 2. Stack retenue

| Domaine | Choix | Pourquoi |
|---|---|---|
| Monorepo | **pnpm workspaces** (+ scripts `pnpm -r`) | Simple, rapide, pas besoin de Turborepo au départ |
| Langage | TypeScript strict partout, Node 22 LTS | Types partagés client/serveur/admin |
| Validation | **zod** (schémas dans `packages/shared`) | Même schéma pour valider les ordres, les fiches d'armes JSON et les formulaires admin |
| Serveur | **Fastify** + `@fastify/websocket` (ws) | Rapide, typé, écosystème mûr |
| ORM / migrations | **Drizzle ORM** + drizzle-kit | SQL explicite, léger, migrations versionnées |
| Sérialisation WS | **MessagePack** (`@msgpack/msgpack`) + diffs | Messages 30 à 50 % plus petits que du JSON |
| Client | React 19 + Vite, **Zustand** pour l'état, **MapLibre GL JS** + protocole `pmtiles` | Conforme au cahier |
| Grille de navigation | **h3-js** (hexagones H3, Apache-2.0) | Pathfinding terre/mer sans terrain, et cohérent avec l'esthétique hexagonale |
| Géométrie | calculs sphériques maison + `@turf/*` ponctuellement | Arcs de portée géodésiques, grands cercles |
| i18n | i18next, `fr.json` | Textes externalisés dès le départ |
| Tests | **Vitest** (+ fast-check pour les propriétés du moteur), Playwright (smoke test mobile + desktop) | Le moteur est la partie critique |
| Auth | Email + mot de passe (argon2), cookie de session httpOnly, **compte invité** pour jouer tout de suite | Pas de dépendance externe au départ |
| Polices | Barlow Condensed, IBM Plex Sans, IBM Plex Mono (licence OFL, auto-hébergées, glyphes PBF générés pour MapLibre) | Conforme au cahier |

---

## 3. Structure des dossiers

```
red-line/
├── CLAUDE.md                     # décisions et contexte, tenu à jour
├── render.yaml                   # Blueprint Render (staging + production)
├── package.json / pnpm-workspace.yaml / tsconfig.base.json
│
├── apps/
│   ├── client/                   # le jeu
│   │   └── src/
│   │       ├── map/              # style MapLibre, calques (territoires, brouillard, portées,
│   │       │                     #   trajectoires, icônes hexagonales), placement des étiquettes à filets
│   │       ├── hud/              # bandeau titre, fiche d'arme, légende, horloge, ressources, alertes
│   │       ├── screens/          # armée, catalogue, recherche, renseignement, diplomatie, rapports…
│   │       ├── net/              # client WS, application des diffs, reconnexion
│   │       ├── store/            # Zustand (état visible du joueur, interpolé localement)
│   │       ├── sandbox/          # bac à sable de dev (moteur local, placement libre d'unités)
│   │       └── i18n/
│   │
│   ├── admin/                    # back-office (rôles : super-admin, équilibrage, modération)
│   │   └── src/{catalog, map, rules, live-games, shop, audit}/
│   │
│   └── server/
│       └── src/
│           ├── http/             # routes REST publiques (auth, lobby, catalogue en lecture)
│           ├── admin-api/        # routes /admin/api protégées par rôle
│           ├── ws/               # passerelle : auth, abonnement à une partie, ordres, diffs
│           ├── host/             # GameHost, ordonnanceur global, bail de partie, vitesse/pause
│           ├── visibility/       # filtre « ce que le joueur a le droit de voir » + calcul des diffs
│           ├── persistence/      # instantanés, journal d'ordres, reprise après redémarrage
│           ├── db/               # schéma Drizzle + migrations
│           ├── tiles/            # service des fichiers PMTiles (HTTP Range)
│           ├── shop/             # Stripe (phase 6)
│           └── metrics/          # CPU, mémoire, parties, joueurs, latence de la boucle
│
├── packages/
│   ├── shared/                   # types, protocole réseau, schémas zod, identifiants, constantes
│   ├── engine/                   # SIMULATION PURE ET DÉTERMINISTE
│   │   └── src/
│   │       ├── state/            # types de GameState, clonage, (dé)sérialisation
│   │       ├── time/             # horloge de jeu (ancre + vitesse + pause)
│   │       ├── queue/            # file de priorité d'événements (tas binaire, tri total)
│   │       ├── rng/              # PRNG à graine (xoshiro128**), état sérialisable
│   │       ├── geo/              # sphère : grands cercles, distances, entrée dans un cercle
│   │       ├── nav/              # grille H3 terre/mer, A*, détroits et canaux
│   │       ├── movement/         # trajets, interpolation, embarquement automatique
│   │       ├── encounters/       # détection, engagement, croisements ; index spatial ; invalidation
│   │       ├── combat/           # rounds, matrice de dégâts, contre-mesures, vétérance
│   │       ├── orders/           # validation et application des ordres
│   │       ├── economy/ research/ production/ logistics/     # phase 2
│   │       ├── intel/ sensors/                               # phase 3
│   │       ├── ai/ diplomacy/ stability/                     # phase 4
│   │       └── index.ts          # API : createGame, applyOrder, advanceTo, viewFor(player)
│   └── ui/                       # design system commun client + admin :
│                                 #   HexIcon, BracketFrame, WeaponCard, Legend, TitleBanner…
│
├── data/                         # tout l'équilibrage, en JSON versionné, validé par zod
│   ├── catalog/                  # un fichier par catégorie : fighters.json, tanks.json…
│   ├── balance/                  # combat.json, speeds.json, economy.json, intel.json…
│   ├── map/                      # nations.json, provinces.geojson, disputed.json, straits.json
│   └── scenarios/                # world-today.json, cold-war-1985.json…
│
├── tools/
│   ├── tiles/                    # pipeline : Blue Marble → tuiles raster sombres → PMTiles ;
│   │                             #   Natural Earth → PMTiles vectoriel (côtes, mers, villes)
│   ├── map/                      # génération des provinces et de la grille H3 terre/mer
│   └── icons/                    # pictogrammes SVG → sprites SDF MapLibre
│
└── docs/                         # architecture, protocole, guide de déploiement
```

---

## 4. Moteur de simulation par événements

### 4.1 Temps

- Le moteur ne manipule que du **temps de jeu** en millisecondes (`GameTime`).
- L'horloge d'une partie : `gameTime = anchorGame + (now − anchorReal) × speed`. Changer de vitesse ou mettre en pause = ré-ancrer (`speed = 0` pour la pause). Le serveur est le seul à lire l'horloge système.
- Un **ordonnanceur global unique** par processus garde un tas des parties triées par leur prochain événement (converti en heure réelle) et un seul `setTimeout`. Des dizaines de parties coûtent donc presque rien quand il ne se passe rien.

### 4.2 File d'événements

- Tas binaire par partie. Clé de tri **totale** : `(time, priority, seq)`, où `seq` est un compteur monotone : deux événements simultanés sont toujours traités dans le même ordre, donc le résultat est déterministe.
- Chaque événement déclare ses **dépendances** (`unitIds`, `zoneIds`). Un index inverse `entité → événements` permet, quand quelque chose change (nouvel ordre, radar détruit, brouillage activé), d'annuler et de recalculer uniquement les événements concernés. L'annulation est paresseuse : un numéro de version par entité, et les événements obsolètes sont ignorés à la sortie du tas.
- Types de la phase 1 : `MoveLegEnd`, `MoveArrive`, `ZoneEnter`, `ZoneExit`, `UnitContact`, `CombatRound`, `CaptureComplete`, `ProductionComplete`, `DailyTick`, `AiThink`.

### 4.3 Trajets et interceptions (le cœur du cahier)

- Un trajet est une suite de **segments de grand cercle** : départ, arrivée, vitesse constante. La position à l'instant *t* s'obtient par interpolation (slerp), avec le même code côté serveur et côté client.
- **Entrée dans une zone circulaire** (radar, défense aérienne, patrouille…) : sur la sphère unité, le point du segment vaut `p(θ) = a·cosθ + b·sinθ` ; la condition « dans la zone de centre *c* et de rayon *r* » s'écrit `A·cosθ + B·sinθ ≥ cos(r/R)`, qui se résout **exactement** (`√(A²+B²)·cos(θ−φ) ≥ k`). On obtient ainsi l'heure d'entrée et de sortie sans pas de temps.
- **Zones mobiles** (patrouille aérienne, navire escorteur) et **croisements de deux unités mobiles** : distance minimale sur la fenêtre commune de deux segments, par recherche dichotomique bornée (précision de 1 s de jeu), faute de solution fermée simple.
- **Index spatial** : cellules H3 de résolution 2. Chaque zone et chaque segment s'enregistrent dans les cellules qu'ils touchent, et seules les paires candidates sont testées.
- Un convoi peut donc être détecté, engagé ou détruit à mi-parcours : l'événement `ZoneEnter` tombe avant `MoveArrive`.

### 4.4 Navigation (sans terrain ni météo)

- **Air et missiles** : grand cercle direct (ravitaillement en vol en phase 3).
- **Terre** : A* sur une grille H3 de résolution 4 (cellules d'environ 22 km, environ 85 000 cellules terrestres) générée depuis les côtes Natural Earth, puis lissage en segments. Si le chemin traverse la mer, **embarquement automatique** au port (unité plus lente et vulnérable, comme dans Conflict of Nations).
- **Mer** : même grille pour les cellules maritimes. Détroits et canaux (Bosphore, Suez, Panama, Gibraltar, Ormuz…) sont des arêtes nommées dans `data/map/straits.json`, qui pourront être bloquées par un blocus en phase 4.
- Le terrain n'influence **jamais** le combat, conformément au cahier : la grille sert seulement à savoir où une unité peut aller.

### 4.5 Combat (phase 1 simple, extensible)

- Des unités en contact (ou dans une zone d'engagement) ouvrent un **combat par rounds** (un `CombatRound` toutes les X minutes de jeu, réglable). Dégâts = `dégâts[attaquant][classe de la cible] × effectif × modificateurs`, puis blindage, avec une variance tirée du PRNG à graine.
- Les **contre-mesures** sont portées par les données : la matrice de dégâts par classe de cible, plus des modificateurs (brouillage → précision, furtivité → portée de détection). Aucune règle d'arme n'est codée en dur.

### 4.6 Déterminisme, persistance, reprise

- **Journal d'ordres** en ajout seul : chaque ordre accepté est horodaté en temps de jeu et enregistré.
- **Instantané** complet de l'état (file d'événements et état du PRNG compris), compressé, toutes les N minutes réelles (réglable) et à l'arrêt propre du processus.
- **Reprise** = dernier instantané + rejeu des ordres postérieurs, puis rattrapage du temps écoulé pendant l'arrêt. Le **replay** d'une bataille utilise le même chemin.
- Un test automatique vérifie que *état initial + ordres ⇒ même état final au bit près*.
- **Bail de partie** (verrou consultatif PostgreSQL + battement de cœur) : une partie n'est simulée que par un seul processus à la fois. Indispensable au moment des déploiements Render, quand l'ancienne et la nouvelle instance coexistent quelques secondes, et plus tard pour répartir les parties sur plusieurs serveurs.

### 4.7 Visibilité et réseau

- Le serveur calcule, par joueur, l'ensemble des unités connues avec leur **niveau d'information** (inconnue, détectée, identifiée, précise), le dernier instant où elles ont été vues et l'incertitude de position. Seul cet ensemble est sérialisé vers le client : **aucune information cachée ne quitte le serveur**.
- Diffusion : un message d'état complet à l'abonnement, puis des **diffs** (unités ajoutées, modifiées, retirées ; trajets). Le client interpole les positions tout seul, ce qui permet d'envoyer les trajets une fois au lieu d'une position par seconde.
- Ordres entrants : schéma zod, puis validation par le moteur (propriété de l'unité, portée, ressources, alerte mondiale…), et limitation de débit par connexion.

---

## 5. Carte et rendu

| Couche | Source | Format | Remarque |
|---|---|---|---|
| Imagerie | **NASA Blue Marble Next Generation, topographie et bathymétrie** (domaine public) | raster WebP → PMTiles, zoom 0 à 8 | Assombrie et désaturée au pré-traitement, relief déjà ombré dans cette variante |
| Côtes, noms de mers, villes | **Natural Earth** (domaine public) | vecteur → PMTiles | Statique |
| Nations, provinces, propriétaires | `data/map` → base → **GeoJSON servi par l'API** | source GeoJSON MapLibre | **Dynamique**, jamais cuit dans les tuiles |
| Unités, sites, portées, trajectoires | état de la partie | sources GeoJSON mises à jour par diff | |

Rendu fidèle à l'image de référence :

- **Teinte des territoires** : couche `fill` avec couleur par `feature-state` (changer de propriétaire ne renvoie pas de géométrie), opacité de 0,45 à 0,6 pour le joueur, plus une couche `line` avec `line-blur` pour le halo.
- **Territoires disputés** : `fill-pattern` hachuré, aux couleurs des prétendants.
- **Brouillard** : polygone mondial percé par l'union des cercles des capteurs (recalculée seulement quand un capteur change), avec un motif de hachures sombres.
- **Icônes hexagonales** : deux sprites SDF superposés, l'hexagone teinté à la couleur de la nation (`icon-color`) et le pictogramme blanc. Un seul jeu de sprites pour toutes les nations, et regroupement (*clustering*) natif aux zooms monde et région.
- **Arcs de portée** : anneau géodésique (polygone entre portée minimale et maximale), remplissage orange translucide et bord extérieur marqué.
- **Trajectoires** : ligne en grand cercle, flèche en `symbol` et distance écrite le long de la ligne (`symbol-placement: line`).
- **Étiquettes à filets coudés** : voir la critique 6.4.

---

## 6. Critiques du cahier et contre-propositions

Le cahier demande de signaler les choix qui me semblent mauvais. Les voici, avec ma recommandation.

### 6.1 Offre Render : il faut une instance payante dès le départ
Les services web gratuits de Render **s'endorment après 15 minutes sans trafic** : les minuteurs de partie s'arrêteraient et les parties persistantes seraient impossibles. La base PostgreSQL gratuite est, elle, **temporaire** (elle expire au bout de quelques semaines ; délai exact à revérifier sur la grille tarifaire). → **Recommandation** : serveur en offre *Starter*, PostgreSQL en offre payante la plus basse, client et admin en *Static Sites* (gratuits). L'environnement de test peut rester sur les offres gratuites.

### 6.2 Imagerie satellite : pas de précision « ville » avec une source libre
Blue Marble a une résolution d'environ 500 m par pixel, ce qui la rend exploitable jusqu'au zoom 8 environ, pas au-delà. Les sources plus fines et vraiment libres pour un usage commercial sont rares : pour Sentinel-2 cloudless (EOX), seule l'édition 2016 serait sous CC BY 4.0 et les suivantes sont non commerciales, à vérifier avant tout usage. → **Recommandation** : imagerie jusqu'au zoom 8 (environ 87 000 tuiles, de l'ordre de 1 à 2 Go en WebP, surtout de la mer très compressible). Au-delà, bascule progressive vers un style **vectoriel sombre** (terres gris-bleu, routes et villes Natural Earth), qui colle d'ailleurs très bien à l'esthétique infographique.

### 6.3 Où servir les tuiles
Servir les PMTiles depuis le serveur de jeu impose un **disque persistant Render**. Un tel disque interdit les déploiements sans interruption, mais le bail de partie (4.6) gère déjà cette coupure. Autre défaut : chaque octet de tuile consomme la bande passante et le CPU du serveur de jeu. → **Recommandation** : phase 1 sur disque Render, comme le demande le cahier, derrière un en-tête `Cache-Control` long. Si la bande passante coûte cher, bascule vers Cloudflare R2 (sortie gratuite, requêtes Range prises en charge) : le code ne change pas, seule l'URL change.

### 6.4 Étiquettes à filets « qui ne se chevauchent jamais »
Afficher des centaines d'étiquettes reliées par des filets coudés, sans chevauchement et à 60 i/s sur mobile, n'est pas réaliste : l'image de référence en montre une vingtaine, et elle est statique. → **Recommandation** : les étiquettes cartouches à filets s'affichent pour un **ensemble limité** (sélection, objectifs de l'opération en cours, sites principaux à l'écran, 30 à 40 au maximum), placées par un algorithme glouton anti-collision dans une surcouche canvas. Tout le reste utilise les étiquettes natives de MapLibre, qui gèrent déjà les collisions en masquant les étiquettes qui se chevauchent.

### 6.5 Persister « l'état et la file d'événements »
C'est ce que je propose, mais **par instantanés et journal d'ordres** plutôt qu'en écrivant la file en base à chaque changement : beaucoup moins d'écritures, et le replay devient gratuit (voir 4.6).

### 6.6 Tout ce qui est interne à une partie vit dans l'état du moteur, pas dans des tables
Alliances, rapports de renseignement, résolutions du Conseil, stabilité… vivent dans `GameState` (sérialisé dans l'instantané). Les tables relationnelles ne servent qu'à ce qui traverse les parties : comptes, catalogue, carte, scénarios, achats, classements. Cela évite des dizaines de tables et garde le moteur testable. Exception : les **rapports** et le **fil d'actualité** sont aussi copiés dans une table en ajout seul, pour la pagination et la consultation hors partie.

### 6.7 Image de référence
Je reprends **uniquement ses codes visuels** (imagerie sombre, teinte violette, hexagones, filets, arcs orange, fiche d'arme, légende), comme le demande le cahier. Son contenu, qui nomme de vrais sites civils et nucléaires comme cibles, n'est pas repris : en jeu, les cibles restent des **bâtiments génériques par province** (raffinerie, centrale, port…), ce qui correspond déjà à la page 10 du cahier.

---

## 7. Modèle de données

### 7.1 PostgreSQL (hors partie)

```
users              id, email (unique), password_hash, display_name, role (player|admin roles…),
                   is_guest, premium_balance, created_at, last_seen_at
sessions           id, user_id, expires_at, user_agent

-- Catalogue d'armes : version courante + historique versionné
weapon_systems     id (texte, ex. "us.f-16"), data jsonb (fiche complète, validée zod),
                   enabled, revision, updated_at
catalog_releases   id, created_at, author_id, message, snapshot jsonb   -- catalogue figé
catalog_changes    id, release_id, system_id, before jsonb, after jsonb,
                   scope ('new_games'|'running_games'), player_message

-- Carte (même logique de versions)
nations            id, iso_code, name_key, kind ('state'|'entity'), color, capital_province_id
provinces          id, default_owner_id, name_key, geometry jsonb (GeoJSON simplifié),
                   centroid, city_point, resource_yield jsonb, building_slots jsonb
disputed_areas     id, province_ids[], claimant_ids[], tension_base, revolt_rate
map_releases       id, created_at, author_id, message, snapshot jsonb

rulesets           id, name, data jsonb (vitesses, victoire, vote du Conseil, fréquence des
                   rapports, économie…), created_at
scenarios          id, name_key, map_release_id, catalog_filter jsonb (ex. générations ≤ 3),
                   initial_setup jsonb, ruleset_id

-- Parties
games              id, scenario_id, status ('lobby'|'running'|'paused'|'ended'), mode ('solo'|'multi'),
                   speed, seed, catalog_release_id, map_release_id, ruleset_snapshot jsonb,
                   shop_policy jsonb, anchor_game_ms, anchor_real_at, lease_owner, lease_until,
                   created_by, created_at, ended_at
game_players       game_id, slot, user_id (null si IA), nation_id, ai_level, is_ai_replacement,
                   joined_at, last_active_at
game_snapshots     game_id, seq, game_time_ms, last_order_seq, state bytea (msgpack+zstd), created_at
game_orders        game_id, seq, player_slot, game_time_ms, payload jsonb, received_at
game_feed          game_id, id, game_time_ms, audience (public|player|alliance), kind, data jsonb
game_results       game_id, user_id, placement, stats jsonb   -- classements, saisons

-- Boutique (phase 6)
purchases          id, user_id, stripe_session_id (unique), pack_id, amount, currency, status
wallet_ledger      id, user_id, delta, reason, ref, created_at      -- ajout seul
stripe_events      id (id Stripe, unique), type, processed_at      -- idempotence des webhooks

admin_audit        id, admin_id, action, target, before jsonb, after jsonb, created_at
```

Les parties **épinglent** une `catalog_release` et une `map_release` : une modification admin « nouvelles parties seulement » ne touche pas les parties en cours. Une modification « aussi en cours » est injectée dans les parties comme un ordre système, donc tracée dans le journal et rejouable.

### 7.2 État d'une partie (`packages/engine`, en TypeScript)

```ts
interface GameState {
  time: GameTime;                 // ms de jeu
  rng: RngState;
  seq: number;                    // compteur d'événements
  config: GameConfig;             // règles figées de la partie
  catalog: CatalogIndex;          // catalogue épinglé (lecture seule)
  nations: Record<NationId, NationState>;   // ressources, stabilité, recherche, alerte…
  provinces: Record<ProvinceId, ProvinceState>; // propriétaire, bâtiments, PV, capture en cours
  units: Record<UnitId, Unit>;
  zones: Record<ZoneId, Zone>;    // détection / engagement, dérivées des unités et bâtiments
  combats: Record<CombatId, Combat>;
  knowledge: Record<NationId, Record<UnitId, Contact>>;  // brouillard de guerre
  queue: EventQueue;              // tas + index d'invalidation
  // phases suivantes : intel, alliances, council, market…
}

interface Unit {
  id: UnitId; owner: NationId; systemId: SystemId;
  count: number; hp: number; xp: number;
  pos: LatLng;                    // position au dernier point de trajet
  move?: Movement;                // trajet en cours, sinon unité immobile
  stance: 'hold' | 'defend' | 'aggressive';
  supply: 'supplied' | 'limited' | 'cut';
  version: number;                // pour l'invalidation paresseuse des événements
}

interface Movement { legs: Leg[]; departAt: GameTime; arriveAt: GameTime; }
interface Leg { from: LatLng; to: LatLng; t0: GameTime; t1: GameTime; medium: 'land'|'sea'|'air'; }

interface Contact {                // ce qu'une nation sait d'une unité ennemie
  level: 'detected' | 'identified' | 'precise';
  lastSeen: GameTime; lastPos: LatLng; move?: Movement;  // trajet vu, s'il l'a été
  systemId?: SystemId; count?: number;                   // selon le niveau
}
```

### 7.3 Fiche d'arme (exemple, `data/catalog/fighters.json`)

```json
{
  "id": "us.f-16",
  "name": "F-16 Fighting Falcon",
  "doctrine": "us",
  "origin": "US",
  "category": "fighter",
  "role": ["air_superiority", "strike"],
  "generation": 4,
  "cost": { "money": 1200, "resources": { "metals": 40, "electronics": 60, "oil": 20 } },
  "buildTimeH": 36,
  "upkeepPerDay": 25,
  "speedKmh": 2100,
  "operationalRadiusKm": 550,
  "weaponRangeKm": { "min": 1, "max": 100 },
  "damage": { "infantry": 4, "armor": 6, "aircraft": 14, "helicopter": 12, "drone": 10,
              "ship": 5, "submarine": 0, "missile": 2, "building": 8 },
  "hp": 30, "armor": 1,
  "stealth": 0.1,
  "detectionRangeKm": 150,
  "ew": { "jamming": 0.2, "jamResistance": 0.4 },
  "payload": { "slots": 6 },
  "requires": ["research.aero.gen4"],
  "licensable": true, "exportable": true,
  "icon": "fighter", "illustration": "us.f-16.webp",
  "sheet": { "engine": "1 turboréacteur", "lengthM": 15.1, "wingspanM": 9.8,
             "mtowKg": 19200, "warheadKg": null, "speedLabel": "Mach 2", "rangeKm": 4200 }
}
```

Les valeurs sont des **valeurs de jeu**, fondées sur des ordres de grandeur publics et arrondies. Toute la fiche est validée par un schéma zod partagé : le même schéma génère le formulaire du back-office et contrôle l'import JSON.

---

## 8. Déploiement (`render.yaml`)

- `redline-server` : Web Service Node, `pnpm --filter server build`, contrôle de santé sur `/healthz`, disque persistant monté sur `/data/tiles`.
- `redline-client`, `redline-admin` : Static Sites, avec réécriture SPA vers `index.html`.
- `redline-db` : PostgreSQL Render.
- Deux environnements : **staging** (branche `staging`, offres gratuites ou minimales) et **production** (branche `main`), séparés par des suffixes dans le même Blueprint, ou via les *Environments* d'un projet Render.
- Migrations Drizzle exécutées en `preDeployCommand`. Le catalogue JSON est chargé en base au démarrage, uniquement pour les fiches absentes ou marquées comme plus récentes dans le dépôt, pour ne jamais écraser une modification faite dans le back-office.

---

## 9. Plan de la phase 1 (Socle)

Critère de fin du cahier : **conquérir une province ennemie sur mobile et sur ordinateur.**

1. Monorepo, outillage (lint, format, typecheck, Vitest), CI GitHub Actions, `render.yaml`, `CLAUDE.md`.
2. `packages/engine` : temps, file, PRNG, géométrie sphérique, trajets, interceptions exactes, combat simple, capture de province, tests (dont la **propriété de rejeu déterministe**).
3. Pipeline de carte : Blue Marble → PMTiles sombre ; Natural Earth → provinces, nations (Gaza, Autorité palestinienne et Israël distincts), grille H3 terre/mer.
4. Serveur : auth (compte invité inclus), création d'une partie solo, GameHost et ordonnanceur, WS avec visibilité simple (portée de détection des unités), persistance et reprise, bail de partie.
5. Client : carte au style de référence, territoires, icônes hexagonales, sélection, ordre de déplacement, arc de portée, trajectoire avec distance, bandeau titre, fiche d'arme, légende, horloge et vitesse (x1, x2, x4… et pause), interface mobile en tiroirs.
6. Une dizaine d'unités de démonstration (infanterie, char, artillerie, chasseur, défense aérienne, drone de reconnaissance…) et une IA minimale qui défend.
7. Back-office minimal : liste et édition des fiches d'armes, import et export JSON, historique.
8. Bac à sable de dev ; test Playwright de bout en bout « conquérir une province » en viewport mobile et desktop.
9. Bilan de phase : ce qui marche, comment tester, ce qui reste, instructions de déploiement Render.

---

## 10. Questions à trancher avant de coder

1. **Budget Render** : d'accord pour un serveur en *Starter* et un PostgreSQL payant dès la production (voir 6.1) ?
2. **Imagerie** : d'accord pour Blue Marble jusqu'au zoom 8, puis un style vectoriel sombre (voir 6.2) ?
3. **Tuiles** : disque Render au départ, avec R2 comme option si la bande passante coûte cher (voir 6.3) ?
4. **Comptes** : email + mot de passe + invité en phase 1, et Google/Apple plus tard ?
