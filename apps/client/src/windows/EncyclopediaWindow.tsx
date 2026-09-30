import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function EncyclopediaWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Encyclopedia" />
    </Window>
  );
}
