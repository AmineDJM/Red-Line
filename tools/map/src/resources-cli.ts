/**
 * Ressources des provinces et rendements cohérents — à lancer après build.ts et cities.mjs :
 *   pnpm --filter @redline/tools-map resources
 * Lit et réécrit data/map/provinces.json (champ `resources`, `income` réparti). Idempotent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';
import { ProvinceDefSchema, type ProvinceDef } from '@redline/shared';
import { RESOURCE_ZONES } from './resources-data.js';
import { assignResources, reshapeIncome, resolveRef } from './resources.js';
import { REPO_DIR } from './sources.js';

const FILE = join(REPO_DIR, 'data', 'map', 'provinces.json');
const provs = JSON.parse(readFileSync(FILE, 'utf8')) as ProvinceDef[];

const missing: string[] = [];
for (const z of RESOURCE_ZONES)
  for (const ref of z.provinces ?? [])
    if (resolveRef(ref, provs).length === 0) missing.push(`${z.id} → ${ref}`);
if (missing.length > 0) throw new Error(`provinces introuvables :\n  ${missing.join('\n  ')}`);

const deposits = assignResources(provs);
const incomes = reshapeIncome(provs, deposits);
// Ordre des clés conservé (diff minimal) ; validation zod de chaque province.
const out: ProvinceDef[] = provs.map((p) => ({
  ...p,
  income: incomes.get(p.id)!,
  resources: deposits.get(p.id)!.map((d) => ({ ...d })),
}));
for (const p of out) ProvinceDefSchema.parse(p);
// Même présentation que cities.mjs + Prettier (objets dépliés) : diff minimal dans git.
const raw = JSON.stringify(out, null, 1).replace(
  /\{\s*("type": "\w+"),\s*("richness": \d),\s*("source": "\w+")\s*\}/g,
  '{ $1, $2, $3 }',
);
const text = await prettier.format(raw, {
  ...(await prettier.resolveConfig(FILE)),
  parser: 'json',
});
writeFileSync(FILE, text);

const count = (f: (p: ProvinceDef) => boolean) => out.filter(f).length;
console.log(`provinces ${out.length}`);
console.log(`  argent seulement : ${count((p) => p.resources!.length === 0)}`);
console.log(`  données sourcées : ${count((p) => p.resources!.some((d) => d.source === 'data'))}`);
for (const r of ['oil', 'metals', 'electronics', 'food'] as const)
  console.log(
    `  ${r.padEnd(12)} principale ${count((p) => p.resources![0]?.type === r)}, total ${count((p) => p.resources!.some((d) => d.type === r))}`,
  );
