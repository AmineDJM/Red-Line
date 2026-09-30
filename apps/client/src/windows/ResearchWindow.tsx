import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function ResearchWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Research" />
    </Window>
  );
}
