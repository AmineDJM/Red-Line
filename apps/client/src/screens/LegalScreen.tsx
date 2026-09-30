import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LegalDoc, LegalDocRef } from '@redline/shared';
import { Button, Checkbox, Dialog, EmptyState, Spinner, Tabs } from '@redline/ui';
import { getApi } from '../api/index.js';
import { Page } from '../components/Page.js';
import { navigate, useRoute } from '../router.js';

const DOCS: LegalDocRef['id'][] = ['cgu', 'cgv', 'privacy', 'withdrawal'];

/** Rendu Markdown minimal et sûr (titres, gras, listes, paragraphes) : aucun HTML injecté. */
export function Markdown({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s
      .split(/(\*\*[^*]+\*\*)/g)
      .map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      );
  // Découpage ligne à ligne : titres (#), listes (- ou *), paragraphes (lignes consécutives).
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join(' '))}</p>);
    if (list.length)
      out.push(
        <ul key={out.length}>
          {list.map((l, j) => (
            <li key={j}>{inline(l)}</li>
          ))}
        </ul>,
      );
    para = [];
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (!line) flush();
    else if (h) {
      flush();
      const Tag = (['h2', 'h3', 'h4'] as const)[h[1]!.length - 1]!;
      out.push(<Tag key={out.length}>{inline(h[2]!)}</Tag>);
    } else if (/^[-*] /.test(line)) {
      if (para.length) flush();
      list.push(line.slice(2));
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return <div className="md">{out}</div>;
}

/** Pages légales (CGU, CGV, confidentialité, rétractation). */
export function LegalScreen({ doc }: { doc: LegalDocRef['id'] }) {
  const { t } = useTranslation();
  const [data, setData] = useState<LegalDoc | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    setData(null);
    void getApi()
      .then((api) => api.legal(doc))
      .then(setData)
      .catch(() => setError(true));
  }, [doc]);
  return (
    <Page
      path={[t('legal.path'), doc]}
      title={t('legal.title')}
      subtitle={
        data
          ? t('legal.version', {
              version: data.version,
              date: new Date(data.updatedAt).toLocaleDateString('fr-FR'),
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
