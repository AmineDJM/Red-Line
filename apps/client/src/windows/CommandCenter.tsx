import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArmyView, CommandView, PlayerView, ReinforceMode } from '@redline/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  Input,
  ProgressBar,
  Segmented,
  Tabs,
  Window,
  formatInt,
  formatMoney,
  pictogramForCategory,
  Pictogram,
  type Tone,
} from '@redline/ui';
import frEngine from '../i18n/fr.engine.json';
import { fmtClock, i18n } from '../i18n/index.js';
import {
  armyUnits,
  centroidOf,
  composition,
  generalOf,
  healthOf,
  keySkill,
  pendingRequests,
  pill,
  ratioText,
  strengthOf,
  supplyOf,
  journalText,
  supplyPill,
  type Pill,
} from '../lib/command.js';
import { nationName, provinceName, systemName } from '../lib/game.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useCommandUi } from '../store/command.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useSend } from './armyCommand.js';
import { GeneralCard, GeneralsPane, MISSION_ICON, etaLabel } from './CommandGenerals.js';
import { CommandWizard, openNewArmy } from './CommandWizard.js';
import { OpWizard, OpsPane, pendingOpRequests } from './CommandOps.js';
import { WaitLine } from './CommandPlan.js';
import './command.css';

/**
 * Centre de commandement : armées du joueur (liste à gauche, armée sélectionnée au centre), mission
 * et général, journal du général, demandes à valider ; assistant de création ; vivier de généraux.
 * Écran simple : chaque armée tient en un coup d'œil (santé, effectifs, logistique, objectif).
 */

// Textes du moteur (journal du général) : présents dans toutes les langues ; en français, le
// dictionnaire du moteur n'est pas embarqué dans le paquet principal, on l'ajoute ici.
let enginePatched = false;
function ensureEngineTexts(): void {
  if (enginePatched) return;
  enginePatched = true;
  const cmd = (frEngine as { engine: { cmd?: unknown } }).engine.cmd;
  if (cmd) i18n.addResourceBundle('fr', 'translation', { engine: { cmd } }, true, false);
}

const STATUS_TONE: Record<ArmyView['status'], Tone> = {
  idle: 'neutral',
  passive: 'amber',
  preparing: 'cyan',
  active: 'green',
  awaiting: 'amber',
  success: 'green',
  failed: 'red',
  suspended: 'neutral',
};

export function StatusBadge({ a }: { a: ArmyView }) {
  const { t } = useTranslation();
  return (
    <Badge
      tone={STATUS_TONE[a.status]}
      dot
      pulse={a.status === 'active' || a.status === 'awaiting'}
    >
      {t(`command.status.${a.status}`)}
    </Badge>
  );
}

function PillDot({ p, label }: { p: Pill; label: string }) {
  return <i className={`cmd-pill cmd-pill--${p}`} title={label} aria-label={label} />;
}

/** Pastilles santé / effectifs / logistique d'une armée. */
function Pills({ a, view }: { a: ArmyView; view: PlayerView | null }) {
  const { t } = useTranslation();
  const units = armyUnits(a, view);
  const hp = healthOf(units);
  const st = strengthOf(a);
  const sup = supplyOf(units);
  return (
    <span className="cmd-pills">
      <PillDot p={pill(hp)} label={t('command.pills.health', { pct: Math.round(hp * 100) })} />
      <PillDot p={pill(st)} label={t('command.pills.strength', { pct: Math.round(st * 100) })} />
      <PillDot p={supplyPill(sup)} label={t(`command.pills.supply.${sup ?? 'supplied'}`)} />
    </span>
  );
}

function missionLabel(a: ArmyView, t: (k: string, o?: Record<string, unknown>) => string): string {
  const m = a.mission;
  if (!m) return t('command.noMission');
  const name = t(`command.missions.${m.type}.name`, { defaultValue: m.type });
  const target = m.provinceId
    ? (useWorld.getState().provinces[m.provinceId]?.cityName ?? provinceName(m.provinceId))
    : m.nationId
      ? nationName(m.nationId)
      : m.at
        ? t('command.zoneShort', { km: m.radiusKm ?? 0 })
        : '';
  return target ? `${name} · ${target}` : name;
}

