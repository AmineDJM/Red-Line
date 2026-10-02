import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Icon, Kbd, Panel, Toggle, Window } from '@redline/ui';
import { AudioSettingsPanel } from '../audio/AudioSettingsPanel.js';
import { STORAGE } from '../config.js';
import {
  disableNotifications,
  enableNotifications,
  notificationsEnabled,
  notificationsSupported,
} from '../lib/push.js';
import { useMapPrefs } from '../map/prefs.js';
import { navigate } from '../router.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';

/** Réglages : affichage, notifications navigateur, tutoriel, raccourcis, mentions légales. */
export function SettingsWindow({ frame }: WindowContentProps) {
  const { t } = useTranslation();
  const legendOpen = useUi((s) => s.legendOpen);
  const setLegendOpen = useUi((s) => s.setLegendOpen);
  const reduceMotion = useMapPrefs((s) => s.reduceMotion);
  const setReduceMotion = useMapPrefs((s) => s.setReduceMotion);
  const setTutorialStep = useUi((s) => s.setTutorialStep);
  const closeWindow = useUi((s) => s.closeWindow);
  const toast = useUi((s) => s.toast);
  const meta = useGame((s) => s.meta);
  const [notif, setNotif] = useState(notificationsEnabled());
  const shortcuts: [string[], string][] = [
    [['Ctrl', 'K'], t('shortcuts.console')],
    [[t('keys.space')], t('shortcuts.pause')],
    [['1', '…', '5'], t('shortcuts.speed')],
    [['A', 'P', 'R', 'E', 'I', 'D', 'C', 'N', 'B', 'Y', 'M'], t('shortcuts.windows')],
    [['Échap'], t('shortcuts.escape')],
    [['?'], t('shortcuts.help')],
  ];
  return (
    <Window {...frame} path={[t('sections.path.settings')]}>
      <div className="vstack">
        <Panel title={t('settings.display')}>
          <div className="stack">
            <Toggle
              checked={legendOpen}
              onChange={setLegendOpen}
              label={t('settings.legend')}
              description={t('settings.legendHelp')}
            />
            <Toggle
              checked={reduceMotion}
              onChange={setReduceMotion}
              label={t('map.settings.reduceMotion')}
              description={t('map.settings.reduceMotionHelp')}
            />
          </div>
        </Panel>
        <AudioSettingsPanel />
        <Panel title={t('settings.notifications')}>
          <div className="stack">
            <Toggle
              checked={notif}
              disabled={!notificationsSupported()}
              onChange={async (on) => {
                if (on) {
                  const r = await enableNotifications();
                  setNotif(r === 'push' || r === 'local');
                  toast(
                    t(`settings.notif.${r}`),
                    r === 'denied' || r === 'unsupported' ? 'error' : 'ok',
                  );
                } else {
                  await disableNotifications();
                  setNotif(false);
                }
              }}
              label={t('settings.browserNotifications')}
              description={
                notificationsSupported() ? t('settings.notifHelp') : t('settings.notif.unsupported')
              }
            />
          </div>
        </Panel>
        <Panel title={t('settings.help')}>
          <div className="stack">
            <Button
              icon={<Icon name="help" size={14} />}
              onClick={() => {
                try {
                  localStorage.removeItem(STORAGE.tutorialDone);
                } catch {
                  /* stockage indisponible */
                }
                closeWindow('settings');
                setTutorialStep(0);
              }}
            >
              {t('settings.restartTutorial')}
            </Button>
            <dl className="kbdlist">
              {shortcuts.map(([keys, label], i) => (
                <div key={i}>
                  <dt>
                    {keys.map((k, j) => (
                      <Kbd key={j}>{k}</Kbd>
                    ))}
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>
        <Panel title={t('settings.game')}>
          <div className="row">
            <span className="muted small grow">
              {meta?.name} · {meta?.id}
            </span>
            <Button variant="subtle" onClick={() => navigate('/legal/cgu')}>
              {t('legal.title')}
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="logout" size={13} />}
              onClick={() => navigate('/')}
            >
              {t('game.exit')}
            </Button>
          </div>
        </Panel>
      </div>
    </Window>
  );
}
