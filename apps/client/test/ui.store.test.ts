import { beforeEach, describe, expect, it } from 'vitest';
import { WINDOW_IDS, topWindow, useUi } from '../src/store/ui.js';

const ui = () => useUi.getState();

describe('store ui : une seule fenêtre principale', () => {
  beforeEach(() => {
    ui().closeAllWindows();
    ui().closeSheet();
  });

  it('ouvrir une fenêtre remplace la précédente', () => {
    ui().openWindow('armies');
    expect(ui().windows.map((w) => w.id)).toEqual(['armies']);
    ui().openWindow('production');
    expect(ui().windows.map((w) => w.id)).toEqual(['production']);
    ui().openWindow('research');
    expect(ui().windows).toHaveLength(1);
    expect(topWindow(ui().windows)?.id).toBe('research');
  });

  it('ancienne encyclopédie : ouvre le catalogue de l’Arsenal de guerre', () => {
    expect(WINDOW_IDS).not.toContain('encyclopedia');
    ui().openWindow('encyclopedia', { systemId: 'eu.rafale' });
    expect(ui().windows).toHaveLength(1);
    expect(ui().windows[0]).toMatchObject({
      id: 'army',
      params: { tab: 'catalog', systemId: 'eu.rafale' },
    });
  });

  it('rouvrir la même fenêtre garde son état et met à jour ses paramètres', () => {
    ui().openWindow('armies');
    const seq0 = ui().windows[0]!.seq;
    ui().openWindow('armies', { tab: 'operations' });
    expect(ui().windows).toHaveLength(1);
    expect(ui().windows[0]!.params.tab).toBe('operations');
    expect(ui().windows[0]!.seq).toBeGreaterThan(seq0);
  });

  it('bascule : la touche de la fenêtre ouverte la ferme, une autre la remplace', () => {
    ui().toggleWindow('army');
    expect(ui().windows.map((w) => w.id)).toEqual(['army']);
    ui().toggleWindow('intel');
    expect(ui().windows.map((w) => w.id)).toEqual(['intel']);
    ui().toggleWindow('intel');
    expect(ui().windows).toHaveLength(0);
  });

  it('position et agrandissement retenus par fenêtre', () => {
    ui().openWindow('research');
    ui().setWindowRect('research', { x: 200, y: 120, w: 700, h: 500 });
    ui().toggleMaximize('research');
    ui().openWindow('economy');
    ui().openWindow('research');
    const w = ui().windows[0]!;
    expect(w.rect).toEqual({ x: 200, y: 120, w: 700, h: 500 });
    expect(w.maximized).toBe(true);
  });

  it('la fiche seule se superpose sans fermer la fenêtre ni ouvrir l’encyclopédie', () => {
    ui().openWindow('armies');
    ui().openSheet('eu.rafale', 'u12');
    expect(ui().sheet).toEqual({ systemId: 'eu.rafale', unitId: 'u12' });
    expect(ui().windows.map((w) => w.id)).toEqual(['armies']);
    ui().closeSheet();
    expect(ui().sheet).toBeNull();
    expect(ui().windows.map((w) => w.id)).toEqual(['armies']);
  });

  it('ouvrir une autre fenêtre ferme la fiche', () => {
    ui().openSheet('eu.rafale');
    ui().openWindow('production');
    expect(ui().sheet).toBeNull();
  });

  it('ancien tiroir « army » : redirigé vers Mes armées', () => {
    ui().openDrawer('army');
    expect(ui().windows.map((w) => w.id)).toEqual(['armies']);
  });
});
