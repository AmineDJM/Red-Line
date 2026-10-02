# Bilan de l'IA — « elles sont assez smart ? »

Question d'Amine : _les IA, ça va, elles sont assez smart ?_ Réponse courte, mesurée sur la vraie partie :

- **Avant : non.** Les IA réagissaient, mais sans plan : unités envoyées **une par une** (100 % des attaques),
  **84 à 99 % de l'armée de terre inactive** en pleine guerre, capitale menacée laissée sans garnison une fois sur
  deux, des milliers d'**ordres refusés** par le moteur (cibles impossibles, avions hors de rayon), une production
  figée sur trois catégories (VCI, artillerie, chars), un renseignement qui balayait chez lui au lieu d'espionner
  l'ennemi, et un niveau « difficile » qui déclenchait **une guerre mondiale en deux à trois semaines** (220 à
  280 guerres, 70 à 85 nations rayées de la carte). Et, en partie solo, **le niveau choisi n'était jamais
  appliqué** (toutes les IA restaient en « normal »).
- **Après : nettement mieux, honnêtement « correct » plutôt que « brillant ».** Attaques groupées et dimensionnées
  sur la force ennemie connue, garnison de la capitale, renforts vers les villes menacées, contre-attaques en
  groupe, appui aérien des offensives, production adaptée à la menace observée, réserve de trésorerie, recherche
  selon la doctrine, reconnaissance de l'ennemi, blocus naval (difficile), paix blanche des guerres sans front, et
  trois niveaux réellement distincts. En « normal », guerres imposées : captures réussies 68 → 81 %, unités
  détruites sans rien prendre 25 → 15 %, capitale menacée sans garnison 48 → 4 %, ordres refusés 11 600 → 1 ; en
  « difficile », 217 → 20 guerres d'IA et 72 → 10 nations anéanties en 14 jours. Le jour de guerre intense du banc
  ne coûte pas plus cher (−3 % à +2 %). Les faiblesses qui restent sont listées à la fin.

Tous les chiffres ci-dessous viennent du banc reproductible `packages/engine/bench/ai-eval.ts` (vraie carte,
catalogue, ORBAT 2025, scénario « world-today »), deux graines par configuration.

## Méthode

`ai-eval.ts` crée la partie comme le serveur (un joueur humain **passif**, toutes les autres nations à l'IA au
niveau choisi), simule plusieurs semaines et observe l'état toutes les 6 heures. Un traceur de diagnostic
(`src/ai/trace.ts`, point de passage unique des ordres de l'IA) compte chaque ordre réussi ou refusé sans rien
modifier (empreinte de la partie identique avec ou sans traceur).

Trois scénarios :

| Scénario | Contenu                                                                                                                                                                                                                                                            | Durée    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `forced` | Dix guerres réalistes déclarées à J1 **entre IA** (Russie–Ukraine, Inde–Pakistan, Corées, Arabie–Yémen, Azerbaïdjan–Arménie, Éthiopie–Érythrée, Algérie–Maroc, Venezuela–Guyana, Chine–Taïwan, Israël–Iran) ; les deux camps jouent seuls. France humaine passive. | 14 jours |
| `free`   | Aucune guerre imposée : ce que les IA décident d'elles-mêmes. France (ou Algérie) humaine passive.                                                                                                                                                                 | 21 jours |
| `duel`   | Les dix guerres, agresseur « difficile » contre cible « facile », puis l'inverse.                                                                                                                                                                                  | 14 jours |

Mesures principales : guerres déclarées (et contre qui), nations anéanties, provinces et capitales prises, ordres
de capture et leur issue (prise, ou unité détruite sans prise = « suicide »), taille des groupes envoyés, part de
l'armée de terre inactive en guerre, capitale menacée **sans garnison** (aucune unité terrestre arrêtée dans la
ville, condition qui permet la capture), va-et-vient (une unité renvoyée vers une destination quittée moins de
24 h plus tôt), ordres refusés par le moteur, usage de l'aviation, du renseignement, de la marine, trésorerie
(nations en solde négatif, déficit structurel), production par catégorie, recherche par branche, coût CPU.

```bash
cd packages/engine
node --expose-gc bench/run.mjs ai-eval                                  # forced, 3 niveaux, graines 1 et 2
AIEVAL_MODE=free AIEVAL_DAYS=21 node --expose-gc bench/run.mjs ai-eval
AIEVAL_MODE=duel AIEVAL_DUEL=hard:easy node --expose-gc bench/run.mjs ai-eval
AIEVAL_HUMAN=dza AIEVAL_MODE=free AIEVAL_LEVELS=normal,hard AIEVAL_VERBOSE=1 node --expose-gc bench/run.mjs ai-eval
node bench/run.mjs ai-orders <instantané.bin> 24                        # ordres de l'IA sur un pas du banc réel
```

## Avant : ce que l'évaluation a montré

Chiffres du moteur d'origine (commit `eae29e7`), mêmes scénarios, mêmes graines.

**Tactique terrestre : réactive, dispersée, passive.**

- **100 % des ordres d'attaque ou de capture portaient sur une seule unité.** Une ville ennemie était « prise »
  par un char envoyé seul ; en guerres imposées « normal », 25 % de ces unités étaient détruites sans rien
  prendre (35 % en « difficile »), et seulement 68 % des captures aboutissaient (51 % en « difficile »).
- **96 à 99 % de l'armée de terre restait immobile en pleine guerre** (« normal » et « facile ») : au plus deux
  contre-attaques et une offensive par réflexion, une unité chacune.
- **Capitale menacée sans aucune garnison dans 48 % des relevés** (« normal », 66 % en « difficile ») : rien ne
  gardait la capitale, l'unité la plus proche partait attaquer la première menace venue.
- **Des milliers d'ordres refusés** : 11 600 en 14 jours en « normal », 29 000 en « difficile » (près de
  50 000 en duel). L'IA ordonnait à des unités d'attaquer des cibles qu'elles ne pouvaient pas toucher (des
  fantassins contre des avions : 6 000 refus `invalid_target` en « normal »), à des avions hors de leur rayon
  d'action de patrouiller au-dessus de la capitale, à des navires de tirer au-delà de la portée de leurs
  missiles (portée supposée de 1 500 km), lançait des recherches sans les ressources et des chantiers sans
  l'argent. Du calcul perdu : 8 % du jour de guerre du banc passait dans la vérification de trajet
  (`violatesNeutral`) de ces ordres.
- Les cibles des missiles étaient choisies d'après le **système réel** de contacts seulement détectés (petite
  triche involontaire).

**Production, économie, recherche.**

- Production figée sur **trois catégories** (VCI, artillerie, chars : les meilleurs rapports « valeur / prix »),
  jamais de défense antiaérienne ni d'infanterie, quelle que soit la menace.
- Aucune réserve : la recherche pouvait engager 25 % de la trésorerie d'un pays déjà en déficit.
- Recherche dominée par l'industrie (78 nœuds sur 159 en « normal »), sans lien avec la doctrine.

