import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BRANCHES,
  BRANCH_SKILL,
  type Aggressiveness,
  type Branch,
  type CampaignView,
  type CommandGeneralView,
  type CommandView,
  type OpCommanderInput,
  type Order,
  type Roe,
} from '@redline/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  Input,
  ProgressBar,
  Segmented,
  Select,
  formatInt,
  formatMoney,
  type IconName,
  type Tone,
} from '@redline/ui';
import { NationTag } from '../components/Common.js';
import { fmtClock, i18n } from '../i18n/index.js';
import { centroidOf, generalOf, journalText, pileValue, ratioText } from '../lib/command.js';
import { nationName, provinceName } from '../lib/game.js';
import {
  allCandidates,
  branchFit,
  branchOfGeneral,
  freeByBranch,
  freeGenerals,
  goalList,
  opHeadline,
  previewOp,
  staffGeneral,
  suggestStaff,
  type OpPreview,
  type StaffPick,
} from '../lib/ops.js';
import { useCommandUi, type OpDraft, type OpStep } from '../store/command.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useSend } from './armyCommand.js';
import { GeneralAvatar, Stars, etaLabel } from './CommandGenerals.js';

/**
 * Opérations (fenêtre QG) : liste des opérations et tableau de bord (progression chiffrée par
 * objectif, généraux et leurs rôles, journal, Renforcer / Suspendre / Changer d'objectif / Annuler),
 * assistant « Nouvelle opération » en quatre étapes : pays cibles (carte ou recherche), objectif
 * (cartes avec estimation), généraux par commandement (vivier, rôles, forces), confirmation.
 */

export const GOAL_ICON: Record<string, IconName> = {
  attrition: 'bolt',
  air_control: 'radio',
  conquest: 'flag',
  decapitation: 'crown',
  strategic: 'factory',
  sead: 'missile',
  blockade: 'anchor',
  defend_border: 'shield',
  occupy: 'mapPin',
};

export const BRANCH_ICON: Record<Branch, IconName> = {
  land: 'army',
  air: 'radio',
  sea: 'anchor',
  ad: 'shield',
};

const STATUS_TONE: Record<CampaignView['status'], Tone> = {
  planning: 'cyan',
  active: 'green',
  holding: 'green',
  awaiting: 'amber',
  suspended: 'neutral',
  success: 'green',
  failed: 'red',
};

function OpStatus({ op }: { op: CampaignView }) {
  const { t } = useTranslation();
  return (
    <Badge
      tone={STATUS_TONE[op.status]}
      dot
      pulse={op.status === 'active' || op.status === 'awaiting'}
    >
      {t(`command.ops.status.${op.status}`)}
    </Badge>
  );
}

function Targets({ op, size = 11 }: { op: CampaignView; size?: number }) {
  const { t } = useTranslation();
  return (
    <span className="ops-targets">
      {op.nations.map((n) => (
        <NationTag key={n} id={n} size={size} />
      ))}
      {op.provinces?.length ? (
        <span className="cmd-chip">
          {t('command.ops.provinces', { count: op.provinces.length })}
        </span>
      ) : null}
    </span>
  );
}

function headline(op: CampaignView, t: (k: string, o?: Record<string, unknown>) => string) {
  const h = opHeadline(op);
  return t(h.key, h.params);
}

function OpRow({ op, sel, onClick }: { op: CampaignView; sel: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        type="button"
        className={sel ? 'cmd-row cmd-row--sel ops-row' : 'cmd-row ops-row'}
        onClick={onClick}
        aria-pressed={sel}
        data-testid={`op-row-${op.id}`}
      >
        <span className="cmd-row__top">
          <span className={`ops-goal-icon ops-goal-icon--${op.goal}`}>
            <Icon name={GOAL_ICON[op.goal] ?? 'target'} size={13} />
          </span>
          <b className="cmd-row__name">{op.name}</b>
          {op.request ? (
            <Badge tone="amber" variant="solid">
              {t('command.request.badge')}
            </Badge>
          ) : (
            <OpStatus op={op} />
          )}
        </span>
        <span className="cmd-row__mission">
          {t(`command.ops.goals.${op.goal}.name`, { defaultValue: op.goal })} ·{' '}
          <Targets op={op} size={10} />
        </span>
        <span className="ops-row__progress">
          <ProgressBar
            value={op.pct}
            tone={op.status === 'failed' ? 'red' : 'green'}
            label={headline(op, t)}
          />
          <small>{headline(op, t)}</small>
        </span>
        <span className="cmd-row__bottom">
          <span className="cmd-row__gen">
            <Icon name="star" size={11} />
            {t('command.ops.generals', { count: op.commanders.length })}
          </span>
          <span className="cmd-row__n">
            {op.commanders.map((c) => (
              <Icon key={c.armyId} name={BRANCH_ICON[c.role]} size={11} />
            ))}
          </span>
        </span>
      </button>
    </li>
  );
}

// ——— Tableau de bord ———

function OpRequest({ op }: { op: CampaignView }) {
  const { t } = useTranslation();
  const send = useSend();
  const r = op.request!;
  const answer = (accept: boolean) =>
    void send(
      { kind: 'campaignAnswer', opId: op.id, requestId: r.id, accept },
      accept ? t('command.request.accepted') : t('command.request.refused'),
    );
  return (
    <div className="cmd-request" role="alert" data-testid="op-request">
      <Icon name="warning" size={16} />
      <div className="cmd-request__text">
        <b>{t('command.request.declare_war.title')}</b>
        <span>{t('command.ops.askWar', { nation: nationName(r.nationId) })}</span>
      </div>
      <div className="cmd-request__actions">
        <Button size="sm" variant="ghost" onClick={() => answer(false)}>
          {t('command.request.refuse')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => answer(true)}
          data-testid="op-request-accept"
        >
          {t('command.request.declare_war.accept')}
        </Button>
      </div>
    </div>
  );
}

