import { useMemo, useState } from 'react';
import { ApiError, type ImportErrorItem, type ImportResult } from '../api/client';
import { useSession } from '../context';
import { DataTable } from '../components/DataTable';
import { useConfirm, useToast } from '../components/overlay';
import { Badge, Button, ErrorBox, Icon, PageHead, Stat, Win } from '../components/term';
import { T, fmt } from '../i18n';
import { downloadJson } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { parseImport } from '../lib/importFile';
import { useSystems } from '../lib/refs';

const count = (v: number | unknown[]) => (Array.isArray(v) ? v.length : v);
const errorText = (e: ImportErrorItem) =>
  typeof e === 'string'
    ? e
    : `${e.id ?? (e.index !== undefined ? `#${e.index}` : '?')} : ${e.message ?? e.error ?? JSON.stringify(e.issues ?? e)}`;

export function ImportExportScreen() {
  const { api, cache } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const existing = useSystems().data;
  const ids = useMemo(() => new Set((existing ?? []).map((s) => s.system.id)), [existing]);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportResult | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseImport(text) : null), [text]);

  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    setReport(null);
  };

  const doExport = async () => {
    try {
      const { systems } = await api.exportCatalog();
      downloadJson('redline-catalog.json', { systems });
      toast(fmt(T.importExport.exported, { n: systems.length }));
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    }
  };

  const doImport = async () => {
    if (!parsed || 'error' in parsed) return;
    const c = parsed.rows.filter((r) => !ids.has(r.id)).length;
    if (
      !(await confirm({
        title: T.importExport.importTitle,
        message: fmt(T.importExport.confirm, {
          n: parsed.rows.length,
          c,
          u: parsed.rows.length - c,
        }),
      }))
    )
      return;
    setBusy(true);
    try {
      const r = await api.importCatalog({
        systems: parsed.items,
        message: message.trim() || T.importExport.defaultMessage,
      });
      setReport(r);
      cache.invalidate('systems');
    } catch (e) {
      // Import refusé (tout ou rien) : le serveur renvoie 400 avec la liste des erreurs.
      const d =
        e instanceof ApiError ? (e.details as Partial<ImportResult> | undefined) : undefined;
      if (d && Array.isArray(d.errors)) setReport({ created: 0, updated: 0, errors: d.errors });
      else toast(errorMessage(e, T.roles.balance), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rows = parsed && !('error' in parsed) ? parsed.rows : [];
  const ok = rows.filter((r) => r.ok).length;

  return (
    <>
      <PageHead title={T.nav.importExport} sub="data/catalog ⇄ back-office" />
      <div className="split-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px' }}>
        <Win
          title={T.importExport.importTitle}
          cmd="Import-WeaponSystem -Path catalog.json"
          glyph="⇡"
        >
          <p className="muted small">{T.importExport.importText}</p>
          <div className="row-wrap" style={{ marginBottom: 12 }}>
            <label className="btn">
              <Icon name="upload" size={14} /> {T.importExport.file}
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(e) => void loadFile(e.target.files?.[0])}
              />
            </label>
          </div>
          <div className="field">
            <label htmlFor="paste">{T.importExport.paste}</label>
            <textarea
              id="paste"
              className="json-editor"
              style={{ minHeight: 160 }}
              spellCheck={false}
              value={text}
              placeholder='{ "systems": [ … ] }'
              onChange={(e) => {
                setText(e.target.value);
                setReport(null);
              }}
            />
          </div>
          {parsed && 'error' in parsed && <ErrorBox message={parsed.error} />}
          {rows.length > 0 && (
            <div className="stack" style={{ marginTop: 12 }}>
              <p className="small">
                {fmt(T.importExport.parsed, { n: rows.length, ok, ko: rows.length - ok })}
              </p>
              <DataTable
                rows={rows}
                rowKey={(r) => `${r.id}:${r.name}`}
                maxHeight={320}
                columns={[
                  { key: 'id', label: 'ID', render: (r) => r.id },
                  { key: 'name', label: T.catalog.colName, render: (r) => r.name },
                  {
                    key: 'st',
                    label: T.catalog.colStatus,
                    render: (r) =>
                      r.ok ? (
                        <Badge tone={ids.has(r.id) ? 'info' : 'ok'}>
                          {ids.has(r.id) ? T.importExport.willUpdate : T.importExport.willCreate}
                        </Badge>
                      ) : (
                        <span className="c-red small" title={r.errors.join('\n')}>
                          ✕ {r.errors[0]}
                        </span>
                      ),
                  },
                ]}
              />
              <div className="field">
                <label htmlFor="imsg">{T.importExport.message}</label>
                <input
                  id="imsg"
                  value={message}
                  maxLength={500}
                  placeholder={T.importExport.defaultMessage}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>
              <div>
                <Button
                  variant="primary"
                  disabled={busy || ok !== rows.length}
                  onClick={() => void doImport()}
                >
                  {busy
                    ? T.importExport.submitting
                    : fmt(T.importExport.submit, { n: rows.length })}
                </Button>
              </div>
            </div>
          )}
          {report && (
            <div className="stack" style={{ marginTop: 16 }}>
              <div className="section-title">{T.importExport.report}</div>
              <div className="stats">
                <Stat k={T.importExport.created} v={count(report.created)} tone="var(--t-green)" />
                <Stat k={T.importExport.updated} v={count(report.updated)} tone="var(--t-cyan)" />
                <Stat
                  k={T.importExport.errors}
                  v={count(report.errors)}
                  tone={count(report.errors) ? 'var(--t-red)' : undefined}
                />
              </div>
              {Array.isArray(report.errors) && report.errors.length > 0 ? (
                <ul className="issues">
                  {report.errors.map((e, i) => (
                    <li key={i}>{errorText(e)}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">{T.importExport.noErrors}</p>
              )}
            </div>
          )}
        </Win>
        <Win title={T.importExport.exportTitle} cmd="Export-Catalog" glyph="⇣">
          <p className="muted small">{T.importExport.exportText}</p>
          <Button variant="primary" onClick={() => void doExport()}>
            <Icon name="download" size={14} /> {T.importExport.exportButton}
          </Button>
          {existing && (
            <p className="dim small" style={{ marginTop: 10 }}>
              {fmt(T.catalog.count, { n: existing.length })}
            </p>
          )}
        </Win>
      </div>
    </>
  );
}
