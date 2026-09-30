# Catalogue — Chasseurs et multirôles (à valider)

> Statut : **proposition, en attente de validation par Amine** avant d'étendre le catalogue aux autres catégories.
> Données : `data/catalog/fighters.json` (27 systèmes), validées par `WeaponSystemSchema`
> (test : `pnpm --filter @redline/admin test`). Éditables ensuite dans le back-office.

Les valeurs sont des **valeurs de jeu** : elles partent d'ordres de grandeur publics arrondis (vitesse maximale,
rayon d'action, dimensions, masse maximale au décollage, distance franchissable), puis sont ramenées sur une échelle
commune pour que les systèmes restent comparables entre eux et entre générations.

## 1. Règles d'équilibrage retenues

| Grandeur                 | Règle                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Génération               | Entier de 1 à 5 (schéma). Les « 4,5 » (F/A-18E, Su-35, J-16, Gripen, Typhoon, Rafale, KF-21) sont en génération 4 mais exigent la recherche `research.aero.gen4plus`, notée **4+** ci-dessous. Recherches : `research.aero.gen2` … `gen5`. |
| Coût                     | Étalon : F-16 = 1 200. 2e gén. ≈ 320 à 350 ; 3e ≈ 450 ; 4e ≈ 750 à 1 900 ; 4+ ≈ 1 400 à 2 300 ; 5e ≈ 3 000 à 4 200. Un F-35 coûte 7 fois un F-5E.                                                                                          |
| Ressources               | Proportionnelles au coût : pétrole ≈ 1,7 %, métaux ≈ 3,3 %, électronique de 2 % (2e gén.) à 6 % (5e gén.), arrondis à 5.                                                                                                                   |
| Production               | 10 h (MiG-21, J-7) → 14 h (F-5E) → 26 à 48 h (4e) → 40 à 54 h (4+) → 72 à 96 h (5e).                                                                                                                                                       |
| Entretien                | Environ 2 % du coût par jour.                                                                                                                                                                                                              |
| Vitesse                  | Mach maximal × 1 060 km/h (vitesse du son en altitude), arrondi à 50. `sheet.speedLabel` garde le Mach public.                                                                                                                             |
| Rayon d'action           | Rayon de combat public, arrondi (aller simple vers la cible). `sheet.rangeKm` = distance franchissable (convoyage).                                                                                                                        |
| Portée d'arme            | Missile air-air principal du modèle de base : 12 à 15 km (missiles à courte portée des 2e et 3e gén.), 70 à 100 km (4e), 110 à 160 km (4+ et 5e, Meteor, PL-15, R-77-1), 200 km (MiG-31). Minimum 1 km.                                    |
| Détection                | Radar de bord : 40 km (2e gén.) à 250 km (MiG-31).                                                                                                                                                                                         |
| Points de vie / blindage | Cellule : 18 PV (2e gén.) → 26 (léger) → 28 (moyen) → 30 (lourd) → 30 à 32 (5e). Blindage 0,05 à 0,15.                                                                                                                                     |
| Furtivité                | **Significative seulement en 5e génération** : F-22 0,85, F-35 0,8, J-35 0,7, J-20 0,65, Su-57 0,55. Tous les autres ≤ 0,15 (réduction de signature des Rafale, KF-21).                                                                    |
| Guerre électronique      | Brouillage 0,05 (2e gén.) à 0,5 (Rafale, F-35) ; résistance au brouillage 0,1 à 0,75.                                                                                                                                                      |

### Matrice de contre-mesures

Dégâts par round et par élément, avant blindage de la cible. Chaque chasseur a une valeur air-air _A_ et une
valeur air-sol _S_ ; la matrice en découle toujours de la même façon, ce qui garde la catégorie cohérente :

| Cible                   | Formule                     | Plage  | Lecture                                                       |
| ----------------------- | --------------------------- | ------ | ------------------------------------------------------------- |
| Avions                  | _A_                         | 6 à 20 | **fort**                                                      |
| Hélicoptères            | 0,85 × _A_                  | 5 à 17 | **fort**                                                      |
| Drones                  | 0,55 × _A_                  | 3 à 11 | moyen                                                         |
| Missiles (de croisière) | 1 à 3 (MiG-31 : 6)          |        | faible, sauf intercepteur                                     |
| Blindés                 | 0,5 × _S_, plafonné à 5     | 1 à 5  | **faible** (et divisé par le blindage des chars : 0,65 à 0,7) |
| Infanterie              | 0,4 × _S_, plafonné à 4     | 1 à 4  | **faible**                                                    |
| Bâtiments               | _S_                         | 2 à 10 | selon le rôle de frappe                                       |
| Navires                 | selon l'armement antinavire | 0 à 7  | Rafale, F/A-18E, Su-30, J-16 : 7                              |
| Sous-marins             | 0                           |        | aucun chasseur ne chasse les sous-marins                      |

