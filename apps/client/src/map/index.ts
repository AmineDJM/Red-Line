/**
 * API publique de la carte (équipe ui-map) pour le reste de l'interface.
 *
 * ——— Carte de jeu ———
 * `<MapView mode fog insets onReady />` monte la carte (MapLibre) ; `onReady(gm)` ou
 * `getActiveGameMap()` donnent le contrôleur `GameMap` :
 *   - `gm.setLayerGroup(group, visible)` : groupes de calques (`MapLayerGroup` : units, orders,
 *     ranges, cities, buildings, labels, fog, intel, radar, satellites) ;
 *   - `gm.focusUnit(id, zoom?)` : centre la carte sur une unité ;
 *   - `gm.selectInRect(x0, y0, x1, y1, add?)` : sélection par rectangle (px écran de la carte) ;
 *   - `gm.setAnimations(on)` : coupe/relance les animations (auto si prefers-reduced-motion ou
 *     réglage « réduire les animations », store `useMapPrefs`) ;
 *   - `gm.fitUnits(ids)` : cadre la carte sur des unités ; `gm.project(lngLat)` : position écran ;
 *   - `gm.stats()` / `gm.resetStats()` : mesures de performance ;
 *   - `gm.map` : l'instance MapLibre (utilisée par les tests de bout en bout).
 * La visibilité des calques est aussi pilotable sans référence à la carte via le store
 * `useMapLayers` (persisté localement) : un panneau « Calques » n'a qu'à l'utiliser.
 *
 * Gestes gérés par la carte : clic/tap sur un pion (sélection, Maj/Ctrl pour ajouter), sur une
 * pile de plusieurs unités (menu de pile `useStackMenu` : choix précis, filtres terre/air/mer/DCA,
 * affiché par shell/StackMenu.tsx), sur un marqueur de bataille (panneau de détail, `useMapSel`),
 * clic sur la carte avec une sélection (aperçu d'ordre de déplacement), sur une unité étrangère
 * avec une sélection (aperçu d'attaque), Maj + glisser (sélection par rectangle), survol (infobulle,
 * contour de province) et appui long sur mobile (infobulle).
 *
 * Combats : marqueurs de bataille (rapports en cours, accrochages), effets (traceurs, obus,
 * explosions, interceptions) sur un canevas dédié, d'après `BattleReportSummary.live`, les missiles
 * disparus et les notifications de destruction. Événements exposés (son) : `onMapEvent` (events.ts).
 * Les panneaux marqués `data-map-avoid` sont évités par les étiquettes de la surcouche.
 *
 * ——— Mini-carte ———
 * `new MiniMap(canvas, { center, radiusKm, owners?, me?, layers? })` ou `<MiniMapView … />` :
 * rendu Canvas 2D léger (sans WebGL) pour rapports, replays et timelapse ; `update(patch)`
 * redessine (ex. `owners` à chaque image d'un timelapse), `toDataURL()` exporte.
 *
 * ——— Couleurs et pictogrammes ———
 * `C` (jetons), `REL_COLOR`, `relationOf(owner, me, nations)` : mêmes codes que la carte
 * (vert : ses forces, violet : alliés, gris : neutres, rouge : en guerre).
 * `drawPion(spec)` / `drawBuilding(type, rel, state, level)` : sprites de la carte (canvas),
 * réutilisables pour des vignettes cohérentes avec la carte.
 */
export { MapView, getActiveGameMap, type MapViewProps } from './MapView.js';
export type { GameMap, GameMapOptions, MapMode, MapStats } from './GameMap.js';
export { useMapLayers, MAP_LAYER_GROUPS, type MapLayersStore } from './layers.js';
export { LAYER_GROUPS, HIDDEN_BY_DEFAULT, type MapLayerGroup } from './style.js';
export {
  MiniMap,
  miniProjection,
  type MiniMapLayer,
  type MiniMapOptions,
  type MiniMapShape,
} from './MiniMap.js';
export { MiniMapView, type MiniMapViewProps } from './MiniMapView.js';
export { C as MAP_COLORS, REL_COLOR, relationOf, type Rel } from './palette.js';
export { drawPion, drawBuilding, pionKey, type PionSpec, type BuildingState } from './pions.js';
export { glyphFor, drawGlyph, GLYPHS, type GlyphId } from './glyphs.js';
export { unitPosition, isMoving, unitHeading } from './interpolation.js';
export { nationColor, VIOLET_UNIT } from './features.js';
export { onMapEvent, type MapEvent } from './events.js';
export { useMapPrefs } from './prefs.js';
export { useStackMenu } from './stackMenu.js';
export { useMapSel } from './mapSel.js';
