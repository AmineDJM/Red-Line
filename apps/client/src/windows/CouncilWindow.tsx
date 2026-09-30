import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function CouncilWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Council" />
    </Window>
  );
}
