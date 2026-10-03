# Gouvernement

Fenêtre « Gouvernement » (raccourci **H**, bouton « bâtiment » de la barre du haut et de la barre latérale) : le
joueur nomme des **titulaires** fictifs, payés chaque jour, à la tête des postes de deux ministères, et leur
confie des **missions** exécutées automatiquement avec les ressources disponibles, dans une **enveloppe** de
budget. Tout vit dans `GameState` (`state.mods.gov`), tous les chiffres dans `data/balance/default.json` →
`government` (schéma `GovernmentBalanceSchema`, `packages/shared/src/government.ts`). Le joueur garde la main :
ses ordres manuels restent possibles et prioritaires, chaque mission peut être modifiée, suspendue ou retirée.

## Modèle

- **Ministères** : Défense et Économie (décision d'Amine : pas d'autre ministère ; les Affaires étrangères
  restent une compétence directe du joueur). Le cadre est générique : un poste et des missions se déclarent
  dans les données (`government.offices`, `government.missions`), le moteur ne connaît que des exécutants.
- **Postes** (`offices`) : ministre de la Défense (infrastructures et logistique), direction de la recherche
  d'armement, direction de la production d'armement, renseignement intérieur, renseignement extérieur et
  militaire, ministre de l'Économie. La vue Défense a quatre sections : commandements (Terre, Air, Marine,
  DCA, lus dans `view.command.commands` si le centre de commandement les expose, sinon emplacement « en
  préparation »), infrastructures, armement, renseignement.
- **Titulaires** : vivier déterministe de 4 candidats par poste (graine, nation, poste, rang), renouvelé tous
  les 10 jours, noms fictifs tirés des listes culturelles du jeu. Six compétences 0-100 (gestion, industrie,
  logistique, prudence budgétaire, science, renseignement) ; chaque poste en retient trois : gestion,
  expertise, prudence. 0 ou 1 trait (`efficient`, `frugal`, `ambitious`, `cautious`, `technocrat`, `reformer`,
  `bureaucrat`). Coût journalier = coût du poste × (0,6 + 0,8 × note / 100) × traits × indice de coût local
  (ministre 60 k$/j, directeur 20 à 25 k$/j aux prix américains) ; prime de nomination 2 jours, indemnité 5 jours,
  démission après 3 jours impayés. Ligne « Ministres et directions » (`government`) du grand livre.
- **Effets** (modestes, `government.effects`) : gestion → vitesse jusqu'à +10 % (chantiers, commandes,
  recherches accélérés d'autant) et une action simultanée de plus à partir de 70 ; expertise → rabais négocié
  jusqu'à 6 % (rendu à la trésorerie, inscrit au poste de la dépense) et qualité des choix (choix parmi les
  k meilleurs, k = 1 + ⌊(100 − expertise) / 30⌋, tirage du PRNG du module) ; prudence → réserve de trésorerie
  que ses missions laissent en caisse (10 j de budget × (0,5 + prudence / 100)).
