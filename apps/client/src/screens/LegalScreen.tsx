import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LegalDoc, LegalDocRef } from '@redline/shared';
import { Button, Checkbox, Dialog, EmptyState, Spinner, Tabs } from '@redline/ui';
import { getApi } from '../api/index.js';
import { Page } from '../components/Page.js';
import { navigate, useRoute } from '../router.js';
import '../styles/legal.css';

const DOCS: LegalDocRef['id'][] = ['mentions', 'cgu', 'cgv', 'privacy', 'cookies', 'withdrawal'];

/** Lien d'un document : « page:legal:x » → écran légal du jeu ; adresses http(s), mailto et internes. */
function linkTarget(href: string): { href: string; internal: boolean } | null {
  const legal = /^page:legal:([a-z]+)$/.exec(href);
  if (legal) return { href: `/legal/${legal[1]}`, internal: true };
  if (/^(https?:|mailto:)/.test(href)) return { href, internal: false };
  if (href.startsWith('/')) return { href, internal: false };
  return null;
}

/** Texte en ligne : liens, gras, italique, code — jamais de HTML injecté. */
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(^|[\s(«])_([^_]+)_(?=[\s.,;:!?)»]|$)/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push(<Fragment key={k++}>{s.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) {
      const target = linkTarget(m[2]!);
      out.push(
        target ? (
          <a
            key={k++}
            href={target.href}
            {...(target.internal
              ? { onClick: (e) => (e.preventDefault(), navigate(target.href)) }
              : { target: '_blank', rel: 'noopener' })}
          >
            {inline(m[1])}
          </a>
        ) : (
          <Fragment key={k++}>{inline(m[1])}</Fragment>
        ),
      );
    } else if (m[3] !== undefined) out.push(<strong key={k++}>{inline(m[3])}</strong>);
    else if (m[4] !== undefined) out.push(<code key={k++}>{m[4]}</code>);
    else {
      out.push(<Fragment key={k++}>{m[5]}</Fragment>);
      out.push(<em key={k++}>{m[6]}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(<Fragment key={k++}>{s.slice(last)}</Fragment>);
  return out;
}

const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/**
 * Rendu Markdown minimal et sûr (titres, paragraphes, listes, tableaux, citations, liens, gras, italique) :
 * aucun HTML injecté. Les commentaires <!-- … --> (notes internes) sont retirés.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      const Tag = (['h2', 'h3', 'h4'] as const)[h[1]!.length - 1]!;
      out.push(<Tag key={out.length}>{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        const r = lines[i]!.trim();
        if (!/^\|?\s*:?-{2,}/.test(r)) rows.push(cells(r));
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <div className="md__table" key={out.length}>
          <table>
            {head ? (
              <thead>
                <tr>
                  {head.map((c, j) => (
                    <th key={j} scope="col">
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((r, j) => (
                <tr key={j}>
                  {r.map((c, n) => (
                    <td key={n}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        q.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(<blockquote key={out.length}>{inline(q.join(' '))}</blockquote>);
      continue;
    }
    const ol = /^\d+[.)] /;
    const ul = /^[-*] /;
    if (ol.test(line) || ul.test(line)) {
      const marker = ol.test(line) ? ol : ul;
      const items: string[] = [];
      while (i < lines.length) {
        const raw = lines[i]!;
        const l = raw.trim();
        if (marker.test(l)) items.push(l.replace(marker, ''));
        else if (l && /^\s{2,}/.test(raw) && items.length) items[items.length - 1] += ` ${l}`;
        else break;
        i++;
      }
      const Tag = marker === ol ? 'ol' : 'ul';
      out.push(
        <Tag key={out.length}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!.trim();
      if (!l || /^(#{1,3} |[-*] |\d+[.)] |>|\|)/.test(l)) break;
      para.push(l);
      i++;
    }
    out.push(<p key={out.length}>{inline(para.join(' '))}</p>);
  }
  return <div className="md">{out}</div>;
}

/** Pages légales (CGU, CGV, confidentialité, rétractation). */
export function LegalScreen({ doc }: { doc: LegalDocRef['id'] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [data, setData] = useState<LegalDoc | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    setData(null);
    void getApi()
      .then((api) => api.legal(doc, lang))
      .then(setData)
      .catch(() => setError(true));
  }, [doc, lang]);
  return (
    <Page
      path={[t('legal.path'), doc]}
      title={t('legal.title')}
      subtitle={
        data
          ? t('legal.version', {
              version: data.version,
              date: new Date(data.updatedAt).toLocaleDateString(lang),
            })
          : undefined
      }
    >
      <Tabs
        label={t('legal.title')}
        value={doc}
        onChange={(d) => navigate(`/legal/${d}`, { replace: true })}
        tabs={DOCS.map((d) => ({ id: d, label: t(`legal.docs.${d}`) }))}
      />
      <div className="legal">
        {error ? (
          <EmptyState icon="document" title={t('legal.error')} />
        ) : data ? (
          <Markdown text={data.markdown} />
        ) : (
          <Spinner label={t('app.loading')} />
        )}
      </div>
    </Page>
  );
}

/** Écran d'acceptation des conditions (quand GET /api/me signale des documents à accepter). */
export function LegalGate() {
  const { t } = useTranslation();
  const route = useRoute();
  const [pending, setPending] = useState<LegalDocRef[]>([]);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getApi()
      .then((api) => api.legalPending())
      .then(setPending)
      .catch(() => setPending([]));
  }, []);
  if (!pending.length || route.name === 'legal') return null;
  return (
    <Dialog
      open
      title={t('legal.gateTitle')}
      path={[t('legal.path'), 'acceptation']}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => navigate('/legal/cgu')}>
            {t('legal.read')}
          </Button>
          <Button
            variant="primary"
            disabled={!checked || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await (await getApi()).acceptLegal(pending);
                setPending([]);
              } finally {
                setBusy(false);
              }
            }}
            data-testid="legal-accept"
          >
            {t('legal.accept')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <h3 className="dialog-heading">{t('legal.gateTitle')}</h3>
        <p>{t('legal.gateText')}</p>
        <ul className="plainlist">
          {pending.map((d) => (
            <li key={d.id}>
              <a
                href={`/legal/${d.id}`}
                onClick={(e) => (e.preventDefault(), navigate(`/legal/${d.id}`))}
              >
                {t(`legal.docs.${d.id}`)}
              </a>{' '}
              <span className="muted small">v{d.version}</span>
            </li>
          ))}
        </ul>
        <Checkbox checked={checked} onChange={setChecked} label={t('legal.checkbox')} />
      </div>
    </Dialog>
  );
}
