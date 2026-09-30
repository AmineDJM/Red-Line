# ORBAT — budgets et arsenaux réels estimés

Ce document décrit les ordres de bataille (ORBAT) livrés dans `data/orbat/` : budget de défense, effectifs,
inventaire en service, niveau technologique (portes de recherche), licences et textes de l'écran de sélection de
chaque nation. Exigence d'Amine : chaque nation démarre avec son **budget de défense actuel** et son **arsenal
actuel estimé**, mais ne peut produire que ce que son industrie maîtrise réellement (posséder ≠ savoir produire).

## Contenu

| Jeu                | Fichiers                          | Nations | Usage                                      |
| ------------------ | --------------------------------- | ------: | ------------------------------------------ |
| `data/orbat/2025/` | `<nationId>.json` (`OrbatSchema`) |     201 | scénario contemporain (toutes les nations) |
| `data/orbat/1985/` | `<nationId>.json` (`OrbatSchema`) |      31 | scénario Guerre froide (nations majeures)  |

Chaque fichier contient : `defenseBudgetUsd` (dollars US courants), `activePersonnel`, `doctrine`, `inventory`
(identifiants **exacts** de `data/catalog-ids.json`, avec le modèle réel dans `variant` et les précisions dans
`note`), `research` (nœuds de `data/research`), `licences` (identifiants de systèmes), `sources`, `confidence`,
`description` et `doctrineText` (écran de sélection, 2025 uniquement).

Les fichiers JSON sont la **source de vérité** : ils se modifient à la main ou par le back-office
(`/admin/api/orbat/:set/:nationId`), puis se valident avec :

```bash
pnpm --filter @redline/tools-orbat validate            # tous les jeux
pnpm --filter @redline/tools-orbat validate -- --set 2025 --nations   # détail par nation
```

## Sources

- **Budgets** : SIPRI Military Expenditure Database, édition 2026 (dépenses **2025** en dollars courants), soit la
  donnée la plus récente disponible au 30 septembre 2026 ; à défaut 2024 ou 2023. Estimations documentées pour les
  pays sans donnée SIPRI (Émirats arabes unis et Qatar : IISS ; Corée du Nord : WMEAT ; Venezuela, Cuba,
  Ouzbékistan, Turkménistan, Érythrée, Djibouti, Soudan, Syrie, Laos, entités non étatiques, micro-États).
  L'Égypte reçoit en plus l'aide militaire américaine (FMF, 1,3 Md$/an), non comptée par le SIPRI.
- **Effectifs et ordres de grandeur** : IISS, _The Military Balance 2025_.
- **Inventaires** : listes d'équipements et d'aéronefs en service de Wikipedia (en), consultées en
  septembre 2026, recoupées avec l'IISS ; Oryx pour les pertes en Ukraine ; CSIS Missile Threat pour les arsenaux
  balistiques ; rapports du DoD sur la Chine.
- **Nucléaire** : FAS, _Status of World Nuclear Forces 2025_ (vecteurs déployés).
- **Événements 2025-2026 pris en compte** (Wikipedia, état au 30 septembre 2026) : guerre russo-ukrainienne en
  cours ; affrontement indo-pakistanais de mai 2025 ; guerre des Douze Jours (juin 2025) puis **guerre d'Iran de
  2026** (frappes américano-israéliennes depuis le 28 février 2026 : aviation, marine et défense aérienne
  iraniennes fortement réduites, ≈ 70 % des lanceurs balistiques conservés ; stocks américains de Tomahawk,
  ATACMS, PrSM et intercepteurs fortement entamés, ≈ 25 % des MQ-9 perdus) ; chute du régime Assad
  (décembre 2024) et destruction de l'essentiel du matériel syrien ; capture de Nicolás Maduro (janvier 2026) ;
  guerre civile au Soudan ; offensive houthie sur Bab el-Mandeb (septembre 2026) ; cessez-le-feu à Gaza
  (octobre 2025).
