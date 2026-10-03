# Centre de commandement

Fenêtre « QG » (raccourci **Q**, bouton étoile de la barre du haut). Le joueur y lance des **opérations** contre un
ou plusieurs pays (onglet par défaut), forme des **armées** à partir de ses piles et leur confie une **mission**, et
engage des **généraux** fictifs, payés chaque jour, qui commandent avec l'IA militaire du moteur. Les généraux
appartiennent à quatre **commandements** (armée de terre, armée de l'air, marine, défense antiaérienne). Tout vit
dans `GameState` (`state.mods.cmd`), tous les chiffres dans `data/balance/default.json` → `command` (schéma
`CommandBalanceSchema`, `packages/shared/src/command.ts`).

## Modèle

- **Armée** (`ArmySt`) : nom, piles (une pile appartient à au plus une armée), général, mission, mode de renforts
  (`off` / `ask` / `auto`), journal (40 entrées, `LocText`), demandes en attente, mémoire propre de l'IA
  (opérations, engagements, transports). Une pile scindée transmet son armée à ses enfants ; une pile détruite
  ou fusionnée hors armée en sort. Maximum 12 armées et 120 piles par armée.
- **Missions** (`command.missions`, extensibles) : `conquer`, `defend`, `hold_front`, `air_superiority`,
  `air_defense`, `deep_strike`, `sea_control` (blocus), `landing`, `reserve`. Chacune déclare un cerveau
  (`brain`), un type de cible (province / nation / zone), les domaines attendus et un rayon. Paramètres :
  agressivité (prudente / équilibrée / audacieuse : rapport de force exigé, repli, poursuite, part de chasse,
  objectifs simultanés), règles d'engagement (strictes / standard / libres), seuil de repli d'une pile.
  Statuts : préparation, en cours, en attente d'ordres (demande), réussie, échouée (pertes, enlisement,
  forces insuffisantes, zone perdue), suspendue. Estimation affichée avant validation : rapport de force
  (forces vues, sinon estimation du renseignement), durée, chances.
