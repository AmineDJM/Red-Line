import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CATEGORIES,
  RESEARCH_BRANCHES,
  RESOURCES,
  type GovMissionDef,
  type GovOffice,
  type PlayerView,
} from '@redline/shared';
import {
  Button,
  Field,
  Icon,
  Segmented,
  Select,
  Slider,
  Toggle,
  formatInt,
  formatMoney,
} from '@redline/ui';
import { fmtDuration, i18n } from '../i18n/index.js';
import {
  autoGoal,
  coverCount,
  draftError,
  emptyDraft,
  envelopeUsd,
  estimatePlan,
  missionIcon,
  missionTypes,
  officeById,
  toInput,
  withType,
  type BudgetDraft,
  type MissionDraft,
  type ZoneMode,
} from '../lib/government.js';
import { nationName } from '../lib/game.js';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';
import { useSend } from './armyCommand.js';

/**
 * Assistant « Nouvelle mission » en trois étapes : 1. la mission (parmi celles du poste) ; 2. la
 * cible, la zone, l'objectif et la priorité ; 3. l'enveloppe (montant ou part des revenus, plafond),
 * avec les coûts et effets prévus avant de confirmer.
 */

/** Unité « jour de budget » : budget de défense par jour (ORBAT), sinon revenus par jour. */
export function useUnit(): number {
  const gv = useGame((s) => s.view?.government);
  const eco = useGame((s) => s.view?.economy);
  if (gv && gv.budgetDay > 0) return gv.budgetDay;
  return Math.max(1e6, eco?.detail?.income.total ?? eco?.incomePerDay.money ?? 0);
}

function revenueOf(view: PlayerView | null): number {
  const e = view?.economy;
  return Math.max(0, e?.detail?.income.total ?? e?.incomePerDay.money ?? 0);
}

const DAYS_PRESETS = [5, 10, 20, 45, 90];

/** Nombre à une décimale, localisé. */
function num1(v: number): string {
  return new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(v);
}

