# Mettre Red Line en ligne sur Render — pas à pas

Ce guide s'adresse à Amine : aucune commande à taper, tout se fait dans les tableaux de bord de GitHub, Render et
Stripe. Compter une demi-heure la première fois.

Tout est décrit dans le fichier `render.yaml` du dépôt (un « Blueprint ») : **un seul service web** sert le jeu
(`/`), le back-office (`/admin/`), l'API et le temps réel (WebSocket) sur la même adresse, plus **une base
PostgreSQL**. Deux environnements :

| Environnement | Branche GitHub | Service web                          | Base                                    |
| ------------- | -------------- | ------------------------------------ | --------------------------------------- |
| Production    | `main`         | `redline-server` (Starter, 7 $/mois) | `redline-db` (basic-256mb, disque 5 Go) |
| Staging       | `staging`      | `redline-server-staging` (gratuit)   | `redline-db-staging` (gratuite)         |

> Le service gratuit s'endort après 15 minutes sans visite (les parties s'arrêtent le temps de son réveil) et la
> base gratuite est supprimée au bout de 30 jours : très bien pour essayer, **jamais pour la production**.

## 1. Préparer

1. Un compte **GitHub** avec le dépôt Red Line, et la branche `main` à jour (la branche `staging` est facultative).
2. Un compte **Render** (render.com) relié à GitHub : Render → _Account Settings_ → _GitHub_ → autoriser l'accès au
   dépôt.
3. Choisir dès maintenant :
   - l'**e-mail** et le **mot de passe** du super-administrateur (12 caractères ou plus conseillés) ;
   - l'**adresse publique** du jeu : au début `https://redline-server.onrender.com` (Render l'affiche après la
     création), plus tard votre domaine (étape 6).

## 2. Créer le Blueprint

1. Render → **New +** → **Blueprint**.
2. Choisir le dépôt Red Line, branche `main`. Render lit `render.yaml` et affiche : 2 services web, 2 bases.
   (Pour ne créer que la production, supprimer le staging juste après, ou le laisser : il ne coûte rien.)
3. Render demande les valeurs « à saisir » (les autres sont automatiques) :

   | Variable                | Que mettre                                                                    |
   | ----------------------- | ----------------------------------------------------------------------------- |
   | `ADMIN_EMAIL`           | votre e-mail de super-admin                                                   |
   | `ADMIN_PASSWORD`        | son mot de passe (8 caractères minimum)                                       |
   | `PUBLIC_URL`            | l'adresse publique, sans `/` final, ex. `https://redline-server.onrender.com` |
   | `STRIPE_SECRET_KEY`     | laisser **vide** pour l'instant (étape 4)                                     |
   | `STRIPE_WEBHOOK_SECRET` | laisser **vide** pour l'instant (étape 4)                                     |

   Automatiques : `SESSION_SECRET` (secret des cookies, tiré au hasard), `DATABASE_URL` (reliée à la base),
   `NODE_OPTIONS`, `CLIENT_IP_HEADER`, `NODE_ENV`, `NODE_VERSION`.

4. **Apply**. Render crée la base, puis construit le service (3 à 6 minutes) :
   installation, construction du jeu, du back-office et du serveur, **migrations de la base**, démarrage, puis
   vérification de santé sur `/healthz`. Le déploiement est vert quand le service affiche **Live**.
5. Ouvrir l'adresse du service : le jeu s'affiche. Ouvrir `…/admin/` et se connecter avec l'e-mail et le mot de
   passe choisis. Si `PUBLIC_URL` n'était pas encore connue, la renseigner maintenant (service → **Environment**
   → modifier → **Save, rebuild and deploy**).

Chaque `git push` sur `main` redéploie automatiquement, **seulement si la CI GitHub est verte**
(`autoDeployTrigger: checksPass`) : un code qui casse les tests n'est jamais mis en ligne. Le staging, lui, se
redéploie à chaque push sur `staging`.

## 3. Vérifier que tout fonctionne

- `https://<adresse>/healthz` répond `{"ok":true,…}`.
- Jeu : « Jouer en invité » → nouvelle partie → la carte satellite s'affiche et zoome jusqu'aux villes.
- Back-office → **Métriques** : CPU, mémoire, boucle d'événements. → **Statut des données** : 201 nations,
  ORBAT, recherche, photos, sans avertissement bloquant.
- Render → service → **Logs** : la dernière ligne est `Red Line : serveur démarré`.

Les parties survivent aux redéploiements : à l'arrêt, chaque partie est enregistrée (instantané) ; le nouveau
serveur la reprend (instantané + rejeu des ordres + rattrapage du temps écoulé). Un **bail** en base garantit
qu'une partie n'est jamais simulée par deux serveurs à la fois pendant le chevauchement.

