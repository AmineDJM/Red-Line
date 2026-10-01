import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  CATEGORIES,
  DOCTRINES,
  MOVEMENT_KINDS,
  RESOURCES,
  TARGET_CLASSES,
  WeaponSystemSchema,
  type AdminSystem,
} from '@redline/shared';
import { useSession } from '../context';
import {
  CheckField,
  FormProvider,
  ListField,
  NumberField,
  SelectField,
  TextField,
  useFieldState,
} from '../components/fields';
import { Dialog, useToast } from '../components/overlay';
import { GatePicker } from '../components/pickers';
import { SchemaFields, SchemaProvider } from '../components/SchemaForm';
import {
  Badge,
  Button,
  ErrorBox,
  Icon,
  PageHead,
  SectionTitle,
  Seg,
  Spinner,
  Win,
} from '../components/term';
import { CommitBar } from '../components/versioning';
import { Photo, WeaponCard } from '../components/weapon';
import { T, fmt } from '../i18n';
import { diffObjects } from '../lib/diff';
import { errorMessage } from '../lib/errors';
import { hours, usd } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { clone, getIn, setIn, type Path } from '../lib/paths';
import { usePhotos, useResearch } from '../lib/refs';
import { href, navigate } from '../lib/router';
import { describe, initialValue, type SNode } from '../lib/schema';
import { blankSystem } from '../lib/template';
import { validateSystem } from '../lib/validation';

const opts = <K extends string>(keys: readonly K[], labels: Record<K, string>) =>
  keys.map((k) => [k, labels[k]] as const);
const SHAPE = (describe(WeaponSystemSchema) as SNode & { t: 'object' }).shape;
const BUILDINGS = (SHAPE.requiresBuilding as SNode & { t: 'enum' }).options;
const OPTIONAL = ['air', 'sensor', 'missile', 'interceptor', 'naval', 'space'] as const;
const fieldHelp = (k: string) => (T.fields[k] ? ([T.fields[k]] as [string]) : undefined);

/** Bloc facultatif du schéma (air, capteur, missile…) : activable, retirable. */
function OptSection({
  name,
  label,
  help,
  children,
}: {
  name: string;
  label: string;
  help: string;
  children?: ReactNode;
}) {
  const { f, value, errs, changed } = useFieldState([name]);
  const node = SHAPE[name]!;
  const present = value !== undefined;
  return (
    <div className={`optsec ${present ? '' : 'absent'}`}>
      <header>
        <b>{label}</b>
        {changed && <span className="c-amber tiny">●</span>}
        {errs.length > 0 && <Badge tone="crit">{errs.length}</Badge>}
        <span className="dim small grow ellipsis hide-m">{help}</span>
        <Button
          small
          variant={present ? 'ghost' : 'default'}
          onClick={() => f.set([name], present ? undefined : initialValue(node))}
        >
          {present ? (
            T.editor.disableSection
          ) : (
            <>
              <Icon name="plus" size={12} /> {T.editor.enableSection}
            </>
          )}
        </Button>
      </header>
      {present && (
        <div className="body">
          {children ??
            (node.t === 'object' && (
              <SchemaFields node={node} path={[name]} helpKey={name} depth={3} />
            ))}
        </div>
      )}
    </div>
  );
}

function GatesField() {
  const { f, value, changed, errs } = useFieldState(['requires']);
  const research = useResearch().data ?? [];
  return (
    <div className={`field field-wide ${changed ? 'field-changed' : ''}`}>
      <span className="field-label">{T.fields.requires}</span>
      <small className="field-hint">{T.editor.gatesHint}</small>
      {research.length ? (
        <GatePicker
          nodes={research}
          value={(value as string[]) ?? []}
          onChange={(v) => f.set(['requires'], v)}
        />
      ) : (
        <ListField path={['requires']} label="" />
      )}
      {errs.map((e) => (
        <small key={e} className="field-msg">
          {e}
        </small>
      ))}
    </div>
  );
}