function ArmyRow({
  a,
  sel,
  onClick,
  command,
  view,
}: {
  a: ArmyView;
  sel: boolean;
  onClick: () => void;
  command: CommandView;
  view: PlayerView | null;
}) {
  const { t } = useTranslation();
  const g = generalOf(command, a.generalId);
  const units = armyUnits(a, view);
  const elements = units.reduce((s, u) => s + (u.count ?? 1), 0);
  return (
    <li>
      <button
        type="button"
        className={sel ? 'cmd-row cmd-row--sel' : 'cmd-row'}
        onClick={onClick}
        aria-pressed={sel}
        data-testid={`army-row-${a.id}`}
      >
        <span className="cmd-row__top">
          <b className="cmd-row__name">{a.name}</b>
          {a.request ? (
            <Badge tone="amber" variant="solid">
              {t('command.request.badge')}
            </Badge>
          ) : (
            <StatusBadge a={a} />
          )}
        </span>
        <span className="cmd-row__mission">{missionLabel(a, t)}</span>
        <span className="cmd-row__bottom">
          <span className={g ? 'cmd-row__gen' : 'cmd-row__gen cmd-row__gen--none'}>
            <Icon name="star" size={11} />
            {g ? `${g.first[0]}. ${g.last}` : t('command.noGeneral')}
          </span>
          <span className="cmd-row__n">
            {t('command.piles', { count: units.length })} · {formatInt(elements)}
          </span>
          <Pills a={a} view={view} />
        </span>
      </button>
    </li>
  );
}

/** Demande du général (autorisation de guerre, de frappe stratégique, renforts). */
function RequestBanner({ a }: { a: ArmyView }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const send = useSend();
  const r = a.request!;
  const answer = (accept: boolean) =>
    void send(
      { kind: 'armyAnswer', armyId: a.id, requestId: r.id, accept },
      accept ? t('command.request.accepted') : t('command.request.refused'),
    );
  const piles = (r.unitIds ?? []).map((id) => view?.units[id]).filter((u) => !!u);
  return (
    <div className="cmd-request" role="alert" data-testid="army-request">
      <Icon name="warning" size={16} />
      <div className="cmd-request__text">
        <b>{t(`command.request.${r.kind}.title`)}</b>
        <span>
          {t(`command.request.${r.kind}.text`, {
            nation: r.nationId ? nationName(r.nationId) : '',
            count: piles.length,
          })}
        </span>
        {piles.length ? (
          <small>
            {piles
              .map((u) => `${systemName(u!.systemId)} ×${u!.count ?? 1}`)
              .slice(0, 4)
              .join(' · ')}
          </small>
        ) : null}
      </div>
      <div className="cmd-request__actions">
        <Button size="sm" variant="ghost" onClick={() => answer(false)}>
          {t('command.request.refuse')}
        </Button>
        <Button
          size="sm"
          variant={r.kind === 'reinforce' ? 'primary' : 'danger'}
          onClick={() => answer(true)}
          data-testid="army-request-accept"
        >
          {t(`command.request.${r.kind}.accept`)}
        </Button>
      </div>
    </div>
  );
}