**Renseignement.** En guerre, la nation se savait « menacée » et faisait un balayage de contre-espionnage **chaque
jour** : 130 balayages pour **0 reconnaissance militaire** de l'ennemi en 14 jours (« normal »).

**Diplomatie.**

- **« Difficile » = guerre mondiale** : 217 à 283 guerres déclarées en 2 à 3 semaines, 72 à 83 nations
  anéanties, 48 à 89 guerres sans frontière commune. Exemples à J3–J4 : Belgique → Luxembourg, Allemagne →
  Suisse, Italie → Vatican et Saint-Marin, États-Unis → Canada et Mexique, Chine → Inde, Suisse → Liechtenstein.
  Cause : une probabilité de guerre **par réflexion** (et non par jour) qui s'emballait dès qu'un voisin était en
  guerre, sans exigence de motif.
- **Invitations d'alliance en boucle** : 1 434 invitations (et autant de refus) en 14 jours en « normal » ; la
  création d'alliance échouait quand le nom « Pacte de <capitale> » était déjà pris.
- « Normal » : calme (1 à 4 guerres en trois semaines, souvent fondées : Maroc → Sahara occidental), mais le Maroc,
  bien plus faible, attaquait l'Algérie humaine.

**Niveaux de difficulté.** En partie solo, le serveur ne transmet le niveau choisi que sur l'entrée du joueur
(`players[].aiLevel`), jamais dans `setup.aiLevel` : **toutes les IA restaient en « normal »** quel que soit le
choix. Hors de cela, « facile » ne contre-attaquait jamais et « difficile » se distinguait surtout par sa
boulimie de guerres.

**Ce qui allait bien** : pas d'unité bloquée (0 dans toutes les parties), pas de guerre contre un pays sans
frontière par décision propre (celles-ci venaient des alliances), paix demandée quand l'IA perd, Conseil de
sécurité utilisé, économie jamais mise en faillite par les dépenses de l'IA elle-même (les soldes négatifs
viennent des données, voir plus bas).

## Ce qui a été changé

Tout passe toujours par des ordres de joueur (`applyOrder`) et par ce que la nation a le droit de voir (ses
unités, ses contacts au niveau d'identification atteint, la carte politique, ses propres comptes). Le
déterminisme est intact (les tests de rejeu et de reprise passent ; la mémoire de l'IA est dans l'état
sérialisé). **Tous les réglages sont dans `data/balance/default.json`, section `ai`** (schéma zod
`AiBalanceSchema`, champs optionnels avec défauts) : un profil par niveau (`ai.levels.easy|normal|hard`) et des
sections `tactical`, `economy`, `strategy`.

**Tactique terrestre (`src/ai/ai.ts`, réécrite)**

- Une image de la situation par réflexion : contacts ennemis vus ou perdus de vue depuis moins de 12 h, force
  ennemie menaçant chacune de ses villes (rayon 150 km) et force tenant chaque ville ennemie (25 km).
- **Points clés** : garnison permanente de la capitale (1 / 2 / 3 unités selon le niveau, plus la force
  nécessaire si l'ennemi approche), renforts vers les villes menacées s'ils suffisent (sinon on ne les sacrifie
  pas) ; hystérésis (marge de 50 %, mémoire de la menace sur la capitale) pour éviter les navettes.
- **Défense** : les ennemis vus chez soi sont attaqués par un groupe dimensionné (force engagée ≥ `attackRatio`
  × force ennemie) et seulement par des unités capables de les toucher (fini les ordres refusés).
- **Contre-attaque** (normal, difficile) : provinces perdues voisines, capitale d'abord.
- **Offensive** : provinces ennemies voisines classées par valeur (revenu, capitale ennemie × `enemyCapitalBonus`)
  et faiblesse ; **jamais une unité seule** (au moins deux), groupe complété jusqu'à la force voulue, et rien
  n'est lancé si la force disponible ne suffit pas. Une unité lancée dans une offensive reste engagée 8 h (pas
  de rappel en renfort, sauf pour la capitale).
- Budget de calcul : nombre de calculs de trajet par réflexion (`pathBudget`).

**Air, missiles, marine (`src/modules/mil/ai.ts`)**

- Patrouilles de chasse au-dessus de la capitale **quand un aéronef ou un missile ennemi est vu à moins de
  600 km** (avant : dès qu'un avion ennemi était vu n'importe où), rayon d'action vérifié avant l'ordre.
- Salves de missiles : portée réelle du missile (les navires tirent avec leur missile de croisière ou
  antinavire), cibles **identifiées** seulement (avant : le système réel de cibles seulement détectées).
- Frappes aériennes sur les forces ennemies chez soi **et en appui des offensives** (défenseurs des villes
  visées).
- Blocus des ports ennemis par les navires de surface libres (difficile ; une unité tient le blocus).

**Production et économie (`src/ai/ai.ts`, `src/ai/money.ts`, `src/modules/eco/ai.ts`)**

- Production adaptée (normal, difficile) : écart entre une composition voulue (aviation ennemie identifiée →
  défense antiaérienne, blindés → chars et artillerie) et la composition actuelle (commandes en cours comprises).
- Faisabilité vérifiée avant l'ordre (fabrication locale : recherche, bâtiment, ressources ; sinon importation au
  prix majoré).
- **Réserve de trésorerie** avant toute dépense de l'IA (production, recherche, chantiers) : 5 jours de budget en
  guerre, 20 en paix, plus 20 jours de déficit structurel s'il y en a ; levée en partie si la capitale est
  menacée.
- Recherche : branches classées selon ses forces (valeur par milieu), sa doctrine ORBAT (us / ru / cn / eu /
  other) et la conjoncture ; ressources vérifiées.

**Renseignement (`src/modules/intel/ai.ts`)** : en guerre, reconnaissance militaire de l'ennemi régulier le plus
proche (probabilité `reconChance` : 0,2 / 0,6 / 0,9) ou un agent sur place ; balayage seulement après un incident
ou si la nation se sait visée.

**Stratégie et diplomatie (`src/ai/strategy.ts`)**

- Probabilité de guerre **par jour** (et non par réflexion : elle s'emballait avec l'agitation des voisins),
  plus forte contre un joueur humain en difficile (0,25 / jour contre 0,02 entre IA).
- Plus de guerre sur la seule foi de ses alliés : ses propres forces doivent peser 60 % du rapport voulu.
- Difficile : sans motif public, il faut une supériorité estimée de ×3.
- Guerre sans front (pas de frontière commune, rien pris ni perdu depuis 3 jours) : paix blanche proposée et
  acceptée.
- Invitations d'alliance : pas de relance avant 5 jours ; nom d'alliance libre (le nom pris faisait échouer la
  création).
