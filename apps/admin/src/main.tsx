import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import { App } from './App';
import { fetchTransport, type Transport } from './api/client';
import type { Role } from '@redline/shared';

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const mock = params.get('mock') === '1';
  let transport: Transport = fetchTransport;
  if (mock) {
    const { createMockTransport } = await import('./api/mock');
    transport = createMockTransport({ role: (params.get('role') as Role | null) ?? undefined });
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App transport={transport} mock={mock} />
    </StrictMode>,
  );
}
void boot();
