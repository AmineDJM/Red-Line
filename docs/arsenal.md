# Arsenal de Red Line — catalogue, prix, recherche et équilibrage

> Données : `data/catalog/<catégorie>.json` (406 systèmes), `data/research/<branche>.json` (116 nœuds),
> `data/balance/default.json` (sections des phases 2 et suivantes), `data/scenarios/*.json` (5 scénarios).
> Validation : `pnpm --filter @redline/admin test` (`apps/admin/test/data.test.ts`). Toutes les valeurs sont
> éditables ensuite dans le back-office. Ce document est généré à partir des données : en cas d’écart, les
> fichiers JSON font foi.

## 1. Méthode de prix (dollars US)

Chaque fiche porte `unitPriceUsd`, le **prix unitaire réel estimé en dollars US actuels**, et
`cost.money = unitPriceUsd × unitSize` (toujours `unitSize = 1` : un élément par unité produite).

- **Sources publiques** : documents budgétaires américains (justifications P-1 et rapports d’acquisition),
  rapports du Congressional Research Service, contrats d’exportation publiés (base SIPRI des transferts
  d’armes, communiqués des ministères), articles Wikipedia des systèmes (ordres de grandeur), presse spécialisée.
- **Quel prix ?** Le coût de production unitaire (« flyaway » pour les aéronefs), hors développement et hors
  soutien. Un contrat d’exportation « tout compris » (formation, pièces, munitions) coûte souvent le double :
  on retient le prix du matériel.
- **Systèmes russes et chinois** : prix des commandes nationales estimés (Su-57 ≈ $40 M, T-90M ≈ $4,5 M), très
  inférieurs aux prix à l’exportation ; c’est le coût réel pour la nation qui produit.
- **Systèmes qui ne sont plus fabriqués** (MiG-21, M60, S-75…) : dernier prix connu corrigé de l’inflation, ou
  prix du marché de l’occasion quand il est mieux documenté.
- **Arrondis** : deux chiffres significatifs au plus. L’incertitude est de ±20 % pour les systèmes occidentaux
  documentés, ±50 % pour les systèmes russes, chinois, iraniens, nord-coréens et les projets secrets (H-20, B-21,
  S-70, GJ-11, satellites, armes antisatellites) : voir § 9.
- **Batteries** : pour la défense aérienne à moyenne et longue portée, un élément est une **batterie**
  (division pour les systèmes russes) avec radar, poste de commandement et lanceurs : S-400 ≈ $500 M,
  Patriot ≈ $1,1 Md (avec une dotation initiale de missiles). Les systèmes à courte portée sont comptés par
  **véhicule**, les missiles portables par **section** (≈ 4 postes de tir et 12 missiles).
- **Infanterie** : un élément est un **bataillon (≈ 600 personnes)** ; son prix est l’équipement du bataillon
  (armes, optiques, radios, missiles antichars, véhicules légers organiques), hors véhicules de combat du
  catalogue (ils sont comptés à part, par véhicule).

### Entretien (`upkeepPerDay`, dollars par jour)

Coût annuel de possession ÷ 365, avec coût annuel = _a_ × prix + _b_ × facteur de personnel (+ équipage × 100 k$
× facteur pour les navires et sous-marins). Facteur de personnel : États-Unis 1 ; Europe 0,8 ; Russie, Chine et
autres 0,3.

| Catégorie                                              | _a_ (part du prix / an) |              _b_ (fixe / an) | Exemple                                                        |
| ------------------------------------------------------ | ----------------------: | ---------------------------: | -------------------------------------------------------------- |
| Chasseurs et multirôles                                |                     6 % |                         $1 M | F-35 Lightning II : $16 k/jour                                 |
| Bombardiers                                            |                     3 % |                        $15 M | B-2 Spirit : $210 k/jour                                       |
| Soutien aérien                                         |                     6 % |                         $3 M | E-3 Sentry : $82 k/jour                                        |
| Hélicoptères                                           |                     7 % |                       $500 k | AH-64 Apache : $8 k/jour                                       |
| Drones et munitions rôdeuses                           |                     8 % |                       $200 k | MQ-9 Reaper : $7 k/jour                                        |
| Chars                                                  |                     6 % |                       $400 k | Leopard 2A7 : $3 k/jour                                        |
| Véhicules de combat d’infanterie et transports blindés |                     6 % |                       $250 k | M2 Bradley : $1 k/jour                                         |
| Artillerie et lance-roquettes                          |                     5 % |                       $400 k | CAESAR : $2 k/jour                                             |
| Infanterie                                             |                     5 % |          $42 M (600 × 70 k$) | Infanterie légère (États-Unis) : $120 k/jour                   |
| Défense aérienne et guerre électronique                |                     5 % | $500 k (+ 8 M$ par batterie) | S-400 Triumf : $91 k/jour                                      |
| Radars terrestres                                      |                     5 % |                         $1 M | Voronezh-DM : $42 k/jour                                       |
| Missiles de frappe                                     |                     2 % |                            — | BGM-109 Tomahawk : $110/jour                                   |
| Nucléaire                                              |                     5 % |                       $500 k | LGM-30G Minuteman III : $6 k/jour                              |
| Navires de surface                                     |                     2 % |                 — + équipage | Arleigh Burke : $210 k/jour                                    |
| Sous-marins                                            |                   1,5 % |                 — + équipage | Virginia : $180 k/jour                                         |
| Espace                                                 |                     5 % |                         $2 M | Satellite de reconnaissance optique (États-Unis) : $480 k/jour |
| Logistique                                             |                     8 % |                       $200 k | Cargo : $9 k/jour                                              |

Les munitions (missiles, munitions rôdeuses) coûtent 2 % de leur prix par an (stockage et maintenance).
L’infanterie coûte surtout ses soldes : un bataillon américain ≈ $120 k par jour, soit plus que sept F-35. Avec
des budgets réels versés chaque jour (`money.budgetPerDayFraction = 1/365`), l’entretien de l’inventaire réel
absorbe, comme dans la réalité, l’essentiel du budget ; il reste de quoi produire et chercher.

### Ressources stratégiques

Les ressources (pétrole, métaux, électronique, nourriture) restent sur l’échelle des revenus des provinces
(`data/map/provinces.json`). Points de ressource P = 1 200 × (prix ÷ 64 M$)^0,6 (étalon : le F-16 garde ses
20 / 40 / 55), répartis selon la catégorie : blindés riches en métaux, capteurs et espace en électronique,
infanterie en nourriture. L’exposant 0,6 évite qu’un porte-avions épuise le pétrole d’un continent.
Les 27 chasseurs validés gardent leurs ressources d’origine.

### Délais de production (`buildTimeH`, heures de jeu)

Compressés mais hiérarchisés : munitions 2 à 24 h, infanterie 8 à 22 h, blindés 6 à 40 h, chasseurs 10 à 96 h,
défense aérienne 6 à 110 h, avions de soutien 12 à 130 h, bombardiers 100 à 240 h, satellites 160 à 240 h,
corvettes 60 à 220 h, frégates et destroyers 260 à 500 h, sous-marins 120 à 1 000 h, porte-avions 900 à 1 100 h.

## 2. Unités de compte et champs

| Catégorie                                              | Élément (`unitLabel`)                          | Milieu         | Classe de cible       | Champs optionnels renseignés |
| ------------------------------------------------------ | ---------------------------------------------- | -------------- | --------------------- | ---------------------------- |
| Chasseurs et multirôles                                | appareil                                       | air            | aircraft              | air                          |
| Bombardiers                                            | appareil                                       | air            | aircraft              | air                          |
| Soutien aérien                                         | appareil                                       | air            | aircraft              | air, naval, sensor           |
| Hélicoptères                                           | hélicoptère                                    | air            | helicopter            | air, naval, sensor           |
| Drones et munitions rôdeuses                           | drone, munition                                | air            | drone                 | air, missile, sensor         |
| Chars                                                  | char                                           | land           | armor                 | —                            |
| Véhicules de combat d’infanterie et transports blindés | véhicule                                       | land           | armor                 | —                            |
| Artillerie et lance-roquettes                          | lanceur, pièce                                 | land           | armor                 | —                            |
| Infanterie                                             | bataillon                                      | land           | infantry              | —                            |
| Défense aérienne et guerre électronique                | batterie, division, section, système, véhicule | land           | armor, infantry       | interceptor, sensor          |
| Radars terrestres                                      | radar, station                                 | land, static   | armor, building       | sensor                       |
| Missiles de frappe                                     | missile                                        | air            | missile               | missile                      |
| Nucléaire                                              | bombe, missile                                 | air            | missile               | missile                      |
| Navires de surface                                     | navire                                         | sea            | ship                  | interceptor, naval, sensor   |
| Sous-marins                                            | sous-marin, sous-marin de poche                | sea            | submarine             | naval, sensor                |
| Espace                                                 | intercepteur, satellite                        | land, static   | armor, missile        | missile, sensor, space       |
| Logistique                                             | appareil, convoi, navire                       | air, land, sea | aircraft, armor, ship | air                          |

- `era.introduced` : année d’entrée en service. Quand la fiche représente une **famille modernisée**, c’est
  l’année de la famille (M1A2 → M1 1980, Leopard 2A7 → 1979, T-80BVM → 1976, Patriot → 1984, Yars → Topol
  1985, Trident II → Trident 1979, Tor-M2 → 1986, Buk-M3 → 1980, S-300PMU2 → 1978) : le scénario 1985 dispose
  ainsi des matériels de l’époque. Aucun système n’est retiré du service partout : `era.retired` est absent.
- **Systèmes en cours de développement** (B-21, H-20, Eurodrone, Constellation, Columbia, Challenger 3, Altay,
  Fujian, J-35 en 2025 ; KF-21 en 2026) : `era.introduced` est l’année de mise en service prévue, bornée à 2025
  quand le prototype existe déjà, pour qu’ils restent accessibles par la recherche dans le monde de 2025.
- `requires` : **exactement** les portes nécessaires pour produire (voir § 5). Posséder ≠ savoir produire.
- Nucléaire : jamais exportable ni sous licence. Logistique : non combattante, jamais exportée, sans porte.

## 3. Table des contre-mesures

Chaque famille a au moins une parade claire (vérifié par le test) :

| Cible                  | Parades (dégâts forts)                                                                                           | Faiblesses de la cible                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Infanterie             | chars, VCI, artillerie (thermobarique TOS-1A : 18), hélicoptères, drones                                         | peu de blindage (0,1 à 0,3)                  |
| Blindés                | chars (10 à 15), hélicoptères d’attaque (10 à 14), drones et munitions rôdeuses (Lancet 16), infanterie antichar | les chasseurs n’y font presque rien (≤ 5)    |
| Artillerie             | contre-batterie, drones, aviation                                                                                | cible blindée légère (≤ 0,35), peu de PV     |
| Hélicoptères           | défense aérienne courte portée (13 à 16), chasseurs (≥ 14)                                                       | les chars ne les touchent pas                |
| Drones                 | canons antiaériens (Skynex 18, Gepard 16), Pantsir, Tor, brouilleurs (Krasukha-4, brouilleurs US et chinois)     | 2 à 18 PV                                    |
| Avions et bombardiers  | chasseurs, défense aérienne longue portée (20 à 24)                                                              | bombardiers sans armement air-air            |
| Défense aérienne       | brouillage (résistance ≤ 0,5), saturation (≤ 24 PV), missiles et drones antiradar (HARM, Harop)                  | —                                            |
| Radars                 | antiradar (HARM 22 contre blindé, 10 contre bâtiment), frappes                                                   | aucune arme                                  |
| Navires                | sous-marins (22 à 30), missiles antinavires (38 à 55), bombardiers antinavires, aviation maritime                | —                                            |
| Sous-marins            | navires ASM (Oudaloï 16, FREMM 14), hélicoptères ASM (11 à 12), sous-marins (14 à 22), P-8 (14)                  | chasseurs, chars, artillerie : 0             |
| Missiles de croisière  | défense aérienne (intercepteur `cruise`), navires Aegis, Iron Dome                                               | lents, peu furtifs sauf JASSM, SCALP, Kh-101 |
| Missiles balistiques   | Patriot, S-300/400, SAMP/T, HQ-9B, Fronde de David, Arleigh Burke, THAAD, Arrow 3, S-500                         | —                                            |
| Missiles hypersoniques | S-500 uniquement (évasion ≥ 0,85)                                                                                | —                                            |
| Satellites             | armes antisatellites (4 doctrines)                                                                               | aucune défense                               |

Les 27 chasseurs validés gardent leur matrice (formules du document `docs/catalog-fighters.md`).

## 4. Tableau de tous les systèmes

Colonnes : prix unitaire, génération (4+ = porte `aero.gen4plus`), entrée en service, portes de recherche.

### Chasseurs et multirôles (27)

| Système              | Identifiant      | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes        |
| -------------------- | ---------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ------------- |
| F-5E Tiger II        | `us.f-5e`        | États-Unis (US) |         $12 M |             $5 k |  3   |  1972   |       14 h | aero.gen3     |
| F-16 Fighting Falcon | `us.f-16`        | États-Unis (US) |         $64 M |            $13 k |  4   |  1978   |       36 h | aero.gen4     |
| F-15E Strike Eagle   | `us.f-15e`       | États-Unis (US) |         $97 M |            $19 k |  4   |  1988   |       48 h | aero.gen4     |
| F/A-18E Super Hornet | `us.fa-18e`      | États-Unis (US) |         $67 M |            $14 k |  4+  |  1999   |       46 h | aero.gen4plus |
| F-22 Raptor          | `us.f-22`        | États-Unis (US) |        $190 M |            $34 k |  5   |  2005   |       96 h | aero.gen5     |
| F-35 Lightning II    | `us.f-35`        | États-Unis (US) |         $82 M |            $16 k |  5   |  2015   |       80 h | aero.gen5     |
| MiG-21               | `ru.mig-21`      | Russie (RU)     |          $5 M |             $2 k |  2   |  1959   |       10 h | aero.gen2     |
| MiG-29               | `ru.mig-29`      | Russie (RU)     |         $25 M |             $5 k |  4   |  1983   |       32 h | aero.gen4     |
| MiG-31               | `ru.mig-31`      | Russie (RU)     |         $40 M |             $7 k |  4   |  1981   |       48 h | aero.gen4     |
| Su-27                | `ru.su-27`       | Russie (RU)     |         $30 M |             $6 k |  4   |  1985   |       40 h | aero.gen4     |
| Su-30                | `ru.su-30`       | Russie (RU)     |         $40 M |             $7 k |  4   |  1996   |       44 h | aero.gen4     |
| Su-35                | `ru.su-35`       | Russie (RU)     |         $38 M |             $7 k |  4+  |  2014   |       50 h | aero.gen4plus |
| Su-57                | `ru.su-57`       | Russie (RU)     |         $40 M |             $7 k |  5   |  2020   |       84 h | aero.gen5     |
| J-7                  | `cn.j-7`         | Chine (CN)      |          $4 M |             $2 k |  2   |  1966   |       10 h | aero.gen2     |
| J-10                 | `cn.j-10`        | Chine (CN)      |         $40 M |             $7 k |  4   |  2005   |       34 h | aero.gen4     |
| J-11                 | `cn.j-11`        | Chine (CN)      |         $35 M |             $7 k |  4   |  1998   |       40 h | aero.gen4     |
| J-16                 | `cn.j-16`        | Chine (CN)      |         $60 M |            $11 k |  4+  |  2015   |       46 h | aero.gen4plus |
| J-20                 | `cn.j-20`        | Chine (CN)      |        $110 M |            $19 k |  5   |  2017   |       80 h | aero.gen5     |
| J-35                 | `cn.j-35`        | Chine (CN)      |         $70 M |            $12 k |  5   |  2025   |       72 h | aero.gen5     |
| Mirage 2000          | `eu.mirage-2000` | Europe (FR)     |         $55 M |            $11 k |  4   |  1984   |       36 h | aero.gen4     |
| Tornado              | `eu.tornado`     | Europe (DE)     |         $60 M |            $12 k |  4   |  1979   |       38 h | aero.gen4     |
| JAS 39 Gripen        | `eu.gripen`      | Europe (SE)     |         $85 M |            $16 k |  4+  |  1996   |       40 h | aero.gen4plus |
| Eurofighter Typhoon  | `eu.typhoon`     | Europe (DE)     |        $125 M |            $23 k |  4+  |  2003   |       54 h | aero.gen4plus |
| Rafale               | `eu.rafale`      | Europe (FR)     |        $115 M |            $21 k |  4+  |  2001   |       54 h | aero.gen4plus |
| JF-17 Thunder        | `other.jf-17`    | Autres (PK)     |         $30 M |             $6 k |  4   |  2007   |       26 h | aero.gen4     |
| KF-21 Boramae        | `other.kf-21`    | Autres (KR)     |         $70 M |            $12 k |  4+  |  2026   |       52 h | aero.gen4plus |
| Tejas                | `other.tejas`    | Autres (IN)     |         $42 M |             $8 k |  4   |  2016   |       32 h | aero.gen4     |

