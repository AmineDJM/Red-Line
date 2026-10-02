import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@redline/ui/fonts.css';
import '@redline/ui/tokens.css';
import '@redline/ui/styles.css';
import './styles/app.css';
import './styles/windows.css';
import './styles/w-research.css';
import './styles/w-economy.css';
import './styles/w-army.css';
import './styles/w-world.css';
import './styles/w-battles.css';
import './styles/pages.css';
import './i18n/index.js';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
