# Bilan de l'économie de départ — entretien des armées réelles

Constat de l'équipe IA (banc `packages/engine/bench/ai-eval.ts`) : **94 nations sur 201 démarraient avec un
entretien d'armée (ORBAT 2025) supérieur à leur budget de défense** (Soudan du Sud ×22, Érythrée ×15, Égypte ×8,
Corée du Nord ×6,4, Maroc ×2,3…). Elles finissaient en solde négatif quoi qu'elles fassent : un joueur qui
choisissait le Maroc était ruiné. Dans la réalité, ces pays entretiennent bien ces forces avec leur budget
(matériel ancien peu utilisé, soldes et carburant au niveau de prix local, conscription). Le scénario 1985 était
pire : 25 nations sur 31 en déficit, parce que ses budgets sont en **dollars de 1985** alors que les prix du
catalogue sont en **dollars de 2025**.

## Méthode de mesure

Banc reproductible `packages/engine/bench/eco-eval.ts` (vraie carte, catalogue, recherche, ORBAT, surcharges
d'équilibrage du scénario comme le serveur) :

```bash
cd packages/engine
node bench/run.mjs eco-eval                  # modèle actuel : résumé et nations remarquables
ECOEVAL_RAW=1 node bench/run.mjs eco-eval    # modèle d'avant (prix catalogue seul, budgets non convertis)
ECOEVAL_ALL=1 node bench/run.mjs eco-eval    # une ligne par nation ; ECOEVAL_JSON=1 : JSON
```

Pour chaque nation dotée d'un ORBAT, une heure après la création de la partie (forces posées) :

- **revenu** = revenu journalier total (budget de défense ÷ 365, parts nationale et provinciale) ;
- **entretien** = entretien journalier de toutes ses unités de départ ;
- **marge** = revenu − entretien : ce qui reste chaque jour pour produire, construire, rechercher ;
- **J0 + 7 j** = trésorerie de départ (30 jours de budget) + 7 jours de marge : ce qu'un joueur peut engager
  la première semaine.

## Résumé avant / après

| Indicateur                                     | 2025 avant | 2025 après | 1985 avant | 1985 après |
| ---------------------------------------------- | ---------: | ---------: | ---------: | ---------: |
| Nations dotées d’un ORBAT                      |        201 |        201 |         31 |         31 |
| Entretien > revenu (déficit structurel)        |         94 |          0 |         25 |          0 |
| Entretien > 90 % du revenu                     |        102 |          0 |         25 |          0 |
| Entretien > 75 % du revenu                     |        117 |          0 |         27 |          0 |
| Ratio entretien / revenu : 1er quartile        |       39 % |       24 % |      128 % |       30 % |
| Ratio médian                                   |       91 % |       47 % |      286 % |       47 % |
| Ratio : 3e quartile                            |      187 % |       67 % |      499 % |       68 % |
| Ratio maximal                                  |     2216 % |       70 % |     1836 % |       70 % |
| Trésorerie négative après 7 jours sans dépense |         11 |          0 |          7 |          0 |
| Marge cumulée de toutes les nations (par jour) |     5,8 G$ |     6,8 G$ |    −276 M$ |     5,0 G$ |

### Nations remarquables (2025)

| Nation                | Budget annuel | Entretien/j avant |  Avant | Entretien/j après | Après | Marge/j après | J0 + 7 j après | Coût local | Facteur national |
| --------------------- | ------------: | ----------------: | -----: | ----------------: | ----: | ------------: | -------------: | ---------: | ---------------: |
| Soudan du Sud (ssd)   |        178 M$ |             11 M$ | 2216 % |            341 k$ |  69 % |        151 k$ |          16 M$ |       0,40 |            0,068 |
| Laos (lao)            |         30 M$ |            1,7 M$ | 2047 % |             58 k$ |  69 % |         26 k$ |         2,6 M$ |       0,25 |            0,100 |
| Érythrée (eri)        |        300 M$ |             12 M$ | 1458 % |            575 k$ |  69 % |        258 k$ |          26 M$ |       0,40 |            0,103 |
| Égypte (egy)          |        3,8 G$ |             86 M$ |  815 % |            7,3 M$ |  69 % |        3,2 M$ |         335 M$ |       0,20 |            0,244 |
| Corée du Nord (prk)   |        4,5 G$ |             80 M$ |  640 % |            8,6 M$ |  69 % |        3,9 M$ |         397 M$ |       0,30 |            0,278 |
| Éthiopie (eth)        |        528 M$ |            8,9 M$ |  608 % |            1,0 M$ |  69 % |        446 k$ |          47 M$ |       0,35 |            0,269 |
| Maroc (mar)           |        6,3 G$ |             41 M$ |  231 % |             12 M$ |  69 % |        5,4 M$ |         558 M$ |       0,40 |            0,622 |
| Iran (irn)            |        7,4 G$ |             39 M$ |  191 % |             14 M$ |  69 % |        6,4 M$ |         652 M$ |       0,25 |            0,996 |
| Cuba (cub)            |       1000 M$ |            3,8 M$ |  137 % |            1,7 M$ |  60 % |        1,1 M$ |          90 M$ |       0,35 |            1,000 |
| Pakistan (pak)        |         12 G$ |             44 M$ |  132 % |             17 M$ |  50 % |         17 M$ |         1,1 G$ |       0,25 |            1,000 |
| Nigeria (nga)         |        2,1 G$ |            6,5 M$ |  111 % |            2,2 M$ |  38 % |        3,6 M$ |         198 M$ |       0,25 |            1,000 |
| Viêt Nam (vnm)        |         10 G$ |             31 M$ |  105 % |             13 M$ |  45 % |         16 M$ |         974 M$ |       0,35 |            1,000 |
| Turquie (tur)         |         30 G$ |             73 M$ |   87 % |             37 M$ |  44 % |         47 M$ |         2,8 G$ |       0,40 |            1,000 |
| Corée du Sud (kor)    |         48 G$ |            113 M$ |   84 % |             82 M$ |  60 % |         54 M$ |         4,3 G$ |       0,65 |            1,000 |
| Brésil (bra)          |         24 G$ |             42 M$ |   63 % |             24 M$ |  36 % |         43 M$ |         2,0 G$ |       0,50 |            1,000 |
| Ukraine (ukr)         |         84 G$ |            100 M$ |   43 % |             44 M$ |  19 % |        189 M$ |         8,2 G$ |       0,35 |            1,000 |
| Inde (ind)            |         92 G$ |            101 M$ |   39 % |             42 M$ |  16 % |        217 M$ |         9,1 G$ |       0,27 |            1,000 |
| Japon (jpn)           |         62 G$ |             61 M$ |   35 % |             46 M$ |  26 % |        129 M$ |         6,0 G$ |       0,60 |            1,000 |
| Israël (isr)          |         48 G$ |             37 M$ |   27 % |             37 M$ |  27 % |         99 M$ |         4,7 G$ |       1,00 |            1,000 |
| Arabie saoudite (sau) |         83 G$ |             60 M$ |   26 % |             39 M$ |  17 % |        194 M$ |         8,2 G$ |       0,55 |            1,000 |
| Algérie (dza)         |         25 G$ |             15 M$ |   21 % |            7,1 M$ |  10 % |         63 M$ |         2,5 G$ |       0,30 |            1,000 |
| France (fra)          |         68 G$ |             38 M$ |   20 % |             34 M$ |  18 % |        155 M$ |         6,7 G$ |       0,85 |            1,000 |
| Russie (rus)          |        190 G$ |             91 M$ |   17 % |             53 M$ |  10 % |        472 M$ |          19 G$ |       0,40 |            1,000 |
| Chine (chn)           |        336 G$ |            146 M$ |   15 % |            108 M$ |  11 % |        843 M$ |          33 G$ |       0,60 |            1,000 |
| États-Unis (usa)      |        954 G$ |            358 M$ |   13 % |            364 M$ |  13 % |        2,4 G$ |          96 G$ |       1,00 |            1,000 |
| Royaume-Uni (gbr)     |         89 G$ |             28 M$ |   11 % |             26 M$ |  10 % |        224 M$ |         8,9 G$ |       0,85 |            1,000 |
| Allemagne (deu)       |        114 G$ |             26 M$ |    8 % |             24 M$ |   7 % |        295 M$ |          11 G$ |       0,85 |            1,000 |

## Le modèle corrigé

Les prix réels ne changent pas : `cost.money`, `unitPriceUsd` et `upkeepPerDay` du catalogue restent les
dollars 2025 du cahier des charges. Ce qui change, c'est ce qu'une nation **paie** pour entretenir un élément
(module `packages/engine/src/modules/eco/upkeep.ts`) :

```
entretien/jour = upkeepPerDay (catalogue)
               × facteur de génération          (matériel ancien : moins d'heures de vol, pièces cannibalisées)
               × [(1 − part locale) + part locale × indice de coût du pays]
               × facteur national de départ     (calculé une fois à la création de la partie)
```

| Réglage                    | Où                                     | Valeur                                                                                     | Rôle                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upkeep.generationFactor`  | `data/balance`                         | 0,6 / 0,7 / 0,85 / 1 / 1,1 (génération 1 à 5)                                              | Le matériel ancien coûte moins cher à entretenir que le moderne.                                                                                                                                                                          |
| `upkeep.generationExempt`  | `data/balance`                         | `infantry`                                                                                 | L'infanterie, ce sont surtout des soldes : pas d'effet d'âge.                                                                                                                                                                             |
| `upkeep.localShare`        | `data/balance`                         | infanterie 0,9 ; véhicules 0,6 ; navires 0,5 ; aéronefs 0,4 ; missiles 0,3 ; espace 0,2    | Part payée au niveau de prix local (soldes, carburant, main-d'œuvre) ; le reste (pièces, munitions importées) au prix mondial.                                                                                                            |
| `costIndex`                | ORBAT, par nation                      | États-Unis 1 ; France 0,85 ; Chine 0,6 ; Maroc 0,4 ; Algérie 0,3 ; Inde 0,27 ; Égypte 0,2… | Niveau des prix en parité de pouvoir d'achat (ordre de grandeur Banque mondiale PCI 2021, corrigé des grandes dévaluations 2022-2024, arrondi). Jeu 1985 : niveaux de 1985 (dollar fort), URSS à 1 (budget estimé en équivalent dollars). |
| `upkeep.maxStartShare`     | `data/balance`                         | 0,7                                                                                        | Si l'entretien de l'armée réelle (âge et coût local compris) dépasse 70 % du budget de défense, un **facteur national** ramène toutes les unités de la nation à 70 %.                                                                     |
| `upkeepShare`              | ORBAT, par nation (optionnel)          | —                                                                                          | Plafond propre à une nation (ex. 0,55 pour une armée de métier).                                                                                                                                                                          |
| `upkeep.minStartShare`     | `data/balance`                         | 0 (désactivé)                                                                              | Plancher optionnel : relève l'entretien des armées très petites devant leur budget.                                                                                                                                                       |
| `money.budgetDollarFactor` | `data/balance`, surchargé par scénario | 1 ; **2,97** pour « Guerre froide (1985) »                                                 | Conversion des budgets ORBAT en dollars du catalogue (inflation 1985 → 2025).                                                                                                                                                             |

Tous ces champs sont optionnels (schémas zod avec valeurs par défaut) : un fichier d'équilibrage sans section
`upkeep` ou un ORBAT sans `costIndex` restent valides.

Points de conception :

- **Facteur national figé à la création** (`EcoState.upk`, valeurs ≠ 1 seulement). Il ne dépend que des données
  (ORBAT, catalogue, équilibrage) : il s'applique aussi aux unités produites ou achetées ensuite, et il ne
  bouge pas quand l'armée grossit (produire ajoute toujours de l'entretien).
- **Sauvegardes** : une partie enregistrée avant ce changement n'a pas `upk` ; il est recalculé à l'identique au
  chargement (`rebuild` du module), donc deux reprises du même instantané donnent le même rejeu. Les nouvelles
  parties le calculent dans `init`. Tout est déterministe (aucune E/S, aucun aléa).
- **IA** : rien n'a été modifié dans `src/ai/*` ni `modules/*/ai.ts` ; elles lisent déjà `breakdown()` (revenus −
  entretien). Fonctions pures exposées pour elles : `unitUpkeepPerDay(state, n, sys, count)` (entretien réel d'un
  achat envisagé), `upkeepFactor`, `costIndexOf`, `startUpkeepShare(state, n)`.
- **Interface** : la fenêtre Économie affiche sous l'entretien par catégorie « Entretien ajusté au coût local :
  ×0,62 du prix catalogue (… / jour), indice de coût 0,40 » (`EconomyDetailView.upkeepAdjust`, champ optionnel).
  La fiche d'arme garde le prix catalogue. Le back-office montre la section « Entretien des forces » avec
  libellés et aides, la section « Intelligence artificielle » entièrement libellée, et les champs `costIndex` /
  `upkeepShare` dans l'écran ORBAT.

## Vérifications

- **Aucun déficit structurel** : 0 nation sur 201 (2025) et 0 sur 31 (1985) ; ratio maximal 70 %. Test
  `test/eco-upkeep.test.ts` sur les vraies données des deux scénarios.
- **Les grandes puissances gardent leur avance** : marge/jour 2025 — États-Unis 2,4 G$, Chine 843 M$, Russie
  472 M$, puis Allemagne, Royaume-Uni, Inde ; 1985 — URSS et États-Unis loin devant. Le trio de tête ne bouge
  pas (testé).
- **Première semaine crédible** (testé avec de vrais ordres) : le Maroc dispose de ≈ 560 M$ en J0 + 7 j et peut
  commander 4 F-16 dès le premier jour **ou** une base militaire (500 M$) ; l'Algérie (2,5 G$) et la France
  (6,7 G$) les deux et bien plus. En 1985, l'Algérie (2,8 G$ de budget annuel en dollars 2025) peut commander
  4 Mirage F1 ; la base militaire attend quelques semaines.
- **Entretien ancien < moderne**, coût local, plafond par nation, plancher, déterminisme, sauvegarde et
  migration : tests moteur dédiés (`test/eco-upkeep.test.ts`).
- **Mode illimité** : inchangé (la réserve est regonflée au plafond ; le grand livre ignore la remise à niveau) ;
  `test/unlimited.test.ts` passe.
- **L'IA ne fait plus faillite** — banc `ai-eval` (guerres imposées, 7 jours, niveaux normal et difficile,
  graines 1 et 2), même code d'IA :

| Partie              | IA en solde négatif (avant → après) | Entretien > revenus en fin de partie | Trésorerie minimale (jours de budget) |
| ------------------- | ----------------------------------: | -----------------------------------: | ------------------------------------: |
| normal, graine 1    |                              10 → 0 |                               88 → 0 |                              −141 → 8 |
| normal, graine 2    |                              10 → 0 |                               88 → 0 |                              −141 → 7 |
| difficile, graine 1 |                               7 → 0 |                               83 → 0 |                            −141 → 6,4 |
| difficile, graine 2 |                               9 → 0 |                               85 → 0 |                            −141 → 6,2 |

Les IA plus pauvres qu'au départ après 7 jours passent de ≈ 121 à ≈ 42 (celles qui produisent ou font la
guerre) ; combats et captures restent du même ordre (normal : 75-83 → 80-84 provinces prises ; difficile :
92-124 → 95-151).

## Ce qui reste

- **Pas de plancher par défaut** : les armées riches et peu nombreuses (Allemagne 7 %, Royaume-Uni 10 %,
  États-Unis 13 % du budget en entretien) gardent une très grande marge ; la réalité est plus proche de 50 à 70 %
  (personnel et fonctionnement). `upkeep.minStartShare` (ex. 0,5) le corrige, mais diviserait à peu près par
  deux la production des grandes puissances : décision d'équilibrage à prendre avec Amine.
- **Indices de coût** : ordres de grandeur arrondis, à affiner nation par nation dans l'écran ORBAT
  (`costIndex`) ; ils ne changent le total que des nations sous le plafond.
- **Inventaires ORBAT** : les pays les plus fortement plafonnés (Soudan du Sud ×0,07, Laos ×0,10, Érythrée
  ×0,10) ont probablement des inventaires surestimés (matériel stocké ou hors d'usage compté en service) ;
  corriger les données serait plus juste que le facteur national.
- **Écran de sélection** : il affiche encore le budget ORBAT brut (dollars de 1985 pour le scénario historique) ;
  la fenêtre Économie, elle, affiche le budget converti.

## Annexe A — 2025, toutes les nations (triées par ratio d'avant)

« Avant » / « Après » = entretien ÷ revenu. Budget annuel en dollars du catalogue.

| Nation                                | Budget annuel | Entretien/j avant |  Avant | Entretien/j après | Après | Marge/j après | J0 + 7 j après | Coût local | Facteur national |
| ------------------------------------- | ------------: | ----------------: | -----: | ----------------: | ----: | ------------: | -------------: | ---------: | ---------------: |
| Soudan du Sud (ssd)                   |        178 M$ |             11 M$ | 2216 % |            341 k$ |  69 % |        151 k$ |          16 M$ |       0,40 |            0,068 |
| Laos (lao)                            |         30 M$ |            1,7 M$ | 2047 % |             58 k$ |  69 % |         26 k$ |         2,6 M$ |       0,25 |            0,100 |
| Érythrée (eri)                        |        300 M$ |             12 M$ | 1458 % |            575 k$ |  69 % |        258 k$ |          26 M$ |       0,40 |            0,103 |
| Égypte (egy)                          |        3,8 G$ |             86 M$ |  815 % |            7,3 M$ |  69 % |        3,2 M$ |         335 M$ |       0,20 |            0,244 |
| Saint-Marin (smr)                     |        5,0 M$ |             95 k$ |  645 % |             10 k$ |  65 % |          5 k$ |         447 k$ |       0,90 |            0,111 |
| Corée du Nord (prk)                   |        4,5 G$ |             80 M$ |  640 % |            8,6 M$ |  69 % |        3,9 M$ |         397 M$ |       0,30 |            0,278 |
| Éthiopie (eth)                        |        528 M$ |            8,9 M$ |  608 % |            1,0 M$ |  69 % |        446 k$ |          47 M$ |       0,35 |            0,269 |
| Madagascar (mdg)                      |        120 M$ |            2,0 M$ |  603 % |            230 k$ |  70 % |        101 k$ |          11 M$ |       0,30 |            0,312 |
| Tuvalu (tuv)                          |        2,0 M$ |             35 k$ |  594 % |              4 k$ |  65 % |          2 k$ |         179 k$ |       0,90 |            0,120 |
| Liban (lbn)                           |        828 M$ |             13 M$ |  556 % |            1,6 M$ |  68 % |        743 k$ |          73 M$ |       0,50 |            0,224 |
| Afghanistan (afg)                     |        600 M$ |            9,0 M$ |  541 % |            1,2 M$ |  70 % |        504 k$ |          53 M$ |       0,30 |            0,346 |
| Sierra Leone (sle)                    |         32 M$ |            455 k$ |  507 % |             61 k$ |  68 % |         28 k$ |         2,8 M$ |       0,30 |            0,365 |
| Népal (npl)                           |        428 M$ |            5,7 M$ |  478 % |            821 k$ |  69 % |        365 k$ |          38 M$ |       0,30 |            0,391 |
| Somaliland (sol)                      |         60 M$ |            739 k$ |  432 % |            115 k$ |  67 % |         56 k$ |         5,3 M$ |       0,40 |            0,339 |
| Guinée-Bissau (gnb)                   |         22 M$ |            252 k$ |  410 % |             42 k$ |  69 % |         19 k$ |         1,9 M$ |       0,40 |            0,364 |
| Bhoutan (btn)                         |         40 M$ |            455 k$ |  406 % |             77 k$ |  69 % |         35 k$ |         3,5 M$ |       0,30 |            0,456 |
| Nauru (nru)                           |        3,0 M$ |             35 k$ |  396 % |              6 k$ |  65 % |          3 k$ |         268 k$ |       0,90 |            0,181 |
| Palaos (plw)                          |        3,0 M$ |             35 k$ |  396 % |              6 k$ |  65 % |          3 k$ |         268 k$ |       0,90 |            0,181 |
| Sao Tomé-et-Principe (stp)            |        3,0 M$ |             35 k$ |  396 % |              6 k$ |  65 % |          3 k$ |         268 k$ |       0,50 |            0,299 |
| Bande de Gaza (gaza)                  |        100 M$ |            1,2 M$ |  392 % |            192 k$ |  65 % |        103 k$ |         8,7 M$ |       0,45 |            0,329 |
| Rwanda (rwa)                          |        191 M$ |            2,0 M$ |  377 % |            366 k$ |  69 % |        166 k$ |          17 M$ |       0,30 |            0,490 |
| Djibouti (dji)                        |        120 M$ |            1,2 M$ |  367 % |            230 k$ |  68 % |        106 k$ |          10 M$ |       0,50 |            0,339 |
| Zimbabwe (zwe)                        |        160 M$ |            1,6 M$ |  357 % |            307 k$ |  69 % |        137 k$ |          14 M$ |       0,45 |            0,381 |
| Thaïlande (tha)                       |        6,0 G$ |             58 M$ |  352 % |             11 M$ |  69 % |        5,1 M$ |         527 M$ |       0,40 |            0,415 |
| Togo (tgo)                            |        205 M$ |            1,9 M$ |  333 % |            393 k$ |  69 % |        180 k$ |          18 M$ |       0,40 |            0,447 |
| Syrie (syr)                           |       1000 M$ |            9,2 M$ |  330 % |            1,9 M$ |  69 % |        875 k$ |          88 M$ |       0,30 |            0,557 |
| Vatican (vat)                         |         10 M$ |             95 k$ |  323 % |             19 k$ |  65 % |         10 k$ |         634 k$ |       1,00 |            0,202 |
| Sahara occidental (esh)               |         50 M$ |            450 k$ |  305 % |             96 k$ |  65 % |         51 k$ |         4,5 M$ |       0,40 |            0,466 |
| Salvador (slv)                        |        490 M$ |            4,1 M$ |  301 % |            940 k$ |  69 % |        429 k$ |          43 M$ |       0,50 |            0,415 |
| Jordanie (jor)                        |        2,6 G$ |             21 M$ |  299 % |            4,9 M$ |  69 % |        2,2 M$ |         226 M$ |       0,50 |            0,402 |
| Bosnie-Herzégovine (bih)              |        231 M$ |            1,9 M$ |  297 % |            443 k$ |  69 % |        200 k$ |          20 M$ |       0,45 |            0,460 |
| Liberia (lbr)                         |         44 M$ |            360 k$ |  295 % |             84 k$ |  69 % |         38 k$ |         3,9 M$ |       0,45 |            0,464 |
| Sri Lanka (lka)                       |        1,4 G$ |             11 M$ |  288 % |            2,7 M$ |  69 % |        1,2 M$ |         123 M$ |       0,30 |            0,633 |
| Burundi (bdi)                         |        227 M$ |            1,8 M$ |  288 % |            435 k$ |  69 % |        195 k$ |          20 M$ |       0,30 |            0,649 |
| Centrafrique (caf)                    |         74 M$ |            542 k$ |  266 % |            142 k$ |  69 % |         62 k$ |         6,5 M$ |       0,40 |            0,569 |
| Gambie (gmb)                          |         15 M$ |            105 k$ |  248 % |             29 k$ |  68 % |         14 k$ |         1,3 M$ |       0,35 |            0,660 |
| Vanuatu (vut)                         |        5,0 M$ |             35 k$ |  247 % |             10 k$ |  68 % |          5 k$ |         443 k$ |       0,80 |            0,334 |
| Cambodge (khm)                        |        739 M$ |            4,9 M$ |  239 % |            1,4 M$ |  69 % |        632 k$ |          65 M$ |       0,35 |            0,692 |
| Dominique (dma)                       |        5,0 M$ |             35 k$ |  238 % |             10 k$ |  65 % |          5 k$ |         447 k$ |       0,65 |            0,400 |
| Micronésie (fsm)                      |        5,0 M$ |             35 k$ |  238 % |             10 k$ |  65 % |          5 k$ |         447 k$ |       0,80 |            0,334 |
| Kiribati (kir)                        |        5,0 M$ |             35 k$ |  238 % |             10 k$ |  65 % |          5 k$ |         447 k$ |       0,70 |            0,375 |
| Îles Marshall (mhl)                   |        5,0 M$ |             35 k$ |  238 % |             10 k$ |  65 % |          5 k$ |         447 k$ |       0,80 |            0,334 |
| Maroc (mar)                           |        6,3 G$ |             41 M$ |  231 % |             12 M$ |  69 % |        5,4 M$ |         558 M$ |       0,40 |            0,622 |
| Irak (irq)                            |        6,4 G$ |             39 M$ |  221 % |             12 M$ |  69 % |        5,5 M$ |         568 M$ |       0,45 |            0,610 |
| Nicaragua (nic)                       |        116 M$ |            705 k$ |  219 % |            222 k$ |  69 % |         99 k$ |          10 M$ |       0,40 |            0,684 |
| Venezuela (ven)                       |       1000 M$ |            6,0 M$ |  215 % |            1,9 M$ |  69 % |        869 k$ |          88 M$ |       0,40 |            0,626 |
| Cameroun (cmr)                        |        627 M$ |            3,7 M$ |  211 % |            1,2 M$ |  69 % |        546 k$ |          55 M$ |       0,40 |            0,705 |
| Bénin (ben)                           |        217 M$ |            1,2 M$ |  206 % |            416 k$ |  69 % |        184 k$ |          19 M$ |       0,40 |            0,733 |
| République dominicaine (dom)          |        1,0 G$ |            5,8 M$ |  200 % |            2,0 M$ |  68 % |        922 k$ |          92 M$ |       0,50 |            0,621 |
| Iran (irn)                            |        7,4 G$ |             39 M$ |  191 % |             14 M$ |  69 % |        6,4 M$ |         652 M$ |       0,25 |            0,996 |
| Turkménistan (tkm)                    |        700 M$ |            3,7 M$ |  187 % |            1,3 M$ |  69 % |        614 k$ |          62 M$ |       0,50 |            0,629 |
| RD Congo (cod)                        |        1,2 G$ |            6,3 M$ |  185 % |            2,3 M$ |  69 % |        1,0 M$ |         108 M$ |       0,45 |            0,737 |
| Guatemala (gtm)                       |        633 M$ |            3,1 M$ |  179 % |            1,2 M$ |  69 % |        540 k$ |          56 M$ |       0,50 |            0,704 |
| Soudan (sdn)                          |        1,5 G$ |            7,3 M$ |  176 % |            2,8 M$ |  68 % |        1,3 M$ |         133 M$ |       0,30 |            1,000 |
| Côte d'Ivoire (civ)                   |        759 M$ |            3,6 M$ |  173 % |            1,5 M$ |  69 % |        647 k$ |          67 M$ |       0,45 |            0,793 |
| Angola (ago)                          |        1,5 G$ |            7,0 M$ |  172 % |            2,8 M$ |  69 % |        1,2 M$ |         129 M$ |       0,40 |            0,846 |
| Mongolie (mng)                        |        221 M$ |            1,0 M$ |  167 % |            424 k$ |  70 % |        186 k$ |          19 M$ |       0,35 |            0,980 |
| Kosovo (xkx)                          |        235 M$ |            1,1 M$ |  164 % |            451 k$ |  68 % |        213 k$ |          21 M$ |       0,40 |            0,898 |
| Monaco (mco)                          |         20 M$ |             95 k$ |  161 % |             38 k$ |  65 % |         21 k$ |         1,5 M$ |       1,30 |            0,318 |
| Tunisie (tun)                         |        1,5 G$ |            6,4 M$ |  154 % |            2,5 M$ |  61 % |        1,6 M$ |         133 M$ |       0,30 |            1,000 |
| Sénégal (sen)                         |        567 M$ |            2,2 M$ |  142 % |            1,1 M$ |  69 % |        485 k$ |          50 M$ |       0,45 |            0,938 |
| Somalie (som)                         |        199 M$ |            771 k$ |  140 % |            355 k$ |  64 % |        195 k$ |          18 M$ |       0,40 |            1,000 |
| Macédoine du Nord (mkd)               |        375 M$ |            1,5 M$ |  139 % |            675 k$ |  64 % |        377 k$ |          33 M$ |       0,40 |            1,000 |
| Cuba (cub)                            |       1000 M$ |            3,8 M$ |  137 % |            1,7 M$ |  60 % |        1,1 M$ |          90 M$ |       0,35 |            1,000 |
| Philippines (phl)                     |        6,4 G$ |             24 M$ |  137 % |             11 M$ |  63 % |        6,6 M$ |         570 M$ |       0,38 |            1,000 |
| Niger (ner)                           |        489 M$ |            1,8 M$ |  135 % |            851 k$ |  63 % |        503 k$ |          44 M$ |       0,40 |            1,000 |
| Grèce (grc)                           |        8,4 G$ |             31 M$ |  134 % |             16 M$ |  69 % |        7,3 M$ |         740 M$ |       0,60 |            0,758 |
| Indonésie (idn)                       |         15 G$ |             56 M$ |  134 % |             23 M$ |  56 % |         18 M$ |         1,1 G$ |       0,33 |            1,000 |
| Pakistan (pak)                        |         12 G$ |             44 M$ |  132 % |             17 M$ |  50 % |         17 M$ |         1,1 G$ |       0,25 |            1,000 |
| Malawi (mwi)                          |        163 M$ |            595 k$ |  132 % |            247 k$ |  55 % |        204 k$ |          15 M$ |       0,35 |            1,000 |
| Colombie (col)                        |         15 G$ |             51 M$ |  126 % |             24 M$ |  59 % |         17 M$ |         1,3 G$ |       0,40 |            1,000 |
| Chypre (cyp)                          |        663 M$ |            2,4 M$ |  125 % |            1,3 M$ |  67 % |        619 k$ |          59 M$ |       0,70 |            0,741 |
| Cap-Vert (cpv)                        |         20 M$ |             70 k$ |  123 % |             38 k$ |  67 % |         18 k$ |         1,5 M$ |       0,50 |            0,996 |
| Jamaïque (jam)                        |        287 M$ |            973 k$ |  121 % |            550 k$ |  69 % |        252 k$ |          25 M$ |       0,60 |            0,885 |
| Antigua-et-Barbuda (atg)              |         10 M$ |             35 k$ |  119 % |             19 k$ |  65 % |         10 k$ |         634 k$ |       0,70 |            0,751 |
| Comores (com)                         |         10 M$ |             35 k$ |  119 % |             18 k$ |  60 % |         12 k$ |         644 k$ |       0,45 |            1,000 |
| Grenade (grd)                         |         10 M$ |             35 k$ |  119 % |             19 k$ |  65 % |         10 k$ |         894 k$ |       0,65 |            0,800 |
| Saint-Christophe-et-Niévès (kna)      |         10 M$ |             35 k$ |  119 % |             19 k$ |  65 % |         10 k$ |         634 k$ |       0,70 |            0,751 |
| Sainte-Lucie (lca)                    |         10 M$ |             35 k$ |  119 % |             19 k$ |  65 % |         10 k$ |         634 k$ |       0,65 |            0,800 |
| Tonga (ton)                           |         10 M$ |             35 k$ |  119 % |             19 k$ |  65 % |         10 k$ |         894 k$ |       0,60 |            0,856 |
| Saint-Vincent-et-les-Grenadines (vct) |         10 M$ |             35 k$ |  119 % |             19 k$ |  65 % |         10 k$ |         634 k$ |       0,65 |            0,800 |
| Samoa (wsm)                           |         10 M$ |             35 k$ |  119 % |             19 k$ |  65 % |         10 k$ |         894 k$ |       0,70 |            0,751 |
| Malaisie (mys)                        |        4,9 G$ |             16 M$ |  114 % |            7,6 M$ |  56 % |        6,0 M$ |         448 M$ |       0,40 |            1,000 |
| Nigeria (nga)                         |        2,1 G$ |            6,5 M$ |  111 % |            2,2 M$ |  38 % |        3,6 M$ |         198 M$ |       0,25 |            1,000 |
| Kenya (ken)                           |        1,5 G$ |            4,5 M$ |  110 % |            2,1 M$ |  52 % |        2,0 M$ |         135 M$ |       0,40 |            1,000 |
| Andorre (and)                         |         30 M$ |             95 k$ |  108 % |             58 k$ |  65 % |         31 k$ |         2,7 M$ |       0,90 |            0,666 |
| Honduras (hnd)                        |        580 M$ |            1,7 M$ |  106 % |            940 k$ |  59 % |        666 k$ |          52 M$ |       0,50 |            1,000 |
| Guyana (guy)                          |        248 M$ |            728 k$ |  106 % |            401 k$ |  58 % |        287 k$ |          22 M$ |       0,50 |            1,000 |
| Viêt Nam (vnm)                        |         10 G$ |             31 M$ |  105 % |             13 M$ |  45 % |         16 M$ |         974 M$ |       0,35 |            1,000 |
| Argentine (arg)                       |        3,9 G$ |             11 M$ |  104 % |            5,9 M$ |  55 % |        4,8 M$ |         352 M$ |       0,45 |            1,000 |
| Yémen (yem)                           |        1,5 G$ |            4,3 M$ |  103 % |            1,8 M$ |  43 % |        2,4 M$ |         140 M$ |       0,35 |            1,000 |
| Afrique du Sud (zaf)                  |        3,2 G$ |            9,1 M$ |  102 % |            5,0 M$ |  57 % |        3,9 M$ |         288 M$ |       0,45 |            1,000 |
| Kazakhstan (kaz)                      |        1,3 G$ |            3,7 M$ |  102 % |            2,0 M$ |  55 % |        1,6 M$ |         119 M$ |       0,35 |            1,000 |
| Maurice (mus)                         |         24 M$ |             70 k$ |  102 % |             32 k$ |  47 % |         37 k$ |         2,2 M$ |       0,40 |            1,000 |
| Mexique (mex)                         |         14 G$ |             37 M$ |   97 % |             22 M$ |  58 % |         16 M$ |         1,2 G$ |       0,55 |            1,000 |
| Mauritanie (mrt)                      |        322 M$ |            861 k$ |   97 % |            361 k$ |  41 % |        527 k$ |          30 M$ |       0,35 |            1,000 |
| Tchad (tcd)                           |        649 M$ |            1,7 M$ |   96 % |            794 k$ |  44 % |        993 k$ |          60 M$ |       0,40 |            1,000 |
| Lesotho (lso)                         |         40 M$ |            105 k$ |   94 % |             48 k$ |  43 % |         64 k$ |         3,7 M$ |       0,40 |            1,000 |
| Fidji (fji)                           |         81 M$ |            210 k$ |   92 % |            116 k$ |  51 % |        113 k$ |         7,4 M$ |       0,50 |            1,000 |
| Botswana (bwa)                        |        614 M$ |            1,6 M$ |   92 % |            807 k$ |  48 % |        886 k$ |          57 M$ |       0,45 |            1,000 |
| Géorgie (geo)                         |        658 M$ |            1,7 M$ |   91 % |            768 k$ |  42 % |        1,1 M$ |          62 M$ |       0,35 |            1,000 |
| Trinité-et-Tobago (tto)               |        230 M$ |            600 k$ |   91 % |            384 k$ |  58 % |        277 k$ |          21 M$ |       0,60 |            1,000 |
| Turquie (tur)                         |         30 G$ |             73 M$ |   87 % |             37 M$ |  44 % |         47 M$ |         2,8 G$ |       0,40 |            1,000 |
| Tadjikistan (tjk)                     |        247 M$ |            600 k$ |   87 % |            237 k$ |  34 % |        453 k$ |          23 M$ |       0,30 |            1,000 |
| Congo (cog)                           |        205 M$ |            485 k$ |   86 % |            245 k$ |  43 % |        322 k$ |          19 M$ |       0,45 |            1,000 |
| Suriname (sur)                        |         30 M$ |             70 k$ |   84 % |             32 k$ |  39 % |         51 k$ |         2,8 M$ |       0,40 |            1,000 |
| Corée du Sud (kor)                    |         48 G$ |            113 M$ |   84 % |             82 M$ |  60 % |         54 M$ |         4,3 G$ |       0,65 |            1,000 |
| Bangladesh (bgd)                      |        3,8 G$ |            9,0 M$ |   83 % |            3,5 M$ |  33 % |        7,3 M$ |         366 M$ |       0,30 |            1,000 |
| Zambie (zmb)                          |        406 M$ |            920 k$ |   82 % |            440 k$ |  39 % |        685 k$ |          38 M$ |       0,40 |            1,000 |
| Taïwan (twn)                          |         18 G$ |             41 M$ |   81 % |             27 M$ |  52 % |         25 M$ |         1,4 G$ |       0,50 |            1,000 |
| Liechtenstein (lie)                   |         40 M$ |             95 k$ |   81 % |             77 k$ |  65 % |         41 k$ |         2,9 M$ |       1,30 |            0,636 |
| Ouganda (uga)                         |        1,3 G$ |            2,9 M$ |   80 % |            1,2 M$ |  34 % |        2,4 M$ |         123 M$ |       0,35 |            1,000 |
| Libye (lby)                           |        1,6 G$ |            3,4 M$ |   79 % |            1,5 M$ |  34 % |        2,9 M$ |         149 M$ |       0,35 |            1,000 |
| Bolivie (bol)                         |        688 M$ |            1,5 M$ |   78 % |            703 k$ |  37 % |        1,2 M$ |          64 M$ |       0,40 |            1,000 |
| Moldavie (mda)                        |        113 M$ |            245 k$ |   78 % |            117 k$ |  37 % |        198 k$ |          11 M$ |       0,40 |            1,000 |
| Timor oriental (tls)                  |         48 M$ |            105 k$ |   77 % |             67 k$ |  49 % |         69 k$ |         4,4 M$ |       0,60 |            1,000 |
| Belize (blz)                          |         33 M$ |             70 k$ |   76 % |             45 k$ |  48 % |         48 k$ |         3,0 M$ |       0,60 |            1,000 |
| Équateur (ecu)                        |        2,7 G$ |            5,7 M$ |   75 % |            3,2 M$ |  42 % |        4,4 M$ |         256 M$ |       0,50 |            1,000 |
| Chili (chl)                           |        5,3 G$ |             11 M$ |   74 % |            6,9 M$ |  47 % |        7,9 M$ |         493 M$ |       0,55 |            1,000 |
| Chypre du Nord (cyn)                  |        100 M$ |            210 k$ |   71 % |             97 k$ |  33 % |        198 k$ |         9,6 M$ |       0,40 |            1,000 |
| Brunei (brn)                          |        560 M$ |            1,1 M$ |   71 % |            685 k$ |  43 % |        922 k$ |          52 M$ |       0,50 |            1,000 |
| Eswatini (swz)                        |         93 M$ |            175 k$ |   67 % |             81 k$ |  31 % |        181 k$ |         8,9 M$ |       0,40 |            1,000 |
| Arménie (arm)                         |        1,7 G$ |            3,2 M$ |   66 % |            1,6 M$ |  33 % |        3,2 M$ |         164 M$ |       0,40 |            1,000 |
| Birmanie (mmr)                        |        5,0 G$ |            9,1 M$ |   65 % |            3,3 M$ |  24 % |         11 M$ |         486 M$ |       0,25 |            1,000 |
| Haïti (hti)                           |         39 M$ |             70 k$ |   64 % |             39 k$ |  35 % |         70 k$ |         3,7 M$ |       0,50 |            1,000 |
| Brésil (bra)                          |         24 G$ |             42 M$ |   63 % |             24 M$ |  36 % |         43 M$ |         2,0 G$ |       0,50 |            1,000 |
| Îles Salomon (slb)                    |         20 M$ |             35 k$ |   62 % |             26 k$ |  45 % |         31 k$ |         1,9 M$ |       0,70 |            1,000 |
| Biélorussie (blr)                     |        1,9 G$ |            3,3 M$ |   62 % |            1,8 M$ |  34 % |        3,6 M$ |         184 M$ |       0,35 |            1,000 |
| Ouzbékistan (uzb)                     |        1,8 G$ |            3,1 M$ |   62 % |            1,4 M$ |  29 % |        3,5 M$ |         173 M$ |       0,30 |            1,000 |
| Malte (mlt)                           |        125 M$ |            221 k$ |   60 % |            158 k$ |  43 % |        210 k$ |          11 M$ |       0,65 |            1,000 |
| Papouasie-Nouvelle-Guinée (png)       |        106 M$ |            175 k$ |   60 % |            112 k$ |  38 % |        181 k$ |         9,7 M$ |       0,60 |            1,000 |
| Autorité palestinienne (pse)          |       1000 M$ |            1,8 M$ |   59 % |            884 k$ |  30 % |        2,1 M$ |          97 M$ |       0,45 |            1,000 |
| Bahreïn (bhr)                         |        1,5 G$ |            2,5 M$ |   59 % |            1,6 M$ |  38 % |        2,6 M$ |         139 M$ |       0,55 |            1,000 |
| Pérou (per)                           |        2,6 G$ |            4,2 M$ |   58 % |            2,4 M$ |  34 % |        4,8 M$ |         247 M$ |       0,50 |            1,000 |
| Ghana (gha)                           |        507 M$ |            792 k$ |   56 % |            348 k$ |  25 % |        1,1 M$ |          49 M$ |       0,35 |            1,000 |
| Tanzanie (tza)                        |        1,0 G$ |            1,5 M$ |   53 % |            639 k$ |  23 % |        2,2 M$ |         100 M$ |       0,35 |            1,000 |
| Kirghizistan (kgz)                    |        601 M$ |            883 k$ |   53 % |            367 k$ |  22 % |        1,3 M$ |          58 M$ |       0,30 |            1,000 |
| Uruguay (ury)                         |        2,0 G$ |            2,8 M$ |   52 % |            2,2 M$ |  40 % |        3,2 M$ |         183 M$ |       0,75 |            1,000 |
| Mali (mli)                            |        953 M$ |            1,4 M$ |   52 % |            651 k$ |  25 % |        2,0 M$ |          92 M$ |       0,40 |            1,000 |
| Mozambique (moz)                      |        468 M$ |            650 k$ |   50 % |            300 k$ |  23 % |        994 k$ |          45 M$ |       0,40 |            1,000 |
| Namibie (nam)                         |        411 M$ |            560 k$ |   49 % |            309 k$ |  27 % |        825 k$ |          39 M$ |       0,50 |            1,000 |
| Gabon (gab)                           |        356 M$ |            485 k$ |   49 % |            267 k$ |  27 % |        721 k$ |          34 M$ |       0,50 |            1,000 |
| Paraguay (pry)                        |        421 M$ |            528 k$ |   45 % |            254 k$ |  22 % |        910 k$ |          41 M$ |       0,40 |            1,000 |
| Croatie (hrv)                         |        2,1 G$ |            2,6 M$ |   45 % |            1,7 M$ |  29 % |        4,2 M$ |         202 M$ |       0,55 |            1,000 |
| Albanie (alb)                         |        624 M$ |            764 k$ |   44 % |            395 k$ |  23 % |        1,3 M$ |          61 M$ |       0,45 |            1,000 |
| Ukraine (ukr)                         |         84 G$ |            100 M$ |   43 % |             44 M$ |  19 % |        189 M$ |         8,2 G$ |       0,35 |            1,000 |
| Seychelles (syc)                      |         28 M$ |             35 k$ |   42 % |             22 k$ |  27 % |         60 k$ |         2,7 M$ |       0,60 |            1,000 |
| Maldives (mdv)                        |        120 M$ |            144 k$ |   41 % |             93 k$ |  26 % |        261 k$ |          12 M$ |       0,60 |            1,000 |
| Azerbaïdjan (aze)                     |        4,9 G$ |            5,5 M$ |   40 % |            2,6 M$ |  19 % |         11 M$ |         484 M$ |       0,35 |            1,000 |
| Monténégro (mne)                      |        177 M$ |            196 k$ |   39 % |             99 k$ |  20 % |        401 k$ |          17 M$ |       0,45 |            1,000 |
| Inde (ind)                            |         92 G$ |            101 M$ |   39 % |             42 M$ |  16 % |        217 M$ |         9,1 G$ |       0,27 |            1,000 |
| Lituanie (ltu)                        |        3,0 G$ |            3,1 M$ |   38 % |            1,9 M$ |  23 % |        6,3 M$ |         287 M$ |       0,55 |            1,000 |
| Roumanie (rou)                        |        9,7 G$ |             10 M$ |   38 % |            5,7 M$ |  21 % |         21 M$ |         948 M$ |       0,45 |            1,000 |
| Oman (omn)                            |        6,0 G$ |            6,2 M$ |   38 % |            3,9 M$ |  23 % |         13 M$ |         581 M$ |       0,50 |            1,000 |
| Bahamas (bhs)                         |        100 M$ |            105 k$ |   37 % |             96 k$ |  34 % |        188 k$ |         9,5 M$ |       0,90 |            1,000 |
| Japon (jpn)                           |         62 G$ |             61 M$ |   35 % |             46 M$ |  26 % |        129 M$ |         6,0 G$ |       0,60 |            1,000 |
| Koweït (kwt)                          |        8,1 G$ |            7,6 M$ |   33 % |            5,6 M$ |  24 % |         17 M$ |         785 M$ |       0,60 |            1,000 |
| Bulgarie (bgr)                        |        2,6 G$ |            2,3 M$ |   33 % |            1,3 M$ |  19 % |        5,8 M$ |         254 M$ |       0,45 |            1,000 |
| Guinée équatoriale (gnq)              |        121 M$ |            108 k$ |   32 % |             65 k$ |  19 % |        273 k$ |          12 M$ |       0,50 |            1,000 |
| Irlande (irl)                         |        1,6 G$ |            1,4 M$ |   32 % |            1,3 M$ |  31 % |        3,0 M$ |         148 M$ |       0,95 |            1,000 |
| Estonie (est)                         |        1,6 G$ |            1,4 M$ |   32 % |            1,1 M$ |  24 % |        3,3 M$ |         153 M$ |       0,70 |            1,000 |
| Finlande (fin)                        |        8,1 G$ |            7,1 M$ |   32 % |            6,7 M$ |  30 % |         16 M$ |         774 M$ |       0,95 |            1,000 |
| Guinée (gin)                          |        601 M$ |            522 k$ |   31 % |            240 k$ |  14 % |        1,4 M$ |          59 M$ |       0,40 |            1,000 |
| Lettonie (lva)                        |        1,7 G$ |            1,5 M$ |   31 % |            1,0 M$ |  21 % |        3,8 M$ |         169 M$ |       0,60 |            1,000 |
| Singapour (sgp)                       |         17 G$ |             15 M$ |   30 % |             12 M$ |  24 % |         38 M$ |         1,7 G$ |       0,75 |            1,000 |
| Barbade (brb)                         |         40 M$ |             35 k$ |   30 % |             32 k$ |  27 % |         86 k$ |         3,9 M$ |       0,90 |            1,000 |
| Pologne (pol)                         |         47 G$ |             37 M$ |   28 % |             22 M$ |  17 % |        108 M$ |         4,3 G$ |       0,50 |            1,000 |
| Émirats arabes unis (are)             |         23 G$ |             18 M$ |   28 % |             14 M$ |  22 % |         51 M$ |         2,2 G$ |       0,65 |            1,000 |
| Slovénie (svn)                        |        1,2 G$ |            958 k$ |   28 % |            681 k$ |  20 % |        2,8 M$ |         120 M$ |       0,65 |            1,000 |
| Islande (isl)                         |         90 M$ |             70 k$ |   28 % |             81 k$ |  32 % |        171 k$ |         8,6 M$ |       1,20 |            1,000 |
| Burkina Faso (bfa)                    |        892 M$ |            675 k$ |   27 % |            319 k$ |  13 % |        2,1 M$ |          88 M$ |       0,40 |            1,000 |
| Israël (isr)                          |         48 G$ |             37 M$ |   27 % |             37 M$ |  27 % |         99 M$ |         4,7 G$ |       1,00 |            1,000 |
| Arabie saoudite (sau)                 |         83 G$ |             60 M$ |   26 % |             39 M$ |  17 % |        194 M$ |         8,2 G$ |       0,55 |            1,000 |
| Suisse (che)                          |        7,6 G$ |            5,3 M$ |   25 % |            6,1 M$ |  29 % |         15 M$ |         731 M$ |       1,25 |            1,000 |
| Serbie (srb)                          |        2,8 G$ |            1,9 M$ |   24 % |            1,0 M$ |  13 % |        6,7 M$ |         276 M$ |       0,45 |            1,000 |
| Portugal (prt)                        |        5,9 G$ |            3,7 M$ |   23 % |            2,6 M$ |  16 % |         14 M$ |         578 M$ |       0,60 |            1,000 |
| Slovaquie (svk)                       |        3,1 G$ |            1,9 M$ |   22 % |            1,3 M$ |  15 % |        7,4 M$ |         308 M$ |       0,60 |            1,000 |
| Algérie (dza)                         |         25 G$ |             15 M$ |   21 % |            7,1 M$ |  10 % |         63 M$ |         2,5 G$ |       0,30 |            1,000 |
| Nouvelle-Zélande (nzl)                |        2,9 G$ |            1,7 M$ |   21 % |            1,5 M$ |  19 % |        6,4 M$ |         280 M$ |       0,90 |            1,000 |
| Italie (ita)                          |         48 G$ |             28 M$ |   21 % |             23 M$ |  17 % |        112 M$ |         4,4 G$ |       0,75 |            1,000 |
| Qatar (qat)                           |         14 G$ |            8,0 M$ |   20 % |            6,7 M$ |  17 % |         33 M$ |         1,4 G$ |       0,70 |            1,000 |
| France (fra)                          |         68 G$ |             38 M$ |   20 % |             34 M$ |  18 % |        155 M$ |         6,7 G$ |       0,85 |            1,000 |
| Autriche (aut)                        |        6,4 G$ |            3,5 M$ |   19 % |            3,2 M$ |  18 % |         15 M$ |         624 M$ |       0,90 |            1,000 |
| Espagne (esp)                         |         40 G$ |             21 M$ |   19 % |             16 M$ |  15 % |         95 M$ |         3,7 G$ |       0,70 |            1,000 |
| Hongrie (hun)                         |        5,0 G$ |            2,6 M$ |   19 % |            1,6 M$ |  11 % |         12 M$ |         498 M$ |       0,50 |            1,000 |
| Russie (rus)                          |        190 G$ |             91 M$ |   17 % |             53 M$ |  10 % |        472 M$ |          19 G$ |       0,40 |            1,000 |
| Tchéquie (cze)                        |        7,1 G$ |            3,1 M$ |   16 % |            2,1 M$ |  11 % |         17 M$ |         702 M$ |       0,60 |            1,000 |
| Chine (chn)                           |        336 G$ |            146 M$ |   15 % |            108 M$ |  11 % |        843 M$ |          33 G$ |       0,60 |            1,000 |
| Suède (swe)                           |         16 G$ |            6,6 M$ |   14 % |            6,4 M$ |  14 % |         39 M$ |         1,6 G$ |       0,95 |            1,000 |
| Australie (aus)                       |         35 G$ |             14 M$ |   14 % |             14 M$ |  14 % |         85 M$ |         3,5 G$ |       1,00 |            1,000 |
| États-Unis (usa)                      |        954 G$ |            358 M$ |   13 % |            364 M$ |  13 % |        2,4 G$ |          96 G$ |       1,00 |            1,000 |
| Panama (pan)                          |        800 M$ |            266 k$ |   12 % |            146 k$ |   7 % |        2,1 M$ |          80 M$ |       0,50 |            1,000 |
| Royaume-Uni (gbr)                     |         89 G$ |             28 M$ |   11 % |             26 M$ |  10 % |        224 M$ |         8,9 G$ |       0,85 |            1,000 |
| Canada (can)                          |         37 G$ |             11 M$ |   10 % |            9,7 M$ |   9 % |         95 M$ |         3,7 G$ |       0,85 |            1,000 |
| Norvège (nor)                         |         17 G$ |            4,5 M$ |   10 % |            5,0 M$ |  11 % |         42 M$ |         1,7 G$ |       1,15 |            1,000 |
| Luxembourg (lux)                      |        855 M$ |            225 k$ |    9 % |            244 k$ |  10 % |        2,2 M$ |          86 M$ |       1,10 |            1,000 |
| Allemagne (deu)                       |        114 G$ |             26 M$ |    8 % |             24 M$ |   7 % |        295 M$ |          11 G$ |       0,85 |            1,000 |
| Pays-Bas (nld)                        |         29 G$ |            6,6 M$ |    8 % |            6,3 M$ |   8 % |         75 M$ |         2,9 G$ |       0,90 |            1,000 |
| Danemark (dnk)                        |         15 G$ |            3,3 M$ |    8 % |            3,5 M$ |   8 % |         38 M$ |         1,5 G$ |       1,05 |            1,000 |
| Costa Rica (cri)                      |        500 M$ |            105 k$ |    8 % |             72 k$ |   5 % |        1,3 M$ |          50 M$ |       0,65 |            1,000 |
| Belgique (bel)                        |         15 G$ |            2,9 M$ |    7 % |            2,7 M$ |   7 % |         38 M$ |         1,5 G$ |       0,90 |            1,000 |

## Annexe B — 1985, toutes les nations dotées d'un ORBAT

« Avant » : budgets en dollars de 1985 face aux prix 2025 ; « Après » : budgets convertis (×2,97, colonne
« Budget annuel »). Les autres nations du scénario n'ont pas d'ORBAT (ancien calcul par provinces).

| Nation                | Budget annuel | Entretien/j avant |  Avant | Entretien/j après | Après | Marge/j après | J0 + 7 j après | Coût local | Facteur national |
| --------------------- | ------------: | ----------------: | -----: | ----------------: | ----: | ------------: | -------------: | ---------: | ---------------: |
| Turquie (tur)         |        7,0 G$ |            121 M$ | 1836 % |             13 M$ |  69 % |        6,1 M$ |         620 M$ |       0,35 |            0,262 |
| Pakistan (pak)        |        6,4 G$ |             95 M$ | 1586 % |             12 M$ |  68 % |        5,7 M$ |         563 M$ |       0,30 |            0,339 |
| Viêt Nam (vnm)        |        7,4 G$ |             69 M$ |  986 % |             14 M$ |  69 % |        6,5 M$ |         656 M$ |       0,25 |            0,616 |
| Corée du Sud (kor)    |         15 G$ |            118 M$ |  854 % |             28 M$ |  68 % |         13 M$ |         1,3 G$ |       0,45 |            0,461 |
| Chine (chn)           |         30 G$ |            222 M$ |  783 % |             57 M$ |  68 % |         27 M$ |         2,6 G$ |       0,30 |            0,662 |
| Grèce (grc)           |        5,7 G$ |             37 M$ |  695 % |             11 M$ |  69 % |        4,9 M$ |         505 M$ |       0,45 |            0,572 |
| Égypte (egy)          |         12 G$ |             77 M$ |  660 % |             24 M$ |  69 % |         11 M$ |         1,1 G$ |       0,35 |            0,725 |
| Brésil (bra)          |        8,0 G$ |             37 M$ |  499 % |             15 M$ |  69 % |        7,0 M$ |         705 M$ |       0,40 |            0,847 |
| Corée du Nord (prk)   |         12 G$ |             55 M$ |  493 % |             21 M$ |  65 % |         12 M$ |         1,1 G$ |       0,30 |            1,000 |
| Algérie (dza)         |        2,8 G$ |             12 M$ |  462 % |            5,4 M$ |  70 % |        2,4 M$ |         249 M$ |       0,50 |            0,808 |
| Inde (ind)            |         22 G$ |             82 M$ |  384 % |             29 M$ |  46 % |         34 M$ |         2,1 G$ |       0,25 |            1,000 |
| Pologne (pol)         |        6,4 G$ |             21 M$ |  354 % |            9,2 M$ |  52 % |        8,5 M$ |         582 M$ |       0,35 |            1,000 |
| Israël (isr)          |         12 G$ |             40 M$ |  353 % |             23 M$ |  68 % |         11 M$ |         1,1 G$ |       0,60 |            0,890 |
| Espagne (esp)         |         15 G$ |             47 M$ |  332 % |             26 M$ |  63 % |         16 M$ |         1,0 G$ |       0,50 |            1,000 |
| Syrie (syr)           |         10 G$ |             29 M$ |  296 % |             14 M$ |  47 % |         15 M$ |         964 M$ |       0,40 |            1,000 |
| Argentine (arg)       |        6,0 G$ |             16 M$ |  286 % |            9,3 M$ |  56 % |        7,4 M$ |         546 M$ |       0,50 |            1,000 |
| Cuba (cub)            |        4,5 G$ |             11 M$ |  275 % |            5,4 M$ |  44 % |        7,0 M$ |         415 M$ |       0,40 |            1,000 |
| Afrique du Sud (zaf)  |        6,3 G$ |             16 M$ |  272 % |            8,3 M$ |  47 % |        9,3 M$ |         582 M$ |       0,45 |            1,000 |
| Italie (ita)          |         25 G$ |             60 M$ |  261 % |             39 M$ |  56 % |         30 M$ |         1,9 G$ |       0,60 |            1,000 |
| Libye (lby)           |        4,5 G$ |             10 M$ |  242 % |            5,7 M$ |  46 % |        6,6 M$ |         413 M$ |       0,50 |            1,000 |
| Iran (irn)            |         32 G$ |             68 M$ |  229 % |             32 M$ |  36 % |         56 M$ |         3,0 G$ |       0,40 |            1,000 |
| Allemagne (deu)       |         55 G$ |             89 M$ |  170 % |             62 M$ |  40 % |         94 M$ |         5,2 G$ |       0,65 |            1,000 |
| France (fra)          |         52 G$ |             73 M$ |  150 % |             50 M$ |  35 % |         94 M$ |         4,9 G$ |       0,65 |            1,000 |
| Japon (jpn)           |         39 G$ |             47 M$ |  128 % |             33 M$ |  30 % |         77 M$ |         3,7 G$ |       0,65 |            1,000 |
| Irak (irq)            |         36 G$ |             39 M$ |  116 % |             20 M$ |  20 % |         79 M$ |         3,5 G$ |       0,45 |            1,000 |
| Australie (aus)       |         13 G$ |             10 M$ |   83 % |            7,6 M$ |  21 % |         29 M$ |         1,3 G$ |       0,75 |            1,000 |
| Royaume-Uni (gbr)     |         77 G$ |             58 M$ |   79 % |             39 M$ |  18 % |        177 M$ |         7,6 G$ |       0,60 |            1,000 |
| États-Unis (usa)      |        808 G$ |            481 M$ |   63 % |            455 M$ |  20 % |        1,8 G$ |          79 G$ |       1,00 |            1,000 |
| Canada (can)          |         22 G$ |             10 M$ |   48 % |            8,0 M$ |  13 % |         54 M$ |         2,2 G$ |       0,80 |            1,000 |
| URSS (rus)            |        891 G$ |            364 M$ |   44 % |            326 M$ |  13 % |        2,1 G$ |          88 G$ |       1,00 |            1,000 |
| Arabie saoudite (sau) |         52 G$ |             14 M$ |   28 % |            9,2 M$ |   6 % |        138 M$ |         5,3 G$ |       0,60 |            1,000 |
