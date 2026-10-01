# tools/art — photos réelles de l'arsenal

Pipeline reproductible qui associe à chaque système du catalogue (`data/catalog-ids.json`) une **vraie
photographie** sous licence libre, issue de Wikimedia Commons, et produit :

- `apps/client/public/art/photos/<systemId>.webp` (1280×800, 16:10) et `<systemId>.thumb.webp` (400×250), en
  présentation homogène « fiche » : sujet **détouré** et posé sur un fond « terminal tactique » commun quand le
  détourage est propre, sinon photo recadrée avec le même étalonnage et le même vignettage ;
- `data/art/photos.json` : manifeste
  `systemId → { file, thumb, credit, license, sourceUrl, title, generic?, note?, cutout? }` ;
- `data/art/CREDITS.md` : liste lisible de toutes les attributions (exigée par CC BY / CC BY-SA).

Aucune image générée : si aucune photo libre n'existe pour un système, il reste sans photo (listé à la fin de
`CREDITS.md`). Le détourage retire seulement l'arrière-plan (masque) : le sujet reste la photo d'origine.

## Licences

Acceptées : **domaine public** (dont photos du département de la Défense américain), **CC0**, **CC BY**,
**CC BY-SA** (toutes versions). Refusées : NC, ND, usage loyal (« fair use »), GFDL seule, GODL indienne (sauf
Agni-V, voir plus bas), licence inconnue. Exception limitée aux **surcharges manuelles** : la **Licence Ouverte**
d'Etalab (État français, compatible CC BY : Suffren et Triomphant) et l'OGL v3 britannique (Challenger 3) sont
admises, faute de toute photo
CC (`acceptLicense(…, extended)`) ; la sélection automatique ne les retient jamais. **Ces trois photos ont été
validées par Amine le 2026-10-01.** Mentions exigées (reprises dans `CREDITS.md`) :

- Licence Ouverte 2.0 : paternité (« Ministère des Armées » / « Armée française »), source (lien Commons) et
  signalement des modifications (recadrage, étalonnage, détourage) ;
- OGL v3 : « Contains public sector information licensed under the Open Government Licence v3.0. » et
  l'attribution de la source (UK MOD © Crown copyright). L'OGL exclut les insignes militaires : la photo du
  Challenger 3 est recadrée (`overrides.json`) pour exclure le panneau d'exposition portant les logos du
  ministère de la Défense et de la British Army ; il ne reste qu'un petit marquage tactique d'unité sur la caisse.

