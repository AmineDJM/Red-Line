# Défense antiaérienne

La défense antiaérienne engage **tout ce qui vole**, selon les capacités réelles de chaque système : avions,
hélicoptères, drones (y compris munitions rôdeuses type Shahed), missiles de croisière (et antinavires,
antiradars), missiles balistiques de courte et moyenne portée, et hypersoniques pour les seuls systèmes qui en sont
réellement capables. Code : `packages/engine/src/modules/mil/ad-profile.ts` (profils, lecture seule) et
`airdefense.ts` (engagements, ordres, vue, IA) ; contrat : `packages/shared/src/airdefense.ts`,
`interceptor.envelopes` dans `packages/shared/src/catalog.ts` ; chiffres : `data/catalog/air_defense.json` et
`data/balance/default.json` (`military.airDefense`).

## Modèle

### Données par système (`interceptor`, validées par zod)

| Champ                   | Sens                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envelopes.<catégorie>` | `minKm`, `maxKm` (portée d'interception), `ceilingKm` (plafond, information de fiche), `pk` (probabilité de destruction par intercepteur au cœur de l'enveloppe), `shots` (intercepteurs par cible, doctrine) |
| `magazine`              | intercepteurs par élément (batterie, division, véhicule, section)                                                                                                                                             |
| `channels`              | intercepteurs guidés simultanément par élément et par fenêtre d'engagement (3 min)                                                                                                                            |
| `reactionS`             | délai entre l'entrée de la menace dans l'enveloppe et le premier tir                                                                                                                                          |
| `reloadH`               | rechargement complet du magasin, progressif (ravitaillement compris)                                                                                                                                          |

Catégories (`AIR_THREATS`) : `aircraft`, `helicopter`, `drone`, `cruise_missile`, `ballistic_missile`,
`hypersonic`. Une catégorie absente des enveloppes n'est **jamais** engagée. La catégorie d'une menace : classe de
cible de l'aéronef (avion, hélicoptère, drone, en vol seulement), ou type du missile (`missile.kind` : croisière,
antinavire, antiradar → croisière ; balistique, ICBM, SLBM → balistique ; hypersonique) ; une munition rôdeuse
(catégorie `drone` du catalogue) est un drone.

Les anciennes fiches sans enveloppes (navires notamment) gardent leur comportement : catégories déduites de
`against`, portée d'arme unique, interception des seules salves de missiles (aéronefs en rounds de combat). Les
chasseurs sans fiche `interceptor` interceptent missiles de croisière et drones avec leurs missiles air-air
(`fighterPkPerDamage` × dégâts « missile », au plus `fighterPkMax`, `fighterMagazine` missiles) quand ces menaces
passent à leur portée (patrouille, interception).

### Engagement automatique

1. **Détection d'entrée.** Les paires (unité, unité) surveillent, en plus des portées d'arme, les bornes de
   l'enveloppe propre à la catégorie de la cible (`adBand`, `encounters/pairs.ts`) : l'instant exact où un
   balistique entre dans les 60 km d'un S-400 programme un événement, sans balayage périodique.
2. **Programmation.** Une menace hostile (guerre sans cessez-le-feu, ou salve visant un allié), visible, dans
   l'enveloppe, est programmée après le délai de réaction (`icq["batterie>menace"]`).
3. **Cycle de la batterie.** À l'heure dite, la batterie traite d'un bloc toutes ses menaces dues, par priorité :
   ordre du joueur, puis catégorie (`priority` : hypersonique 6, balistique 5, croisière 4, avion 3, hélicoptère 2,
   drone 1,5), × `protectFactor` (2) si la salve vise un point de sa bulle (ce qu'elle protège), puis impact le plus
   proche, puis distance.
4. **Tir.** Par menace : `shots` intercepteurs par élément visé (salve : un coup au but suffit), dans la limite du
   magasin et des canaux libres de la fenêtre. pk = pk de l'enveloppe × dégradation en limite de portée (pleine
   jusqu'à `fullPkShare` = 60 % de la portée, puis linéaire jusqu'à × `farPkFactor` = 0,5 à la portée maximale) ×
   (1 − évasion du missile, ou 1 − furtivité de l'aéronef × (1 − détection furtive du radar)) × recherche
   (`missiles.interception`) × (1 − brouillage ami couvrant la cible × (1 − résistance au brouillage)). Plafonné à
   0,98.
5. **Effet.** Salve : chaque intercepteur au but retire un missile ; réengagement à la fenêtre suivante tant que la
   salve reste dans l'enveloppe avant l'impact. Aéronef : chaque élément abattu est retiré (dégâts = points de vie
   d'un élément, pertes et rapport par le crochet `onDamage`) ; réengagement après `aircraftReengageMinutes` (5).
6. **Saturation.** Canaux pris : la menace attend la fenêtre suivante ; si l'impact survient avant, ou si le
   magasin est vide, elle passe (contre-mesure « saturation » du rapport de bataille). Plus de menaces que
   d'intercepteurs ⇒ des menaces passent ; plus de batteries ⇒ moins passent.
7. **Rechargement.** Magasin progressif : `magazine × éléments` en `reloadH` depuis le dernier tir. Batterie vide :
   réveil au premier intercepteur rechargé (`adrl`), les menaces passées entre-temps sont reprises.

Posture « tenir » : la batterie n'engage les aéronefs que sur ordre ; les missiles et munitions rôdeuses sont
toujours interceptés.

### Ordres manuels

« Attaquer » avec une défense à enveloppes sur une cible volante (aéronef, ou salve de missiles en vol) :
acceptée si la catégorie est engagée, la cible dans l'enveloppe et le magasin non vide ; tir immédiat, priorité
absolue (`adf`). Refus clairs et traduits (`game.orders.reasons.*`) :

- `ad_cannot_engage` : « Pantsir-S1 n'intercepte pas les missiles balistiques. »
- `ad_out_of_range` : « S-400 Triumf — hors de portée : 745 km, portée 3–380 km contre les avions. »
- `ad_no_ammo` : « Pantsir-S1 : plus d'intercepteurs, rechargement en cours. »

Les refus existants sont inchangés (cible au sol : `air_defense_air_only` ; cible invisible, amie, cessez-le-feu).
Une sélection mixte est exécutée en partie (`partial`), comme pour les autres ordres.

### Interface

- Fiche d'arme (`components/AirDefenseCaps.tsx`, dans la fiche du catalogue et la fiche d'une pile) : une ligne par
  catégorie avec icône, portée, plafond, Pk, tirs par cible (catégories non interceptées grisées), magasin, canaux,
  réaction, rechargement ; pour sa propre pile, jauge des intercepteurs restants et délai jusqu'au plein.
- Panneau de sélection : intercepteurs restants (« 18/32 · Plein dans 1 h 20 »), pastilles par catégorie avec la
  portée maximale.
- Carte : cercle principal (portée d'arme, en ambre) et cercles cyan pointillés des enveloppes plus courtes,
  étiquetés par catégorie (« CRS/HÉLI 40 km », « BAL 60 km »). Les engagements alimentent les tirs des batailles :
  traceurs d'interception (missiles), tirs antiaériens et explosions (aéronefs), tirs manqués compris.
- Rapport de bataille : menaces abattues par catégorie (« Abattus : drones ») et intercepteurs tirés
  (`BattleAarSide.intercepts`, `interceptorsFired`, optionnels).

### IA

Nation en guerre (`airDefenseAi`, réglages `military.airDefense.ai`) : une réflexion sur deux, ses batteries mobiles
protègent la capitale (2), ses bases aériennes (1) et ses villes du front (1 ; ville à elle à moins de 250 km d'un
ennemi vu). Une batterie couvre un point si elle en est à moins de la moitié de sa portée principale ; les points
découverts reçoivent les batteries libres les plus proches. Stocks : une batterie à moins de 30 % de son magasin ne
part pas au front et y est relevée (retour vers la capitale pour recharger) dès qu'une remplaçante arrive. Au plus
3 redéploiements par réflexion ; les batteries des opérations et les sites fixes ne bougent pas.

## Valeurs retenues

Pk par intercepteur avant évasion et brouillage ; « ×2 » : intercepteurs par cible.

| Système            | Avions              | Hélicos             | Drones              | Croisière          | Balistiques          | Hypersoniques       | Magasin | Canaux | Réaction | Recharge |
| ------------------ | ------------------- | ------------------- | ------------------- | ------------------ | -------------------- | ------------------- | ------: | -----: | -------: | -------: |
| MIM-104 Patriot    | 3–160 km · 60 % ×2  | 3–40 km · 60 % ×1   | 3–100 km · 60 % ×1  | 3–60 km · 70 % ×2  | 3–40 km · 80 % ×2    | 3–30 km · 35 % ×2   |      16 |      9 |      9 s |      6 h |
| S-400 Triumf       | 3–380 km · 60 % ×2  | 3–40 km · 60 % ×1   | 3–120 km · 60 % ×1  | 3–40 km · 55 % ×2  | 5–60 km · 50 % ×2    | —                   |      32 |     20 |     10 s |      6 h |
| Pantsir-S1         | 1–20 km · 45 % ×2   | 1–20 km · 65 % ×1   | 0–20 km · 65 % ×1   | 1–15 km · 55 % ×2  | —                    | —                   |      12 |      4 |      5 s |      2 h |
| Mistral            | 0,5–6 km · 45 % ×1  | 0,5–8 km · 70 % ×1  | 0,5–6 km · 60 % ×1  | 0,5–5 km · 35 % ×1 | —                    | —                   |      12 |      3 |      5 s |      1 h |
| NASAMS             | 1–40 km · 60 % ×2   | 1–30 km · 70 % ×1   | 1–30 km · 75 % ×1   | 1–30 km · 75 % ×1  | —                    | —                   |      18 |     12 |      5 s |      3 h |
| Avenger            | 0,5–5 km · 35 % ×1  | 0,5–6 km · 60 % ×1  | 0,5–5 km · 60 % ×1  | —                  | —                    | —                   |       8 |      2 |      5 s |      1 h |
| THAAD              | —                   | —                   | —                   | —                  | 30–200 km · 85 % ×2  | —                   |      48 |     16 |     10 s |      6 h |
| Stinger            | 0,2–5 km · 35 % ×1  | 0,2–6 km · 60 % ×1  | 0,2–5 km · 55 % ×1  | —                  | —                    | —                   |      12 |      3 |      5 s |      1 h |
| MIM-23 Hawk        | 2–45 km · 50 % ×2   | 2–30 km · 50 % ×1   | 2–35 km · 45 % ×1   | 2–30 km · 45 % ×2  | —                    | —                   |      18 |      6 |     15 s |      4 h |
| Tor-M2             | 1–16 km · 55 % ×2   | 1–16 km · 70 % ×1   | 1–15 km · 70 % ×1   | 1–12 km · 65 % ×2  | —                    | —                   |      16 |      4 |      5 s |      2 h |
| Buk-M3             | 3–70 km · 60 % ×2   | 3–40 km · 65 % ×1   | 3–40 km · 60 % ×1   | 3–35 km · 60 % ×2  | 3–20 km · 30 % ×2    | —                   |      12 |      6 |     10 s |      3 h |
| S-300PMU2          | 3–200 km · 55 % ×2  | 3–30 km · 55 % ×1   | 3–100 km · 50 % ×1  | 5–40 km · 50 % ×2  | 5–40 km · 40 % ×2    | —                   |      24 |     12 |     15 s |      8 h |
| S-500 Prometey     | 5–400 km · 65 % ×2  | 5–40 km · 50 % ×1   | 5–150 km · 50 % ×1  | 5–60 km · 55 % ×2  | 10–200 km · 60 % ×2  | 10–150 km · 35 % ×2 |      16 |     10 |      4 s |      8 h |
| Igla               | 0,5–5 km · 30 % ×1  | 0,5–5 km · 55 % ×1  | 0,5–5 km · 50 % ×1  | —                  | —                    | —                   |      12 |      3 |      5 s |      1 h |
| S-75 Dvina         | 7–45 km · 30 % ×3   | —                   | 7–40 km · 25 % ×2   | —                  | —                    | —                   |       6 |      3 |     60 s |      4 h |
| S-125 Neva/Pechora | 3–25 km · 35 % ×2   | 3–20 km · 35 % ×1   | 3–20 km · 35 % ×1   | —                  | —                    | —                   |       8 |      2 |     25 s |      3 h |
| 2K12 Kub           | 4–24 km · 40 % ×2   | 4–20 km · 45 % ×1   | 4–20 km · 40 % ×1   | —                  | —                    | —                   |      12 |      3 |     25 s |      3 h |
| 9K33 Osa           | 1,5–10 km · 35 % ×2 | 1,5–10 km · 50 % ×1 | 1,5–10 km · 45 % ×1 | —                  | —                    | —                   |       6 |      2 |     20 s |      1 h |
| ZSU-23-4 Shilka    | 0–2,5 km · 15 % ×1  | 0–2,5 km · 35 % ×1  | 0–2,5 km · 40 % ×1  | —                  | —                    | —                   |       8 |      2 |      5 s |    0,5 h |
| Strela-10          | 0,8–5 km · 30 % ×1  | 0,8–5 km · 50 % ×1  | 0,8–5 km · 45 % ×1  | —                  | —                    | —                   |       8 |      2 |      8 s |      1 h |
| HQ-9B              | 3–260 km · 55 % ×2  | 3–30 km · 55 % ×1   | 3–100 km · 55 % ×1  | 3–50 km · 60 % ×2  | 5–35 km · 45 % ×2    | —                   |      32 |     12 |     12 s |      6 h |
| HQ-16              | 2–70 km · 55 % ×2   | 2–35 km · 60 % ×1   | 2–40 km · 55 % ×1   | 2–35 km · 60 % ×2  | —                    | —                   |      24 |      6 |     10 s |      3 h |
| HQ-17              | 1–15 km · 50 % ×2   | 1–15 km · 65 % ×1   | 1–12 km · 65 % ×1   | 1–12 km · 60 % ×2  | —                    | —                   |       8 |      4 |      6 s |      2 h |
| HQ-7               | 0,5–12 km · 40 % ×2 | 0,5–12 km · 55 % ×1 | 0,5–10 km · 45 % ×1 | 1–8 km · 40 % ×2   | —                    | —                   |       4 |      2 |      6 s |      1 h |
| SAMP/T             | 3–120 km · 65 % ×2  | 3–40 km · 65 % ×1   | 3–80 km · 65 % ×1   | 3–50 km · 75 % ×2  | 3–25 km · 60 % ×2    | —                   |      32 |     16 |      8 s |      6 h |
| IRIS-T SLM         | 1–40 km · 65 % ×2   | 1–30 km · 75 % ×1   | 1–30 km · 85 % ×1   | 1–30 km · 85 % ×1  | —                    | —                   |      24 |     12 |      5 s |      3 h |
| Skynex             | 0–4 km · 25 % ×1    | 0–4 km · 50 % ×1    | 0–4 km · 70 % ×1    | 0–3,5 km · 50 % ×1 | —                    | —                   |      24 |      4 |      4 s |    0,5 h |
| Gepard             | 0–4 km · 20 % ×1    | 0–4 km · 45 % ×1    | 0–4 km · 55 % ×1    | 0–3 km · 30 % ×1   | —                    | —                   |      16 |      2 |      5 s |    0,5 h |
| Crotale            | 0,5–11 km · 45 % ×2 | 0,5–11 km · 60 % ×1 | 0,5–10 km · 55 % ×1 | 1–8 km · 50 % ×2   | —                    | —                   |       8 |      2 |      6 s |      1 h |
| Dôme de fer        | —                   | —                   | 4–70 km · 90 % ×1   | 4–40 km · 80 % ×1  | —                    | —                   |      60 |     20 |     15 s |      4 h |
| Fronde de David    | 5–250 km · 60 % ×2  | —                   | 5–100 km · 60 % ×1  | 5–150 km · 75 % ×2 | 5–100 km · 60 % ×2   | —                   |      24 |      8 |     10 s |      6 h |
| Arrow 3            | —                   | —                   | —                   | —                  | 100–800 km · 85 % ×2 | —                   |      24 |      8 |     15 s |      8 h |
| Bavar-373          | 5–300 km · 45 % ×2  | 5–30 km · 45 % ×1   | 5–100 km · 45 % ×1  | 5–40 km · 45 % ×2  | 10–60 km · 35 % ×2   | —                   |      16 |      6 |     15 s |      6 h |
| Akash              | 3–30 km · 50 % ×2   | 3–25 km · 55 % ×1   | 3–25 km · 50 % ×1   | 3–20 km · 50 % ×2  | —                    | —                   |      12 |      4 |     15 s |      3 h |

Brouilleurs (Krasukha-4, brouilleurs génériques) : pas d'intercepteurs, ils neutralisent les drones en rounds de
combat et dégradent la probabilité d'interception adverse (brouillage).

## Sources et choix

Ordres de grandeur issus de sources publiques ouvertes (fiches des industriels et des exportateurs, IISS _The
Military Balance_, CSIS Missile Defense Project « Missile Threat », Army Recognition, ODIN (US Army TRADOC), rapports
publics sur les engagements en Ukraine et au Proche-Orient). Les probabilités réelles ne sont pas publiques : les Pk
retenus sont des estimations de jeu, cohérentes entre systèmes (génération, guidage, retours d'expérience publiés).

- **S-400** (Almaz-Antey, Rosoboronexport) : 40N6E annoncé à 380–400 km contre de grands aéronefs, 48N6DM à 250 km,
  9M96E2 à 120 km (drones de moyenne altitude) ; défense antibalistique annoncée contre des engins jusqu'à 4,8 km/s
  à environ 60 km ; une division : 8 lanceurs × 4 missiles, radar 92N6 (une dizaine de cibles, deux missiles par
  cible) ; réaction annoncée ≈ 10 s. Aucune capacité hypersonique retenue (non démontrée).
- **S-300PMU2** : 48N6E2 à 200 km, capacité antibalistique limitée (≈ 40 km). **S-500** : capacité antibalistique
  et contre les planeurs hypersoniques annoncée par le constructeur (77N6), Pk hypersonique volontairement bas.
- **Patriot** (Raytheon) : PAC-2 GEM-T ≈ 160 km contre avions ; PAC-3 MSE ≈ 35–40 km contre balistiques (doctrine
  de tir en salve de deux), interceptions de Kh-47M2 Kinzhal en phase terminale rapportées en 2023 : seul système
  occidental retenu contre les hypersoniques (Pk bas). Une batterie : 4 à 8 lanceurs ; 16 missiles retenus.
- **SAMP/T** (Eurosam, Aster 30 B1) : 120 km contre avions, balistiques de théâtre jusqu'à 600 km de portée (≈ 25 km).
- **THAAD** (Lockheed Martin) : interception terminale endo/exo-atmosphérique, 200 km, plafond ≈ 150 km,
  balistiques seulement ; 6 lanceurs × 8. **Arrow 3** : exo-atmosphérique, balistiques seulement.
- **Fronde de David** (Stunner) : 40–300 km annoncés contre missiles de croisière, roquettes lourdes et
  balistiques de courte portée. **Dôme de fer** (Rafael, Tamir 4–70 km) : roquettes, obus, drones et missiles de
  croisière ; taux d'interception publiés ≈ 90 %. Roquettes et obus d'artillerie ne sont pas des objets volants
  du jeu (tir indirect résolu en rounds) : seuls drones et croisière sont modélisés.
- **NASAMS** (Kongsberg, AMRAAM/AMRAAM-ER) et **IRIS-T SLM** (Diehl, 40 km, plafond 20 km) : très bons résultats
  publiés contre missiles de croisière et drones en Ukraine.
- **Pantsir-S1** (57E6, 1,2–20 km, plafond 15 km, 12 missiles, 3–4 cibles simultanées) et **Tor-M2** (9M338,
  16 km, 16 missiles, 4 cibles) : défense rapprochée contre aéronefs, drones, missiles de croisière ; aucune
  capacité balistique.
- **Missiles portables** (Stinger, Igla, Mistral 3, Strela-10) : 5–8 km, plafond 3–4 km, efficaces surtout contre
  hélicoptères et drones lents. **Canons** (Gepard, Skynex, Shilka) : 2,5–4 km, très efficaces contre les drones
  (Gepard contre Shahed en Ukraine) ; « magasin » = rafales.
- **Systèmes anciens** (S-75, S-125, Kub, Osa, Hawk) : portées constructeur, Pk historiques bas (Vietnam,
  Proche-Orient), réaction lente ; le S-75 tirait trois missiles par cible.
- **Altitude** : non simulée. Les plafonds sont affichés ; les portées réduites contre hélicoptères et missiles de
  croisière (vol à basse altitude, horizon radar) en tiennent compte.

## Compatibilité et déterminisme

- Contrats partagés en champs optionnels : `interceptor.envelopes/channels/reactionS/reloadH`,
  `UnitView.airDefense`, `BattleAarSide.intercepts/interceptorsFired`, raisons d'ordre `ad_*`.
- État du module : `adf` (engagements ordonnés), `BattleSideX.ic/ifd` optionnels ; `mag` garde son format
  `[restant, instant]` ; les événements `icpt` des anciennes sauvegardes restent valides (même clé
  `batterie>menace`). Moteur pur : tirages par le générateur du module, parcours triés.
- Tests : `packages/engine/test/mil-airdefense.test.ts` (vraies données), `orders-audit.test.ts`.

## Coût de calcul

Banc de `packages/engine/test/mil-bench-real.ts` (vraie carte, vrai catalogue, 201 nations, 2 069 unités dont une
batterie Patriot par nation, 400 ordres dont salves de Tomahawk et de Shahed), version de base et nouvelle version
lancées **en parallèle** (même charge machine), temps CPU, moyenne de 3 manches :

| Étape                 |      Base | Défense détaillée |  Écart |
| --------------------- | --------: | ----------------: | -----: |
| Jour calme            |    244 ms |            247 ms |   +1 % |
| Jour de guerre        | 10 317 ms |         10 326 ms | +0,1 % |
| Demi-journée suivante |  4 296 ms |          4 451 ms | +3,6 % |

Profil (jour de guerre et demi-journée suivante) : programmation des engagements 2,7 % du temps, cycles
d'interception 1,5 % (dont l'essentiel en dégâts et rapports, qui remplacent les rounds de combat des défenses
contre les aéronefs), IA de placement 1,3 % (3,7 % avant de l'espacer à une réflexion sur deux et de calculer le
front par ville plutôt que par contact), seuils d'enveloppe des paires 0,3 %.

Monde synthétique de `mil-perf.test.ts` (≈ 4 800 unités, fiches de test anciennes), même méthode : jour calme
320 → 325 ms (+1,5 %), jour de guerre 8 670 → 8 712 ms (+0,5 %), jour suivant 7 225 → 7 389 ms (+2,3 %). Les
mesures en temps mur de la machine partagée (charge 15 à 28) ne sont pas exploitables : base et nouvelle version
y dépassent toutes deux la borne de 500 ms du jour calme ; lancé seul à charge modérée, le test passe.