- **1985** : IISS, _The Military Balance 1985-1986_ ; SIPRI (dépenses 1985) ; estimations CIA (URSS) et ACDA
  (Chine, Irak, Libye, Cuba, Viêt Nam, Corée du Nord).

## Méthode et conventions

### Inventaire « en service »

On compte le matériel **en service actif estimé aujourd'hui** : les stocks en réserve (chars américains ou russes
entreposés, par exemple) sont exclus et signalés dans `note`. Les commandes non livrées ne sont pas comptées
(elles sont citées en note). Les pertes de guerre documentées sont déduites.

### Unités de compte (1 élément =)

Conventions de l'orchestrateur, alignées sur `unitLabel` du catalogue :

| Famille                                                                                   | 1 élément                                           |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Défense aérienne moyenne et longue portée (Patriot, S-300/400/500, SAMP/T, HQ-9, NASAMS…) | 1 batterie (russe : 1 division)                     |
| Défense aérienne courte portée véhiculée (Tor, Pantsir, Osa, Gepard, Avenger…)            | 1 véhicule                                          |
| Missiles portables (Stinger, Igla, Mistral et équivalents)                                | 1 section (≈ 4 postes de tir)                       |
| Infanterie                                                                                | 1 bataillon (≈ 600 personnes)                       |
| Missiles de frappe et vecteurs nucléaires                                                 | 1 missile (`unitLabel` « missile »)                 |
| Tout le reste                                                                             | 1 appareil, char, navire, lanceur, satellite, radar |

Les défenses aériennes ont été relevées en lanceurs puis converties (note « ≈ N lanceurs, soit M batteries ») avec
les ratios suivants : Patriot 6, THAAD 6, NASAMS 4, Hawk 6, S-300/S-400/S-500 8, Buk 6, Kub 4, S-75 6, S-125 4,
HQ-9 8, HQ-16 4, SAMP/T 4, IRIS-T SLM 3, Iron Dome 4, David's Sling 4, Arrow 4, Bavar-373 4, Akash 6 ; les batteries
connues directement sont saisies telles quelles (États-Unis : 60 batteries Patriot, 8 THAAD ; Japon : 24 Patriot).

### Infanterie

Les effectifs des **forces terrestres** (armée de terre, plus forces aéroportées et spéciales rattachées) sont
convertis en bataillons de 600 et répartis entre les types de la doctrine : `infantry-light` (reste),
`infantry-mech` (part mécanisée/motorisée), `airborne`, `special-forces` ; l'infanterie de marine vient des
effectifs de la marine (`marines`, `ru.naval-infantry`). La répartition est indiquée dans `note`. Les paramilitaires
(gardes nationales, milices, gendarmeries) ne sont pas comptés. Gaza et l'Autorité palestinienne n'ont que de
l'infanterie légère générique, sans aucun matériel lourd. Les micro-États sans armée reçoivent 1 bataillon
symbolique représentant leur police ou leur garde.

### Budget

`defenseBudgetUsd` = dépense militaire annuelle la plus récente en dollars courants (SIPRI 2025). La somme
mondiale obtenue est de **2 919 Md$**, contre 2 887 Md$ pour le total mondial SIPRI 2025 (l'écart vient des
estimations pour les pays sans donnée) ; le total 2024 était de 2 718 Md$. Le script de validation signale une somme
hors de 2 400 à 3 000 Md$.

### Regroupement des variantes

Chaque matériel réel est rattaché au système du catalogue le plus proche ; le nom réel est conservé dans `variant`
et la note « modèle le plus proche » signale les rattachements approximatifs. Principaux regroupements :

