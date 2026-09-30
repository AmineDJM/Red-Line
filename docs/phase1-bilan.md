# Bilan de la phase 1 — Socle

**Critère de fin : conquérir une province ennemie sur mobile et sur ordinateur — atteint.**
Le test Playwright `e2e/conquest.spec.ts` joue le parcours réel contre le vrai serveur et une vraie base :
accueil → compte invité → nouvelle partie (France) → sélection des fantassins sur la carte → ordre de déplacement
vers Bruxelles → confirmation → capture de Bruxelles-Capitale. Il passe en 1440×900 et en 390×844 (tactile).

## Ce qui marche

**Carte et rendu** (style de l'image de référence)

- Imagerie NASA Blue Marble assombrie (zoom 0 à 8), fond vectoriel sombre au-delà, frontières fines.
- 201 nations et 2 567 provinces (Natural Earth) ; Gaza, Autorité palestinienne et Israël distincts ; 15 détroits.
- Territoire du joueur en violet lumineux avec halo, autres nations dans leur teinte, brouillard hachuré.
- Icônes hexagonales, étiquettes cartouches à filets coudés sans chevauchement (32 au plus), arcs de portée orange,
  trajectoires avec flèche et distance, triangle de lancement numéroté, fiche d'arme, légende, bandeau titre.

**Moteur** (`packages/engine`, pur et déterministe)

- File d'événements datés, interceptions exactes sur la sphère (un convoi peut être détruit en route).
- Navigation terre/mer sur grille H3 avec embarquement automatique, détroits, zones infranchissables.
- Combat par rounds, matrice de dégâts et contre-mesures, brouillage, vétérance, capture, économie, production.
- Brouillard de guerre (détectée / identifiée / précise, vieillissement des contacts), IA à règles sans triche.
- Sérialisation et rejeu au bit près (même graine + mêmes ordres ⇒ même empreinte).

**Serveur** (`apps/server`)

- Comptes (invité, inscription, connexion ; argon2, cookie httpOnly), rôles.
- Parties solo, vitesse ×1 à ×16 et pause, un seul ordonnanceur pour toutes les parties.
- WebSocket MessagePack : le joueur ne reçoit que ce qu'il a le droit de voir (diffs).
- Instantanés + journal d'ordres, reprise après redémarrage, bail de partie pour les déploiements.

**Back-office** (`/admin/`) : catalogue par doctrine, édition complète d'une fiche avec validation en direct,
historique et retour arrière, import/export JSON, parties en direct, métriques.

**Arsenal** : 27 chasseurs (catégorie complète, **à valider**, voir `docs/catalog-fighters.md`) + 30 unités de phase 1.

## Comment tester

```bash
pnpm install
pnpm --filter @redline/server db:dev     # PostgreSQL local jetable (port 54329)
pnpm build
pnpm start                                # http://localhost:3000 — jeu à /, back-office à /admin/
```

- Jeu : « Jouer en invité » → choisir une nation → sélectionner une unité → toucher la carte → Confirmer.
- Raccourcis (ordinateur) : Espace = pause, 1 à 4 = vitesses, Échap = désélection, Entrée = confirmer.
- Bac à sable : `/sandbox` (moteur dans le navigateur, placement libre d'unités de toutes nations).
- Back-office : définir `ADMIN_EMAIL` et `ADMIN_PASSWORD` avant `pnpm start`, puis `/admin/`.
- Tests : `pnpm test` (203 tests unitaires), `pnpm e2e` (bout en bout, mobile + ordinateur).

## Ce qui reste (phases suivantes)

- **À valider par toi** : la catégorie chasseurs et la liste complémentaire proposée (≈ 241 systèmes au total).
- Armée de départ par doctrine (aujourd'hui la même liste pour toutes les nations).
- Avions : carburant et retour à la base (ils restent sur place à destination).
- Hachures des territoires disputés (la donnée n'est pas encore transmise à la carte).
- Reprendre une partie depuis l'accueil (l'API existe, pas encore l'écran).
- 60 i/s sur un vrai mobile milieu de gamme : à mesurer sur appareil réel.
- Phase 2 : catalogue complet, licences, ressources stratégiques, logistique, recherche.

## Déploiement

Voir `docs/deploiement.md`.