**GODL-India (Agni-V seulement)** : la Government Open Data License – India (Gazette of India, partie I
section 1, février 2017, <https://data.gov.in/government-open-data-license-india>) a été **validée par Amine le
2026-10-01 pour l'Agni-V uniquement**. Elle n'est admise que par une surcharge qui la cite (`"validated":
["GODL-India"]` dans `overrides.json`, voir `CASE_BY_CASE` dans `src/lib.ts`) ; la sélection automatique et les
autres systèmes la refusent toujours. Texte (sections 3 à 7) : licence mondiale, gratuite, non exclusive
d'utiliser, adapter, publier (original ou dérivé), traduire, afficher et créer des œuvres dérivées à toutes fins
licites, commerciales ou non. Obligations reprises dans `CREDITS.md` :

- **attribution** (section 4 a et 5) : fournisseur, source et licence avec l'URL, au format « [Fournisseur],
  [Année], [Nom], [Dépôt], [Date], [URL]. Published under Government Open Data License – India: [URL] » ; ici
  « DRDO / Ministry of Defence, Government of India » et le lien Commons (champ `attribution` de `sources.json`,
  obligatoire : `build` échoue sans lui) ;
- **pas d'approbation implicite** (section 4 c) : rien ne doit laisser entendre que la DRDO ou le gouvernement
  indien approuve le jeu ;
- **exclusions** (section 6) : noms, écussons, logos et symboles officiels du fournisseur, marques et insignes
  militaires ne sont pas couverts → **aucun emblème officiel dans le cadre** (recadrage ou zone de découpe) ;
- la licence tombe automatiquement en cas de manquement (section 7), rétablie si corrigé sous 30 jours.

Photo retenue : « Agni V Ballistic missile successfully launched on 15 September 2013 (7) » (source officielle
drdo.gov.in, paysage, aucun emblème visible). Écartées : le lanceur TCT-5 (missile bâché ; source Commons = un
blog de stagiaire, provenance DRDO non démontrable), les tirs verticaux de 2018 et 2024 (format portrait, sigle
DRDO peint sur le missile, source secondaire pour 2024), « Advanced Agni Missile » (variante non identifiée
comme Agni-V), la photo du défilé de 2013 (emblème DRDO et « Ministry of Defence » sur la calandre du tracteur).

Toute autre licence gouvernementale (GODL-India pour un autre système, licences israélienne ou pakistanaise…)
reste **refusée** tant qu'Amine ne l'a pas validée au cas par cas : les candidats sont listés à part, jamais
activés d'office. Seuls les fichiers hébergés sur Commons sont interrogés (les fichiers locaux de Wikipedia,
souvent non libres, sont donc exclus d'office). La
vérification se fait sur les métadonnées `extmetadata` (`License`, `LicenseShortName`) : voir `acceptLicense`
dans `src/lib.ts`.

Les images CC BY-SA recadrées et étalonnées sont des œuvres dérivées : elles restent sous CC BY-SA (mentionné
dans `CREDITS.md`). Le crédit doit être affiché sous la photo dans le jeu (`credit` + `license`).

## Fichiers

| Fichier          | Rôle                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `sources.json`   | systemId → `{ wiki?, search?, generic?, none?, note? }` (article Wikipedia anglais, requête)  |
| `overrides.json` | **surcharge manuelle** systemId → `"File:…"` ou `{ "file": "File:…", "focus": …, "zoom": … }` |
| `selection.json` | verrou (commité) : photo retenue, licence, auteur, URL de miniature. Lu par `build`.          |
| `cutouts.json`   | verrou (commité) : décision de détourage par système (`use`, `reason`). Produit par `cutout`. |
| `.cache/`        | téléchargements et découpes (ignoré par git)                                                  |

`focus` règle le recadrage 16:10 : `"centre"` (défaut), `"top"`, `"bottom"`, `"left"`, `"right"`,
`"attention"` (détection du sujet par sharp), un point `[x, y]` en fractions de l'image, ou `"fit"` (image
entière sur un fond flou et assombri tiré d'elle-même, pour les photos très allongées). `zoom` (≥ 1) resserre le
cadre autour du point `focus` (sujet lointain, texte incrusté à exclure). `seek` (secondes) prend, pour une vidéo
Commons, l'image extraite à cet instant par Commons (URL renvoyée par l'API, `iiurlparam`).

Dans `sources.json`, `none` documente pourquoi un système reste **sans photo** (repris dans `CREDITS.md`),
`generic: true` marque une photo **représentative** (infanterie, satellites, logistique, brouilleurs) et `note`
précise ce que montre la photo quand ce n'est pas exactement le système (repris dans le manifeste).
`cutout: false` (avec `cutoutWhy`) refuse le détourage après contrôle visuel, `cutout: true` l'impose malgré un
contrôle automatique, `cutoutBox: [x0, y0, x1, y1]` ne garde qu'une zone de la découpe (second véhicule à écarter),
`cutoutErase: [[x0, y0, x1, y1], …]` en retire des zones (reste de décor collé au sujet).
`attribution` donne la déclaration d'attribution exigée par une licence gouvernementale (GODL-India), reprise
telle quelle dans `CREDITS.md`. Dans `overrides.json`, `validated` (liste de licences) admet pour cette seule
photo une licence validée au cas par cas par Amine.

## Utilisation

```bash
pnpm --filter @redline/tools-art resolve             # 1. choisit les photos → selection.json
pnpm --filter @redline/tools-art resolve -- us.f-16  #    (seulement certains systèmes)
pnpm --filter @redline/tools-art cutout              # 2. détoure (service Recraft) → cutouts.json + .cache/cutout
pnpm --filter @redline/tools-art cutout -- --sheet /tmp/qc   #    + planches de contrôle des fiches détourées
pnpm --filter @redline/tools-art build               # 3. compose, étalonne → WebP + manifeste + crédits
pnpm --filter @redline/tools-art contact -- /tmp/pl  # planches contact des miniatures pour relecture
pnpm --filter @redline/tools-art candidates -- us.f-16 "F-16 Viper" --out /tmp/f16.jpg
pnpm --filter @redline/tools-art candidates -- us.f-16 "Category:General Dynamics F-16 Fighting Falcon"
pnpm --filter @redline/tools-art preview -- /tmp/pl us.f-16 ru.su-57   # images sources entières (réglage du cadrage)
pnpm --filter @redline/tools-art test                                 # licences + cohérence du manifeste
```