Face au reste du catalogue de phase 1 : un S-400 inflige 22 à un avion (19 après blindage) et un F-16 le détruit
en deux rounds s'il entre dans sa bulle ; un chasseur n'inflige que ≈ 2,5 par round à ce S-400. La défense aérienne
se combat donc par le brouillage, la saturation et la furtivité, pas en duel frontal.

## 2. Tableau récapitulatif (27 systèmes)

| Système              | Doctrine        | Gén. |  Coût | Prod. |    Vitesse |    Rayon | Portée arme | Furtivité | Air / hélico / drone | Inf. / blindé / bât. / navire | Points forts                                                                                                            |
| -------------------- | --------------- | ---- | ----: | ----: | ---------: | -------: | ----------: | --------: | -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| F-5E Tiger II        | États-Unis (US) | 3    |   450 |  14 h | 1 700 km/h |   400 km |       15 km |         0 | 7 / 6 / 4            | 1 / 2 / 3 / 2                 | Très bon marché, produit en 14 h ; chasseur léger de masse pour les petits budgets                                      |
| F-16 Fighting Falcon | États-Unis (US) | 4    | 1 200 |  36 h | 2 100 km/h |   550 km |      100 km |      0,05 | 13 / 11 / 7          | 2 / 3 / 6 / 3                 | Polyvalent équilibré ; étalon de coût du catalogue (1 200)                                                              |
| F-15E Strike Eagle   | États-Unis (US) | 4    | 1 900 |  48 h | 2 650 km/h | 1 250 km |      100 km |         0 | 13 / 11 / 7          | 4 / 5 / 9 / 4                 | Rayon de 1 250 km et meilleure frappe au sol américaine ; robuste                                                       |
| F/A-18E Super Hornet | États-Unis (US) | 4+   | 1 800 |  46 h | 1 900 km/h |   720 km |      100 km |       0,1 | 14 / 12 / 8          | 3 / 4 / 7 / 7                 | Antinavire (7), bon brouillage ; futur embarqué sur porte-avions                                                        |
| F-22 Raptor          | États-Unis (US) | 5    | 4 200 |  96 h | 2 400 km/h |   850 km |      120 km |      0,85 | 20 / 17 / 11         | 2 / 2 / 4 / 1                 | Meilleur combat aérien du jeu (20) et furtivité 0,85 ; non exportable                                                   |
| F-35 Lightning II    | États-Unis (US) | 5    | 3 200 |  80 h | 1 700 km/h | 1 100 km |      120 km |       0,8 | 18 / 15 / 10         | 3 / 4 / 8 / 5                 | Furtif polyvalent (0,8), SEAD, meilleure guerre électronique (0,5 / 0,75)                                               |
| MiG-21               | Russie (RU)     | 2    |   350 |  10 h | 2 150 km/h |   370 km |       12 km |         0 | 6 / 5 / 3            | 1 / 1 / 2 / 1                 | Très bon marché (350, 10 h) ; masse d’intercepteurs de 2e génération                                                    |
| MiG-29               | Russie (RU)     | 4    | 1 000 |  32 h | 2 400 km/h |   700 km |       70 km |         0 | 12 / 10 / 7          | 2 / 2 / 4 / 2                 | Supériorité aérienne abordable, rapide (Mach 2,25)                                                                      |
| MiG-31               | Russie (RU)     | 4    | 1 700 |  48 h | 3 000 km/h |   720 km |      200 km |         0 | 15 / 7 / 5           | 1 / 1 / 2 / 0                 | Mach 2,8, radar 250 km, arme à 200 km ; meilleur intercepteur de missiles (6) mais faible contre hélicoptères et drones |
| Su-27                | Russie (RU)     | 4    | 1 400 |  40 h | 2 500 km/h | 1 300 km |      100 km |         0 | 14 / 12 / 8          | 2 / 2 / 4 / 2                 | Grand rayon (1 300 km) et bon combat aérien pour 1 400                                                                  |
| Su-30                | Russie (RU)     | 4    | 1 700 |  44 h | 2 100 km/h | 1 500 km |      110 km |         0 | 14 / 12 / 8          | 3 / 4 / 8 / 7                 | Multirôle lourd, antinavire (7), rayon 1 500 km                                                                         |
| Su-35                | Russie (RU)     | 4+   | 2 000 |  50 h | 2 400 km/h | 1 600 km |      130 km |      0,05 | 16 / 14 / 9          | 3 / 4 / 7 / 4                 | Plus grand rayon du catalogue (1 600 km), brouillage 0,4                                                                |
| Su-57                | Russie (RU)     | 5    | 3 500 |  84 h | 2 100 km/h | 1 500 km |      160 km |      0,55 | 18 / 15 / 10         | 3 / 4 / 8 / 5                 | Furtivité moyenne (0,55), plus longue portée d’arme des 5e gén. (160 km)                                                |
| J-7                  | Chine (CN)      | 2    |   320 |  10 h | 2 100 km/h |   350 km |       12 km |         0 | 6 / 5 / 3            | 1 / 1 / 2 / 1                 | Le moins cher du catalogue (320) ; même rôle que le MiG-21                                                              |
| J-10                 | Chine (CN)      | 4    | 1 100 |  34 h | 2 350 km/h |   550 km |      100 km |      0,05 | 12 / 10 / 7          | 2 / 3 / 5 / 3                 | Chasseur léger moderne à prix contenu                                                                                   |
| J-11                 | Chine (CN)      | 4    | 1 350 |  40 h | 2 500 km/h | 1 300 km |      100 km |         0 | 14 / 12 / 8          | 2 / 3 / 5 / 3                 | Équivalent du Su-27, non exportable                                                                                     |
| J-16                 | Chine (CN)      | 4+   | 1 800 |  46 h | 2 100 km/h | 1 500 km |      150 km |         0 | 15 / 13 / 8          | 4 / 5 / 9 / 7                 | Meilleur multirôle chinois : arme à 150 km, frappe (9) et antinavire (7)                                                |
| J-20                 | Chine (CN)      | 5    | 3 300 |  80 h | 2 100 km/h | 1 100 km |      150 km |      0,65 | 18 / 15 / 10         | 2 / 3 / 5 / 4                 | Supériorité aérienne furtive (0,65), grande distance franchissable                                                      |
| J-35                 | Chine (CN)      | 5    | 3 000 |  72 h | 1 900 km/h | 1 100 km |      150 km |       0,7 | 17 / 14 / 9          | 3 / 4 / 7 / 5                 | Furtif moyen (0,7), moins cher que le J-20 et exportable                                                                |
| Mirage 2000          | Europe (FR)     | 4    | 1 250 |  36 h | 2 350 km/h |   700 km |       70 km |      0,05 | 12 / 10 / 7          | 2 / 3 / 5 / 3                 | Chasseur léger rapide (Mach 2,2), prix modéré                                                                           |
| Tornado              | Europe (DE)     | 4    | 1 300 |  38 h | 2 350 km/h | 1 300 km |       20 km |         0 | 9 / 8 / 5            | 3 / 4 / 10 / 6                | Meilleur contre les bâtiments (10), antinavire ; faible en combat aérien (arme à 20 km)                                 |
| JAS 39 Gripen        | Europe (SE)     | 4+   | 1 400 |  40 h | 2 100 km/h |   800 km |      100 km |       0,1 | 14 / 12 / 8          | 2 / 3 / 6 / 5                 | Meilleur brouillage des chasseurs légers (0,45) pour 1 400 ; licence possible                                           |
| Eurofighter Typhoon  | Europe (DE)     | 4+   | 2 300 |  54 h | 2 100 km/h | 1 100 km |      150 km |       0,1 | 16 / 14 / 9          | 2 / 3 / 6 / 4                 | Supériorité aérienne 4+ (16), Meteor à 150 km                                                                           |
| Rafale               | Europe (FR)     | 4+   | 2 300 |  54 h | 1 900 km/h | 1 100 km |      150 km |      0,15 | 16 / 14 / 9          | 4 / 5 / 9 / 7                 | Omnirôle non furtif le plus complet (air 16, sol 9, navire 7), guerre électronique 0,5 / 0,6                            |
| JF-17 Thunder        | Autres (PK)     | 4    |   750 |  26 h | 1 700 km/h |   700 km |       80 km |      0,05 | 11 / 9 / 6           | 2 / 3 / 5 / 4                 | 4e génération bon marché (750, 26 h) : l’option des pays moyens                                                         |
| KF-21 Boramae        | Autres (KR)     | 4+   | 2 000 |  52 h | 1 900 km/h | 1 000 km |      150 km |      0,15 | 15 / 13 / 8          | 3 / 4 / 7 / 4                 | 4+ semi-furtif (0,15, plafonné hors 5e gén.), Meteor                                                                    |
| Tejas                | Autres (IN)     | 4    |   950 |  32 h | 1 700 km/h |   500 km |       80 km |       0,1 | 11 / 9 / 6           | 2 / 2 / 4 / 3                 | Chasseur léger indien, rayon court (500 km)                                                                             |

