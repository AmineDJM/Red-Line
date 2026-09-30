import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function ProductionWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Production" />
    </Window>
  );
}
