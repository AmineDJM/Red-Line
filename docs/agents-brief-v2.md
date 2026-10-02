# Brief commun — Phases 2 à 6 (tout livrer, sans validation intermédiaire)

Lis d'abord : `CLAUDE.md`, `docs/architecture.md`, `docs/phase1-bilan.md`, ce fichier, puis les contrats
`packages/shared/src/*.ts` (surtout `economy.ts`, `military.ts`, `intel.ts`, `diplomacy.ts`, `view.ts`,
`protocol.ts`, `api.ts`, `balance.ts`, `catalog.ts`) et `packages/engine/src/api.ts`, `packages/engine/src/modules/`.

Le cahier des charges complet d'Amine est résumé dans `docs/architecture.md` ; les exigences ajoutées par Amine
depuis sont **prioritaires** et listées ci-dessous (§ Exigences d'Amine).

## Méthode de travail (worktree isolé)

- Tu travailles dans un **worktree git isolé** (ta propre copie du dépôt, ta propre branche). Commence par
  `pnpm install --frozen-lockfile` (le magasin pnpm est partagé : c'est rapide). Si tu ajoutes une dépendance,
  le lockfile change dans ta branche, c'est normal.
- **Commite** ton travail dans ta branche, par étapes cohérentes, messages en français, sans pousser. Termine par
  un commit final propre. L'orchestrateur fusionne toutes les branches ensuite.
- Ne modifie **que les fichiers de ton périmètre** (indiqué dans ta mission). Contrats partagés
  (`packages/shared`) : ajouts **optionnels** seulement, et signale-les dans ton rapport. Jamais de suppression ni de
  renommage d'un champ existant.
- Avant de finir : `typecheck` et tests de tes paquets au vert, `pnpm exec prettier --write` sur tes fichiers.
- Fichiers temporaires : `/tmp/claude-0/-home-user-Red-Line/f97702d8-0462-564b-a9e9-21a6bf589e3c/scratchpad/<ton-nom>/`.
- **Base de données** : la variable d'environnement `DATABASE_URL` du conteneur pointe vers une **vraie base
  Render d'Amine : ne JAMAIS l'utiliser**. PostgreSQL local jetable sur le port 54329 (déjà lancé depuis le dépôt
  principal ; sinon `apps/server/scripts/dev-db.sh start`) : crée ta propre base (`redline_<ton-nom>`) et force
  `DATABASE_URL=postgres://postgres@127.0.0.1:54329/redline_<ton-nom>`.
- Chromium pour Playwright : `/opt/pw-browsers` (ne lance jamais `playwright install`).
- Réseau : npm, raw.githubusercontent.com, Wikipedia / Wikimedia Commons (API), sipri.org, NASA accessibles ;
  github.com bloqué. Identifie-toi par `User-Agent: RedLine/0.1 (+https://github.com/AmineDJM/Red-Line)`.
  **N'envoie jamais l'adresse e-mail d'Amine** à un service externe.
- Textes visibles en **français**, externalisés. Nom du jeu : **Red Line**.

## Exigences d'Amine (prioritaires)

1. **Argent réel en dollars US.** Chaque système a son **prix unitaire réel estimé** (`unitPriceUsd`) et
   `cost.money = unitPriceUsd × unitSize` en dollars. Entretien (`upkeepPerDay`) en dollars (≈ coût annuel de
   possession / 365). Affichage : `$1,2 Md`, `$450 M`, `$85 k` (format français).
2. **Budget réel** : chaque nation reçoit son **budget de défense annuel réel actuel** (SIPRI / IISS, 2024-2025),
   versé chaque jour de jeu (`balance.money.budgetPerDayFraction`), dont une part liée aux provinces
   (`balance.money.provinceShare` : conquérir rapporte, perdre coûte).
3. **Arsenal réel** : chaque nation démarre avec son **inventaire actuel estimé** (`data/orbat/2025/<nation>.json`,
   schéma `OrbatSchema`). Exemple d'Amine : si l'Algérie aurait 14 Su-57, elle les a en début de partie, **mais ne
   peut pas en produire** tant qu'elle n'a pas fait la R&D nécessaire (`requires` du système, voir portes de
   recherche). Posséder ≠ savoir produire.
4. **Graphismes et interface** : niveau **Conflict of Nations**, beaucoup plus propre, et style
   **terminal moderne / PowerShell, extrêmement propre** (voir § Direction artistique).
5. **Photos réelles** des avions et armements dans l'arsenal, proprement présentées, avec crédit et licence.

## Direction artistique : « Terminal tactique »

Une console de commandement moderne : l'élégance d'un terminal (Windows Terminal, PowerShell 7, Warp),
extrêmement propre, dense mais aérée, au-dessus d'une carte au niveau de Conflict of Nations.

- **Polices** : `JetBrains Mono` (OFL, paquet `@fontsource/jetbrains-mono`) pour toute l'interface et les
  chiffres ; titres en majuscules espacées dans la même police. Pas de police fantaisie.
- **Palette** (jetons CSS dans `packages/ui/src/tokens.css`, à réécrire par l'équipe interface) :
  fond `#0a0e13`, panneau `#0e141b`, panneau 2 `#121a23`, filet `#1e2a36`, texte `#d6dde6`, texte atténué
  `#7d8b99`, **cyan** `#4cc9f0` (sélection, interface, invite de commande), **vert** `#3ddc84` (ses forces, succès),
  **ambre** `#ffb020` (valeurs, portées, trajectoires), **rouge** `#ff4d5e` (menaces critiques uniquement),
  **violet** `#9b6bff` (territoire du joueur), bleu `#3a86ff` (information).
- **Fenêtres** : panneaux à bord fin 1 px, coins 4 px, barre de titre façon onglet de terminal avec une invite
  (`PS RED-LINE:\Armée>` ou `redline@fra:~/armee$`), curseur clignotant discret, raccourci affiché à droite.
  Tableaux alignés en chasse fixe, séparateurs fins, jauges nettes (`████░░░░ 54 %` rendu proprement en CSS).
  Animations courtes (120-180 ms), aucune fioriture.
- **Console de commande** (`Ctrl+K` ou `:`) : palette de commandes avec autocomplétion, qui permet de tout faire au
  clavier (`move 12e-brigade bruxelles`, `produce 4 rafale paris`, `research aero.gen5`, `goto alger`…), en plus
  des gestes à la souris et au doigt (mobile : bouton console).
- **Carte, niveau Conflict of Nations** : imagerie sombre existante ; pions d'unités nets (rectangle arrondi avec
  drapeau de la nation, pictogramme du type, effectif, barre d'état), empilement et regroupement lisibles selon le
  zoom, villes avec marqueur de taille et nom, capitales distinguées, frontières nettes, territoire du joueur
  violet, flèches d'ordres animées (pointillés en mouvement), anneaux de sélection, portées ambre, infobulles au
  survol, transitions fluides. Drapeaux : `flagUrl(nationId)` de `@redline/ui` (fichiers dans
  `apps/client/public/flags`, flag-icons, MIT).
- **Photos** : `data/art/photos.json` (manifeste `systemId → { file, credit, license, sourceUrl }`) et fichiers
  `apps/client/public/art/photos/<systemId>.webp` (+ `<systemId>.thumb.webp`). Afficher le crédit sous la photo.

## Portes de recherche (identifiants FIXES, utilisés par le catalogue, l'ORBAT et le moteur)

```
research.aero.gen2 gen3 gen4 gen4plus gen5          (chasseurs et avions de combat par génération)
research.aero.bomber1 bomber2 stealth-bomber         (bombardiers subsoniques, supersoniques, furtifs)
research.aero.helo1 helo2 helo3                      (hélicoptères : transport ancien, attaque, attaque moderne)
research.aero.drones1 drones2 drones3                (tactiques, MALE armés et HALE, UCAV furtifs)
research.aero.aew tanker transport                   (guet aérien, ravitaillement, transport stratégique)
research.land.gen1 gen2 gen3 gen4 gen5               (chars, véhicules, artillerie par génération)
research.land.mlrs ew                                (lance-roquettes lourds, guerre électronique terrestre)
research.naval.gen1 gen2 gen3 gen4 gen5 carrier      (navires de surface, porte-avions)
research.naval.sub1 sub2 sub3 ssbn                   (sous-marins, sous-marins lanceurs d'engins)
research.missiles.sam1 sam2 sam3 sam4 sam5 abm       (défense aérienne par génération, antimissile)
research.missiles.cruise1 cruise2 antiship           (croisière, antinavire)
research.missiles.ballistic1 ballistic2 ballistic3 hypersonic
research.nuclear.weapons icbm slbm
research.sensors.radar1 radar2 radar3 space1 space2 asat
research.cyber.l1 l2 l3
research.intel.interior1 interior2 interior3 exterior1 exterior2 exterior3 military1 military2 military3
research.industry.l1 l2 l3
```

Chaque système du catalogue a dans `requires` exactement les portes nécessaires pour **le produire**. Chaque ORBAT
liste dans `research` les portes que la nation maîtrise réellement aujourd'hui (ex. Algérie : gen4 et gen4plus,
mais pas gen5 ; France : gen4plus, nuclear.weapons et slbm, pas gen5). Le catalogue (équipe données) crée ces nœuds
et d'autres dans `data/research/*.json` (schéma `ResearchFileSchema`).

## Identifiants

- Systèmes : **exactement** ceux de `data/catalog-ids.json` (380 systèmes, convention `doctrine.slug`).
- Nations : `data/map/nations.json` (ISO alpha-3 en minuscules, plus `gaza`, `pse`, `xkx`, `sol`, `cyn`, `esh`).
- Échelle : 1 élément = 1 appareil, 1 char, 1 navire, 1 lanceur, 1 satellite ; **infanterie : 1 élément =
  1 bataillon (≈ 600 personnes)**. `unitSize` = 1 sauf exception documentée ; l'ordre `produce` accepte `count`.
- Le moteur regroupe l'inventaire réel en **piles** (unités de jeu) réparties sur les bases (bâtiments `air_base`,
  `military_base`, `port`) ; cible ≤ ≈ 5 000 unités de jeu au départ, monde entier.

## Répartition des équipes (périmètres)

| Équipe       | Périmètre (écriture)                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| eng-eco      | `packages/engine/src/modules/eco/**`, chargement monde (`state/world.ts`, `state/create.ts`), tests eco |
| eng-mil      | `packages/engine/src/modules/mil/**`, cœur combat/mouvement/rencontres/vision/IA de combat, tests mil   |
| eng-intel    | `packages/engine/src/modules/intel/**`, tests intel                                                     |
| eng-diplo    | `packages/engine/src/modules/diplo/**`, `packages/engine/src/ai/**` (IA stratégique), tests diplo       |
| data-arsenal | `data/catalog/**`, `data/research/**`, `data/scenarios/**`, `data/balance/**`, `docs/arsenal.md`        |
| data-orbat   | `data/orbat/**`, `docs/orbat.md`                                                                        |
| art          | `data/art/**`, `apps/client/public/art/**`, `tools/art/**`                                              |
| ui-shell     | `packages/ui/**`, `apps/client/src/**` SAUF `src/map/**` ; `fr.json`                                    |
| ui-map       | `apps/client/src/map/**`, `apps/client/src/i18n/fr.map.json`                                            |
| server       | `apps/server/**`                                                                                        |

Fichiers partagés du cœur du moteur (`sim/`, `orders/`, `view/`, `state/types.ts`) : chaque équipe moteur peut y
faire des ajouts **minimes et localisés** ; tout le reste de sa logique vit dans son module.

## Rapport final attendu

Ce qui est fait, comment le tester, ce qui manque, écarts de contrat, et le **nom de ta branche**.

## Communication entre modules du moteur (sans import croisé)

Les modules ne s'importent **jamais** entre eux (ils sont développés en parallèle). Trois mécanismes :

1. **Tableau partagé** `board(state)` (`modules/kit.ts`, type `SharedBoard`) : alerte mondiale et tension (écrit
   par mil), embargos, sanctions, zones d'exclusion, cessez-le-feu, stabilité, alliances (écrits par diplo),
   autorisations nucléaires (mil), mobilisation (eco). Lu par tous.
2. **Signaux** `signal(state, nom, données)` (`modules/registry.ts`) reçus par `hooks.onSignal` de chaque module :

| Signal                  | Émetteur    | Données                                                            | Réagissent                |
| ----------------------- | ----------- | ------------------------------------------------------------------ | ------------------------- |
| `building_hit`          | mil         | `{ pid, building, damage (0..1), by }`                             | eco (santé bâtiment)      |
| `strike`                | mil         | `{ by, victim, at, kind: 'missile'\|'air'\|'artillery', nuclear }` | diplo (actualité), intel  |
| `nuclear_detonation`    | mil         | `{ by, victim, at, pid }`                                          | diplo, eco                |
| `battle_end`            | mil         | `{ reportId, at, winner, nations }`                                | diplo (actualité)         |
| `blockade`              | mil         | `{ by, pid?, straitId?, on }`                                      | eco (commerce), diplo     |
| `sabotage`              | intel       | `{ by, victim, pid, building, damage }`                            | eco                       |
| `cyber`                 | intel       | `{ by, victim, kind: 'radar'\|'production'\|'orders', hours }`     | mil, eco                  |
| `disinformation`        | intel       | `{ by, victim, amount }`                                           | diplo (stabilité)         |
| `leak`                  | intel       | `{ by, victim, headline, body }`                                   | diplo (actualité)         |
| `agent_caught`          | intel       | `{ spyNation, onNation }`                                          | diplo (incident)          |
| `rebels_funded`         | intel/diplo | `{ by, pid, amount }`                                              | diplo                     |
| `black_market_detected` | intel       | `{ buyer, systemId }`                                              | diplo                     |
| `research_stolen`       | intel       | `{ by, victim, nodeId }`                                           | eco (accorde le nœud)     |
| `delivery_intercepted`  | mil         | `{ deliveryId, by }`                                               | eco                       |
| `alert`                 | tous        | `{ amount, reason }` (hausse de tension)                           | mil (niveau d'alerte)     |
| `news`                  | tous        | `{ category, headline, body, at, nations }`                        | diplo (fil d'actualité)   |
| `stability`             | tous        | `{ nation, delta, reason }`                                        | diplo                     |
| `domestic_policy`       | diplo       | `{ nation, policy, on }` (politique intérieure changée)            | —                         |
| `domestic_event`        | diplo       | `{ nation, kind: 'strike'\|'protest'\|'riot'\|'sabotage', pid }`   | intel (menace intérieure) |

`sabotage` peut aussi venir de diplo (réseau rebelle intérieur) : `{ victim, pid, building, damage, domestic: true }`,
sans `by`. Clés de modificateurs ajoutées : `production.speed.infantry` (eco, infanterie), `unrest.risk` (diplo
politiques × intel sécurité intérieure), `site.protection` (intel, site protégé). Tableau partagé : `moraleShift`
(diplo), `moraleAvg` (eco), `protectedSites` (intel).

Tout signal inconnu est ignoré. Tu peux en ajouter : documente-le dans ton rapport. 3. **Crochets** du cœur (`modules/types.ts`) : `modifier`, `unitModifier`, `canProduce`, `canImport`,
`placeStartingForces`, `onDailyTick`, `onUnitDestroyed`, `onDamage`, `onProvinceCaptured`, `onWarDeclared`,
`aiThink`, `audience`, `stats`.

Catégorie `logistics` ajoutée : `other.supply-convoy`, `other.cargo-ship`, `other.cargo-aircraft` (porteurs des
livraisons du marché, génériques, non combattants).
