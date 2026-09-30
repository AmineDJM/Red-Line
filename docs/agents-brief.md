# Brief commun des agents — Phase 1 (Socle)

Lis d'abord : `CLAUDE.md`, `docs/architecture.md`, tout `packages/shared/src/*.ts` et `packages/engine/src/api.ts`.
Ce sont les **contrats figés** entre les équipes. Si un contrat te bloque vraiment, ne le casse pas : ajoute des
champs **optionnels** seulement, et signale-le dans ton rapport final.

## Règles

- Monorepo pnpm, TypeScript strict, ESM. Les paquets `@redline/shared`, `@redline/engine` et `@redline/ui` sont consommés
  directement en source (`src/index.ts`), sans étape de build.
- **Ne fais PAS de commit git** (l'orchestrateur commite). Ne modifie que les dossiers qui te sont attribués.
- Dépendances déjà installées. Si tu dois en ajouter : `pnpm --filter <ton-paquet> add <dep>` depuis la racine
  (en cas d'erreur de verrou du lockfile, réessaie quelques secondes plus tard ; d'autres agents travaillent en parallèle).
- Fichiers temporaires dans `/tmp/claude-0/-home-user-Red-Line/f97702d8-0462-564b-a9e9-21a6bf589e3c/scratchpad/<ton-nom>/`.
- Textes visibles par le joueur en **français**. Nom du jeu : **Red Line**.
- Tous les chiffres d'équilibrage viennent de `data/` (jamais en dur).
- Aucun vrai site sensible nommé comme cible : bâtiments génériques par province uniquement.
- Réseau : npm, raw.githubusercontent.com, naciscdn.org, NASA (eoimages.gsfc.nasa.gov, assets.science.nasa.gov) accessibles ;
  github.com (releases) bloqué.
- PostgreSQL 16 disponible localement : `/usr/lib/postgresql/16/bin/{initdb,pg_ctl,postgres}`.
- Chromium pour Playwright : `/opt/pw-browsers` (ne lance jamais `playwright install`).

## Conventions partagées

- Identifiants de nations : ISO 3166-1 alpha-3 en minuscules (`fra`, `dza`, `usa`) ; entités spéciales : `gaza`, `pse`
  (Autorité palestinienne / Cisjordanie), `isr` distincts.
- Identifiants de province : `<nation>-<n>` (ex. `fra-12`), stables.
- Coordonnées : `[lng, lat]`.
- Polices des étiquettes MapLibre (fontstacks exacts) : `Barlow Condensed Bold`, `IBM Plex Sans Regular`,
  `IBM Plex Sans SemiBold`, `IBM Plex Sans Italic`. Glyphes servis sous `/glyphs/{fontstack}/{range}.pbf`.
- Fichiers servis par le serveur :
  - `/tiles/*.pmtiles` ← `TILES_DIR` (défaut `data/tiles`) ;
  - `/basemap/*.geojson` ← `data/basemap` ;
  - `/glyphs/...` ← `data/glyphs` ;
  - `/` ← `apps/client/dist` ; `/admin/` ← `apps/admin/dist`.
- Imagerie : `data/tiles/satellite-lowzoom.pmtiles` (commité, zoom 0 à 5) et `data/tiles/satellite.pmtiles`
  (zoom 0 à 8, non commité, construit par script). Le client utilise `satellite.pmtiles` s'il existe, sinon la version `lowzoom` ;
  l'API expose la liste des fichiers disponibles via `GET /api/map/tiles` → `{ satellite: "/tiles/xxx.pmtiles", maxzoom }`.
- Dev : serveur sur `:3000`, client Vite sur `:5173` (proxy `/api`, `/ws`, `/tiles`, `/basemap`, `/glyphs` vers `:3000`),
  admin Vite sur `:5174` (base `/admin/`, même proxy).

## Rapport final attendu

Ce qui est fait, comment le tester, ce qui manque, et **tout écart par rapport aux contrats**.
