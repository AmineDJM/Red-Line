import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Aggressiveness,
  CommandGeneralView,
  MissionDef,
  Order,
  Roe,
  UnitView,
} from '@redline/shared';
import { Badge, Button, Icon, Input, Segmented, Slider, formatInt, formatMoney } from '@redline/ui';
import { fmtKm, i18n } from '../i18n/index.js';
import {
  availableGenerals,
  composition,
  domainFit,
  domainsOf,
  dominantDomain,
  freePiles,
  groupPiles,
  keySkill,
  missionCost,
  missionList,
  nextArmyNumber,
  pileValue,
  previewEstimate,
  ratioText,
  targetReady,
  type Domain,
  type PileGroup,
} from '../lib/command.js';
import { nationName, provinceName, systemName } from '../lib/game.js';
import { missionInput, useCommandUi, type WizardStep } from '../store/command.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useSend } from './armyCommand.js';
import { GeneralCard, MISSION_ICON, etaLabel } from './CommandGenerals.js';
import { allCandidates } from '../lib/ops.js';

/**
 * Assistant du centre de commandement, en trois étapes : 1) composer l'armée (piles libres groupées
 * par milieu et par région, ou sélection de la carte), 2) choisir la mission et sa cible (désignée sur
 * la carte), ses paramètres et voir l'estimation, 3) choisir le général (compétences, traits, solde,
 * coût estimé de la mission) → Confirmer. Les mêmes écrans servent à renforcer une armée et à changer
 * de mission ou de général. Sur mobile : écrans successifs, gros boutons.
 */

/** Ouvre l'assistant de création d'une armée (piles sélectionnées sur la carte proposées d'office). */
export function openNewArmy(): void {
  const sel = useUi.getState().selection;
  const view = useGame.getState().view;
  const mine = new Set(
    freePiles(view, useGame.getState().me, useWorld.getState().catalog).map((u) => u.id),
  );
  useCommandUi.getState().startWizard({
    steps: ['compose', 'mission', 'general'],
    unitIds: sel.filter((id) => mine.has(id)),
  });
  useUi.getState().openWindow('command');
}

const DOMAIN_ICON: Record<Domain, 'army' | 'missile' | 'anchor'> = {
  land: 'army',
  air: 'missile',
  sea: 'anchor',
};