export function EditorScreen({ id }: { id: string | null }) {
  const { api, cache } = useSession();
  const toast = useToast();
  const isNew = id === null;
  const photos = usePhotos().data ?? {};
  const research = useResearch().data;
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
  const [saving, setSaving] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupId, setDupId] = useState('');

  const validation = useMemo(() => validateSystem(draft), [draft]);
  const warnings = useMemo(() => {
    const w = [...validation.warnings];
    const req = (getIn(draft, ['requires']) as string[] | undefined) ?? [];
    if (research)
      for (const r of req)
        if (!research.some((n) => n.id === r)) w.push(fmt(T.editor.warnGate, { id: r }));
    return w;
  }, [validation, draft, research]);
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

  const save = async (meta: {
    message: string;
    scope: 'new_games' | 'running_games';
    playerMessage: string;
  }) => {
    if (!validation.ok) return false;
    setSaving(true);
    try {
      const body = {
        data: validation.value,
        message: meta.message.trim(),
        scope: meta.scope,
        ...(meta.playerMessage.trim() && meta.scope === 'running_games'
          ? { playerMessage: meta.playerMessage.trim() }
          : {}),
      };
      if (isNew) {
        const { system } = await api.createSystem(body);
        cache.invalidate('systems');
        toast(T.editor.created);
        navigate({ name: 'system', id: system.system.id });
        return true;
      }
      const { system } = await api.updateSystem(id, body);
      cache.invalidate('systems');
      setOriginal(system);
      setDraft(clone(system.system));
      if (mode === 'json') setJsonText(JSON.stringify(system.system, null, 2));
      toast(fmt(T.editor.saved, { n: system.revision }));
      return true;
    } catch (e) {
      toast(errorMessage(e, T.roles.balance), 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    if (!id) return;
    try {
      const { system } = await api.duplicateSystem(id, dupId.trim());
      cache.invalidate('systems');
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

  const d = draft as Record<string, unknown> & {
    photo?: unknown;
    unitPriceUsd?: number;
    unitSize?: number;
  };
  const sysId = String(d.id ?? '');
  const manifestPhoto = photos[sysId] ?? null;
  const photo = (d.photo as typeof manifestPhoto) ?? manifestPhoto;
  const title = isNew ? T.editor.newTitle : String(d.name || id);
  const price = typeof d.unitPriceUsd === 'number' ? d.unitPriceUsd : null;

  return (
    <>
      <PageHead
        crumbs={<a href={href({ name: 'catalog' })}>← {T.editor.back}</a>}
        title={title}
        sub={
          !isNew ? `${id} · ${fmt(T.editor.revision, { n: original?.revision ?? '—' })}` : undefined
        }
        actions={
          <>
            <Seg
              value={mode}
              onChange={switchMode}
              options={[
                ['form', T.editor.form],
                ['json', T.editor.json],
              ]}
            />
            {!isNew && (
              <>
                <Button onClick={() => navigate({ name: 'history', id: id })}>
                  <Icon name="history" size={14} /> {T.editor.history}
                </Button>
                <Button
                  onClick={() => {
                    setDupId(`${id}-copie`);
                    setDupOpen(true);
                  }}
                >
                  <Icon name="copy" size={14} /> {T.editor.duplicate}
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="split-side">
        <div className="stack">
          {mode === 'json' ? (
            <Win title={T.editor.json} cmd={`Get-Content ${sysId || 'new'}.json`}>
              <p className="muted small">{T.editor.jsonHint}</p>
              <textarea
                className="json-editor"
                spellCheck={false}
                value={jsonText}
                onChange={(e) => onJson(e.target.value)}
                aria-label={T.editor.json}
              />
              {jsonError && <ErrorBox message={jsonError} />}
            </Win>
          ) : (
            <FormProvider
              draft={draft}
              set={set}
              errors={errors}
              changed={changed}
              readOnly={isNew ? undefined : new Set(['id'])}
            >
              <SchemaProvider env={{ help: fieldHelp, openDepth: 5 }}>
                <Win title={T.editor.sections.identity} glyph="#">
                  <div className="grid g3">
                    <TextField path={['id']} placeholder="us.f-16" />
                    <TextField path={['name']} />
                    <TextField path={['origin']} />
                    <SelectField
                      path={['doctrine']}
                      options={DOCTRINES.map((k) => [k, `${T.doctrines[k]} (${k})`] as const)}
                    />
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
                    <TextField path={['icon']} />
                    <TextField
                      path={['unitLabel']}
                      optional
                      placeholder="appareil, char, bataillon…"
                    />
                    <ListField path={['roles']} wide />
                  </div>
                </Win>
                <Win title={T.editor.sections.economy} glyph="$">
                  <div className="grid g4">
                    <NumberField path={['unitPriceUsd']} optional affix={usd} />
                    <NumberField path={['unitSize']} />
                    <NumberField path={['cost', 'money']} affix={usd} />
                    <NumberField path={['upkeepPerDay']} affix={usd} />
                    <NumberField path={['buildTimeH']} affix={hours} />
                    <SelectField
                      path={['requiresBuilding']}
                      optional
                      options={BUILDINGS.map(
                        (b) => [b, T.buildings[b as keyof typeof T.buildings] ?? b] as const,
                      )}
                    />
                    {RESOURCES.map((r) => (
                      <NumberField
                        key={r}
                        path={['cost', 'resources', r]}
                        optional
                        label={`${T.resources[r]} (coût)`}
                      />
                    ))}
                  </div>
                  {price !== null && (
                    <div className="row" style={{ marginTop: 10 }}>
                      <Button
                        small
                        onClick={() =>
                          set(
                            ['cost', 'money'],
                            price * (typeof d.unitSize === 'number' ? d.unitSize : 1),
                          )
                        }
                      >
                        {T.editor.recompute}
                      </Button>
                    </div>
                  )}
                </Win>
                <Win title={T.editor.sections.flags} glyph="⚑">
                  <div className="grid g4">
                    <CheckField path={['enabled']} />
                    <CheckField path={['canCapture']} />
                    <CheckField path={['licensable']} />
                    <CheckField path={['exportable']} />
                    <CheckField path={['generic']} />
                  </div>
                  <div className="grid" style={{ marginTop: 12 }}>
                    <GatesField />
                  </div>
                </Win>
                <Win title={T.editor.sections.mobility} glyph="⇢">
                  <div className="grid g3">
                    <NumberField path={['speedKmh']} />
                    <NumberField path={['operationalRadiusKm']} nullable />
                    <NumberField path={['detectionRangeKm']} />
                    <NumberField path={['weaponRangeKm', 'min']} />
                    <NumberField path={['weaponRangeKm', 'max']} />
                  </div>
                </Win>
                <Win title={T.editor.sections.combat} glyph="✦">
                  <div className="grid g4">
                    <NumberField path={['hp']} />
                    <NumberField path={['armor']} />
                    <NumberField path={['stealth']} />
                    <NumberField path={['ew', 'jamming']} />
                    <NumberField path={['ew', 'jamResistance']} />
                    <NumberField path={['payload', 'slots']} />
                    <NumberField path={['payload', 'transport']} optional />
                  </div>
                  <SectionTitle>{T.editor.sections.damage}</SectionTitle>
                  <div className="grid g3">
                    {TARGET_CLASSES.map((c) => (
                      <NumberField
                        key={c}
                        path={['damage', c]}
                        label={T.targetClasses[c]}
                        compact
                      />
                    ))}
                  </div>
                </Win>
                <Win title={T.editor.sections.specific} glyph="⚙">
                  <div className="stack-sm">
                    <OptSection
                      name="era"
                      label={T.editor.optional.era![0]}
                      help={T.editor.optional.era![1]}
                    />
                    {OPTIONAL.map((k) => (
                      <OptSection
                        key={k}
                        name={k}
                        label={T.editor.optional[k]![0]}
                        help={T.editor.optional[k]![1]}
                      />
                    ))}
                  </div>
                </Win>
                <Win title={T.editor.sections.photo} glyph="▣">
                  <div className="grid g2">
                    <div className="stack-sm">
                      <span className="field-label">{T.editor.photoManifest}</span>
                      <Photo photo={manifestPhoto} alt={String(d.name ?? '')} />
                      {manifestPhoto && !d.photo && (
                        <Button
                          small
                          onClick={() =>
                            set(['photo'], {
                              file: manifestPhoto.file,
                              credit: manifestPhoto.credit,
                              license: manifestPhoto.license,
                              sourceUrl: manifestPhoto.sourceUrl,
                            })
                          }
                        >
                          {T.editor.photoUseManifest}
                        </Button>
                      )}
                    </div>
                    <div className="stack-sm">
                      <OptSection name="photo" label={T.editor.photoOverride} help="" />
                    </div>
                  </div>
                </Win>
                <Win title={T.editor.sections.sheet} glyph="≡">
                  <div className="grid g3">
                    <TextField path={['sheet', 'engine']} nullable />
                    <TextField path={['sheet', 'speedLabel']} nullable />
                    <NumberField path={['sheet', 'rangeKm']} nullable />
                    <NumberField path={['sheet', 'lengthM']} nullable />
                    <NumberField path={['sheet', 'wingspanM']} nullable />
                    <NumberField path={['sheet', 'mtowKg']} nullable />
                    <NumberField path={['sheet', 'warheadKg']} nullable />
                  </div>
                </Win>
              </SchemaProvider>
            </FormProvider>
          )}
        </div>
        <aside className="stack sticky-col">
          <CommitBar
            valid={validation.ok && !jsonError}
            issues={validation.issues}
            changes={changes.length}
            dirty={isNew || changes.length > 0}
            busy={saving}
            isNew={isNew}
            warnings={warnings}
            saveLabel={isNew ? T.editor.create : T.editor.save}
            onSave={save}
            onDiscard={original ? () => setDraft(clone(original.system)) : undefined}
            onIssueClick={(p) => document.getElementById(p)?.focus()}
          />
          <Win title={T.editor.preview} glyph="◆" accent>
            <WeaponCard system={d as never} photo={photo} />
          </Win>
        </aside>
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
              value={dupId}
              onChange={(e) => setDupId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void duplicate()}
            />
          </div>
        </Dialog>
      )}
    </>
  );
}
