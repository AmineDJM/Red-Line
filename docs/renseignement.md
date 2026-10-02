# Renseignement — Red Line

Modèle inspiré des services français : **sécurité intérieure** (DGSI), **renseignement extérieur**
(DGSE), **renseignement militaire** (DRM). Rapports cotés OTAN (fiabilité A–F, crédibilité 1–6).
Moteur pur et déterministe : `packages/engine/src/modules/intel/*` ; contrats :
`packages/shared/src/intel.ts`, `protocol.ts` (`INTEL_OPS`) ; réglages : `data/balance/default.json`,
section `intel` (zod : `packages/shared/src/balance.ts`) ; console : `apps/client/src/windows/IntelWindow.tsx`.

## Inventaire (avant cette étape)

| Domaine        | Existant                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Départements   | 3 départements, niveau 1 + portes de recherche `research.intel.<dept>1..3`, budget journalier prélevé (dollars), qualité = niveau + budget, capacité = 1 + niveau                                                                                                                             |
| Opérations     | 21 : infiltration, recrutement, retournement, exfiltration, vol de recherche, sabotage, financement de rebelles, écoute de zone, interception d'une armée, brouillage, 3 cyberattaques, désinformation, fuite, faux rapport, leurres, faux trafic radio, contre-espionnage, 2 reconnaissances |
| Agents         | officier / source, démasqué discrètement puis arrêté publiquement (retournement possible entre-temps), agent double invisible de son propriétaire                                                                                                                                             |
| Rapports       | notes quotidiennes ×3 (07:00), flash (mouvements près des frontières, frappes), cotation bruitée, intoxication (`fk`, jamais dans la vue), partage entre alliés                                                                                                                               |
| Intérieur      | priorité (équilibrée, contre-espionnage, protection, surveillance), sites protégés, menace par province, détection des opérations en préparation                                                                                                                                              |
| Reconnaissance | connaissance progressive des provinces (axes économique et militaire 0..3), mission sur une province ou un pays entier en phases, imagerie (signal `imagery` du module mil)                                                                                                                   |

## Profondeur ajoutée (`deep.ts`, réglages `intel.deep`)

### SIGINT (onglet SIGINT, département militaire)

- **Capteurs en service**, recalculés chaque jour en un seul parcours des unités (poids par matériel en
  cache) : écoute (rôles `sigint`/`elint` ou capteur `sigint` — satellites d'écoute ×3, RQ-4, Heron TP…),
  imagerie (satellites optiques/radar ×3, drones et avions de reconnaissance ×0,5), guerre électronique
  (matériels `ew.jamming` > 0 : EA-18G…). Bonus `sensorBonusMax × x / (x + sensorRef)` sur la réussite
  des écoutes, interceptions, géolocalisations (écoute) et reconnaissances militaires / désignations
  (imagerie) ; les brouilleurs élargissent le rayon de brouillage (`ewJamBonus`).
- **Chiffrement** d'une nation : `encryptionBase + encryptionPerLevel × (niveau moyen des services − 1)`.
- **Cryptanalyse** (`cryptanalysis`) : décryptage `+cryptoStep × (0,5 + qualité) / (0,5 + chiffrement)`,
  érodé de `cryptoDecayPerDay` par jour (changements de clés).
- **Interception des communications** (`intercept_comms`) : analyse du trafic (indicateur « trafic de
  commandement »), au-delà de `decryptOrders` les ordres de mouvement (destinations, contacts révélés),
  au-delà de `decryptPlans` les plans de guerre (dossier → intentions). **Faux trafic** : chance
  `disinfoBase × qualité intérieure adverse × (1 − décryptage)` d'un rapport truqué (drapeau interne).
- **Géolocalisation des émetteurs** (`geolocate_emitters`) : radars, défenses aériennes, avions de guet,
  PC révélés comme contacts identifiés (incertitude `geolocateUncKm`, ×`jamUncFactor` en zone brouillée).

### HUMINT (onglet HUMINT, département extérieur)

- **Couverture** choisie à l'infiltration : diplomatique (détection ×1,2, **expulsion** à l'arrestation,
  tension ×0,5, notification « diplomates expulsés ») ou non officielle (détection ×0,7, arrestation,
  tension ×1,5). Agents d'avant cette étape : règles d'origine.
- **Fiabilité perçue** (cotation A–F) qui progresse chaque jour (`reliabilityPerDay`, ×`handlerBonus`
  pour une source quand un officier traitant est sur place). Un agent double progresse aussi : son
  propriétaire n'en sait rien.
- **Culture d'une source** (`cultivate_source`, fiabilité ≥ `cultivateMinReliability`) : accès terrain →
  ministère (trésor estimé, recherche en cours) → état-major (plans de guerre, meilleur ordre de bataille).
  Détection ×`accessDetect` par niveau ; échec démasqué = arrestation de l'agent.