- **Missions** : type des données, priorité (basse, normale, haute : ordre d'examen), objectif chiffré,
  enveloppe (`amount` : montant total ; `share` : part des revenus créditée chaque jour, plafond facultatif),
  cible (ressource, domaine de recherche, catégorie de matériel, nation) et zone facultative (frontière avec
  un pays, rayon autour d'une province). Statuts : en cours, en attente, bloquée (raison expliquée), suspendue,
  terminée. Une mission ne dépense jamais plus que son enveloppe ni ne fait passer la trésorerie sous le
  plancher (prudence du titulaire, mission « Réserves »).

| Poste                   | Missions (exécutant)                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Défense                 | bases aériennes, bases militaires (`build`, nouveaux sites d'abord), modernisation des bases (`upgrade`), logistique militaire et fortification des frontières (`build`, provinces frontalières), défense antiaérienne et défense côtière (`build`, provinces de valeur) |
| Recherche               | prochaine génération d'une catégorie (`research` : portes manquantes et prérequis), recherche par domaine, laboratoires (`invest`)                                                                                                                                       |
| Production              | commande de matériel (`produce` : fabrication locale d'abord, puis le matériel déjà en service dans les forces), stocks stratégiques (`stock`, continu), industrie d'armement (`invest`)                                                                                 |
| Renseignement intérieur | contre-espionnage (priorité `counterintel`, balayages, démantèlement), protection des sites sensibles (`protectSite`, puis durcissement)                                                                                                                                 |
| Renseignement extérieur | surveillance d'un pays, cartographie des défenses, renseignement économique (`intel` : opérations en rotation)                                                                                                                                                           |
| Économie                | production de ressources (`extract` : gisements seulement), développement industriel, hausse des revenus, économie de guerre (`invest`), réserves (`reserve`), reconstruction (`repair`)                                                                                 |

## Exécution

Toutes les `time.aiThinkMinutes`, chaque nation examine ses missions par priorité (`gov/missions.ts`). Les
exécutants (`gov/exec.ts`) **réutilisent la logique de l'IA économique** (`eco/ai.ts`, désormais paramétrable :
`investCandidates`, `productionOptions`, `researchPick`, `repairCandidates`) et celle du renseignement, puis
agissent **uniquement par les ordres de jeu existants** (`aiOrder` : `build`, `repair`, `research`, `produce`,
`intelOp`, `interiorFocus`, `protectSite`), validés comme ceux du joueur (ressources, côte, gisement,
niveau maximal, file, capacité du service). Les ordres naissent d'événements du module : ils sont recalculés au
rejeu (instantané + journal d'ordres du joueur), comme ceux des généraux. Chaque action en cours est suivie
jusqu'à son aboutissement (chantier terminé, lot livré, nœud acquis, opération achevée). Le journal du poste
explique ce qui est fait (« Chantier lancé : Champ pétrolier niveau 4 à Adrar — 164 M$ ») et ce qui bloque
(« Enveloppe épuisée », « Aucun gisement de pétrole sur le territoire », « Réserve de prudence… ») ; clés
`engine.gov.*` traduites par le client. Une mission bloquée n'est réexaminée qu'au prochain crédit journalier
(enveloppe), 2 h plus tard (argent, file) ou 6 h plus tard (aucun emplacement, aucune cible), sauf modification,
reprise, nomination ou action aboutie.

## Contrats

Ordres (`GOVERNMENT_ORDERS`) : `govAppoint`, `govDismiss`, `govMission`, `govMissionEdit`, `govMissionSuspend`,
`govMissionCancel`. Vue : `PlayerView.government` (section `government`), uniquement les postes, titulaires,
candidats et missions du joueur. Notifications `engine.note.gov_*` (démission, mission accomplie).

## Interface (`apps/client`)

`windows/GovernmentWindow.tsx` (ministères, sections, postes, cartes de titulaire, missions, journal),
`windows/GovernmentWizard.tsx` (assistant en trois étapes : mission, cible et objectif, enveloppe avec
prévisions), `windows/government.css`. Logique pure testée dans `lib/government.ts` (estimation des coûts d'après
les provinces du joueur, couverture de l'enveloppe, lecture des commandements). Textes : `i18n/fr.gov.json`
(interface) et `fr.engine.json` (`engine.gov.*`), traduits dans les 14 langues.

## Tests et coût de calcul

`packages/engine/test/gov-real.test.ts` (vraies données) ; `apps/client/test/government.test.ts` ;
`e2e/government.spec.ts` (ordinateur et mobile). Banc `packages/engine/bench/gov.ts` :
`node --expose-gc bench/run.mjs gov` (dans `packages/engine`). Mesure (France, Algérie, Allemagne, Inde, six
titulaires et onze missions chacune, 4 jours) : 193 ms par jour de jeu sans mission, 197 ms avec ; une
réflexion complète coûte 0,35 ms par nation (toutes missions réexaminées).