Remarques :

- **J-35** : chiffres publics encore peu nombreux ; valeurs estimées par analogie avec le F-35 et le J-20, à revoir.
- **KF-21** : génération 4 dans le schéma (4+ en recherche), sa furtivité est plafonnée comme celle des 4e génération.
- Illustrations attendues : `<id>.webp` (champ `illustration`), fichiers à produire.
- Doctrine « autres » : JF-17 (Pakistan, avec la Chine), KF-21 (Corée du Sud), Tejas (Inde).

## 3. Proposition de liste complémentaire (200 à 250 systèmes) — NON intégrée

Le catalogue compte aujourd'hui **57 systèmes** : les 27 chasseurs ci-dessus et 30 unités de démonstration de la
phase 1 (`data/catalog/phase1-*.json` : 10 infanteries génériques, 5 chars, 2 VCI, 3 artilleries, 4 défenses
aériennes, 1 brouilleur, 3 drones, 2 hélicoptères). La liste ci-dessous porterait le total à **environ 240**.
Critères : modèles de base, systèmes réellement en service (ou en entrée en service), au moins un système par doctrine
et par rôle clé quand il existe, pas de variantes quasi identiques, et chaque contre-mesure de la table du cahier
servie par au moins deux systèmes par doctrine.

| Catégorie                                                                             | À ajouter |     Total | Proposition                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | --------: | --------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chasseurs et multirôles                                                               |         0 |        27 | Catégorie complète (ci-dessus).                                                                                                                                                                                                                                  |
| Bombardiers                                                                           |         9 |         9 | B-52H, B-1B, B-2, B-21 · Tu-95MS, Tu-22M3, Tu-160 · H-6K, H-20 (projet, à confirmer). L'Europe n'en aligne pas.                                                                                                                                                  |
| Soutien aérien (attaque, guet aérien, ravitaillement, transport, guerre électronique) |        17 |        17 | A-10C, E-3 Sentry, E-2D, KC-46, C-17, EA-18G Growler · Su-25, Su-34, A-50, Il-78, Il-76 · KJ-500, Y-20, YY-20 · A400M, A330 MRTT, GlobalEye.                                                                                                                     |
| Hélicoptères                                                                          |        12 |        14 | AH-1Z, UH-60, CH-47, MH-60R (lutte anti-sous-marine) · Mi-28NM, Mi-24/35, Mi-8/17 · Z-10, Z-20 · Tigre, NH90 · T129 ATAK.                                                                                                                                        |
| Drones et munitions rôdeuses                                                          |        13 |        16 | RQ-4, MQ-1C, Switchblade 600 · Forpost, S-70 Okhotnik, Lancet · Wing Loong II, CH-5, GJ-11 · Akinci, Heron TP, Harop, Shahed-136 (générique « drone kamikaze à longue portée »).                                                                                 |
| Chars                                                                                 |         8 |        13 | T-72B3, T-80BVM, T-14 · Type 96B, VT4 · Challenger 3 · K2, Merkava IV.                                                                                                                                                                                           |
| VCI et transports blindés                                                             |        10 |        12 | Stryker, AMPV · BMP-2, BTR-82A · ZBD-04A, ZBL-08 · CV90, Puma, VBCI, Boxer.                                                                                                                                                                                      |
| Artillerie et lance-roquettes                                                         |        13 |        16 | M777, M142 HIMARS, M270 · 2S35 Koalitsiya, BM-21 Grad, Tornado-S, TOS-1A · PLZ-05, PHL-16 · PzH 2000, Archer · K9, Pinaka.                                                                                                                                       |
| Défense aérienne et guerre électronique                                               |        15 |        20 | NASAMS, Avenger, THAAD · Tor-M2, Buk-M3, S-300PMU2, S-500 · HQ-9B, HQ-16, HQ-17 · SAMP/T, IRIS-T SLM, Skynex, Gepard · Iron Dome. Plus 2 brouilleurs (États-Unis, Chine) pour que chaque grande doctrine ait sa contre-mesure antidrone.                         |
| Missiles de frappe                                                                    |        20 |        20 | Tomahawk, JASSM-ER, ATACMS, PrSM, AGM-88 · Kalibr, Iskander-M, Kh-101, Kinzhal, Zircon · CJ-10, DF-17, DF-21D, YJ-18 · SCALP/Storm Shadow, Exocet, Taurus, NSM · BrahMos, Fateh-110. Classe de cible `missile`.                                                  |
| Nucléaire                                                                             |        12 |        12 | Minuteman III, Trident II D5, B61-12 · Yars, Sarmat, Bulava · DF-41, JL-3 · M51, ASMPA · Agni-V, Shaheen-III. Règles d'emploi et d'alerte à définir avant intégration.                                                                                           |
| Navires de surface                                                                    |        20 |        20 | Arleigh Burke, Nimitz/Ford, America, Constellation · Admiral Kuznetsov, Admiral Gorshkov, Karakurt, Pyotr Velikiy · Type 055, Type 052D, Type 054A, Type 003, Type 075 · Charles de Gaulle, FREMM, Horizon, Type 45, Queen Elizabeth · Sejong le Grand, Kolkata. |
| Sous-marins                                                                           |        13 |        13 | Virginia, Ohio (SSBN), Columbia · Yasen-M, Borei, Kilo 636.3 · Type 093, Type 094, Type 039 · Suffren, Astute, Type 212 · Scorpène.                                                                                                                              |
| Infanterie                                                                            |        10 |        20 | Par doctrine : infanterie de marine et forces spéciales (aéroportées incluses), toujours génériques (`us.infantry-marines`, `ru.special-forces`…).                                                                                                               |
| Espace                                                                                |         6 |         6 | Génériques par doctrine : satellite de reconnaissance optique, radar, écoute, alerte avancée, navigation, arme antisatellite.                                                                                                                                    |
| **Total**                                                                             | **≈ 184** | **≈ 241** |                                                                                                                                                                                                                                                                  |