function MissionPanel({ a, command }: { a: ArmyView; command: CommandView }) {
  const { t } = useTranslation();
  const m = a.mission;
  if (!m)
    return (
      <section className="cmd-panel">
        <h4 className="cmd-panel__title">{t('command.detail.mission')}</h4>
        <p className="cmd-muted">{t('command.detail.noMissionText')}</p>
      </section>
    );
  const def = command.missions[m.type];
  const obj = a.objective;
  const est = a.estimate;
  return (
    <section className="cmd-panel" data-testid="army-mission">
      <h4 className="cmd-panel__title">
        {t('command.detail.mission')}
        <span>{t('command.detail.since', fmtClock(m.since))}</span>
      </h4>
      <div className="cmd-mission">
        <span className={`cmd-mission__icon cmd-mission__icon--${m.brain}`}>
          <Icon name={MISSION_ICON[m.brain] ?? 'target'} size={18} />
        </span>
        <div>
          <b>{missionLabel(a, t)}</b>
          <span className="cmd-chips">
            <span className="cmd-chip">{t(`command.aggr.${m.aggr}`)}</span>
            <span className="cmd-chip">{t(`command.roe.${m.roe}.short`)}</span>
            <span className="cmd-chip">
              {t('command.detail.retreat', { pct: Math.round(m.retreatAt * 100) })}
            </span>
          </span>
        </div>
      </div>
      {obj ? (
        <div className="cmd-objective">
          <span>{t(`command.objective.${def?.brain ?? 'conquer'}`)}</span>
          <ProgressBar
            value={obj.total ? obj.done / obj.total : 0}
            tone={a.status === 'failed' ? 'red' : 'green'}
            label={t('command.detail.objective')}
            trailing={`${obj.done}/${obj.total}`}
          />
        </div>
      ) : null}
      {est ? (
        <div className="cmd-est">
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
            <b
              className={est.chance >= 0.65 ? 'is-good' : est.chance >= 0.4 ? 'is-warn' : 'is-bad'}
            >
              {Math.round(est.chance * 100)} %
            </b>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CompositionPanel({ a, view }: { a: ArmyView; view: PlayerView | null }) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const send = useSend();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const units = armyUnits(a, view);
  const rows = composition(units, catalog);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const manual = new Set(a.manualIds);
  return (
    <section className="cmd-panel" data-testid="army-composition">
      <h4 className="cmd-panel__title">
        {t('command.detail.composition')}
        <span>{formatMoney(total)}</span>
        <button type="button" className="cmd-link" onClick={() => setEditing(!editing)}>
          {editing ? t('command.detail.doneEditing') : t('command.detail.piles')}
        </button>
      </h4>
      {!editing ? (
        <ul className="cmd-comp">
          {rows.map((r) => (
            <li key={r.category}>
              <Pictogram id={pictogramForCategory(r.category)} size={18} />
              <span className="cmd-comp__name">{t(`categories.${r.category}`)}</span>
              <span className="cmd-comp__n">
                <b>{formatInt(r.elements)}</b>
                <small>{t('command.piles', { count: r.piles })}</small>
              </span>
              <span className="cmd-comp__bar">
                <i style={{ width: `${total ? (100 * r.value) / total : 0}%` }} />
              </span>
            </li>
          ))}
          {!rows.length ? <li className="cmd-muted">{t('command.detail.empty')}</li> : null}
        </ul>
      ) : (
        <>
          <ul className="cmd-piles">
            {units.map((u) => (
              <li key={u.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(u.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(u.id);
                      else next.delete(u.id);
                      setPicked(next);
                    }}
                  />
                  <span>{systemName(u.systemId)}</span>
                  <small>×{u.count ?? 1}</small>
                  {manual.has(u.id) ? (
                    <Badge tone="cyan" variant="outline" title={t('command.detail.manualHelp')}>
                      {t('command.detail.manual')}
                    </Badge>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
          <div className="cmd-piles__actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={!picked.size}
              onClick={() => {
                void send(
                  { kind: 'armyEdit', armyId: a.id, remove: [...picked] },
                  t('command.toast.removed', { count: picked.size }),
                );
                setPicked(new Set());
              }}
            >
              {t('command.actions.removeN', { count: picked.size })}
            </Button>
          </div>
        </>
      )}
      <p className="cmd-hint">
        <Icon name="info" size={11} /> {t('command.detail.manualRule')}
      </p>
    </section>
  );
}

function JournalPanel({ a }: { a: ArmyView }) {
  const { t } = useTranslation();
  const list = [...a.journal].reverse();
  return (
    <section className="cmd-panel cmd-panel--journal" data-testid="army-journal">
      <h4 className="cmd-panel__title">{t('command.detail.journal')}</h4>
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

function ArmyDetail({ a, mobile, onBack }: { a: ArmyView; mobile: boolean; onBack: () => void }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const send = useSend();
  const select = useUi((s) => s.select);
  const focusOn = useUi((s) => s.focusOn);
  const closeWindow = useUi((s) => s.closeWindow);
  const startWizard = useCommandUi((s) => s.startWizard);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(a.name);
  const [dissolve, setDissolve] = useState(false);
  const g = generalOf(command, a.generalId);
  const units = armyUnits(a, view);
  const at = centroidOf(units.map((u) => u.pos));
  const def = a.mission ? command.missions[a.mission.type] : null;

  const showOnMap = () => {
    select(a.unitIds.filter((id) => !!view?.units[id]));
    if (at) focusOn(at, units.length > 3 ? 5.5 : 6.5);
    closeWindow('command');
  };
  const mission = () =>
    startWizard({
      armyId: a.id,
      steps: ['mission', 'general'],
      name: a.name,
      unitIds: a.unitIds,
      generalId: a.generalId,
      mission: a.mission
        ? {
            type: a.mission.type,
            provinceId: a.mission.provinceId,
            nationId: a.mission.nationId,
            at: a.mission.at,
            radiusKm: a.mission.radiusKm,
            aggr: a.mission.aggr,
            roe: a.mission.roe,
            retreatAt: a.mission.retreatAt,
          }
        : { type: null, aggr: 'balanced', roe: 'standard' },
    });
  const reinforce = () =>
    startWizard({ armyId: a.id, steps: ['compose'], name: a.name, unitIds: [] });
  const general = () =>
    startWizard({
      armyId: a.id,
      steps: ['general'],
      name: a.name,
      unitIds: a.unitIds,
      generalId: a.generalId,
      mission: a.mission
        ? { type: a.mission.type, aggr: a.mission.aggr, roe: a.mission.roe }
        : { type: null, aggr: 'balanced', roe: 'standard' },
    });

  const reinforceSeg = (
    <Segmented<ReinforceMode>
      size="sm"
      label={t('command.reinforce.label')}
      value={a.reinforce}
      onChange={(v) =>
        void send({ kind: 'armyEdit', armyId: a.id, reinforce: v }, t('command.toast.saved'))
      }
      options={(['off', 'ask', 'auto'] as const).map((v) => ({
        value: v,
        label: t(`command.reinforce.${v}`),
        title: t(`command.reinforce.${v}Help`),
      }))}
    />
  );
  const dissolveBtn = (
    <Button size={mobile ? 'lg' : 'md'} variant="danger" onClick={() => setDissolve(true)}>
      {t('command.actions.dissolve')}
    </Button>
  );

  return (
    <div className="cmd-detail" data-testid="army-detail">
      <header className="cmd-detail__head">
        {mobile ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="close" size={12} />}
            onClick={onBack}
            data-testid="army-back"
          >
            {t('command.back')}
          </Button>
        ) : null}
        {renaming ? (
          <form
            className="cmd-rename"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== a.name)
                void send(
                  { kind: 'armyEdit', armyId: a.id, name: name.trim() },
                  t('command.toast.renamed'),
                );
              setRenaming(false);
            }}
          >
            <Input
              value={name}
              maxLength={40}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              aria-label={t('command.wizard.name')}
            />
            <Button size="sm" type="submit" variant="primary">
              {t('app.confirm')}
            </Button>
          </form>
        ) : (
          <h3 className="cmd-detail__name">
            {a.name}
            <button
              type="button"
              className="cmd-icon-btn"
              aria-label={t('command.actions.rename')}
              onClick={() => {
                setName(a.name);
                setRenaming(true);
              }}
            >
              <Icon name="edit" size={12} />
            </button>
          </h3>
        )}
        <StatusBadge a={a} />
        <span className="cmd-detail__spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="map" size={12} />}
          onClick={showOnMap}
          data-testid="army-show-map"
        >
          {t('command.actions.showMap')}
        </Button>
      </header>
      {a.request ? <RequestBanner a={a} /> : null}
      {a.opId ? (
        <div className="cmd-request cmd-request--info" role="status" data-testid="army-op">
          <Icon name="link" size={16} />
          <div className="cmd-request__text">
            <b>
              {t('command.armyOp.title', {
                name: command.ops?.find((o) => o.id === a.opId)?.name ?? a.opId,
              })}
            </b>
            <span>
              {a.posture ? t(`command.posture.${a.posture}Help`) : t('command.armyOp.text')}
            </span>
          </div>
          <div className="cmd-request__actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                useCommandUi.getState().selectOp(a.opId!);
                useCommandUi.getState().setTab('ops');
              }}
              data-testid="army-op-open"
            >
              {t('command.armyOp.open')}
            </Button>
          </div>
        </div>
      ) : a.posture ? (
        <div className="cmd-request cmd-request--info" role="status" data-testid="army-posture">
          <Icon name="shield" size={16} />
          <div className="cmd-request__text">
            <b>{t(`command.posture.${a.posture}`)}</b>
            <span>{t(`command.posture.${a.posture}Help`)}</span>
          </div>
        </div>
      ) : null}
      {a.wait && !a.request ? (
        <WaitLine
          wait={a.wait}
          actions={{
            manual: {
              label: t('command.wait.act.manual'),
              run: () =>
                void send(
                  { kind: 'armyEdit', armyId: a.id, reclaim: true },
                  t('command.toast.reclaimed'),
                ),
            },
            suspended: {
              label: t('command.actions.resume'),
              run: () =>
                void send(
                  { kind: 'armySuspend', armyId: a.id, on: false },
                  t('command.toast.resumed'),
                ),
            },
            noGeneral: { label: t('command.actions.pickGeneral'), run: general },
            noForces: { label: t('command.actions.reinforce'), run: reinforce },
            noTargets: { label: t('command.actions.changeMission'), run: mission },
            ...(a.opId
              ? {
                  staging: {
                    label: t('command.wait.act.staging'),
                    run: () =>
                      void send(
                        { kind: 'campaignEdit', opId: a.opId!, stageNow: true },
                        t('command.ops.toast.stageNow'),
                      ),
                  },
                }
              : {}),
          }}
        />
      ) : null}
      <div className="cmd-detail__grid">
        <MissionPanel a={a} command={command} />
        <section className="cmd-panel" data-testid="army-general">
          <h4 className="cmd-panel__title">
            {t('command.detail.general')}
            <button type="button" className="cmd-link" onClick={general}>
              {g ? t('command.actions.changeGeneral') : t('command.actions.pickGeneral')}
            </button>
          </h4>
          {g ? (
            <GeneralCard g={g} highlight={def ? keySkill(def) : undefined} />
          ) : (
            <div className="cmd-nogen">
              <Icon name="warning" size={16} />
              <p>{t('command.detail.noGeneralText')}</p>
              <Button size="sm" variant="primary" onClick={general}>
                {t('command.actions.pickGeneral')}
              </Button>
            </div>
          )}
        </section>
        <CompositionPanel a={a} view={view} />
        <JournalPanel a={a} />
      </div>
      {mobile ? (
        <section className="cmd-detail__more">
          <h4 className="cmd-panel__title">{t('command.reinforce.label')}</h4>
          {reinforceSeg}
          <p className="cmd-hint">{t(`command.reinforce.${a.reinforce}Help`)}</p>
          {dissolveBtn}
        </section>
      ) : null}
      <footer className="cmd-detail__foot">
        <Button
          size={mobile ? 'lg' : 'md'}
          icon={<Icon name="plus" size={13} />}
          onClick={reinforce}
          data-testid="army-reinforce"
        >
          {t('command.actions.reinforce')}
        </Button>
        <Button
          size={mobile ? 'lg' : 'md'}
          variant="primary"
          icon={<Icon name="target" size={13} />}
          onClick={mission}
          data-testid="army-mission-change"
        >
          {a.mission ? t('command.actions.changeMission') : t('command.actions.giveMission')}
        </Button>
        {a.mission && a.status !== 'success' && a.status !== 'failed' ? (
          <Button
            size={mobile ? 'lg' : 'md'}
            variant="ghost"
            icon={<Icon name={a.status === 'suspended' ? 'play' : 'pause'} size={13} />}
            onClick={() =>
              void send(
                { kind: 'armySuspend', armyId: a.id, on: a.status !== 'suspended' },
                a.status === 'suspended'
                  ? t('command.toast.resumed')
                  : t('command.toast.suspended'),
              )
            }
          >
            {a.status === 'suspended' ? t('command.actions.resume') : t('command.actions.suspend')}
          </Button>
        ) : null}
        {mobile ? null : (
          <>
            {reinforceSeg}
            <span className="cmd-detail__spacer" />
            {dissolveBtn}
          </>
        )}
      </footer>
      <Dialog
        open={dissolve}
        title={t('command.actions.dissolveTitle')}
        tone="red"
        onClose={() => setDissolve(false)}
        closeLabel={t('app.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDissolve(false)}>
              {t('app.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void send({ kind: 'armyDissolve', armyId: a.id }, t('command.toast.dissolved'));
                setDissolve(false);
              }}
            >
              {t('command.actions.dissolve')}
            </Button>
          </>
        }
      >
        <p>{t('command.actions.dissolveText', { name: a.name })}</p>
      </Dialog>
    </div>
  );
}

function ArmiesPane({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const command = view!.command!;
  const selected = useCommandUi((s) => s.selected);
  const select = useCommandUi((s) => s.select);
  // Mobile : une armée désignée (création, lien depuis la carte) s'ouvre directement.
  const [mobileDetail, setMobileDetail] = useState(selected != null);
  useEffect(() => {
    if (selected) setMobileDetail(true);
  }, [selected]);
  const armies = command.armies;
  const cur = armies.find((a) => a.id === selected) ?? (mobile ? null : (armies[0] ?? null));
  const full = armies.length >= command.maxArmies;
  const newBtn = (
    <Button
      variant="primary"
      size={mobile ? 'lg' : 'md'}
      block
      icon={<Icon name="plus" size={13} />}
      disabled={full}
      onClick={() => openNewArmy()}
      data-testid="army-new"
    >
      {t('command.newArmy')}
    </Button>
  );
  const list = (
    <div className="cmd-list">
      {newBtn}
      {full ? <p className="cmd-hint">{t('command.full', { max: command.maxArmies })}</p> : null}
      {armies.length ? (
        <ul className="cmd-rows">
          {armies.map((a) => (
            <ArmyRow
              key={a.id}
              a={a}
              sel={cur?.id === a.id}
              command={command}
              view={view}
              onClick={() => {
                select(a.id);
                setMobileDetail(true);
              }}
            />
          ))}
        </ul>
      ) : mobile ? (
        <Onboarding disabled={full} mobile />
      ) : (
        <EmptyState
          compact
          icon="star"
          title={t('command.emptyTitle')}
          text={t('command.emptyText')}
        />
      )}
    </div>
  );
  if (mobile) {
    if (cur && mobileDetail)
      return (
        <ArmyDetail
          key={cur.id}
          a={cur}
          mobile
          onBack={() => {
            setMobileDetail(false);
            select(null);
          }}
        />
      );
    return list;
  }
  return (
    <div className="cmd-split">
      {list}
      {cur ? (
        <ArmyDetail key={cur.id} a={cur} mobile={false} onBack={() => select(null)} />
      ) : !armies.length ? (
        <Onboarding disabled={full} />
      ) : (
        <div className="cmd-detail cmd-detail--empty">
          <EmptyState icon="star" title={t('command.pickTitle')} text={t('command.pickText')} />
        </div>
      )}
    </div>
  );
}

/** Premier contact : les trois étapes et la règle des ordres directs, avant toute armée. */
function Onboarding({ disabled, mobile }: { disabled: boolean; mobile?: boolean }) {
  const { t } = useTranslation();
  const steps = [
    { key: 'compose', icon: 'layers' as const },
    { key: 'mission', icon: 'target' as const },
    { key: 'general', icon: 'star' as const },
  ];
  return (
    <div
      className={mobile ? 'cmd-onboard-wrap' : 'cmd-detail cmd-detail--empty'}
      data-testid="command-onboarding"
    >
      <div className="cmd-onboard">
        <p className="cmd-onboard__title">{t('command.onboard.title')}</p>
        <ol className="cmd-onboard__steps">
          {steps.map((s, i) => (
            <li key={s.key} className="cmd-onboard__step">
              <span className="cmd-onboard__num">{i + 1}</span>
              <Icon name={s.icon} size={18} />
              <div>
                <strong>{t(`command.wizard.step.${s.key}`)}</strong>
                <p>{t(`command.onboard.${s.key}`)}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="cmd-onboard__rule">
          <Icon name="info" size={11} /> {t('command.detail.manualRule')}
        </p>
        {mobile ? null : (
          <Button
            variant="primary"
            icon={<Icon name="plus" size={13} />}
            disabled={disabled}
            onClick={() => openNewArmy()}
          >
            {t('command.newArmy')}
          </Button>
        )}
      </div>
    </div>
  );
}

function Kpis({ command }: { command: CommandView }) {
  const { t } = useTranslation();
  const req = pendingRequests(command) + pendingOpRequests(command);
  const ops = (command.ops ?? []).filter((o) => o.status !== 'success' && o.status !== 'failed');
  const active = command.armies.filter(
    (a) => a.status === 'active' || a.status === 'preparing' || a.status === 'awaiting',
  );
  return (
    <div className="cmd-kpis" data-testid="command-kpis">
      <span>
        <small>{t('command.kpi.ops')}</small>
        <b>{ops.length}</b>
      </span>
      <span>
        <small>{t('command.kpi.armies')}</small>
        <b>
          {command.armies.length}
          <em>/{command.maxArmies}</em>
        </b>
      </span>
      <span>
        <small>{t('command.kpi.active')}</small>
        <b>{active.length}</b>
      </span>
      <span>
        <small>{t('command.kpi.generals')}</small>
        <b>{command.generals.length}</b>
      </span>
      <span>
        <small>{t('command.kpi.payroll')}</small>
        <b className="is-amber">{formatMoney(command.salaryPerDay)}</b>
      </span>
      <span className={req ? 'cmd-kpis__alert' : ''}>
        <small>{t('command.kpi.requests')}</small>
        <b>{req}</b>
      </span>
    </div>
  );
}

export function CommandCenter({ frame, mobile, win }: WindowContentProps) {
  const { t } = useTranslation();
  const command = useGame((s) => s.view?.command);
  const draft = useCommandUi((s) => s.draft);
  const opDraft = useCommandUi((s) => s.opDraft);
  const tab = useCommandUi((s) => s.tab);
  const setTab = useCommandUi((s) => s.setTab);
  ensureEngineTexts();
  useEffect(() => {
    const p = win.params.tab;
    if (p === 'generals' || p === 'armies' || p === 'ops') setTab(p);
  }, [win.seq, win.params.tab, setTab]);
  const counts = useMemo(
    () => ({
      ops: command?.ops?.length ?? 0,
      armies: command?.armies.length ?? 0,
      generals: command?.generals.length ?? 0,
    }),
    [command],
  );
  const wizard = draft ? 'army' : opDraft ? 'op' : null;
  if (!command)
    return (
      <Window {...frame}>
        <EmptyState icon="star" title={t('command.unavailable')} />
      </Window>
    );
  return (
    <Window
      {...frame}
      className="cmd-window"
      path={[
        t('sections.path.command'),
        draft
          ? t('command.wizard.path')
          : opDraft
            ? t(`command.ops.path.${opDraft.mode}`)
            : t(`command.tabs.${tab}`),
      ]}
      flush
      tabs={
        wizard ? undefined : (
          <Tabs
            label={t('sections.command')}
            value={tab}
            onChange={setTab}
            tabs={[
              {
                id: 'ops',
                label: t('command.tabs.ops'),
                count: counts.ops,
                icon: <Icon name="target" size={13} />,
                dot: pendingOpRequests(command) > 0,
              },
              {
                id: 'armies',
                label: t('command.tabs.armies'),
                count: counts.armies,
                icon: <Icon name="army" size={13} />,
                dot: pendingRequests(command) > 0,
              },
              {
                id: 'generals',
                label: t('command.tabs.generals'),
                count: counts.generals,
                icon: <Icon name="star" size={13} />,
              },
            ]}
          />
        )
      }
      toolbar={wizard || mobile ? undefined : <Kpis command={command} />}
    >
      {draft ? (
        <CommandWizard mobile={mobile} />
      ) : opDraft ? (
        <OpWizard mobile={mobile} />
      ) : tab === 'ops' ? (
        <OpsPane mobile={mobile} />
      ) : tab === 'armies' ? (
        <ArmiesPane mobile={mobile} />
      ) : (
        <GeneralsPane mobile={mobile} />
      )}
    </Window>
  );
}