- **Généraux** : vivier déterministe de 6 candidats par nation, renouvelé tous les 7 jours, noms fictifs tirés
  de 29 cultures (jamais de personnes réelles). Compétences 0-100 : offensive, défensive, logistique, aviation,
  marine, audace (prudent ↔ audacieux), expérience ; 0 à 2 traits (`command.generals.traits`). **Solde** par
  grade (note moyenne des compétences) : général de brigade 35 k$/j, de division 80 k$/j, de corps d'armée
  190 k$/j, d'armée 400 k$/j, +30 % au sein du grade selon la note, × traits, × indice de coût du pays.
  Prime d'engagement 5 jours, indemnité de licenciement 10 jours ; 3 jours impayés ⇒ démission. Ligne
  « Généraux et états-majors » (`command`) du grand livre. XP : captures, succès, jours de combat.
  QG touché (dégâts sur la première pile terrestre de l'armée) : blessure (3 jours) ou mort, par tirage.

## Comment le général conduit l'IA

Toutes les `aiThinkMinutes`, chaque armée en mission réfléchit (`brain.ts`) avec les fonctions de `ai/ai.ts`
restreintes à ses propres piles (`ArmyScope` : unités, mémoire, zone) : groupes d'assaut, transports
amphibies, garnisons, contre-attaques, patrouilles, escortes, frappes. Les compétences fixent le niveau d'IA
(`levelFor`) : rapport de force exigé (agressivité + audace + traits), taille des groupes (offensive,
logistique), objectifs par cycle (offensive, traits), contre-attaques (défensive), ralliement avant assaut
(logistique), escortes navales (marine), escortes aériennes et SEAD (aviation), budget de chemins
(logistique). L'expérience réduit les **frictions** (cycles perdus, tirage par le PRNG du module) et renforce
les bonus modestes appliqués par `unitModifier` (dégâts +5 % × offensive, protection à l'arrêt +5 % × défensive,
endurance et rayon logistique +8 % × logistique, modulés par l'expérience et les traits).

Règle d'ordre affichée au joueur : **un ordre direct sur une pile prime jusqu'à sa fin, puis le général reprend
la pile.** Les ordres du général passent par `aiOrder` (mêmes validations que ceux du joueur).

Selon les règles d'engagement, le général **demande** l'autorisation d'entrer en guerre ou de frapper l'arrière
ennemi, et des renforts (mode `ask`) ; les réponses passent par l'ordre `armyAnswer`. Notifications
(`engine.note.cmd_*`) et journal (`engine.cmd.j.*`) sont des clés traduites.

## Commandements

`BRANCHES = land | air | sea | ad` ; l'arme d'une pile vient de son système (`branchOfSystem` : domaine air ⇒
armée de l'air, mer ⇒ marine, catégories `air_defense` et `radar` ⇒ défense antiaérienne, espace et nucléaire hors
commandement, le reste ⇒ armée de terre). Chaque commandement a :

- son **vivier** (6 candidats, renouvelé tous les 7 jours ; compétence maîtresse `BRANCH_SKILL` : offensive,
  aviation, marine, défensive ; vivier terrestre inchangé pour les anciennes parties, autres viviers dans
  `bpools["nation:arme"]`, candidats `cand-<arme>-<n>`) ;
- son **général en chef** (`chiefs`, ordre `commandChief`) : bonus aux compétences de ses généraux
  ((note − 50) × `chiefBonus`), solde × `chiefSalary` ; en opération, un général blessé est remplacé par un adjoint
  (× `deputySkill`) au lieu de rendre son armée passive ;
- ses **forces** : les piles de son arme.

Structure lue par le ministère de la Défense (fenêtre Gouvernement, section Commandements, `commandsOf` de
`apps/client/src/lib/government.ts`) : `PlayerView.command.commands` (`DefenseCommandView[]`, contrat partagé) avec,
par commandement, `id` (arme), `domain` (`land`, `air`, `sea`, `air_defense`), `chief` (`{id, name}` ou null),
`generalIds` et `generals` (`{id, name, status, opId?}`), `operationIds` et `operations` en cours
(`{id, name, goal, status, pct}`), `forces`. Le détail complet reste dans `command.branches` (`CommandBranchView` :
vivier, forces `{piles, free, elements, value}`), `generals[].branch/chief/opId`, `ops[]` (`CampaignView`) et
`armies[].opId/role`. Soit commandements → chefs → généraux → opérations, sans dépendance au module `eco`.

## Opérations

Une **opération** (`OpSt`, `ops.ts` pour le planificateur, `opbrain.ts` pour la conduite) regroupe les pays visés
(ou des provinces, pour Occuper), un objectif, 1 à `maxCommanders` généraux (un général ne commande qu'une
opération à la fois, réaffectation par `campaignForces`), une échéance facultative, les règles d'engagement,
l'agressivité et un seuil de repli. Au plus `maxOps` opérations en cours. Chaque général reçoit une armée
(existante ou formée d'office avec la part `forceShare[agressivité]` des piles libres de son arme, une pile
terrestre restant à la capitale sauf engagement total), un **rôle** (son arme par défaut, modifiable) et, pour
l'armée de terre, un **secteur** (axe pays ↔ cibles découpé en blocs contigus, nord / sud / est / ouest / centre).

Objectifs (`command.operations.goals`, extensibles : ordre, commandements recommandés, type de cible, objectif
continu, seuil de réussite) :

| Objectif                | Conduite                                                                                                                                                           | Réussite                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `attrition` (affaiblir) | frappes : défense antiaérienne et radars, puis aviation au sol, bases, forces terrestres, navires ; chasse au sol à `huntKm` ; reconnaissance si rien n'est connu  | `success` (50 %) de la valeur estimée des forces détruite           |
| `air_control`           | SEAD/DEAD de toutes les défenses connues, chasse, patrouilles au-dessus des cibles une fois le ciel ouvert                                                         | plus d'appareil actif ni de défense connue, puis maintien (continu) |
| `conquest`              | rassemblement borné (`stageHours`), secteurs, groupes d'assaut, assaut conjoint des petites armées, appui aérien, transports navals, garnisons des prises menacées | toutes les provinces prises                                         |
| `decapitation`          | poussée sur la capitale (priorité ×4)                                                                                                                              | capitale prise                                                      |
| `strategic`             | SEAD des seules défenses couvrant les sites, puis bâtiments militaires, navals et industriels révélés                                                              | `success` (80 %) des bâtiments connus détruits                      |
| `sead`                  | défenses sol-air et radars connus                                                                                                                                  | toutes détruites                                                    |
| `blockade`              | navires sur les ports, attaque des navires, patrouille côtière                                                                                                     | ports bloqués (continu)                                             |
| `defend_border`         | front tenu, contre-attaques, DCA ; ne déclare pas la guerre                                                                                                        | continu                                                             |
| `occupy`                | comme la conquête, sur les provinces désignées                                                                                                                     | provinces prises et tenues                                          |

Objectifs ajoutés (37 au total, par **catégorie** `land` / `air` / `sea` / `ad` / `joint`, champ `category` ;
`war: false` = aucune déclaration de guerre ; paramètres numériques dans `params`, tous dans
`data/balance/default.json`). Préparation des cibles : `opgoals.ts` (`setupGoal`), mesure : `measureGoal`,
conduite spécifique : `opconduct.ts`, branchée dans `opbrain.ts`.

| Objectif                | Cat.  | Conduite                                                                                                              | Réussite (mesure principale)                                    |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `counteroffensive`      | terre | reprendre ses provinces occupées, les plus précieuses d'abord, appui aérien                                           | provinces reprises / occupées                                   |
| `liberation`            | terre | chasser l'occupant des provinces d'un allié (cible `ally`) ; chaque prise est **rendue** à l'allié                    | provinces libérées                                              |
| `encircle`              | terre | couper le goulet (provinces de la poche au contact, poids `neckWeight`), puis réduire la poche                        | toutes les provinces de la poche                                |
| `breakthrough`          | terre | axe étroit vers la capitale (chemin BFS), toutes les piles sur l'axe (secteur `all`)                                  | profondeur `depth` atteinte sur l'axe                           |
| `raid`                  | terre | frapper `targets` installations de l'arrière, puis phase `withdraw` (repli ordonné) après `hours`                     | arrière frappé (installations, provinces) puis piles rentrées   |
| `siege`                 | terre | prendre l'anneau (voisines de la ville) d'abord, puis la ville                                                        | ville prise                                                     |
| `defense_depth`         | terre | lignes successives tenues par parts (`line1`, `line2`), contre-attaques, repli ordonné                                | provinces des lignes tenues (continu)                           |
| `defend_capital`        | terre | garnison `capitalShare`, anneau tenu, DCA et chasse au-dessus de la capitale                                          | capitale et anneau tenus (continu)                              |
| `pacify`                | terre | une garnison par province conquise ou agitée, chasse aux infiltrés à `huntKm`                                         | provinces sécurisées (continu)                                  |
| `show_of_force`         | terre | masser à la frontière sans la franchir (`war: false`)                                                                 | `success` (60 %) des piles massées à `borderKm`                 |
| `ally_support`          | int.  | déployer sur le front d'un allié, couvrir et défendre                                                                 | provinces du front allié couvertes (continu)                    |
| `interdiction`          | air   | bases avancées, ports, dépôts de carburant, convois en mouvement                                                      | installations logistiques détruites ; convois frappés en second |
| `cas`                   | air   | frapper les forces au contact de ses offensives en cours (`radiusKm`)                                                 | forces adverses au contact détruites                            |
| `strategic_bombing`     | air   | industrie, énergie, ressources, y compris les réparations (cibles reprises)                                           | sites détruits                                                  |
| `air_defense_territory` | air   | patrouilles (`patrolShare`) au-dessus de la capitale et des bases, interceptions, DCA (`war: false`)                  | appareils ennemis abattus (continu)                             |
| `air_redeploy`          | air   | convoyage vers les terrains les plus proches de la zone (portée de convoyage, `war: false`)                           | appareils rebasés                                               |
| `armed_recon`           | air   | survol et révélation du pays, frappes d'opportunité                                                                   | provinces révélées                                              |
| `naval_supremacy`       | mer   | traque (`huntKm`) et attaque des flottes connues, puis patrouille                                                     | navires ennemis coulés                                          |
| `antiship`              | mer   | sous-marins, missiles antinavires et patrouilles contre tout navire                                                   | navires coulés                                                  |
| `convoy_escort`         | mer   | escorte des transports chargés, patrouille des routes (`war: false`)                                                  | transports escortés (continu)                                   |
| `amphibious`            | mer   | transports ajustés à la capacité (`fitTransports`), escorte, appui, tête de pont                                      | provinces côtières visées prises                                |
| `port_blockade`         | mer   | `shipsPerPort` navires par port, navires sortants attaqués, bases navales frappées                                    | ports bloqués (continu)                                         |
| `naval_strikes`         | mer   | salves de croisière navales (`salvos`) sur défenses, bases, sites côtiers                                             | cibles détruites                                                |
| `missile_shield`        | DCA   | antimissiles (enveloppe `ballistic_missile`) et DCA sur la capitale et `sites` bases (`war: false`)                   | sites couverts ; interceptions comptées                         |
| `ad_umbrella`           | DCA   | la DCA suit les offensives, juste derrière le front                                                                   | offensives couvertes (continu)                                  |
| `missile_campaign`      | DCA   | salves coordonnées (`salvos`, `readyShare` des lanceurs prêts ou `waitHours`) sur DCA, bases aériennes et militaires  | cibles détruites                                                |
| `blitz`                 | int.  | **objectif composé** : `chain` [sead, air_control, breakthrough, decapitation], échéances `chainHours` [36, 24, 0, 0] | chaque phase selon son critère                                  |
| `combined_landing`      | int.  | objectif composé : [sead, amphibious], [24, 0]                                                                        | chaque phase selon son critère                                  |

Cibles par genre (`target`) : `nation`, `provinces`, `place` (provinces ou pays), `self` (son propre territoire,
rien à désigner) et `ally` (pays allié ou ami, refusé en guerre). Un objectif sans cible au lancement
(contre-offensive sans province occupée…) est refusé avant toute embauche.

### Enchaînement des phases et « quand c'est fini »

Une opération porte une **chaîne** de phases (`OpSt.chain`, ordre `campaignCreate.phases`, au plus `maxPhases`),
objectif composé développé (`blitz`, `combined_landing`), chaque phase avec ses cibles (celles de la précédente
par défaut) et une **échéance** facultative (`hours`, ou `phaseHours` pour la première). Une phase se termine sur
réussite (ou maintien acquis pour un objectif continu) ou à son échéance ; la suivante démarre aussitôt avec les
**mêmes généraux et les mêmes armées** (`advancePhase` → `setGoal`), rassemblement court (`phaseStageHours`),
journal `phaseDone` / `phaseTimeout` / `phaseSkipped` (phase sans cible sautée), notification `cmd_opPhase`.
`campaignEdit` : `phases` (remplace les phases à venir), `after`, `nextPhase` (passer), `stageNow` (écourter le
rassemblement).

**Quand c'est fini** (`after`) : `hold` (défaut) — l'opération close, les armées gardent leurs généraux et
**exploitent** : garnisons sur les gains, DCA, chasse si l'ennemi vole, contre-attaques (`holdOp` /
`holdGround`) ; `home` — retour vers les villes, bases et ports d'origine (`returnHome`, au plus `returnHours`),
puis remise des piles ; `reserve` — remise immédiate. Dans tous les cas, une nouvelle opération ou mission
reprend **les mêmes généraux et leurs piles** sur-le-champ (`enlist` avec `keepArmies`, piles des armées
d'office d'une opération close comptées comme libres).

**Jamais inerte sans raison** : vue `wait` (`WaitView`) sur chaque armée et chaque général d'opération :
autorisation de guerre, renforts proposés, fin du rassemblement (échéance), piles sous ordre direct (bouton
« Rendre au général », ordre `armyEdit.reclaim`), suspension, général manquant ou blessé, ravitaillement,
forces insuffisantes, aucune cible connue, repos ; posture `hold` / `home` après une mission ou une opération.

### Pourquoi « les armées ne font que la première mission » (corrigé)

Causes mesurées sur les vraies données (répro : France, opération Luxembourg puis mission Charleroi → 0 ordre,
Charleroi reste belge ; après correction : 5 ordres, Charleroi prise) :

1. `brain.ts` `thinkArmy` : `if (a.op) { thinkOpArmy(); return }` — une armée restée attachée à une opération
   close ignorait sa nouvelle mission (`armies.ts` `applyMission` ne la détachait pas). Désormais
   `applyMission` détache l'opération (`detachOp`, journal `leftOp`).
2. `ops.ts` `closeOp` laissait les armées captives de l'opération close (statut réussite / échec, inertes,
   `opbrain.ts` sortait aussitôt), leurs piles hors des forces libres (`freeBranchPiles`), et l'assistant les
   masquait (filtre `!a.opId`). Désormais : posture `after`, armées d'office reprises par la suivante.