### Bombardiers (9)

| Système              | Identifiant               | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes              |
| -------------------- | ------------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ------------------- |
| B-52H Stratofortress | `us.b-52h-stratofortress` | États-Unis (US) |        $100 M |            $49 k |  3   |  1961   |      120 h | aero.bomber1        |
| B-1B Lancer          | `us.b-1b-lancer`          | États-Unis (US) |        $500 M |            $82 k |  4   |  1986   |      180 h | aero.bomber2        |
| B-2 Spirit           | `us.b-2-spirit`           | États-Unis (US) |       $2,1 Md |           $210 k |  5   |  1997   |      240 h | aero.stealth-bomber |
| B-21 Raider          | `us.b-21-raider`          | États-Unis (US) |        $800 M |           $110 k |  5   |  2025   |      220 h | aero.stealth-bomber |
| Tu-95MS              | `ru.tu-95ms`              | Russie (RU)     |        $120 M |            $22 k |  3   |  1981   |      120 h | aero.bomber1        |
| Tu-22M3              | `ru.tu-22m3`              | Russie (RU)     |         $80 M |            $19 k |  4   |  1983   |      140 h | aero.bomber2        |
| Tu-160               | `ru.tu-160`               | Russie (RU)     |        $270 M |            $35 k |  4   |  1987   |      200 h | aero.bomber2        |
| H-6K                 | `cn.h-6k`                 | Chine (CN)      |         $45 M |            $16 k |  3   |  2011   |      100 h | aero.bomber1        |
| H-20                 | `cn.h-20`                 | Chine (CN)      |        $450 M |            $49 k |  5   |  2025   |      220 h | aero.stealth-bomber |

### Soutien aérien (40)

| Système               | Identifiant               | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes                         |
| --------------------- | ------------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ------------------------------ |
| A-10C Thunderbolt II  | `us.a-10c-thunderbolt-ii` | États-Unis (US) |         $25 M |            $12 k |  4   |  1977   |       30 h | aero.gen4                      |
| E-3 Sentry            | `us.e-3-sentry`           | États-Unis (US) |        $450 M |            $82 k |  4   |  1977   |      120 h | aero.aew                       |
| E-7 Wedgetail         | `us.e-7-wedgetail`        | États-Unis (US) |        $600 M |           $110 k |  5   |  2010   |      130 h | aero.aew, sensors.radar3       |
| E-2D Advanced Hawkeye | `us.e-2d-hawkeye`         | États-Unis (US) |        $200 M |            $41 k |  5   |  2014   |       96 h | aero.aew, sensors.radar3       |
| KC-135 Stratotanker   | `us.kc-135-stratotanker`  | États-Unis (US) |         $70 M |            $20 k |  3   |  1957   |       72 h | aero.tanker                    |
| KC-46 Pegasus         | `us.kc-46-pegasus`        | États-Unis (US) |        $180 M |            $38 k |  4   |  2019   |       96 h | aero.tanker                    |
| C-17 Globemaster III  | `us.c-17-globemaster-iii` | États-Unis (US) |        $340 M |            $64 k |  4   |  1995   |      110 h | aero.transport                 |
| C-130 Hercules        | `us.c-130-hercules`       | États-Unis (US) |         $80 M |            $21 k |  3   |  1956   |       60 h | aero.transport                 |
| EA-18G Growler        | `us.ea-18g-growler`       | États-Unis (US) |         $70 M |            $20 k |  4+  |  2009   |       54 h | aero.gen4plus                  |
| P-8 Poseidon          | `us.p-8-poseidon`         | États-Unis (US) |        $170 M |            $36 k |  5   |  2013   |       96 h | aero.transport, sensors.radar2 |
| AV-8B Harrier II      | `us.av-8b-harrier-ii`     | États-Unis (US) |         $50 M |            $16 k |  4   |  1985   |       34 h | aero.gen4                      |
| F-4 Phantom II        | `us.f-4-phantom-ii`       | États-Unis (US) |         $25 M |            $12 k |  3   |  1960   |       18 h | aero.gen3                      |
| Su-25                 | `ru.su-25`                | Russie (RU)     |         $15 M |             $5 k |  4   |  1981   |       24 h | aero.gen3                      |
| Su-34                 | `ru.su-34`                | Russie (RU)     |         $40 M |             $9 k |  4+  |  2014   |       50 h | aero.gen4plus                  |
| Su-24                 | `ru.su-24`                | Russie (RU)     |         $20 M |             $6 k |  3   |  1974   |       30 h | aero.gen3                      |
| Su-22                 | `ru.su-22`                | Russie (RU)     |         $10 M |             $4 k |  3   |  1970   |       16 h | aero.gen3                      |
| MiG-23                | `ru.mig-23`               | Russie (RU)     |         $12 M |             $4 k |  3   |  1970   |       16 h | aero.gen3                      |
| A-50                  | `ru.a-50`                 | Russie (RU)     |        $330 M |            $57 k |  4   |  1985   |      120 h | aero.aew                       |
| Il-78                 | `ru.il-78`                | Russie (RU)     |         $90 M |            $17 k |  3   |  1984   |       80 h | aero.tanker                    |
| Il-76                 | `ru.il-76`                | Russie (RU)     |         $75 M |            $15 k |  3   |  1974   |       70 h | aero.transport                 |
| An-26                 | `ru.an-26`                | Russie (RU)     |          $8 M |             $4 k |  2   |  1969   |       24 h | aero.transport                 |
| Yak-130               | `ru.yak-130`              | Russie (RU)     |         $15 M |             $5 k |  4   |  2010   |       20 h | aero.gen4                      |
| KJ-500                | `cn.kj-500`               | Chine (CN)      |        $150 M |            $27 k |  5   |  2015   |      110 h | aero.aew, sensors.radar3       |
| KJ-2000               | `cn.kj-2000`              | Chine (CN)      |        $250 M |            $44 k |  4   |  2007   |      120 h | aero.aew, sensors.radar2       |
| Y-20                  | `cn.y-20`                 | Chine (CN)      |        $160 M |            $29 k |  4   |  2016   |      100 h | aero.transport                 |
| YY-20                 | `cn.yy-20`                | Chine (CN)      |        $180 M |            $32 k |  4   |  2021   |      100 h | aero.tanker                    |
| Y-9                   | `cn.y-9`                  | Chine (CN)      |         $50 M |            $11 k |  3   |  2012   |       56 h | aero.transport                 |
| K-8 Karakorum         | `cn.k-8-karakorum`        | Chine (CN)      |          $7 M |             $4 k |  3   |  1994   |       14 h | aero.gen3                      |
| A400M Atlas           | `eu.a400m-atlas`          | Europe (FR)     |        $170 M |            $35 k |  4   |  2013   |      100 h | aero.transport                 |
| A330 MRTT             | `eu.a330-mrtt`            | Europe (FR)     |        $300 M |            $56 k |  4   |  2011   |      110 h | aero.tanker                    |
| GlobalEye             | `eu.globaleye`            | Europe (SE)     |        $380 M |            $69 k |  5   |  2020   |      120 h | aero.aew, sensors.radar3       |
| C-295                 | `eu.c-295`                | Europe (ES)     |         $35 M |            $12 k |  4   |  2001   |       40 h | aero.transport                 |
| Mirage F1             | `eu.mirage-f1`            | Europe (FR)     |         $15 M |             $9 k |  3   |  1973   |       18 h | aero.gen3                      |
| Mirage 5              | `eu.mirage-5`             | Europe (FR)     |          $8 M |             $8 k |  2   |  1967   |       12 h | aero.gen2                      |
| Alpha Jet             | `eu.alpha-jet`            | Europe (FR)     |          $8 M |             $8 k |  3   |  1977   |       14 h | aero.gen3                      |
| Hawk                  | `eu.hawk`                 | Europe (GB)     |         $22 M |            $10 k |  3   |  1976   |       16 h | aero.gen3                      |
| FA-50                 | `other.fa-50`             | Autres (KR)     |         $40 M |             $9 k |  4   |  2013   |       26 h | aero.gen4                      |
| A-29 Super Tucano     | `other.a-29-super-tucano` | Autres (BR)     |         $14 M |             $5 k |  3   |  2003   |       14 h | aero.gen3                      |
| L-39 Albatros         | `other.l-39-albatros`     | Autres (CZ)     |          $6 M |             $4 k |  2   |  1972   |       12 h | aero.gen2                      |
| F-14 Tomcat           | `other.f-14-tomcat`       | Autres (US)     |         $75 M |            $15 k |  4   |  1974   |       44 h | aero.gen4                      |

### Hélicoptères (23)

| Système          | Identifiant           | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes     |
| ---------------- | --------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ---------- |
| AH-64 Apache     | `us.ah-64-apache`     | États-Unis (US) |         $35 M |             $8 k |  4   |  1986   |       28 h | aero.helo3 |
| Ka-52 Alligator  | `ru.ka-52`            | Russie (RU)     |         $16 M |             $4 k |  4   |  2011   |       26 h | aero.helo3 |
| AH-1Z Viper      | `us.ah-1z-viper`      | États-Unis (US) |         $31 M |             $7 k |  4   |  2010   |       26 h | aero.helo3 |
| AH-1 Cobra       | `us.ah-1-cobra`       | États-Unis (US) |         $12 M |             $4 k |  3   |  1967   |       18 h | aero.helo2 |
| UH-60 Black Hawk | `us.uh-60-black-hawk` | États-Unis (US) |         $21 M |             $5 k |  4   |  1979   |       20 h | aero.helo2 |
| CH-47 Chinook    | `us.ch-47-chinook`    | États-Unis (US) |         $40 M |             $9 k |  4   |  1962   |       24 h | aero.helo2 |
| MH-60R Seahawk   | `us.mh-60r-seahawk`   | États-Unis (US) |         $40 M |             $9 k |  4   |  2006   |       22 h | aero.helo2 |
| UH-1 Huey        | `us.uh-1-huey`        | États-Unis (US) |          $4 M |             $2 k |  2   |  1959   |       10 h | aero.helo1 |
| Mi-28NM          | `ru.mi-28nm`          | Russie (RU)     |         $18 M |             $4 k |  4   |  2009   |       24 h | aero.helo3 |
| Mi-24            | `ru.mi-24`            | Russie (RU)     |         $12 M |             $3 k |  3   |  1972   |       20 h | aero.helo2 |
| Mi-8             | `ru.mi-8`             | Russie (RU)     |         $12 M |             $3 k |  2   |  1967   |       14 h | aero.helo1 |
| Ka-27            | `ru.ka-27`            | Russie (RU)     |         $15 M |             $3 k |  3   |  1982   |       20 h | aero.helo2 |
| Mi-2             | `ru.mi-2`             | Russie (RU)     |          $1 M |             $600 |  1   |  1965   |        6 h | aero.helo1 |
| Z-10             | `cn.z-10`             | Chine (CN)      |         $20 M |             $4 k |  4   |  2012   |       22 h | aero.helo3 |
| Z-19             | `cn.z-19`             | Chine (CN)      |         $12 M |             $3 k |  3   |  2012   |       16 h | aero.helo2 |
| Z-20             | `cn.z-20`             | Chine (CN)      |         $25 M |             $5 k |  4   |  2019   |       20 h | aero.helo2 |
| Z-9              | `cn.z-9`              | Chine (CN)      |          $6 M |             $2 k |  3   |  1994   |       12 h | aero.helo1 |
| Tigre            | `eu.tigre`            | Europe (FR)     |         $45 M |            $10 k |  4   |  2005   |       26 h | aero.helo3 |
| NH90             | `eu.nh90`             | Europe (FR)     |         $40 M |             $9 k |  4   |  2007   |       22 h | aero.helo2 |
| AW101            | `eu.aw101`            | Europe (IT)     |         $50 M |            $11 k |  4   |  1999   |       24 h | aero.helo2 |
| Gazelle          | `eu.gazelle`          | Europe (FR)     |          $3 M |             $2 k |  2   |  1973   |        8 h | aero.helo2 |
| SA 330 Puma      | `eu.sa-330-puma`      | Europe (FR)     |          $8 M |             $3 k |  2   |  1968   |       12 h | aero.helo1 |
| T129 ATAK        | `other.t129-atak`     | Autres (TR)     |         $28 M |             $6 k |  4   |  2014   |       22 h | aero.helo3 |

### Drones et munitions rôdeuses (24)