- **Niveau de la partie** : quand `setup.aiLevel` est absent, les IA prennent le niveau commun explicite des
  joueurs déclarés (c'est ainsi que le serveur transmet le niveau choisi). Avant, toutes les IA d'une partie
  solo restaient en « normal » quel que soit le choix du joueur.

## Les trois niveaux

|                                                          | Facile      | Normal                                         | Difficile                                                                               |
| -------------------------------------------------------- | ----------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Guerres d'agression                                      | jamais      | avec un motif public, rapport ≥ 2, 10 % / jour | motif ou supériorité ×3, rapport ≥ 2, 2 % / jour entre IA, 25 % / jour contre un joueur |
| Garnison de la capitale                                  | 1           | 2                                              | 3                                                                                       |
| Contre-attaque / offensive                               | non / non   | oui / dans ses propres guerres                 | oui / contre tout ennemi                                                                |
| Groupes (taille max., force exigée)                      | 2, ×1       | 4, ×1,5                                        | 6, ×2                                                                                   |
| Salves de missiles, frappes, patrouilles (par réflexion) | — / — / 1   | 1 salve de 4 / 1 / 1                           | 2 salves de 8 / 2 / 2                                                                   |
| Appui aérien, blocus                                     | non / non   | oui / non                                      | oui / oui                                                                               |
| Production adaptée                                       | non         | oui                                            | oui                                                                                     |
| Reconnaissance en guerre                                 | 20 % / jour | 60 % / jour                                    | 90 % / jour                                                                             |

## Après : mesures

### Guerres imposées entre IA (14 jours, 2 graines, moyennes par partie)

| Mesure                                              | Facile avant | Facile après | Normal avant | Normal après | Difficile avant | Difficile après |
| --------------------------------------------------- | -----------: | -----------: | -----------: | -----------: | --------------: | --------------: |
| Guerres déclarées par les IA (hors les 10 imposées) |            0 |            0 |            2 |            1 |             217 |              20 |
| … sans frontière commune                            |            0 |            0 |            0 |            0 |              48 |               2 |
| Nations anéanties                                   |            0 |            0 |            4 |            5 |              72 |              10 |
| Ordres de capture                                   |            0 |            0 |          313 |          516 |           4 420 |           1 136 |
| Captures réussies                                   |            — |            — |         68 % |         81 % |            51 % |            70 % |
| Unité détruite sans prise                           |            — |            — |         25 % |         15 % |            35 % |            20 % |
| Taille moyenne des groupes                          |         1,00 |         1,03 |         1,00 |         1,66 |            1,00 |            1,71 |
| Ordres à une seule unité                            |        100 % |         97 % |        100 % |         53 % |           100 % |            49 % |
| Armée de terre inactive en guerre                   |         99 % |         99 % |         96 % |         87 % |            84 % |            82 % |
| Capitale menacée sans garnison                      |            — |            — |         48 % |          4 % |            66 % |             9 % |
| Va-et-vient                                         |            0 |            0 |           10 |           29 |             246 |              29 |
| Ordres refusés par le moteur                        |          457 |            0 |       11 587 |            1 |          29 281 |               2 |
| Patrouilles / frappes réussies                      |       19 / 0 |       12 / 0 |    537 / 880 |    138 / 770 |   2 082 / 3 060 |     320 / 1 262 |
| Reconnaissances militaires / balayages              |        0 / 3 |        0 / 0 |      0 / 130 |      16 / 40 |         8 / 686 |         56 / 80 |
| Invitations d'alliance                              |            0 |            0 |        1 434 |           50 |           1 786 |             108 |
| Nations en solde négatif à J14                      |           40 |           32 |           37 |           29 |            14 ¹ |              26 |
| CPU de la partie (s)                                |          4,2 |          4,5 |         18,0 |         17,4 |            63,3 |            26,9 |

¹ Avant, en « difficile », 72 nations avaient disparu : elles ne comptent plus.

Production en « normal » : avant 173 artilleries, 170 VCI, 164 chars ; après 132 VCI, 92 chars, **64 défenses
antiaériennes**, 57 artilleries, **38 infanteries**. Recherche : l'industrie passe de 78 nœuds sur 159 à 54 sur
126 (moins de dépenses, plus ciblées), au profit des branches des forces réellement employées et de la doctrine.

### Ce que les IA décident seules (21 jours, France humaine passive)

| Mesure                         | Normal avant | Normal après | Difficile avant | Difficile après |
| ------------------------------ | -----------: | -----------: | --------------: | --------------: |
| Guerres déclarées par les IA   |            2 |            1 |             251 |              22 |
| … sans frontière commune ²     |            0 |            0 |              65 |               4 |
| Nations anéanties              |            0 |            1 |              83 |              12 |
| Provinces prises               |           18 |            1 |           1 290 |             114 |
| Captures réussies              |         48 % |        100 % |            50 % |            86 % |
| Capitale menacée sans garnison |         32 % |          0 % |            66 % |            15 % |
| Ordres refusés                 |        1 354 |            0 |          34 242 |               4 |
| CPU de la partie (s)           |          6,7 |          4,5 |            74,7 |            16,2 |

² Guerres d'alliance : un agresseur se retrouve en guerre avec les alliés de sa victime (défense mutuelle) ; ces
guerres finissent désormais en paix blanche après 3 jours sans front.

« Difficile » reste agressif, mais de façon opportuniste et locale (Autriche → Liechtenstein, Allemagne →
Luxembourg, Russie → Estonie, Égypte → Gaza, Mozambique → Eswatini…) au lieu d'embraser la planète. « Normal » ne
fait que des guerres motivées (Maroc → Sahara occidental). « Facile » n'agresse jamais.

**Joueur humain.** Avec l'Algérie humaine : avant, le Maroc (×4 plus faible) attaquait en « normal » et le Mali
en « difficile » ; après, aucune IA n'attaque l'Algérie ni la France (leurs voisins se savent trop faibles). Un
petit pays humain est en revanche une proie en « difficile » : la Turquie envahit une Arménie humaine passive
(capitale prise à J8,4), la Russie attaque une Estonie humaine à J4,4 ; en « normal », personne ne les attaque.

### Duels de niveaux (agresseur contre cible, 10 guerres, 14 jours)

|                           | Provinces gagnées par l'agresseur | Provinces gagnées par la cible | Captures réussies |
| ------------------------- | --------------------------------: | -----------------------------: | ----------------: |
| Difficile → facile, avant |                     +121 / +120 ³ |                      −68 / −80 |       63 % / 47 % |
| Difficile → facile, après |                         +93 / +72 |                      −74 / −72 |       88 % / 80 % |
| Facile → difficile, avant |                         −16 / −14 |                      +21 / +18 |       14 % / 44 % |
| Facile → difficile, après |                         −15 / −14 |                  **+41 / +40** |       73 % / 75 % |

³ Avant, l'agresseur « difficile » conquérait aussi des pays tiers (26 guerres de plus) ; la cible « facile »
perd autant de terrain avant et après.

Une cible « difficile » attaquée par une IA « facile » reprend désormais deux fois plus de terrain (contre-attaques
groupées) ; l'écart entre niveaux est net dans les deux sens.

## Coût de calcul

Banc réel (`pnpm --filter @redline/engine bench`, 201 nations, 4 150 unités, dix guerres et 200 ordres à J1),
temps CPU, même machine, ancien et nouveau moteur lancés l'un après l'autre :

| Mesure                                                   |   Avant |   Après |    Écart |
| -------------------------------------------------------- | ------: | ------: | -------: |
| Jour calme (J0 → J1)                                     |  347 ms |  455 ms |  +108 ms |
| **Jour de guerre intense (J1 → J2)**                     | 11,05 s | 10,71 s | **−3 %** |
| Même pas depuis l'instantané J1, 4 alternances (moyenne) | 13,07 s | 13,32 s |     +2 % |
| Jour suivant (J2 → J3)                                   |  5,64 s |  6,42 s |    +14 % |
| Cinq jours suivants (J3 → J8)                            |  7,10 s |  8,38 s |    +18 % |
| Pire jour parmi ces cinq                                 |  2,67 s |  3,15 s |          |

Le jour de guerre intense reste dans le budget (la réflexion elle-même coûte un peu plus, mais les milliers
d'ordres refusés ont disparu). Les jours suivants coûtent davantage parce que **les armées se battent vraiment**
(avant, les fronts s'endormaient ; après, les combats durent puis les guerres se concluent : 15 guerres à J8 au
lieu de 17). Les parties « difficile » coûtent 2,4 à 4,6 fois moins qu'avant (fin de la guerre mondiale). Le
déterminisme est vérifié par le banc (« reprise identique », « états identiques ») et les tests de rejeu.

Mesures par variante de réglage sur le même pas : le blocus naval coûte ≈ 1 s par jour de guerre du banc (il
est réservé au niveau « difficile »), l'appui aérien ≈ 1,2 s, les patrouilles de chasse ≈ 3 s (avant comme
après : elles ne décollent plus que si la menace aérienne est à moins de 600 km de la capitale).

## Tests ajoutés

`packages/engine/test/ai-tactics.test.ts` (scénarios synthétiques) : l'IA défend sa capitale (la garnison reste,
les renforts arrivent, la ville tient) ; contre-attaque **en groupe** et reprend sa province ; n'envoie pas ses
unités contre une ville solidement tenue ; aucun ordre refusé pendant une guerre ; l'IA économique ne dépense pas
sa réserve (et dépense quand la trésorerie le permet) ; le niveau de la partie s'applique à toutes les IA ; guerre
sans front → paix blanche. Mis à jour : `intel-view` (reconnaissance de l'ennemi avant le balayage) et `mil-misc`
(pas de patrouille pour une menace lointaine ; patrouille et salve quand elle approche).

## Ce qui reste faible (honnêtement)

- **Pas d'opérations amphibies ni de plan naval offensif** : la Chine ne peut rien contre Taïwan, Israël rien
  contre l'Iran ; ces guerres finissent désormais en paix blanche (guerre sans front) au lieu de durer pour rien.
  La marine défend ses eaux, tire ses missiles et, en difficile, fait un blocus ; elle n'escorte pas et ne
  transporte pas de troupes.
- **Aviation encore sous-employée** : patrouille au-dessus de la capitale, frappes chez soi et en appui des
  offensives, avion radar ; pas d'escorte des bombardiers, pas de suppression des défenses antiaériennes
  ennemies planifiée (les missiles antiradar visent les radars identifiés, sans plus), pas de supériorité
  aérienne au-dessus du front. La part d'aéronefs en mission reste faible (quelques %).
- **Estimation des forces rudimentaire** : faute de mieux sans tricher, l'IA suppose que l'adversaire a autant de
  forces par province qu'elle (hypothèse miroir), corrigée par ses contacts. Les grandes nations surestiment leur
  avantage sur les petites, d'où les conquêtes opportunistes du niveau difficile (Autriche → Liechtenstein,
  Allemagne → Luxembourg). Le renseignement (reconnaissance militaire) affine les contacts, pas cette hypothèse.
