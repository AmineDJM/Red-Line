/**
 * Traduction incrémentale des fichiers sources français vers toutes les langues cibles.
 *
 *   pnpm --filter @redline/tools-i18n translate                  # tout ce qui a changé
 *   pnpm --filter @redline/tools-i18n translate -- --lang en,ar  # langues choisies
 *   pnpm --filter @redline/tools-i18n translate -- --domain client --dry
 *
 * Mode strict : une clé n'est retraduite que si elle est nouvelle, si sa source française a changé
 * (empreinte dans tools/i18n/state) ou si la traduction en place échoue aux contrôles. Les clés
 * disparues de la source sont retirées. Lancer `extract` d'abord si le moteur ou data/ ont changé.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { LOCALE_TAGS, type Locale } from '@redline/shared';
import { DOMAINS, LANG_LABEL, REPO, TARGETS, TOOL_DIR, stateFile, type Domain } from './config.js';
import { chatJson, cost, fatalError, usage } from './llm.js';
import {
  checkPlural,
  checkText,
  flatten,
  merge,
  pluralCats,
  toUnits,
  unflatten,
  unitHash,
  unitKeys,
  type Tree,
  type Unit,
} from './units.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes('--dry');
const langs = (opt('lang')?.split(',') as Locale[] | undefined) ?? TARGETS;
const domains = opt('domain')
  ? DOMAINS.filter((d) => opt('domain')!.split(',').includes(d.id))
  : DOMAINS;
const CONCURRENCY = Number(opt('concurrency') ?? 8);
/**
 * `--import <dossier>` : traductions fournies hors modèle (relecture humaine, autre outil), lues dans
 * `<dossier>/<domaine>/<langue>*.json` (clés à plat ou arbre). Mêmes contrôles, même état
 * incrémental ; aucun appel réseau.
 */
const IMPORT = opt('import');

function importedFor(d: Domain, lang: Locale): Record<string, string> | null {
  if (!IMPORT) return null;
  const dir = join(IMPORT, d.id);
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  // Format compact : `index.tsv` (n° → clé) et `<langue>*.tsv` (« n°[:catégorie] \t "texte" ») ;
  // la catégorie plurielle remplace le suffixe de la clé (`x_other` + `:few` → `x_few`).
  const indexFile = join(dir, 'index.tsv');
  const index = new Map<string, string>();
  if (existsSync(indexFile))
    for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
      const [n, key] = line.split('\t');
      if (n && key) index.set(n, key);
    }
  for (const f of readdirSync(dir).sort()) {
    const mine = f === `${lang}.json` || f === `${lang}.tsv` || f.startsWith(`${lang}.`);
    if (!mine) continue;
    if (f.endsWith('.json')) Object.assign(out, flatten(readJson<Tree>(join(dir, f), {})));
    else if (f.endsWith('.tsv'))
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        const m = /^(\d+)(?::(zero|one|two|few|many|other))?\t(.*)$/.exec(line.trimEnd());
        if (!m) continue;
        const key = index.get(m[1]!);
        if (!key) continue;
        let text: string;
        try {
          text = JSON.parse(m[3]!) as string;
        } catch {
          text = m[3]!;
        }
        out[m[2] ? key.replace(/_(zero|one|two|few|many|other)$/, `_${m[2]}`) : key] = text;
      }
  }
  return out;
}

/** Réponse simulée pour un lot à partir des traductions importées. */
function replyFrom(imported: Record<string, string>, b: Unit[]): Record<string, unknown> {
  const reply: Record<string, unknown> = {};
  for (const u of b) {
    if (u.kind === 'text') {
      if (imported[u.id] !== undefined) reply[u.id] = imported[u.id];
    } else {
      const forms: Record<string, string> = {};
      for (const [k, v] of Object.entries(imported))
        if (k.startsWith(`${u.id}_`)) forms[k.slice(u.id.length + 1)] = v;
      if (Object.keys(forms).length) reply[u.id] = forms;
    }
  }
  return reply;
}

const readJson = <T>(file: string, fallback: T): T =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;