Points à trancher avant l'intégration :

1. **Nucléaire** : règles d'emploi, seuil d'alerte mondiale et effets sur des bâtiments génériques (jamais de vrais sites).
2. **Missiles** : unités consommables (production, puis tir) ou emport des lanceurs (`payload.slots`) ?
3. **Porte-avions** : capacité d'emport d'aéronefs (le champ `payload.transport` peut servir), à confirmer avec le moteur.
4. Faut-il une **armée de départ par doctrine** ? `BalanceSchema.startingArmy` est aujourd'hui unique pour toutes les
   nations (voir le rapport de la phase 1).

## 4. Réglages liés (data/balance/default.json)

- Temps : round de combat 20 min, capture 90 min, réflexion des IA 30 min (x1 = 1 h de jeu par heure réelle).
- Économie : 6 000 d'argent de départ (≈ 5 F-16 ou une trentaine d'infanteries légères). Hypothèse pour les données de
  carte : un pays moyen gagne **2 500 à 3 000 par jour**, soit 2 chasseurs de 4e génération ou 3 chars par jour, et un
  chasseur de 5e génération tous les un ou deux jours.
- Victoire : 60 % des provinces du monde ou toutes les capitales ennemies.
- Armée de départ (identique pour toutes les nations, faute de champ par doctrine) : 3 infanteries légères et
  1 mécanisée génériques, 1 Leopard 2A7, 1 CAESAR, 1 Pantsir-S1, 1 F-16, 1 Bayraktar TB2 (les systèmes les plus
  exportés de leur catégorie). Garnison des nations neutres : 2 infanteries légères, 1 mécanisée, 1 Mistral.