Ordre de choix dans `resolve` : surcharge manuelle → recherche Commons ciblée (`search`, tous les mots doivent
figurer dans le nom du fichier) → image principale de l'article Wikipedia → autres images de l'article.
Filtres : JPEG, largeur ≥ 960 px, rapport largeur/hauteur entre 1,15 et 2,6, nom de fichier sans indice de
schéma, logo, carte, maquette, cockpit… (`BAD_NAME`).

**Curation** : la plupart des systèmes ont une surcharge manuelle, choisie après examen visuel de planches de
candidates (`candidates`). Pour changer une photo : lancer `candidates`, recopier le titre retenu dans
`overrides.json`, puis `resolve -- <id>` et `build`.

## Détourage (`cutout`)

Service : API Recraft `POST https://external.api.recraft.ai/v1/images/removeBackground` (multipart `file`).
L'authentification est ajoutée par le proxy de l'environnement (aucune clé dans le dépôt ; le script lance Node
avec `NODE_USE_ENV_PROXY=1`). Seule la photo source (publique, issue de Commons) est envoyée, en JPEG sans
métadonnées. Un appel toutes les 1,5 s au plus, reprise sur 429/5xx/erreur réseau (5 essais, `Retry-After`).
Résultat mis en cache (`.cache/cutout/<clé>.png`) : relancer ne rappelle pas le service.

Décision par système (`cutouts.json`) : les lancements spatiaux (`space`) ne sont pas détourés ; sinon la découpe
est retenue si les contrôles automatiques passent (sujet présent, arrière-plan retiré, sujet non coupé par le
cadre), puis **contrôle visuel** des planches (`--sheet`) : restes de décor (panneau d'exposition, poussière,
neige projetée, second véhicule, navires voisins), tirs avec panache, groupes et soldats dispersés → `cutout:
false` dans `sources.json` avec la raison. Une décision ne vaut que pour la photo source qu'elle cite (`title`).

## Traitement (`build`)

- **Sujet détouré** : recadré sur sa boîte englobante, centré (≈ 80 % de la largeur, 66 % de la hauteur au plus),
  posé sur le fond commun (dégradé radial sombre bleuté, grille fine discrète, couleurs de
  `packages/ui/src/tokens.css`), ombre portée douce et ombre au sol, vignettage léger (`src/compose.ts`).
- **Photo non détourée** : recadrage 16:10 selon `focus` / `zoom`, resserré de 6 %, même étalonnage, vignettage.
- Étalonnage commun : saturation × 0,86, léger contraste, dominante froide à peine perceptible, accentuation
  légère (un peu plus marquée sur les sujets détourés). Le liseré est dessiné par l'interface (`.rl-photo__frame`).
- 1280×800 WebP qualité 76 et miniature 400×250 qualité 74 (composée directement à cette taille, pas réduite).
  Budget total visé : ≤ 60 Mio.

## Réseau et politesse

User-Agent `RedLine-art/1.0 (https://github.com/AmineDJM/Red-Line)` (jamais d'adresse e-mail), une requête toutes
les 2 s au plus (les environnements partagés reçoivent vite des 429 de Wikimedia), reprise automatique sur
429/5xx avec `Retry-After`. Les URL de miniatures sont celles renvoyées par l'API (`iiurlwidth=1920`), jamais construites à la main. Pour une image plus étroite que 1920 px,
l'API renverrait l'original (hôte `upload.wikimedia.org`, très limité en débit depuis les environnements
partagés) : on redemande alors une miniature standard (1280 ou 960 px), servie par le cache de miniatures. Les
téléchargements ont un délai maximal (90 s) ; si une photo reste inaccessible, `build` garde la fiche précédente
(même photo) ou signale le système et se termine en erreur : relancer `build -- <id>` plus tard. L'API REST `page/summary` est limitée
depuis les environnements partagés : on utilise l'API Action (`prop=pageimages`), équivalente.
