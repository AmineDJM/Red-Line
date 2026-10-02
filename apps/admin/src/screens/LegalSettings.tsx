/** Réglages › Légal : identité de l'éditeur et mentions insérées dans les pages publiques et les documents légaux. */
import { useEffect, useState } from 'react';
import { LEGAL_SETTING_KEYS, LegalSettingsSchema, type LegalSettings } from '@redline/shared';
import { useSession } from '../context';
import { useToast } from '../components/overlay';
import { Button, ErrorBox, Icon, Note, PageHead, Spinner, Win } from '../components/term';
import { T } from '../i18n';
import { errorMessage } from '../lib/errors';
import { useLoad } from '../lib/hooks';

const GROUPS: { title: string; keys: (keyof LegalSettings)[] }[] = [
  {
    title: T.legal.groups.publisher,
    keys: [
      'publisherName',
      'publisherStatus',
      'tradeName',
      'siren',
      'siret',
      'vatNumber',
      'registration',
      'address',
      'director',
      'contactEmail',
    ],
  },
  { title: T.legal.groups.host, keys: ['hostName', 'hostAddress', 'hostUrl', 'dataRegion'] },
  { title: T.legal.groups.consumer, keys: ['mediatorName', 'mediatorUrl', 'vatMention'] },
];

export function LegalSettingsScreen() {
  const { api, user } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(
    () => api.legalSettings(),
    [api],
    T.roles.moderator,
  );
  const [form, setForm] = useState<LegalSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  const canEdit = user.role === 'superadmin';
  const parsed = form ? LegalSettingsSchema.safeParse(form) : null;
  const fieldError = (k: keyof LegalSettings) =>
    parsed && !parsed.success
      ? parsed.error.issues.find((i) => i.path[0] === k)?.message
      : undefined;
  const dirty = !!form && !!data && LEGAL_SETTING_KEYS.some((k) => form[k] !== data.settings[k]);

  const save = async () => {
    if (!parsed?.success) return;
    setBusy(true);
    try {
      await api.saveLegalSettings(parsed.data);
      toast(T.legal.saved);
      await reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title={T.legal.title}
        sub={T.legal.sub}
        actions={
          canEdit ? (
            <Button
              variant="primary"
              disabled={!dirty || !parsed?.success || busy}
              onClick={() => void save()}
            >
              <Icon name="save" size={14} /> {busy ? T.app.saving : T.app.save}
            </Button>
          ) : undefined
        }
      />
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {loading && !data && <Spinner />}
      {data && form && (
        <div className="stack">
          <Note tone="warn">{T.legal.review}</Note>
          {!canEdit && <Note>{T.legal.readOnly}</Note>}
          {GROUPS.map((g) => (
            <Win key={g.title} title={g.title} glyph="§">
              <div className="grid g2">
                {g.keys.map((k) => {
                  const err = fieldError(k);
                  const def = data.defaults[k];
                  return (
                    <div key={k} className={`field ${err ? 'field-error' : ''}`}>
                      <label htmlFor={`legal-${k}`}>{T.legal.fields[k]}</label>
                      <input
                        id={`legal-${k}`}
                        value={form[k]}
                        readOnly={!canEdit}
                        placeholder={
                          k === 'contactEmail' ? data.effective.contactEmail : def || undefined
                        }
                        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      />
                      {err ? (
                        <small className="field-msg">{err}</small>
                      ) : k === 'contactEmail' ? (
                        <small className="field-hint">
                          {T.legal.contactHint.replace('{email}', data.effective.contactEmail)}
                        </small>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Win>
          ))}
          <p className="dim small">
            {T.legal.publicUrl} : {data.publicUrl ?? T.legal.noPublicUrl}
          </p>
        </div>
      )}
    </>
  );
}
