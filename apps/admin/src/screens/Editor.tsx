import { useCallback, useMemo, useState } from 'react';
import {
  CATEGORIES,
  DOCTRINES,
  MOVEMENT_KINDS,
  RESOURCES,
  TARGET_CLASSES,
  type AdminSystem,
  type ChangeScope,
} from '@redline/shared';
import { useSession } from '../context';
import {
  CheckField,
  FormProvider,
  ListField,
  NumberField,
  SelectField,
  TextField,
} from '../components/fields';
import { Badge, Button, Dialog, ErrorBox, Frame, Spinner, useToast } from '../components/ui';
import { WeaponCard } from '../components/WeaponCard';
import { T, fmt } from '../i18n';
import { diffObjects } from '../lib/diff';
import { errorMessage } from '../lib/errors';
import { useLoad } from '../lib/hooks';
import { clone, setIn, type Path } from '../lib/paths';
import { href, navigate } from '../lib/router';
import { blankSystem } from '../lib/template';
import { validateSystem } from '../lib/validation';

const opts = <K extends string>(keys: readonly K[], labels: Record<K, string>) =>
  keys.map((k) => [k, `${labels[k]}`] as const);
const withCode = <K extends string>(keys: readonly K[], labels: Record<K, string>) =>
  keys.map((k) => [k, `${labels[k]} (${k})`] as const);