- **Groupes sans point de rassemblement** : les unités d'un groupe partent ensemble mais arrivent à des heures
  différentes selon leur vitesse ; une colonne rapide peut arriver seule.
- **Va-et-vient résiduels** sur les fronts mouvants (une province prise, perdue, reprise…) : une trentaine par
  partie de 14 jours en « normal » (pour ~500 ordres de capture), contre une dizaine avant — mais avant, l'armée
  ne bougeait presque pas. En « difficile », ils passent de 246 à 29.
- **Production uniquement à la capitale** et en catégories terrestres (l'IA tactique n'achète ni avions ni
  navires ; seules les IA « actives » des parties multijoueur achètent des avions via le module économique).
- **Déficits structurels : ce n'est pas l'IA.** 94 nations sur 200 ont, dès le départ, un entretien d'ORBAT
  supérieur à leur budget (Corée du Nord : ×6,5 ; Érythrée : ×15 ; Maroc : ×2,3 ; Iran : ×1,9). Elles finissent
  en solde négatif quoi que fasse l'IA, qui ne peut pas démobiliser (aucun ordre de dissolution). L'IA ne
  provoque aucune faillite par ses dépenses (0 nation en solde négatif sans déficit structurel, avant comme
  après) ; sa réserve retarde celle des pays en déficit (en « normal », 29 nations en solde négatif à J14 au
  lieu de 37). À traiter côté économie (`modules/eco/budget.ts`, données ORBAT) ou par un ordre de
  démobilisation.
- **« Normal » est très pacifique envers le joueur** : en 21 jours, aucune IA « normal » n'a attaqué une France,
  une Algérie, une Arménie ou une Estonie humaines (il faut un motif public et un rapport de force de 2). C'est un
  choix d'équilibrage à valider. « Difficile » attaque les petits pays humains (Turquie → Arménie, Russie →
  Estonie) mais pas les puissances moyennes, que leurs voisins jugent trop fortes.
- **Le joueur passif n'est pas un adversaire** : le banc ne joue pas le joueur humain ; la qualité de l'IA face
  à un humain qui contre-attaque, encercle ou bombarde n'est mesurée qu'indirectement (duels IA contre IA).
- **Back-office** : la section `ai` apparaît dans l'éditeur de règles avec des libellés générés ; des libellés
  français dédiés (`apps/admin/src/i18n/rules.ts`) seraient plus lisibles (non fait : hors périmètre).
- **Serveur** : il serait plus propre de passer `setup.aiLevel` dans `prepare()` (apps/server) plutôt que de
  compter sur le repli du moteur (non fait : hors périmètre).

## Passe 2 — menace contre le joueur, opérations, aviation, estimation, production