| Système          | Identifiant           | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes       |
| ---------------- | --------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ------------ |
| MQ-9 Reaper      | `us.mq-9-reaper`      | États-Unis (US) |         $30 M |             $7 k |  4   |  2007   |       24 h | aero.drones2 |
| Orion            | `ru.orion`            | Russie (RU)     |          $6 M |             $2 k |  4   |  2020   |       16 h | aero.drones2 |
| Bayraktar TB2    | `other.bayraktar-tb2` | Autres (TR)     |          $5 M |             $1 k |  4   |  2014   |       12 h | aero.drones2 |
| RQ-4 Global Hawk | `us.rq-4-global-hawk` | États-Unis (US) |        $130 M |            $29 k |  4   |  2001   |       60 h | aero.drones2 |
| MQ-1C Gray Eagle | `us.mq-1c-gray-eagle` | États-Unis (US) |         $21 M |             $5 k |  4   |  2009   |       20 h | aero.drones2 |
| Switchblade 600  | `us.switchblade-600`  | États-Unis (US) |        $120 k |               $7 |  4   |  2021   |        2 h | aero.drones1 |
| ScanEagle        | `us.scaneagle`        | États-Unis (US) |        $200 k |             $590 |  3   |  2005   |        3 h | aero.drones1 |
| Forpost          | `ru.forpost`          | Russie (RU)     |          $5 M |             $1 k |  3   |  2012   |       14 h | aero.drones2 |
| S-70 Okhotnik    | `ru.s-70-okhotnik`    | Russie (RU)     |         $80 M |            $18 k |  5   |  2024   |       72 h | aero.drones3 |
| Lancet           | `ru.lancet`           | Russie (RU)     |         $35 k |               $2 |  4   |  2019   |        2 h | aero.drones1 |
| Geran-2          | `ru.geran-2`          | Russie (RU)     |         $80 k |               $4 |  3   |  2022   |        3 h | aero.drones1 |
| Orlan-10         | `ru.orlan-10`         | Russie (RU)     |        $100 k |             $190 |  3   |  2010   |        2 h | aero.drones1 |
| Wing Loong II    | `cn.wing-loong-ii`    | Chine (CN)      |          $2 M |             $600 |  4   |  2017   |       14 h | aero.drones2 |
| CH-4             | `cn.ch-4`             | Chine (CN)      |          $4 M |             $1 k |  3   |  2014   |       12 h | aero.drones2 |
| CH-5             | `cn.ch-5`             | Chine (CN)      |         $12 M |             $3 k |  4   |  2017   |       18 h | aero.drones2 |
| GJ-11            | `cn.gj-11`            | Chine (CN)      |         $60 M |            $13 k |  5   |  2019   |       64 h | aero.drones3 |
| Patroller        | `eu.patroller`        | Europe (FR)     |         $15 M |             $4 k |  4   |  2024   |       16 h | aero.drones2 |
| Eurodrone        | `eu.eurodrone`        | Europe (DE)     |         $80 M |            $18 k |  5   |  2025   |       48 h | aero.drones2 |
| Akinci           | `other.akinci`        | Autres (TR)     |         $15 M |             $4 k |  4   |  2021   |       20 h | aero.drones2 |
| Heron TP         | `other.heron-tp`      | Autres (IL)     |         $35 M |             $8 k |  4   |  2010   |       24 h | aero.drones2 |
| Harop            | `other.harop`         | Autres (IL)     |        $800 k |              $44 |  4   |  2009   |        4 h | aero.drones1 |
| Hermes 900       | `other.hermes-900`    | Autres (IL)     |         $20 M |             $4 k |  4   |  2012   |       18 h | aero.drones2 |
| Shahed-136       | `other.shahed-136`    | Autres (IR)     |         $50 k |               $3 |  3   |  2021   |        3 h | aero.drones1 |
| Mohajer-6        | `other.mohajer-6`     | Autres (IR)     |          $2 M |             $600 |  3   |  2018   |       12 h | aero.drones2 |

### Chars (27)

| Système          | Identifiant              | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes    |
| ---------------- | ------------------------ | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | --------- |
| M1A2 Abrams      | `us.m1a2-abrams`         | États-Unis (US) |         $10 M |             $3 k |  4   |  1980   |       30 h | land.gen4 |
| T-90M            | `ru.t-90m`               | Russie (RU)     |        $4,5 M |             $1 k |  4   |  1992   |       26 h | land.gen4 |
| Type 99A         | `cn.type-99a`            | Chine (CN)      |          $6 M |             $1 k |  4   |  2001   |       28 h | land.gen4 |
| Leopard 2A7      | `eu.leopard-2a7`         | Europe (DE)     |         $11 M |             $3 k |  4   |  1979   |       32 h | land.gen4 |
| Leclerc          | `eu.leclerc`             | Europe (FR)     |         $12 M |             $3 k |  4   |  1992   |       30 h | land.gen4 |
| M60 Patton       | `us.m60-patton`          | États-Unis (US) |          $5 M |             $2 k |  2   |  1960   |       18 h | land.gen2 |
| T-72B3           | `ru.t-72b3`              | Russie (RU)     |          $3 M |             $820 |  3   |  2013   |       20 h | land.gen3 |
| T-80BVM          | `ru.t-80bvm`             | Russie (RU)     |          $4 M |             $990 |  4   |  1976   |       24 h | land.gen4 |
| T-14 Armata      | `ru.t-14-armata`         | Russie (RU)     |          $8 M |             $2 k |  5   |  2021   |       40 h | land.gen5 |
| T-72             | `ru.t-72`                | Russie (RU)     |          $2 M |             $660 |  3   |  1973   |       16 h | land.gen3 |
| T-62             | `ru.t-62`                | Russie (RU)     |          $1 M |             $490 |  2   |  1961   |       14 h | land.gen2 |
| T-55             | `ru.t-55`                | Russie (RU)     |        $600 k |             $430 |  1   |  1958   |       12 h | land.gen1 |
| Type 96B         | `cn.type-96b`            | Chine (CN)      |        $2,5 M |             $740 |  3   |  1997   |       18 h | land.gen3 |
| Type 15          | `cn.type-15`             | Chine (CN)      |        $3,5 M |             $900 |  4   |  2018   |       20 h | land.gen4 |
| VT4              | `cn.vt4`                 | Chine (CN)      |          $5 M |             $1 k |  4   |  2014   |       26 h | land.gen4 |
| Type 59          | `cn.type-59`             | Chine (CN)      |        $500 k |             $410 |  1   |  1959   |       12 h | land.gen1 |
| Challenger 3     | `eu.challenger-3`        | Europe (GB)     |         $10 M |             $2 k |  4   |  2025   |       34 h | land.gen4 |
| Challenger 2     | `eu.challenger-2`        | Europe (GB)     |          $9 M |             $2 k |  4   |  1998   |       32 h | land.gen4 |
| Ariete           | `eu.ariete`              | Europe (IT)     |          $7 M |             $2 k |  4   |  1995   |       28 h | land.gen4 |
| Leopard 1        | `eu.leopard-1`           | Europe (DE)     |          $3 M |             $1 k |  2   |  1965   |       16 h | land.gen2 |
| AMX-30           | `eu.amx-30`              | Europe (FR)     |        $2,5 M |             $1 k |  2   |  1966   |       16 h | land.gen2 |
| K2 Black Panther | `other.k2-black-panther` | Autres (KR)     |          $9 M |             $2 k |  4   |  2014   |       32 h | land.gen4 |
| Merkava IV       | `other.merkava-iv`       | Autres (IL)     |          $6 M |             $1 k |  4   |  2004   |       30 h | land.gen4 |
| Altay            | `other.altay`            | Autres (TR)     |         $10 M |             $2 k |  4   |  2025   |       30 h | land.gen4 |
| Arjun            | `other.arjun`            | Autres (IN)     |          $8 M |             $2 k |  4   |  2004   |       30 h | land.gen4 |
| Al-Khalid        | `other.al-khalid`        | Autres (PK)     |          $4 M |             $990 |  3   |  2001   |       22 h | land.gen3 |
| PT-91 Twardy     | `other.pt-91-twardy`     | Autres (PL)     |          $3 M |             $820 |  3   |  1995   |       20 h | land.gen3 |

### Véhicules de combat d’infanterie et transports blindés (21)

| Système    | Identifiant     | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes    |
| ---------- | --------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | --------- |
| M2 Bradley | `us.m2-bradley` | États-Unis (US) |        $4,5 M |             $1 k |  4   |  1981   |       18 h | land.gen3 |
| BMP-3      | `ru.bmp-3`      | Russie (RU)     |        $1,5 M |             $450 |  4   |  1987   |       16 h | land.gen3 |
| Stryker    | `us.stryker`    | États-Unis (US) |          $5 M |             $2 k |  4   |  2002   |       16 h | land.gen4 |
| AMPV       | `us.ampv`       | États-Unis (US) |          $4 M |             $1 k |  4   |  2020   |       14 h | land.gen4 |
| M113       | `us.m113`       | États-Unis (US) |        $800 k |             $820 |  2   |  1960   |        8 h | land.gen2 |
| BMP-2      | `ru.bmp-2`      | Russie (RU)     |        $800 k |             $340 |  3   |  1980   |       12 h | land.gen3 |
| BMP-1      | `ru.bmp-1`      | Russie (RU)     |        $500 k |             $290 |  2   |  1966   |       10 h | land.gen2 |
| BTR-82A    | `ru.btr-82a`    | Russie (RU)     |        $700 k |             $320 |  3   |  2013   |       10 h | land.gen3 |
| BTR-80     | `ru.btr-80`     | Russie (RU)     |        $400 k |             $270 |  3   |  1986   |        8 h | land.gen3 |
| BRDM-2     | `ru.brdm-2`     | Russie (RU)     |        $200 k |             $240 |  1   |  1962   |        6 h | land.gen1 |
| MT-LB      | `ru.mt-lb`      | Russie (RU)     |        $300 k |             $250 |  2   |  1964   |        6 h | land.gen2 |
| ZBD-04A    | `cn.zbd-04a`    | Chine (CN)      |        $1,5 M |             $450 |  4   |  2011   |       14 h | land.gen4 |
| ZBL-08     | `cn.zbl-08`     | Chine (CN)      |        $1,2 M |             $400 |  4   |  2009   |       12 h | land.gen4 |
| Type 63    | `cn.type-63`    | Chine (CN)      |        $200 k |             $240 |  1   |  1963   |        6 h | land.gen1 |
| CV90       | `eu.cv90`       | Europe (SE)     |          $8 M |             $2 k |  4   |  1993   |       18 h | land.gen4 |
| Puma       | `eu.puma`       | Europe (DE)     |         $15 M |             $3 k |  5   |  2015   |       24 h | land.gen5 |
| VBCI       | `eu.vbci`       | Europe (FR)     |          $5 M |             $1 k |  4   |  2008   |       16 h | land.gen4 |
| Boxer      | `eu.boxer`      | Europe (DE)     |          $9 M |             $2 k |  4   |  2011   |       18 h | land.gen4 |
| Patria AMV | `eu.patria-amv` | Europe (FI)     |          $4 M |             $1 k |  4   |  2004   |       14 h | land.gen4 |
| VAB        | `eu.vab`        | Europe (FR)     |        $800 k |             $680 |  2   |  1976   |        8 h | land.gen2 |
| Namer      | `other.namer`   | Autres (IL)     |          $3 M |             $700 |  4   |  2008   |       18 h | land.gen4 |

### Artillerie et lance-roquettes (25)

| Système            | Identifiant          | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes               |
| ------------------ | -------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | -------------------- |
| M109 Paladin       | `us.m109-paladin`    | États-Unis (US) |         $14 M |             $3 k |  4   |  1963   |       24 h | land.gen3            |
| 2S19 Msta-S        | `ru.2s19-msta`       | Russie (RU)     |          $3 M |             $740 |  4   |  1989   |       22 h | land.gen3            |
| CAESAR             | `eu.caesar`          | Europe (FR)     |          $6 M |             $2 k |  4   |  2008   |       20 h | land.gen4            |
| M777               | `us.m777`            | États-Unis (US) |        $3,5 M |             $2 k |  4   |  2005   |       12 h | land.gen4            |
| M142 HIMARS        | `us.m142-himars`     | États-Unis (US) |          $5 M |             $2 k |  4   |  2005   |       18 h | land.gen4, land.mlrs |
| M270 MLRS          | `us.m270-mlrs`       | États-Unis (US) |          $6 M |             $2 k |  3   |  1983   |       20 h | land.gen3, land.mlrs |
| 2S35 Koalitsiya-SV | `ru.2s35-koalitsiya` | Russie (RU)     |          $8 M |             $1 k |  5   |  2023   |       30 h | land.gen5            |
| 2S7 Pion           | `ru.2s7-pion`        | Russie (RU)     |        $2,5 M |             $670 |  2   |  1976   |       18 h | land.gen2            |
| 2S1 Gvozdika       | `ru.2s1-gvozdika`    | Russie (RU)     |        $700 k |             $420 |  2   |  1971   |       10 h | land.gen2            |
| 2S3 Akatsiya       | `ru.2s3-akatsiya`    | Russie (RU)     |          $1 M |             $470 |  2   |  1971   |       12 h | land.gen2            |
| D-30               | `ru.d-30`            | Russie (RU)     |        $200 k |             $360 |  2   |  1963   |        6 h | land.gen2            |
| BM-21 Grad         | `ru.bm-21-grad`      | Russie (RU)     |        $500 k |             $400 |  2   |  1963   |        8 h | land.gen2            |
| BM-27 Uragan       | `ru.bm-27-uragan`    | Russie (RU)     |        $1,5 M |             $530 |  3   |  1975   |       14 h | land.gen3, land.mlrs |
| BM-30 Smerch       | `ru.bm-30-smerch`    | Russie (RU)     |          $3 M |             $740 |  3   |  1989   |       16 h | land.gen3, land.mlrs |
| Tornado-S          | `ru.tornado-s`       | Russie (RU)     |          $5 M |             $1 k |  4   |  2016   |       20 h | land.gen4, land.mlrs |
| TOS-1A             | `ru.tos-1a`          | Russie (RU)     |          $5 M |             $1 k |  3   |  2001   |       18 h | land.gen3, land.mlrs |
| PLZ-05             | `cn.plz-05`          | Chine (CN)      |          $3 M |             $740 |  4   |  2008   |       20 h | land.gen4            |
| PHL-03             | `cn.phl-03`          | Chine (CN)      |          $3 M |             $740 |  4   |  2004   |       16 h | land.gen4, land.mlrs |
| PHL-16             | `cn.phl-16`          | Chine (CN)      |          $5 M |             $1 k |  4   |  2019   |       20 h | land.gen4, land.mlrs |
| PzH 2000           | `eu.pzh-2000`        | Europe (DE)     |         $14 M |             $3 k |  4   |  1998   |       26 h | land.gen4            |
| Archer             | `eu.archer`          | Europe (SE)     |          $8 M |             $2 k |  4   |  2016   |       22 h | land.gen4            |
| K9 Thunder         | `other.k9-thunder`   | Autres (KR)     |          $4 M |             $880 |  4   |  1999   |       22 h | land.gen4            |
| K239 Chunmoo       | `other.k239-chunmoo` | Autres (KR)     |          $6 M |             $1 k |  4   |  2015   |       20 h | land.gen4, land.mlrs |
| Pinaka             | `other.pinaka`       | Autres (IN)     |          $3 M |             $740 |  4   |  2000   |       16 h | land.gen4, land.mlrs |
| Fajr-5             | `other.fajr-5`       | Autres (IR)     |        $1,5 M |             $530 |  3   |  1996   |       12 h | land.gen3, land.mlrs |

### Infanterie (25)

