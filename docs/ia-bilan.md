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
