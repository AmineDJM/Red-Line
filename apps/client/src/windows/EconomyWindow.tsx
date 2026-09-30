import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function EconomyWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Economy" />
    </Window>
  );
}