| Système                           | Identifiant            | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes          |
| --------------------------------- | ---------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | --------------- |
| Infanterie légère (États-Unis)    | `us.infantry-light`    | États-Unis (US) |         $20 M |           $120 k |  4   |  1950   |        8 h | —               |
| Infanterie mécanisée (États-Unis) | `us.infantry-mech`     | États-Unis (US) |         $45 M |           $120 k |  4   |  1960   |       14 h | land.gen2       |
| Infanterie légère (Russie)        | `ru.infantry-light`    | Russie (RU)     |          $8 M |            $36 k |  3   |  1950   |        8 h | —               |
| Infanterie mécanisée (Russie)     | `ru.infantry-mech`     | Russie (RU)     |         $20 M |            $37 k |  3   |  1960   |       14 h | land.gen2       |
| Infanterie légère (Chine)         | `cn.infantry-light`    | Chine (CN)      |          $7 M |            $35 k |  3   |  1950   |        8 h | —               |
| Infanterie mécanisée (Chine)      | `cn.infantry-mech`     | Chine (CN)      |         $18 M |            $37 k |  3   |  1960   |       14 h | land.gen2       |
| Infanterie légère (Europe)        | `eu.infantry-light`    | Europe (EU)     |         $18 M |            $95 k |  4   |  1950   |        8 h | —               |
| Infanterie mécanisée (Europe)     | `eu.infantry-mech`     | Europe (EU)     |         $40 M |            $98 k |  4   |  1960   |       14 h | land.gen2       |
| Infanterie légère (générique)     | `other.infantry-light` | Autres (XX)     |          $5 M |            $35 k |  2   |  1950   |        8 h | —               |
| Infanterie mécanisée (générique)  | `other.infantry-mech`  | Autres (XX)     |         $12 M |            $36 k |  2   |  1960   |       14 h | land.gen2       |
| Infanterie de marine (États-Unis) | `us.marines`           | États-Unis (US) |         $35 M |           $120 k |  4   |  1950   |       16 h | naval.gen2      |
| Forces spéciales (États-Unis)     | `us.special-forces`    | États-Unis (US) |         $40 M |           $120 k |  4   |  1960   |       22 h | intel.military1 |
| Troupes aéroportées (États-Unis)  | `us.airborne`          | États-Unis (US) |         $30 M |           $120 k |  4   |  1950   |       18 h | aero.transport  |
| Infanterie de marine (Russie)     | `ru.naval-infantry`    | Russie (RU)     |         $12 M |            $36 k |  3   |  1950   |       16 h | naval.gen2      |
| Spetsnaz (Russie)                 | `ru.spetsnaz`          | Russie (RU)     |         $15 M |            $37 k |  3   |  1960   |       22 h | intel.military1 |
| Troupes aéroportées VDV (Russie)  | `ru.vdv-airborne`      | Russie (RU)     |         $25 M |            $38 k |  3   |  1950   |       18 h | aero.transport  |
| Infanterie de marine (Chine)      | `cn.marines`           | Chine (CN)      |         $10 M |            $36 k |  3   |  1950   |       16 h | naval.gen2      |
| Forces spéciales (Chine)          | `cn.special-forces`    | Chine (CN)      |         $12 M |            $36 k |  3   |  1960   |       22 h | intel.military1 |
| Troupes aéroportées (Chine)       | `cn.airborne`          | Chine (CN)      |         $12 M |            $36 k |  3   |  1950   |       18 h | aero.transport  |
| Infanterie de marine (Europe)     | `eu.marines`           | Europe (EU)     |         $25 M |            $95 k |  4   |  1950   |       16 h | naval.gen2      |
| Forces spéciales (Europe)         | `eu.special-forces`    | Europe (EU)     |         $30 M |            $96 k |  4   |  1960   |       22 h | intel.military1 |
| Troupes aéroportées (Europe)      | `eu.airborne`          | Europe (EU)     |         $22 M |            $95 k |  4   |  1950   |       18 h | aero.transport  |
| Infanterie de marine (générique)  | `other.marines`        | Autres (XX)     |          $7 M |            $35 k |  3   |  1950   |       16 h | naval.gen2      |
| Forces spéciales (générique)      | `other.special-forces` | Autres (XX)     |          $8 M |            $36 k |  3   |  1960   |       22 h | intel.military1 |
| Troupes aéroportées (générique)   | `other.airborne`       | Autres (XX)     |          $7 M |            $35 k |  3   |  1950   |       18 h | aero.transport  |

### Défense aérienne et guerre électronique (37)

| Système                                        | Identifiant          | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes                      |
| ---------------------------------------------- | -------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | --------------------------- |
| MIM-104 Patriot                                | `us.patriot`         | États-Unis (US) |       $1,1 Md |           $170 k |  4   |  1984   |       48 h | missiles.sam3               |
| S-400 Triumf                                   | `ru.s-400`           | Russie (RU)     |        $500 M |            $91 k |  4   |  2007   |       52 h | missiles.sam4               |
| Pantsir-S1                                     | `ru.pantsir-s1`      | Russie (RU)     |         $14 M |             $2 k |  4   |  2012   |       24 h | missiles.sam4               |
| Mistral                                        | `eu.mistral`         | Europe (FR)     |        $4,5 M |             $2 k |  4   |  1988   |       10 h | missiles.sam3               |
| Krasukha-4                                     | `ru.krasukha-4`      | Russie (RU)     |         $30 M |             $4 k |  4   |  2014   |       24 h | land.ew                     |
| NASAMS                                         | `us.nasams`          | États-Unis (US) |        $150 M |            $44 k |  4   |  1998   |       48 h | missiles.sam4               |
| Avenger                                        | `us.avenger`         | États-Unis (US) |          $3 M |             $2 k |  3   |  1989   |       12 h | missiles.sam3               |
| THAAD                                          | `us.thaad`           | États-Unis (US) |         $2 Md |           $300 k |  5   |  2008   |      110 h | missiles.sam5, missiles.abm |
| Stinger                                        | `us.stinger`         | États-Unis (US) |          $6 M |             $2 k |  3   |  1981   |        6 h | missiles.sam3               |
| MIM-23 Hawk                                    | `us.mim-23-hawk`     | États-Unis (US) |        $120 M |            $40 k |  2   |  1960   |       40 h | missiles.sam1               |
| Brouilleur de guerre électronique (États-Unis) | `us.ew-jammer`       | États-Unis (US) |         $25 M |             $5 k |  4   |  2020   |       24 h | land.ew                     |
| Tor-M2                                         | `ru.tor-m2`          | Russie (RU)     |         $25 M |             $4 k |  4   |  1986   |       24 h | missiles.sam4               |
| Buk-M3                                         | `ru.buk-m3`          | Russie (RU)     |        $120 M |            $39 k |  4   |  1980   |       44 h | missiles.sam3               |
| S-300PMU2                                      | `ru.s-300pmu2`       | Russie (RU)     |        $250 M |            $57 k |  4   |  1978   |       48 h | missiles.sam3               |
| S-500 Prometey                                 | `ru.s-500`           | Russie (RU)     |        $700 M |           $120 k |  5   |  2021   |       96 h | missiles.sam5, missiles.abm |
| Igla                                           | `ru.igla`            | Russie (RU)     |        $1,5 M |             $620 |  3   |  1983   |        6 h | missiles.sam3               |
| S-75 Dvina                                     | `ru.s-75-dvina`      | Russie (RU)     |         $40 M |            $28 k |  1   |  1957   |       36 h | missiles.sam1               |
| S-125 Neva/Pechora                             | `ru.s-125-neva`      | Russie (RU)     |         $30 M |            $26 k |  2   |  1961   |       30 h | missiles.sam1               |
| 2K12 Kub                                       | `ru.2k12-kub`        | Russie (RU)     |         $25 M |            $26 k |  2   |  1967   |       28 h | missiles.sam2               |
| 9K33 Osa                                       | `ru.9k33-osa`        | Russie (RU)     |          $5 M |             $1 k |  2   |  1972   |       14 h | missiles.sam2               |
| ZSU-23-4 Shilka                                | `ru.zsu-23-4-shilka` | Russie (RU)     |          $1 M |             $550 |  2   |  1965   |       10 h | missiles.sam1               |
| Strela-10                                      | `ru.strela-10`       | Russie (RU)     |          $2 M |             $680 |  2   |  1976   |       10 h | missiles.sam2               |
| HQ-9B                                          | `cn.hq-9b`           | Chine (CN)      |        $300 M |            $63 k |  4   |  2017   |       56 h | missiles.sam4               |
| HQ-16                                          | `cn.hq-16`           | Chine (CN)      |        $100 M |            $36 k |  4   |  2011   |       40 h | missiles.sam4               |
| HQ-17                                          | `cn.hq-17`           | Chine (CN)      |         $15 M |             $2 k |  4   |  2015   |       22 h | missiles.sam4               |
| HQ-7                                           | `cn.hq-7`            | Chine (CN)      |          $8 M |             $2 k |  3   |  1991   |       14 h | missiles.sam2               |
| Brouilleur de guerre électronique (Chine)      | `cn.ew-jammer`       | Chine (CN)      |         $20 M |             $3 k |  4   |  2015   |       22 h | land.ew                     |
| SAMP/T                                         | `eu.samp-t`          | Europe (FR)     |        $700 M |           $120 k |  4   |  2001   |       72 h | missiles.sam4               |
| IRIS-T SLM                                     | `eu.iris-t-slm`      | Europe (DE)     |        $170 M |            $46 k |  4   |  2022   |       44 h | missiles.sam4               |
| Skynex                                         | `eu.skynex`          | Europe (DE)     |         $80 M |            $34 k |  4   |  2021   |       30 h | missiles.sam4               |
| Gepard                                         | `eu.gepard`          | Europe (DE)     |          $3 M |             $2 k |  2   |  1976   |       12 h | missiles.sam2               |
| Crotale                                        | `eu.crotale`         | Europe (FR)     |         $15 M |             $3 k |  2   |  1971   |       16 h | missiles.sam2               |
| Dôme de fer                                    | `other.iron-dome`    | Autres (IL)     |        $100 M |            $36 k |  4   |  2011   |       40 h | missiles.sam4               |
| Fronde de David                                | `other.davids-sling` | Autres (IL)     |        $400 M |            $77 k |  4   |  2017   |       64 h | missiles.sam4               |
| Arrow 3                                        | `other.arrow-3`      | Autres (IL)     |       $1,4 Md |           $210 k |  5   |  2017   |      110 h | missiles.sam5, missiles.abm |
| Bavar-373                                      | `other.bavar-373`    | Autres (IR)     |        $150 M |            $43 k |  4   |  2019   |       56 h | missiles.sam4               |
| Akash                                          | `other.akash`        | Autres (IN)     |         $80 M |            $33 k |  4   |  2014   |       40 h | missiles.sam4               |

### Radars terrestres (23)

| Système                          | Identifiant                  | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes         |
| -------------------------------- | ---------------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | -------------- |
| AN/TPY-2                         | `us.an-tpy-2`                | États-Unis (US) |        $550 M |            $78 k |  5   |  2006   |       96 h | sensors.radar3 |
| AN/FPS-132 UEWR                  | `us.an-fps-132-uewr`         | États-Unis (US) |         $1 Md |           $140 k |  4   |  1980   |      480 h | sensors.radar2 |
| AN/TPS-80 G/ATOR                 | `us.an-tps-80-g-ator`        | États-Unis (US) |         $40 M |             $8 k |  5   |  2018   |       30 h | sensors.radar3 |
| AN/TPS-75                        | `us.an-tps-75`               | États-Unis (US) |         $15 M |             $5 k |  3   |  1968   |       20 h | sensors.radar1 |
| Rezonans-NE                      | `ru.rezonans-ne`             | Russie (RU)     |        $120 M |            $17 k |  5   |  2008   |      120 h | sensors.radar3 |
| Nebo-M                           | `ru.nebo-m`                  | Russie (RU)     |        $100 M |            $15 k |  5   |  2017   |       72 h | sensors.radar3 |
| Voronezh-DM                      | `ru.voronezh-dm`             | Russie (RU)     |        $300 M |            $42 k |  5   |  2012   |      360 h | sensors.radar3 |
| Konteyner 29B6                   | `ru.container-29b6`          | Russie (RU)     |        $300 M |            $42 k |  5   |  2019   |      360 h | sensors.radar3 |
| Podsolnukh-E                     | `ru.podsolnukh-e`            | Russie (RU)     |         $50 M |             $8 k |  4   |  2008   |       96 h | sensors.radar2 |
| Protivnik-GE                     | `ru.protivnik-ge`            | Russie (RU)     |         $30 M |             $5 k |  5   |  2012   |       30 h | sensors.radar3 |
| P-18                             | `ru.p-18`                    | Russie (RU)     |          $3 M |             $1 k |  2   |  1970   |       10 h | sensors.radar1 |
| JY-27A                           | `cn.jy-27a`                  | Chine (CN)      |         $40 M |             $6 k |  5   |  2015   |       30 h | sensors.radar3 |
| YLC-8B                           | `cn.ylc-8b`                  | Chine (CN)      |         $40 M |             $6 k |  5   |  2014   |       30 h | sensors.radar3 |
| JY-26                            | `cn.jy-26`                   | Chine (CN)      |         $20 M |             $4 k |  5   |  2014   |       24 h | sensors.radar3 |
| Radar à grande antenne Type 7010 | `cn.type-7010-lpar`          | Chine (CN)      |        $500 M |            $69 k |  5   |  2015   |      360 h | sensors.radar3 |
| Ground Master 400                | `eu.ground-master-400`       | Europe (FR)     |         $30 M |             $6 k |  5   |  2012   |       30 h | sensors.radar3 |
| SMART-L EWC                      | `eu.smart-l-ewc`             | Europe (NL)     |        $150 M |            $23 k |  5   |  2021   |      120 h | sensors.radar3 |
| TRML-4D                          | `eu.trml-4d`                 | Europe (DE)     |         $25 M |             $6 k |  5   |  2018   |       24 h | sensors.radar3 |
| EL/M-2084                        | `other.el-m-2084`            | Autres (IL)     |         $50 M |             $8 k |  5   |  2011   |       30 h | sensors.radar3 |
| EL/M-2080 Green Pine             | `other.el-m-2080-green-pine` | Autres (IL)     |        $200 M |            $28 k |  5   |  2000   |       72 h | sensors.radar3 |
| Ghadir                           | `other.ghadir-oth`           | Autres (IR)     |        $100 M |            $15 k |  4   |  2013   |      240 h | sensors.radar2 |
| Sepehr                           | `other.sepehr-oth`           | Autres (IR)     |        $150 M |            $21 k |  5   |  2019   |      300 h | sensors.radar3 |
| Swordfish LRTR                   | `other.swordfish-lrtr`       | Autres (IN)     |        $200 M |            $28 k |  5   |  2012   |      240 h | sensors.radar3 |

### Missiles de frappe (30)