3. `orderCampaignCreate` comptait les opérations closes dans `maxOps` (et le client, `full`).
4. `brain.ts` `otherAims` comptait la mémoire (`mem.ops`, `commit`) des armées inertes : cibles « déjà visées ».
5. Réussite ou échec d'une mission laissaient l'armée inerte : `endMission` passe en posture `hold` (missions
   de prise) et efface la mémoire d'échec.
6. Un ordre direct sans fin (patrouille, blocus) gardait les piles « manuelles » après une nouvelle mission :
   `applyMission` remet `manual` à zéro.
7. `ai.ts` `needFor` : besoin plancher d'une capitale à 2 × l'unité moyenne — avec les piles mixtes
   (brigades), une capitale n'était jamais attaquée (« forces insuffisantes » jusqu'à l'échec). `needAt`
   (brain.ts) le borne par `min(2 × unité moyenne, 2 × landingPrior)` pour les missions et opérations.

Tests : `command-chain.test.ts` (synthétique : 4 échecs avant correction), `command-chain-real.test.ts` et
`command-goals-real.test.ts` (vraies données).

**Planificateur** (`planOp`, à chaque réflexion, avant les armées) : guerre (automatique en ROE standard ou libres,
demande au joueur en ROE strictes), mesure (`measure` : métriques par objectif), phases (rassemblement, SEAD,
air, offensive, maintien, terminée), cibles du focus partagées entre armées, fin (réussite, échéance, pertes
au-delà du seuil de repli, enlisement `failStuckHours`), alertes (pertes lourdes `heavyLossShare`, enlisement
`stuckHours`, objectif atteint). **Conduite** (`thinkOpArmy`) : niveau d'IA dérivé des compétences (`levelForOp` :
groupes jusqu'à 16 piles selon `groupShare`, objectifs simultanés, budget de chemins), puis les parties terrestre,
aérienne (sorties `sorties`, cibles prioritaires, redéploiement vers le terrain le plus proche à portée de
convoyage), navale, feux (lanceurs, cellules) et DCA (placement près du focus, des prises, du front, de la
capitale). Tous les ordres passent par `aiOrder` ; les généraux sont déterministes (PRNG du module).

