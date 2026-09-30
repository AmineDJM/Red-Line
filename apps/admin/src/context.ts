import { createContext, useContext } from 'react';
import type { PublicUser } from '@redline/shared';
import type { Api } from './api/client';

export interface Session {
  api: Api;
  user: PublicUser;
  mock: boolean;
}
export const SessionCtx = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('Session absente');
  return s;
}
