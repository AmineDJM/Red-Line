# Économie du service : coûts, attribution, gestion du back-office

Demande d'Amine : « tout gérer dans l'espace admin, et connaître même le coût par utilisateur gratuit ».
Écran **Économie du service** (superadmin) : `#/economy/dashboard`, paramètres `#/economy/settings`,
dépenses `#/economy/entries`.

## Ce qui est mesuré (apps/server/src/costs/usage.ts)

| Mesure                                    | Comment                                                                                                                           | Imputée à                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| CPU de simulation                         | temps synchrone de `advance` (événements du moteur) et `applyOrder`                                                               | partie                            |
| CPU de diffusion                          | `flushSlice`, `flushNation`, vue initiale (`viewFor` + `diffViews`)                                                               | partie                            |
| CPU « autre »                             | `createGame`, `serializeState` (instantanés), `deserializeState` + rejeu (chargement), changement d'épingle                       | partie                            |
| CPU du processus                          | `process.cpuUsage` (tout compris : HTTP, ramasse-miettes, compression)                                                            | serveur                           |
| Mémoire résidente estimée                 | `max(min, Mio d'état sérialisé × 9,5) + 1,2 Mo × connexions` (modèle éditable, calé sur docs/charge.md), intégrée en Mo·h         | partie                            |
| RSS réel                                  | `process.memoryUsage.rss()` intégré (Mo·h) et maximum                                                                             | serveur                           |
| Octets WebSocket                          | `bytesWritten` de la socket TCP (après permessage-deflate : octets réellement facturés), relevé toutes les 15 s et à la fermeture | joueur (et partie)                |
| Octets HTTP                               | différence de `bytesWritten` de la socket à chaque réponse (en-têtes compris, connexions persistantes gérées)                     | joueur si connecté, sinon partagé |
| Temps de jeu                              | secondes de connexion d'un joueur (hors spectateur) à une partie chargée                                                          | joueur et partie                  |
| Ordres, notifications push, appels Stripe | compteurs (`createCheckout`, `refund`)                                                                                            | joueur                            |
| Stockage en base                          | à la demande : instantanés (`octet_length`), journal d'ordres, timelapse, messagerie (`pg_column_size`) + `pg_database_size`      | partie                            |
| Dépenses externes                         | saisies dans le back-office, ou mesurées par un service (`ctx.costs.recordExternal({ category: 'video_api', … })`)                | frais généraux                    |

Les mesures s'accumulent en mémoire et sont versées chaque minute dans `usage_stats` (migration
`0004_costs.sql`), deux fois : grain **heure** et grain **jour** (upsert additif, maxima pour les pointes).
Rétention réglable : 14 jours d'agrégats horaires, 400 jours d'agrégats journaliers (purge horaire).

## Méthode d'attribution (packages/shared/src/costs.ts, `computeCostReport`)

1. **Calcul** : prix de l'offre Render × instances, au prorata de la période (mois = 730 h). Part
   `cpuWeight` (50 %) répartie au prorata du **CPU·s** des parties, le reste au prorata de leur **mémoire·h**.
2. **Base** : forfait + stockage provisionné, au prorata des octets stockés par partie.
3. **Partie → joueurs** : coût d'une partie réparti **à parts égales** entre ses joueurs humains (à défaut,
   son créateur ; sinon « non attribué » : parties d'IA, capacité payée sans aucune partie).
4. **Bande passante** : sortie au-delà de l'inclus de l'espace de travail × prix par Go, au prorata des
   octets reçus par chaque joueur ; les octets sans utilisateur (fichiers statiques, tuiles) sont répartis
   au prorata du temps de jeu.
5. **Coûts directs** : frais Stripe (pourcentage + fixe par paiement), push.
6. **Frais généraux** (espace de travail, dépenses saisies : API du studio vidéo, domaine…) : par tête
   d'utilisateur actif.

Deux lectures : **coût complet** (toute la facture est répartie, capacité inoccupée comprise) et **coût
marginal** (seule la capacité réellement consommée, aux prix unitaires de l'offre à pleine charge).
Recettes : achats payés (TTC) − remboursements − TVA − frais Stripe ; marge, ARPU (actifs hors équipe),
ARPPU, conversion (payants de la période / inscrits actifs). Cohortes : gratuit, payant (au moins un achat
payé), invité, équipe (rôle ≠ joueur ou mode illimité, exclue des moyennes commerciales).

Projection du mois : coûts fixes au mois plein, coûts variables au rythme de la période.

Alertes (`costAlerts`) : coût mensuel projeté par joueur gratuit au-dessus du seuil, marge négative, CPU
moyen > 40 % en Starter (> 70 % par cœur ailleurs), RSS > 420 Mo en Starter, boucle p99 > 200 ms, parties
en rattrapage, base > 4 Go, bande passante au-delà de l'inclus. Recommandations : offre supérieure (avec
`--max-old-space-size`), offre inférieure si la charge est durablement faible, `basic-1gb` ou
`SNAPSHOT_INTERVAL_S=120`, limites des joueurs gratuits.

## Prix par défaut (relevés le 1er octobre 2026, éditables)

Render : Starter 7 $ (0,5 CPU, 512 Mo), Standard 25 $ (1 CPU, 2 Go), Pro 85 $ (2 CPU, 4 Go), Pro Plus 175 $
(4 CPU, 8 Go) ; Postgres `basic-256mb` 6 $ + 0,30 $/Go·mois (5 Go provisionnés) ; sortie : 5 Go inclus
(Hobby, 25 Go en Pro), puis 0,15 $/Go ; espace de travail Hobby 0 $ (Pro 25 $). Stripe (cartes EEE) :
1,5 % + 0,25 €. TVA 20 %, 1 € = 1,08 $. **Les prix Render ont changé deux fois fin août 2026 : vérifier
la facture.**