function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

const glossary = readJson<{ rules: string[]; terms: Record<string, string> }>(
  join(TOOL_DIR, 'glossary.json'),
  { rules: [], terms: {} },
);

function systemPrompt(lang: Locale, d: Domain): string {
  return [
    `You are a senior video-game localizer. Translate French UI text into ${LANG_LABEL[lang]} (${LOCALE_TAGS[lang]}) for "Red Line", a real-time geopolitical military strategy game played in the browser on the real world map (real armies, real defense budgets, military victory only).`,
    `Context: ${d.context}`,
    'Rules:',
    ...glossary.rules.map((r) => `- ${r}`),
    '- Translate meaning, not word by word; natural, idiomatic, concise UI language. Keep the length close to the source.',
    '- Output: a JSON object with exactly the same keys as the input, values translated.',
    'Glossary (French → English reference; use the established equivalent in the target language):',
    ...Object.entries(glossary.terms).map(([fr, en]) => `- ${fr} → ${en}`),
  ].join('\n');
}

type Item = string | { plural: Record<string, string>; need: string[] };

function itemOf(u: Unit, lang: Locale): Item {
  return u.kind === 'text'
    ? u.text
    : { plural: u.forms as Record<string, string>, need: pluralCats(lang) };
}

function userPrompt(lang: Locale, units: Unit[], errors: Map<string, string[]>): string {
  const obj: Record<string, Item> = {};
  for (const u of units) obj[u.id] = itemOf(u, lang);
  const fixes = units
    .filter((u) => errors.has(u.id))
    .map((u) => `- ${u.id}: ${errors.get(u.id)!.join('; ')}`);
  return [
    `Translate into ${LANG_LABEL[lang]}.`,
    'Plural items are objects {"plural": {French forms}, "need": [categories]}: answer for those keys with an object whose keys are exactly the "need" CLDR categories of the target language, each a complete translated form.',
    ...(fixes.length ? ['A previous attempt had these problems, fix them:', ...fixes] : []),
    JSON.stringify(obj, null, 1),
  ].join('\n');
}

