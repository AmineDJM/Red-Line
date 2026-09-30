import { EmptyState, Window } from '@redline/ui';
import type { WindowContentProps } from '../shell/WindowHost.js';

export function ChatWindow({ frame }: WindowContentProps) {
  return (
    <Window {...frame}>
      <EmptyState title="Chat" />
    </Window>
  );
}