| Système              | Identifiant             | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes                                 |
| -------------------- | ----------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | -------------------------------------- |
| BGM-109 Tomahawk     | `us.tomahawk`           | États-Unis (US) |          $2 M |             $110 |  4   |  1983   |        8 h | missiles.cruise1                       |
| AGM-158B JASSM-ER    | `us.jassm-er`           | États-Unis (US) |        $1,5 M |              $82 |  5   |  2014   |        8 h | missiles.cruise2                       |
| MGM-140 ATACMS       | `us.atacms`             | États-Unis (US) |        $1,5 M |              $82 |  4   |  1991   |        8 h | missiles.ballistic2                    |
| PrSM                 | `us.prsm`               | États-Unis (US) |        $1,6 M |              $88 |  5   |  2023   |       10 h | missiles.ballistic2                    |
| AGM-88 HARM          | `us.agm-88-harm`        | États-Unis (US) |        $900 k |              $49 |  4   |  1985   |        6 h | missiles.cruise1                       |
| RGM-84 Harpoon       | `us.harpoon`            | États-Unis (US) |        $1,5 M |              $82 |  3   |  1977   |        6 h | missiles.antiship                      |
| 3M-14 Kalibr         | `ru.kalibr`             | Russie (RU)     |        $1,2 M |              $66 |  4   |  2012   |        8 h | missiles.cruise1                       |
| 9K720 Iskander-M     | `ru.iskander-m`         | Russie (RU)     |          $3 M |             $160 |  4   |  2006   |       10 h | missiles.ballistic2                    |
| Kh-101               | `ru.kh-101`             | Russie (RU)     |         $13 M |             $710 |  5   |  2013   |       10 h | missiles.cruise2                       |
| Kh-47M2 Kinzhal      | `ru.kinzhal`            | Russie (RU)     |         $10 M |             $550 |  5   |  2017   |       20 h | missiles.hypersonic                    |
| 3M22 Zircon          | `ru.zircon`             | Russie (RU)     |         $10 M |             $550 |  5   |  2023   |       22 h | missiles.hypersonic, missiles.antiship |
| P-800 Oniks          | `ru.p-800-oniks`        | Russie (RU)     |          $3 M |             $160 |  4   |  2002   |       10 h | missiles.antiship                      |
| OTR-21 Tochka-U      | `ru.tochka-u`           | Russie (RU)     |        $800 k |              $44 |  3   |  1975   |        6 h | missiles.ballistic1                    |
| R-17 Scud-B          | `ru.scud-b`             | Russie (RU)     |          $1 M |              $55 |  2   |  1964   |        8 h | missiles.ballistic1                    |
| CJ-10                | `cn.cj-10`              | Chine (CN)      |        $1,5 M |              $82 |  4   |  2009   |        8 h | missiles.cruise1                       |
| DF-15                | `cn.df-15`              | Chine (CN)      |        $1,5 M |              $82 |  4   |  1990   |       10 h | missiles.ballistic2                    |
| DF-17                | `cn.df-17`              | Chine (CN)      |         $10 M |             $550 |  5   |  2019   |       24 h | missiles.hypersonic                    |
| DF-21D               | `cn.df-21d`             | Chine (CN)      |         $10 M |             $550 |  5   |  2010   |       20 h | missiles.ballistic3, missiles.antiship |
| DF-26                | `cn.df-26`              | Chine (CN)      |         $12 M |             $660 |  5   |  2016   |       24 h | missiles.ballistic3                    |
| YJ-18                | `cn.yj-18`              | Chine (CN)      |        $2,5 M |             $140 |  5   |  2015   |       12 h | missiles.antiship                      |
| C-802                | `cn.c-802`              | Chine (CN)      |        $800 k |              $44 |  3   |  1994   |        6 h | missiles.antiship                      |
| SCALP / Storm Shadow | `eu.scalp-storm-shadow` | Europe (FR)     |        $2,5 M |             $140 |  5   |  2002   |       10 h | missiles.cruise2                       |
| Exocet MM40          | `eu.exocet`             | Europe (FR)     |        $2,5 M |             $140 |  4   |  1975   |        8 h | missiles.antiship                      |
| Taurus KEPD 350      | `eu.taurus-kepd-350`    | Europe (DE)     |        $1,5 M |              $82 |  5   |  2005   |       10 h | missiles.cruise2                       |
| Naval Strike Missile | `eu.nsm`                | Europe (NO)     |        $2,2 M |             $120 |  5   |  2012   |        8 h | missiles.antiship                      |
| BrahMos              | `other.brahmos`         | Autres (IN)     |        $3,5 M |             $190 |  5   |  2006   |       12 h | missiles.antiship                      |
| Fateh-110            | `other.fateh-110`       | Autres (IR)     |        $500 k |              $27 |  4   |  2002   |        8 h | missiles.ballistic2                    |
| Kheibar Shekan       | `other.kheibar-shekan`  | Autres (IR)     |        $1,5 M |              $82 |  5   |  2022   |       14 h | missiles.ballistic3                    |
| Shahab-3             | `other.shahab-3`        | Autres (IR)     |          $2 M |             $110 |  3   |  2003   |       14 h | missiles.ballistic3                    |
| KN-23 (Hwasong-11)   | `other.kn-23`           | Autres (KP)     |          $2 M |             $110 |  4   |  2019   |       10 h | missiles.ballistic2                    |

### Nucléaire (14)

| Système               | Identifiant         | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes                               |
| --------------------- | ------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ------------------------------------ |
| LGM-30G Minuteman III | `us.minuteman-iii`  | États-Unis (US) |         $30 M |             $6 k |  3   |  1970   |       96 h | nuclear.icbm                         |
| UGM-133 Trident II D5 | `us.trident-ii-d5`  | États-Unis (US) |         $35 M |             $6 k |  4   |  1979   |       96 h | nuclear.slbm                         |
| B61-12                | `us.b61-12`         | États-Unis (US) |         $28 M |             $5 k |  5   |  1968   |       24 h | nuclear.weapons                      |
| RS-24 Yars            | `ru.yars`           | Russie (RU)     |         $25 M |             $4 k |  5   |  1985   |       96 h | nuclear.icbm                         |
| RS-28 Sarmat          | `ru.sarmat`         | Russie (RU)     |        $100 M |            $14 k |  5   |  2023   |      140 h | nuclear.icbm                         |
| R-30 Bulava           | `ru.bulava`         | Russie (RU)     |         $30 M |             $4 k |  5   |  2013   |       96 h | nuclear.slbm                         |
| DF-41                 | `cn.df-41`          | Chine (CN)      |         $30 M |             $4 k |  5   |  2017   |      100 h | nuclear.icbm                         |
| JL-3                  | `cn.jl-3`           | Chine (CN)      |         $30 M |             $4 k |  5   |  2020   |       96 h | nuclear.slbm                         |
| M51                   | `eu.m51`            | Europe (FR)     |         $80 M |            $12 k |  5   |  2010   |      100 h | nuclear.slbm                         |
| ASMP-A                | `eu.asmp-a`         | Europe (FR)     |         $30 M |             $5 k |  5   |  2009   |       48 h | nuclear.weapons, missiles.cruise2    |
| Agni-V                | `other.agni-v`      | Autres (IN)     |         $15 M |             $2 k |  5   |  2018   |       96 h | nuclear.icbm                         |
| Shaheen-III           | `other.shaheen-iii` | Autres (PK)     |         $10 M |             $2 k |  4   |  2022   |       72 h | nuclear.weapons, missiles.ballistic3 |
| Hwasong-17            | `other.hwasong-17`  | Autres (KP)     |         $30 M |             $4 k |  4   |  2022   |      120 h | nuclear.icbm                         |
| Jericho III           | `other.jericho-iii` | Autres (IL)     |         $15 M |             $2 k |  4   |  2011   |       96 h | nuclear.icbm                         |

### Navires de surface (36)

| Système              | Identifiant              | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes                    |
| -------------------- | ------------------------ | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ------------------------- |
| Arleigh Burke        | `us.arleigh-burke`       | États-Unis (US) |       $2,2 Md |           $210 k |  5   |  1991   |      450 h | naval.gen4, missiles.sam4 |
| Gerald R. Ford       | `us.gerald-r-ford`       | États-Unis (US) |      $13,3 Md |           $1,4 M |  5   |  2017   |     1100 h | naval.carrier, naval.gen5 |
| Nimitz               | `us.nimitz`              | États-Unis (US) |       $8,5 Md |           $1,3 M |  4   |  1975   |     1000 h | naval.carrier             |
| America              | `us.america`             | États-Unis (US) |       $3,8 Md |           $540 k |  5   |  2014   |      640 h | naval.gen4                |
| Ticonderoga          | `us.ticonderoga`         | États-Unis (US) |       $2,4 Md |           $220 k |  4   |  1983   |      480 h | naval.gen3, missiles.sam3 |
| Constellation        | `us.constellation`       | États-Unis (US) |       $1,3 Md |           $130 k |  5   |  2025   |      360 h | naval.gen5                |
| Littoral Combat Ship | `us.lcs`                 | États-Unis (US) |        $550 M |            $56 k |  4   |  2008   |      240 h | naval.gen4                |
| Amiral Kouznetsov    | `ru.admiral-kuznetsov`   | Russie (RU)     |         $3 Md |           $330 k |  4   |  1991   |      900 h | naval.carrier             |
| Amiral Gorchkov      | `ru.admiral-gorshkov`    | Russie (RU)     |        $500 M |            $45 k |  5   |  2018   |      320 h | naval.gen4                |
| Karakourt            | `ru.karakurt`            | Russie (RU)     |        $150 M |            $11 k |  5   |  2018   |      160 h | naval.gen4                |
| Kirov                | `ru.kirov`               | Russie (RU)     |         $4 Md |           $280 k |  4   |  1980   |      640 h | naval.gen3, missiles.sam3 |
| Slava                | `ru.slava`               | Russie (RU)     |       $1,5 Md |           $120 k |  4   |  1982   |      480 h | naval.gen3, missiles.sam3 |
| Oudaloï              | `ru.udaloy`              | Russie (RU)     |        $800 M |            $68 k |  3   |  1980   |      400 h | naval.gen3                |
| Steregouchtchi       | `ru.steregushchiy`       | Russie (RU)     |        $300 M |            $25 k |  5   |  2008   |      220 h | naval.gen4                |
| Bouïan-M             | `ru.buyan-m`             | Russie (RU)     |        $100 M |            $10 k |  4   |  2014   |      140 h | naval.gen4                |
| Guépard (classe)     | `ru.gepard-class`        | Russie (RU)     |        $300 M |            $25 k |  4   |  2002   |      220 h | naval.gen3                |
| Type 055             | `cn.type-055`            | Chine (CN)      |         $1 Md |            $79 k |  5   |  2020   |      500 h | naval.gen5, missiles.sam4 |
| Type 052D            | `cn.type-052d`           | Chine (CN)      |        $600 M |            $56 k |  5   |  2014   |      400 h | naval.gen4, missiles.sam4 |
| Type 054A            | `cn.type-054a`           | Chine (CN)      |        $350 M |            $33 k |  4   |  2008   |      280 h | naval.gen4                |
| Type 056             | `cn.type-056`            | Chine (CN)      |         $80 M |            $10 k |  4   |  2013   |      140 h | naval.gen4                |
| Type 022             | `cn.type-022`            | Chine (CN)      |         $40 M |             $3 k |  4   |  2004   |       60 h | naval.gen3                |
| Fujian (Type 003)    | `cn.type-003-fujian`     | Chine (CN)      |        $10 Md |           $750 k |  5   |  2025   |     1100 h | naval.carrier, naval.gen5 |
| Liaoning             | `cn.liaoning`            | Chine (CN)      |         $3 Md |           $330 k |  4   |  2012   |      900 h | naval.carrier             |
| Shandong             | `cn.shandong`            | Chine (CN)      |         $4 Md |           $380 k |  4   |  2019   |      950 h | naval.carrier             |
| Type 075             | `cn.type-075`            | Chine (CN)      |       $1,5 Md |           $160 k |  5   |  2021   |      560 h | naval.gen4                |
| Charles de Gaulle    | `eu.charles-de-gaulle`   | Europe (FR)     |       $5,5 Md |           $600 k |  4   |  2001   |      950 h | naval.carrier             |
| FREMM                | `eu.fremm`               | Europe (FR)     |        $800 M |            $68 k |  5   |  2012   |      320 h | naval.gen4                |
| Horizon              | `eu.horizon`             | Europe (FR)     |       $1,3 Md |           $110 k |  5   |  2008   |      400 h | naval.gen4, missiles.sam4 |
| Type 45 (Daring)     | `eu.type-45`             | Europe (GB)     |       $1,5 Md |           $120 k |  5   |  2009   |      420 h | naval.gen4, missiles.sam4 |
| Queen Elizabeth      | `eu.queen-elizabeth`     | Europe (GB)     |         $4 Md |           $370 k |  5   |  2017   |      950 h | naval.carrier             |
| Mistral (classe)     | `eu.mistral-class`       | Europe (FR)     |        $650 M |            $75 k |  5   |  2006   |      420 h | naval.gen4                |
| MEKO A-200           | `eu.meko-a-200`          | Europe (DE)     |        $400 M |            $48 k |  4   |  2006   |      260 h | naval.gen4                |
| Gowind 2500          | `eu.gowind`              | Europe (FR)     |        $300 M |            $31 k |  5   |  2017   |      200 h | naval.gen4                |
| Sejong le Grand      | `other.sejong-the-great` | Autres (KR)     |         $1 Md |            $79 k |  5   |  2008   |      460 h | naval.gen4, missiles.sam4 |
| Kolkata              | `other.kolkata`          | Autres (IN)     |        $800 M |            $71 k |  5   |  2014   |      420 h | naval.gen4, missiles.sam4 |
| Sa'ar 6              | `other.saar-6`           | Autres (IL)     |        $350 M |            $25 k |  5   |  2020   |      220 h | naval.gen4                |

### Sous-marins (22)

| Système              | Identifiant     | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes     |
| -------------------- | --------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | ---------- |
| Virginia             | `us.virginia`   | États-Unis (US) |       $3,4 Md |           $180 k |  5   |  2004   |      720 h | naval.sub3 |
| Ohio                 | `us.ohio`       | États-Unis (US) |         $4 Md |           $210 k |  4   |  1981   |      960 h | naval.ssbn |
| Columbia             | `us.columbia`   | États-Unis (US) |         $9 Md |           $410 k |  5   |  2025   |     1000 h | naval.ssbn |
| Seawolf              | `us.seawolf`    | États-Unis (US) |       $5,5 Md |           $260 k |  5   |  1997   |      760 h | naval.sub3 |
| Iassen-M             | `ru.yasen-m`    | Russie (RU)     |       $1,6 Md |            $71 k |  5   |  2014   |      720 h | naval.sub3 |
| Boreï                | `ru.borei`      | Russie (RU)     |        $900 M |            $46 k |  5   |  2013   |      900 h | naval.ssbn |
| Kilo (projet 636.3)  | `ru.kilo`       | Russie (RU)     |        $350 M |            $19 k |  3   |  1980   |      360 h | naval.sub1 |
| Delta IV             | `ru.delta-iv`   | Russie (RU)     |         $2 Md |            $93 k |  3   |  1985   |      900 h | naval.ssbn |
| Type 093             | `cn.type-093`   | Chine (CN)      |       $1,5 Md |            $70 k |  4   |  2006   |      640 h | naval.sub2 |
| Type 094             | `cn.type-094`   | Chine (CN)      |         $2 Md |            $92 k |  4   |  2007   |      900 h | naval.ssbn |
| Type 039 (Song/Yuan) | `cn.type-039`   | Chine (CN)      |        $500 M |            $25 k |  4   |  2006   |      380 h | naval.sub2 |
| Suffren (Barracuda)  | `eu.suffren`    | Europe (FR)     |       $1,7 Md |            $84 k |  5   |  2020   |      700 h | naval.sub3 |
| Astute               | `eu.astute`     | Europe (GB)     |       $2,4 Md |           $120 k |  5   |  2010   |      720 h | naval.sub3 |
| Type 212             | `eu.type-212`   | Europe (DE)     |        $700 M |            $35 k |  5   |  2005   |      380 h | naval.sub2 |
| Scorpène             | `eu.scorpene`   | Europe (FR)     |        $600 M |            $31 k |  4   |  2005   |      380 h | naval.sub2 |
| Le Triomphant        | `eu.triomphant` | Europe (FR)     |       $3,5 Md |           $170 k |  5   |  1997   |      960 h | naval.ssbn |
| Type 209             | `eu.type-209`   | Europe (DE)     |        $350 M |            $22 k |  3   |  1971   |      320 h | naval.sub1 |
| Type 214             | `eu.type-214`   | Europe (DE)     |        $500 M |            $26 k |  5   |  2007   |      380 h | naval.sub2 |
| Vanguard             | `eu.vanguard`   | Europe (GB)     |       $3,2 Md |           $160 k |  4   |  1993   |      960 h | naval.ssbn |
| Soryu                | `other.soryu`   | Autres (JP)     |        $550 M |            $28 k |  5   |  2009   |      400 h | naval.sub2 |
| Dolphin              | `other.dolphin` | Autres (DE)     |        $600 M |            $28 k |  5   |  1999   |      400 h | naval.sub2 |
| Ghadir               | `other.ghadir`  | Autres (IR)     |         $30 M |             $3 k |  3   |  2007   |      120 h | naval.sub1 |

