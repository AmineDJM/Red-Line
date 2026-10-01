import { useTranslation } from 'react-i18next';
import { Panel, Slider, Toggle } from '@redline/ui';
import { playSfx } from './bridge.js';
import { useAudioSettings, type AudioSettings } from './settings.js';

type Level = 'master' | 'music' | 'sfx' | 'ui';
const LEVELS: Level[] = ['master', 'music', 'sfx', 'ui'];

/** Réglages du son (fenêtre Réglages) : volumes par bus, muet, sons réduits. */
export function AudioSettingsPanel() {
  const { t } = useTranslation();
  const s = useAudioSettings();
  const change = (k: Level, v: number) => s.set({ [k]: v / 100 } as Partial<AudioSettings>);
  // Aperçu discret au relâchement du curseur (effets et interface).
  const preview = (k: Level) => {
    if (k === 'sfx') playSfx('production-complete');
    else if (k === 'ui' || k === 'master') playSfx('select');
  };
  return (
    <Panel title={t('audio.title')}>
      <div className="stack">
        <Toggle
          checked={s.muted}
          onChange={(v) => s.set({ muted: v })}
          label={t('audio.mute')}
          description={t('audio.muteHelp')}
        />
        {LEVELS.map((k) => (
          <div
            key={k}
            className="rl-field"
            onPointerUp={() => preview(k)}
            onKeyUp={() => preview(k)}
          >
            <span className="rl-field__label">{t(`audio.levels.${k}`)}</span>
            <Slider
              value={Math.round(s[k] * 100)}
              min={0}
              max={100}
              step={5}
              label={t(`audio.levels.${k}`)}
              format={(v) => `${v} %`}
              disabled={s.muted}
              onChange={(v) => change(k, v)}
            />
          </div>
        ))}
        <Toggle
          checked={s.reduced}
          onChange={(v) => s.set({ reduced: v })}
          label={t('audio.reduced')}
          description={t('audio.reducedHelp')}
        />
        <span className="muted small">{t('audio.credits')}</span>
      </div>
    </Panel>
  );
}