function Stepper({ steps, step }: { steps: WizardStep[]; step: WizardStep }) {
  const { t } = useTranslation();
  const patch = useCommandUi((s) => s.patch);
  const i = steps.indexOf(step);
  return (
    <ol className="cmd-stepper" aria-label={t('command.wizard.steps')}>
      {steps.map((s, k) => (
        <li key={s} className={k === i ? 'is-cur' : k < i ? 'is-done' : ''}>
          <button
            type="button"
            disabled={k > i}
            onClick={() => patch({ step: s })}
            aria-current={k === i ? 'step' : undefined}
          >
            <span className="cmd-stepper__n">
              {k < i ? <Icon name="check" size={11} /> : k + 1}
            </span>
            <span className="cmd-stepper__label">{t(`command.wizard.step.${s}`)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function PileGroupBlock({
  g,
  picked,
  toggle,
  toggleAll,
}: {
  g: PileGroup;
  picked: Set<string>;
  toggle: (id: string) => void;
  toggleAll: (ids: string[], on: boolean) => void;
}) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const all = g.piles.every((u) => picked.has(u.id));
  const some = g.piles.some((u) => picked.has(u.id));
  return (
    <div className="cmd-pgroup">
      <label className="cmd-pgroup__head">
        <input
          type="checkbox"
          checked={all}
          ref={(el) => {
            if (el) el.indeterminate = some && !all;
          }}
          onChange={(e) =>
            toggleAll(
              g.piles.map((u) => u.id),
              e.target.checked,
            )
          }
        />
        <Icon name={DOMAIN_ICON[g.domain]} size={13} />
        <b>{g.region}</b>
        <span>
          {t('command.piles', { count: g.piles.length })} · {formatInt(g.elements)} ·{' '}
          {formatMoney(g.value)}
        </span>
      </label>
      <ul className="cmd-pgroup__list">
        {g.piles.map((u) => (
          <li key={u.id}>
            <label className={picked.has(u.id) ? 'is-on' : ''}>
              <input
                type="checkbox"
                checked={picked.has(u.id)}
                onChange={() => toggle(u.id)}
                data-testid={`pick-${u.id}`}
              />
              <span className="cmd-pgroup__sys">{systemName(u.systemId)}</span>
              {u.parts && u.parts.length > 1 ? (
                <small>{t('command.wizard.mixed', { count: u.parts.length })}</small>
              ) : null}
              <span className="cmd-pgroup__n">×{formatInt(u.count ?? 1)}</span>
              <span className="cmd-pgroup__v">{formatMoney(pileValue(u, catalog))}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Summary({ units }: { units: UnitView[] }) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const rows = composition(units, catalog);
  const value = units.reduce((s, u) => s + pileValue(u, catalog), 0);
  const elements = units.reduce((s, u) => s + (u.count ?? 1), 0);
  const doms = domainsOf(units, catalog);
  return (
    <aside className="cmd-summary" data-testid="wizard-summary">
      <h4>{t('command.wizard.summary')}</h4>
      <div className="cmd-summary__kpi">
        <span>
          <small>{t('command.wizard.piles')}</small>
          <b>{units.length}</b>
        </span>
        <span>
          <small>{t('command.wizard.elements')}</small>
          <b>{formatInt(elements)}</b>
        </span>
        <span>
          <small>{t('command.wizard.value')}</small>
          <b className="is-amber">{formatMoney(value)}</b>
        </span>
      </div>
      <div className="cmd-chips">
        {(['land', 'air', 'sea'] as Domain[]).map((d) => (
          <span key={d} className={doms.has(d) ? 'cmd-chip is-on' : 'cmd-chip'}>
            <Icon name={DOMAIN_ICON[d]} size={11} /> {t(`command.domain.${d}`)}
          </span>
        ))}
      </div>
      <ul className="cmd-summary__comp">
        {rows.slice(0, 8).map((r) => (
          <li key={r.category}>
            <span>{t(`categories.${r.category}`)}</span>
            <b>{formatInt(r.elements)}</b>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ComposeStep({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const provinces = useWorld((s) => s.provinces);
  const selection = useUi((s) => s.selection);
  const draft = useCommandUi((s) => s.draft)!;
  const patch = useCommandUi((s) => s.patch);
  const setPicking = useCommandUi((s) => s.setPicking);
  const closeWindow = useUi((s) => s.closeWindow);
  const [domain, setDomain] = useState<Domain | 'all'>('all');
  const free = useMemo(() => freePiles(view, me, catalog), [view, me, catalog]);
  const groups = useMemo(
    () =>
      groupPiles(
        free.filter((u) => domain === 'all' || groupDomain(u) === domain),
        catalog,
        provinces,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [free, catalog, provinces, domain],
  );
  function groupDomain(u: UnitView): Domain {
    const m = u.systemId ? catalog[u.systemId]?.movement : 'land';
    return m === 'air' || m === 'sea' ? m : 'land';
  }
  const picked = new Set(draft.unitIds);
  const set = (ids: Set<string>) => patch({ unitIds: [...ids].sort() });
  const freeSel = selection.filter((id) => free.some((u) => u.id === id));
  const units = draft.unitIds.map((id) => view?.units[id]).filter((u): u is UnitView => !!u);
  const reinforcing = !!draft.armyId;
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step cmd-step--split'}>
      <div className="cmd-step__main">
        {!reinforcing ? (
          <label className="cmd-field">
            <span>{t('command.wizard.name')}</span>
            <Input
              value={draft.name}
              maxLength={40}
              placeholder={t('command.wizard.namePlaceholder')}
              onChange={(e) => patch({ name: e.target.value })}
              data-testid="wizard-name"
            />
          </label>
        ) : (
          <p className="cmd-lead">{t('command.wizard.reinforceLead', { name: draft.name })}</p>
        )}
        <div className="cmd-compose-tools">
          <Segmented<Domain | 'all'>
            size="sm"
            label={t('command.wizard.filter')}
            value={domain}
            onChange={setDomain}
            options={(['all', 'land', 'air', 'sea'] as const).map((d) => ({
              value: d,
              label: t(`command.domain.${d}`),
            }))}
          />
          <span className="cmd-detail__spacer" />
          {freeSel.length ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="target" size={12} />}
              onClick={() => set(new Set([...draft.unitIds, ...freeSel]))}
              data-testid="wizard-use-selection"
            >
              {t('command.wizard.useSelection', { count: freeSel.length })}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="map" size={12} />}
            onClick={() => {
              setPicking('units');
              closeWindow('command');
            }}
          >
            {t('command.wizard.pickOnMap')}
          </Button>
          {draft.unitIds.length ? (
            <Button size="sm" variant="ghost" onClick={() => set(new Set())}>
              {t('command.wizard.clear')}
            </Button>
          ) : null}
        </div>
        <div className="cmd-pgroups" data-testid="wizard-piles">
          {groups.length ? (
            groups.map((g) => (
              <PileGroupBlock
                key={`${g.domain}|${g.regionId}`}
                g={g}
                picked={picked}
                toggle={(id) => {
                  const next = new Set(picked);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  set(next);
                }}
                toggleAll={(ids, on) => {
                  const next = new Set(picked);
                  for (const id of ids)
                    if (on) next.add(id);
                    else next.delete(id);
                  set(next);
                }}
              />
            ))
          ) : (
            <p className="cmd-muted">{t('command.wizard.noFree')}</p>
          )}
        </div>
      </div>
      <Summary units={units} />
    </div>
  );
}

/** Nations proposées comme cible (voisines, en guerre, estimées par le renseignement). */
function nationOptions(view: ReturnType<typeof useGame.getState>['view']): string[] {
  const out = new Set<string>(Object.keys(view?.command?.estimates ?? {}));
  for (const [id, n] of Object.entries(view?.nations ?? {}))
    if (n.relation === 'war' && id !== view?.me) out.add(id);
  return [...out].sort((a, b) => nationName(a).localeCompare(nationName(b), 'fr'));
}

function MissionStep({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const catalog = useWorld((s) => s.catalog);
  const provinces = useWorld((s) => s.provinces);
  const balance = useWorld((s) => s.balance);
  const draft = useCommandUi((s) => s.draft)!;
  const patchMission = useCommandUi((s) => s.patchMission);
  const setPicking = useCommandUi((s) => s.setPicking);
  const closeWindow = useUi((s) => s.closeWindow);
  const command = view!.command!;
  const m = draft.mission;
  const units = draft.unitIds.map((id) => view?.units[id]).filter((u): u is UnitView => !!u);
  const have = domainsOf(units, catalog);
  const def: MissionDef | null = m.type ? (command.missions[m.type] ?? null) : null;
  const general =
    command.generals.find((g) => g.id === draft.generalId) ??
    allCandidates(command).find((g) => g.id === draft.generalId) ??
    null;
  const est =
    def && view && targetReady(def, m)
      ? previewEstimate({
          view,
          catalog,
          provinces,
          units,
          def,
          mission: m,
          general,
          captureMinutes: balance?.time.captureMinutes ?? 60,
        })
      : null;
  const pick = () => {
    setPicking('target');
    closeWindow('command');
  };
  const targetText = (): string => {
    if (!def) return '';
    if (def.target === 'zone' && m.at) {
      const p = m.provinceId ? provinces[m.provinceId] : undefined;
      return p ? (p.cityName ?? p.name) : `${m.at[1].toFixed(2)}, ${m.at[0].toFixed(2)}`;
    }
    if (m.provinceId) {
      const p = provinces[m.provinceId];
      const owner = view?.provinces[m.provinceId]?.owner;
      const name = p?.cityName ?? provinceName(m.provinceId);
      return owner ? `${name} — ${nationName(owner)}` : name;
    }
    if (m.nationId) return nationName(m.nationId);
    return '';
  };
  const own = m.provinceId && view?.provinces[m.provinceId]?.owner === view?.me;
  const wrongTarget = def?.target === 'province' && own;
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step'}>
      <div className="cmd-missions" role="radiogroup" aria-label={t('command.wizard.mission')}>
        {missionList(command).map(([id, d]) => {
          const fit = domainFit(d, have);
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={m.type === id}
              className={m.type === id ? 'cmd-mcard is-on' : 'cmd-mcard'}
              onClick={() =>
                patchMission({
                  type: id,
                  radiusKm: d.target === 'zone' ? d.radiusKm : undefined,
                  scope: d.brain === 'conquer' ? (m.scope ?? 'province') : undefined,
                })
              }
              data-testid={`mission-${id}`}
            >
              <span className={`cmd-mission__icon cmd-mission__icon--${d.brain}`}>
                <Icon name={MISSION_ICON[d.brain] ?? 'target'} size={16} />
              </span>
              <b>{t(`command.missions.${id}.name`, { defaultValue: id })}</b>
              <span className="cmd-mcard__desc">
                {t(`command.missions.${id}.desc`, { defaultValue: '' })}
              </span>
              <span className={`cmd-fit cmd-fit--${fit}`}>
                {d.domains.map((x) => t(`command.domain.${x}`)).join(' + ')}
                {fit !== 'ok' ? ` · ${t(`command.fit.${fit}`)}` : ''}
              </span>
            </button>
          );
        })}
      </div>
      {def ? (
        <div className="cmd-params" data-testid="mission-params">
          <div className="cmd-target">
            <span className="cmd-target__label">{t(`command.target.${def.target}`)}</span>
            <b className={targetReady(def, m) ? '' : 'cmd-muted'} data-testid="mission-target">
              {targetText() || t('command.target.none')}
            </b>
            {def.target !== 'none' ? (
              <Button
                size={mobile ? 'md' : 'sm'}
                variant={targetReady(def, m) ? 'ghost' : 'primary'}
                icon={<Icon name="target" size={12} />}
                onClick={pick}
                data-testid="mission-pick"
              >
                {targetReady(def, m) ? t('command.target.change') : t('command.target.pick')}
              </Button>
            ) : null}
            {def.target === 'nation' ? (
              <span className="rl-select cmd-nation">
                <select
                  value={m.nationId ?? ''}
                  aria-label={t('command.target.nation')}
                  onChange={(e) =>
                    patchMission({ nationId: e.target.value || undefined, provinceId: undefined })
                  }
                >
                  <option value="">{t('command.target.nationAny')}</option>
                  {nationOptions(view).map((n) => (
                    <option key={n} value={n}>
                      {nationName(n)}
                    </option>
                  ))}
                </select>
              </span>
            ) : null}
          </div>
          {wrongTarget ? <p className="cmd-warn">{t('command.target.own')}</p> : null}
          {def.brain === 'conquer' && m.provinceId ? (
            <Segmented<'province' | 'region' | 'nation'>
              size="sm"
              label={t('command.scope.label')}
              value={m.scope ?? 'province'}
              onChange={(v) =>
                patchMission({ scope: v, radiusKm: v === 'region' ? m.radiusKm || 200 : undefined })
              }
              options={(['province', 'region', 'nation'] as const).map((v) => ({
                value: v,
                label: t(`command.scope.${v}`),
              }))}
            />
          ) : null}
          {def.target === 'zone' || (def.brain === 'conquer' && m.scope === 'region') ? (
            <div className="cmd-slider">
              <span className="cmd-param__label">{t('command.radius')}</span>
              <Slider
                label={t('command.radius')}
                min={30}
                max={def.brain === 'air_superiority' ? 600 : 800}
                step={10}
                value={m.radiusKm ?? (def.radiusKm || 200)}
                onChange={(v) => patchMission({ radiusKm: v })}
                format={(v) => fmtKm(v)}
              />
            </div>
          ) : null}
          <div className="cmd-params__row">
            <div>
              <span className="cmd-param__label">{t('command.aggr.label')}</span>
              <Segmented<Aggressiveness>
                size="sm"
                label={t('command.aggr.label')}
                value={m.aggr}
                onChange={(v) => patchMission({ aggr: v, retreatAt: undefined })}
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
                value={m.roe}
                onChange={(v) => patchMission({ roe: v })}
                options={(['strict', 'standard', 'free'] as const).map((v) => ({
                  value: v,
                  label: t(`command.roe.${v}.short`),
                  title: t(`command.roe.${v}.help`),
                }))}
              />
            </div>
          </div>
          <p className="cmd-hint">{t(`command.roe.${m.roe}.help`)}</p>
          <div className="cmd-slider">
            <span className="cmd-param__label">{t('command.retreat.label')}</span>
            <Slider
              label={t('command.retreat.label')}
              min={0}
              max={0.8}
              step={0.05}
              value={
                m.retreatAt ??
                balance?.command?.aggressiveness?.[m.aggr]?.retreatAt ??
                RETREAT_DEFAULT[m.aggr]
              }
              onChange={(v) => patchMission({ retreatAt: v })}
              format={(v) => (v <= 0 ? t('command.retreat.never') : `${Math.round(v * 100)} %`)}
            />
          </div>
          {est ? <EstimateBox est={est} /> : null}
        </div>
      ) : (
        <p className="cmd-muted cmd-pad">{t('command.wizard.pickMission')}</p>
      )}
    </div>
  );
}

const RETREAT_DEFAULT: Record<Aggressiveness, number> = {
  cautious: 0.5,
  balanced: 0.35,
  bold: 0.2,
};

function EstimateBox({ est }: { est: ReturnType<typeof previewEstimate> }) {
  const { t } = useTranslation();
  return (
    <div className="cmd-est cmd-est--box" data-testid="mission-estimate">
      <div>
        <span>{t('command.est.ratio')}</span>
        <b className={est.ratio >= 1.5 ? 'is-good' : est.ratio >= 1 ? 'is-warn' : 'is-bad'}>
          {est.ratio >= 99 ? '—' : ratioText(est.ratio, i18n.language)}
        </b>
        <small>{t(`command.est.source.${est.source}`)}</small>
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
    </div>
  );
}

function GeneralStep({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const catalog = useWorld((s) => s.catalog);
  const provinces = useWorld((s) => s.provinces);
  const balance = useWorld((s) => s.balance);
  const draft = useCommandUi((s) => s.draft)!;
  const patch = useCommandUi((s) => s.patch);
  const command = view!.command!;
  const def = draft.mission.type ? command.missions[draft.mission.type] : null;
  const units = draft.unitIds.map((id) => view?.units[id]).filter((u): u is UnitView => !!u);
  const current = command.generals.find(
    (g) => g.id === draft.generalId && g.armyId === draft.armyId,
  );
  const mine = [
    ...(current && draft.armyId ? [current] : []),
    ...availableGenerals(command).filter((g) => g.id !== current?.id),
  ];
  const cost = (g: CommandGeneralView) => {
    if (!def || !view) return null;
    const est = previewEstimate({
      view,
      catalog,
      provinces,
      units,
      def,
      mission: draft.mission,
      general: g,
      captureMinutes: balance?.time.captureMinutes ?? 60,
    });
    return missionCost(g, est.etaHours);
  };
  const card = (g: CommandGeneralView) => (
    <GeneralCard
      key={g.id}
      g={g}
      selected={draft.generalId === g.id}
      onSelect={() => patch({ generalId: g.id })}
      highlight={def ? keySkill(def) : undefined}
      cost={cost(g)}
      testId={`wizard-general-${g.id}`}
    />
  );
  return (
    <div className={mobile ? 'cmd-step cmd-step--mobile' : 'cmd-step'}>
      {def ? (
        <p className="cmd-lead">
          {t('command.wizard.generalLead', {
            skill: t(`command.skills.${keySkill(def)}.label`),
          })}
        </p>
      ) : null}
      {mine.length ? (
        <>
          <h4 className="cmd-h">{t('command.generals.yours')}</h4>
          <div className="cmd-grid">{mine.map(card)}</div>
        </>
      ) : null}
      <h4 className="cmd-h">
        {t('command.generals.pool')}
        <small>{t('command.generals.poolHint')}</small>
      </h4>
      <div className="cmd-grid">
        {[...allCandidates(command)]
          .sort((a, b) => (def ? b.skills[keySkill(def)] - a.skills[keySkill(def)] : 0))
          .map(card)}
      </div>
    </div>
  );
}

export function CommandWizard({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const draft = useCommandUi((s) => s.draft)!;
  const patch = useCommandUi((s) => s.patch);
  const closeWizard = useCommandUi((s) => s.closeWizard);
  const select = useCommandUi((s) => s.select);
  const send = useSend();
  const [busy, setBusy] = useState(false);
  const command = view!.command!;
  const i = draft.steps.indexOf(draft.step);
  const last = i === draft.steps.length - 1;
  const units = draft.unitIds.map((id) => view?.units[id]).filter((u): u is UnitView => !!u);
  const def = draft.mission.type ? command.missions[draft.mission.type] : null;
  const nationOf = (pid: string) => view?.provinces[pid]?.owner;
  const generalSel =
    command.generals.find((g) => g.id === draft.generalId) ??
    allCandidates(command).find((g) => g.id === draft.generalId) ??
    null;
  const ownTarget =
    def?.target === 'province' &&
    !!draft.mission.provinceId &&
    view?.provinces[draft.mission.provinceId]?.owner === me;

  const can: Record<WizardStep, boolean> = {
    compose: units.length > 0,
    mission: !!def && targetReady(def, draft.mission) && !ownTarget,
    general: !!generalSel,
  };

  const defaultName = (): string => {
    const d = dominantDomain(units, catalog);
    const nameOf = (n: number) =>
      n === 1 ? t(`command.defaultName.${d}First`) : t(`command.defaultName.${d}`, { n });
    return nameOf(nextArmyNumber(command, nameOf));
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const mission = missionInput(draft.mission, nationOf);
      const hire = generalSel?.status === 'candidate' ? generalSel.id : undefined;
      const gen = generalSel && generalSel.status !== 'candidate' ? generalSel.id : undefined;
      if (!draft.armyId) {
        const name = draft.name.trim() || defaultName();
        const before = new Set(command.armies.map((a) => a.id));
        const order: Order = {
          kind: 'armyCreate',
          name,
          unitIds: draft.unitIds,
          ...(hire ? { candidateId: hire } : {}),
          ...(gen ? { generalId: gen } : {}),
          ...(mission && generalSel ? { mission } : {}),
        };
        if (await send(order, t('command.toast.created', { name }))) {
          closeWizard();
          // Nouvelle armée : affichée dès que la vue la reçoit (au plus 5 s d'attente).
          let tries = 0;
          const find = () => {
            const a = useGame
              .getState()
              .view?.command?.armies.find((x) => !before.has(x.id) && x.name === name);
            if (a) select(a.id);
            else if (++tries < 25) setTimeout(find, 200);
          };
          setTimeout(find, 100);
        }
        return;
      }
      const armyId = draft.armyId;
      if (draft.steps.length === 1 && draft.step === 'compose') {
        if (
          await send(
            { kind: 'armyEdit', armyId, add: draft.unitIds },
            t('command.toast.reinforced', { count: draft.unitIds.length }),
          )
        )
          closeWizard();
        return;
      }
      let ok = true;
      const army = command.armies.find((a) => a.id === armyId);
      if (hire)
        ok = await send(
          { kind: 'generalHire', candidateId: hire, armyId },
          t('command.toast.hiredShort'),
        );
      else if (gen && army?.generalId !== gen)
        ok = await send(
          { kind: 'generalAssign', generalId: gen, armyId },
          t('command.toast.assigned'),
        );
      if (ok && mission && draft.steps.includes('mission'))
        ok = await send({ kind: 'armyMission', armyId, mission }, t('command.toast.mission'));
      if (ok) closeWizard();
    } finally {
      setBusy(false);
    }
  };

  const createWithout = async () => {
    const name = draft.name.trim() || defaultName();
    if (
      await send(
        { kind: 'armyCreate', name, unitIds: draft.unitIds },
        t('command.toast.created', { name }),
      )
    )
      closeWizard();
  };

  const totalCost = (() => {
    if (!generalSel) return null;
    return generalSel.status === 'candidate' ? generalSel.hireCost : 0;
  })();

  return (
    <div
      className={mobile ? 'cmd-wizard cmd-wizard--mobile' : 'cmd-wizard'}
      data-testid="army-wizard"
    >
      <header className="cmd-wizard__head">
        <Stepper steps={draft.steps} step={draft.step} />
        <span className="cmd-detail__spacer" />
        <Button size="sm" variant="ghost" onClick={closeWizard} data-testid="wizard-cancel">
          {t('app.cancel')}
        </Button>
      </header>
      <div className="cmd-wizard__body">
        {draft.step === 'compose' ? (
          <ComposeStep mobile={mobile} />
        ) : draft.step === 'mission' ? (
          <MissionStep mobile={mobile} />
        ) : (
          <GeneralStep mobile={mobile} />
        )}
      </div>
      <footer className="cmd-wizard__foot">
        {i > 0 ? (
          <Button
            size={mobile ? 'lg' : 'md'}
            variant="ghost"
            onClick={() => patch({ step: draft.steps[i - 1]! })}
          >
            {t('app.previous')}
          </Button>
        ) : null}
        {draft.step === 'compose' && !draft.armyId && can.compose ? (
          <Button size={mobile ? 'lg' : 'md'} variant="ghost" onClick={() => void createWithout()}>
            {t('command.wizard.createOnly')}
          </Button>
        ) : null}
        <span className="cmd-detail__spacer" />
        {draft.step === 'general' && generalSel ? (
          <span className="cmd-foot__cost">
            {generalSel.status === 'candidate'
              ? t('command.wizard.costHire', {
                  bonus: formatMoney(totalCost ?? 0),
                  day: formatMoney(generalSel.salaryPerDay),
                })
              : t('command.wizard.costDay', { day: formatMoney(generalSel.salaryPerDay) })}
          </span>
        ) : null}
        {last ? (
          <Button
            size={mobile ? 'lg' : 'md'}
            variant="primary"
            icon={<Icon name="check" size={13} />}
            disabled={busy || !draft.steps.every((s) => can[s])}
            onClick={() => void confirm()}
            data-testid="wizard-confirm"
          >
            {draft.armyId && draft.steps.length === 1 && draft.step === 'compose'
              ? t('command.wizard.addPiles', { count: draft.unitIds.length })
              : t('app.confirm')}
          </Button>
        ) : (
          <Button
            size={mobile ? 'lg' : 'md'}
            variant="primary"
            disabled={!can[draft.step]}
            onClick={() => patch({ step: draft.steps[i + 1]! })}
            data-testid="wizard-next"
          >
            {t('app.next')}
          </Button>
        )}
      </footer>
      {draft.step === 'mission' && def && !can.mission ? (
        <p className="cmd-wizard__why">
          <Badge tone="amber">{t('command.wizard.missing')}</Badge>{' '}
          {ownTarget ? t('command.target.own') : t('command.target.needed')}
        </p>
      ) : null}
    </div>
  );
}