### Espace (20)

| Système                                          | Identifiant                     | Doctrine        | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes         |
| ------------------------------------------------ | ------------------------------- | --------------- | ------------: | ---------------: | :--: | :-----: | ---------: | -------------- |
| Satellite de reconnaissance optique (États-Unis) | `us.optical-recon-satellite`    | États-Unis (US) |       $3,5 Md |           $480 k |  5   |  1976   |      240 h | sensors.space1 |
| Satellite de reconnaissance radar (États-Unis)   | `us.radar-satellite`            | États-Unis (US) |       $1,5 Md |           $210 k |  5   |  1988   |      220 h | sensors.space2 |
| Satellite d'écoute électronique (États-Unis)     | `us.sigint-satellite`           | États-Unis (US) |         $3 Md |           $420 k |  5   |  1970   |      240 h | sensors.space1 |
| Satellite d'alerte avancée (États-Unis)          | `us.early-warning-satellite`    | États-Unis (US) |       $1,6 Md |           $220 k |  5   |  1970   |      240 h | sensors.space1 |
| Arme antisatellite (États-Unis)                  | `us.asat`                       | États-Unis (US) |         $40 M |            $11 k |  5   |  1985   |       72 h | sensors.asat   |
| Satellite de reconnaissance optique (Russie)     | `ru.optical-recon-satellite`    | Russie (RU)     |        $400 M |            $56 k |  4   |  1974   |      160 h | sensors.space1 |
| Satellite de reconnaissance radar (Russie)       | `ru.radar-satellite`            | Russie (RU)     |        $300 M |            $43 k |  4   |  1987   |      180 h | sensors.space2 |
| Satellite d'écoute électronique (Russie)         | `ru.sigint-satellite`           | Russie (RU)     |        $400 M |            $56 k |  4   |  1970   |      180 h | sensors.space1 |
| Satellite d'alerte avancée (Russie)              | `ru.early-warning-satellite`    | Russie (RU)     |        $500 M |            $70 k |  4   |  1982   |      200 h | sensors.space1 |
| Arme antisatellite (Russie)                      | `ru.asat`                       | Russie (RU)     |         $60 M |            $10 k |  5   |  1978   |       72 h | sensors.asat   |
| Satellite de reconnaissance optique (Chine)      | `cn.optical-recon-satellite`    | Chine (CN)      |        $300 M |            $43 k |  4   |  2006   |      160 h | sensors.space1 |
| Satellite de reconnaissance radar (Chine)        | `cn.radar-satellite`            | Chine (CN)      |        $300 M |            $43 k |  4   |  2006   |      180 h | sensors.space2 |
| Satellite d'écoute électronique (Chine)          | `cn.sigint-satellite`           | Chine (CN)      |        $300 M |            $43 k |  4   |  2010   |      180 h | sensors.space1 |
| Satellite d'alerte avancée (Chine)               | `cn.early-warning-satellite`    | Chine (CN)      |        $400 M |            $56 k |  4   |  2019   |      200 h | sensors.space1 |
| Arme antisatellite (Chine)                       | `cn.asat`                       | Chine (CN)      |         $40 M |             $7 k |  5   |  2007   |       72 h | sensors.asat   |
| Satellite de reconnaissance optique (Europe)     | `eu.optical-recon-satellite`    | Europe (FR)     |        $600 M |            $87 k |  5   |  1995   |      160 h | sensors.space1 |
| Satellite de reconnaissance radar (Europe)       | `eu.radar-satellite`            | Europe (FR)     |        $350 M |            $52 k |  5   |  2006   |      180 h | sensors.space2 |
| Satellite d'écoute électronique (Europe)         | `eu.sigint-satellite`           | Europe (FR)     |        $200 M |            $32 k |  5   |  2011   |      180 h | sensors.space1 |
| Satellite de reconnaissance optique (Inde)       | `other.optical-recon-satellite` | Autres (IN)     |        $100 M |            $15 k |  4   |  2007   |      160 h | sensors.space1 |
| Arme antisatellite (Inde)                        | `other.asat`                    | Autres (IN)     |         $20 M |             $4 k |  4   |  2019   |       72 h | sensors.asat   |

### Logistique (3)

| Système             | Identifiant            | Doctrine    | Prix unitaire | Entretien / jour | Gén. | Service | Production | Portes |
| ------------------- | ---------------------- | ----------- | ------------: | ---------------: | :--: | :-----: | ---------: | ------ |
| Convoi logistique   | `other.supply-convoy`  | Autres (XX) |          $3 M |             $820 |  3   |  1945   |        4 h | —      |
| Cargo               | `other.cargo-ship`     | Autres (XX) |         $40 M |             $9 k |  3   |  1945   |       96 h | —      |
| Avion cargo affrété | `other.cargo-aircraft` | Autres (XX) |        $120 M |            $26 k |  3   |  1970   |       24 h | —      |

## 5. Arbre de recherche

116 nœuds répartis sur les 8 branches : toutes les **portes du brief** (identifiants fixes, marquées ◆) et des
nœuds d’amélioration dont les effets sont des modificateurs de `MODIFIER_KEYS` (multiplicatifs, cumulés par
produit ; les clés `intel.*.level` ajoutent un niveau). Coûts en dollars, durées en heures de jeu, `eraYear` =
première année possible (le scénario 1985 exclut les nœuds postérieurs). Une génération de chasseur coûte des
milliards : `aero.gen4` $3 Md, `aero.gen4plus` $6 Md, `aero.gen5` $15 Md ; les armes nucléaires $15 Md.

### Aviation (21)

| Nœud                              | Identifiant                   | Rang |    Coût | Durée | Prérequis                                             | Effets                          | Ère  |
| --------------------------------- | ----------------------------- | :--: | ------: | ----: | ----------------------------------------------------- | ------------------------------- | :--: |
| ◆ Drones tactiques                | `aero.drones1`                |  1   |  $200 M |  36 h | —                                                     | —                               | 1980 |
| ◆ Chasseurs de 2e génération      | `aero.gen2`                   |  1   |  $300 M |  48 h | —                                                     | —                               | 1955 |
| ◆ Hélicoptères de transport       | `aero.helo1`                  |  1   |  $200 M |  36 h | —                                                     | —                               | 1955 |
| ◆ Transport aérien stratégique    | `aero.transport`              |  1   |  $400 M |  48 h | —                                                     | —                               | 1950 |
| ◆ Bombardiers subsoniques         | `aero.bomber1`                |  2   | $1,5 Md | 120 h | aero.gen2                                             | —                               | 1955 |
| ◆ Drones MALE et HALE             | `aero.drones2`                |  2   | $1,5 Md | 120 h | aero.drones1                                          | —                               | 1995 |
| ◆ Chasseurs de 3e génération      | `aero.gen3`                   |  2   |   $1 Md |  96 h | aero.gen2                                             | —                               | 1965 |
| ◆ Hélicoptères d’attaque          | `aero.helo2`                  |  2   |  $800 M |  96 h | aero.helo1                                            | —                               | 1967 |
| ◆ Ravitaillement en vol           | `aero.tanker`                 |  2   |  $600 M |  72 h | aero.transport                                        | air.range ×1,05                 | 1956 |
| ◆ Guet aérien embarqué            | `aero.aew`                    |  3   |   $2 Md | 168 h | aero.transport, sensors.radar2                        | —                               | 1977 |
| ◆ Bombardiers supersoniques       | `aero.bomber2`                |  3   |   $5 Md | 240 h | aero.bomber1, aero.gen3                               | —                               | 1970 |
| Motorisation à haut rendement     | `aero.engines`                |  3   | $1,5 Md | 120 h | aero.gen3                                             | air.range ×1,10, air.fuel ×1,10 | 1975 |
| ◆ Chasseurs de 4e génération      | `aero.gen4`                   |  3   |   $3 Md | 168 h | aero.gen3, sensors.radar1                             | —                               | 1975 |
| ◆ Hélicoptères d’attaque modernes | `aero.helo3`                  |  3   | $2,5 Md | 168 h | aero.helo2, sensors.radar1                            | —                               | 1986 |
| ◆ Chasseurs de génération 4+      | `aero.gen4plus`               |  4   |   $6 Md | 264 h | aero.gen4, sensors.radar2                             | —                               | 1995 |
| Maintenance prédictive            | `aero.predictive-maintenance` |  4   |   $1 Md | 120 h | aero.gen4, cyber.l1                                   | upkeep ×0,96                    | 2010 |
| Matériaux furtifs                 | `aero.stealth-materials`      |  4   |   $4 Md | 240 h | aero.gen4                                             | —                               | 1983 |
| ◆ Drones de combat furtifs        | `aero.drones3`                |  5   |   $6 Md | 336 h | aero.drones2, aero.stealth-materials                  | —                               | 2015 |
| ◆ Chasseurs de 5e génération      | `aero.gen5`                   |  5   |  $15 Md | 480 h | aero.gen4plus, aero.stealth-materials, sensors.radar3 | —                               | 2005 |
| ◆ Bombardiers furtifs             | `aero.stealth-bomber`         |  5   |  $20 Md | 600 h | aero.bomber2, aero.stealth-materials                  | —                               | 1989 |
| Supercroisière                    | `aero.supercruise`            |  5   |   $3 Md | 192 h | aero.engines, aero.gen4plus                           | air.fuel ×1,10, air.range ×1,05 | 2005 |

### Terre (12)

| Nœud                            | Identifiant              | Rang |    Coût | Durée | Prérequis                                      | Effets              | Ère  |
| ------------------------------- | ------------------------ | :--: | ------: | ----: | ---------------------------------------------- | ------------------- | :--: |
| ◆ Blindés de 1re génération     | `land.gen1`              |  1   |  $100 M |  24 h | —                                              | —                   | 1945 |
| ◆ Blindés de 2e génération      | `land.gen2`              |  2   |  $400 M |  48 h | land.gen1                                      | —                   | 1960 |
| ◆ Blindés de 3e génération      | `land.gen3`              |  3   | $1,2 Md |  96 h | land.gen2                                      | —                   | 1970 |
| ◆ Lance-roquettes lourds        | `land.mlrs`              |  3   |   $1 Md |  96 h | land.gen2                                      | —                   | 1975 |
| Logistique motorisée            | `land.mobile-logistics`  |  3   |  $500 M |  72 h | land.gen2                                      | supply.range ×1,15  | 1960 |
| Vision nocturne                 | `land.night-vision`      |  3   |  $800 M |  72 h | land.gen2                                      | combat.damage ×1,03 | 1975 |
| Blindage composite              | `land.composite-armor`   |  4   |   $1 Md |  96 h | land.gen3                                      | combat.armor ×1,04  | 1977 |
| ◆ Guerre électronique terrestre | `land.ew`                |  4   | $1,5 Md | 120 h | land.gen3, sensors.radar1                      | ew.jamming ×1,05    | 1975 |
| Conduite de tir numérique       | `land.fire-control`      |  4   | $1,5 Md | 120 h | land.gen3                                      | combat.damage ×1,04 | 1985 |
| ◆ Blindés de 4e génération      | `land.gen4`              |  5   |   $3 Md | 168 h | land.gen3, land.composite-armor                | —                   | 1980 |
| Protection active               | `land.active-protection` |  6   |   $2 Md | 168 h | land.gen4                                      | combat.armor ×1,05  | 2010 |
| ◆ Blindés de 5e génération      | `land.gen5`              |  7   |   $8 Md | 336 h | land.gen4, land.active-protection, industry.l2 | —                   | 2015 |

### Marine (14)

| Nœud                                       | Identifiant            | Rang |    Coût | Durée | Prérequis                               | Effets                      | Ère  |
| ------------------------------------------ | ---------------------- | :--: | ------: | ----: | --------------------------------------- | --------------------------- | :--: |
| ◆ Navires de 1re génération                | `naval.gen1`           |  1   |  $300 M |  48 h | —                                       | —                           | 1945 |
| Sécurité et lutte contre les avaries       | `naval.damage-control` |  2   |  $400 M |  48 h | naval.gen1                              | combat.armor ×1,03          | 1960 |
| ◆ Navires de 2e génération                 | `naval.gen2`           |  2   |   $1 Md |  96 h | naval.gen1                              | —                           | 1960 |
| ◆ Sous-marins classiques                   | `naval.sub1`           |  2   |   $1 Md |  96 h | naval.gen1                              | —                           | 1950 |
| Chantiers navals modernes                  | `naval.dockyards`      |  3   | $1,5 Md | 120 h | naval.gen2, industry.l1                 | production.speed ×1,05      | 1970 |
| ◆ Navires de 3e génération                 | `naval.gen3`           |  3   |   $3 Md | 168 h | naval.gen2, sensors.radar1              | —                           | 1975 |
| ◆ Sous-marins modernes                     | `naval.sub2`           |  3   |   $4 Md | 216 h | naval.sub1, naval.gen2                  | —                           | 1970 |
| Sonars remorqués                           | `naval.towed-sonar`    |  3   |   $1 Md |  96 h | naval.sub1                              | naval.sonar ×1,15           | 1975 |
| ◆ Porte-avions                             | `naval.carrier`        |  4   |  $10 Md | 480 h | naval.gen1, aero.gen2                   | —                           | 1955 |
| Système de combat intégré                  | `naval.combat-system`  |  4   |   $2 Md | 168 h | naval.gen3, sensors.radar2              | missiles.interception ×1,10 | 1983 |
| ◆ Navires de 4e génération                 | `naval.gen4`           |  4   |   $6 Md | 264 h | naval.gen3, sensors.radar2              | —                           | 1990 |
| ◆ Sous-marins lanceurs d’engins            | `naval.ssbn`           |  4   |   $8 Md | 360 h | naval.sub1, nuclear.slbm                | —                           | 1965 |
| ◆ Sous-marins nucléaires d’attaque avancés | `naval.sub3`           |  4   |  $10 Md | 432 h | naval.sub2, industry.l2                 | —                           | 1990 |
| ◆ Navires de 5e génération                 | `naval.gen5`           |  5   |  $12 Md | 432 h | naval.gen4, sensors.radar3, industry.l2 | —                           | 2015 |

