import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function IntelWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Intel" />
    </Window>
  );
}