| Matériel réel                                                    | Système du catalogue     |
| ---------------------------------------------------------------- | ------------------------ |
| Su-30MKI/MKA/MKK/SM/MK2                                          | `ru.su-30`               |
| T-90S/SA/SK, T-90A                                               | `ru.t-90m`               |
| T-64 (Ukraine, Ouzbékistan), M-84, Pokpung-ho                    | `ru.t-72`                |
| T-80U/UD/BV, Oplot                                               | `ru.t-80bvm`             |
| Mirage 2000-5/9/D/H/P/EG                                         | `eu.mirage-2000`         |
| Mirage III/5, Kfir                                               | `eu.mirage-5`            |
| F-15C/D/J/S/SA/SG/QA/K                                           | `us.f-15e`               |
| F/A-18A-D Hornet (CF-18, EF-18)                                  | `us.fa-18e`              |
| F-2 (Japon), F-CK-1 (Taïwan)                                     | `us.f-16`                |
| Jaguar, AMX, F-111 (1985)                                        | `eu.tornado`             |
| JH-7, Il-28/H-5                                                  | `ru.su-24`               |
| M-346, L-15, JL-10                                               | `ru.yak-130`             |
| Leopard 2A4/A5/A6 et dérivés (Strv 122, 2E, 2SG…)                | `eu.leopard-2a7`         |
| K1/K1A1, Type 10                                                 | `other.k2-black-panther` |
| CV90, Warrior, Ajax, ASCOD, Hunter                               | `eu.cv90`                |
| Marder, Lynx, VCTP                                               | `eu.puma`                |
| Piranha, Pandur, Rosomak, XA-180                                 | `eu.patria-amv`          |
| LAV/LAV III/LAV 6.0, Terrex, Pars, Type 16/96                    | `us.stryker`             |
| Fuchs, Guarani, Anoa, Casspir                                    | `eu.vab`                 |
| Krab, T-155 Fırtına, K9 dérivés                                  | `other.k9-thunder`       |
| Obusiers remorqués (hors M777) de toutes origines                | `ru.d-30`                |
| Obusiers sur camion (ATMOS, Dana, Zuzana, Nora, G6, Bohdana)     | `eu.caesar`              |
| ASTROS, RT-2000, T-300 Kasırga                                   | `us.m270-mlrs`           |
| Barak 8 / Barak MX / MRSAM                                       | `other.davids-sling`     |
| SPYDER, KM-SAM, Type 03 Chu-SAM                                  | `us.nasams`              |
| CAMM (Sky Sabre, Narew), Hisar                                   | `eu.iris-t-slm`          |
| RBS 70, Starstreak, Piorun, QW                                   | `eu.mistral` / `ru.igla` |
| MV-22/CV-22 Osprey, CH-53                                        | `us.ch-47-chinook`       |
| Dhruv, Oryx, W-3 Sokół, IAR-330                                  | `eu.sa-330-puma`         |
| AW159 Wildcat, AW149, Super Lynx                                 | `eu.nh90`                |
| AW129 Mangusta, LCH Prachand, LAH                                | `other.t129-atak`        |
| Frégates génériques anciennes (FFG-7, MEKO, Lupo, Halifax…)      | `eu.meko-a-200`          |
| Corvettes, patrouilleurs hauturiers, La Fayette                  | `eu.gowind`              |
| Frégates Talwar, Grigorovich, Shivalik                           | `ru.admiral-gorshkov`    |
| Vedettes lance-missiles chinoises et asiatiques                  | `cn.type-022`            |
| Sous-marins Collins, Taigei, Oyashio                             | `other.soryu`            |
| SSN Los Angeles (2025)                                           | `us.virginia`            |
| P-3, P-1, Atlantique 2, CP-140                                   | `us.p-8-poseidon`        |
| Radars de surveillance occidentaux (AN/FPS-117, AN/TPS-77, HADR) | `us.an-tps-75`           |
| Radars de surveillance soviétiques anciens (P-19, P-37, 36D6)    | `ru.p-18`                |
| RAT-31, GM403, Master-T                                          | `eu.ground-master-400`   |
| JORN (transhorizon australien)                                   | `ru.container-29b6`      |

### Doctrine

