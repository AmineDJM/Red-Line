import { useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  OP_AFTER,
  type CampaignView,
  type CommandView,
  type OpAfter,
  type WaitView,
} from '@redline/shared';
import { Badge, Button, Icon, Segmented, Select, type Tone } from '@redline/ui';
import { NationTag } from '../components/Common.js';
import { fmtClock } from '../i18n/index.js';
import { nationName } from '../lib/game.js';
import { chainOf, etaFor, goalCatalog } from '../lib/ops.js';
import { useCommandUi, type PhaseDraft } from '../store/command.js';
import { useGame } from '../store/game.js';
import { useSend } from './armyCommand.js';
import { etaLabel } from './CommandGenerals.js';
import { CAT_ICON, GOAL_ICON } from './opsIcons.js';

/**
 * Plan d'une opération : phases enchaînées (le planificateur passe à la suivante quand la précédente
 * est réussie ou à son échéance), « quand c'est fini » (tenir les gains, rentrer à la base, réserve),
 * et ce qu'attend chaque général (avec le bouton qui le débloque).
 */

const HOURS = [6, 12, 24, 48, 72, 168];

function goalName(t: (k: string, o?: Record<string, unknown>) => string, g: string): string {
  return t(`command.ops.goals.${g}.name`, { defaultValue: g });
}