### Missiles et nucléaire (20)

| Nœud                                        | Identifiant                       | Rang |    Coût | Durée | Prérequis                                        | Effets                      | Ère  |
| ------------------------------------------- | --------------------------------- | :--: | ------: | ----: | ------------------------------------------------ | --------------------------- | :--: |
| ◆ Missiles balistiques tactiques            | `missiles.ballistic1`             |  1   |  $500 M |  72 h | —                                                | —                           | 1955 |
| ◆ Missiles sol-air de 1re génération        | `missiles.sam1`                   |  1   |  $300 M |  48 h | —                                                | —                           | 1957 |
| ◆ Missiles antinavires                      | `missiles.antiship`               |  2   |   $1 Md |  96 h | naval.gen1                                       | —                           | 1960 |
| ◆ Missiles balistiques modernes             | `missiles.ballistic2`             |  2   |   $2 Md | 144 h | missiles.ballistic1                              | —                           | 1962 |
| ◆ Missiles de croisière                     | `missiles.cruise1`                |  2   |   $1 Md |  96 h | —                                                | —                           | 1980 |
| ◆ Missiles sol-air de 2e génération         | `missiles.sam2`                   |  2   |   $1 Md |  96 h | missiles.sam1                                    | —                           | 1967 |
| ◆ Missiles balistiques de moyenne portée    | `missiles.ballistic3`             |  3   |   $5 Md | 264 h | missiles.ballistic2                              | —                           | 1965 |
| ◆ Missiles de croisière furtifs             | `missiles.cruise2`                |  3   |   $3 Md | 192 h | missiles.cruise1, sensors.space1                 | —                           | 2000 |
| Guidage par satellite                       | `missiles.gps-guidance`           |  3   |   $1 Md |  96 h | missiles.cruise1, sensors.space1                 | missiles.accuracy ×1,15     | 1993 |
| ◆ Missiles sol-air de 3e génération         | `missiles.sam3`                   |  3   | $2,5 Md | 168 h | missiles.sam2, sensors.radar1                    | —                           | 1980 |
| ◆ Armes nucléaires                          | `nuclear.weapons`                 |  3   |  $15 Md | 600 h | industry.l1                                      | —                           | 1950 |
| ◆ Armes hypersoniques                       | `missiles.hypersonic`             |  4   |  $12 Md | 480 h | missiles.ballistic3, missiles.cruise2            | —                           | 2017 |
| Autodirecteurs à imagerie                   | `missiles.imaging-seekers`        |  4   |   $2 Md | 144 h | missiles.gps-guidance                            | missiles.accuracy ×1,10     | 2005 |
| Défense aérienne intégrée                   | `missiles.integrated-air-defense` |  4   |   $2 Md | 168 h | missiles.sam3, sensors.radar2                    | missiles.interception ×1,10 | 1990 |
| ◆ Missiles sol-air de 4e génération         | `missiles.sam4`                   |  4   |   $5 Md | 264 h | missiles.sam3, sensors.radar2                    | —                           | 1995 |
| ◆ Missiles intercontinentaux                | `nuclear.icbm`                    |  4   |  $10 Md | 480 h | nuclear.weapons, missiles.ballistic3             | —                           | 1965 |
| ◆ Missiles mer-sol balistiques stratégiques | `nuclear.slbm`                    |  4   |   $8 Md | 432 h | nuclear.weapons, missiles.ballistic3, naval.sub1 | —                           | 1965 |
| ◆ Défense antimissile balistique            | `missiles.abm`                    |  5   |  $12 Md | 480 h | missiles.sam4, sensors.space1                    | missiles.interception ×1,05 | 2000 |
| ◆ Missiles sol-air de 5e génération         | `missiles.sam5`                   |  5   |  $10 Md | 432 h | missiles.sam4, sensors.radar3                    | —                           | 2008 |
| Interception par impact direct              | `missiles.hit-to-kill`            |  6   |   $4 Md | 240 h | missiles.abm                                     | missiles.interception ×1,10 | 2008 |

### Capteurs, espace et guerre électronique (15)

| Nœud                          | Identifiant                 | Rang |    Coût | Durée | Prérequis                              | Effets                                                | Ère  |
| ----------------------------- | --------------------------- | :--: | ------: | ----: | -------------------------------------- | ----------------------------------------------------- | :--: |
| ◆ Radars de 1re génération    | `sensors.radar1`            |  1   |  $300 M |  48 h | —                                      | —                                                     | 1950 |
| Contre-mesures électroniques  | `sensors.ecm`               |  2   |  $500 M |  72 h | sensors.radar1                         | ew.jamming ×1,10                                      | 1965 |
| ◆ Radars Doppler              | `sensors.radar2`            |  2   | $1,5 Md | 120 h | sensors.radar1                         | sensors.radarRange ×1,05                              | 1975 |
| ◆ Satellites militaires       | `sensors.space1`            |  2   |   $3 Md | 240 h | missiles.ballistic1                    | —                                                     | 1960 |
| Contre-contre-mesures         | `sensors.eccm`              |  3   |   $1 Md |  96 h | sensors.ecm                            | ew.jamResistance ×1,10                                | 1975 |
| Réseau de stations au sol     | `sensors.ground-stations`   |  3   |   $1 Md |  96 h | sensors.space1                         | sensors.satellitePasses ×1,20                         | 1975 |
| Radars transhorizon           | `sensors.over-the-horizon`  |  3   |   $2 Md | 168 h | sensors.radar2                         | sensors.radarRange ×1,15                              | 1975 |
| ◆ Radars à antenne active     | `sensors.radar3`            |  3   |   $4 Md | 240 h | sensors.radar2, industry.l2            | sensors.radarRange ×1,10                              | 2000 |
| ◆ Satellites radar            | `sensors.space2`            |  3   |   $6 Md | 336 h | sensors.space1, sensors.radar2         | sensors.satellitePasses ×1,20                         | 1988 |
| Radars à ondes métriques      | `sensors.vhf-radar`         |  3   | $1,5 Md | 120 h | sensors.radar2                         | sensors.stealthDetect ×1,25                           | 1985 |
| ◆ Armes antisatellites        | `sensors.asat`              |  4   |   $5 Md | 264 h | sensors.space1, missiles.ballistic2    | —                                                     | 1978 |
| Constellations de satellites  | `sensors.constellations`    |  4   |   $4 Md | 240 h | sensors.space2, industry.l3            | sensors.satellitePasses ×1,50                         | 2015 |
| Fusion de données             | `sensors.data-fusion`       |  4   |   $2 Md | 168 h | sensors.radar3, cyber.l1               | sensors.radarRange ×1,10, sensors.stealthDetect ×1,05 | 2010 |
| Détection passive             | `sensors.passive-detection` |  4   |   $2 Md | 168 h | sensors.vhf-radar, sensors.radar3      | sensors.stealthDetect ×1,15                           | 2005 |
| Guerre électronique cognitive | `sensors.cognitive-ew`      |  5   |   $3 Md | 192 h | sensors.eccm, sensors.radar3, cyber.l2 | ew.jamming ×1,10, ew.jamResistance ×1,05              | 2015 |

### Cyber (8)

| Nœud                              | Identifiant            | Rang |    Coût | Durée | Prérequis                 | Effets                                      | Ère  |
| --------------------------------- | ---------------------- | :--: | ------: | ----: | ------------------------- | ------------------------------------------- | :--: |
| ◆ Cyberdéfense                    | `cyber.l1`             |  1   |  $500 M |  72 h | —                         | cyber.defense ×1,10                         | 1995 |
| ◆ Cyberattaque                    | `cyber.l2`             |  2   |   $2 Md | 168 h | cyber.l1, industry.l2     | cyber.attack ×1,15                          | 2005 |
| Centre des opérations de sécurité | `cyber.soc`            |  2   |  $800 M |  96 h | cyber.l1                  | cyber.defense ×1,20                         | 2005 |
| Attaque des systèmes industriels  | `cyber.ics-attack`     |  3   |   $2 Md | 144 h | cyber.l2                  | cyber.attack ×1,10                          | 2010 |
| ◆ Cyberguerre avancée             | `cyber.l3`             |  3   |   $6 Md | 336 h | cyber.l2, intel.exterior2 | cyber.attack ×1,20, cyber.defense ×1,10     | 2015 |
| Arsenal de vulnérabilités         | `cyber.zero-days`      |  3   | $1,5 Md | 120 h | cyber.l2                  | cyber.attack ×1,20                          | 2010 |
| Défense automatisée               | `cyber.ai-defense`     |  4   |   $3 Md | 192 h | cyber.soc, cyber.l3       | cyber.defense ×1,15                         | 2023 |
| Communications durcies            | `cyber.hardened-comms` |  4   |   $2 Md | 168 h | cyber.l3                  | cyber.defense ×1,15, ew.jamResistance ×1,05 | 2020 |

### Renseignement (13)

| Nœud                                   | Identifiant                     | Rang |   Coût | Durée | Prérequis                       | Effets                                        | Ère  |
| -------------------------------------- | ------------------------------- | :--: | -----: | ----: | ------------------------------- | --------------------------------------------- | :--: |
| ◆ Renseignement extérieur — niveau 1   | `intel.exterior1`               |  1   | $300 M |  72 h | —                               | intel.exterior.level +1                       | 1947 |
| ◆ Renseignement intérieur — niveau 1   | `intel.interior1`               |  1   | $300 M |  72 h | —                               | intel.interior.level +1                       | 1947 |
| ◆ Renseignement militaire — niveau 1   | `intel.military1`               |  1   | $300 M |  72 h | —                               | intel.military.level +1                       | 1947 |
| Cellule d’analyse                      | `intel.analysis`                |  2   | $500 M |  96 h | intel.exterior1                 | intel.capacity ×1,25                          | 1960 |
| Contre-espionnage renforcé             | `intel.counterintelligence`     |  2   | $600 M |  96 h | intel.interior1                 | cyber.defense ×1,05, stability.recovery ×1,10 | 1955 |
| ◆ Renseignement extérieur — niveau 2   | `intel.exterior2`               |  2   |  $1 Md | 168 h | intel.exterior1                 | intel.exterior.level +1                       | 1960 |
| ◆ Renseignement intérieur — niveau 2   | `intel.interior2`               |  2   |  $1 Md | 168 h | intel.interior1                 | intel.interior.level +1                       | 1960 |
| ◆ Renseignement militaire — niveau 2   | `intel.military2`               |  2   |  $1 Md | 168 h | intel.military1                 | intel.military.level +1                       | 1960 |
| Communication stratégique              | `intel.strategic-communication` |  2   | $400 M |  72 h | intel.interior1                 | stability.recovery ×1,20                      | 1950 |
| ◆ Renseignement extérieur — niveau 3   | `intel.exterior3`               |  3   |  $3 Md | 336 h | intel.exterior2, sensors.space1 | intel.exterior.level +1                       | 1975 |
| ◆ Renseignement intérieur — niveau 3   | `intel.interior3`               |  3   |  $3 Md | 336 h | intel.interior2                 | intel.interior.level +1                       | 1975 |
| ◆ Renseignement militaire — niveau 3   | `intel.military3`               |  3   |  $3 Md | 336 h | intel.military2, sensors.space1 | intel.military.level +1                       | 1975 |
| Renseignement d’origine source ouverte | `intel.osint`                   |  3   | $800 M |  96 h | intel.analysis, cyber.l1        | intel.capacity ×1,20                          | 2010 |

### Industrie et économie (13)

| Nœud                             | Identifiant                       | Rang |   Coût | Durée | Prérequis             | Effets                                        | Ère  |
| -------------------------------- | --------------------------------- | :--: | -----: | ----: | --------------------- | --------------------------------------------- | :--: |
| Agriculture mécanisée            | `industry.agriculture`            |  1   | $300 M |  48 h | —                     | income.food ×1,15                             | 1960 |
| ◆ Industrie de défense           | `industry.l1`                     |  1   | $500 M |  96 h | —                     | production.speed ×1,10                        | 1950 |
| Mines et métallurgie             | `industry.mining`                 |  1   | $500 M |  72 h | —                     | income.metals ×1,15                           | 1950 |
| Extraction pétrolière            | `industry.oil-extraction`         |  1   | $500 M |  72 h | —                     | income.oil ×1,15                              | 1950 |
| ◆ Industrie de haute technologie | `industry.l2`                     |  2   |  $3 Md | 240 h | industry.l1           | production.speed ×1,10, production.cost ×0,97 | 1970 |
| Logistique militaire             | `industry.military-logistics`     |  2   |  $1 Md |  96 h | industry.l1           | supply.range ×1,20, upkeep ×0,97              | 1960 |
| Laboratoires nationaux           | `industry.national-labs`          |  2   |  $1 Md | 120 h | industry.l1           | research.speed ×1,10                          | 1955 |
| Semi-conducteurs                 | `industry.semiconductors`         |  2   |  $4 Md | 240 h | industry.l1           | income.electronics ×1,20                      | 1975 |
| Économie de guerre               | `industry.war-economy`            |  2   |  $1 Md |  96 h | industry.l1           | income.money ×1,05                            | 1950 |
| Automatisation                   | `industry.automation`             |  3   |  $3 Md | 192 h | industry.l2           | production.speed ×1,10, upkeep ×0,97          | 1990 |
| ◆ Industrie numérique            | `industry.l3`                     |  3   | $10 Md | 480 h | industry.l2, cyber.l1 | production.speed ×1,15, production.cost ×0,95 | 2000 |
| Fabrication additive             | `industry.additive-manufacturing` |  4   |  $2 Md | 144 h | industry.l3           | production.cost ×0,95, upkeep ×0,97           | 2015 |
| Recherche assistée par IA        | `industry.ai-research`            |  4   |  $5 Md | 240 h | industry.l3, cyber.l2 | research.speed ×1,15                          | 2020 |

## 6. Bâtiments (niveaux 1 à 5)

`balance.buildings` : `effects`, `buildHours` et `buildCostUsd` donnent le niveau 1 (compatibilité) ; `levels`
(ajout optionnel au contrat `BalanceSchema`) donne pour chaque type les 5 niveaux : coût et durée **pour
atteindre** ce niveau, et effets **absolus** une fois le niveau atteint (pas de cumul entre niveaux). Coûts
×1 / ×1,5 / ×2,2 / ×3,2 / ×4,5 et durées ×1 / ×1,25 / ×1,5 / ×1,8 / ×2,2 par rapport au niveau 1.
Réparation d’un bâtiment endommagé : 48 h.