Le champ `doctrine` indique le **catalogue d'origine dominant de l'arsenal actuel et de ses achats récents**
(fournisseur principal), et non le simple décompte d'éléments : l'artillerie et les blindés anciens rattachés à des
modèles russes gonfleraient artificiellement la part `ru` de nombreux pays. Exemples : Pologne `us`, Ukraine `eu`,
Pakistan `cn`, Inde `ru`, Israël `us`, Iran `other`. Il détermine aussi le type d'infanterie.

### Portes de recherche et licences

`research` liste les portes du brief que la nation **sait produire ou entretenir en profondeur** aujourd'hui, par
échelons cumulés (qui maîtrise `gen4plus` maîtrise `gen4`, `gen3`…), puis **fermées par prérequis** selon
`data/research` (par exemple `aero.gen5` implique `aero.stealth-materials` et `sensors.radar3`). Les États-Unis
maîtrisent les 116 nœuds. Seuls les États-Unis, la Russie et la Chine ont `aero.gen5` : l'Algérie possède des Su-57
mais n'a que `aero.gen4plus` ; le Japon et l'Italie assemblent le F-35 sous **licence** (`licences`), sans la porte
`gen5`. Les armes nucléaires (`nuclear.weapons`) sont réservées aux neuf puissances dotées ; l'Afrique du Sud
(programme de 1985) l'a dans le jeu 1985.

Les licences sont des identifiants de systèmes (ex. Inde : `ru.su-30`, `ru.t-90m`, `eu.scorpene`,
`other.brahmos` ; Pologne : `other.k2-black-panther`, `other.k9-thunder`, `other.k239-chunmoo` ; Russie :
`other.shahed-136` produit sous le nom de Geran-2).

### Radars, satellites, nucléaire, missiles

- **Radars** (catégorie `radar`) : ajoutés quand ils sont documentés ; les radars de même origine et fonction sont
  rattachés au modèle le plus proche. Les radars américains installés à l'étranger (AN/TPY-2 au Japon, en Turquie,
  en Israël, en Corée) sont comptés aux États-Unis.
- **Satellites** : satellites militaires ou à usage militaire documenté, estimations publiques.
- **Nucléaire** : vecteurs déployés (missiles et bombes) selon la FAS.
- **Missiles de frappe** : stocks estimés de missiles (et non de lanceurs, cités en note).

## Jeu 1985

31 nations : États-Unis, URSS (`rus`), Chine, France, Royaume-Uni, RFA (`deu`), Italie, Espagne, Grèce, Pologne,
Turquie, Inde, Pakistan, Israël, Iran, Irak, Syrie, Égypte, Arabie saoudite, Libye, Algérie, Afrique du Sud, Japon,
Corée du Sud, Corée du Nord, Viêt Nam, Cuba, Brésil, Argentine, Canada, Australie.

- **Seuls des systèmes d'époque** (`era.introduced ≤ 1985`) sont utilisés : le scénario filtre le catalogue par
  époque, un système postérieur serait inutilisable. Les portes de recherche respectent `eraYear ≤ 1985`
  (pas de cyber, pas de `gen4plus`, `sam4`, `cruise2`, `radar3`…).
- Le catalogue ne contient pas de frégates, destroyers d'escorte, SSN, avions de patrouille maritime ni obusiers
  remorqués occidentaux d'époque : les escorteurs sont rattachés à `ru.udaloy` (ou `us.ticonderoga` pour les
  croiseurs), les SSN à des sous-marins d'attaque (`eu.type-209`, `ru.kilo`), les porte-avions et porte-aéronefs à
  `us.nimitz`, les SLBM soviétiques, français et britanniques à `us.trident-ii-d5`, les obusiers remorqués à
  `ru.d-30`. Chaque cas est signalé par « modèle le plus proche ». Les avions de patrouille maritime sont omis.
  **Recommandation à l'équipe catalogue** : ajouter quelques systèmes génériques d'époque (frégate, SSN, patrouille
  maritime, obusier remorqué occidental) améliorerait nettement le scénario 1985.