Suivi : progression chiffrée (`progress`, `pct`), statistiques (frappes, prises, valeur détruite mesurée par le
crochet `onDamage`, pertes), journal (`engine.cmd.op.*`), demandes, notifications `cmd_op*`.

Ordres : `campaignCreate` (atomique : embauches, armées, rôles), `campaignEdit` (objectif, cibles, paramètres),
`campaignForces` (renforcer, retirer, rôles), `campaignSuspend`, `campaignCancel`, `campaignAnswer`,
`commandChief`. Anciennes sauvegardes : champs facultatifs, rien à migrer.

### Pourquoi les généraux « rassemblaient puis tenaient »

Avant les opérations, une armée en mission plafonnait ses groupes d'assaut (3 à 6 piles, 1 à 3 objectifs par
cycle) ; `runOps` libérait le rassemblement si la force restait sous le besoin ou si `warGoalReached` (part
de guerre du profil IA, appliquée à tort aux armées du joueur) était atteint, d'où des piles au point de
rassemblement et un cycle sans fin ; les départs échelonnés n'étaient pas bornés ; les piles qui ne capturent
pas (DCA, radars) ne bougeaient jamais ; les missions de zone tiennent un pôle par conception ; une armée d'une
seule pile mixte n'attaquait jamais (`minUnits` 2). Les armées en opération bornent le rassemblement
(`stageHours`), ignorent `warGoalReached`, attaquent dès une pile (`minGroup`) et se coordonnent.

