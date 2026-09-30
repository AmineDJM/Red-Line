/** Scénarios : nations jouables et présentes, année, jeu d'ORBAT, caméra, surcharges d'équilibrage. */
import { useEffect, useMemo, useState } from 'react';
import { BalanceSchema, ScenarioFileSchema, type ScenarioFile } from '@redline/shared';
import { useCached, useSession } from '../context';
import { DataTable } from '../components/DataTable';
import { FormProvider, NumberField, TextField } from '../components/fields';
import { Nation } from '../components/Flag';
import { Dialog } from '../components/overlay';
import { ChipList, NationPicker } from '../components/pickers';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Icon,
  PageHead,
  SectionTitle,
  Seg,
  Spinner,
  Win,
} from '../components/term';
import { CommitBar, RevisionPanel } from '../components/versioning';
import { T, fmt } from '../i18n';
import { useNationMap, useNations } from '../lib/refs';
import { navigate } from '../lib/router';
import { useVersioned } from '../lib/useVersioned';

const LABELS: Record<string, string> = {
  name: T.scenarios.name,
  description: T.scenarios.description,
  year: T.scenarios.year,
  orbatSet: T.scenarios.orbatSet,
  playableNations: T.scenarios.playable,
  nationIds: T.scenarios.nations,
  camera: T.scenarios.camera,
  'camera.zoom': T.scenarios.zoom,
  balanceOverrides: T.scenarios.overrides,
};
const labelFor = (p: string) => LABELS[p] ?? LABELS[p.split('.')[0]!] ?? p;

/** Fusion profonde (même règle que le serveur : les objets se fusionnent, le reste remplace). */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!over || typeof over !== 'object' || Array.isArray(over))
    return over === undefined ? base : over;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

