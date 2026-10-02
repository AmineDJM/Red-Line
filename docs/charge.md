# Charge et robustesse du serveur

Mesures faites le 30 septembre 2026 avec le **vrai moteur** et les **vraies données** (scénario « Le monde
aujourd'hui » : 201 nations, 2 567 provinces, ORBAT 2025, 116 nœuds de recherche), sur le serveur de production
(`NODE_ENV=production`, build `pnpm build`), PostgreSQL 16 local.

Machine d'essai : 4 vCPU partagés avec d'autres travaux (charge moyenne 3 à 8 pendant les essais) ; les
pourcentages de CPU sont ceux **du seul processus serveur** (`process.cpuUsage`, 100 % = un cœur).

## Reproduire

```bash
# 1. Serveur de production, chaque client simulé ayant sa propre « IP » (limites de débit réalistes)
NODE_ENV=production CLIENT_IP_HEADER=x-load-ip MIGRATE_ON_START=true \
  DATABASE_URL=postgres://postgres@127.0.0.1:54329/redline_charge \
  SESSION_SECRET=… ADMIN_EMAIL=admin@exemple.fr ADMIN_PASSWORD=… \
  node --max-old-space-size=384 apps/server/dist/main.js

# 2. 64 joueurs humains simulés dans une partie monde + 3 parties simultanées, 3 minutes
pnpm --filter @redline/server exec tsx scripts/load-test.ts --base http://localhost:3000 \
  --players 64 --games 3 --duration 180 --speed 16 --order-every 15 \
  --admin-email admin@exemple.fr --admin-password …

# Coûts unitaires du moteur (sans serveur)
pnpm --filter @redline/server exec tsx scripts/bench-engine.ts 64 24 4
pnpm --filter @redline/server exec tsx scripts/bench-views.ts 12
pnpm --filter @redline/server exec tsx scripts/determinism-check.ts 6
```

Chaque client simulé est un vrai client WebSocket (MessagePack, permessage-deflate) : il reçoit la vue initiale,
les diffs et les notifications, et donne un ordre toutes les 7 à 22 s (70 % de déplacements d'une unité à
50-300 km, 30 % de changements de posture) plus un ping de temps en temps. Les métriques du serveur sont lues
toutes les 5 s sur `/admin/api/metrics`.

## Coûts unitaires du moteur (partie monde)

| Opération                                       | Coût                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `buildWorld` (une fois par version de données)  | 0,8 s                                                           |
| `createGame` (201 nations, ORBAT réels)         | 0,7 s                                                           |
| `viewFor` d'une nation                          | 8 ms en moyenne, 25 ms au pire                                  |
| `diffViews` d'une nation                        | 5 ms en moyenne, 46 ms au pire                                  |
| Vue initiale (message `welcome`)                | 275 Kio bruts, ~22 Kio compressés (permessage-deflate)          |
| Diff                                            | 1,1 à 1,5 Kio (médiane), 5 à 6,6 Kio (95e centile)              |
| Instantané `serializeState`                     | 75 ms, 2,1 Mio bruts → 430 Kio gzip ; `deserializeState` 240 ms |
| Pas de simulation le plus long (IA quotidienne) | 230 ms                                                          |
| 24 h de jeu (201 IA)                            | ~0,8 s de calcul, ~200 pas                                      |

## Résultats

| Essai                                                             | CPU moyen / max | Mémoire (RSS max, tas vivant) | Ordres p50 / p95 / max | Diffs par joueur          | Boucle d'événements                    |
| ----------------------------------------------------------------- | --------------- | ----------------------------- | ---------------------- | ------------------------- | -------------------------------------- |
| **Avant** corrections : 64 joueurs + 3 parties, ×16               | 94 % / 105 %    | 887 Mo                        | 33 / 258 / 1 694 ms    | 13,5 / min                | pire 1,7 s                             |
| **Après** : 64 joueurs + 3 parties, ×16                           | 51 % / 86 %     | 888 Mo (sans borne), 170 Mo   | **7 / 92 / 344 ms**    | 10,8 / min, 1,4 Kio (p50) | tranches ≤ 40 ms, 1 seule > 250 ms     |
| Après, tas borné à 384 Mo (offre Starter) : 64 joueurs + 1 partie | 48 % / 69 %     | **396 Mo**, 150 Mo            | —                      | —                         | ramasse-miettes : pauses de 10 à 30 ms |
| 10 parties monde simultanées (13 joueurs), ×4, tas 384 Mo         | 13 % / 100 %\*  | 457 Mo, ~265 Mo               | 4 / 26 / 61 ms         | 3,1 / min, 0,3 Kio        | pire 0,66 s (création d'une partie)    |

\* Les pointes à 100 % correspondent aux créations de parties (`buildWorld` + `createGame`, ~1,5 s d'un seul
tenant, non découpables côté serveur) ; en régime établi, 10 parties monde à ×4 consomment ~13 % d'un cœur.

Autres mesures : une partie monde pèse ~15 à 25 Mo de tas vivant (le monde, ~60 Mo, est partagé par toutes
les parties de même version de données) ; ~430 Kio par instantané en base (3 conservés par partie) ; 64 joueurs
reçoivent ~2,5 à 3,6 Mo/min de WebSocket au total (≈ 40 à 55 Kio/min par joueur, décompressé ≈ 120 Kio/min).

## Goulots trouvés et corrigés

1. **Chaque ordre déclenchait une diffusion complète** (64 × `viewFor` + `diffViews` ≈ 0,9 à 1,6 s de calcul
   d'un seul tenant). Désormais : retour immédiat au seul joueur qui a donné l'ordre (`flushNation`), les
   autres nations reçoivent l'effet avec la diffusion groupée suivante.
2. **Diffusions découpées en tranches** d'au plus ~40 ms (une nation après l'autre) : la boucle d'événements
   n'est plus jamais bloquée par une diffusion ; un seul `viewFor` et un seul `diffViews` par nation et par
   vue précédente (plusieurs onglets d'un même joueur partagent le calcul).
3. **Diffusions adaptatives** : l'écart entre deux diffusions d'une partie est proportionnel à leur coût, pour
   qu'elles n'occupent jamais plus de 35 % du processeur (`flushCpuShare`) ; la diffusion suivante est programmée
   à la fin de la précédente, avec son coût complet (avant : une nouvelle diffusion repartait aussitôt).
   Avec 64 joueurs, les actions des autres nations arrivent en 2 à 4 s, les siennes immédiatement.
4. **Rattrapage de simulation découpé** (`advanceTo` par événements, budget de 40 ms, reprise au tour suivant) :
   après un redémarrage, une partie à ×16 arrêtée une heure rattrape 16 h de jeu sans geler les autres.
   Même chose pour le rejeu du journal d'ordres à la reprise, et les instantanés passent une partie à la fois.
5. **Connexion d'un joueur** : plus de diffusion complète à chaque arrivée (tempête de reconnexions après un
   déploiement : 67 connexions en 2 s).
6. **Instantanés** : une seule sérialisation au lieu de deux (`stateHash` du moteur resérialisait l'état :
   110 ms économisées par instantané) ; empreinte SHA-256 calculée hors du chemin de simulation.
7. **Parties sans joueur connecté** : une partie **continue toujours** (constructions, recherche, attaques
   nocturnes des IA, guerres en cours). Après 5 min sans aucun joueur humain connecté, les IA **lointaines**
   (aucune ville à moins de `time.dormancyRadiusKm` = 2 000 km d'une ville d'un joueur humain) **et en paix
   avec lui** mettent leurs décisions en veille (commande système `dormancy`, journalisée : le rejeu reste
   identique) ; elles se réveillent dès le retour d'un joueur. Les voisins et tout pays en guerre avec un
   joueur continuent de jouer. Une partie **solo** dont le joueur ne s'est pas connecté depuis **48 h**,
   ou une partie **multijoueur** sans aucun joueur humain connecté depuis **24 h**, est **terminée pour
   abandon et fermée** (`pause_reason = 'abandoned'`, `GameMeta.endReason`) ; les parties déjà déchargées
   (mises en pause par le joueur) sont terminées directement en base. Toute partie en pause sans connexion depuis 10 min est
   déchargée de la mémoire. Au redémarrage, seules les parties **en cours** sont adoptées (les autres sont
   chargées à la demande).
8. **Quotas de création** : 10 parties solo et 5 parties multijoueur non terminées par joueur, 10 créations par
   minute et par IP (une création coûte ~1,5 s de calcul). Le joueur peut **supprimer** ses parties solo
   (`DELETE /api/games/:id`), ce qui libère son quota.
9. **Compression** : WebSocket permessage-deflate (au-delà de 2 Kio, sans contexte conservé : pas de mémoire
   zlib par connexion) ; fichiers statiques précompressés au build (Brotli + gzip : 14,4 Mio → 2,8 Mio).
10. **Déterminisme** : `stabilityView` (module diplo) créait une entrée dans l'état à la lecture ; les parties
    regardées par un joueur divergeaient donc de leur rejeu (empreinte différente après un arrêt brutal).
    Corrigé (lecture seule) et vérifié par `scripts/determinism-check.ts` et par un test de reprise du vrai moteur.

Métriques ajoutées au back-office (écran Métriques) : latence de la boucle (99e centile et pire), nombre et
coût CPU des diffusions, pire diffusion, parties en rattrapage ; le serveur journalise tout travail synchrone
de plus de 250 ms (`travail synchrone long`).

## Piles de départ regroupées (piles mixtes)

Décision d'Amine : moins de piles, plus grosses, séparables à volonté. Au départ, les matériels terrestres
(infanterie, VCI, chars, artillerie), les hélicoptères et les drones d'une nation forment des **piles
mixtes** (brigades interarmes, escadres) posées sur les sites de leur domaine (capitale, frontières
menacées, bases, grandes villes) ; avions de combat (escadrons d'un seul type sur une base), navires,
défenses antiaériennes, radars, missiles et satellites gardent leurs piles d'origine
(`startingForces.stackMax`). Réglages : `data/balance` → `stacks` (`start.enabled` désactive tout le
regroupement, `start.groups` fixe catégories et tailles, `classes` les mélanges autorisés, `mergeKm`,
`maxSystems`, `ai` l'emploi par l'IA).

Une pile mixte (`Unit.mix`, champ optionnel : les anciennes sauvegardes se rechargent telles quelles)
vaut la somme de ses éléments : chaque matériel tire avec ses dégâts et sa portée, les dégâts reçus sont
répartis au prorata des points de vie (blindage de chaque matériel), détection du meilleur capteur,
vitesse du plus lent, entretien et consommation de chaque matériel (`state/stack.ts`,
`combat/stack-combat.ts`). Ordres journalisés : `split` (diviser en deux, détacher N éléments au prorata,
détacher des éléments par matériel, séparer par type) et `merge` (même matériel, ou même classe de fusion,
à l'arrêt, à moins de `mergeKm`). L'IA divise ses piles en guerre (garnisons, groupes d'offensive) et les
refond en paix (`ai/stacks.ts`). Client : panneau de sélection (touche « Piles… » sur mobile) et
« Mes armées ».

Mesures (2 octobre 2026, `bench/real.ts` et `bench/stacks.ts`, machine partagée très chargée — charge
moyenne 15 à 22 — : comparer surtout les temps de **CPU**). « Avant » = même code, `BENCH_STACKS=off`.

| Mesure (monde 2025)                        | Avant (sans regroupement) | Après              | Écart      |
| ------------------------------------------ | ------------------------- | ------------------ | ---------- |
| Unités au départ                           | 4 238                     | 2 141 (369 mixtes) | **−49 %**  |
| Paires de rencontre au départ              | 11 442                    | 5 449              | **−52 %**  |
| `createGame` (CPU)                         | 1 245 ms                  | 942 ms             | −24 %      |
| Tas de la partie                           | 12,8 Mio                  | 8,7 Mio            | −32 %      |
| Instantané au départ                       | 2,06 Mio                  | 1,26 Mio           | −39 %      |
| Jour calme J0 → J1 (CPU)                   | 1 510 ms                  | 610 ms             | −60 %      |
| Jour de guerre intense J1 → J2 (CPU)       | 19,0 s                    | 15,4 s             | −19 %      |
| Jour suivant J2 → J3 (CPU)                 | 10,3 s                    | 8,1 s              | −22 %      |
| J3 → J5 (CPU, 10 à 17 guerres)             | 10,8 s                    | 10,8 s             | =          |
| `viewFor` moyen (CPU, 20 nations)          | 43,7 ms                   | 24,2 ms            | −45 %      |
| Instantané à J5 (après 10 guerres forcées) | 3,7 Mio                   | 5,4 Mio            | +46 % (\*) |

| Scénario 1985 (`bench/stacks.ts`) | Avant    | Après              | Écart     |
| --------------------------------- | -------- | ------------------ | --------- |
| Unités au départ                  | 3 156    | 1 341 (341 mixtes) | **−58 %** |
| Paires au départ                  | 4 007    | 1 666              | −58 %     |
| `createGame`                      | 1 453 ms | 751 ms             | −48 %     |
| Instantané au départ              | 1,07 Mio | 0,65 Mio           | −39 %     |

Éléments (347 891 en 2025, 479 940 en 1985) et entretien journalier identiques avec ou sans regroupement.
(\*) La différence vient des rapports de bataille (`mods.mil.battles` : images et tirs échantillonnés,
bornés par bataille et en nombre de rapports) : les grosses piles livrent des combats plus longs, donc
des rapports plus remplis ; l'état des unités et des paires reste plus petit. À surveiller par l'équipe
des rapports de bataille (`military.battle.maxFrames`, `maxShots`, `maxReports`).

IA (`bench/ai-eval.ts`, guerres forcées, niveau normal, graines 1 et 2, 5 jours ; moyenne des deux
graines, avant → après) : provinces prises 31,5 → 30, captures réussies 172 → 156, unités perdues en
capture 37 → 33, capitales perdues 1 → 0,5, forces terrestres inactives 80 % → 65 %, CPU 23 s → 26 s
(machine chargée). L'IA donne ~450 ordres `split` (détachements, garnison de la capitale divisée en
premier) et refond ses piles en paix. Points à reprendre : capitale menacée sans garnison plus souvent
(`capBarePct` 2 % → 15 %) et production de défense antiaérienne et d'infanterie en baisse (les piles
mixtes comptent comme leur matériel principal dans les choix de production).

```bash
cd packages/engine
node --expose-gc bench/run.mjs stacks                                   # recensement 2025 + 1985
BENCH_STACKS=off node --expose-gc bench/run.mjs stacks                  # sans regroupement
BENCH_DAYS=2 [BENCH_STACKS=off] [BENCH_SCENARIO=cold-war-1985] node --expose-gc bench/run.mjs real
```

## Seuils de passage à l'offre Render supérieure

Node.js exécute la simulation sur **un seul cœur** : au-delà d'un cœur, seuls le ramasse-miettes, la
compression et les E/S en profitent. Le serveur ne répartit pas encore les parties entre plusieurs instances
(les baux le permettent, mais le WebSocket d'un joueur doit alors atteindre l'instance qui héberge sa partie) :
la montée en charge est **verticale**.

| Offre (Render)                | Capacité mesurée / estimée                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Starter** (0,5 CPU, 512 Mo) | jusqu'à ~8 parties monde en cours et ~30 joueurs connectés au total ; une partie à 64 joueurs **tient en mémoire** (396 Mo) mais sature le demi-cœur (48 % d'un cœur mesuré) |
| **Standard** (1 CPU, 2 Go)    | une partie à 64 joueurs + une dizaine de parties ; ~20 à 25 parties monde en cours ; `NODE_OPTIONS=--max-old-space-size=1536`                                                |
| **Pro** (2 CPU, 4 Go)         | 2 à 3 parties à 64 joueurs simultanées, ~40 parties monde ; `--max-old-space-size=3072`                                                                                      |

Passer à l'offre supérieure quand l'un de ces signaux dure (écran **Métriques** du back-office) :

- **CPU moyen > 40 %** en Starter (le demi-cœur est plein à 50 %), **> 70 %** en Standard ;
- **boucle : 99e centile > 200 ms** plusieurs minutes (ordres et diffs ralentis pour tout le monde) ;
- **mémoire (RSS) > 420 Mo** en Starter, > 1,7 Go en Standard ;
- une partie à **plus de ~20 joueurs humains** connectés simultanément en Starter ;
- des « parties en rattrapage » (compteur non nul) en dehors des redémarrages ;
- des messages `travail synchrone long` fréquents dans les journaux Render.

Base de données : `basic-256mb` suffit tant que la taille reste sous ~4 Go (disque de 5 Go) ; chaque partie monde
écrit ~430 Kio par minute d'instantanés (intervalle `SNAPSHOT_INTERVAL_S`, 60 s par défaut). Au-delà de ~50
parties en cours, passer à `basic-1gb` ou porter `SNAPSHOT_INTERVAL_S` à 120 (la reprise rejoue le journal
d'ordres, rien n'est perdu).

## Pistes pour l'équipe moteur

- `viewFor` (8 à 25 ms) et `diffViews` (5 à 46 ms) par nation dominent le coût des diffusions : une vue
  incrémentale (nations « sales » seulement) diviserait ce coût par un facteur proche du nombre de joueurs.
- Le pas le plus long (~230 ms, IA quotidienne de 201 nations) n'est pas découpable côté serveur ; l'étaler sur
  plusieurs événements supprimerait les derniers pics de latence.
- `createGame` (0,7 s) et `deserializeState` (0,24 s) bloquent la boucle lors des créations et reprises.
- Le moteur annonce parfois un événement à l'instant courant qu'`advanceTo` ne consomme pas
  (`événement non consommé` dans les journaux) ; le serveur le contourne (nouvel essai 1 s plus tard).
