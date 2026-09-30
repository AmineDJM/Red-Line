import { useMemo, useState } from 'react';
import { useSession } from '../context';
import type { ImportErrorItem, ImportResult } from '../api/client';
import { Badge, Button, ErrorBox, Frame, useToast } from '../components/ui';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';
import { parseImport } from '../lib/importFile';

const count = (v: number | string[] | ImportErrorItem[]) => (typeof v === 'number' ? v : v.length);
const errorText = (e: ImportErrorItem) =>
  typeof e === 'string'
    ? e
    : [
        e.id ?? (e.index != null ? `#${e.index + 1}` : null),
        e.message ?? e.error ?? JSON.stringify(e.issues ?? e),
      ]
        .filter(Boolean)
        .join(' : ');

export function ImportExportScreen() {
  const { api } = useSession();
  const toast = useToast();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string>(T.importExport.defaultMessage);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportResult | null>(null);
  const [existing, setExisting] = useState<Set<string> | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseImport(text) : null), [text]);

  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    setReport(null);
    if (!existing) {
      api.listSystems().then(
        (r) => setExisting(new Set(r.systems.map((s) => s.system.id))),
        () => undefined,
      );
    }
  };

  const doExport = async () => {
    try {
      const { systems } = await api.exportCatalog();
      const blob = new Blob([JSON.stringify({ systems }, null, 2) + '\n'], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `redline-catalogue-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(fmt(T.importExport.exported, { n: systems.length }));
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    }
  };

  const doImport = async () => {
    if (!parsed || 'error' in parsed) return;
    setBusy(true);
    try {
      const r = await api.importCatalog({
        systems: parsed.items,
        message: message.trim() || T.importExport.defaultMessage,
      });
      setReport(r);
      requestAnimationFrame(() =>
        document.querySelector('.report')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
      api.listSystems().then(
        (l) => setExisting(new Set(l.systems.map((x) => x.system.id))),
        () => undefined,
      );
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    } finally {
      setBusy(false);
    }
  };

  const ok = parsed && !('error' in parsed) ? parsed.rows.filter((r) => r.ok).length : 0;

  return (
    <div className="io-grid">
      <Frame title={T.importExport.exportTitle}>
        <p className="muted">{T.importExport.exportText}</p>
        <Button variant="primary" onClick={() => void doExport()}>
          ⤓ {T.importExport.exportButton}
        </Button>
      </Frame>

      <Frame title={T.importExport.importTitle}>
        <p className="muted">{T.importExport.importText}</p>
        <label className="btn btn-default file-btn">
          {T.importExport.file}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void loadFile(e.target.files?.[0])}
          />
        </label>
        <div className="field">
          <label htmlFor="paste">{T.importExport.paste}</label>
          <textarea
            id="paste"
            className="mono json-small"
            spellCheck={false}
            rows={8}
            value={text}
            placeholder='{ "systems": [ … ] }'
            onChange={(e) => {
              setText(e.target.value);
              setReport(null);
              if (!existing)
                api.listSystems().then(
                  (r) => setExisting(new Set(r.systems.map((s) => s.system.id))),
                  () => undefined,
                );
            }}
          />
        </div>
        {parsed && 'error' in parsed && <ErrorBox message={parsed.error} />}
        {parsed && !('error' in parsed) && (
          <>
            <p>
              {fmt(T.importExport.parsed, {
                n: parsed.rows.length,
                ok,
                ko: parsed.rows.length - ok,
              })}
            </p>
            <div className="import-rows">
              {parsed.rows.map((r, i) => (
                <div key={i} className={`import-row ${r.ok ? '' : 'import-bad'}`}>
                  <span className="mono">{r.id}</span>
                  <span>{r.name}</span>
                  <span>
                    {r.ok ? (
                      <Badge tone={existing?.has(r.id) ? 'info' : 'ok'}>
                        {existing?.has(r.id)
                          ? T.importExport.willUpdate
                          : T.importExport.willCreate}
                      </Badge>
                    ) : (
                      <Badge tone="crit">{fmt(T.editor.invalid, { n: r.errors.length })}</Badge>
                    )}
                  </span>
                  {!r.ok && (
                    <small className="field-msg import-err">
                      {r.errors.slice(0, 3).join(' ; ')}
                    </small>
                  )}
                </div>
              ))}
            </div>
            <div className="field">
              <label htmlFor="imsg">{T.importExport.message}</label>
              <input
                id="imsg"
                value={message}
                maxLength={500}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            <Button
              variant="primary"
              disabled={busy || parsed.rows.length === 0}
              onClick={() => void doImport()}
            >
              {busy
                ? T.importExport.submitting
                : fmt(T.importExport.submit, { n: parsed.rows.length })}
            </Button>
          </>
        )}
        {report && (
          <div className="report">
            <h3 className="sub-title">{T.importExport.report}</h3>
            <div className="report-tiles">
              <div className="tile">
                <span className="tile-label">{T.importExport.created}</span>
                <span className="tile-value">{count(report.created)}</span>
              </div>
              <div className="tile">
                <span className="tile-label">{T.importExport.updated}</span>
                <span className="tile-value">{count(report.updated)}</span>
              </div>
              <div className="tile">
                <span className="tile-label">{T.importExport.errors}</span>
                <span className={`tile-value ${count(report.errors) ? 'tile-crit' : ''}`}>
                  {count(report.errors)}
                </span>
              </div>
            </div>
            {Array.isArray(report.created) && report.created.length > 0 && (
              <p className="small">
                <strong>{T.importExport.created} :</strong>{' '}
                <span className="mono">{report.created.join(', ')}</span>
              </p>
            )}
            {Array.isArray(report.updated) && report.updated.length > 0 && (
              <p className="small">
                <strong>{T.importExport.updated} :</strong>{' '}
                <span className="mono">{report.updated.join(', ')}</span>
              </p>
            )}
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
      </Frame>
    </div>
  );
}
