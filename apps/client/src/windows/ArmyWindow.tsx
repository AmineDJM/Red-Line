import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function ArmyWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Army" />
    </Window>
  );
}
