/**
 * Produit les fichiers sources français dérivés (à relancer avant `translate`) :
 *  - apps/client/src/i18n/fr.news.json : gabarits de dépêches du moteur (diplo/news.ts), convertis
 *    en variables i18next (`{le:A}` → `{{A}}`, `{de:A}` → `de {{A}}`…). Le client français affiche
 *    toujours le texte du moteur ; ces gabarits ne servent qu'aux autres langues.
 *  - apps/client/src/i18n/fr.data.json : textes de data/ (recherche, fiches techniques, noms des
 *    systèmes génériques, unités, scénarios), indexés par `k` + `textKey(texte)`.
 *  - apps/client/src/i18n/fr.nations.json : descriptions et doctrines des nations (data/orbat).
 *
 *   pnpm --filter @redline/tools-i18n extract           # écrit les fichiers
 *   pnpm --filter @redline/tools-i18n extract -- --check  # échoue s'ils ne sont pas à jour
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { textKey } from '@redline/shared';
import { TEMPLATES } from '../../../packages/engine/src/modules/diplo/news.js';
import { CLIENT_I18N, REPO } from './config.js';

/** Gabarit du moteur → texte i18next neutre (le sens suffit au traducteur). */
export function convertTemplate(tpl: string): string {
  return tpl.replace(
    /\{(?:(le|Le|de|a):([AB])|s:[AB]:([^|}]*)\|[^}]*|([ABPXY]))\}/g,
    (_m, form?: string, nat?: string, sg?: string, plain?: string) => {
      if (sg !== undefined) return sg;
      if (plain) return `{{${plain}}}`;
      return form === 'de' ? `de {{${nat}}}` : form === 'a' ? `à {{${nat}}}` : `{{${nat}}}`;
    },
  );
}

export function newsSource(): Record<string, Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [kind, t] of Object.entries(TEMPLATES)) {
    const e: Record<string, string> = {};
    t.h.forEach((h, i) => (e[`h${i}`] = convertTemplate(h)));
    t.b.forEach((b, i) => (e[`b${i}`] = convertTemplate(b)));
    out[kind] = e;
  }
  return { news: out };
}

const readJson = (f: string): unknown => JSON.parse(readFileSync(f, 'utf8'));
const jsonFiles = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(dir, f))
    : [];

export function dataSource(): Record<string, Record<string, string>> {
  const groups: Record<string, Record<string, string>> = {
    research: {},
    system: {},
    sheet: {},
    unit: {},
    scenario: {},
  };
  const add = (g: string, s: string | null | undefined) => {
    if (s && s.trim()) groups[g]![`k${textKey(s)}`] = s;
  };
  for (const f of jsonFiles(join(REPO, 'data/research'))) {
    for (const n of (readJson(f) as { nodes: { name: string; description?: string }[] }).nodes) {
      add('research', n.name);
      add('research', n.description);
    }
  }
  for (const f of jsonFiles(join(REPO, 'data/catalog'))) {
    const systems = (readJson(f) as { systems: Record<string, unknown>[] }).systems;
    for (const s of systems) {
      if (s.generic) add('system', s.name as string);
      const sheet = s.sheet as { engine?: string | null; speedLabel?: string | null } | undefined;
      add('sheet', sheet?.engine);
      add('sheet', sheet?.speedLabel);
      add('unit', s.unitLabel as string | undefined);
    }
  }
  for (const f of jsonFiles(join(REPO, 'data/scenarios'))) {
    const s = readJson(f) as { name?: string; description?: string };
    add('scenario', s.name);
    add('scenario', s.description);
  }
  return sortGroups(groups);
}

export function nationsSource(): Record<string, Record<string, string>> {
  const groups: Record<string, Record<string, string>> = { text: {} };
  const dir = join(REPO, 'data/orbat');
  for (const set of existsSync(dir) ? readdirSync(dir).sort() : []) {
    for (const f of jsonFiles(join(dir, set))) {
      const o = readJson(f) as { description?: string; doctrineText?: string };
      for (const s of [o.description, o.doctrineText])
        if (s && s.trim()) groups.text![`k${textKey(s)}`] = s;
    }
  }
  return sortGroups(groups);
}

/** Groupes non vides, dans l'ordre des fichiers (un nom suivi de sa description : contexte utile). */
function sortGroups(g: Record<string, Record<string, string>>) {
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(g)) {
    if (Object.keys(v).length) out[k] = v;
  }
  return out;
}

export const OUTPUTS: [string, () => unknown][] = [
  [join(CLIENT_I18N, 'fr.news.json'), newsSource],
  [join(CLIENT_I18N, 'fr.data.json'), dataSource],
  [join(CLIENT_I18N, 'fr.nations.json'), nationsSource],
];

if (process.argv[1]?.endsWith('extract.ts')) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [file, fn] of OUTPUTS) {
    const text = `${JSON.stringify(fn(), null, 2)}\n`;
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (cur === text) continue;
    if (check) {
      console.error(`à régénérer : ${file}`);
      stale++;
    } else {
      writeFileSync(file, text);
      console.log(`écrit : ${file}`);
    }
  }
  if (stale) process.exitCode = 1;
}
