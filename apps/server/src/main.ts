import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { loadRealEngine } from './engine.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const { engine, missing } = loadRealEngine();
  const { app } = await buildApp({ config, engine, engineMissing: missing });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'arrêt propre en cours (instantanés, baux)…');
    const force = setTimeout(() => {
      app.log.error('arrêt forcé après 25 s');
      process.exit(1);
    }, 25_000);
    force.unref();
    app
      .close()
      .then(() => {
        app.log.info('arrêt terminé');
        process.exit(0);
      })
      .catch((err) => {
        app.log.error({ err }, "échec de l'arrêt propre");
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'promesse rejetée non gérée'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { instance: config.instanceId, dataDir: config.dataDir, tilesDir: config.tilesDir },
    'Red Line : serveur démarré',
  );
}

main().catch((err) => {
  console.error('Échec du démarrage :', err);
  process.exit(1);
});