Demande d'Amine : _l'IA ne doit pas être agressive, mais elle doit tout de même attaquer, être smart_. Même banc
(`bench/ai-eval.ts`, enrichi), deux graines, comparé au moteur juste avant la passe (même économie recalibrée,
commit `b679bc0`). Les mesures longues ont été arrêtées avant la dernière série : les chiffres « après » des
parties viennent de la série r5 (code final sauf le dernier réglage du rassemblement, voir « Non terminé ») ;
duels et coût de calcul sur le code final. Les faiblesses de la passe 1 (amphibie, aviation, groupes,
estimation miroir, production à la capitale, « normal » pacifique) sont traitées ci-dessous.

### Ce qui a été fait

1. **Menace contre le joueur humain** (`strategy.ts`, `seekHumanWar` / `advancePlan`). Un voisin (par la terre,
   ou par la mer pour les niveaux qui débarquent ; capitale du joueur à moins de `threatReachKm` de ses villes) le
   menace si le rapport de force estimé dépasse `humanWarRatio`, avec un **motif** (revendication, revanche,
   allié attaqué, paria) ou une **opportunité** (cible déjà en guerre ou instable) ; sans motif, il faut
   `humanMotiveFactor` fois plus (jamais en facile). Pas avant `humanWarFromDays` (facile J10, normal J3,
   difficile J2), au plus `humanAggressors` IA à la fois contre le même joueur (difficile : 2, en **coalition** :
   forces cumulées, échéances alignées). Étapes visibles : **préparatifs** (`humanPrepHours` ; plan inscrit dans
   `board.warPlans`, que le renseignement du joueur peut découvrir ; troupes massées dans la ville frontalière ou
   le port le plus proche), **ultimatum public** (dépêche, `ultimatumHours`), puis **guerre** — ou
   **renonciation** (dépêche de désescalade) si le rapport de force est tombé sous `planHoldShare` (le joueur a
   renforcé sa frontière). Guerres **limitées** : au-delà de `warGoalShare` des provinces de la cible (normal
   34 %), l'agresseur arrête ses offensives et propose la paix en gardant ses gains (`satisfiedPeaceDays`) ; une
   victime qui n'a rien perdu accepte le statu quo. Répit (`humanCooldownDays`) après une paix ou une menace
   abandonnée.
2. **Opérations navales et amphibies.** Le moteur sait débarquer : une unité terrestre embarque d'elle-même sur un
   trajet qui passe par la mer (plus lente, sans défense). L'IA vise les provinces côtières ennemies reliées par la
   mer à un de ses ports (`amphibiousReachKm`), se **rassemble au port**, envoie ses **navires d'escorte**
   patrouiller la zone de débarquement et ne traverse que lorsqu'ils y sont, ou que la mer est libre de navires
   ennemis identifiés (`seaControlKm`) ; force exigée majorée (`amphibiousRatio`, et part des forces publiques de
   l'ennemi par province quand la côte n'est pas vue), groupe double. Une guerre contre une nation atteignable
   par la mer n'est plus une « guerre sans front » (plus de paix blanche par incapacité). Blocus inchangé.