export function ScenariosScreen({ id }: { id?: string }) {
  const { api, cache } = useSession();
  const list = useCached('scenarios', () => api.listScenarios().then((r) => r.scenarios));
  const [newOpen, setNewOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const rows = list.data ?? [];
  return (
    <>
      <PageHead
        title={T.scenarios.title}
        sub={fmt(T.scenarios.sub, { n: rows.length })}
        actions={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={14} /> {T.scenarios.newScenario}
          </Button>
        }
      />
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      <div className={`tri ${id ? 'has-sel' : ''}`}>
        <Win title={T.scenarios.title} className="list-pane" cmd="Get-Scenario" flush>
          <DataTable
            rows={rows}
            rowKey={(s) => s.id}
            selected={id}
            bare
            onRowClick={(s) => navigate({ name: 'scenarios', id: s.id })}
            columns={[
              {
                key: 'n',
                label: T.scenarios.name,
                className: 'two',
                render: (s) => (
                  <>
                    <b className="bright">{s.name}</b>
                    <span className="sub">
                      {s.id} · {s.year}
                    </span>
                  </>
                ),
              },
              {
                key: 'p',
                label: 'Nations',
                align: 'right',
                width: 96,
                render: (s) =>
                  s.nationIds ? s.nationIds.length : <Badge tone="info">{T.scenarios.world}</Badge>,
              },
            ]}
          />
        </Win>
        {id ? (
          <ScenarioEditor key={id} id={id} onWritten={() => cache.invalidate('scenarios')} />
        ) : (
          <div className="detail-pane">
            <Win title={T.scenarios.title} glyph="?">
              <Empty glyph="⚑">{T.scenarios.select}</Empty>
            </Win>
          </div>
        )}
      </div>
      {newOpen && (
        <Dialog
          title={T.scenarios.newScenario}
          onClose={() => setNewOpen(false)}
          actions={
            <>
              <Button onClick={() => setNewOpen(false)}>{T.app.cancel}</Button>
              <Button
                variant="primary"
                disabled={!/^[a-z0-9-]{2,64}$/.test(newId) || rows.some((s) => s.id === newId)}
                onClick={() => {
                  setNewOpen(false);
                  navigate({ name: 'scenarios', id: newId });
                }}
              >
                {T.app.create}
              </Button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="new-sid">{T.scenarios.newId}</label>
            <input id="new-sid" value={newId} onChange={(e) => setNewId(e.target.value.trim())} />
          </div>
        </Dialog>
      )}
    </>
  );
}

function ScenarioEditor({ id, onWritten }: { id: string; onWritten: () => void }) {
  const { api } = useSession();
  const nations = useNations().data ?? [];
  const byId = useNationMap();
  const sets = useCached('orbat-sets', () => api.orbatSets().then((r) => r.sets));
  const rules = useCached('rules', () => api.getRules().then((r) => r.rules));
  const v = useVersioned<ScenarioFile>({
    key: id,
    load: () => api.scenario.get(id),
    save: (d, m) => api.scenario.save(id, d, m),
    revert: (r, m) => api.scenario.revert(id, r, m),
    reset: (m) => api.scenario.reset(id, m),
    schema: ScenarioFileSchema,
    labelFor,
    role: T.roles.balance,
    onWritten,
    blank: () => ({
      id,
      name: '',
      description: '',
      playableNations: 'all',
      year: 2025,
      orbatSet: '2025',
    }),
  });
  const d = v.draft;
  const [ovText, setOvText] = useState('');
  const [ovErr, setOvErr] = useState<string | null>(null);
  useEffect(() => {
    if (d) setOvText(d.balanceOverrides ? JSON.stringify(d.balanceOverrides, null, 2) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.original]);

  const merged = useMemo(() => {
    if (!d?.balanceOverrides || !rules.data) return null;
    const r = BalanceSchema.safeParse(deepMerge(rules.data, d.balanceOverrides));
    return r.success
      ? null
      : r.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join('.')} : ${i.message}`)
          .join(' ; ');
  }, [d?.balanceOverrides, rules.data]);

  if (v.error)
    return (
      <div className="detail-pane">
        <ErrorBox message={v.error} onRetry={() => void v.reload()} />
      </div>
    );
  if (!d)
    return (
      <div className="detail-pane">
        <Spinner />
      </div>
    );

  const playable = d.playableNations === 'all' ? null : d.playableNations;
  const present = d.nationIds ?? null;
  const warnings = [
    ...(merged ? [fmt(T.scenarios.overridesKo, { msg: merged })] : []),
    ...(ovErr ? [ovErr] : []),
  ];

  return (
    <FormProvider draft={d} set={v.set} errors={v.errors} changed={v.changed} labelFor={labelFor}>
      <div className="detail-pane stack">
        <div className="show-m">
          <Button small onClick={() => navigate({ name: 'scenarios' })}>
            <Icon name="back" size={12} /> {T.app.back}
          </Button>
        </div>
        <Win title={d.name || id} path={`Scenarios\\${id}`} cmd={`Get-Scenario ${id}`} glyph="⚑">
          <div className="grid g3">
            <TextField path={['name']} />
            <NumberField path={['year']} />
            <div className="field">
              <label htmlFor="orbatset">{T.scenarios.orbatSet}</label>
              <select
                id="orbatset"
                className="input"
                value={d.orbatSet}
                onChange={(e) => v.set(['orbatSet'], e.target.value)}
              >
                {[...new Set([d.orbatSet, ...Object.keys(sets.data ?? {})])].map((s) => (
                  <option key={s} value={s}>
                    {s} ({sets.data?.[s]?.length ?? 0})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <TextField path={['description']} multiline rows={4} />
          </div>

          <SectionTitle n={playable ? playable.length : '∞'}>{T.scenarios.playable}</SectionTitle>
          <Seg
            small
            value={playable ? 'list' : 'all'}
            onChange={(m) =>
              v.set(['playableNations'], m === 'all' ? 'all' : (present ?? []).slice(0, 12))
            }
            options={[
              ['all', T.scenarios.playableAll],
              ['list', T.scenarios.playableList],
            ]}
          />
          {playable && (
            <div style={{ marginTop: 10 }}>
              <ChipList
                values={playable}
                label={(n) => (
                  <Nation id={n} name={byId.get(n)?.name} color={byId.get(n)?.color} code={false} />
                )}
                onRemove={(n) =>
                  v.set(
                    ['playableNations'],
                    playable.filter((x) => x !== n),
                  )
                }
                picker={
                  <NationPicker
                    nations={nations}
                    exclude={new Set(playable)}
                    placeholder={T.scenarios.addNation}
                    onPick={(n) => v.set(['playableNations'], [...playable, n])}
                  />
                }
              />
            </div>
          )}

          <SectionTitle n={present ? present.length : '∞'}>{T.scenarios.nations}</SectionTitle>
          <Seg
            small
            value={present ? 'list' : 'all'}
            onChange={(m) => v.set(['nationIds'], m === 'all' ? undefined : (playable ?? []))}
            options={[
              ['all', T.scenarios.nationsAll],
              ['list', T.scenarios.nationsList],
            ]}
          />
          {present && (
            <div style={{ marginTop: 10 }}>
              <ChipList
                values={present}
                label={(n) => (
                  <Nation id={n} name={byId.get(n)?.name} color={byId.get(n)?.color} code={false} />
                )}
                onRemove={(n) =>
                  v.set(
                    ['nationIds'],
                    present.filter((x) => x !== n),
                  )
                }
                picker={
                  <NationPicker
                    nations={nations}
                    exclude={new Set(present)}
                    placeholder={T.scenarios.addNation}
                    onPick={(n) => v.set(['nationIds'], [...present, n])}
                  />
                }
              />
            </div>
          )}

          <SectionTitle>{T.scenarios.camera}</SectionTitle>
          {d.camera ? (
            <div className="grid g4">
              <NumberField path={['camera', 'center', 0]} label="Longitude" />
              <NumberField path={['camera', 'center', 1]} label="Latitude" />
              <NumberField path={['camera', 'zoom']} />
              <div className="field" style={{ justifyContent: 'flex-end' }}>
                <Button small variant="ghost" onClick={() => v.set(['camera'], undefined)}>
                  {T.app.remove}
                </Button>
              </div>
            </div>
          ) : (
            <Button small onClick={() => v.set(['camera'], { center: [15, 25], zoom: 1.6 })}>
              <Icon name="plus" size={12} /> {T.editor.enableSection}
            </Button>
          )}

          <SectionTitle>{T.scenarios.overrides}</SectionTitle>
          <p className="field-hint" style={{ marginBottom: 8 }}>
            {T.scenarios.overridesHint}
          </p>
          <textarea
            className="json-editor"
            style={{ minHeight: 140 }}
            spellCheck={false}
            aria-label={T.scenarios.overrides}
            placeholder='{ "victory": { "provinceShare": 0.5 } }'
            value={ovText}
            onChange={(e) => {
              setOvText(e.target.value);
              if (!e.target.value.trim()) {
                v.set(['balanceOverrides'], undefined);
                setOvErr(null);
                return;
              }
              try {
                v.set(['balanceOverrides'], JSON.parse(e.target.value));
                setOvErr(null);
              } catch (err) {
                setOvErr(
                  fmt(T.rules.invalidJson, {
                    msg: err instanceof Error ? err.message : String(err),
                  }),
                );
              }
            }}
          />
          {d.balanceOverrides && rules.data && !merged && (
            <p className="c-green small" style={{ marginTop: 6 }}>
              ✓ {T.scenarios.overridesOk}
            </p>
          )}
        </Win>
      </div>
      <div className="side-pane stack">
        <CommitBar
          valid={!!v.validation?.ok && !ovErr && !merged}
          issues={v.issues}
          changes={v.changes.length}
          dirty={v.dirty}
          busy={v.busy}
          isNew={v.isNew}
          warnings={warnings}
          onSave={v.save}
          onDiscard={v.discard}
          scopes={false}
        />
        {!v.isNew && (
          <RevisionPanel
            revisions={v.revisions}
            source={v.source}
            current={v.original}
            busy={v.busy}
            onRestore={(r) => void v.restore(r)}
            onReset={() => void v.reset()}
            labelFor={labelFor}
          />
        )}
      </div>
    </FormProvider>
  );
}