export function EditorScreen({ id }: { id: string | null }) {
  const { api } = useSession();
  const toast = useToast();
  const isNew = id === null;
  const [original, setOriginal] = useState<AdminSystem | null>(null);
  const [draft, setDraft] = useState<unknown>(() => (isNew ? blankSystem() : null));
  const load = useLoad(
    async () => {
      if (isNew) return null;
      const { system } = await api.getSystem(id);
      setOriginal(system);
      setDraft(clone(system.system));
      return system;
    },
    [api, id],
    T.roles.balance,
  );

  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [scope, setScope] = useState<ChangeScope>('new_games');
  const [playerMessage, setPlayerMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupId, setDupId] = useState('');

  const validation = useMemo(() => validateSystem(draft), [draft]);
  const errors = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const i of validation.issues) m.set(i.path, [...(m.get(i.path) ?? []), i.message]);
    return m;
  }, [validation]);
  const changes = useMemo(
    () => (draft ? diffObjects(original?.system ?? (isNew ? {} : draft), draft) : []),
    [original, draft, isNew],
  );
  const changed = useMemo(() => new Set(isNew ? [] : changes.map((c) => c.path)), [changes, isNew]);
  const set = useCallback(
    (path: Path, value: unknown) => setDraft((d: unknown) => setIn(d, path, value)),
    [],
  );

  const switchMode = (m: 'form' | 'json') => {
    if (m === 'json') {
      setJsonText(JSON.stringify(draft, null, 2));
      setJsonError(null);
    }
    setMode(m);
  };
  const onJson = (text: string) => {
    setJsonText(text);
    try {
      setDraft(JSON.parse(text));
      setJsonError(null);
    } catch (e) {
      setJsonError(
        fmt(T.editor.jsonParseError, { msg: e instanceof Error ? e.message : String(e) }),
      );
    }
  };

  const save = async () => {
    if (!validation.ok) return;
    setSaving(true);
    try {
      const body = {
        data: validation.value,
        message: message.trim(),
        scope,
        ...(playerMessage.trim() ? { playerMessage: playerMessage.trim() } : {}),
      };
      if (isNew) {
        const { system } = await api.createSystem(body);
        toast(T.editor.created);
        navigate({ name: 'system', id: system.system.id });
        return;
      }
      const { system } = await api.updateSystem(id, body);
      setOriginal(system);
      setDraft(clone(system.system));
      if (mode === 'json') setJsonText(JSON.stringify(system.system, null, 2));
      setMessage('');
      setPlayerMessage('');
      toast(fmt(T.editor.saved, { n: system.revision }));
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    if (!id) return;
    try {
      const { system } = await api.duplicateSystem(id, dupId.trim());
      setDupOpen(false);
      toast(fmt(T.editor.duplicated, { id: system.system.id }));
      navigate({ name: 'system', id: system.system.id });
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
    }
  };

  if (!isNew && load.error)
    return <ErrorBox message={load.error} onRetry={() => void load.reload()} />;
  if (!draft) return <Spinner />;

  const d = draft as Record<string, unknown>;
  const title = isNew ? T.editor.newTitle : String(d.name || id);
  const canSave = validation.ok && (isNew || changes.length > 0) && !saving && !jsonError;

  const status = (
    <div className="status-line">
      {validation.ok ? (
        <Badge tone="ok">✓ {T.editor.valid}</Badge>
      ) : (
        <Badge tone="crit">✕ {fmt(T.editor.invalid, { n: validation.issues.length })}</Badge>
      )}
      {!isNew &&
        (changes.length ? (
          <Badge tone="warn">{fmt(T.editor.unsaved, { n: changes.length })}</Badge>
        ) : (
          <Badge tone="off">{T.editor.noChange}</Badge>
        ))}
    </div>
  );

  return (
    <div className="editor">
      <div className="editor-bar">
        <a className="back" href={href({ name: 'catalog' })}>
          ← {T.editor.back}
        </a>
        <div className="editor-title">
          <h1>{title}</h1>
          {!isNew && (
            <span className="mono muted">
              {id} · {fmt(T.editor.revision, { n: original?.revision ?? '—' })}
            </span>
          )}
        </div>
        <div className="editor-actions">
          <div className="seg" role="group">
            <button className={mode === 'form' ? 'seg-on' : ''} onClick={() => switchMode('form')}>
              {T.editor.form}
            </button>
            <button className={mode === 'json' ? 'seg-on' : ''} onClick={() => switchMode('json')}>
              {T.editor.json}
            </button>
          </div>
          {!isNew && (
            <>
              <Button onClick={() => navigate({ name: 'history', id: id })}>
                {T.editor.history}
              </Button>
              <Button
                onClick={() => {
                  setDupId(`${id}-copie`);
                  setDupOpen(true);
                }}
              >
                {T.editor.duplicate}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="editor-grid">
        <div className="editor-main">
          {mode === 'json' ? (
            <Frame title={T.editor.json}>
              <p className="muted small">{T.editor.jsonHint}</p>
              <textarea
                className="json-editor mono"
                spellCheck={false}
                value={jsonText}
                onChange={(e) => onJson(e.target.value)}
                aria-label={T.editor.json}
              />
              {jsonError && <ErrorBox message={jsonError} />}
            </Frame>
          ) : (
            <FormProvider
              draft={draft}
              set={set}
              errors={errors}
              changed={changed}
              readOnly={isNew ? undefined : new Set(['id'])}
            >
              <Frame title={T.editor.sections.identity}>
                <div className="grid g3">
                  <TextField path={['id']} mono placeholder="us.f-16" />
                  <TextField path={['name']} />
                  <TextField path={['origin']} mono />
                  <SelectField path={['doctrine']} options={withCode(DOCTRINES, T.doctrines)} />
                  <SelectField path={['category']} options={opts(CATEGORIES, T.categories)} />
                  <SelectField
                    path={['generation']}
                    asNumber
                    options={[1, 2, 3, 4, 5].map((g) => [String(g), String(g)] as const)}
                  />
                  <SelectField
                    path={['targetClass']}
                    options={opts(TARGET_CLASSES, T.targetClasses)}
                  />
                  <SelectField path={['movement']} options={opts(MOVEMENT_KINDS, T.movement)} />
                  <TextField path={['icon']} mono />
                  <ListField path={['roles']} wide />
                  <TextField path={['illustration']} optional mono />
                </div>
              </Frame>
              <Frame title={T.editor.sections.flags}>
                <div className="grid g4 checks">
                  <CheckField path={['enabled']} />
                  <CheckField path={['canCapture']} />
                  <CheckField path={['licensable']} />
                  <CheckField path={['exportable']} />
                </div>
                <div className="grid g1">
                  <ListField path={['requires']} wide />
                </div>
              </Frame>
              <Frame title={T.editor.sections.economy}>
                <div className="grid g4">
                  <NumberField path={['cost', 'money']} />
                  <NumberField path={['buildTimeH']} />
                  <NumberField path={['upkeepPerDay']} />
                  <NumberField path={['unitSize']} />
                  {RESOURCES.map((r) => (
                    <NumberField
                      key={r}
                      path={['cost', 'resources', r]}
                      optional
                      label={`${T.fields['cost.resources']} : ${T.resources[r].toLowerCase()}`}
                    />
                  ))}
                </div>
              </Frame>
              <Frame title={T.editor.sections.mobility}>
                <div className="grid g3">
                  <NumberField path={['speedKmh']} />
                  <NumberField path={['operationalRadiusKm']} nullable />
                  <NumberField path={['detectionRangeKm']} />
                  <NumberField path={['weaponRangeKm', 'min']} />
                  <NumberField path={['weaponRangeKm', 'max']} />
                </div>
              </Frame>
              <Frame title={T.editor.sections.combat}>
                <div className="grid g3">
                  <NumberField path={['hp']} />
                  <NumberField path={['armor']} />
                  <NumberField path={['stealth']} />
                </div>
                <h3 className="sub-title">{T.editor.sections.damage}</h3>
                <div className="damage-grid">
                  {TARGET_CLASSES.map((c) => (
                    <NumberField key={c} path={['damage', c]} label={T.targetClasses[c]} compact />
                  ))}
                </div>
              </Frame>
              <Frame title={T.editor.sections.ew}>
                <div className="grid g4">
                  <NumberField path={['ew', 'jamming']} />
                  <NumberField path={['ew', 'jamResistance']} />
                  <NumberField path={['payload', 'slots']} />
                  <NumberField path={['payload', 'transport']} optional />
                </div>
              </Frame>
              <Frame title={T.editor.sections.sheet}>
                <div className="grid g3">
                  <TextField path={['sheet', 'engine']} nullable />
                  <TextField path={['sheet', 'speedLabel']} nullable />
                  <NumberField path={['sheet', 'rangeKm']} nullable />
                  <NumberField path={['sheet', 'lengthM']} nullable />
                  <NumberField path={['sheet', 'wingspanM']} nullable />
                  <NumberField path={['sheet', 'mtowKg']} nullable />
                  <NumberField path={['sheet', 'warheadKg']} nullable />
                </div>
              </Frame>
            </FormProvider>
          )}
        </div>

        <aside className="editor-side">
          <Frame title={T.editor.preview} accent>
            <WeaponCard system={d as never} />
          </Frame>
          <Frame title={isNew ? T.editor.create : T.editor.save} className="save-panel">
            {status}
            {!validation.ok && (
              <ul className="issues">
                {validation.issues.slice(0, 12).map((i, k) => (
                  <li key={k}>
                    <strong>{i.label}</strong> : {i.message}
                  </li>
                ))}
                {validation.issues.length > 12 && <li>…</li>}
              </ul>
            )}
            {validation.warnings.length > 0 && (
              <div className="warnings">
                <div className="small">{T.editor.warnings}</div>
                <ul>
                  {validation.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="field">
              <label htmlFor="commit">{T.editor.commitMessage}</label>
              <input
                id="commit"
                value={message}
                maxLength={500}
                placeholder={T.editor.commitPlaceholder}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            <fieldset className="field scope">
              <legend>{T.editor.scope}</legend>
              {(['new_games', 'running_games'] as const).map((s) => (
                <label key={s} className="radio">
                  <input
                    type="radio"
                    name="scope"
                    checked={scope === s}
                    onChange={() => setScope(s)}
                  />
                  <span className="radio-dot" aria-hidden />
                  {T.scope[s]}
                </label>
              ))}
              {scope === 'running_games' && (
                <small className="field-warn">{T.editor.scopeRunningWarn}</small>
              )}
            </fieldset>
            <div className="field">
              <label htmlFor="pmsg">{T.editor.playerMessage}</label>
              <textarea
                id="pmsg"
                rows={2}
                maxLength={500}
                value={playerMessage}
                placeholder={T.editor.playerPlaceholder}
                onChange={(e) => setPlayerMessage(e.target.value)}
              />
            </div>
            <Button
              variant="primary"
              className="save-btn"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? T.editor.saving : isNew ? T.editor.create : T.editor.save}
            </Button>
          </Frame>
        </aside>
      </div>

      <div className="save-sticky">
        {status}
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
          {saving ? T.editor.saving : isNew ? T.editor.create : T.editor.save}
        </Button>
      </div>

      {dupOpen && (
        <Dialog
          title={T.editor.duplicate}
          onClose={() => setDupOpen(false)}
          actions={
            <>
              <Button onClick={() => setDupOpen(false)}>{T.app.cancel}</Button>
              <Button
                variant="primary"
                disabled={!/^[a-z]{2,5}\.[a-z0-9-]+$/.test(dupId.trim())}
                onClick={() => void duplicate()}
              >
                {T.editor.duplicate}
              </Button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="dupid">{T.editor.duplicatePrompt}</label>
            <input
              id="dupid"
              className="mono"
              value={dupId}
              autoFocus
              onChange={(e) => setDupId(e.target.value)}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}
