import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function NewsWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="News" />
    </Window>
  );
}
