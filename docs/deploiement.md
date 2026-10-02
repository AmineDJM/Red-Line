# Mettre Red Line en ligne sur Render — pas à pas

Ce guide s'adresse à Amine : aucune commande à taper, tout se fait dans les tableaux de bord de GitHub, Render et
Stripe. Compter une demi-heure la première fois.

Tout est décrit dans le fichier `render.yaml` du dépôt (un « Blueprint ») : **un seul service web** sert le jeu
(`/`), le back-office (`/admin/`), l'API et le temps réel (WebSocket) sur la même adresse, plus **une base
PostgreSQL**, en production uniquement :

| Environnement | Branche GitHub | Service web                          | Base                                    |
| ------------- | -------------- | ------------------------------------ | --------------------------------------- |
| Production    | `main`         | `redline-server` (Starter, 7 $/mois) | `redline-db` (basic-256mb, disque 5 Go) |

> Un environnement de test (staging, offres gratuites) pourra être ajouté plus tard dans `render.yaml` ; il exige
> une branche `staging` sur GitHub.

## 1. Préparer

1. Un compte **GitHub** avec le dépôt Red Line, et la branche `main` à jour.
2. Un compte **Render** (render.com) relié à GitHub : Render → _Account Settings_ → _GitHub_ → autoriser l'accès au
   dépôt.
3. Choisir dès maintenant :
   - l'**e-mail** et le **mot de passe** du super-administrateur (12 caractères ou plus conseillés) ;
   - l'**adresse publique** du jeu : au début `https://redline-server.onrender.com` (Render l'affiche après la
     création), plus tard votre domaine (étape 6).

## 2. Créer le Blueprint

1. Render → **New +** → **Blueprint**.
2. Choisir le dépôt Red Line, branche `main`. Render lit `render.yaml` et affiche : 1 service web, 1 base.
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
(`autoDeployTrigger: checksPass`) : un code qui casse les tests n'est jamais mis en ligne.

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
4. Pour essayer sans vrai paiement : clés de **test** (`sk_test_…`) d'abord, puis clés réelles.

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
5. **`PUBLIC_URL` est aussi l'adresse de référence pour les moteurs de recherche** : URL canoniques, balises
   `hreflang`, sitemap, images de partage (Open Graph, Twitter) et e-mail de contact par défaut
   (`contact@<domaine>`) en dépendent. Sans elle, ces adresses sont déduites de chaque requête (acceptable en
   essai, à éviter en production : l'adresse `onrender.com` serait indexée en double).

## 6 bis. Référencement (Google, Bing) et informations légales

Les pages publiques sont **prérendues au build** (`apps/site`, aucune action manuelle) et servies par le serveur :

| Adresse                                                                                                      | Contenu                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `/`                                                                                                          | le jeu (en-tête SEO, JSON-LD `VideoGame`, image de partage)   |
| `/fr/`, `/en/`                                                                                               | accueil public par langue                                     |
| `/fr/comment-jouer/`, `/en/how-to-play/`                                                                     | guide du débutant                                             |
| `/fr/fonctionnalites/`, `/fr/nations/`, `/fr/faq/`                                                           | fonctionnalités, 201 nations et budgets 2025, FAQ (`FAQPage`) |
| `/fr/arsenal/` + 6 familles                                                                                  | les 406 matériels, photos créditées, prix unitaires           |
| `/fr/mentions-legales/`, `/fr/confidentialite/`, `/fr/cookies/`, `/fr/cgu/`, `/fr/cgv/`, `/fr/retractation/` | documents légaux (et leurs versions anglaises)                |
| `/sitemap.xml`, `/robots.txt`                                                                                | plan du site (avec `hreflang`) et consignes d'exploration     |

**Avant d'ouvrir au public**

1. Back-office → **Réglages › Légal** : vérifier l'éditeur (pré-rempli), renseigner le **médiateur de la
   consommation** et l'**e-mail de contact** (vide = `LEGAL_CONTACT_EMAIL`, sinon `contact@<domaine>` : créer
   cette boîte, ou une redirection, chez le registraire). Les pages sont mises à jour aussitôt.
2. Variable facultative `LEGAL_CONTACT_EMAIL` (Render → **Environment**) : adresse de contact par défaut.
3. Ouvrir `https://<domaine>/fr/mentions-legales/` et `…/sitemap.xml` : les adresses doivent commencer par le
   domaine définitif.

**Google Search Console** (search.google.com/search-console)

1. **Ajouter une propriété** → type **Domaine** → saisir `votre-domaine.fr` → Google affiche un enregistrement
   DNS `TXT` (`google-site-verification=…`) : l'ajouter chez le registraire, puis **Valider** (quelques minutes à
   quelques heures). Le type « Domaine » couvre `www`, `https` et tous les sous-domaines.
