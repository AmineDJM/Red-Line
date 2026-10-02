# CLAUDE.md — Red Line

Jeu de stratégie géopolitique en temps réel sur la vraie carte du monde, dans le navigateur (inspiré de Conflict of
Nations). Victoire uniquement militaire. Cahier des charges : PDF « Prompt Claude Code — Red Line » fourni par Amine.

## État

- **Phase 1 (Socle) : terminée** — bilan dans `docs/phase1-bilan.md`.
- **Phases 2 à 6 : intégrées** (économie, armée, renseignement, diplomatie, serveur, back-office, interface,
  optimisation). Brief des équipes : `docs/agents-brief-v2.md` ; charge et capacité : `docs/charge.md` ;
  déploiement pas à pas : `docs/deploiement.md`.
- Parties sans joueur (décision d'Amine) : la partie **continue toujours** ; après 5 min sans humain connecté,
  seules les IA lointaines (> `time.dormancyRadiusKm`) et en paix avec les joueurs mettent leurs décisions en
  veille (commande système `dormancy`). **Fin pour abandon** et fermeture après **48 h** sans connexion (solo) ou
  **24 h** sans aucun humain (multijoueur). Quota : 10 parties solo en cours, suppressibles par le joueur.
- Économie du service (coûts mesurés par partie et par joueur, attribution, recettes, alertes) et gestion
  complète du back-office (comptes, RGPD, parties, annonces, paramètres serveur) : `docs/couts.md`.
- Exigences d'Amine prioritaires : **dollars réels** (prix unitaires réels, budgets de défense réels), **arsenaux
  réels** au départ (ORBAT), production soumise à la R&D, **vraies photos** des matériels, interface **terminal
  moderne extrêmement propre** et carte au niveau de **Conflict of Nations**.

## Carte du dépôt

- `packages/shared` : contrats (types, schémas zod, protocole WS, API REST, géométrie sphérique). Tout changement
  de contrat se fait ici, en champs optionnels si possible.
- `packages/engine` : simulation pure et déterministe (aucune E/S, aucun `Date.now`, aucun `Math.random`).
- `packages/ui` : design system commun (hexagones, cadres à crochets, fiche d'arme, jetons de couleur).
- `apps/server` : Fastify + WebSocket + PostgreSQL (Drizzle) ; sert aussi `apps/client/dist` (`/`) et
  `apps/admin/dist` (`/admin/`).
- `apps/client` : jeu (React, Vite, MapLibre, Zustand, i18next). `apps/admin` : back-office.
- `apps/site` : pages publiques prérendues au build (SEO : accueil, guide, nations, arsenal, FAQ, légal), contenus
  par langue dans `apps/site/content/<langue>/` (site.json + legal/*.md, le français fait foi), servies sous
  `/<langue>/…` par `apps/server/src/http/site.ts` (jetons `{{origin}}` = `PUBLIC_URL`, `{{legal.*}}` = back-office).
- `data/` : catalogue, équilibrage, scénarios, carte (générée), fond de carte, glyphes, tuiles satellite.
- `tools/map`, `tools/tiles`, `tools/glyphs` : pipelines reproductibles qui produisent `data/` ; `tools/audio` : sons et
  musiques ElevenLabs → `apps/client/public/audio` (moteur audio : `apps/client/src/audio`).
- `e2e/` : Playwright contre le vrai serveur. `docs/` : architecture, déploiement, bilans.

## Décisions prises

- Monorepo pnpm, TypeScript strict ; paquets internes consommés en source (pas de build des libs).
- Simulation par événements : file `(time, priority, seq)`, invalidation paresseuse par version ; trajets en grand
  cercle ; entrée dans les zones circulaires calculée exactement ; croisements mobiles par recherche bornée.
- Navigation sur grille H3 résolution 4 ; `cells.json.impassable` = terres sans propriétaire (Antarctique, zones
  tampons), infranchissables. Le terrain n'influence jamais le combat.
- **Réseau de routes** (`data/map/routes.json`, `pnpm --filter @redline/tools-map routes`, graphe `RoadNet` de
  `packages/shared`) : les unités terrestres ne circulent que sur les routes (villes = points de capture, centres,
  ports, passages de frontière, carrefours) ; destination accrochée à moins de `movement.roadSnapKm`, sinon ordre
  refusé (`off_road`) ; traversées de port à port sur la grille navale. Air et mer : trajets libres inchangés.
  Unité hors réseau (ancienne sauvegarde) : termine son trajet, puis rejoint la route la plus proche. Désactivable : `movement.roadNetwork: false`.
- Guerre déclarée automatiquement par un ordre d'attaque ou l'entrée dans une province étrangère.
- Distances des paires alignées sur les bandes de seuils (`consistentDist`, encounters/pairs.ts) : sans cela,
  l'arrondi d'acos laissait une pile arrivée sur la ville « juste hors » du rayon de capture ou de tir (ni
  capture ni combat). Balayage de conquête de toutes les provinces : `CONQUEST_ALL=1` (test engine
  `conquest-sweep`).
- **Transport naval** (`military.transport`, module mil `transport.ts`) : ordres `embark` / `disembark`,
  capacité = éléments × `payload.transport` × places ; troupes à bord hors carte, perdues avec le navire ;
  débarquement contesté = malus de dégâts. Les traversées automatiques de port à port restent en place.
- **Escorte** (`military.escort`, `escort.ts`) : ordre `escort`, vol / navigation / route en formation avec la
  pile protégée, engagement des menaces autour d'elle ; fin sur arrêt, cible détruite ou posée, carburant.
- Persistance : instantanés compressés + journal d'ordres ; reprise = instantané + rejeu. Bail de partie en base
  (colonnes `lease_owner`/`lease_until`) ; ne jamais fixer `INSTANCE_ID` à une constante sur Render.
- L'état interne d'une partie vit dans `GameState`, pas dans des tables SQL.
- Le serveur n'envoie que ce que le joueur a le droit de voir (`viewFor`, `notificationsFor`, diffs MessagePack).
- **Même origine** pour API, jeu et back-office (pas de Static Sites séparés : `onrender.com` est sur la liste des
  suffixes publics, un cookie inter-sous-domaines deviendrait tiers et serait bloqué par Safari).
- Imagerie : Blue Marble juillet 2004 (décembre = Russie et Canada enneigés), zoom 0 à 8, **commitée**
  (~93 Mio, sous la limite GitHub de 100 Mio) ; pas de disque Render.
- Fond vectoriel en GeoJSON statique (`data/basemap`) plutôt qu'en PMTiles vectoriel (petit volume, pas de tippecanoe).
- Cibles stratégiques : bâtiments **génériques** par province, jamais de vrais sites nommés. De l'image de référence,
  on ne reprend que les codes visuels.
- Armées de départ en **piles mixtes** (brigades, escadres ; `data/balance` `stacks`, désactivable) : une pile vaut
  la somme de ses éléments (`Unit.mix`), ordres `split` / `merge` ; mesures dans `docs/charge.md`.
- Couleurs de nations : jamais de violet (réservé au joueur), deux voisins jamais identiques.
- Défense antiaérienne : enveloppes par catégorie de menace (avions, hélicoptères, drones, croisière, balistiques,
  hypersoniques) dans `interceptor.envelopes` du catalogue ; tout ce qui vole est engagé par intercepteurs
  (magasin, canaux, priorité, saturation, rechargement) : `docs/defense-aerienne.md`.
- Ressources des provinces (`pnpm --filter @redline/tools-map resources`) : aucune nation sans ressource (micro-États
  exceptés), **plancher national** de production pour chaque ressource (`resources.nationalFloor`) ; menu Construire
  limité aux bâtiments ouverts pour la province ; insigne de ressources devant le nom des villes. `docs/ressources.md`.

## Conventions

- Tous les chiffres d'équilibrage dans `data/` (JSON validé par zod), jamais en dur.
- Textes de l'interface en français, externalisés (`apps/client/src/i18n/fr.json`, `apps/admin/src/i18n/fr.ts`).
- Multilingue (15 langues, arabe en RTL) : source française, autres langues produites et contrôlées par `tools/i18n`
  (`check`, `translate -- --import`) ; toute nouvelle clé de `fr*.json` doit être traduite (test de complétude en CI).
  Le moteur ne porte que des clés + paramètres (`LocText`, champs optionnels). Voir `docs/i18n.md`.
- Nom du jeu : **Red Line** (interface, titres, métadonnées).
- Accès de diagnostic du client (`window.__rl`, `window.__rlMap`) : actifs en mock ou avec localStorage `rl.debug=1`.
- `REDLINE_EXTRA_SPEEDS` : vitesses d'essai pour les tests, refusées en production.

## Commandes

```bash
pnpm install
pnpm --filter @redline/server db:dev   # PostgreSQL jetable, port 54329 (données dans .pgdata)
pnpm build && pnpm start               # http://localhost:3000
pnpm dev                               # serveur :3000, client :5173, admin :5174
pnpm typecheck && pnpm test            # ~480 tests unitaires (moteur : --no-file-parallelism si machine chargée)
pnpm e2e                               # bout en bout (build + base requis)
pnpm format                            # Prettier
```

Attention : dans l'environnement cloud de Claude, `DATABASE_URL` pointe vers une base Render réelle. Pour les essais
locaux, toujours forcer `DATABASE_URL=postgres://postgres@127.0.0.1:54329/redline`.
