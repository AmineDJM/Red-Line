# tools/art — photos réelles de l'arsenal

Pipeline reproductible qui associe à chaque système du catalogue (`data/catalog-ids.json`) une **vraie
photographie** sous licence libre, issue de Wikimedia Commons, et produit :

- `apps/client/public/art/photos/<systemId>.webp` (1280×800, 16:10) et `<systemId>.thumb.webp` (400×250) ;
- `data/art/photos.json` : manifeste `systemId → { file, thumb, credit, license, sourceUrl, title, generic? }` ;
- `data/art/CREDITS.md` : liste lisible de toutes les attributions (exigée par CC BY / CC BY-SA).

Aucune image générée : si aucune photo libre n'existe pour un système, il reste sans photo (listé à la fin de
`CREDITS.md`).

## Licences

Acceptées : **domaine public** (dont photos du département de la Défense américain), **CC0**, **CC BY**,
**CC BY-SA** (toutes versions). Refusées : NC, ND, usage loyal (« fair use »), GFDL seule, GODL indienne,
licence inconnue. Exception limitée aux **surcharges manuelles** : la **Licence Ouverte** d'Etalab (État français,
compatible CC BY : 2 sous-marins français) et l'OGL v3 britannique (Challenger 3) sont admises, faute de toute photo CC
(`acceptLicense(…, extended)`) ; la sélection automatique ne les retient jamais. Seuls les fichiers hébergés sur
Commons sont interrogés (les fichiers locaux de Wikipedia, souvent non libres, sont donc exclus d'office). La
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
| `.cache/`        | téléchargements (ignoré par git)                                                              |

`focus` règle le recadrage 16:10 : `"centre"` (défaut), `"top"`, `"bottom"`, `"left"`, `"right"`,
`"attention"` (détection du sujet par sharp), un point `[x, y]` en fractions de l'image, ou `"fit"` (image
entière sur un fond flou et assombri tiré d'elle-même, pour les photos très allongées). `zoom` (≥ 1) resserre le
cadre autour du point `focus` (sujet lointain, texte incrusté à exclure).

Dans `sources.json`, `none` documente pourquoi un système reste **sans photo** (repris dans `CREDITS.md`),
`generic: true` marque une photo **représentative** (infanterie, satellites, logistique, brouilleurs) et `note`
précise ce que montre la photo quand ce n'est pas exactement le système (repris dans le manifeste).

## Utilisation

```bash
pnpm --filter @redline/tools-art resolve             # 1. choisit les photos → selection.json
pnpm --filter @redline/tools-art resolve -- us.f-16  #    (seulement certains systèmes)
pnpm --filter @redline/tools-art build               # 2. télécharge, recadre, étalonne → WebP + manifeste
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

## Traitement

Recadrage 16:10 centré (ou selon `focus` / `zoom`), 1280×800 WebP qualité 74 et miniature 400×250 qualité 70.
Étalonnage commun et discret pour une interface sombre : saturation × 0,84, léger contraste (× 1,07), dominante
froide à peine perceptible, accentuation légère. Budget total visé : ≤ 60 Mio.

## Réseau et politesse

User-Agent `RedLine/0.1 (+https://github.com/AmineDJM/Red-Line)` (jamais d'adresse e-mail), une requête toutes
les 300 ms au plus, reprise automatique sur 429/5xx avec `Retry-After`. Les URL de miniatures sont celles
renvoyées par l'API (`iiurlwidth=1920`), jamais construites à la main. L'API REST `page/summary` est limitée
depuis les environnements partagés : on utilise l'API Action (`prop=pageimages`), équivalente.
