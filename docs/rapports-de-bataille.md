# Rapports de bataille : format « après action »

Demande d'Amine : _les rapports de bataille plus réalistes_. Chaque bataille produit désormais un **rapport
après action** (AAR) crédible, construit **uniquement à partir de la simulation** (aucun tirage aléatoire,
aucune donnée inventée), déterministe, et **filtré par le brouillard de guerre** : le camp du lecteur est
exact, le camp adverse n'est connu que par ce que son camp a vu pendant les combats.

## Où ça vit

| Couche                                     | Fichier                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Contrat (champs optionnels, rétrocompatible) | `packages/shared/src/military.ts` : `BattleReport.aar` (`BattleAar`), `BattleReportSummary.domain / mySide / intensity` |
| Réglages                                   | `data/balance/default.json` → `military.report` (schéma `MilitaryBalanceSchema.report`) ; personnels par élément : `military.casualties` |
| Enregistrement pendant les combats         | `packages/engine/src/modules/mil/battles.ts` (état sérialisé `BattleSt.x`)                  |
| Construction du rapport pour un lecteur    | `packages/engine/src/modules/mil/aar.ts` (`reportFor`, `summaryFor`, lecture seule)         |
| Route                                      | `GET /api/games/:id/battle-reports/:rid` (inchangée : `battleReportFor(state, nation, id)`) |
| Fenêtre                                    | `apps/client/src/windows/BattlesWindow.tsx`, `apps/client/src/components/BattleAar.tsx`, `styles/w-battles.css` |
| Banc                                       | `node packages/engine/bench/run.mjs battle-report` (vraie carte : rapport vu par chaque camp) |

Les batailles des parties antérieures (sans `BattleSt.x`) gardent l'ancien rapport (`aar` absent) ; la
fenêtre affiche alors les anciens tableaux.

## Ce que la simulation enregistre (par camp, `BattleSideX`)

À chaque coup au but (crochet `onDamage`), interception, tir de missiles et prise de province :

- **ce que le camp voit** de chaque unité adverse engagée : meilleur niveau d'identification atteint pendant
  la bataille (1 détectée, 2 identifiée, 3 précise), lu sur ses capteurs (`sight`) et ses contacts (`know`) ;
- **pertes adverses confirmées** : éléments détruits par ses propres tirs sur une cible vue ;
- **dégâts infligés** à chaque unité adverse (évaluation des dégâts) et **dégâts reçus** par système ;
- **feux** : éléments × rounds de tir au but par système, missiles tirés, missiles abattus, missiles adverses
  abattus, impacts reçus ;
- **effets** : tirs adverses dégradés par son brouillage, coups portés sans être vu (furtivité), coups
  encaissés en position retranchée (fortification, bunker, ville), tirs portés par des unités mal
  ravitaillées, aéronefs adverses abattus, vétérance et généraux des unités engagées ;
- **matériel saisi** par l'adversaire quand une province tombe (unités réellement créées pour le preneur) ;
- une **courbe des pertes** (tranches de `military.report.bucketMinutes`, 30 min) et le **découpage en
  phases** : chaque tranche est classée d'après les modes de tir (indirect, air-sol, sol direct, naval,
  contre aéronefs), l'initiative (coups portés et pertes infligées) et la phase précédente.

## Le rapport (`BattleAar`)