## Estimation du coût d'un joueur gratuit (mesures de docs/charge.md)

Une partie solo monde **continue de tourner** sans son joueur jusqu'à la fin pour abandon (48 h) :

- CPU : 10 parties monde à ×4 ≈ 13 % d'un cœur → ~1,3 % par partie, soit ~9,5 h CPU par mois ;
- mémoire : 15 à 25 Mo de tas par partie (~20 Mo) → ~14,6 Go·h par mois ;
- réseau : 40 à 55 Kio/min connecté (≈ 3 Mo par heure de jeu) + premier chargement (~3 Mo compressés) ;
- base : 3 instantanés × 430 Kio + journal ≈ 1,5 à 2 Mo.

| Profil (offre Starter)                                 | Coût marginal / mois | Coût complet / mois                       |
| ------------------------------------------------------ | -------------------- | ----------------------------------------- |
| Joueur gratuit, une partie solo en cours tout le mois  | ~0,23 $              | ~1,8 $ (Starter + base pleins, 8 parties) |
| Joueur gratuit, une session puis abandon (partie 48 h) | ~0,02 $              | dépend du remplissage du serveur          |
| Bande passante (30 h de jeu)                           | ~0,01 $              | 0 tant que l'inclus suffit                |

Le coût complet baisse avec le remplissage : la facture fixe (~14,5 $/mois Starter + base) est partagée
par tous les joueurs actifs. L'écran Économie donne la valeur réelle dès que les mesures arrivent.

## Inventaire du back-office

Déjà présent : catalogue (fiches, historique, retour arrière, import/export), règles d'équilibrage,
recherche, ORBAT, scénarios, carte (nations, provinces, zones disputées), statut des données, parties en
direct (pause, reprise, IA imposée, événements mondiaux), messagerie (masquage, sourdine), sécurité
(multi-comptes, anomalies), utilisateurs (rôles, bannissement, sourdine, renommage, mode illimité,
empreintes, achats), boutique (packs, promotions, achats, remboursement), journal d'audit, métriques.

Ajouté :

- **Économie du service** : tableau de bord (coûts, projection, recettes, marge, ARPU/ARPPU, conversion,
  coût par type d'utilisateur et de partie, coût par heure de jeu, capacité utilisée, séries, comptes et
  parties les plus coûteux, export CSV), paramètres de coût, dépenses saisies ou mesurées.
- **Fiche utilisateur** : type de compte, coût du mois (complet et marginal), résultats, portefeuille
  (crédit/débit journalisé), suspension temporaire, sessions ouvertes (fermeture), mot de passe
  provisoire (affiché une fois, jamais journalisé), export RGPD (JSON) et suppression RGPD (anonymisation ;
  achats et portefeuille conservés pour la comptabilité ; parties solo supprimées). Recherche par
  identifiant, filtres (payants, invités, bannis, équipe, illimités, supprimés), export CSV.
- **Parties** : voir la carte en spectateur, coût du mois, fin imposée (non classée, avis aux joueurs,
  `endReason: 'admin'`), suppression confirmée ; **archives** des parties terminées (taille, suppression).
- **Annonces globales** : avis WebSocket à tous les connectés, rappelé à chaque connexion pendant la
  validité ; lecture publique `GET /api/announcements` (bannière du client).
- **Paramètres du serveur** : quotas solo/multi, délais d'abandon, veille des IA, déchargement (à chaud,
  conservés en base) ; vitesses et rayon de veille renvoient aux Règles.
- **Journal d'audit** : filtres côté serveur (famille d'action, dates, pagination), export CSV.
- Correctif : le déclencheur d'ajout seul de `wallet_ledger` bloquait la suppression d'une partie où le
  joueur avait acheté des accélérations (`ON DELETE SET NULL`) ; seule la mise à `NULL` de `game_id` est
  désormais permise.

Section Légal : gérée par l'équipe accueil/SEO/pages légales (non dupliquée ici). Langue de
l'utilisateur : à afficher dans la fiche quand la colonne de l'équipe i18n existera.

RBAC : coûts, annonces, paramètres de coût, actions sur les comptes, fin et suppression de partie :
**superadmin** ; lecture des paramètres serveur et des archives : modérateur. Toute action est journalisée
(`admin_audit`) ; les actions destructives exigent une confirmation (nom retapé côté interface, champ
`confirm` vérifié côté serveur).

## Routes

```
GET    /admin/api/costs/dashboard?period=24h|7d|30d|month      superadmin
GET    /admin/api/costs/report?period=…&full=1                 superadmin
GET    /admin/api/costs/users/:id | /games/:id                 superadmin
GET|PUT /admin/api/costs/settings                              superadmin
GET|POST /admin/api/costs/entries, DELETE /…/:id               superadmin
GET    /api/announcements                                      public
GET|POST /admin/api/announcements, PUT|DELETE /…/:id           superadmin
GET    /admin/api/server/settings (moderator), PUT (superadmin)
GET    /admin/api/users?q=&filter=                             superadmin
GET    /admin/api/users/:id/overview | /export                 superadmin
POST   /admin/api/users/:id/suspend | /sessions/revoke | /password-reset | /wallet
DELETE /admin/api/users/:id {confirm}                          superadmin
GET    /admin/api/games/archive                                moderator
POST   /admin/api/games/:id/end, DELETE /admin/api/games/:id {confirm}   superadmin
GET    /admin/api/audit?action=&target=&adminId=&from=&to=&before=&limit=
```