function ProgressPanel({ op }: { op: CampaignView }) {
  const { t } = useTranslation();
  return (
    <section className="cmd-panel ops-progress" data-testid="op-progress">
      <h4 className="cmd-panel__title">
        {t('command.ops.progress')}
        <span>{t(`command.ops.phase.${op.phase}`)}</span>
      </h4>
      <div className="ops-headline">
        <b data-testid="op-headline">{headline(op, t)}</b>
        <span className="ops-headline__pct">{Math.round(op.pct * 100)} %</span>
      </div>
      <ProgressBar
        value={op.pct}
        size="md"
        tone={op.status === 'failed' ? 'red' : op.status === 'holding' ? 'cyan' : 'green'}
        label={t('command.ops.progress')}
      />
      <ul className="ops-metrics">
        {op.progress.map((m) => (
          <li key={m.key}>
            <span>{t(`command.ops.metrics.${m.key}`)}</span>
            {m.key === 'forces' ? (
              <b>
                {formatMoney(m.done)} <small>/ {formatMoney(m.total)}</small>
              </b>
            ) : (
              <b>
                {formatInt(m.done)} <small>/ {formatInt(m.total)}</small>
              </b>
            )}
          </li>
        ))}
      </ul>
      {op.estimate ? (
        <div className="cmd-est">
          <div>
            <span>{t('command.est.ratio')}</span>
            <b
              className={
                op.estimate.ratio >= 1.5 ? 'is-good' : op.estimate.ratio >= 1 ? 'is-warn' : 'is-bad'
              }
            >
              {op.estimate.ratio >= 99 ? '—' : ratioText(op.estimate.ratio, i18n.language)}
            </b>
          </div>
          <div>
            <span>{t('command.est.eta')}</span>
            <b>{etaLabel(op.estimate.etaHours)}</b>
          </div>
          <div>
            <span>{t('command.est.chance')}</span>
            <b
              className={
                op.estimate.chance >= 0.65
                  ? 'is-good'
                  : op.estimate.chance >= 0.4
                    ? 'is-warn'
                    : 'is-bad'
              }
            >
              {Math.round(op.estimate.chance * 100)} %
            </b>
          </div>
        </div>
      ) : null}
      <div className="ops-stats">
        <span>
          <small>{t('command.ops.stats.strikes')}</small>
          <b>{formatInt(op.stats.strikes)}</b>
        </span>
        <span>
          <small>{t('command.ops.stats.captures')}</small>
          <b>{formatInt(op.stats.captures)}</b>
        </span>
        <span>
          <small>{t('command.ops.stats.kills')}</small>
          <b className="is-good">{formatMoney(op.stats.kills)}</b>
        </span>
        <span>
          <small>{t('command.ops.stats.losses')}</small>
          <b className={op.stats.losses ? 'is-bad' : ''}>{formatInt(op.stats.losses)}</b>
        </span>
        <span>
          <small>{t('command.ops.stats.strength')}</small>
          <b>{op.value.start > 0 ? Math.round((100 * op.value.now) / op.value.start) : 100} %</b>
        </span>
      </div>
    </section>
  );
}