| Champ               | Contenu                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `place`             | province, ville, propriétaire au début, milieu (`land`, `coast`, `sea`, `air`), combats en zone urbaine                                            |
| `sides[2]`          | attaquant puis défenseur : `own` (camp du lecteur), cote `grade` du renseignement (adversaire), ordre de bataille, totaux, bilan                  |
| `sides[].forces`    | par matériel : engagés, détruits, endommagés, capturés, personnels, munitions (son camp seulement) ; contacts non identifiés groupés par milieu      |
| `sides[].casualties`| tués, blessés, disparus, prisonniers                                                                                                               |
| `sides[]`           | matériels détruits / endommagés / capturés, valeur perdue ($), missiles tirés et abattus, interceptions, sorties aériennes, munitions principales  |
| `phases`            | `preparation`, `strikes`, `assault`, `defense`, `counter`, `air`, `naval`, `retreat`, `capture` — début, fin, camp à l'initiative, pertes          |
| `losses`            | pertes cumulées dans le temps (exactes pour son camp, confirmées pour l'adversaire)                                                                |
| `factors`           | jusqu'à 6 facteurs décisifs : rapport de forces, supériorité aérienne, guerre électronique, furtivité, défense retranchée, défense aérienne, ravitaillement (−), vétérance, commandement, moral (−) — camp, signe, poids, paramètres du libellé |
| `result`            | `verdict` (victoire décisive / avantage / indécis / en cours), provinces prises pendant les combats, province tenue                                  |

Chaque nombre est une **estimation** `{ best, min, max }` : exacte (`min = max`) pour son camp, fourchette
pour l'adversaire. Les libellés sont traduits côté client (`battles.aar.*` de `fr.json`) : le moteur
n'envoie que des genres et des paramètres.

### Chiffres « réels » dérivés de la simulation

- **Personnels** = éléments × personnels par élément (`military.casualties` : bataillon d'infanterie 600,
  char 4, VCI 8, navire de surface 250, sous-marin 100, chasseur 1…).
- **Pertes humaines** : personnels des éléments détruits répartis par milieu (`military.report.killedShare`,
  `woundedShare` : terre 25 % tués / 55 % blessés / reste disparus ; air 35 / 30 ; mer 30 / 45), plus les
  blessés des éléments endommagés (`damagedWoundedShare`). Quand le camp perd la province des combats, une
  part des disparus devient prisonniers (`prisonerShare`).
- **Endommagés** : dégâts reçus au-delà des éléments détruits, par tranche de `damagedHpShare` des points
  de vie d'un élément.
- **Munitions principales** : éléments × rounds de tir × `munitionsPerRound` de la catégorie (obus,
  roquettes, missiles, bombes).

## Brouillard de guerre (rien de caché n'est divulgué)

- Une unité adverse **jamais détectée** par le camp du lecteur n'apparaît **nulle part** : ni dans l'ordre de
  bataille, ni dans le résumé de la vue, ni dans le replay (positions), ni dans la chronologie ; ses tirs
  sont montrés depuis leur point d'impact (la position du tireur reste inconnue).
- Un contact **détecté non identifié** apparaît comme « contact terrestre / aérien / naval non identifié »,
  effectifs et personnels en large fourchette (`spreadDetected`) ; un matériel **identifié** est nommé,
  effectifs à ± `spreadIdentified` ; **précis** : exact.
- Les pertes adverses sont celles que ses propres tirs ont **confirmées** (fourchette haute `killSpread` pour
  les coups non observés) ; les entrées de chronologie qui nomment une unité adverse non identifiée sont
  retirées.
- Facteurs : vétérance, généraux et ravitaillement de l'adversaire ne sont jamais cités ; seuls les effets
  observables (brouillage subi, furtivité, retranchement, interceptions, supériorité aérienne) le sont.
- **Cote du renseignement** (code de l'Amirauté) : source A (≥ 50 % des contacts précis), B (≥ 50 %
  identifiés), C, D (détectés seulement), E (aucun contact, seulement des coups reçus), F ; crédibilité 1
  (≥ 80 % précis) à 6 (rien). Elle ne dépend que de ce que le camp a vu (pas du nombre réel d'unités
  adverses).
- Les co-belligérants d'un même camp partagent ce qu'ils ont vu pendant la bataille.

## Déterminisme et coût

Le rapport est une **lecture** (aucune écriture dans l'état : même empreinte avant et après) ; il est
identique après une reprise d'instantané en pleine bataille (test `battle-aar.test.ts`). L'enregistrement
pendant les combats est borné : 32 points de courbe, 10 phases, des compteurs par unité engagée.