- **Vérification** (`vet_agents`) : démasque les agents doubles (statut « double » visible, intentions
  qu'ils ont fournies retirées) et détecte ceux sous surveillance.
- Sources de haut niveau : rapport à chaque changement de plans ; un agent double fournit des plans vides
  (truqués).

### Renseignement militaire (onglet Militaire)

- **Ordre de bataille estimé** par nation suivie : fourchettes par catégorie et total, écart
  `orbatSpreadMax → orbatSpreadMin` selon la qualité (service, imagerie, source d'état-major, décryptage).
  La fourchette encadre la vérité, sauf agent double chez la cible (effectifs minorés).
- **Indice de menace** 0..100 : guerre en cours, concentration de forces près de nos villes (éléments,
  `massingRef`), plans de guerre connus (× qualité), trafic de commandement récent, mobilisation
  industrielle (source au ministère), opérations clandestines attribuées. **Alerte stratégique** (rapport
  flash) au-delà de `alertThreshold`, au plus une fois par `alertCooldownH`.
- **Désignation de cibles** (`designate_targets`) : analyse d'imagerie d'une province, forces
  identifiées (contacts précis), connaissance militaire 3/3, frappe proposée unité par unité.
- **Évaluation des dégâts** après chaque frappe d'un joueur (signal `strike`) : forces restantes dans
  `bdaRadiusKm`, précision selon la qualité et l'imagerie.

### Renseignement intérieur (onglet Intérieur)

- **Démantèlement d'un réseau** (`dismantle_network`) : arrestation des agents repérés d'une nation et
  chasse aux autres (`dismantleCatch`).
- **Déception** (`deception_plan`) : faux plans de guerre transmis à l'adversaire (intentions truquées
  dans son dossier, rapport chez lui s'il est joueur) ; plus crédible s'il a des agents chez nous
  (×1,2), surtout un agent retourné (×1,5).
- **Durcissement des sites** (`harden_sites`) : `hardenDays` jours, réussite des sabotages, financements
  rebelles et cyberattaques industrielles adverses × (1 − `hardenReduction`).
- Existant conservé : priorité, sites protégés, menace par province, retournement des agents démasqués.

### Synthèse

- **Bulletin quotidien** : la note militaire de 07:00 contient une « synthèse par théâtre » (menace,
  tendance, indicateurs, forces estimées) ; pas de rapport supplémentaire (tirages inchangés).
- **Dossiers pays** (`view.intel.dossiers`) : menace, tendance, indicateurs, alerte, forces estimées,
  intentions (source et cotation), trésor estimé, recherche, niveau des services, décryptage, chiffrement,
  agents et meilleur accès, fiabilité d'ensemble. Calculés chaque jour pour les nations des joueurs
  seulement (les IA ne lisent pas les rapports).
- **Carte des menaces** : mini-carte, cercles sur les capitales proportionnels à l'indice.

## IA

Une décision par jour (inchangé). Ajouts : démantèlement si deux agents d'une même nation sont démasqués,
durcissement après des sabotages ou cyberattaques répétés, et en guerre cryptanalyse puis interceptions
de l'ennemi ou géolocalisation de ses émetteurs (tirages hachés, sans consommer le PRNG).

## Garanties

- Rien de caché dans la vue : intoxications (`fk`), état réel des agents (double non vérifié), victime et
  agent d'une opération restent dans le moteur (tests `intel-view`, `intel-deep`).
- Déterminisme : calculs quotidiens par hachage (`hash01`), tirages des opérations sur le PRNG de l'état ;
  rejeu et reprise après sérialisation identiques.
- Sauvegardes anciennes : tous les nouveaux champs sont optionnels (`sx`, `cr`, `ev`, `hd` par nation ;
  `cv`, `ac`, `rl`, `ex` par agent) ; défauts appliqués à la lecture.
- Performance : un parcours quotidien des unités pour les capteurs, évaluations limitées aux joueurs
  (`dossierNations` nations chacun).

## Console (client)

Six onglets : **SIGINT** (capteurs, décryptage par nation), **HUMINT** (réseau d'agents : couverture,
accès, fiabilité, statut ; cultiver, vérifier, exfiltrer en un clic), **Militaire** (carte et liste des
menaces), **Intérieur** (priorité, sites protégés, menace), **Dossiers** (carte des menaces, liste,
dossier), **Rapports** (filtre par onglet). Chaque onglet d'action : budget et capacité du département,
cartes d'opérations avec coût, durée, réussite de base et risque — un clic ouvre le dialogue prérempli,
un second lance. Mise en page en une colonne sur mobile. Logique pure testée dans
`apps/client/test/intel.test.ts` (`lib/intelTabs.ts`).
