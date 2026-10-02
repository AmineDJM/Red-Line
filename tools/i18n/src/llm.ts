/**
 * Appel du modèle de langue en mode JSON : API Gemini (generateContent, modèles `gemini-*`) ou API
 * OpenAI (Chat Completions, modèles `gpt-*`). L'authentification est injectée par le proxy sortant
 * de l'environnement : aucune clé n'est lue ni stockée ici (`GEMINI_API_KEY` / `OPENAI_API_KEY`
 * éventuelles sont transmises si elles existent). curl respecte HTTPS_PROXY et le magasin de
 * certificats du système, contrairement à fetch sous Node 22.
 *
 * Seuls les textes de l'interface (sources françaises du dépôt) sont envoyés : aucune donnée de
 * joueur, aucun identifiant.
 */
import { execFile } from 'node:child_process';

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export const usage: Record<string, Usage> = {};

/** Prix publics par million de jetons (entrée, sortie), en dollars, pour l'estimation du coût. */
export const PRICES: Record<string, [number, number]> = {
  // Tarif de la famille Flash-Lite 3.x (estimation : à confirmer sur la facture).
  'gemini-3.5-flash-lite': [0.25, 1.5],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4o-mini': [0.15, 0.6],
};

export function cost(model: string, u: Usage): number {
  const [i, o] = PRICES[model] ?? [0, 0];
  return (u.promptTokens * i + u.completionTokens * o) / 1e6;
}

function curl(
  url: string,
  headers: string[],
  body: string,
): Promise<{ status: number; text: string }> {
  const args = [
    '-sS',
    '--max-time',
    '600',
    '-w',
    '\n%{http_code}',
    '-H',
    'Content-Type: application/json',
    ...headers.flatMap((h) => ['-H', h]),
    '--data-binary',
    '@-',
    url,
  ];
  return new Promise((resolve, reject) => {
    const p = execFile('curl', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const i = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(i + 1)) || 0, text: stdout.slice(0, i) });
    });
    p.stdin!.end(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Reply {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

function request(model: string, system: string, user: string) {
  if (model.startsWith('gemini')) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: process.env.GEMINI_API_KEY ? [`x-goog-api-key: ${process.env.GEMINI_API_KEY}`] : [],
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          maxOutputTokens: 65536,
          // Pas de « réflexion » facturée : la traduction n'en a pas besoin.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      parse(text: string): Reply {
        const j = JSON.parse(text) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            thoughtsTokenCount?: number;
          };
        };
        return {
          content: (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
          promptTokens: j.usageMetadata?.promptTokenCount ?? 0,
          completionTokens:
            (j.usageMetadata?.candidatesTokenCount ?? 0) +
            (j.usageMetadata?.thoughtsTokenCount ?? 0),
        };
      },
    };
  }
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: process.env.OPENAI_API_KEY
      ? [`Authorization: Bearer ${process.env.OPENAI_API_KEY}`]
      : [],
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    parse(text: string): Reply {
      const j = JSON.parse(text) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      return {
        content: j.choices[0]?.message.content ?? '{}',
        promptTokens: j.usage?.prompt_tokens ?? 0,
        completionTokens: j.usage?.completion_tokens ?? 0,
      };
    },
  };
}

/** Crédit épuisé ou accès refusé : arrêt immédiat de tous les appels (aucun appel superflu). */
let fatal: string | null = null;
export const fatalError = () => fatal;

/** Une requête : système + utilisateur → objet JSON. Réessaie sur 429/5xx (backoff). */
export async function chatJson(
  model: string,
  system: string,
  user: string,
): Promise<Record<string, unknown>> {
  if (fatal) throw new Error(fatal);
  const req = request(model, system, user);
  let last = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await curl(req.url, req.headers, req.body).catch((e: Error) => ({
      status: 0,
      text: e.message,
    }));
    if (r.status === 200) {
      const rep = req.parse(r.text);
      const u = (usage[model] ??= { calls: 0, promptTokens: 0, completionTokens: 0 });
      u.calls++;
      u.promptTokens += rep.promptTokens;
      u.completionTokens += rep.completionTokens;
      try {
        return JSON.parse(rep.content) as Record<string, unknown>;
      } catch {
        // Réponse tronquée : les clés manquantes seront retraduites au passage suivant.
        return {};
      }
    }
    last = `HTTP ${r.status} ${r.text.slice(0, 300)}`;
    if (
      /insufficient_quota|credit_balance|billing|PERMISSION_DENIED|API_KEY_INVALID/i.test(r.text)
    ) {
      fatal = last;
      throw new Error(last);
    }
    // Refus de politique ou erreur de requête : inutile d'insister.
    if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) break;
    await sleep(2000 * 2 ** attempt);
  }
  throw new Error(`appel du modèle en échec : ${last}`);
}