3. **Aviation** (`modules/mil/ai.ts`). **Suppression des défenses** : une défense antiaérienne _identifiée_ sur la
   route ou l'objectif d'une frappe est frappée d'abord ; **escorte** : des chasseurs patrouillent sur l'objectif
   de chaque frappe hors de son territoire (ils arrivent avant les bombardiers) ; couverture des objectifs et des
   zones de débarquement ; **frappes profondes** sur les installations _révélées par son renseignement_ (sites
   antiaériens, radars, bases aériennes, bases et usines d'armement), jamais sous une défense connue non
   neutralisée. Les salves de missiles ne visent plus que des bâtiments révélés (petite triche corrigée). Aucun
   vol au-dessus d'un neutre (le survol ouvrait des guerres par accident).
4. **Groupes.** Départs **échelonnés** (les plus lents d'abord, chacun à l'heure qui fait arriver le groupe
   ensemble) ; si les unités sont trop dispersées (`rallySpreadHours`), **rassemblement** dans la ville amie voisine
   de l'objectif, puis départ ; force exigée revue au départ ; poursuites arrêtées avant d'entrer chez un neutre
   (elles ouvraient, elles aussi, des guerres accidentelles).
5. **Estimation** (`estimate.ts`, `publicForce`). Plus d'hypothèse miroir : ORBAT **publié** de départ, moins une
   part des forces avec le territoire perdu, plus la production que le budget de défense public a pu financer,
   moins ce que l'observateur a **vu détruire** lui-même (nouvelle statistique `vs` du module militaire), majoré
   d'une **incertitude** (fiabilité de la source, vieillissement, réduite par la reconnaissance militaire), jamais
   sous les contacts vus. Miroir conservé sans ORBAT (bac à sable).
6. **Production hors capitale.** Le moteur le permet (bâtiment requis par catégorie). L'IA produit dans la province
   la mieux équipée et la plus proche du front (hors villes menacées), importe vers la ville sûre la plus proche du
   front, et revient à la capitale quand celle-ci est menacée ou dégarnie.

Réglages : `ai.levels.*` (17 champs), `ai.tactical` (9), `ai.estimate` (section nouvelle), `ai.strategy`
(`planHoldShare`, `threatReachKm`), tous optionnels avec défauts, libellés français dans
`apps/admin/src/i18n/rules.ts`. Calibrage : « difficile » `casusBelliWaiverRatio` 3 → 5 et `warChancePerDay`
0,02 → 0,01 (l'estimation exacte rendait les petits voisins trop tentants entre IA).

### Le joueur humain (parties libres de 21 jours, joueur passif, 2 graines × Arménie, Estonie, Taïwan, France)

| Niveau    | Avant                                          | Après                                                                                                                                   |
| --------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Facile    | aucune guerre                                  | aucune guerre (motif et rapport ×3 exigés, pas avant J10 : aucun cas)                                                                   |
| Normal    | **aucune guerre** contre le joueur (0 sur 8)   | **7 guerres sur 8 parties** (une par partie, sauf la France : ses voisins sont plus faibles), toutes après préparatifs puis ultimatum   |
| Difficile | 8 guerres (Arménie, Estonie, France), dès J3,7 | 15 guerres sur 8 parties, par paires coordonnées (même échéance), dès J3,6 ; France attaquée à J19,6 par une coalition Allemagne–Italie |

« Normal », après (début des préparatifs → guerre, provinces prises à J21) : Arménie : Turquie J7,8 → J10,2
(3 prov.), Iran J4,0 → J6,3 (3 prov.) ; Estonie : Russie J4,0 → J6,4 (2 prov.), Finlande par la mer J3,5 → J5,8
(0 prov.) ; Taïwan : Chine J8,5 → J10,8 (4 prov.) et J5,5 → J7,8 (5 prov., débarquements 10 sur 10 réussis) ;
France : aucune. Délai de la première guerre : J5,8 à J10,8. Le joueur n'est **jamais éliminé** en « normal » (but
de guerre limité ; l'agresseur propose 5 à 7 fois la paix, que le joueur passif ne signe pas). En « difficile »,
l'Arménie, l'Estonie et Taïwan passifs sont rayés de la carte en 21 jours ; la France perd 7 provinces dans une
graine.

### Guerres imposées entre IA (14 jours, 2 graines, moyennes)

| Mesure                                       |  Normal avant |      Normal après | Difficile avant | Difficile après |
| -------------------------------------------- | ------------: | ----------------: | --------------: | --------------: |
| Guerres déclarées par les IA (hors imposées) |             1 |                 1 |              12 |               7 |
| Paix signées                                 |             3 |               7,5 |               4 |             2,5 |
| Nations anéanties                            |             5 |               1,5 |              11 |            12,5 |
| Provinces prises                             |            84 |                31 |             171 |             148 |
| Écart moyen des arrivées d'une vague (h)     |           9,5 |               4,1 |             8,3 |             2,3 |
| Vagues arrivant étalées sur plus de 3 h      |          69 % |              25 % |            64 % |            13 % |
| Unités détruites après un ordre de capture   |           8 % |              21 % |            17 % |            10 % |
| Capitale menacée sans garnison               |          11 % |               1 % |            15 % |          38 % ¹ |
| Va-et-vient                                  |            33 |                17 |              12 |              23 |
| Débarquements (ordres / réussis)             |         0 / 0 |             0 / 0 |         0,5 / 0 |         20 / 12 |
| Frappes profondes / suppressions / escortes  |    7 / 47 / 0 |     70 / 51 / 100 |     17 / 46 / 0 |  165 / 46 / 178 |
| Production hors capitale                     |           3 % |              23 % |             3 % |            26 % |
| Erreur médiane d'estimation des voisins      | ×3,8 (miroir) | ×1,4 (pessimiste) |            ×3,5 |            ×1,4 |
| CPU de la partie (s)                         |          18,5 |              18,5 |            24,6 |            31,3 |

¹ Relevés dominés par des nations déjà sans armée (Arménie anéantie : 52 relevés, Vatican : 16). En « normal »,
la Corée du Nord gardait sa capitale vide ; la production revient désormais à la capitale dégarnie.

« Normal » mène des **guerres limitées** qui finissent en paix (7,5 au lieu de 3 ; 1,5 nation anéantie au lieu de
5). Point faible honnête : la part d'unités détruites après un ordre de capture monte (8 → 21 %), concentrée sur
Inde → Pakistan et les contre-attaques ukrainiennes ; des variantes montrent que le rassemblement en est la cause
principale sur une graine (sans lui : 28 pertes au lieu de 64), pas sur l'autre (57 contre 54). D'où le réglage
final : départs échelonnés sur place, rassemblement seulement au-delà de 6 h d'écart (au lieu de 3) — non mesuré
en série complète.

Chine → Taïwan (imposée) : en « normal », la Chine ne débarque pas contre un Taïwan IA qui défend ses côtes (force
jugée insuffisante), mais la guerre continue (frappes profondes et missiles : 67 → 23 unités taïwanaises) au lieu
de finir en paix blanche ; contre un Taïwan humain passif, elle débarque. En « difficile », Taïwan contre-débarque
sur le continent (17 à 19 ordres, 8 à 11 réussis).

### Duels de niveaux (code final, 14 jours)

|                           | Gains de l'agresseur | Gains de la cible | Captures réussies | Unités perdues après capture |
| ------------------------- | -------------------: | ----------------: | ----------------: | ---------------------------: |
| Difficile → facile, avant |            +75 / +67 |         −68 / −67 |       91 % / 80 % |                      22 / 88 |
| Difficile → facile, après |            +91 / +82 |         −87 / −82 |       99 % / 99 % |                        0 / 0 |
| Facile → difficile, avant |            −14 / −19 |         +34 / +44 |       62 % / 81 % |                      87 / 36 |
| Facile → difficile, après |            −12 / −12 |         +12 / +14 |       69 % / 69 % |                      23 / 26 |

La cible « difficile » reprend son territoire puis accepte la paix (estimation exacte : elle se sait plus faible
que la plupart des agresseurs imposés) au lieu de contre-envahir.

### Coût de calcul (banc réel, 2 alternances, machine au repos, temps CPU)

| Mesure                     |         Avant |                    Après |
| -------------------------- | ------------: | -----------------------: |
| Jour calme                 |  504 / 433 ms |             465 / 463 ms |
| **Jour de guerre intense** | 12,9 / 11,5 s | **11,7 / 11,7 s** (−4 %) |
| Jour suivant               |   6,8 / 6,3 s |              4,9 / 5,2 s |
| Dix jours suivants         | 14,8 / 14,6 s |            12,4 / 13,7 s |

Une partie du gain vient de la fin des guerres accidentelles (29 guerres à J2 avant, 14 après : poursuites et
survols chez des neutres). Les parties « difficile » du banc d'évaluation coûtent ~25 % de plus (opérations
aériennes). Reprise et rejeu : « reprise identique », « états identiques » ; tests de déterminisme verts.

### Tests ajoutés

`test/ai-operations.test.ts` : menace en « normal » (rien avant J3, plan visible du renseignement, troupes massées
à la frontière, ultimatum public 24 h avant la guerre) ; **dissuasion** (le joueur renforce sa frontière pendant
l'ultimatum, l'IA renonce) ; « facile » n'attaque pas sans motif ; **rassemblement** puis assaut groupé ; **SEAD
et escorte** (la défense antiaérienne identifiée est la première cible, un chasseur patrouille au-dessus) ;
**débarquement** escorté sur l'île `ddd`. `ai-tactics` mis à jour (vagues échelonnées, arrivées à moins d'une
heure d'écart) ; `fuzz` : délai porté à 60 s (4,3 s seul, plus de 5 s sur machine chargée).

### Non terminé, ce qui reste faible

- **Dernier réglage du rassemblement non mesuré en série complète** (départs échelonnés sur place, seuil 6 h) :
  mesures arrêtées à la demande. À relancer : `node --expose-gc bench/run.mjs ai-eval` et
  `AIEVAL_MODE=free AIEVAL_DAYS=21 AIEVAL_HUMAN=arm,est,twn,fra node --expose-gc bench/run.mjs ai-eval`.
- **Pertes en attaque en « normal »** plus élevées qu'avant (8 → 21 % sur les guerres imposées), à surveiller.
- **Débarquements contre une IA qui défend ses côtes** : la Chine « normal » n'ose pas (prudence) ; le
  « difficile » réussit environ la moitié de ses traversées.
- **Le joueur passif** ne signe jamais la paix proposée : en jeu réel, la guerre limitée s'arrête si le joueur
  accepte ; sinon l'agresseur reste sur ses gains.
- **Estimation pessimiste par construction** (moyenne × (1 + incertitude)) : elle surestime toujours un peu (×1,4
  en médiane) ; c'est voulu, mais l'IA ignore les pertes que l'ennemi subit contre des tiers.
- **Mobilisation** non utilisée pendant les préparatifs (coût économique ; laissée de côté).

## Passe 3 — un monde vivant en partie solo

Demande d'Amine : _le reste des IA dans le monde doivent être actives en partie solo, se battre entre elles,
se conquérir, etc._ Avant cette passe, en « normal », les IA ne se déclaraient presque jamais la guerre entre
elles (0 à 1 guerre en trois semaines : le Maroc contre le Sahara occidental) ; en « difficile », c'était
l'inverse : des guerres de choix absurdes (Allemagne → Luxembourg, Suisse → Liechtenstein, Italie →
Vatican, États-Unis → Canada, Allemagne → Italie, Brésil → Uruguay), 14 à 17 guerres simultanées, des
guerres qui ne finissaient presque jamais (0 à 4 paix) et 7 à 9 nations rayées de la carte.

