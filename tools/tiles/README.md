# tools/tiles — imagerie satellite sombre (PMTiles)

Pipeline Python qui transforme NASA Blue Marble en tuiles raster sombres pour le fond de carte de Red Line.

| Fichier                                | Zoom  | Taille | Git                           |
| -------------------------------------- | ----- | ------ | ----------------------------- |
| `data/tiles/satellite-lowzoom.pmtiles` | 0 à 5 | ~2 Mo  | commité                       |
| `data/tiles/satellite.pmtiles`         | 0 à 8 | ~97 Mo | ignoré (construit par script) |

Le client utilise `satellite.pmtiles` s'il existe, sinon la version `lowzoom`.

## Source et licence

- **NASA Blue Marble: Next Generation, avec topographie et bathymétrie**, juillet 2004
  (`world.topo.bathy.200407`, enregistrement 73751 d'Earth Observatory) :
  `https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73751/`
  - `world.topo.bathy.200407.3x21600x10800.jpg` (2 km/px) pour le zoom 0 à 5 ;
  - les 8 dalles `world.topo.bathy.200407.3x21600x21600.{A,B,C,D}{1,2}.jpg` (500 m/px) pour le zoom 0 à 8.
- Juillet plutôt que décembre (73909) : la neige de l'hiver boréal blanchissait toute la Russie et le Canada.
  Le mois se change avec les constantes `NASA` et `BM` de `build_tiles.py`.
- **Licence** (vérifiée le 30/09/2026 sur les pages de NASA) : les images de NASA « ne sont généralement pas
  soumises au droit d'auteur aux États-Unis » et peuvent être utilisées, y compris commercialement, sans
  autorisation explicite, à condition de **citer NASA** comme source et de ne pas suggérer une approbation de
  NASA (pas de logo ni d'insigne NASA). La page Blue Marble NG demande de créditer
  **« NASA Earth Observatory »** (produit par Reto Stöckli, NASA GSFC). Attribution à afficher dans le jeu :
  `Imagerie : NASA Earth Observatory (Blue Marble NG) ; données : Natural Earth`. Elle est aussi écrite dans les
  métadonnées de l'archive PMTiles (`attribution`).
- Masque terre/mer : Natural Earth `ne_10m_land` + `ne_10m_antarctic_ice_shelves_polys` (domaine public).

## Traitement (`build_tiles.py`)

1. Masque terre/mer Natural Earth rastérisé à la résolution de la source, bords adoucis (flou gaussien).
2. Étalonnage (`grade`) :
   - terre : désaturée (15 % de la couleur d'origine), tons compressés par une courbe logarithmique,
     teinte gris-bleu nuit ; le relief ombré de la source est renforcé par un passe-haut de la luminance
     (`RELIEF_GAIN`, `RELIEF_RADIUS`) ;
   - mer : presque noire, bleu très sombre (`SEA_BASE`), bathymétrie lissée à peine visible (`SEA_GAIN`).
3. Pyramide équirectangulaire par moyenne 2×2 (les grands niveaux sont des `numpy.memmap` dans `.cache`).
4. Reprojection Web Mercator (interpolation bilinéaire depuis le niveau de pyramide adapté à chaque zoom),
   tuiles 256 px, WebP qualité 80, archive PMTiles v3 écrite dans l'ordre des identifiants (Hilbert),
   tuiles identiques dédupliquées (océans).

## Commandes

Prérequis : Python 3.10+ et `curl`. `run.sh` crée un venv dans `tools/tiles/.cache/venv` (ignoré par git) et
installe `requirements.txt` (numpy, pillow, pmtiles) ; la variable `PYTHON_VENV` permet d'en réutiliser un.

```sh
pnpm --filter @redline/tools-tiles build:lowzoom   # data/tiles/satellite-lowzoom.pmtiles (zoom 0–5)
pnpm --filter @redline/tools-tiles build:full      # data/tiles/satellite.pmtiles (zoom 0–8)
# aperçu PNG d'un bloc de tuiles relu dans l'archive : fichier, z, x0, y0, x1, y1, sortie
pnpm --filter @redline/tools-tiles preview ../../data/tiles/satellite-lowzoom.pmtiles 4 7 4 10 6 /tmp/europe.png
```

Les sources téléchargées et les images intermédiaires sont gardées dans `tools/tiles/.cache` (ignoré par git).
Incrémenter `GRADE_VERSION` après toute modification de l'étalonnage pour invalider le cache.

## Mesures (machine de développement : 4 cœurs, 15 Go de RAM)

| Cible      | Durée                                            | Taille | Disque temporaire                     |
| ---------- | ------------------------------------------------ | ------ | ------------------------------------- |
| zoom 0 à 5 | ~1 min 30                                        | 2,1 Mo | 0,7 Go                                |
| zoom 0 à 8 | ~29 min (étalonnage 23 min, 87 381 tuiles 6 min) | 97 Mo  | ~15 Go (sources 0,4 Go, images 14 Go) |

## Limites

- Blue Marble fait ~500 m/px : au-delà du zoom 8 l'image serait floue (voir la critique 6.2 de
  `docs/architecture.md`) ; le client doit basculer vers le style vectoriel sombre.
- Nuages absents mais une seule saison (juillet) : banquise antarctique d'hiver visible en bleu à peine plus clair.
- Les lacs intérieurs gardent l'étalonnage « terre » (couleur sombre de la source) : seuls les océans et mers
  du masque Natural Earth sont traités comme de la mer.

Après une construction complète, `tools/tiles/.cache/graded-*.u8` (~14 Go) peut être supprimé ; il n'accélère
que les reconstructions sans changement d'étalonnage.