## Contrats

Ordres (`COMMAND_ORDERS`) : `armyCreate` (atomique : piles + embauche + mission), `armyEdit`, `armyMission`,
`armySuspend`, `armyDissolve`, `armyAnswer`, `generalHire`, `generalAssign`, `generalDismiss`. Vue :
`PlayerView.command` (section `command`), uniquement les armées, généraux et candidats du joueur.

## Interface (`apps/client`)

`windows/CommandCenter.tsx` (onglets Opérations, Armées, Généraux ; indicateurs ; bandeau « armée
d'opération », posture et attente de chaque armée), `CommandOps.tsx` (assistant objectif — catalogue par
catégorie avec icône, ligne de description et généraux recommandés — → cibles selon le genre → plan → généraux
par commandement → confirmation ; tableau de bord : progression, phases, état-major avec l'attente de chaque
général et son bouton d'action, journal, Renforcer, Changer d'objectif, Suspendre, Annuler ; bandeau de
rassemblement « Lancer maintenant » ; opération close : « Nouvelle opération, même état-major », rouvrir),
`CommandPlan.tsx` (constructeur de chaîne : phases glissées ou montées / descendues, échéance par phase,
choix « Quand c'est fini » ; frise des phases ; ligne d'attente), `opsIcons.ts` (icônes d'objectif et de
catégorie), `CommandWizard.tsx` (composer → mission avec cible
désignée sur la carte → général), `CommandGenerals.tsx` (généraux par commandement, chef, viviers), `map/commandLayer.ts` (étiquette,
zone, flèches d'offensive colorées par rôle, contour rouge des pays visés), `shell/CommandPick.tsx` (désignation sur la carte, lien depuis la sélection).
Logique pure testée dans `lib/command.ts` et `lib/ops.ts` (état-major proposé, estimation).

## Coût de calcul

Banc `packages/engine/bench/command.ts` (données réelles, France contre Belgique, armée de piles terrestres) :
`CMD_SEEDS=1,2 CMD_AGGR=cautious,bold node --expose-gc bench/run.mjs command` (dans `packages/engine`). Mesure
(carte fusionnée, 4 jours, monde entier simulé) : 583 à 900 ms par jour de jeu avec l'armée, contre 347 à
393 ms sans armée ni guerre. L'écart inclut la guerre que l'armée déclenche (combats, captures, IA belge en
guerre), pas seulement la réflexion du général ; prise de Charleroi entre J+0,4 et J+1,0, mission réussie
dans les quatre cas.

Opérations (données réelles, `command-ops-real.test.ts`, monde entier simulé) : conquête France → Belgique,
4 provinces en 25 h environ ; Turquie → Syrie, 6 provinces en 47 h ; affaiblir Russie → Ukraine, environ 300
frappes et 26 % des forces estimées détruites en 2 jours ; réflexion des généraux ≈ 410 ms par jour de jeu
en Russie → Ukraine (le reste de l'écart, 1,1 à 2,1 s par jour contre 222 ms sans guerre, est la guerre
elle-même : combats, interceptions, IA ukrainienne).

Chaînes de phases (banc `CMD_OP=…`, ex. `CMD_DAYS=3 CMD_OP=sead,conquest node --expose-gc bench/run.mjs command`,
`CMD_OP=blitz CMD_NATION=tur CMD_FOE=syr`) : SEAD → conquête France → Belgique, phase 2 lancée à H+2, réussite
à J+1,04, 737 ms par jour (référence sans opération 354 ms) ; conquête seule, même partie : 880 ms par jour
(réussite à J+1,04) ; guerre éclair Turquie → Syrie : SEAD, puis ciel à J+0,83, percée à J+0,96, réussite
(capitale prise) à J+2,21, 918 ms par jour (référence 343 ms). L'enchaînement ne coûte rien de plus qu'une
opération simple : l'écart reste celui de la guerre elle-même.