### Ce qui a été fait

Tout est en **données** (`data/balance/default.json`, section `ai.world`, schéma `AiBalanceSchema.world`,
libellés du back-office dans `apps/admin/src/i18n/rules.ts`) ; le code est dans `src/ai/world.ts` (index des
données, lectures publiques) et `src/ai/strategy.ts` (`seekWorldWar`, `blocDefense`, fin des guerres).

1. **Rivalités historiques** (45 paires, `ai.world.rivalries`) : Russie–Ukraine, Inde–Pakistan, Israël–Gaza,
   Israël–Iran, Israël–Liban, Israël–Syrie, Azerbaïdjan–Arménie, Éthiopie–Érythrée, Éthiopie–Somalie,
   Égypte–Éthiopie (barrage), Chine–Taïwan, Chine–Inde, Chine–Philippines, Chine–Viêt Nam, Corées,
   RD Congo–Rwanda, Soudan–Soudan du Sud, Soudan–Tchad, Somalie–Somaliland, Venezuela–Guyana,
   Colombie–Venezuela, Arabie–Yémen, Iran–Arabie, Iran–Irak, Pakistan–Iran, Afghanistan–Pakistan,
   Tadjikistan–Kirghizistan, Thaïlande–Cambodge, Serbie–Kosovo, Chypre–Chypre du Nord, Grèce–Turquie,
   Turquie–Syrie, Russie–Géorgie, Russie–Estonie / Lettonie, Algérie–Maroc, Maroc–Sahara occidental,
   Sahel (Mali–Algérie, Niger–Bénin, Burkina–Côte d'Ivoire), Érythrée–Djibouti, Burundi–Rwanda,
   Équateur–Pérou, Bolivie–Chili, Guatemala–Belize. Chacune a un **poids** (probabilité relative), un
   **motif** public repris dans la dépêche de déclaration (« Motif invoqué : le Cachemire. ») et un
   **déclencheur** (`initiator` : la Corée du Sud n'envahit pas le Nord, Taïwan n'attaque pas la Chine).
   Probabilité par jour = `rivalryChancePerDay` × poids × intensité (× 2 si le rival est affaibli), si le
   rapport de force estimé (sans tricher) atteint `rivalryRatio` ; un rival non voisin est visé si sa
   capitale est à moins de `rivalReachKm` (guerre de frappes, débarquement).
2. **Opportunisme** : un voisin affaibli (capitale perdue, stabilité publique sous `weakStability`, ou en
   train de perdre une autre guerre) attire un vautour libre de toute autre guerre
   (`opportunismChancePerDay` × intensité × (1 − retenue de son bloc), rapport `opportunismRatio`).
3. **Blocs politiques** (22 blocs, `ai.world.blocs`) : OTAN, Europe neutre, OTSC, Alliance des États du
   Sahel, CCG, ASEAN, Mercosur, Communauté andine, SICA, CARICOM, partenaires du Pacifique, SACU, SADC,
   CEDEAO, CAE, CEEAC, Maghreb, OCS, SAARC, ACEUM, Balkans occidentaux, trio associé. **Jamais de guerre de
   choix entre membres** (sauf rivalité déclarée : Grèce–Turquie, Inde–Pakistan…) ; **retenue** (0 à 1 :
   une démocratie de l'OTAN ne fait pas de guerre opportuniste ni, en « difficile », de guerre sans motif —
   seuil `waiverMaxRestraint`) ; **défense mutuelle** (OTAN, OTSC, AES) : un membre IA voisin de l'agresseur
   ou de la victime entre en guerre contre l'agresseur IA d'un autre membre pendant les `blocDefenseDays`
   premiers jours, si leurs forces réunies pèsent `blocDefenseRatio` de l'agresseur (dépêche « défense
   mutuelle » au nom du bloc, sans atteinte à la réputation). Ces défenseurs comptent dans la
   **dissuasion** : la Russie ne s'attaque pas à l'Estonie. Les blocs ne s'activent pas contre un joueur
   humain (son équilibre de jeu est inchangé).
4. **Les guerres se terminent** : but de guerre (`warGoalShare`), agresseur satisfait
   (`satisfiedPeaceDays`), **capitulation** (capitale perdue, ou `capitulationShare` des provinces perdue
   après `capitulationMinDays`), **enlisement** (aucune province n'a changé de main depuis `stalemateDays` :
   paix au statu quo). Une guerre entre IA dure au moins `capitulationMinDays` sauf chute d'une capitale.
   Pas de nouvelle guerre entre les deux mêmes IA avant `rematchDays`. À la paix, les provinces conquises
   restent au vainqueur : nouvelles dépêches « la paix entérine les conquêtes de… » (`peace_annexation`) et
   « … capitule » (`capitulation`), en plus des dépêches de guerre, de prise de province et de capitale. Le
   joueur voit les frontières bouger sur la carte et lit l'actualité.
