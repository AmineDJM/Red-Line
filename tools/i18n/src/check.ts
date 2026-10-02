/**
 * Contrôle des fichiers de langue sans appel réseau : clés manquantes, variables, longueur.
 *
 *   pnpm --filter @redline/tools-i18n check                  # résumé par domaine et langue
 *   pnpm --filter @redline/tools-i18n check -- --dump client # source française à plat (relecture)
 *   pnpm --filter @redline/tools-i18n check -- --todo client --lang en  # clés restant à traduire
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Locale } from '@redline/shared';
import { DOMAINS, TARGETS, stateFile } from './config.js';
import { checkUnit, flatten, merge, toUnits, unitHash, unitKeys, type Tree } from './units.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const readJson = <T>(f: string, fb: T): T =>
  existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : fb;

export function sourceUnits(domainId: string) {
  const d = DOMAINS.find((x) => x.id === domainId)!;
  let tree: Tree = {};
  for (const f of d.sources) if (existsSync(f)) tree = merge(tree, readJson<Tree>(f, {}));
  return { d, units: toUnits(flatten(tree)) };
}

/** Unités dont la traduction manque, est périmée (source modifiée) ou invalide. */
export function pending(domainId: string, lang: Locale) {
  const { d, units } = sourceUnits(domainId);
  const flat = flatten(readJson<Tree>(d.out(lang), {}));
  const state = readJson<Record<string, string>>(stateFile(d.id, lang), {});
  return units.filter(
    (u) =>
      state[u.id] !== unitHash(u) ||
      unitKeys(u, lang).some((k) => flat[k] === undefined) ||
      checkUnit(u, flat, lang).length > 0,
  );
}

if (process.argv[1]?.endsWith('check.ts')) {
  const dump = opt('dump');
  const todo = opt('todo');
  if (dump || todo) {
    const domain = (dump ?? todo)!;
    const units = todo
      ? pending(domain, (opt('lang') ?? 'en') as Locale)
      : sourceUnits(domain).units;
    for (const u of units) {
      if (u.kind === 'text') console.log(`${u.id}\t${JSON.stringify(u.text)}`);
      else
        for (const [c, v] of Object.entries(u.forms))
          console.log(`${u.id}_${c}\t${JSON.stringify(v)}`);
    }
  } else {
    let bad = 0;
    for (const d of DOMAINS) {
      const { units } = sourceUnits(d.id);
      if (!units.length) continue;
      const row: string[] = [];
      for (const l of TARGETS) {
        const n = pending(d.id, l).length;
        bad += n;
        row.push(`${l}:${units.length - n}/${units.length}`);
      }
      console.log(`${d.id.padEnd(8)} ${row.join(' ')}`);
    }
    if (bad) process.exitCode = 1;
  }
}