/** Choix d'un objectif de phase : catalogue compact par catégorie. */
function PhasePicker({
  command,
  onPick,
  onClose,
}: {
  command: CommandView;
  onPick: (goal: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const cats = goalCatalog(command);
  return (
    <div className="ops-ppick" data-testid="op-phase-picker">
      <header className="ops-ppick__head">
        <b>{t('command.ops.plan.pickPhase')}</b>
        <span className="cmd-detail__spacer" />
        <button
          type="button"
          className="cmd-icon-btn"
          onClick={onClose}
          aria-label={t('app.close')}
        >
          <Icon name="close" size={12} />
        </button>
      </header>
      {cats.map(({ cat, goals }) => (
        <section key={cat} className="ops-ppick__cat">
          <h5>
            <Icon name={CAT_ICON[cat]} size={11} /> {t(`command.ops.cat.${cat}`)}
          </h5>
          <div className="ops-ppick__list">
            {goals.map(([id]) => (
              <button
                key={id}
                type="button"
                className="ops-ppick__goal"
                onClick={() => onPick(id)}
                data-testid={`op-phase-goal-${id}`}
              >
                <Icon name={GOAL_ICON[id] ?? 'target'} size={12} />
                {goalName(t, id)}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** « Quand c'est fini » : tenir les gains, rentrer à la base, réserve. */
export function AfterChoice({
  value,
  onChange,
  size = 'sm',
}: {
  value: OpAfter;
  onChange: (v: OpAfter) => void;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  return (
    <div className="ops-after" data-testid="op-after">
      <span className="cmd-param__label">{t('command.ops.after.label')}</span>
      <Segmented<OpAfter>
        size={size}
        label={t('command.ops.after.label')}
        value={value}
        onChange={onChange}
        options={OP_AFTER.map((v) => ({
          value: v,
          label: t(`command.ops.after.${v}`),
          title: t(`command.ops.after.${v}Help`),
        }))}
      />
      <p className="cmd-hint">{t(`command.ops.after.${value}Help`)}</p>
    </div>
  );
}

/**
 * Étape « Plan » de l'assistant : phase 1 (objectif choisi, déplié s'il est composé), phases
 * suivantes à ajouter, ordonner (glisser-déposer, flèches) et borner dans le temps, puis le
 * comportement final.
 */
export function PlanStep({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const d = useCommandUi((s) => s.opDraft)!;
  const patchOp = useCommandUi((s) => s.patchOp);
  const [picking, setPicking] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const set = (phases: PhaseDraft[]) => patchOp({ phases });
  const move = (i: number, j: number) => {
    if (j < 0 || j >= d.phases.length || i === j) return;
    const next = [...d.phases];
    const [x] = next.splice(i, 1);
    next.splice(j, 0, x!);
    set(next);
  };
  const first = chainOf(command, d.goal, []);
  const all = chainOf(command, d.goal, d.phases);
  let eta = 0;
  for (const p of all) eta += p.hours ?? etaFor(p.goal, 4) ?? 24;
  const nations = useGame((s) => s.view?.nations ?? {});
  const hot = Object.keys(command.estimates ?? {})
    .filter((n) => nations[n]?.alive !== false)
    .slice(0, 24);
  const targetOptions = [
    { value: '', label: t('command.ops.plan.sameTargets') },
    ...hot.map((n) => ({ value: n, label: nationName(n) })),
  ];
  const onDrop = (e: DragEvent, j: number) => {
    e.preventDefault();
    if (drag !== null) move(drag, j);
    setDrag(null);
  };
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step'} data-testid="op-plan">
      <p className="cmd-lead">{t('command.ops.plan.lead')}</p>
      <ol className="ops-chain" data-testid="op-chain">
        {first.map((p, i) => (
          <li key={`f${i}`} className="ops-chain__row is-first">
            <span className="ops-chain__n">{i + 1}</span>
            <span className="ops-goal-icon">
              <Icon name={GOAL_ICON[p.goal] ?? 'target'} size={13} />
            </span>
            <span className="ops-chain__name">
              <b>{goalName(t, p.goal)}</b>
              <small>
                {p.preset
                  ? t('command.ops.plan.presetPart', { name: goalName(t, p.preset) })
                  : t('command.ops.plan.firstTargets')}
              </small>
            </span>
            {i === first.length - 1 && !p.preset && d.phases.length ? (
              <span className="ops-chain__opts">
                <Select
                  label={t('command.ops.plan.timebox')}
                  value={String(d.phaseHours ?? '')}
                  onChange={(v) => patchOp({ phaseHours: v ? Number(v) : null })}
                  data-testid="op-phase-timebox-first"
                  options={[
                    { value: '', label: t('command.ops.plan.untilDone') },
                    ...HOURS.map((h) => ({ value: String(h), label: etaLabel(h) })),
                  ]}
                />
              </span>
            ) : p.hours ? (
              <span className="cmd-chip">{etaLabel(p.hours)}</span>
            ) : null}
          </li>
        ))}
        {d.phases.map((p, i) => (
          <li
            key={`p${i}-${p.goal}`}
            className={drag === i ? 'ops-chain__row is-drag' : 'ops-chain__row'}
            draggable={!mobile}
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(e, i)}
            onDragEnd={() => setDrag(null)}
            data-testid={`op-phase-${i}`}
          >
            <span className="ops-chain__n" title={t('command.ops.plan.drag')}>
              {first.length + i + 1}
            </span>
            <span className="ops-goal-icon">
              <Icon name={GOAL_ICON[p.goal] ?? 'target'} size={13} />
            </span>
            <span className="ops-chain__name">
              <b>{goalName(t, p.goal)}</b>
              <small>{t(`command.ops.goals.${p.goal}.desc`, { defaultValue: '' })}</small>
            </span>
            <span className="ops-chain__opts">
              <Select
                label={t('command.ops.plan.targets')}
                value={p.nations?.[0] ?? ''}
                onChange={(v) =>
                  set(
                    d.phases.map((x, k) =>
                      k === i
                        ? v
                          ? { goal: x.goal, nations: [v], ...(x.hours ? { hours: x.hours } : {}) }
                          : { goal: x.goal, ...(x.hours ? { hours: x.hours } : {}) }
                        : x,
                    ),
                  )
                }
                options={targetOptions}
              />
              <Select
                label={t('command.ops.plan.timebox')}
                value={String(p.hours ?? '')}
                onChange={(v) =>
                  set(
                    d.phases.map((x, k) => {
                      if (k !== i) return x;
                      const { hours: _h, ...rest } = x;
                      return v ? { ...rest, hours: Number(v) } : rest;
                    }),
                  )
                }
                options={[
                  { value: '', label: t('command.ops.plan.untilDone') },
                  ...HOURS.map((h) => ({ value: String(h), label: etaLabel(h) })),
                ]}
              />
              <span className="ops-chain__moves">
                <button
                  type="button"
                  className="cmd-icon-btn"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                  aria-label={t('command.ops.plan.up')}
                  title={t('command.ops.plan.up')}
                >
                  <Icon name="chevronUp" size={12} />
                </button>
                <button
                  type="button"
                  className="cmd-icon-btn"
                  disabled={i === d.phases.length - 1}
                  onClick={() => move(i, i + 1)}
                  aria-label={t('command.ops.plan.down')}
                  title={t('command.ops.plan.down')}
                >
                  <Icon name="chevronDown" size={12} />
                </button>
                <button
                  type="button"
                  className="cmd-icon-btn"
                  onClick={() => set(d.phases.filter((_, k) => k !== i))}
                  aria-label={t('command.ops.plan.remove')}
                  title={t('command.ops.plan.remove')}
                  data-testid={`op-phase-remove-${i}`}
                >
                  <Icon name="trash" size={12} />
                </button>
              </span>
            </span>
          </li>
        ))}
      </ol>
      {picking ? (
        <PhasePicker
          command={command}
          onClose={() => setPicking(false)}
          onPick={(goal) => {
            set([...d.phases, { goal }]);
            setPicking(false);
          }}
        />
      ) : (
        <Button
          size={mobile ? 'md' : 'sm'}
          variant="ghost"
          icon={<Icon name="plus" size={12} />}
          disabled={all.length >= 6}
          onClick={() => setPicking(true)}
          data-testid="op-phase-add"
        >
          {t('command.ops.plan.add')}
        </Button>
      )}
      <p className="cmd-hint">
        <Icon name="info" size={11} /> {t('command.ops.plan.rule')}
        {all.length > 1 ? ` ${t('command.ops.plan.total', { eta: etaLabel(eta) })}` : ''}
      </p>
      <AfterChoice value={d.after} onChange={(after) => patchOp({ after })} />
    </div>
  );
}

const RESULT_TONE: Record<string, Tone> = {
  success: 'green',
  timeout: 'amber',
  skipped: 'neutral',
};

/** Tableau de bord : phases de l'opération (faite, en cours, à venir), suivante, comportement final. */
export function PhasesPanel({ op, closed }: { op: CampaignView; closed: boolean }) {
  const { t } = useTranslation();
  const send = useSend();
  const startOp = useCommandUi((s) => s.startOp);
  const phases = op.phases ?? [
    {
      goal: op.goal,
      nations: op.nations,
      state: closed ? ('done' as const) : ('current' as const),
      ...(closed
        ? { result: op.status === 'success' ? ('success' as const) : ('timeout' as const) }
        : {}),
    },
  ];
  const step = op.step ?? 0;
  const next = phases[step + 1];
  const editPhases = () =>
    startOp({
      mode: 'phases',
      opId: op.id,
      steps: ['plan', 'confirm'],
      goal: op.goal,
      nations: op.nations,
      provinces: op.provinces ?? [],
      aggr: op.aggr,
      roe: op.roe,
      name: op.name,
      after: op.after ?? 'hold',
      phases: phases.slice(step + 1).map((p) => ({
        goal: p.goal,
        ...(JSON.stringify(p.nations) !== JSON.stringify(op.nations) ? { nations: p.nations } : {}),
        ...(p.hours ? { hours: p.hours } : {}),
      })),
    });
  return (
    <section className="cmd-panel ops-phases" data-testid="op-phases">
      <h4 className="cmd-panel__title">
        {t('command.ops.plan.title')}
        <span>
          {phases.length > 1
            ? t('command.ops.plan.phaseOf', {
                n: Math.min(step + 1, phases.length),
                total: phases.length,
              })
            : t('command.ops.plan.single')}
        </span>
      </h4>
      <ol className="ops-timeline">
        {phases.map((p, i) => (
          <li
            key={`${i}-${p.goal}`}
            className={`ops-timeline__step ops-timeline__step--${p.state}`}
            data-testid={`op-timeline-${i}`}
          >
            <span className="ops-timeline__dot" aria-hidden>
              {p.state === 'done' ? <Icon name="check" size={10} /> : i + 1}
            </span>
            <span className="ops-timeline__body">
              <b>
                <Icon name={GOAL_ICON[p.goal] ?? 'target'} size={12} /> {goalName(t, p.goal)}
              </b>
              <small>
                {p.nations.map((n) => (
                  <NationTag key={n} id={n} size={10} />
                ))}
                {p.hours ? ` · ${t('command.ops.plan.within', { eta: etaLabel(p.hours) })}` : ''}
              </small>
            </span>
            {p.result ? (
              <Badge tone={RESULT_TONE[p.result] ?? 'neutral'} variant="outline">
                {t(`command.ops.plan.result.${p.result}`)}
              </Badge>
            ) : p.state === 'current' ? (
              <Badge tone="cyan" dot pulse>
                {t('command.ops.plan.now')}
              </Badge>
            ) : null}
          </li>
        ))}
      </ol>
      {!closed && op.phaseUntil ? (
        <p className="cmd-hint">
          <Icon name="clock" size={11} />{' '}
          {t('command.ops.plan.until', { ...fmtClock(op.phaseUntil) })}
        </p>
      ) : null}
      <div className="ops-phases__next">
        <span>
          <small>{t('command.ops.plan.next')}</small>
          <b data-testid="op-next-phase">
            {next ? goalName(t, next.goal) : t(`command.ops.after.${op.after ?? 'hold'}`)}
          </b>
        </span>
        {!closed && next ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="forward" size={11} />}
            onClick={() =>
              void send(
                { kind: 'campaignEdit', opId: op.id, nextPhase: true },
                t('command.ops.toast.nextPhase'),
              )
            }
            data-testid="op-skip-phase"
          >
            {t('command.ops.plan.skip')}
          </Button>
        ) : null}
        {!closed ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="edit" size={11} />}
            onClick={editPhases}
            data-testid="op-edit-phases"
          >
            {t('command.ops.plan.edit')}
          </Button>
        ) : null}
      </div>
      {!closed ? (
        <AfterChoice
          value={op.after ?? 'hold'}
          onChange={(after) =>
            void send({ kind: 'campaignEdit', opId: op.id, after }, t('command.toast.saved'))
          }
        />
      ) : null}
    </section>
  );
}

const WAIT_TONE: Partial<Record<WaitView['reason'], Tone>> = {
  war: 'amber',
  strike: 'amber',
  reinforce: 'amber',
  suspended: 'neutral',
  staging: 'cyan',
  manual: 'cyan',
  fuel: 'cyan',
  resting: 'cyan',
  noForces: 'red',
  noTargets: 'amber',
  noGeneral: 'red',
  wounded: 'amber',
};

export interface WaitAction {
  label: string;
  run: () => void;
  testId?: string;
}

/** « En attente de… » : raison lisible et bouton qui la lève. */
export function WaitLine({
  wait,
  actions,
  compact,
}: {
  wait: WaitView;
  actions: Partial<Record<WaitView['reason'], WaitAction>>;
  compact?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const a = actions[wait.reason];
  const until = wait.until !== undefined ? fmtClock(wait.until) : null;
  return (
    <div className={compact ? 'cmd-wait cmd-wait--compact' : 'cmd-wait'} data-testid="cmd-wait">
      <Badge tone={WAIT_TONE[wait.reason] ?? 'neutral'} variant="outline">
        {t('command.wait.badge')}
      </Badge>
      <span className="cmd-wait__text">
        {t(`command.wait.${wait.reason}`, {
          count: wait.count ?? 0,
          nation: wait.nationId ? nationName(wait.nationId) : '',
          day: until?.day ?? '',
          time: until?.time ?? '',
        })}
      </span>
      {a ? (
        <Button
          size="sm"
          variant="primary"
          onClick={a.run}
          data-testid={a.testId ?? `wait-${wait.reason}`}
        >
          {a.label}
        </Button>
      ) : null}
    </div>
  );
}