| Nation          | Budget 1985 | Effectifs |
| --------------- | ----------: | --------: |
| URSS            |     300 Md$ | 5 300 000 |
| États-Unis      |   272,2 Md$ | 2 151 600 |
| Royaume-Uni     |      26 Md$ |   327 100 |
| RFA             |    18,7 Md$ |   478 000 |
| Arabie saoudite |    17,7 Md$ |    62 500 |
| France          |    17,5 Md$ |   464 300 |
| Japon           |    13,1 Md$ |   243 000 |
| Irak            |      12 Md$ |   520 000 |
| Iran            |    10,7 Md$ |   555 000 |
| Chine           |      10 Md$ | 4 100 000 |
| (21 autres)     |   < 8,5 Md$ |           |

Somme des 31 nations : 773 Md$ (dollars de 1985).

## Récapitulatif des 40 premiers budgets (2025)

Éléments selon les unités de compte ci-dessus (défense aérienne en batteries). « Navires » = navires de surface
de combat comptés au catalogue (hors amphibie légère et patrouilleurs côtiers).

|   # | Nation              | Budget 2025 | Effectifs | Chasseurs | Chars | Navires / sous-marins | Principaux systèmes (éléments)                                                                                                                                                                       | Confiance |
| --: | ------------------- | ----------: | --------: | --------: | ----: | --------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
|   1 | États-Unis          |   954,4 Md$ | 1 316 000 |     2 592 | 2 640 |              130 / 64 | F-16C/D Block 30-52 (USAF, ANG, AFRC) (762), F/A-18E/F Super Hornet (549), M1A2 SEPv2/SEPv3 (2 640), M902/M903 Patriot PAC-2 GEM-T / PAC-3 MSE (60), DDG-51 Arleigh Burke (Flight I/II/IIA/III) (75) | haute     |
|   2 | Chine               |   335,5 Md$ | 2 035 000 |     1 961 | 4 900 |              201 / 59 | J-10A/C/S (600), J-16 (350), ZTZ-96/96A/96B (2 500), HQ-17/17A (250), Type 022 Houbei (60)                                                                                                           | moyenne   |
|   3 | Russie              |   190,4 Md$ | 1 134 000 |       573 | 3 580 |              101 / 57 | Su-30SM/SM2/M2 (VKS et aéronavale) (120), Su-35S (110), T-72A/AV/B/BA (1 000), Pantsir-S1/S2/SM (250), Nanuchka III, Tarantul III (20)                                                               | moyenne   |
|   4 | Allemagne           |   113,6 Md$ |   181 600 |       223 |   313 |                21 / 6 | Eurofighter Typhoon (138), Tornado IDS/ECR (85), Leopard 2A6/A7/A7V/A7A1 (313), Patriot PAC-2/PAC-3 (8), K130 Braunschweig (10)                                                                      | haute     |
|   5 | Inde                |    92,1 Md$ | 1 475 750 |       590 | 3 820 |               48 / 19 | Su-30MKI (259), SEPECAT Jaguar IS/IB/IM (DARIN III) (110), T-72M1 Ajeya (2 400), 9K33 Osa-AKM (50), Shivalik, Nilgiri (P-17A), Brahmaputra (10)                                                      | haute     |
|   6 | Royaume-Uni         |      89 Md$ |   141 100 |       147 |   200 |               23 / 10 | Typhoon FGR4 (Tranche 2/3) (107), F-35B Lightning (40), Challenger 2 (200), Sky Sabre (CAMM) (8), River (patrouilleurs) (8)                                                                          | haute     |
|   7 | Ukraine             |    84,1 Md$ |   730 000 |       121 | 1 230 |                 0 / 0 | F-16AM/BM (50), MiG-29 / MiG-29MU2 (40), T-64BV/BM Bulat (500), 9K33 Osa (40)                                                                                                                        | faible    |
|   8 | Arabie saoudite     |    83,2 Md$ |   257 000 |       341 |   750 |                14 / 0 | F-15SA / F-15S modernisés (150), Eurofighter Typhoon (71), M1A2S (450), Patriot PAC-2/PAC-3 (18), Al Jubail (Avante 2200) (5)                                                                        | moyenne   |
|   9 | France              |      68 Md$ |   202 200 |       225 |   200 |               24 / 10 | Rafale B/C (Armée de l'air et de l'espace) (112), Mirage 2000D RMV (50), Leclerc / Leclerc XLR (200), SAMP/T Mamba (8), FREMM Aquitaine / FREDA (8)                                                  | haute     |
|  10 | Japon               |    62,2 Md$ |   247 150 |       334 |   350 |               49 / 24 | F-15J/DJ (200), Mitsubishi F-2A/B (88), Type 90 (220), Patriot PAC-2/PAC-3 MSE (24), Akizuki / Asahi / Takanami / Murasame (20)                                                                      | haute     |
|  11 | Israël              |    48,3 Md$ |   169 500 |       306 |   700 |                15 / 5 | F-16C/D Barak, F-16I Sufa (175), F-15A/B/C/D Baz (58), Merkava Mk4 / Mk4M / Barak (400), Iron Dome (15), Sa'ar 4.5 (8)                                                                               | haute     |
|  12 | Italie              |    48,1 Md$ |   161 850 |       179 |   200 |                20 / 8 | Eurofighter Typhoon (94), Tornado IDS/ECR (45), Ariete (200), SAMP/T (5), FREMM Bergamini (10)                                                                                                       | haute     |
|  13 | Corée du Sud        |    47,8 Md$ |   450 000 |       329 | 2 160 |               59 / 19 | KF-16C/D (KF-16U) (160), F-5E/F (70), K1/K1A1/K1A2 (1 500), KM-SAM Cheongung II (10), PKG Yoon Youngha / Gumdoksuri (20)                                                                             | haute     |
|  14 | Pologne             |    46,8 Md$ |   216 000 |        68 | 1 216 |                 3 / 1 | F-16C/D Block 52+ (48), MiG-29A/UB (14), M1A2 SEPv3 (250), 9K33 Osa-AK (64), Ślązak, Kaszub (2)                                                                                                      | haute     |
|  15 | Espagne             |    40,2 Md$ |   122 200 |       142 |   269 |                18 / 4 | EF-18A/B+ Hornet (C.15) (72), Eurofighter Typhoon (C.16) (70), Leopard 2E (219), Patriot PAC-2/PAC-3 (2), F80 Santa María (FFG-7) (6)                                                                | haute     |
|  16 | Canada              |    37,5 Md$ |    63 500 |        88 |    74 |                18 / 4 | CF-18A/B Hornet (88), Leopard 2A4/2A4M/2A6M (74), Halifax (12), Victoria (Upholder) (4)                                                                                                              | haute     |
|  17 | Australie           |    35,3 Md$ |    58 600 |        96 |   115 |                14 / 6 | F-35A (72), F/A-18F Super Hornet (24), M1A2 SEPv3 (75), NASAMS (2), Anzac (MEKO 200) (7)                                                                                                             | haute     |
|  18 | Turquie             |      30 Md$ |   355 200 |       245 | 1 945 |               38 / 14 | F-16C/D Block 30/40/50 (245), M60A3 / M60T Sabra (750), Hisar-A+/O+ (10), Kılıç (9), Preveze / Gür / Atılay (Type 209) (12)                                                                          | haute     |
|  19 | Pays-Bas            |    28,9 Md$ |    34 400 |        45 |    18 |                10 / 3 | F-35A (45), Leopard 2A6 (loués à l'Allemagne) (18), Patriot PAC-3 (3), Holland (patrouilleurs) (4), Walrus (3)                                                                                       | haute     |
|  20 | Algérie             |    25,4 Md$ |   139 000 |       129 | 1 485 |                11 / 6 | Su-30MKA (72), MiG-29S/M/M2 (46), T-90SA (600), Pantsir-S1/SM (108), Rais Hamidou (Nanuchka II) (3)                                                                                                  | moyenne   |
|  21 | Brésil              |    23,9 Md$ |   366 500 |        72 |   220 |                 7 / 7 | F-5EM/FM (40), A-1M AMX (20), Leopard 1A5BR (220), Niterói (4), Riachuelo (S-BR) (4)                                                                                                                 | haute     |
|  22 | Émirats arabes unis |      23 Md$ |    63 000 |       137 |   340 |                 9 / 0 | F-16E/F Block 60 (78), Mirage 2000-9 (59), Leclerc (340), Pantsir-S1 (50), Baynunah (6)                                                                                                              | moyenne   |
|  23 | Taïwan              |    18,2 Md$ |   169 000 |       358 | 1 008 |                56 / 2 | F-16V (Block 70 standard, A/B modernisés) (139), AIDC F-CK-1 Ching-kuo (127), M60A3 (450), Tien Kung II/III (17), Kuang Hua VI (31)                                                                  | haute     |
|  24 | Singapour           |    17,4 Md$ |    51 000 |       100 |   170 |                14 / 4 | F-16C/D Block 52/52+ (60), F-15SG (40), Leopard 2SG (170), SPYDER-SR (3), Independence (LMV) (8)                                                                                                     | haute     |
|  25 | Norvège             |      17 Md$ |    25 400 |        52 |    36 |                10 / 6 | F-35A (52), Leopard 2A4NO (36), NASAMS (12), Skjold (6), Ula (6)                                                                                                                                     | haute     |
|  26 | Suède               |    16,5 Md$ |    24 000 |        96 |   110 |                 9 / 4 | JAS 39C/D Gripen (90), JAS 39E Gripen (6), Strv 122 (Leopard 2A5) (110), IRIS-T SLS (LvS 98) (4), Visby (5)                                                                                          | haute     |
|  27 | Indonésie           |      15 Md$ |   404 500 |        55 |   253 |                35 / 4 | F-16C/D, F-16A/B (33), Su-30MK/MK2 (11), AMX-13 / Scorpion (150), NASAMS (2), KCR-40/60, Clurit (20)                                                                                                 | moyenne   |
|  28 | Danemark            |    14,9 Md$ |    15 400 |        30 |    44 |                 9 / 0 | F-35A (20), F-16AM/BM (10), Leopard 2A7 (44), Thetis (4)                                                                                                                                             | haute     |
|  29 | Belgique            |    14,5 Md$ |    23 200 |        46 |     0 |                 2 / 0 | F-16AM/BM (42), F-35A (4), Karel Doorman (2)                                                                                                                                                         | haute     |
|  30 | Colombie            |    14,5 Md$ |   293 200 |         0 |     0 |                 8 / 4 | Almirante Padilla (4), Type 209, Type 206A (4)                                                                                                                                                       | moyenne   |
|  31 | Qatar               |      14 Md$ |    16 500 |        96 |    62 |                 6 / 0 | Rafale EQ/DQ (36), F-15QA (36), Leopard 2A7+ (62), Patriot PAC-3 (7), Al Zubarah (Doha), Musherib (6)                                                                                                | moyenne   |
|  32 | Mexique             |    13,6 Md$ |   216 000 |         3 |     0 |                13 / 0 | F-5E/F (3), Reformador (SIGMA), Oaxaca, Durango (13)                                                                                                                                                 | moyenne   |
|  33 | Pakistan            |    11,9 Md$ |   660 000 |       300 | 1 700 |                17 / 6 | JF-17 Thunder (Block I/II/III) (150), F-16A/B/C/D (75), Al-Zarrar (Type 59 modernisé) (400), FM-90 (20), Zulfiquar (F-22P) (4)                                                                       | moyenne   |
|  34 | Viêt Nam            |    10,5 Md$ |   450 000 |        44 | 1 334 |                16 / 6 | Su-30MK2V (35), Su-27SK/UBK (9), T-54/T-55 (850), 9K33 Osa (20), Molniya (Tarantul V) (8)                                                                                                            | moyenne   |
|  35 | Roumanie            |     9,7 Md$ |    69 900 |        49 |   100 |                10 / 0 | F-16AM/BM (ex-Portugal, ex-Norvège) (49), TR-85M1 / TR-85 (100), Patriot PAC-3 (4), Tetal (4)                                                                                                        | haute     |
|  36 | Grèce               |     8,4 Md$ |   132 200 |       197 |   950 |                18 / 9 | F-16C/D Block 30/50/52+, F-16V (153), Rafale EG/DG (24), Leopard 1A5 (500), 9K33 Osa-AKM (38), Roussen (Super Vita) (7)                                                                              | haute     |
|  37 | Koweït              |     8,1 Md$ |    17 500 |        76 |   218 |                 8 / 0 | F/A-18E/F Super Hornet (28), Eurofighter Typhoon (28), M1A2K (218), Patriot PAC-3 (7), Um Almaradim (Combattante I) (8)                                                                              | moyenne   |
|  38 | Finlande            |     8,1 Md$ |    24 000 |        62 |   200 |                 8 / 0 | F/A-18C/D Hornet (62), Leopard 2A6 (100), NASAMS II (6), Hamina, Rauma (8)                                                                                                                           | haute     |
|  39 | Suisse              |     7,6 Md$ |    19 550 |        55 |   134 |                 0 / 0 | F/A-18C/D Hornet (30), F-5E/F Tiger II (25), Pz 87 WE (Leopard 2A4) (134)                                                                                                                            | haute     |
|  40 | Iran                |     7,4 Md$ |   610 000 |        70 | 1 600 |               65 / 12 | F-5E/F, HESA Saeqeh, Kowsar (35), MiG-29A/UB (20), T-72S/Z (480), Tor-M1 (20), vedettes lance-missiles des Gardiens de la révolution (60)                                                            | faible    |

Totaux mondiaux 2025 (201 nations) : 2 919 Md$, 20,4 millions de militaires d'active, 347 191 éléments, dont
12 330 chasseurs, 7 828 avions d'appui et de soutien, 476 bombardiers, 16 694 hélicoptères, 12 198 drones,
52 307 chars, 108 858 VCI/VTT, 64 891 pièces d'artillerie, 12 289 éléments de défense aérienne, 28 654 missiles de
frappe, 2 296 vecteurs nucléaires, 1 361 navires de surface, 437 sous-marins, 24 812 bataillons d'infanterie,
512 satellites et 1 248 radars.

## Limites et incertitudes

- **Confiance** : 36 nations « haute » (armées occidentales et asiatiques bien documentées), 74 « moyenne »,
  91 « faible » (petites armées, pays en guerre, régimes opaques).
- **Pays en guerre** : les inventaires de l'Ukraine, de la Russie, de l'Iran, du Soudan, du Yémen, de la Birmanie,
  de la Syrie et d'Israël évoluent vite ; ils reflètent l'état estimé à fin septembre 2026.
- **Munitions** : les stocks de missiles (Tomahawk, Kalibr, Shahed/Geran, missiles balistiques iraniens) sont des
  estimations publiques à ±50 %.
- **Opacité** : Corée du Nord, Chine (effectifs par modèle), Iran, Érythrée, Turkménistan, Venezuela, Cuba.
- **Regroupements** : le rattachement à un modèle de base surévalue parfois un matériel ancien (frégates FFG-7
  rattachées à la MEKO A-200) ou le sous-évalue (Type 10 japonais rattaché au K2) ; la variante réelle reste
  affichée.
- **Effectifs → bataillons** : la conversion de toutes les forces terrestres (soutien compris) en bataillons de 600
  surestime l'infanterie de manœuvre ; c'est la convention demandée (1 élément = ≈ 600 personnes).
- **Entités** : Taïwan, Kosovo, Chypre du Nord, Somaliland, Sahara occidental, Gaza et l'Autorité palestinienne
  sont traités comme des nations du jeu, sans prise de position sur leur statut.
