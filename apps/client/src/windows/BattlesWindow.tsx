import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function BattlesWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Battles" />
    </Window>
  );
}