## 4. Boutique (Stripe)

Sans les deux clés Stripe, la boutique reste visible mais affiche « paiements indisponibles » ; tout le reste du
jeu fonctionne. Pour l'activer :

1. **Stripe** → Développeurs → **Clés API** → copier la **clé secrète** (`sk_live_…`).
   Render → `redline-server` → **Environment** → `STRIPE_SECRET_KEY` → coller.
2. Stripe → Développeurs → **Webhooks** → **Ajouter un point de terminaison** :
   - URL : `https://<adresse>/api/stripe/webhook`
   - événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
   - Copier le **secret de signature** (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`.
3. **Save, rebuild and deploy**. Dans le jeu, la boutique propose les packs ; un achat de test crédite le
   portefeuille une fois le webhook reçu (Stripe → Webhooks → le point de terminaison affiche « 200 »).
4. Staging : mêmes étapes avec les clés de **test** (`sk_test_…`) et l'adresse du staging.

Garanties : le portefeuille n'est crédité **que** par un webhook dont la signature est vérifiée ; chaque
événement n'est traité qu'une fois ; le journal des mouvements est en ajout seul. Les remboursements se font
depuis le back-office (Boutique → Achats). Packs, promotions et cosmétiques se gèrent dans le back-office.

## 5. Notifications (Web Push, clés VAPID)

Rien à faire : les clés VAPID sont générées au premier démarrage et gardées en base, donc les abonnements des
joueurs restent valables d'un déploiement à l'autre. Le contact envoyé aux services de notification est
`PUBLIC_URL`. Facultatif : pour imposer vos propres clés (par exemple en changeant d'hébergeur), ajouter
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` (`mailto:vous@exemple.fr`). Sur iPhone, les
notifications exigent que le joueur ait ajouté Red Line à l'écran d'accueil.

## 6. Votre nom de domaine

1. Render → `redline-server` → **Settings** → **Custom Domains** → **Add** → par exemple `jouer.redline.fr`.
2. Chez votre registraire (OVH, Gandi…), créer l'enregistrement DNS indiqué par Render (un `CNAME` vers
   `redline-server.onrender.com`, ou un `A`/`ALIAS` pour un domaine nu). Render émet le certificat HTTPS tout seul
   (quelques minutes à quelques heures).
3. Mettre `PUBLIC_URL` à la nouvelle adresse, et mettre à jour l'URL du webhook Stripe (étape 4).
4. Le jeu, le back-office et l'API restent sur **la même adresse** : c'est voulu (cookies de session acceptés par
   tous les navigateurs, Safari compris). Ne pas séparer le back-office sur un autre sous-domaine.

## 7. Sauvegardes de la base

- **Automatiques** : les bases payantes de Render ont une restauration à un instant donné (_Point-in-Time
  Recovery_, plusieurs jours) : Render → `redline-db` → **Recovery** → choisir la date et l'heure → Render crée une
  nouvelle base restaurée ; il suffit ensuite de relier `DATABASE_URL` du service à cette base.
- **Exports** : Render → `redline-db` → **Recovery** → **Export** (ou _Create export_) télécharge une copie
  complète ; en faire une par semaine et avant toute grosse modification du back-office.
- La base n'accepte **aucune connexion depuis Internet** (`ipAllowList: []`) : seul le service y accède par le
  réseau privé de Render. Pour une connexion ponctuelle depuis un ordinateur (outil SQL, `pg_dump`), ajouter
  temporairement son adresse IP dans `redline-db` → **Networking**, puis la retirer.
- La base gratuite du staging n'est **pas** sauvegardée et disparaît au bout de 30 jours.

## 8. Surveiller et grandir

- `/healthz` : état du service et de la base (Render le surveille et redémarre le service si besoin).
- Back-office → **Métriques** : CPU, mémoire, latence de la boucle (99e centile et pire), diffusions (nombre et
  coût), parties en rattrapage, joueurs et spectateurs connectés, trafic WebSocket, chat, notifications.
- Back-office → **Parties en direct** : pause, reprise, événements mondiaux, **confier une nation à une IA** (et
  la rendre au joueur).
- Back-office → **Sécurité** : comptes suspects (IP hachée partagée, même navigateur, horaires, même partie).
- **Quand passer à l'offre supérieure** (Render → service → **Settings** → **Instance Type**) : voir
  [`docs/charge.md`](charge.md). En bref, en Starter : CPU moyen au-dessus de 40 %, latence de boucle (99e
  centile) au-dessus de 200 ms, mémoire au-dessus de 420 Mo, ou une partie de plus de ~20 joueurs connectés. En
  passant en **Standard** (2 Go), régler `NODE_OPTIONS` à `--max-old-space-size=1536`.