/** Enveloppe : montant (en jours de budget) ou part des revenus avec plafond facultatif. */
export function BudgetPicker({
  value,
  onChange,
}: {
  value: BudgetDraft;
  onChange: (b: BudgetDraft) => void;
}) {
  const { t } = useTranslation();
  const unit = useUnit();
  const view = useGame((s) => s.view);
  const rev = revenueOf(view);
  const set = (p: Partial<BudgetDraft>) => onChange({ ...value, ...p });
  return (
    <div className="gov-budget" data-testid="gov-budget">
      <Segmented
        label={t('gov.budget.mode')}
        value={value.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { value: 'amount', label: t('gov.budget.amount') },
          { value: 'share', label: t('gov.budget.share') },
        ]}
      />
      {value.mode === 'amount' ? (
        <>
          <div className="gov-budget__big">
            <b data-testid="gov-budget-amount">{formatMoney(envelopeUsd(value, unit) ?? 0)}</b>
            <span>{t('gov.budget.daysOf', { count: value.days })}</span>
          </div>
          <Slider
            label={t('gov.budget.amount')}
            min={1}
            max={180}
            value={value.days}
            onChange={(days) => set({ days })}
            format={(v) => t('gov.budget.daysShort', { count: v })}
          />
          <div className="gov-presets">
            {DAYS_PRESETS.map((d) => (
              <button
                key={d}
                type="button"
                className={value.days === d ? 'gov-preset gov-preset--on' : 'gov-preset'}
                onClick={() => set({ days: d })}
              >
                {formatMoney(d * unit)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="gov-budget__big">
            <b>{value.pct} %</b>
            <span>
              {t('gov.budget.perDayOf', {
                v: formatMoney((rev * value.pct) / 100),
                rev: formatMoney(rev),
              })}
            </span>
          </div>
          <Slider
            label={t('gov.budget.share')}
            min={1}
            max={50}
            value={value.pct}
            onChange={(pct) => set({ pct })}
            format={(v) => `${v} %`}
          />
          <Toggle
            checked={value.capOn}
            onChange={(capOn) => set({ capOn })}
            label={t('gov.budget.cap')}
            description={
              value.capOn ? formatMoney(envelopeUsd(value, unit) ?? 0) : t('gov.budget.noCap')
            }
          />
          {value.capOn ? (
            <Slider
              label={t('gov.budget.cap')}
              min={1}
              max={365}
              value={value.capDays}
              onChange={(capDays) => set({ capDays })}
              format={(v) => formatMoney(v * unit)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** Objectif chiffré d'une mission (chantiers, lots, nœuds, opérations, jours de réserve). */
export function GoalField({
  def,
  value,
  onChange,
}: {
  def: GovMissionDef;
  value: number;
  onChange: (v: number) => void;
}) {
  const { t } = useTranslation();
  const max = Math.max(1, def.goalMax);
  return (
    <Slider
      label={t(`gov.goal.${def.unit}`)}
      min={1}
      max={max}
      value={Math.min(max, Math.max(1, value))}
      onChange={onChange}
      format={(v) => formatInt(v)}
    />
  );
}

function TargetField({
  def,
  d,
  set,
}: {
  def: GovMissionDef;
  d: MissionDraft;
  set: (p: Partial<MissionDraft>) => void;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const nations = useMemo(
    () =>
      Object.values(view?.nations ?? {})
        .filter((x) => x.id !== me && x.alive && x.provinceCount > 0)
        .map((x) => ({ value: x.id, label: nationName(x.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [view?.nations, me],
  );
  if (def.target === 'resource')
    return (
      <Field label={t('gov.wizard.resource')}>
        <Segmented
          label={t('gov.wizard.resource')}
          value={d.resource ?? 'oil'}
          onChange={(resource) => set({ resource })}
          options={RESOURCES.map((r) => ({
            value: r,
            label: (
              <span className="gov-seg">
                <Icon name={r} size={12} /> {t(`game.resources.${r}`)}
              </span>
            ),
          }))}
        />
      </Field>
    );
  if (def.target === 'branch')
    return (
      <Field label={t('gov.wizard.branch')}>
        <Select
          label={t('gov.wizard.branch')}
          value={d.branch ?? 'aero'}
          onChange={(branch) => set({ branch })}
          options={RESEARCH_BRANCHES.map((b) => ({ value: b, label: t(`research.branches.${b}`) }))}
        />
      </Field>
    );
  if (def.target === 'category')
    return (
      <Field label={t('gov.wizard.category')}>
        <Select
          label={t('gov.wizard.category')}
          value={d.category ?? 'air_defense'}
          onChange={(category) => set({ category })}
          options={CATEGORIES.filter((c) => c !== 'nuclear').map((c) => ({
            value: c,
            label: t(`categories.${c}`),
          }))}
          data-testid="gov-wizard-category"
        />
      </Field>
    );
  if (def.target === 'nation')
    return (
      <Field label={t('gov.wizard.nation')}>
        <Select
          label={t('gov.wizard.nation')}
          value={d.nationId ?? ''}
          onChange={(nationId) => set({ nationId: nationId || undefined })}
          options={[{ value: '', label: t('gov.wizard.pick') }, ...nations]}
          data-testid="gov-wizard-nation"
        />
      </Field>
    );
  return null;
}

function ZoneField({ d, set }: { d: MissionDraft; set: (p: Partial<MissionDraft>) => void }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const provinces = useWorld((s) => s.provinces);
  const own = useMemo(
    () =>
      Object.keys(view?.provinces ?? {})
        .filter((p) => view!.provinces[p]!.owner === me)
        .map((p) => ({ value: p, label: provinces[p]?.cityName ?? provinces[p]?.name ?? p }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [view, me, provinces],
  );
  const neighbors = useMemo(() => {
    const set0 = new Set<string>();
    for (const p of own)
      for (const q of provinces[p.value]?.neighbors ?? []) {
        const o = view?.provinces[q]?.owner;
        if (o && o !== me) set0.add(o);
      }
    return [...set0]
      .map((n) => ({ value: n, label: nationName(n) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [own, provinces, view, me]);
  return (
    <Field label={t('gov.wizard.zone')}>
      <div className="gov-zone">
        <Segmented
          label={t('gov.wizard.zone')}
          value={d.zone}
          onChange={(zone: ZoneMode) => set({ zone })}
          options={[
            { value: 'all', label: t('gov.zone.all') },
            { value: 'border', label: t('gov.zone.border') },
            { value: 'around', label: t('gov.zone.around') },
          ]}
        />
        {d.zone === 'border' ? (
          <Select
            label={t('gov.zone.border')}
            value={d.nationId ?? ''}
            onChange={(nationId) => set({ nationId: nationId || undefined })}
            options={[{ value: '', label: t('gov.wizard.pick') }, ...neighbors]}
          />
        ) : null}
        {d.zone === 'around' ? (
          <>
            <Select
              label={t('gov.zone.around')}
              value={d.provinceId ?? ''}
              onChange={(provinceId) => set({ provinceId: provinceId || undefined })}
              options={[{ value: '', label: t('gov.wizard.pick') }, ...own]}
            />
            <Slider
              label={t('gov.zone.radius')}
              min={100}
              max={1500}
              step={50}
              value={d.radiusKm}
              onChange={(radiusKm) => set({ radiusKm })}
              format={(v) => `${formatInt(v)} km`}
            />
          </>
        ) : null}
      </div>
    </Field>
  );
}

function EstimatePanel({ d, def }: { d: MissionDraft; def: GovMissionDef }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const world = useWorld();
  const unit = useUnit();
  const gv = view?.government;
  const head = gv ? officeById(gv, d.office)?.head : null;
  const est =
    view && me
      ? estimatePlan(
          {
            view,
            me,
            provinces: world.provinces,
            catalog: world.catalog,
            research: world.research,
            balance: world.balance,
          },
          d,
          def,
        )
      : null;
  const env = envelopeUsd(d.budget, unit);
  const rev = revenueOf(view);
  const covers = coverCount(est, env);
  return (
    <section className="gov-estimate" data-testid="gov-estimate">
      <h4>{t('gov.estimate.title')}</h4>
      {est?.warn ? (
        <p className="gov-why gov-why--warn">
          <Icon name="warning" size={12} /> {t(est.warn, { count: est.options ?? 0 })}
        </p>
      ) : null}
      <dl>
        {est?.options != null ? (
          <>
            <dt>{t('gov.estimate.options')}</dt>
            <dd>{formatInt(est.options)}</dd>
          </>
        ) : null}
        {est?.first != null ? (
          <>
            <dt>{t('gov.estimate.first')}</dt>
            <dd>{formatMoney(est.first)}</dd>
          </>
        ) : null}
        {est?.total != null ? (
          <>
            <dt>{t('gov.estimate.total')}</dt>
            <dd>≈ {formatMoney(est.total)}</dd>
          </>
        ) : null}
        {est?.hours != null ? (
          <>
            <dt>{t('gov.estimate.hours')}</dt>
            <dd>{fmtDuration(est.hours * 3600_000)}</dd>
          </>
        ) : null}
        {def.exec === 'reserve' ? (
          <>
            <dt>{t('gov.estimate.reserveTarget')}</dt>
            <dd>{formatMoney(d.goal * unit)}</dd>
          </>
        ) : null}
        <dt>{t('gov.estimate.envelope')}</dt>
        <dd>
          {env !== null ? formatMoney(env) : t('gov.estimate.open')}
          {d.budget.mode === 'share'
            ? ` · ${formatMoney((rev * d.budget.pct) / 100)}${t('gov.perDay')}`
            : ''}
        </dd>
        {covers !== null && def.exec !== 'reserve' ? (
          <>
            <dt>{t('gov.estimate.covers')}</dt>
            <dd className={covers < 1 ? 'is-warn' : ''}>
              {t('gov.estimate.coversN', { count: covers })}
            </dd>
          </>
        ) : null}
      </dl>
      {head ? (
        <p className="gov-estimate__head">
          <Icon name="user" size={12} />
          {t('gov.estimate.head', {
            name: `${head.first} ${head.last}`,
            speed: num1(head.effects.speed * 100),
            discount: num1(head.effects.discount * 100),
            reserve: formatMoney(head.effects.reserveDays * unit),
          })}
        </p>
      ) : (
        <p className="gov-why gov-why--warn">
          <Icon name="warning" size={12} /> {t('gov.estimate.vacant')}
        </p>
      )}
      <p className="gov-muted">{t('gov.estimate.note')}</p>
    </section>
  );
}

export function MissionWizard({
  office,
  type: initial,
  mobile,
  onClose,
}: {
  office: GovOffice;
  /** Mission présélectionnée (suggestion) : l'assistant s'ouvre sur la cible et l'objectif. */
  type?: string;
  mobile: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const gv = useGame((s) => s.view?.government)!;
  const send = useSend();
  const unit = useUnit();
  const [step, setStep] = useState(() => (initial && gv.missionDefs[initial] ? 1 : 0));
  const [d, setD] = useState<MissionDraft>(() => {
    const e = emptyDraft(office);
    const def0 = initial ? gv.missionDefs[initial] : undefined;
    return def0 && initial ? withType(e, initial, def0) : e;
  });
  const set = (p: Partial<MissionDraft>) => setD((x) => ({ ...x, ...p }));
  const types = missionTypes(gv, office);
  const def = d.type ? gv.missionDefs[d.type] : undefined;
  const err = draftError(d, def);
  const steps = ['type', 'params', 'budget'] as const;
  const canNext = step === 0 ? !!def : step === 1 ? !err || err === 'gov.wizard.err.budget' : !err;
  const confirm = async () => {
    if (!def || err) return;
    const ok = await send(
      { kind: 'govMission', mission: toInput(d, def, unit) },
      t('gov.toast.created', { mission: t(`gov.missions.${d.type}.name`) }),
    );
    if (ok) onClose();
  };
  return (
    <div
      className={mobile ? 'gov-wizard gov-wizard--mobile' : 'gov-wizard'}
      data-testid="gov-wizard"
    >
      <ol className="gov-steps">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? 'is-on' : i < step ? 'is-done' : ''}>
            <span>{i + 1}</span>
            {t(`gov.wizard.step.${s}`)}
          </li>
        ))}
      </ol>
      <p className="gov-wizard__office">
        <Icon name="building" size={12} /> {t(`gov.offices.${office}.name`)}
      </p>
      <div className="gov-wizard__body">
        {step === 0 ? (
          <div className="gov-types" role="listbox" aria-label={t('gov.wizard.step.type')}>
            {types.map(([type, td]) => (
              <button
                key={type}
                type="button"
                role="option"
                aria-selected={d.type === type}
                className={d.type === type ? 'gov-type gov-type--on' : 'gov-type'}
                onClick={() => setD((x) => withType(x, type, td))}
                data-testid={`gov-type-${type}`}
              >
                <span className="gov-type__icon">
                  <Icon name={missionIcon({ type })} size={18} />
                </span>
                <b>{t(`gov.missions.${type}.name`)}</b>
                <span>{t(`gov.missions.${type}.desc`)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {step === 1 && def ? (
          <div className="gov-form">
            <TargetField def={def} d={d} set={set} />
            {def.zone ? <ZoneField d={d} set={set} /> : null}
            {autoGoal(def) ? (
              <p className="gov-muted">{t(`gov.goal.auto.${def.exec}`)}</p>
            ) : (
              <GoalField def={def} value={d.goal} onChange={(goal) => set({ goal })} />
            )}
            <Field label={t('gov.mission.priority')}>
              <Segmented
                label={t('gov.mission.priority')}
                value={d.priority}
                onChange={(priority) => set({ priority })}
                options={[1, 2, 3].map((p) => ({ value: p, label: t(`gov.priority.${p}`) }))}
              />
            </Field>
          </div>
        ) : null}
        {step === 2 && def ? (
          <div className="gov-wizard__final">
            <BudgetPicker value={d.budget} onChange={(budget) => set({ budget })} />
            <EstimatePanel d={d} def={def} />
          </div>
        ) : null}
      </div>
      {err &&
      step > 0 &&
      err !== 'gov.wizard.err.type' &&
      !(step === 1 && err === 'gov.wizard.err.budget') ? (
        <p className="gov-why gov-why--warn">
          <Icon name="warning" size={12} /> {t(err)}
        </p>
      ) : null}
      <footer className="gov-wizard__foot">
        <Button
          variant="ghost"
          size={mobile ? 'lg' : 'md'}
          onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
        >
          {step === 0 ? t('app.cancel') : t('gov.wizard.back')}
        </Button>
        <span className="gov-spacer" />
        {step < 2 ? (
          <Button
            variant="primary"
            size={mobile ? 'lg' : 'md'}
            disabled={!canNext}
            onClick={() => setStep(step + 1)}
            data-testid="gov-wizard-next"
          >
            {t('gov.wizard.next')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size={mobile ? 'lg' : 'md'}
            disabled={!!err}
            onClick={() => void confirm()}
            icon={<Icon name="check" size={13} />}
            data-testid="gov-wizard-confirm"
          >
            {t('gov.wizard.confirm')}
          </Button>
        )}
      </footer>
    </div>
  );
}
