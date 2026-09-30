# CLAUDE.md — Red Line

Jeu de stratégie géopolitique en temps réel sur la vraie carte du monde, dans le navigateur (inspiré de Conflict of Nations). Victoire uniquement militaire.

Cahier des charges : fourni par Amine (PDF « Prompt Claude Code — Red Line »). Proposition d'architecture : `docs/architecture.md`.

## État actuel

- **Phase 0 : proposition d'architecture en attente de validation.** Aucun code n'est écrit.
- Règle de travail : avancer phase par phase et **demander la validation avant chaque nouvelle phase**.

## Décisions proposées (pas encore validées)

- Monorepo pnpm, TypeScript strict. `apps/{client,admin,server}`, `packages/{shared,engine,ui}`, `data/`, `tools/`.
- `packages/engine` est **pur et déterministe** : pas d'E/S, pas de `Date.now`, pas de `Math.random` (PRNG à graine). Temps de jeu en ms.
- Simulation par événements : file de priorité par partie, clé de tri `(time, priority, seq)`, invalidation paresseuse par version d'entité.
- Trajets en segments de grand cercle ; entrée dans les zones circulaires calculée exactement ; croisements mobiles par dichotomie.
- Navigation terre/mer sur une grille H3 (résolution 4) ; le terrain n'affecte jamais le combat.
- Persistance : instantanés compressés + journal d'ordres en ajout seul ; reprise = instantané + rejeu. Bail de partie via un verrou consultatif PostgreSQL.
- L'état interne d'une partie vit dans `GameState`, pas dans des tables SQL.
- Le serveur n'envoie que ce que le joueur a le droit de voir (diffs MessagePack).
- Carte : Blue Marble (domaine public) en PMTiles jusqu'au zoom 8, Natural Earth en vecteur ; provinces et propriétaires servis en GeoJSON dynamique.
- Cibles stratégiques : bâtiments **génériques** par province, jamais de vrais sites nommés. De l'image de référence, on ne reprend que les codes visuels.

## Conventions

- Tous les chiffres d'équilibrage dans `data/` (JSON validé par zod), jamais en dur dans le code.
- Textes de l'interface externalisés (i18next, français d'abord).
- Nom du jeu : **Red Line** (interface, titres de pages, métadonnées).
- Catalogue d'armes : faire valider une catégorie complète (les chasseurs) avant d'étendre aux autres.