5. **Plafonds** : guerres entre IA par nation (`maxWars`) et **dans le monde** (`maxActiveWars` ×
   intensité ; les guerres d'alliance ne sont pas bloquées) ; aucune guerre entre IA avant `fromDays`.
6. **Intensité du monde** (`ai.world.intensity`, 1 par défaut ; 0 : monde figé ; 2 : très agité) et rythme
   par niveau (`ai.world.levels.easy|normal|hard`) :

|                                    |     Facile |     Normal |  Difficile |
| ---------------------------------- | ---------: | ---------: | ---------: |
| Guerres entre IA à partir de       |         J5 |         J2 |         J1 |
| Probabilité / jour d'une rivalité  |      0,006 |       0,03 |      0,035 |
| Rapport de force contre un rival   |        1,8 |        1,3 |       1,15 |
| Opportunisme / jour (rapport)      |      0 (—) |   0,01 (2) | 0,02 (1,6) |
| Guerres par nation / dans le monde |      1 / 3 |      1 / 6 |     2 / 10 |
| But de guerre, capitulation        | 20 %, 30 % | 34 %, 50 % | 50 %, 50 % |
| Enlisement → paix                  |        4 j |        6 j |        9 j |

**Veille des IA lointaines.** Inchangée et conforme à la décision d'Amine : le serveur ne pose la commande
système `dormancy` qu'après 5 min **sans aucun joueur humain connecté** (`manageIdle`) et la lève dès qu'un
joueur se connecte (`attach`) : joueur connecté = monde entier actif (test `ai-dormancy`).

### Mesures (banc `ai-eval`, mode `free`, 21 jours, France humaine passive, graines 1 et 2)

```bash
AIEVAL_MODE=free AIEVAL_DAYS=21 AIEVAL_LEVELS=normal,hard node --expose-gc packages/engine/bench/run.mjs ai-eval
```

Le banc relève désormais (ligne `monde`) les guerres entre IA (agressions et guerres d'alliance), leur
durée, les paix, les provinces prises et changées de main, les nations anéanties, le pic de guerres
simultanées, et liste chaque guerre (dates, agresseur → cible, gains / pertes).

| Mesure (graine 1 / graine 2)                 | Normal avant | Normal après | Difficile avant | Difficile après |
| -------------------------------------------- | -----------: | -----------: | --------------: | --------------: |
| Guerres entre IA déclarées                   |        1 / 0 |        7 / 8 |         14 / 21 |          8 / 12 |
| … dont guerres d'alliance (défense mutuelle) |        0 / 0 |        1 / 0 |          1 / 12 |           0 / 4 |
| Guerres terminées                            |        0 / 0 |        5 / 6 |           0 / 4 |           2 / 9 |
| Durée médiane d'une guerre terminée (j)      |            — |    3,2 / 3,2 |         — / 3,2 |       3,1 / 3,2 |
| Paix signées entre IA                        |        0 / 0 |        5 / 5 |           0 / 4 |          2 / 12 |
| Provinces prises entre IA                    |        1 / 0 |      43 / 27 |         80 / 61 |         38 / 81 |
| Provinces ayant changé de main à J21         |        1 / 0 |      38 / 25 |         70 / 61 |         36 / 66 |
| Nations IA anéanties                         |        1 / 0 |        1 / 4 |           9 / 7 |           5 / 4 |
| Pic de guerres simultanées entre IA          |        1 / 0 |        4 / 4 |         14 / 17 |           7 / 6 |
| Pic de nations en guerre                     |        2 / 0 |        6 / 8 |         24 / 26 |         14 / 10 |
| Guerres sans frontière commune               |        0 / 0 |        1 / 1 |          1 / 11 |           0 / 2 |
| CPU de la partie de 21 jours (s)             |    7,9 / 6,2 |  15,3 / 23,7 |     24,4 / 22,5 |     17,9 / 27,7 |

Exemples « normal » (graine 2) : Chine → Taïwan J2,3 (pas de débarquement, paix d'enlisement J8,5),
Russie → Ukraine J2,4 (+8 provinces, −2, paix J6,5), Venezuela → Guyana J5,0 (Essequibo, +6, capitulation
J7,3), Thaïlande → Cambodge J6,4 (+4), Russie → Géorgie J7,9 (+3), RD Congo → Rwanda J9,3 (+3), Israël →
Gaza, Maroc → Sahara occidental. Graine 1 : Arabie → Yémen (+8), Turquie → Syrie (+7) suivie d'un vautour
(Jordanie → Syrie), Soudan → Tchad (+12), Chypre → Chypre du Nord, Érythrée → Djibouti. Les nations
anéanties sont de petites entités (Sahara occidental, Gaza, Chypre du Nord, Kosovo…). « Difficile » : plus
de guerres de choix entre démocraties alliées ni contre les micro-États ; il reste des guerres sans motif
de nations sans bloc retenu (Soudan → Centrafrique, Égypte → Libye, Chili → Bolivie) et des activations de
l'OTSC. Contre le joueur humain, la logique de menace de la passe 2 est inchangée.

### Coût de calcul (banc réel, `pnpm --filter @redline/engine bench`, 2 alternances, temps CPU)

| Mesure                     |         Avant |         Après |   Écart |
| -------------------------- | ------------: | ------------: | ------: |
| Jour calme                 |  549 / 603 ms |  601 / 593 ms |    +4 % |
| **Jour de guerre intense** | 14,1 / 13,9 s | 14,2 / 13,8 s | **0 %** |
| Jour suivant               |   5,4 / 5,1 s |   5,8 / 5,2 s |    +5 % |
| Dix jours suivants         | 12,7 / 12,0 s | 16,6 / 15,0 s |   +28 % |
| Instantané                 |      3,63 Mio |      3,67 Mio |    +1 % |

Le jour de guerre intense (dix guerres imposées) ne coûte pas plus : l'enregistrement du rapport après
action (quelques compteurs par coup au but) est invisible. Les dix jours suivants coûtent ~28 % de plus
**parce que le monde se bat** (nouvelles guerres de rivalité pendant la mesure) : c'est le prix voulu. Le
plafond mondial (`maxActiveWars`, 6 en « normal ») et l'intensité (`ai.world.intensity`) bornent ce coût ;
à 0,5 d'intensité, le plafond tombe à 3 guerres simultanées. Pour une partie de 21 jours, le calcul total
passe de 6 à 8 s à 15 à 24 s en « normal » (~1 s de calcul par jour de jeu, soit ~0,2 ms par seconde
réelle à ×16, 0,02 % d’un cœur).

### Tests ajoutés

- `test/ai-world.test.ts` : une rivalité des données dégénère en guerre entre IA (dépêche avec le motif,
  agresseur désigné) ; un bloc retient le partenaire de la victime ; sans rivalité le monde « normal » reste
  en paix, intensité nulle = monde figé ; plafond de guerres simultanées (pas de guerre mondiale) ; la
  victime capitule, le vainqueur garde ses conquêtes, partie déterministe.
- `test/battle-aar.test.ts` : rapport après action complet, rien de caché divulgué, déterminisme et rejeu
  (voir `docs/rapports-de-bataille.md`).
- Back-office : libellés de toutes les clés `ai.world.*` (test `admin.test.ts`).

### Ce qui reste faible

- Les guerres entre IA sont **courtes** (médiane ~3 jours) : la capitulation suit souvent la chute de la
  capitale d'un petit pays ; les grandes guerres (Russie–Ukraine) finissent en paix de statu quo ou par
  enlisement après 4 à 6 jours. Réglable (`capitulationMinDays`, `stalemateDays`).
- La Chine ne débarque pas à Taïwan contre une IA qui défend ses côtes (prudence de la passe 2) ; la guerre
  finit par enlisement.
- Pas de guerre civile simulée comme telle (Soudan, Sahel, Birmanie) : l'instabilité et les soulèvements du
  module diplo font de ces pays des cibles d'opportunisme, pas des belligérants internes.
- « Difficile » garde des guerres sans motif hors des blocs retenus (Égypte → Libye, Soudan → Centrafrique) :
  c'est le caractère du niveau, réglable par `waiverMaxRestraint` ou de nouveaux blocs.
- Les mesures de coût ont été prises sur une machine partagée très chargée (temps réel ≈ 3 × CPU) : les
  écarts de quelques % ne sont pas significatifs.