function batches(units: Unit[], maxChars: number): Unit[][] {
  const out: Unit[][] = [];
  let cur: Unit[] = [];
  let size = 0;
  for (const u of units) {
    const len = JSON.stringify(u.kind === 'text' ? u.text : u.forms).length + u.id.length;
    if (cur.length && (size + len > maxChars || cur.length >= 220)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Sémaphore simple : au plus N appels simultanés. */
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function loadSource(d: Domain): Record<string, string> {
  let tree: Tree = {};
  for (const f of d.sources) if (existsSync(f)) tree = merge(tree, readJson<Tree>(f, {}));
  return flatten(tree);
}

interface Result {
  domain: string;
  lang: Locale;
  todo: number;
  done: number;
  failed: string[];
  removed: number;
}

async function run(d: Domain, lang: Locale, units: Unit[]): Promise<Result> {
  const outFile = d.out(lang);
  const existing = flatten(readJson<Tree>(outFile, {}));
  const state = readJson<Record<string, string>>(stateFile(d.id, lang), {});
  const todo = units.filter((u) => {
    if (state[u.id] !== unitHash(u)) return true;
    return unitKeys(u, lang).some((k) => existing[k] === undefined);
  });
  const res: Result = { domain: d.id, lang, todo: todo.length, done: 0, failed: [], removed: 0 };
  const fresh = new Map<string, Record<string, string>>();
  const imported = importedFor(d, lang);
  if (!DRY && todo.length) {
    let pending = todo;
    const errors = new Map<string, string[]>();
    for (let pass = 0; pass < (imported ? 1 : 3) && pending.length && !fatalError(); pass++) {
      const next: Unit[] = [];
      await Promise.all(
        batches(pending, pass === 0 ? d.batchChars : 2500).map((b) =>
          limited(async () => {
            let reply: Record<string, unknown> = {};
            if (imported) reply = replyFrom(imported, b);
            else
              try {
                reply = await chatJson(d.model, systemPrompt(lang, d), userPrompt(lang, b, errors));
              } catch (e) {
                if (!fatalError()) console.error(`  ${d.id}/${lang} : ${(e as Error).message}`);
              }
            for (const u of b) {
              const v = reply[u.id];
              const errs =
                u.kind === 'text' ? checkText(u.text, v, lang) : checkPlural(u.forms, v, lang);
              if (errs.length) {
                errors.set(u.id, errs);
                next.push(u);
                continue;
              }
              errors.delete(u.id);
              if (u.kind === 'text') fresh.set(u.id, { [u.id]: v as string });
              else {
                const o = v as Record<string, string>;
                fresh.set(
                  u.id,
                  Object.fromEntries(pluralCats(lang).map((c) => [`${u.id}_${c}`, o[c]!])),
                );
              }
            }
          }),
        ),
      );
      pending = next;
    }
    res.failed = pending.map((u) => `${u.id} (${errors.get(u.id)?.join('; ')})`);
  }
  res.done = fresh.size;
  // Écriture dans l'ordre de la source : nouvelles traductions, sinon traductions en place.
  const out: Record<string, string> = {};
  const nextState: Record<string, string> = {};
  for (const u of units) {
    const f = fresh.get(u.id);
    const keys = unitKeys(u, lang);
    if (f) {
      Object.assign(out, f);
      nextState[u.id] = unitHash(u);
    } else if (keys.every((k) => existing[k] !== undefined)) {
      for (const k of keys) out[k] = existing[k]!;
      // Traduction conservée : empreinte inchangée (une source modifiée reste « à refaire »).
      if (state[u.id]) nextState[u.id] = state[u.id]!;
    }
  }
  res.removed = Object.keys(existing).filter((k) => out[k] === undefined).length;
  if (!DRY) {
    writeJson(outFile, unflatten(out));
    writeJson(stateFile(d.id, lang), nextState);
  }
  return res;
}

const t0 = Date.now();
const results: Result[] = [];
for (const d of domains) {
  const units = toUnits(loadSource(d));
  if (units.length === 0) {
    console.log(`${d.id} : source vide, ignoré`);
    continue;
  }
  console.log(`${d.id} : ${units.length} unités (${d.model})`);
  results.push(...(await Promise.all(langs.map((l) => run(d, l, units)))));
}
for (const r of results) {
  if (!r.todo && !r.removed) continue;
  console.log(
    `${r.domain}/${r.lang} : ${r.done}/${r.todo} traduites${r.removed ? `, ${r.removed} retirées` : ''}${r.failed.length ? `, ${r.failed.length} en échec` : ''}`,
  );
  for (const f of r.failed.slice(0, 10)) console.log(`   ✗ ${f}`);
}
const models = Object.entries(usage);
let total = 0;
for (const [m, u] of models) {
  const c = cost(m, u);
  total += c;
  console.log(
    `${m} : ${u.calls} appels, ${u.promptTokens} jetons en entrée, ${u.completionTokens} en sortie ≈ $${c.toFixed(3)}`,
  );
}
if (models.length) {
  const logFile = join(TOOL_DIR, 'state', 'usage.json');
  const log = readJson<unknown[]>(logFile, []);
  log.push({
    at: new Date().toISOString(),
    langs: langs.join(','),
    domains: domains.map((d) => d.id).join(','),
    usage,
    costUsd: Number(total.toFixed(4)),
  });
  writeJson(logFile, log);
}
console.log(
  `${DRY ? '[à blanc] ' : ''}terminé en ${Math.round((Date.now() - t0) / 1000)} s` +
    (models.length ? ` — coût estimé $${total.toFixed(3)}` : ''),
);
if (results.some((r) => r.failed.length)) {
  console.log(
    `Clés en échec : elles restent absentes (repli anglais puis français). Relancer pour réessayer. Fichiers : ${relative(REPO, join(TOOL_DIR, 'state'))}`,
  );
  process.exitCode = 1;
}
if (fatalError()) console.error(`Arrêt : ${fatalError()}`);
