import { useTranslation } from 'react-i18next';
import { Window } from '@redline/ui';
import { ShopContent } from '../components/ShopContent.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';

export function ShopWindow({ frame }: WindowContentProps) {
  const { t } = useTranslation();
  const meta = useGame((s) => s.meta);
  return (
    <Window {...frame} path={[t('sections.path.shop')]}>
      <ShopContent policy={meta?.shopPolicy} />
    </Window>
  );
}