function StaffPanel({ op, command }: { op: CampaignView; command: CommandView }) {
  const { t } = useTranslation();
  const send = useSend();
  const closed = op.status === 'success' || op.status === 'failed';
  return (
    <section className="cmd-panel" data-testid="op-staff">
      <h4 className="cmd-panel__title">
        {t('command.ops.staff')}
        <span>{t('command.ops.generals', { count: op.commanders.length })}</span>
      </h4>
      <ul className="ops-staff">
        {op.commanders.map((c) => {
          const g = generalOf(command, c.generalId);
          const army = command.armies.find((a) => a.id === c.armyId);
          return (
            <li key={c.armyId} className="ops-staff__row" data-testid={`op-commander-${c.armyId}`}>
              {g ? <GeneralAvatar g={g} size={38} /> : <Icon name="user" size={20} />}
              <div className="ops-staff__id">
                <b>{g ? `${g.first} ${g.last}` : t('command.noGeneral')}</b>
                <span>
                  <Badge tone="cyan" variant="outline">
                    <Icon name={BRANCH_ICON[c.role]} size={10} />{' '}
                    {t(`command.branch.${c.role}.role`)}
                  </Badge>
                  {c.sector && c.sector !== 'all' ? (
                    <span className="cmd-chip">
                      {t(`command.ops.sector.${c.sector}`)} ·{' '}
                      {t('command.ops.sectorLeft', { left: c.sectorLeft, total: c.sectorTotal })}
                    </span>
                  ) : null}
                </span>
                <small>
                  {army?.name ?? ''} · {t('command.piles', { count: c.piles })} ·{' '}
                  {formatMoney(c.value)}
                </small>
              </div>
              <span className={`ops-staff__status ops-staff__status--${c.status}`}>
                {t(`command.status.${c.status}`)}
              </span>
              {closed ? null : (
                <span className="ops-staff__actions">
                  <Select
                    label={t('command.ops.role')}
                    value={c.role}
                    onChange={(v) =>
                      void send(
                        {
                          kind: 'campaignForces',
                          opId: op.id,
                          roles: [{ armyId: c.armyId, role: v as Branch }],
                        },
                        t('command.toast.saved'),
                      )
                    }
                    options={BRANCHES.map((b) => ({
                      value: b,
                      label: t(`command.branch.${b}.role`),
                    }))}
                  />
                  <button
                    type="button"
                    className="cmd-icon-btn"
                    aria-label={t('command.ops.release')}
                    title={t('command.ops.release')}
                    onClick={() =>
                      void send(
                        { kind: 'campaignForces', opId: op.id, remove: [c.armyId] },
                        t('command.ops.toast.released'),
                      )
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function OpJournal({ op }: { op: CampaignView }) {
  const { t } = useTranslation();
  const list = [...op.journal].reverse();
  return (
    <section className="cmd-panel cmd-panel--journal" data-testid="op-journal">
      <h4 className="cmd-panel__title">{t('command.ops.journal')}</h4>
      <ol className="cmd-journal">
        {list.map((e, i) => {
          const c = fmtClock(e.t);
          return (
            <li
              key={`${e.t}-${i}`}
              className={`cmd-journal__e cmd-journal__e--${e.tone ?? 'info'}`}
            >
              <time>
                {c.day} {c.time}
              </time>
              <span>{journalText(e, t)}</span>
            </li>
          );
        })}
        {!list.length ? <li className="cmd-muted">{t('command.detail.journalEmpty')}</li> : null}
      </ol>
    </section>
  );
}

function OpDetail({
  op,
  mobile,
  onBack,
}: {
  op: CampaignView;
  mobile: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const send = useSend();
  const startOp = useCommandUi((s) => s.startOp);
  const focusOn = useUi((s) => s.focusOn);
  const select = useUi((s) => s.select);
  const closeWindow = useUi((s) => s.closeWindow);
  const [cancel, setCancel] = useState(false);
  const closed = op.status === 'success' || op.status === 'failed';
  const units = op.commanders.flatMap(
    (c) => command.armies.find((a) => a.id === c.armyId)?.unitIds ?? [],
  );
  const showOnMap = () => {
    const pts = op.commanders.flatMap((c) => c.aims);
    const at = centroidOf(
      pts.length
        ? pts
        : (units.map((id) => view?.units[id]?.pos).filter((p) => !!p) as [number, number][]),
    );
    select(units.filter((id) => !!view?.units[id]));
    if (at) focusOn(at, 5);
    closeWindow('command');
  };
  const btn = mobile ? 'lg' : 'md';
  return (
    <div className="cmd-detail" data-testid="op-detail">
      <header className="cmd-detail__head">
        {mobile ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="close" size={12} />}
            onClick={onBack}
            data-testid="op-back"
          >
            {t('command.ops.back')}
          </Button>
        ) : null}
        <span className={`ops-goal-icon ops-goal-icon--${op.goal}`}>
          <Icon name={GOAL_ICON[op.goal] ?? 'target'} size={16} />
        </span>
        <h3 className="cmd-detail__name">{op.name}</h3>
        <OpStatus op={op} />
        <span className="cmd-detail__spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="map" size={12} />}
          onClick={showOnMap}
          data-testid="op-show-map"
        >
          {t('command.actions.showMap')}
        </Button>
      </header>
      <div className="ops-sub">
        <b>{t(`command.ops.goals.${op.goal}.name`, { defaultValue: op.goal })}</b>
        <Targets op={op} />
        <span className="cmd-chip">{t(`command.aggr.${op.aggr}`)}</span>
        <span className="cmd-chip">{t(`command.roe.${op.roe}.short`)}</span>
        <span className="cmd-chip">{t('command.detail.since', fmtClock(op.since))}</span>
        {op.deadline !== null ? (
          <span className="cmd-chip">{t('command.ops.deadlineAt', fmtClock(op.deadline))}</span>
        ) : null}
      </div>
      {op.request ? <OpRequest op={op} /> : null}
      <div className="cmd-detail__grid">
        <ProgressPanel op={op} />
        <StaffPanel op={op} command={command} />
        <OpJournal op={op} />
      </div>
      <footer className="cmd-detail__foot">
        {closed ? null : (
          <>
            <Button
              size={btn}
              icon={<Icon name="plus" size={13} />}
              onClick={() =>
                startOp({
                  mode: 'reinforce',
                  opId: op.id,
                  steps: ['staff', 'confirm'],
                  goal: op.goal,
                  nations: op.nations,
                  provinces: op.provinces ?? [],
                  aggr: op.aggr,
                  roe: op.roe,
                  name: op.name,
                })
              }
              data-testid="op-reinforce"
            >
              {t('command.ops.reinforce')}
            </Button>
            <Button
              size={btn}
              variant="primary"
              icon={<Icon name="target" size={13} />}
              onClick={() =>
                startOp({
                  mode: 'edit',
                  opId: op.id,
                  steps: ['targets', 'goal', 'confirm'],
                  step: 'goal',
                  goal: op.goal,
                  nations: op.nations,
                  provinces: op.provinces ?? [],
                  aggr: op.aggr,
                  roe: op.roe,
                  name: op.name,
                  deadlineHours: null,
                })
              }
              data-testid="op-change-goal"
            >
              {t('command.ops.changeGoal')}
            </Button>
            <Button
              size={btn}
              variant="ghost"
              icon={<Icon name={op.status === 'suspended' ? 'play' : 'pause'} size={13} />}
              onClick={() =>
                void send(
                  { kind: 'campaignSuspend', opId: op.id, on: op.status !== 'suspended' },
                  op.status === 'suspended'
                    ? t('command.ops.toast.resumed')
                    : t('command.ops.toast.suspended'),
                )
              }
              data-testid="op-suspend"
            >
              {op.status === 'suspended'
                ? t('command.actions.resume')
                : t('command.actions.suspend')}
            </Button>
          </>
        )}
        <span className="cmd-detail__spacer" />
        <Button size={btn} variant="danger" onClick={() => setCancel(true)} data-testid="op-cancel">
          {closed ? t('command.ops.close') : t('command.ops.cancel')}
        </Button>
      </footer>
      <Dialog
        open={cancel}
        title={closed ? t('command.ops.closeTitle') : t('command.ops.cancelTitle')}
        tone="red"
        onClose={() => setCancel(false)}
        closeLabel={t('app.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancel(false)}>
              {t('app.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void send(
                  { kind: 'campaignCancel', opId: op.id },
                  t('command.ops.toast.cancelled'),
                );
                setCancel(false);
                onBack();
              }}
              data-testid="op-cancel-confirm"
            >
              {closed ? t('command.ops.close') : t('command.ops.cancel')}
            </Button>
          </>
        }
      >
        <p>{t('command.ops.cancelText', { name: op.name })}</p>
      </Dialog>
    </div>
  );
}

// ——— Assistant ———

function Stepper({ steps, step }: { steps: OpStep[]; step: OpStep }) {
  const { t } = useTranslation();
  const patchOp = useCommandUi((s) => s.patchOp);
  const i = steps.indexOf(step);
  return (
    <ol className="cmd-stepper" aria-label={t('command.wizard.steps')}>
      {steps.map((s, k) => (
        <li key={s} className={k === i ? 'is-cur' : k < i ? 'is-done' : ''}>
          <button
            type="button"
            disabled={k > i}
            onClick={() => patchOp({ step: s })}
            aria-current={k === i ? 'step' : undefined}
          >
            <span className="cmd-stepper__n">
              {k < i ? <Icon name="check" size={11} /> : k + 1}
            </span>
            <span className="cmd-stepper__label">{t(`command.ops.step.${s}`)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Nations proposées : en guerre, voisines, estimées par le renseignement, puis toutes. */
function useNationChoices(query: string): string[] {
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const nations = useWorld((s) => s.nations);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const hot = new Set<string>(Object.keys(view?.command?.estimates ?? {}));
    for (const [id, n] of Object.entries(view?.nations ?? {}))
      if (n.relation === 'war') hot.add(id);
    const all = new Set<string>([...Object.keys(view?.nations ?? {}), ...Object.keys(nations)]);
    all.delete(me ?? '');
    const list = [...all].filter((id) => view?.nations[id]?.alive !== false);
    const match = (id: string) =>
      !q || nationName(id).toLowerCase().includes(q) || id.toLowerCase().startsWith(q);
    const score = (id: string) => (view?.nations[id]?.relation === 'war' ? 0 : hot.has(id) ? 1 : 2);
    return list
      .filter((id) => match(id) && (q || hot.has(id)))
      .sort(
        (a, b) => score(a) - score(b) || nationName(a).localeCompare(nationName(b), i18n.language),
      )
      .slice(0, q ? 30 : 16);
  }, [query, view, me, nations]);
}

function TargetsStep({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const d = useCommandUi((s) => s.opDraft)!;
  const patchOp = useCommandUi((s) => s.patchOp);
  const setPicking = useCommandUi((s) => s.setPicking);
  const closeWindow = useUi((s) => s.closeWindow);
  const view = useGame((s) => s.view);
  const [q, setQ] = useState('');
  const choices = useNationChoices(q);
  const toggle = (id: string) =>
    patchOp({
      nations: d.nations.includes(id) ? d.nations.filter((x) => x !== id) : [...d.nations, id],
    });
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step'}>
      <p className="cmd-lead">{t('command.ops.targetsLead')}</p>
      <div className="ops-picked" data-testid="op-targets">
        {d.nations.length ? (
          d.nations.map((n) => (
            <button
              key={n}
              type="button"
              className="ops-picked__chip"
              onClick={() => toggle(n)}
              title={t('command.ops.removeTarget')}
            >
              <NationTag id={n} size={12} />
              <small>
                {view?.command?.estimates[n] ? formatMoney(view.command.estimates[n]!) : '—'}
              </small>
              <Icon name="close" size={10} />
            </button>
          ))
        ) : (
          <span className="cmd-muted">{t('command.ops.noTarget')}</span>
        )}
        {d.provinces.length ? (
          <span className="cmd-chip">
            {t('command.ops.provinces', { count: d.provinces.length })}
          </span>
        ) : null}
      </div>
      <div className="ops-search">
        <Input
          value={q}
          placeholder={t('command.ops.search')}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('command.ops.search')}
          data-testid="op-search"
        />
        <Button
          size={mobile ? 'md' : 'sm'}
          variant="ghost"
          icon={<Icon name="map" size={12} />}
          onClick={() => {
            setPicking('nation');
            closeWindow('command');
          }}
          data-testid="op-pick-map"
        >
          {t('command.ops.pickOnMap')}
        </Button>
      </div>
      <ul className="ops-nations">
        {choices.map((id) => {
          const on = d.nations.includes(id);
          const rel = view?.nations[id]?.relation;
          return (
            <li key={id}>
              <button
                type="button"
                className={on ? 'ops-nation is-on' : 'ops-nation'}
                aria-pressed={on}
                onClick={() => toggle(id)}
                data-testid={`op-nation-${id}`}
              >
                <NationTag id={id} size={13} />
                {rel === 'war' ? <Badge tone="red">{t('command.ops.atWar')}</Badge> : null}
                <span className="ops-nation__est">
                  {view?.command?.estimates[id] ? formatMoney(view.command.estimates[id]!) : ''}
                </span>
                {on ? <Icon name="check" size={12} /> : <Icon name="plus" size={12} />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EstimateBox({ est }: { est: OpPreview }) {
  const { t } = useTranslation();
  return (
    <div className="cmd-est cmd-est--box ops-est" data-testid="op-estimate">
      <div>
        <span>{t('command.ops.est.forces')}</span>
        <b>{formatMoney(est.forces)}</b>
        <small>
          {t('command.ops.est.enemy', { value: est.enemy ? formatMoney(est.enemy) : '—' })}
        </small>
      </div>
      <div>
        <span>{t('command.est.ratio')}</span>
        <b className={est.ratio >= 1.5 ? 'is-good' : est.ratio >= 1 ? 'is-warn' : 'is-bad'}>
          {est.ratio >= 99 ? '—' : ratioText(est.ratio, i18n.language)}
        </b>
      </div>
      <div>
        <span>{t('command.est.eta')}</span>
        <b>{etaLabel(est.etaHours)}</b>
      </div>
      <div>
        <span>{t('command.est.chance')}</span>
        <b className={est.chance >= 0.65 ? 'is-good' : est.chance >= 0.4 ? 'is-warn' : 'is-bad'}>
          {Math.round(est.chance * 100)} %
        </b>
      </div>
      <div>
        <span>{t('command.ops.est.cost')}</span>
        <b className="is-amber">{formatMoney(est.costPerDay)}</b>
        <small>
          {est.hireCost
            ? t('command.ops.est.hire', { value: formatMoney(est.hireCost) })
            : t('command.general.perDay')}
        </small>
      </div>
    </div>
  );
}

function usePreview(d: OpDraft, staff: StaffPick[]): OpPreview {
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const balance = useWorld((s) => s.balance);
  const share = balance?.command?.operations?.forceShare?.[d.aggr] ?? SHARE[d.aggr];
  const ratio = balance?.command?.aggressiveness?.[d.aggr]?.attackRatio ?? RATIO[d.aggr];
  return previewOp({
    view,
    me,
    catalog,
    goal: d.goal ?? 'conquest',
    nations: d.nations,
    provinces: d.provinces,
    staff,
    aggr: d.aggr,
    share,
    attackRatio: ratio,
  });
}

const SHARE: Record<Aggressiveness, number> = { cautious: 0.5, balanced: 0.75, bold: 1 };
const RATIO: Record<Aggressiveness, number> = { cautious: 2.2, balanced: 1.5, bold: 1.1 };

function freeCounts(free: ReturnType<typeof freeByBranch>): Record<Branch, number> {
  return { land: free.land.length, air: free.air.length, sea: free.sea.length, ad: free.ad.length };
}

function GoalCard({ id, on, onPick }: { id: string; on: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const d = useCommandUi((s) => s.opDraft)!;
  const command = view!.command!;
  const def = command.goals![id]!;
  const free = freeCounts(freeByBranch(view, me, catalog));
  const staff = d.staff.length ? d.staff : suggestStaff(command, def, id, free);
  const est = usePreview({ ...d, goal: id }, staff);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={on ? 'cmd-mcard ops-gcard is-on' : 'cmd-mcard ops-gcard'}
      onClick={onPick}
      data-testid={`op-goal-${id}`}
    >
      <span className={`ops-goal-icon ops-goal-icon--${id}`}>
        <Icon name={GOAL_ICON[id] ?? 'target'} size={16} />
      </span>
      <b>{t(`command.ops.goals.${id}.name`, { defaultValue: id })}</b>
      <span className="cmd-mcard__desc">
        {t(`command.ops.goals.${id}.desc`, { defaultValue: '' })}
      </span>
      <span className="ops-gcard__foot">
        <span className="ops-gcard__branches">
          {def.branches.map((b) => (
            <span
              key={b}
              className={free[b] ? 'cmd-chip is-on' : 'cmd-chip'}
              title={t(`command.branch.${b}.name`)}
            >
              <Icon name={BRANCH_ICON[b]} size={10} />
            </span>
          ))}
        </span>
        <span className="ops-gcard__est">
          {etaLabel(est.etaHours)} · {Math.round(est.chance * 100)} %
        </span>
      </span>
    </button>
  );
}

function GoalStep({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const d = useCommandUi((s) => s.opDraft)!;
  const patchOp = useCommandUi((s) => s.patchOp);
  const setPicking = useCommandUi((s) => s.setPicking);
  const closeWindow = useUi((s) => s.closeWindow);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const def = d.goal ? command.goals?.[d.goal] : null;
  const free = freeCounts(freeByBranch(view, me, catalog));
  const staff = d.staff.length || !def ? d.staff : suggestStaff(command, def, d.goal!, free);
  const est = usePreview(d, staff);
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step'}>
      <div className="cmd-missions" role="radiogroup" aria-label={t('command.ops.step.goal')}>
        {goalList(command).map(([id]) => (
          <GoalCard key={id} id={id} on={d.goal === id} onPick={() => patchOp({ goal: id })} />
        ))}
      </div>
      {def ? (
        <div className="cmd-params" data-testid="op-params">
          {def.target === 'provinces' ? (
            <div className="cmd-target">
              <span className="cmd-target__label">{t('command.ops.region')}</span>
              <b>
                {d.provinces.length
                  ? d.provinces
                      .slice(0, 4)
                      .map((p) => provinceName(p))
                      .join(', ')
                  : t('command.target.none')}
              </b>
              <Button
                size={mobile ? 'md' : 'sm'}
                variant={d.provinces.length ? 'ghost' : 'primary'}
                icon={<Icon name="target" size={12} />}
                onClick={() => {
                  setPicking('nation');
                  closeWindow('command');
                }}
              >
                {t('command.ops.pickProvinces')}
              </Button>
            </div>
          ) : null}
          <div className="cmd-params__row">
            <div>
              <span className="cmd-param__label">{t('command.aggr.label')}</span>
              <Segmented<Aggressiveness>
                size="sm"
                label={t('command.aggr.label')}
                value={d.aggr}
                onChange={(v) => patchOp({ aggr: v })}
                options={(['cautious', 'balanced', 'bold'] as const).map((v) => ({
                  value: v,
                  label: t(`command.aggr.${v}`),
                  title: t(`command.aggr.${v}Help`),
                }))}
              />
            </div>
            <div>
              <span className="cmd-param__label">{t('command.roe.label')}</span>
              <Segmented<Roe>
                size="sm"
                label={t('command.roe.label')}
                value={d.roe}
                onChange={(v) => patchOp({ roe: v })}
                options={(['strict', 'standard', 'free'] as const).map((v) => ({
                  value: v,
                  label: t(`command.roe.${v}.short`),
                  title: t(`command.ops.roe.${v}`),
                }))}
              />
            </div>
            <div>
              <span className="cmd-param__label">{t('command.ops.deadline')}</span>
              <Select
                label={t('command.ops.deadline')}
                value={String(d.deadlineHours ?? '')}
                onChange={(v) => patchOp({ deadlineHours: v ? Number(v) : null })}
                options={[
                  { value: '', label: t('command.ops.noDeadline') },
                  ...[24, 72, 168, 336].map((h) => ({
                    value: String(h),
                    label: etaLabel(h),
                  })),
                ]}
              />
            </div>
          </div>
          <p className="cmd-hint">{t(`command.ops.roe.${d.roe}`)}</p>
          <EstimateBox est={est} />
          {!d.staff.length && staff.length ? (
            <p className="cmd-hint">
              <Icon name="info" size={11} /> {t('command.ops.estWithSuggestion')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="cmd-muted cmd-pad">{t('command.ops.pickGoal')}</p>
      )}
    </div>
  );
}

function GeneralRow({
  g,
  pick,
  onToggle,
  onRole,
  onArmy,
  armies,
  recommended,
}: {
  g: CommandGeneralView;
  pick: StaffPick | undefined;
  onToggle: () => void;
  onRole: (b: Branch) => void;
  onArmy: (id: string | null) => void;
  armies: { id: string; name: string }[];
  recommended: boolean;
}) {
  const { t } = useTranslation();
  const b = branchOfGeneral(g);
  const key = BRANCH_SKILL[b];
  return (
    <li className={pick ? 'ops-grow is-on' : 'ops-grow'}>
      <button
        type="button"
        className="ops-grow__main"
        aria-pressed={!!pick}
        onClick={onToggle}
        data-testid={`op-general-${g.id}`}
      >
        <GeneralAvatar g={g} size={36} />
        <span className="ops-grow__id">
          <b>
            {g.first} {g.last}
          </b>
          <span>
            <Stars n={g.rank} /> {t(`command.skills.${key}.label`)} <b>{g.skills[key]}</b> ·{' '}
            {t('command.skills.experience.label')} {g.skills.experience}
            {g.traits.length
              ? ` · ${g.traits.map((x) => t(`command.traits.${x}.label`)).join(', ')}`
              : ''}
          </span>
        </span>
        <span className="ops-grow__pay">
          <b>{formatMoney(g.salaryPerDay)}</b>
          <small>
            {g.status === 'candidate'
              ? t('command.general.signing', { value: formatMoney(g.hireCost) })
              : g.chief
                ? t('command.ops.chief')
                : t('command.ops.hired')}
          </small>
        </span>
        <span className="ops-grow__check" aria-hidden>
          {pick ? (
            <Icon name="check" size={13} />
          ) : recommended ? (
            <Icon name="plus" size={13} />
          ) : null}
        </span>
      </button>
      {pick ? (
        <div className="ops-grow__opts">
          <Select
            label={t('command.ops.role')}
            value={pick.role}
            onChange={(v) => onRole(v as Branch)}
            options={BRANCHES.map((x) => ({ value: x, label: t(`command.branch.${x}.role`) }))}
          />
          <Select
            label={t('command.ops.forces')}
            value={pick.armyId ?? ''}
            onChange={(v) => onArmy(v || null)}
            options={[
              { value: '', label: t('command.ops.autoForces') },
              ...armies.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </div>
      ) : null}
    </li>
  );
}

function StaffStep({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const command = view!.command!;
  const d = useCommandUi((s) => s.opDraft)!;
  const patchOp = useCommandUi((s) => s.patchOp);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const def = d.goal ? command.goals?.[d.goal] : null;
  const freeU = freeByBranch(view, me, catalog);
  const free = freeCounts(freeU);
  const inOp = new Set(
    (command.ops ?? []).find((o) => o.id === d.opId)?.commanders.map((c) => c.generalId) ?? [],
  );
  const armies = command.armies
    .filter((a) => !a.opId || a.opId === d.opId)
    .map((a) => ({ id: a.id, name: a.name }));
  const set = (staff: StaffPick[]) => patchOp({ staff });
  const toggle = (g: CommandGeneralView) => {
    const has = d.staff.find((p) => p.id === g.id);
    set(
      has
        ? d.staff.filter((p) => p.id !== g.id)
        : [
            ...d.staff,
            {
              id: g.id,
              role: branchOfGeneral(g),
              armyId:
                g.armyId && !command.armies.find((a) => a.id === g.armyId)?.opId ? g.armyId : null,
            },
          ],
    );
  };
  const suggest = () =>
    def && d.goal
      ? set(suggestStaff(command, def, d.goal, free, new Set(inOp as Set<string>)))
      : undefined;
  const fit = def ? branchFit(def, d.staff) : [];
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step'}>
      <div className="ops-staffbar">
        <span className="cmd-lead">{t('command.ops.staffLead', { count: d.staff.length })}</span>
        <span className="ops-staffbar__fit">
          {fit.map((x) => (
            <Badge key={x.b} tone={x.ok ? 'green' : 'amber'} variant="outline">
              <Icon name={BRANCH_ICON[x.b]} size={10} /> {t(`command.branch.${x.b}.name`)}
            </Badge>
          ))}
        </span>
        <span className="cmd-detail__spacer" />
        {def ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="star" size={12} />}
            onClick={suggest}
            data-testid="op-suggest"
          >
            {t('command.ops.suggest')}
          </Button>
        ) : null}
      </div>
      <div className="ops-branches">
        {BRANCHES.map((b) => {
          const hired = freeGenerals(command, d.opId).filter(
            (g) => branchOfGeneral(g) === b && !inOp.has(g.id),
          );
          const pool = allCandidates(command)
            .filter((g) => branchOfGeneral(g) === b)
            .sort(
              (x, y) =>
                y.skills[BRANCH_SKILL[b]] - x.skills[BRANCH_SKILL[b]] || (x.id < y.id ? -1 : 1),
            );
          const shown = more[b] ? pool : pool.slice(0, 3);
          const recommended = !!def?.branches.includes(b);
          const value = freeU[b].reduce((s, u) => s + pileValue(u, catalog), 0);
          const chief = command.branches?.find((x) => x.id === b)?.chiefId;
          const chiefG = chief ? command.generals.find((g) => g.id === chief) : null;
          return (
            <section
              key={b}
              className={recommended ? 'ops-branch is-rec' : 'ops-branch'}
              data-testid={`op-branch-${b}`}
            >
              <header className="ops-branch__head">
                <Icon name={BRANCH_ICON[b]} size={14} />
                <b>{t(`command.branch.${b}.name`)}</b>
                {recommended ? <Badge tone="cyan">{t('command.ops.recommended')}</Badge> : null}
                <span className="cmd-detail__spacer" />
                <small>
                  {t('command.ops.freeForces', { count: free[b], value: formatMoney(value) })}
                </small>
              </header>
              {chiefG ? (
                <p className="ops-branch__chief">
                  <Icon name="crown" size={11} />{' '}
                  {t('command.ops.chiefIs', { name: `${chiefG.first} ${chiefG.last}` })}
                </p>
              ) : null}
              <ul className="ops-glist">
                {[...hired, ...shown].map((g) => (
                  <GeneralRow
                    key={g.id}
                    g={g}
                    pick={d.staff.find((p) => p.id === g.id)}
                    onToggle={() => toggle(g)}
                    onRole={(role) => set(d.staff.map((p) => (p.id === g.id ? { ...p, role } : p)))}
                    onArmy={(armyId) =>
                      set(d.staff.map((p) => (p.id === g.id ? { ...p, armyId } : p)))
                    }
                    armies={armies}
                    recommended={recommended}
                  />
                ))}
              </ul>
              {pool.length > 3 ? (
                <button
                  type="button"
                  className="cmd-link"
                  onClick={() => setMore({ ...more, [b]: !more[b] })}
                >
                  {more[b]
                    ? t('command.ops.lessPool')
                    : t('command.ops.morePool', { count: pool.length - 3 })}
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ConfirmStep({ mobile, defaultName }: { mobile: boolean; defaultName: string }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const d = useCommandUi((s) => s.opDraft)!;
  const patchOp = useCommandUi((s) => s.patchOp);
  const est = usePreview(d, d.staff);
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step'}>
      {d.mode === 'new' ? (
        <label className="cmd-field">
          <span>{t('command.ops.name')}</span>
          <Input
            value={d.name}
            maxLength={40}
            placeholder={defaultName}
            onChange={(e) => patchOp({ name: e.target.value })}
            data-testid="op-name"
          />
        </label>
      ) : null}
      <dl className="ops-summary" data-testid="op-summary">
        <div>
          <dt>{t('command.ops.step.targets')}</dt>
          <dd>
            {d.nations.map((n) => (
              <NationTag key={n} id={n} size={12} />
            ))}
            {d.provinces.length ? (
              <span className="cmd-chip">
                {t('command.ops.provinces', { count: d.provinces.length })}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t('command.ops.step.goal')}</dt>
          <dd>
            {d.goal ? (
              <>
                <Icon name={GOAL_ICON[d.goal] ?? 'target'} size={12} />{' '}
                {t(`command.ops.goals.${d.goal}.name`, { defaultValue: d.goal })}
              </>
            ) : null}
            <span className="cmd-chip">{t(`command.aggr.${d.aggr}`)}</span>
            <span className="cmd-chip">{t(`command.roe.${d.roe}.short`)}</span>
            {d.deadlineHours ? <span className="cmd-chip">{etaLabel(d.deadlineHours)}</span> : null}
          </dd>
        </div>
        {d.mode !== 'edit' ? (
          <div>
            <dt>{t('command.ops.step.staff')}</dt>
            <dd className="ops-summary__staff">
              {d.staff.map((p) => {
                const g = staffGeneral(command, p.id);
                const army = p.armyId ? command.armies.find((a) => a.id === p.armyId)?.name : null;
                return g ? (
                  <span key={p.id} className="ops-summary__gen">
                    <Icon name={BRANCH_ICON[p.role]} size={11} />
                    <b>
                      {g.first} {g.last}
                    </b>
                    <small>
                      {t(`command.branch.${p.role}.role`)} · {army ?? t('command.ops.autoForces')}
                    </small>
                  </span>
                ) : null;
              })}
            </dd>
          </div>
        ) : null}
      </dl>
      <EstimateBox est={est} />
    </div>
  );
}

export function OpWizard({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const d = useCommandUi((s) => s.opDraft)!;
  const patchOp = useCommandUi((s) => s.patchOp);
  const closeOp = useCommandUi((s) => s.closeOp);
  const selectOp = useCommandUi((s) => s.selectOp);
  const send = useSend();
  const [busy, setBusy] = useState(false);
  const i = d.steps.indexOf(d.step);
  const last = i === d.steps.length - 1;
  const def = d.goal ? command.goals?.[d.goal] : null;
  const can: Record<OpStep, boolean> = {
    targets: d.nations.length > 0 || d.provinces.length > 0,
    goal: !!def && (def.target !== 'provinces' || d.provinces.length > 0),
    staff: d.staff.length > 0,
    confirm: true,
  };
  const defaultName = d.goal
    ? t('command.ops.defaultName', {
        goal: t(`command.ops.goals.${d.goal}.name`, { defaultValue: d.goal }),
        target: d.nations.length
          ? nationName(d.nations[0]!)
          : d.provinces.length
            ? provinceName(d.provinces[0]!)
            : '',
      }).slice(0, 40)
    : '';
  const commanders = (): OpCommanderInput[] =>
    d.staff.map((p) => {
      const g = staffGeneral(command, p.id);
      return {
        ...(g?.status === 'candidate' ? { candidateId: p.id } : { generalId: p.id }),
        ...(p.armyId ? { armyId: p.armyId } : {}),
        role: p.role,
      };
    });
  const confirm = async () => {
    setBusy(true);
    try {
      if (d.mode === 'new') {
        const before = new Set((command.ops ?? []).map((o) => o.id));
        const name = d.name.trim() || defaultName;
        const order: Order = {
          kind: 'campaignCreate',
          name,
          goal: d.goal!,
          nations: d.nations,
          ...(d.provinces.length ? { provinces: d.provinces } : {}),
          aggr: d.aggr,
          roe: d.roe,
          ...(d.deadlineHours ? { deadlineHours: d.deadlineHours } : {}),
          commanders: commanders(),
        };
        if (await send(order, t('command.ops.toast.created', { name }))) {
          closeOp();
          let tries = 0;
          const find = () => {
            const o = useGame.getState().view?.command?.ops?.find((x) => !before.has(x.id));
            if (o) selectOp(o.id);
            else if (++tries < 25) setTimeout(find, 200);
          };
          setTimeout(find, 100);
        }
        return;
      }
      if (d.mode === 'edit') {
        if (
          await send(
            {
              kind: 'campaignEdit',
              opId: d.opId!,
              goal: d.goal!,
              nations: d.nations,
              ...(d.provinces.length ? { provinces: d.provinces } : {}),
              aggr: d.aggr,
              roe: d.roe,
              ...(d.deadlineHours ? { deadlineHours: d.deadlineHours } : {}),
            },
            t('command.ops.toast.edited'),
          )
        )
          closeOp();
        return;
      }
      if (
        await send(
          { kind: 'campaignForces', opId: d.opId!, add: commanders() },
          t('command.ops.toast.reinforced'),
        )
      )
        closeOp();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={mobile ? 'cmd-wizard cmd-wizard--mobile' : 'cmd-wizard'}
      data-testid="op-wizard"
    >
      <header className="cmd-wizard__head">
        <Stepper steps={d.steps} step={d.step} />
        <span className="cmd-detail__spacer" />
        <Button size="sm" variant="ghost" onClick={closeOp} data-testid="op-wizard-cancel">
          {t('app.cancel')}
        </Button>
      </header>
      <div className="cmd-wizard__body">
        {d.step === 'targets' ? (
          <TargetsStep mobile={mobile} />
        ) : d.step === 'goal' ? (
          <GoalStep mobile={mobile} />
        ) : d.step === 'staff' ? (
          <StaffStep mobile={mobile} />
        ) : (
          <ConfirmStep mobile={mobile} defaultName={defaultName} />
        )}
      </div>
      <footer className="cmd-wizard__foot">
        {i > 0 ? (
          <Button
            size={mobile ? 'lg' : 'md'}
            variant="ghost"
            onClick={() => patchOp({ step: d.steps[i - 1]! })}
          >
            {t('app.previous')}
          </Button>
        ) : null}
        <span className="cmd-detail__spacer" />
        {last ? (
          <Button
            size={mobile ? 'lg' : 'md'}
            variant="primary"
            icon={<Icon name="check" size={13} />}
            disabled={busy || !d.steps.every((s) => can[s])}
            onClick={() => void confirm()}
            data-testid="op-confirm"
          >
            {d.mode === 'new' ? t('command.ops.launch') : t('app.confirm')}
          </Button>
        ) : (
          <Button
            size={mobile ? 'lg' : 'md'}
            variant="primary"
            disabled={!can[d.step]}
            onClick={() => {
              const next = d.steps[i + 1]!;
              // Étape des généraux : état-major proposé d'office (modifiable).
              if (next === 'staff' && !d.staff.length && def && d.goal) {
                const free = freeCounts(
                  freeByBranch(view, useGame.getState().me, useWorld.getState().catalog),
                );
                patchOp({
                  step: next,
                  staff: d.mode === 'reinforce' ? [] : suggestStaff(command, def, d.goal, free),
                });
              } else patchOp({ step: next });
            }}
            data-testid="op-next"
          >
            {t('app.next')}
          </Button>
        )}
      </footer>
    </div>
  );
}

/** Ouvre l'assistant « Nouvelle opération » (pays de la sélection proposé d'office). */
export function openNewOp(nations: string[] = []): void {
  useCommandUi.getState().startOp({ steps: ['targets', 'goal', 'staff', 'confirm'], nations });
  useCommandUi.getState().setTab('ops');
  useUi.getState().openWindow('command');
}

/** Premier contact : comment fonctionne une opération. */
function OpsOnboarding({ mobile }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const steps: { key: OpStep; icon: IconName }[] = [
    { key: 'targets', icon: 'globe' },
    { key: 'goal', icon: 'target' },
    { key: 'staff', icon: 'star' },
  ];
  return (
    <div
      className={mobile ? 'cmd-onboard-wrap' : 'cmd-detail cmd-detail--empty'}
      data-testid="ops-onboarding"
    >
      <div className="cmd-onboard">
        <p className="cmd-onboard__title">{t('command.ops.onboard.title')}</p>
        <ol className="cmd-onboard__steps">
          {steps.map((s, i) => (
            <li key={s.key} className="cmd-onboard__step">
              <span className="cmd-onboard__num">{i + 1}</span>
              <Icon name={s.icon} size={18} />
              <div>
                <strong>{t(`command.ops.step.${s.key}`)}</strong>
                <p>{t(`command.ops.onboard.${s.key}`)}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="cmd-onboard__rule">
          <Icon name="info" size={11} /> {t('command.ops.onboard.rule')}
        </p>
        {mobile ? null : (
          <Button
            variant="primary"
            icon={<Icon name="plus" size={13} />}
            onClick={() => openNewOp()}
          >
            {t('command.ops.new')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function OpsPane({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const selected = useCommandUi((s) => s.selectedOp);
  const selectOp = useCommandUi((s) => s.selectOp);
  const [mobileDetail, setMobileDetail] = useState(selected != null);
  useEffect(() => {
    if (selected) setMobileDetail(true);
  }, [selected]);
  const ops = command.ops ?? [];
  const cur = ops.find((o) => o.id === selected) ?? (mobile ? null : (ops[0] ?? null));
  const full = ops.length >= (command.maxOps ?? 8);
  const list = (
    <div className="cmd-list">
      <Button
        variant="primary"
        size={mobile ? 'lg' : 'md'}
        block
        icon={<Icon name="plus" size={13} />}
        disabled={full}
        onClick={() => openNewOp()}
        data-testid="op-new"
      >
        {t('command.ops.new')}
      </Button>
      {full ? (
        <p className="cmd-hint">{t('command.ops.full', { max: command.maxOps ?? 8 })}</p>
      ) : null}
      {ops.length ? (
        <ul className="cmd-rows">
          {ops.map((o) => (
            <OpRow
              key={o.id}
              op={o}
              sel={cur?.id === o.id}
              onClick={() => {
                selectOp(o.id);
                setMobileDetail(true);
              }}
            />
          ))}
        </ul>
      ) : mobile ? (
        <OpsOnboarding mobile />
      ) : (
        <EmptyState
          compact
          icon="target"
          title={t('command.ops.emptyTitle')}
          text={t('command.ops.emptyText')}
        />
      )}
    </div>
  );
  if (mobile) {
    if (cur && mobileDetail)
      return (
        <OpDetail
          key={cur.id}
          op={cur}
          mobile
          onBack={() => {
            setMobileDetail(false);
            selectOp(null);
          }}
        />
      );
    return list;
  }
  return (
    <div className="cmd-split">
      {list}
      {cur ? (
        <OpDetail key={cur.id} op={cur} mobile={false} onBack={() => selectOp(null)} />
      ) : (
        <OpsOnboarding />
      )}
    </div>
  );
}

/** Nombre d'opérations qui attendent une réponse du joueur. */
export function pendingOpRequests(command: CommandView | undefined): number {
  return (command?.ops ?? []).filter((o) => !!o.request).length;
}
