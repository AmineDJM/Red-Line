import { useTranslation } from 'react-i18next';
import { Window } from '@redline/ui';
import { ArsenalBrowser } from '../components/ArsenalBrowser.js';
import type { WindowContentProps } from '../shell/WindowHost.js';

/** Encyclopédie de l'arsenal : toutes les fiches, avec photos, crédits et caractéristiques. */
export function EncyclopediaWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  return (
    <Window {...frame} path={[t('sections.path.encyclopedia')]} flush>
      <ArsenalBrowser mode="encyclopedia" mobile={mobile} initialSystemId={win.params.systemId} />
    </Window>
  );
}