| Type                | Coût niv. 1 → 5    | Durée niv. 1 → 5 | Effets niv. 1 → 5                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oil_field`         | $400 M → $1,8 Md   | 168 → 370 h      | `oilPerDay` : 8 / 14 / 20 / 28 / 36                                                                                                                                                                                                                                                                  |
| `mine`              | $300 M → $1,4 Md   | 168 → 370 h      | `metalsPerDay` : 8 / 14 / 20 / 28 / 36                                                                                                                                                                                                                                                               |
| `farm`              | $60 M → $270 M     | 72 → 158 h       | `foodPerDay` : 12 / 20 / 30 / 42 / 55                                                                                                                                                                                                                                                                |
| `electronics_plant` | $1,5 Md → $6,8 Md  | 240 → 528 h      | `electronicsPerDay` : 6 / 10 / 15 / 21 / 28                                                                                                                                                                                                                                                          |
| `local_industry`    | $250 M → $1,1 Md   | 120 → 264 h      | `incomeMultiplier` : 1,05 / 1,1 / 1,15 / 1,2 / 1,25<br>`constructionSpeed` : 1,1 / 1,2 / 1,3 / 1,4 / 1,5                                                                                                                                                                                             |
| `refinery`          | $2,5 Md → $11,2 Md | 336 → 739 h      | `oilMultiplier` : 1,1 / 1,15 / 1,2 / 1,25 / 1,3<br>`radiusKm` : 400 / 450 / 500 / 550 / 600                                                                                                                                                                                                          |
| `power_plant`       | $1,5 Md → $6,8 Md  | 336 → 739 h      | `productionSpeed` : 1,1 / 1,15 / 1,2 / 1,25 / 1,3<br>`researchSpeed` : 1,03 / 1,06 / 1,09 / 1,12 / 1,15<br>`radiusKm` : 300 / 350 / 400 / 450 / 500                                                                                                                                                  |
| `port`              | $800 M → $3,6 Md   | 240 → 528 h      | `tradeMultiplier` : 1,05 / 1,1 / 1,15 / 1,2 / 1,25<br>`embarkSpeed` : 1,2 / 1,4 / 1,6 / 1,8 / 2<br>`shipCapacity` : 4 / 8 / 12 / 16 / 20                                                                                                                                                             |
| `naval_base`        | $1,5 Md → $6,8 Md  | 336 → 739 h      | `navalProductionSpeed` : 1 / 1,1 / 1,2 / 1,3 / 1,4<br>`repairPerHour` : 0,02 / 0,03 / 0,04 / 0,05 / 0,06<br>`shipCapacity` : 6 / 12 / 18 / 24 / 30                                                                                                                                                   |
| `air_base`          | $1 Md → $4,5 Md    | 240 → 528 h      | `aircraftCapacity` : 24 / 48 / 72 / 96 / 120<br>`repairPerHour` : 0,02 / 0,03 / 0,04 / 0,05 / 0,06<br>`rearmMinutes` : 60 / 50 / 40 / 30 / 20<br>`airProductionSpeed` : 1 / 1,1 / 1,2 / 1,3 / 1,4                                                                                                    |
| `military_base`     | $400 M → $1,8 Md   | 120 → 264 h      | `garrisonCapacity` : 10 / 20 / 30 / 40 / 50<br>`supplyRangeKm` : 150 / 200 / 250 / 300 / 350<br>`landProductionSpeed` : 1 / 1,1 / 1,2 / 1,3 / 1,4                                                                                                                                                    |
| `arms_factory`      | $1,2 Md → $5,4 Md  | 240 → 528 h      | `productionSpeed` : 1,2 / 1,3 / 1,4 / 1,5 / 1,6<br>`productionCost` : 1 / 0,98 / 0,96 / 0,94 / 0,92                                                                                                                                                                                                  |
| `research_center`   | $500 M → $2,2 Md   | 168 → 370 h      | `researchSpeed` : 1,05 / 1,08 / 1,11 / 1,14 / 1,17                                                                                                                                                                                                                                                   |
| `recruiting_office` | $20 M → $90 M      | 24 → 53 h        | `infantryProductionSpeed` : 1,2 / 1,4 / 1,6 / 1,8 / 2<br>`mobilizationSpeed` : 1,1 / 1,2 / 1,3 / 1,4 / 1,5                                                                                                                                                                                           |
| `bunker`            | $150 M → $675 M    | 72 → 158 h       | `damageReduction` : 0,15 / 0,22 / 0,3 / 0,37 / 0,45                                                                                                                                                                                                                                                  |
| `air_defense_site`  | $600 M → $2,7 Md   | 120 → 264 h      | `rangeKm` : 40 / 70 / 100 / 130 / 160<br>`damageAircraft` : 12 / 15 / 18 / 21 / 24<br>`damageHelicopter` : 12 / 14 / 16 / 18 / 20<br>`damageDrone` : 8 / 10 / 12 / 14 / 16<br>`damageMissile` : 8 / 11 / 14 / 17 / 20<br>`pk` : 0,45 / 0,5 / 0,55 / 0,6 / 0,65<br>`magazine` : 8 / 12 / 16 / 24 / 32 |
| `coastal_battery`   | $300 M → $1,4 Md   | 96 → 211 h       | `rangeKm` : 100 / 150 / 200 / 250 / 300<br>`damageShip` : 15 / 20 / 25 / 30 / 35                                                                                                                                                                                                                     |
| `radar_station`     | $250 M → $1,1 Md   | 96 → 211 h       | `detectionKm` : 250 / 350 / 450 / 550 / 650<br>`stealthDetect` : 0,1 / 0,15 / 0,2 / 0,3 / 0,4                                                                                                                                                                                                        |
| `missile_silo`      | $400 M → $1,8 Md   | 336 → 739 h      | `silos` : 1 / 2 / 3 / 4 / 6<br>`hardening` : 0,5 / 0,6 / 0,7 / 0,8 / 0,9                                                                                                                                                                                                                             |
| `hospital`          | $200 M → $900 M    | 96 → 211 h       | `healPerHour` : 0,01 / 0,01 / 0,02 / 0,03 / 0,04<br>`lossReduction` : 0,05 / 0,1 / 0,15 / 0,2 / 0,25                                                                                                                                                                                                 |
| `secret_lab`        | $1 Md → $4,5 Md    | 336 → 739 h      | `researchSpeed` : 1,05 / 1,1 / 1,15 / 1,22 / 1,3<br>`researchProtection` : 0,1 / 0,2 / 0,3 / 0,4 / 0,5                                                                                                                                                                                               |
| `forward_base`      | $100 M → $450 M    | 36 → 79 h        | `supplyRangeKm` : 150 / 200 / 250 / 300 / 350<br>`repairPerHour` : 0,01 / 0,01 / 0,02 / 0,03 / 0,04                                                                                                                                                                                                  |

Clés d’effet (proposées au moteur, à confirmer par l’équipe éco) :

- `oilPerDay` : pétrole produit par jour dans la province.
- `metalsPerDay` : métaux par jour.
- `foodPerDay` : nourriture par jour.
- `electronicsPerDay` : électronique par jour.
- `incomeMultiplier` : multiplicateur des revenus (argent) de la province.
- `constructionSpeed` : multiplicateur de vitesse de construction des bâtiments de la province.
- `oilMultiplier` : multiplicateur du pétrole des provinces de la nation dans le rayon.
- `radiusKm` : rayon d’effet autour de la ville de la province.
- `productionSpeed` : multiplicateur de vitesse de production (toutes catégories).
- `productionCost` : multiplicateur du prix des unités produites dans la province.
- `researchSpeed` : multiplicateur national de vitesse de recherche (le meilleur bâtiment compte).
- `tradeMultiplier` : multiplicateur du commerce maritime.
- `embarkSpeed` : vitesse d’embarquement.
- `shipCapacity` : navires stationnés.
- `navalProductionSpeed` : vitesse de production navale.
- `repairPerHour` : fraction de PV réparée par heure pour les unités stationnées.
- `aircraftCapacity` : aéronefs stationnés.
- `rearmMinutes` : réarmement et ravitaillement au sol.
- `airProductionSpeed` : vitesse de production aérienne.
- `garrisonCapacity` : unités terrestres en garnison.
- `supplyRangeKm` : rayon de ravitaillement (dépôt).
- `landProductionSpeed` : vitesse de production terrestre.
- `infantryProductionSpeed` : vitesse de production de l’infanterie.
- `mobilizationSpeed` : vitesse de mobilisation.
- `damageReduction` : réduction des dégâts subis par les unités terrestres qui défendent la province.
- `rangeKm` : portée de l’arme fixe.
- `damageAircraft` : dégâts par round contre avions.
- `damageHelicopter` : contre hélicoptères.
- `damageDrone` : contre drones.
- `damageMissile` : contre missiles.
- `pk` : probabilité d’interception par engagement.
- `magazine` : intercepteurs avant rechargement.
- `damageShip` : dégâts par round contre navires.
- `detectionKm` : portée de détection du radar fixe.
- `stealthDetect` : capacité à voir les furtifs (0 à 1).
- `silos` : missiles balistiques stockés et lançables.
- `hardening` : réduction des dégâts subis par le silo.
- `healPerHour` : PV rendus par heure aux unités de la province.
- `lossReduction` : réduction des pertes définitives.
- `researchProtection` : réduction des chances de vol de recherche.

## 7. Autres réglages (`data/balance/default.json`)

- **Argent** : dollars US ; budget annuel réel versé à raison de 1/365 par jour de jeu, multiplicateur 1, part liée aux provinces 50 %. Trésorerie de repli d’une nation sans ORBAT : $500 M.
- **Recherche** : durée ×1, file de 5 nœuds.
- **Licences** : prix = prix unitaire × 20 (une licence de F-16 ≈ $1,3 Md), remise de production 30 %.
- **Marché noir** : prix × 2,5, détection 25 %.
- **Logistique** : ravitaillement à 300 km, efficacité limitée 70 %, coupée 35 %.
- **Mobilisation** : 1 bataillon par province, revenus −25 %, stabilité -1 par jour.
- **Alerte mondiale** : seuils 20, 45, 70, 90, décroissance 5 par jour.
- **Diplomatie** : conseil tous les 30 jours, vote ouvert 12 h réelles, majorité simple, veto, 10 sièges tournants (comme le Conseil de sécurité).
- **Stabilité** : départ 70, révolte sous 30, coup d’État sous 15.

### Opérations de renseignement

| Opération            |   Coût | Durée | Réussite de base | Exposition en cas d’échec |
| -------------------- | -----: | ----: | ---------------: | ------------------------: |
| `infiltrate_spy`     |   $5 M |  72 h |             60 % |                      30 % |
| `recruit_source`     |   $3 M |  96 h |             50 % |                      25 % |
| `turn_agent`         |   $2 M |  48 h |             50 % |                      40 % |
| `exfiltrate`         |   $4 M |  24 h |             70 % |                      30 % |
| `steal_research`     |  $50 M | 168 h |             30 % |                      50 % |
| `sabotage_factory`   |  $20 M |  72 h |             40 % |                      50 % |
| `fund_rebels`        | $100 M | 168 h |             60 % |                      40 % |
| `listen_area`        |   $2 M |  24 h |             80 % |                       5 % |
| `intercept_army`     |   $5 M |  48 h |             60 % |                      10 % |
| `jam_area`           |   $3 M |  12 h |             80 % |                      10 % |
| `cyber_radar`        |  $30 M |  48 h |             50 % |                      20 % |
| `cyber_production`   |  $40 M |  72 h |             45 % |                      25 % |
| `cyber_orders`       |  $50 M |  48 h |             35 % |                      30 % |
| `disinformation`     |  $10 M |  72 h |             60 % |                      20 % |
| `leak_plans`         |   $5 M |  24 h |             70 % |                      30 % |
| `plant_fake_report`  |   $3 M |  48 h |             55 % |                      30 % |
| `deploy_decoys`      |  $15 M |  24 h |             80 % |                      10 % |
| `fake_radio_traffic` |   $2 M |  24 h |             75 % |                      10 % |
| `counterintel_sweep` |  $10 M |  72 h |             60 % |                       0 % |

## 8. Scénarios

| Scénario                               | Année | ORBAT | Nations    | Caméra         |
| -------------------------------------- | :---: | :---: | ---------- | -------------- |
| Guerre froide (1985) (`cold-war-1985`) | 1985  | 1985  | toutes     | 20°, 45° ×1,8  |
| Europe de l'Est (`eastern-europe`)     | 2025  | 2025  | 24 nations | 32°, 52° ×3,2  |
| Moyen-Orient (`middle-east`)           | 2025  | 2025  | 28 nations | 45°, 29° ×3,6  |
| Pacifique (`pacific`)                  | 2025  | 2025  | 38 nations | 130°, 18° ×2,6 |
| Le monde aujourd'hui (`world-today`)   | 2025  | 2025  | toutes     | 15°, 25° ×1,6  |

La Guerre froide filtre le catalogue par `era.introduced ≤ 1985` et la recherche par `eraYear ≤ 1985` : pas de
furtivité, de drones armés, de génération 4+, de SAM de 4e génération ni de cyber. Le test vérifie qu’un système
disponible en 1985 se produit avec la technologie de 1985, et que les États-Unis comme l’URSS disposent de chasseurs,
chars, VCI, artillerie, défense aérienne, sous-marins et armes nucléaires.

## 9. Points incertains

- **Prix très incertains (±50 % ou plus)** : H-20, B-21, S-70, GJ-11, Eurodrone, J-35, Type 003, Kheibar
  Shekan, KN-23, Hwasong-17, Sarmat, satellites (tous), armes antisatellites, radars transhorizon russes et
  iraniens, Bavar-373, drones iraniens et chinois, munitions rôdeuses (Lancet ≈ $35 k, Geran-2 ≈ $80 k).
- **Prix « domestiques »** russes et chinois : un choix assumé (coût pour la nation productrice) ; à l’achat sur
  le marché, le jeu applique `licences` et `blackMarket`.
- **Virginia ≈ $3,4 Md** : prix moyen des blocs III et IV ; le bloc V dépasse $4 Md.
- **Munitions rôdeuses et drones kamikazes** (Switchblade, Lancet, Harop, Geran-2, Shahed-136) : catégorie
  `drone`, mais avec un champ `missile` (munition consommée à l’impact) ; le moteur doit les traiter comme des
  missiles lents.
- **Satellites** : classe de cible `missile` (seuls les ASAT, rôle `asat`, doivent pouvoir les viser) ; les armes
  antisatellites ont `damage.missile = 30` et une portée minimale de 200 km. Le moteur doit restreindre les
  cibles des ASAT aux satellites et exclure les satellites des combats ordinaires.
- **Bombe B61-12** : pas de rayon d’action propre (`operationalRadiusKm = null`), elle doit être emportée.
- **Budgets et entretien** : l’entretien réel de l’inventaire complet d’une grande puissance approche son budget ;
  si les parties sont trop lentes, jouer sur `money.budgetMultiplier` plutôt que sur les prix.
- **Coûts de recherche** : réalistes, donc hors de portée des petites nations pour les portes de pointe (gen5,
  nucléaire) ; c’est voulu (licences, marché, vol de recherche par le renseignement).

## 10. Écarts de contrat

- `BalanceSchema.buildings.levels` (ajout optionnel, `packages/shared/src/balance.ts`) : niveaux 1 à 5 par type
  de bâtiment.
- Fichiers : `data/catalog/fighters.json` devient `fighter.json` et les `phase1-*.json` sont remplacés par un
  fichier par catégorie (`<catégorie>.json`, champ `category` renseigné).
- Infanterie : `unitSize` passe de 3 à 1 (1 bataillon) avec PV ×3 et dégâts ×2,5, pour garder la puissance
  d’une unité produite. Mistral : `unitSize` 2 → 1 (une section).