2. Menu **Sitemaps** → saisir `sitemap.xml` → **Envoyer**. L'état passe à « Opération effectuée » ; les pages
   apparaissent dans **Pages** sous quelques jours.
3. **Inspection de l'URL** → coller `https://<domaine>/fr/` → **Demander l'indexation** (à refaire pour `/en/`).
4. Contrôles utiles : **Améliorations › Fil d'Ariane** et **FAQ** (données structurées détectées),
   **Signaux Web essentiels** (après quelques semaines de trafic), outil
   [Résultats enrichis](https://search.google.com/test/rich-results) sur `/fr/` (VideoGame) et `/fr/faq/`.

**Bing Webmaster Tools** (bing.com/webmasters ; sert aussi Yahoo, DuckDuckGo, Ecosia)

1. **Se connecter** → **Importer depuis Google Search Console** (le plus simple : propriété et sitemap repris), ou
   **Ajouter un site** → vérification par enregistrement DNS `CNAME`.
2. **Sitemaps** → **Envoyer un sitemap** → `https://<domaine>/sitemap.xml`.
3. Facultatif : **IndexNow** n'est pas nécessaire (le sitemap suffit à ce volume de pages).

**Langues** : seules les langues dont `apps/site/content/<langue>/site.json` existe sont construites (français et
anglais aujourd'hui). Pour en ajouter une : copier `content/en/site.json` (et `content/en/legal/*.md`,
facultatif) dans `content/<langue>/`, traduire les textes (les clés absentes reprennent l'anglais), puis ajouter la
langue à `apps/client/src/lib/publicPages.ts`. Les `hreflang`, le sélecteur de langue et le sitemap suivent
d'eux-mêmes. Les documents légaux traduits ne sont publiés que si leur `version` est celle du texte français, qui
seul fait foi.

**Image de partage et capture** : `apps/site/static/og/og-<langue>.jpg` et `static/shots/` viennent d'une vraie
partie ; pour les refaire (après une évolution visible de l'interface) : serveur lancé puis
`node apps/site/scripts/capture.mjs http://localhost:3000 France`, et committer les fichiers.

## 7. Sauvegardes de la base

- **Automatiques** : les bases payantes de Render ont une restauration à un instant donné (_Point-in-Time
  Recovery_, plusieurs jours) : Render → `redline-db` → **Recovery** → choisir la date et l'heure → Render crée une
  nouvelle base restaurée ; il suffit ensuite de relier `DATABASE_URL` du service à cette base.
- **Exports** : Render → `redline-db` → **Recovery** → **Export** (ou _Create export_) télécharge une copie
  complète ; en faire une par semaine et avant toute grosse modification du back-office.
- La base n'accepte **aucune connexion depuis Internet** (`ipAllowList: []`) : seul le service y accède par le
  réseau privé de Render. Pour une connexion ponctuelle depuis un ordinateur (outil SQL, `pg_dump`), ajouter
  temporairement son adresse IP dans `redline-db` → **Networking**, puis la retirer.

## 8. Compte illimité (administrateur)

Le compte d'`ADMIN_EMAIL` / `ADMIN_PASSWORD` est en **mode illimité d'office** : rien d'autre à faire sur
Render. Il suffit de jouer avec ce compte (se connecter dans le jeu avec le même e-mail et le même mot de passe
que pour le back-office) :

- **en partie** (solo ou multijoueur) : argent et ressources jamais limitants. La barre du haut affiche « ∞ » et
  un badge « ILLIMITÉ » ; aucune production, importation, licence, construction, recherche, opération de
  renseignement ou mobilisation n'est refusée faute de fonds. La **recherche reste nécessaire** pour produire un
  matériel (elle n'est simplement jamais bloquée par l'argent) ;
- **monnaie premium** illimitée : accélérations et cosmétiques sans débit ni passage par Stripe ;
- **aucun quota** de parties (10 parties solo en cours pour les autres joueurs) ;
- **équité** : une partie multijoueur où joue un compte illimité devient **non classée** (aucun point de
  classement), et un avis public le signale à tous les joueurs (« Mode illimité actif pour France — partie non
  classée ») ainsi que dans le salon. En solo, rien n'est signalé.

Pour l'activer ou le retirer à **n'importe quel compte** : back-office → **Utilisateurs** → choisir le compte →
**Mode illimité** → _Activer_ / _Retirer_ (confirmation demandée). Seul le rôle **superadmin** peut le faire ;
chaque changement est inscrit au **journal d'audit** (`user.unlimited`). L'effet est immédiat dans les parties
en cours du joueur (sinon à leur prochain chargement ou à sa prochaine connexion). En retirant le mode, la nation
retrouve la réserve qu'elle avait avant l'activation. Une IA qui remplace le joueur (inactivité, départ,
décision de l'administration) n'en profite jamais. Le choix fait dans le back-office est conservé : un
redémarrage du serveur ne réactive pas le mode illimité retiré au compte administrateur.

Détails techniques : colonne `users.unlimited` (migration `0003_unlimited`), commande système journalisée
`{ kind: 'unlimited', nationId, on }` rejouée à la reprise ; le moteur gèle la réserve de la nation aux plafonds
`unlimited` de `data/balance/default.json` (10¹⁵ $ et 10¹² unités de chaque ressource) après chaque événement,
ordre et commande ; les dépenses restent comptées dans les statistiques. Colonne `games.unranked` pour les
parties non classées.

## 9. Surveiller et grandir

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

| Variable                                                                                           | Rôle                                                                        |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                     | Connexion PostgreSQL (obligatoire)                                          |
| `SESSION_SECRET`                                                                                   | Signature des cookies, 32 caractères minimum en production                  |
| `ADMIN_EMAIL`/`ADMIN_PASSWORD`                                                                     | Super-admin créé ou mis à jour au démarrage                                 |
| `PUBLIC_URL`                                                                                       | Adresse publique (retours de Stripe Checkout, contact VAPID)                |
| `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`                                                        | Boutique (les deux ensemble)                                                |
| `CLIENT_IP_HEADER`                                                                                 | En-tête de l'IP réelle posé par le proxy (`cf-connecting-ip` sur Render)    |
| `NODE_OPTIONS`                                                                                     | Taille du tas JavaScript (`--max-old-space-size=384` en Starter)            |
| `PORT`                                                                                             | Fourni par Render                                                           |
| `MIGRATE_ON_START`                                                                                 | Migrations au démarrage (staging gratuit, sans pré-déploiement)             |
| `SNAPSHOT_INTERVAL_S`                                                                              | Fréquence des instantanés de parties (60 s)                                 |
| `LEASE_TTL_S`                                                                                      | Durée du bail d'une partie (30 s)                                           |
| `INSTANCE_ID`                                                                                      | **Laisser vide** (un identifiant unique par instance est généré)            |
| `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`                                             | Facultatif : clés Web Push imposées                                         |
| `LEGAL_CONTACT_EMAIL`                                                                              | Facultatif : e-mail de contact légal par défaut (sinon `contact@<domaine>`) |
| `DATA_DIR`, `TILES_DIR`, `CLIENT_DIST`, `ADMIN_DIST`, `LEGAL_DIR`, `SITE_DIST`, `SITE_CONTENT_DIR` | Chemins ; les valeurs par défaut conviennent                                |
| `REDLINE_EXTRA_SPEEDS`                                                                             | Tests uniquement — **refusé en production**                                 |

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
- **Documents légaux** (`apps/site/content/fr/legal/*.md`, la version française fait foi ; traductions dans
  `content/<langue>/legal/`) : **à faire valider par un professionnel** ; incrémenter `version` dans l'en-tête
  d'un document (et de ses traductions) pour faire réaccepter les CGU, la confidentialité ou les CGV. Les
  informations de l'éditeur (`{{legal.*}}`) se règlent au back-office (**Réglages › Légal**).
- **Données du back-office** (règles, recherche, ORBAT, scénarios, carte) : versionnées en base
  (`data_revisions`) ; une partie garde la version de sa création, sauf modification « parties en cours ».
- **Versions de la carte** (identifiants de province) : `data/map/version.json` donne la version de la carte
  des nouvelles parties ; chaque partie l'épingle à sa création (`games.map_version`, migration
  `0007_map_version`, les parties d'avant valent 1). Les cartes précédentes restent dans
  `data/map/archive/<version>/` (copie exacte des fichiers d'origine : mêmes objets dans le dépôt, aucun
  poids ajouté) ; le serveur recharge une partie ancienne avec sa carte (`?map=<version>` sur `/api/map/*`,
  noms localisés par `/api/map/names/<langue>?map=<version>`), et le client charge la carte de la partie à
  l'accueil. Les modifications de carte du back-office (provinces, zones disputées) valent pour la version
  de carte en vigueur à leur écriture ; une nation modifiée garde la capitale de la carte visée. Changer les
  identifiants : copier l'ancienne carte dans `archive/<version>/`, incrémenter la version et son empreinte
  (`pnpm --filter @redline/tools-map map-version`), sinon `tools/map/test/map.test.ts` échoue. Une archive
  peut être retirée quand plus aucune partie en cours ne l'utilise
  (`SELECT map_version, count(*) FROM games WHERE status <> 'ended' GROUP BY 1`).
- Simulation locale d'un déploiement de zéro : clone frais, installation et build ci-dessus, base vide,
  `migrate.js` puis `main.js` avec les variables de `render.yaml` — vérifié le 30/09/2026 (santé, jeu,
  back-office, tuiles `Range`, photos, glyphes, fond de carte, compression).
