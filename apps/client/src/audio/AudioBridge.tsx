import { useEffect } from 'react';
import { startAudio } from './bridge.js';

/** Point d'entrée du son dans la coque de jeu (aucun rendu). */
export function AudioBridge() {
  useEffect(() => startAudio(), []);
  return null;
}
