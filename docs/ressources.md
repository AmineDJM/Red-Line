# Ressources des provinces et plancher national

Pétrole, métaux, électronique, nourriture. Une province a une ressource principale, parfois une secondaire,
ou aucune (« argent seulement » : services, finances, bonus de revenu). Toute nation produit au moins un
minimum de chaque ressource.

## Carte (`tools/map`, reproductible)

`pnpm --filter @redline/tools-map resources` lit et réécrit `data/map/provinces.json` (champs `resources` et
`income`), idempotent, mêmes conventions d'ordre des clés (diff minimal). Étapes (`tools/map/src/resources.ts`) :

1. **Données sourcées** (`resources-data.ts`, EIA, USGS, FAO/USDA, SEMI/OCDE) : bassins, mines, greniers, pôles
   électroniques réels, richesse 1 à 3. Y figurent aussi les petites productions réelles de pays réputés
   « sans » : Niigata (pétrole, Japon), Hishikari (or, Japon), Qassim et Al-Jawf (nourriture, Arabie saoudite),
   Mittelplate et Basse-Saxe (pétrole, Allemagne), phosphates de Nauru, Kirkop (électronique, Malte).
2. **Heuristiques** pour les provinces sans donnée (richesse 1) : capitale, métropole et micro-territoire →
   argent seulement ; désert → rien ; grand Nord → métaux ; ailleurs → nourriture, métaux en second dans les
   reliefs miniers.
3. **Repli national** : une nation dont aucune province n'a de ressource reçoit de la nourriture modeste
   (agriculture, pêche, élevage ; richesse 1, heuristique) dans sa plus grande province, hors capitale si elle
   en a une autre (Andorre, Antigua, Comores, Somaliland Est, Sahara occidental…). Seuls les micro-États de
   moins de 100 km² restent « argent seulement » : Vatican, Monaco, Saint-Marin, Tuvalu.
4. **Rendements** (`income`) : pour chaque nation et chaque ressource, total national conservé et réparti entre
   les seules provinces qui ont la ressource, selon la richesse (plancher par richesse).

Bilan actuel : 2 567 provinces, 428 « argent seulement », 197 nations sur 201 avec au moins une province à
ressource.

## Plancher national de production (moteur)

`data/balance/default.json`, `resources.nationalFloor` (zod optionnel, défauts dans `eco/config.ts`) :

```
plancher[r] = max(minPerDay[r], economyShare × poids économique × production mondiale[r]) × incomeMultiplier
poids économique = Σ income.money des provinces possédées / Σ income.money de la carte
production mondiale[r] = Σ income[r] de la carte
production[r] = max(production des provinces et bâtiments, plancher[r]) × modificateurs
```

Réglages : `economyShare` 0,05 ; `minPerDay` pétrole 1, métaux 1, électronique 1, nourriture 2. C'est la
production domestique minimale (raffinage, recyclage, petits gisements, cultures vivrières) : elle ne remplace
pas un vrai gisement, elle évite qu'un pays soit à zéro. Le poids économique suit les provinces possédées
(conquête). `economyShare: 0` et `minPerDay: {}` désactivent le plancher. Le tableau de bord publie la part
due au plancher (`ResourceFlowView.floor`, « Production nationale minimale » dans Économie > Ressources).

Valeurs de départ (2025, par jour de jeu) :

| Nation          | Pétrole | Métaux | Électronique | Nourriture | Remarque                                          |
| --------------- | ------: | -----: | -----------: | ---------: | ------------------------------------------------- |
| Japon           |      29 |     22 |        1 414 |      1 813 | pétrole et métaux : plancher (avant : 0)          |
| Arabie saoudite |   5 224 |    855 |            7 |         25 | nourriture et électronique : plancher (avant : 0) |
| Allemagne       |      22 |     17 |        2 451 |      1 447 | pétrole et métaux : plancher                      |
| Corée du Sud    |      14 |     10 |          622 |      1 009 | pétrole et métaux : plancher                      |
| Algérie         |   4 094 |  1 642 |            7 |      1 354 | électronique : plancher                           |
| Vatican         |       1 |      1 |            1 |          2 | micro-État « argent seulement » : minimum absolu  |

Avant le plancher, 147 nations ne produisaient pas de pétrole, 139 pas de métaux, 175 pas d'électronique et
48 pas de nourriture ; aujourd'hui aucune.

## Interface

- **Menu Construire** : n'y figure que ce qui est ouvert pour la province (constructible ici, ou déjà présent
  et améliorable). Les bâtiments impossibles (gisement absent, province intérieure, ni pôle électronique ni
  grande ville) ne sont pas grisés mais absents ; une ligne discrète dit pourquoi ; une famille vide
  disparaît (`buildMenuGroups`, `apps/client/src/lib/resources.ts`). Le moteur refuse toujours ces chantiers
  (`resource_required`), l'IA ne les tente pas.
- **Carte** : insigne des ressources (pictogramme de la principale, richesse en 1 à 3 points ambre, secondaire
  plus petite) en ligne devant le nom de la ville, à partir du zoom 5 (palier entier : les propriétés de mise en page sont évaluées au zoom de la tuile) : il suit le placement et les
  collisions de l'étiquette (au-dessus du pion posé sur la ville). Aucune source ni calcul par image : une
  propriété `res` des villes et des images `res|…` dessinées une fois. Interrupteur : Réglages > Affichage
  (groupe de calques `resources`, mémorisé localement).