## Sécurité en place

- Mots de passe hachés (Argon2), sessions en cookie `HttpOnly`, `Secure`, `SameSite=Lax`, signées, renouvelées
  chaque jour ; comptes bannis déconnectés partout (sessions et WebSocket).
- Toute requête d'écriture doit venir du site lui-même (contrôle d'origine anti-CSRF) ; WebSocket réservé à la
  même origine ; webhook Stripe authentifié par signature.
- En-têtes de sécurité sur toutes les réponses : politique de contenu (CSP) stricte compatible avec la carte,
  anti-iframe, `nosniff`, HSTS, `Referrer-Policy`, `Permissions-Policy` ; réponses d'API jamais mises en cache.
- Limites de débit par IP réelle (IP transmise par Cloudflare, `CLIENT_IP_HEADER`) : connexions, créations de
  parties, achats, messages WebSocket et chat ; quotas de parties par joueur.
- Le serveur n'envoie à chaque joueur que ce qu'il a le droit de voir ; statistiques des autres nations
  seulement en fin de partie ; spectateurs : vue publique sans secret.
- Notifications push envoyées uniquement aux services des navigateurs (Google, Mozilla, Apple, Microsoft).
- Rôles du back-office : modération < équilibrage < super-admin, chaque action est journalisée (Journal d'audit).

## Référence : variables d'environnement

| Variable                                                          | Rôle                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                                                    | Connexion PostgreSQL (obligatoire)                                       |
| `SESSION_SECRET`                                                  | Signature des cookies, 32 caractères minimum en production               |
| `ADMIN_EMAIL`/`ADMIN_PASSWORD`                                    | Super-admin créé ou mis à jour au démarrage                              |
| `PUBLIC_URL`                                                      | Adresse publique (retours de Stripe Checkout, contact VAPID)             |
| `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`                       | Boutique (les deux ensemble)                                             |
| `CLIENT_IP_HEADER`                                                | En-tête de l'IP réelle posé par le proxy (`cf-connecting-ip` sur Render) |
| `NODE_OPTIONS`                                                    | Taille du tas JavaScript (`--max-old-space-size=384` en Starter)         |
| `PORT`                                                            | Fourni par Render                                                        |
| `MIGRATE_ON_START`                                                | Migrations au démarrage (staging gratuit, sans pré-déploiement)          |
| `SNAPSHOT_INTERVAL_S`                                             | Fréquence des instantanés de parties (60 s)                              |
| `LEASE_TTL_S`                                                     | Durée du bail d'une partie (30 s)                                        |
| `INSTANCE_ID`                                                     | **Laisser vide** (un identifiant unique par instance est généré)         |
| `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`            | Facultatif : clés Web Push imposées                                      |
| `DATA_DIR`, `TILES_DIR`, `CLIENT_DIST`, `ADMIN_DIST`, `LEGAL_DIR` | Chemins ; les valeurs par défaut conviennent                             |
| `REDLINE_EXTRA_SPEEDS`                                            | Tests uniquement — **refusé en production**                              |

## Annexes techniques

- **Construction** (Render et CI) : `npx pnpm@10.33.0 install --frozen-lockfile && npx pnpm@10.33.0 build` ;
  le build précompresse les fichiers du jeu et du back-office (Brotli + gzip : 14 Mio → 3 Mio). Taille des
  livrables : jeu 66 Mo (dont 52 Mo de photos), back-office 7 Mo, serveur 5 Mo ; imagerie satellite 93 Mo dans
  `data/tiles` (servie avec les requêtes partielles `Range`, cache 7 jours).
- **Pré-déploiement** : `node apps/server/dist/migrate.js` (migrations SQL) ; **démarrage** :
  `node apps/server/dist/main.js`.
- **Imagerie** : `data/tiles/satellite.pmtiles` (zoom 0 à 8) est dans le dépôt ; pour la régénérer :
  `tools/tiles/README.md`. Au-delà de 100 Mio par fichier (limite GitHub), passer par un stockage objet et
  `TILES_DIR`.
- **Documents légaux** (`apps/server/legal/*.md`) : modèles **à faire valider par un professionnel** ; incrémenter
  `version` dans l'en-tête d'un document pour le faire réaccepter par les joueurs.
- **Données du back-office** (règles, recherche, ORBAT, scénarios, carte) : versionnées en base
  (`data_revisions`) ; une partie garde la version de sa création, sauf modification « parties en cours ».
- Simulation locale d'un déploiement de zéro : clone frais, installation et build ci-dessus, base vide,
  `migrate.js` puis `main.js` avec les variables de `render.yaml` — vérifié le 30/09/2026 (santé, jeu,
  back-office, tuiles `Range`, photos, glyphes, fond de carte, compression).
