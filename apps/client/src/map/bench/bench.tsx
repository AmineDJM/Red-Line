/**
 * Banc d'essai de la carte seule (développement uniquement, jamais dans le build : non référencé
 * par index.html) : /src/map/bench/bench.html?mock=1 avec le serveur Vite en mode données locales.
 * Monte la carte de jeu sur la partie simulée, sans le reste de l'interface, pour mesurer le coût
 * propre du rendu (window.__rlMap.stats(), .demo({ extra })).
 */
import { createRoot } from 'react-dom/client';
import '@redline/ui/fonts.css';
import '../../i18n/index.js';
import { getApi } from '../../api/index.js';
import { bindConnection, useGame } from '../../store/game.js';
import { useUi } from '../../store/ui.js';
import { useWorld } from '../../store/world.js';
import { MapView } from '../MapView.js';

async function start() {
  (window as unknown as { __rl?: unknown }).__rl = { game: useGame, ui: useUi, world: useWorld };
  const api = await getApi();
  await useWorld.getState().load(api);
  const [{ MockGameConnection }, { loadFixtures }] = await Promise.all([
    import('../../net/mock.js'),
    import('../../api/mock.js'),
  ]);
  const f = await loadFixtures();
  const { me } = await api.game('demo');
  bindConnection(
    new MockGameConnection(
      { nations: f.nations, provinces: f.provinces, catalog: f.catalog, geo: f.geo },
      { me },
    ),
  );
  createRoot(document.getElementById('root')!).render(<MapView mode="game" fog />);
}

void start();
