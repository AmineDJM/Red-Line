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

Structure exposée pour une future vue « Ministère de la Défense » : `PlayerView.command.branches`
(`CommandBranchView` : `chiefId`, `generalIds`, `candidates`, forces `{piles, free, elements, value}`, `opIds`),
puis `generals[].branch/chief/opId`, `ops[]` (`CampaignView`) et `armies[].opId/role`. Soit commandements → chefs →
généraux → opérations, sans dépendance au module `eco`.

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

`windows/CommandCenter.tsx` (onglets Opérations, Armées, Généraux ; indicateurs), `CommandOps.tsx` (assistant
cibles → objectif avec estimation → généraux par commandement → confirmation ; tableau de bord : progression,
état-major, journal, Renforcer, Changer d'objectif, Suspendre, Annuler), `CommandWizard.tsx` (composer → mission avec cible
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
