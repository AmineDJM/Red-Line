/** Paramètres d'exploitation : quotas, délais d'abandon, veille des IA (à chaud, conservés en base). */
import { useEffect, useState } from 'react';
import { RuntimeSettingsSchema, type RuntimeSettings } from '@redline/shared';
import { useSession } from '../context';
import { useConfirm, useToast } from '../components/overlay';
import { Badge, Button, ErrorBox, Icon, Note, PageHead, Spinner, Win } from '../components/term';
import { T } from '../i18n';
import { O } from '../i18n/fr-ops';
import { errorMessage } from '../lib/errors';
import { num } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { href } from '../lib/router';
import './ops.css';

const V = O.server;

/** Champs : clé, libellé, conversion affichage ↔ valeur (heures pour les délais d'abandon). */
const FIELDS: [keyof RuntimeSettings, string, number][] = [
  ['maxActiveSoloPerUser', V.solo, 1],
  ['maxActiveMultiPerUser', V.multi, 1],
  ['soloAbandonMin', V.soloAbandon, 60],
  ['multiAbandonMin', V.multiAbandon, 60],
  ['dormancyDelayMin', V.dormancy, 1],
  ['idleUnloadMin', V.unload, 1],
];

export function ServerSettingsScreen() {
  const { api, user } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(
    () => api.serverSettings(),
    [api],
    T.roles.moderator,
  );
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canEdit = user.role === 'superadmin';
  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(FIELDS.map(([k, , f]) => [k, String(data.settings[k] / f)])));
  }, [data]);
  if (error) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading || !data) return <Spinner />;
  const value: Record<string, number> = Object.fromEntries(
    FIELDS.map(([k, , f]) => [k, Number((form[k] ?? '').replace(',', '.')) * f]),
  );
  const parsed = RuntimeSettingsSchema.safeParse(value);
  const dirty = FIELDS.some(([k]) => value[k] !== data.settings[k]);
  const save = async () => {
    if (!parsed.success) return;
    if (!(await confirm({ title: V.title, message: V.confirm, confirm: T.app.save }))) return;
    setBusy(true);
    try {
      await api.saveServerSettings(parsed.data);
      toast(V.saved);
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };
  const field = ([k, label]: (typeof FIELDS)[number]) => (
    <div className="field" key={k}>
      <label htmlFor={`rs-${k}`}>{label}</label>
      <input
        id={`rs-${k}`}
        className="input"
        inputMode="decimal"
        disabled={!canEdit}
        value={form[k] ?? ''}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
      />
    </div>
  );
  const i = data.info;
  return (
    <>
      <PageHead title={V.title} sub={V.sub} />
      <div className="stack">
        {!canEdit && <Note>{V.readonly}</Note>}
        <div className="eco-grid" style={{ margin: 0 }}>
          <Win title={V.quotas} glyph="#">
            <div className="form-grid">{FIELDS.slice(0, 2).map(field)}</div>
          </Win>
          <Win title={V.delays} glyph="⧗">
            <div className="form-grid">{FIELDS.slice(2).map(field)}</div>
          </Win>
        </div>
        {!parsed.success && (
          <Note tone="crit">
            {parsed.error.issues
              .slice(0, 3)
              .map((x) => `${x.path.join('.')} : ${x.message}`)
              .join(' ; ')}
          </Note>
        )}
        {canEdit && (
          <div className="row" style={{ gap: 8 }}>
            <Button
              variant="primary"
              disabled={busy || !dirty || !parsed.success}
              onClick={() => void save()}
            >
              <Icon name="save" size={14} /> {T.app.save}
            </Button>
            {dirty && <Badge tone="warn">●</Badge>}
          </div>
        )}
        <Win title={V.info} glyph="i">
          <dl className="kv">
            <dt>{V.speeds}</dt>
            <dd>
              {i.speeds.map((s) => `×${s}`).join(' ')} ·{' '}
              <a href={href({ name: 'rules', section: 'time' })}>{V.rulesLink}</a>
            </dd>
            <dt>{V.radius}</dt>
            <dd>{i.dormancyRadiusKm ? `${num(i.dormancyRadiusKm)} km` : '—'}</dd>
            <dt>{V.snapshot}</dt>
            <dd>{i.snapshotIntervalS} s (SNAPSHOT_INTERVAL_S)</dd>
            <dt>{V.rate}</dt>
            <dd>{i.createRateLimitPerMin}</dd>
            <dt>{V.instance}</dt>
            <dd>
              <code>{i.instanceId}</code>
            </dd>
            <dt>{V.env}</dt>
            <dd>{i.nodeEnv}</dd>
            <dt>{V.payments}</dt>
            <dd className={i.paymentsAvailable ? 'c-green' : 'c-red'}>
              {i.paymentsAvailable ? V.available : V.unavailable}
            </dd>
          </dl>
        </Win>
      </div>
    </>
  );
}
