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

| Variable                                             | Rôle                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                                       | Connexion PostgreSQL (obligatoire)                                   |
| `SESSION_SECRET`                                     | Signature des cookies, 32 caractères minimum en production           |
| `ADMIN_EMAIL`/`ADMIN_PASSWORD`                       | Super-admin créé ou mis à jour au démarrage                          |
| `PORT`                                               | Fourni par Render                                                    |
| `MIGRATE_ON_START`                                   | Applique les migrations au démarrage (staging)                       |
| `SNAPSHOT_INTERVAL_S`                                | Fréquence des instantanés de parties (60 s)                          |
| `LEASE_TTL_S`                                        | Durée du bail d'une partie (30 s)                                    |
| `INSTANCE_ID`                                        | Laisser vide : un identifiant unique par instance est généré         |
| `DATA_DIR`, `TILES_DIR`, `CLIENT_DIST`, `ADMIN_DIST` | Chemins, valeurs par défaut adaptées au dépôt                        |
| `REDLINE_EXTRA_SPEEDS`                               | Tests uniquement (vitesses d'essai) — **refusé en production**       |
| `PUBLIC_URL`                                         | URL publique du site (retours de Stripe Checkout, sujet VAPID)       |
| `STRIPE_SECRET_KEY`                                  | Clé secrète Stripe (`sk_live_…` ; `sk_test_…` en staging)            |
| `STRIPE_WEBHOOK_SECRET`                              | Secret de signature du webhook Stripe (`whsec_…`)                    |
| `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`               | Facultatif : clés Web Push imposées (sinon générées en base)         |
| `VAPID_SUBJECT`                                      | Facultatif : contact VAPID (`mailto:…` ou URL ; défaut `PUBLIC_URL`) |
| `LEGAL_DIR`                                          | Facultatif : dossier des documents légaux (`apps/server/legal`)      |

## Boutique (Stripe)

Sans `STRIPE_SECRET_KEY` **et** `STRIPE_WEBHOOK_SECRET`, la boutique reste visible mais affiche « paiements
indisponibles » (`GET /api/shop/packs` → `paymentsAvailable: false`) ; le reste du jeu fonctionne.

1. Stripe → Développeurs → Clés API : copier la clé secrète dans `STRIPE_SECRET_KEY`.
2. Stripe → Développeurs → Webhooks → Ajouter un point de terminaison :
   `https://<service>.onrender.com/api/stripe/webhook`, événements `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired`, `charge.refunded`. Copier le secret de signature dans `STRIPE_WEBHOOK_SECRET`.
3. Renseigner `PUBLIC_URL` (adresse du service) pour les pages de retour de Checkout.

Le portefeuille n'est crédité **que** par un webhook dont la signature est vérifiée (corps brut, tolérance
5 min) ; chaque événement n'est traité qu'une fois (table `stripe_events`). Le journal `wallet_ledger` est en
ajout seul (déclencheur SQL). Les remboursements se font depuis le back-office (appel Stripe puis débit).
Les packs et cosmétiques initiaux viennent de `apps/server/shop/config.json` (insérés s'ils n'existent pas), puis
se gèrent dans le back-office. Tester en local : `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## Notifications Web Push

Les clés VAPID sont générées au premier démarrage et stockées en base (`server_settings`) : toutes les instances
partagent la même paire, et les abonnements des navigateurs restent valides d'un déploiement à l'autre. Pour
imposer une paire existante, renseigner `VAPID_PUBLIC_KEY` et `VAPID_PRIVATE_KEY`.

## Documents légaux

Les textes (CGU, CGV, confidentialité, rétractation) sont des **modèles à faire valider par un professionnel**,
dans `apps/server/legal/*.md`. Pour publier une nouvelle version, modifier le texte et incrémenter `version` dans
l'en-tête : les joueurs devront la réaccepter (`GET /api/me` → `legal.needsAcceptance`). L'achat est refusé tant
que les CGV et la renonciation à la rétractation en vigueur ne sont pas acceptées.

## Déploiements et parties en cours

Les parties survivent aux redéploiements : instantané à l'arrêt (SIGTERM), puis reprise par la nouvelle instance
(dernier instantané + rejeu des ordres + rattrapage du temps écoulé). Pendant le court chevauchement de deux
instances, un **bail** en base garantit qu'une partie n'est simulée que par une seule d'entre elles.

## Surveiller

- `/healthz` : état du service et de la base.
- Back-office → **Métriques** : CPU, mémoire, décalage de la boucle d'événements, parties (par statut, toutes
  instances), joueurs et spectateurs connectés, événements par minute, taille des états (instantanés compressés),
  octets et messages WebSocket envoyés, messages de chat et notifications push par minute. Passer à l'offre
  supérieure quand le décalage de boucle dépasse régulièrement ~50 ms.
- Back-office → **Sécurité** : paires de comptes suspectes (IP hachée partagée, même navigateur, horaires
  semblables, même partie) et cadences d'ordres anormales. Aucune IP n'est stockée en clair.
- Les modifications de données du back-office (règles, recherche, ORBAT, scénarios, carte) sont versionnées dans
  `data_revisions` : une partie épingle la révision de sa création ; la portée « parties en cours » s'applique
  aux parties hébergées par l'instance qui reçoit la modification (les autres la prennent à leur reprise).
