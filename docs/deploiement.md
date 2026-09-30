# Déployer Red Line sur Render

Tout est décrit dans `render.yaml` (Blueprint). Un seul service web sert l'API, le WebSocket, le jeu (`/`) et le
back-office (`/admin/`), sur la même origine, plus une base PostgreSQL.

| Environnement | Branche   | Service web                        | Base                        |
| ------------- | --------- | ---------------------------------- | --------------------------- |
| Production    | `main`    | `redline-server` (Starter)         | `redline-db` (basic-256mb)  |
| Staging       | `staging` | `redline-server-staging` (gratuit) | `redline-db-staging` (free) |

> L'offre gratuite s'endort après 15 minutes sans trafic, ce qui fige les parties en cours, et la base gratuite est
> temporaire. C'est acceptable pour le staging, **pas pour la production**.

## Première mise en service

1. Pousser la branche `main` (et `staging` si besoin) sur GitHub.
2. Render → **New → Blueprint** → choisir le dépôt. Render lit `render.yaml` et propose les 2 services et les 2 bases.
3. Renseigner les variables marquées `sync: false` :
   - `ADMIN_EMAIL` : e-mail du super-admin (créé ou mis à jour à chaque démarrage) ;
   - `ADMIN_PASSWORD` : 8 caractères minimum.
     `SESSION_SECRET` est généré automatiquement ; `DATABASE_URL` est relié à la base.
4. Valider. Render exécute, à chaque déploiement :
   - build : `pnpm install --frozen-lockfile && pnpm build` (client, back-office, puis serveur) ;
   - avant la mise en ligne (production) : `node apps/server/dist/migrate.js` (migrations SQL) ;
     en staging, les migrations sont appliquées au démarrage (`MIGRATE_ON_START=true`) ;
   - démarrage : `node apps/server/dist/main.js` ; contrôle de santé sur `/healthz`.
5. Ouvrir l'URL du service : le jeu est à `/`, le back-office à `/admin/`.

## Imagerie satellite

`data/tiles/satellite.pmtiles` (zoom 0 à 8, ~93 Mio) et `satellite-lowzoom.pmtiles` (zoom 0 à 5, 2 Mo) sont
**dans le dépôt** : aucun disque Render n'est nécessaire. Le serveur choisit automatiquement le plus détaillé.
Pour les régénérer : `tools/tiles/README.md` (≈ 30 min, ≈ 15 Go d'espace temporaire).
Si l'imagerie devait grossir au-delà de la limite GitHub (100 Mio par fichier), la placer sur un stockage objet
(Cloudflare R2 par exemple) et pointer `TILES_DIR` vers un dossier synchronisé : le code ne change pas.

## Variables d'environnement

| Variable                                             | Rôle                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`                                       | Connexion PostgreSQL (obligatoire)                             |
| `SESSION_SECRET`                                     | Signature des cookies, 32 caractères minimum en production     |
| `ADMIN_EMAIL`/`ADMIN_PASSWORD`                       | Super-admin créé ou mis à jour au démarrage                    |
| `PORT`                                               | Fourni par Render                                              |
| `MIGRATE_ON_START`                                   | Applique les migrations au démarrage (staging)                 |
| `SNAPSHOT_INTERVAL_S`                                | Fréquence des instantanés de parties (60 s)                    |
| `LEASE_TTL_S`                                        | Durée du bail d'une partie (30 s)                              |
| `INSTANCE_ID`                                        | Laisser vide : un identifiant unique par instance est généré   |
| `DATA_DIR`, `TILES_DIR`, `CLIENT_DIST`, `ADMIN_DIST` | Chemins, valeurs par défaut adaptées au dépôt                  |
| `REDLINE_EXTRA_SPEEDS`                               | Tests uniquement (vitesses d'essai) — **refusé en production** |

## Déploiements et parties en cours

Les parties survivent aux redéploiements : instantané à l'arrêt (SIGTERM), puis reprise par la nouvelle instance
(dernier instantané + rejeu des ordres + rattrapage du temps écoulé). Pendant le court chevauchement de deux
instances, un **bail** en base garantit qu'une partie n'est simulée que par une seule d'entre elles.

## Surveiller

- `/healthz` : état du service et de la base.
- Back-office → **Métriques** : CPU, mémoire, décalage de la boucle d'événements, parties, joueurs connectés,
  événements par minute. Passer à l'offre supérieure quand le décalage de boucle dépasse régulièrement ~50 ms.
