# Centre de commandement

Fenêtre « QG » (raccourci **Q**, bouton étoile de la barre du haut) : le joueur forme des **armées** à partir de
ses piles, leur confie une **mission** et engage un **général** fictif, payé chaque jour, qui les commande avec
l'IA militaire du moteur. Tout vit dans `GameState` (`state.mods.cmd`), tous les chiffres dans
`data/balance/default.json` → `command` (schéma `CommandBalanceSchema`, `packages/shared/src/command.ts`).

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

## Contrats

Ordres (`COMMAND_ORDERS`) : `armyCreate` (atomique : piles + embauche + mission), `armyEdit`, `armyMission`,
`armySuspend`, `armyDissolve`, `armyAnswer`, `generalHire`, `generalAssign`, `generalDismiss`. Vue :
`PlayerView.command` (section `command`), uniquement les armées, généraux et candidats du joueur.

## Interface (`apps/client`)

`windows/CommandCenter.tsx` (liste, détail, indicateurs), `CommandWizard.tsx` (composer → mission avec cible
désignée sur la carte → général), `CommandGenerals.tsx` (cartes de général), `map/commandLayer.ts` (étiquette,
zone et flèches d'offensive), `shell/CommandPick.tsx` (désignation sur la carte, lien depuis la sélection).
Logique pure testée dans `lib/command.ts`.

## Coût de calcul

Banc `packages/engine/bench/command.ts` (données réelles, France contre Belgique, armée de piles terrestres) :
`CMD_SEEDS=1,2 CMD_AGGR=cautious,bold node --expose-gc bench/run.mjs command` (dans `packages/engine`) ; mesure de référence : 726 ms par jour de jeu
avec l'armée contre 620 ms sans (≈ +17 % sur ce scénario, monde entier simulé).
