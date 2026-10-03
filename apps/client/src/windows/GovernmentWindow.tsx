import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type GovHeadView,
  type GovMissionView,
  type GovOffice,
  type GovOfficeView,
  type GovernmentView,
  type GovSkill,
} from '@redline/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  ProgressBar,
  Segmented,
  Tabs,
  Window,
  formatInt,
  formatMoney,
  type IconName,
} from '@redline/ui';
import frEngine from '../i18n/fr.engine.json';
import { fmtClock, i18n } from '../i18n/index.js';
import {
  DEFENSE_SECTIONS,
  STATUS_TONE,
  blockedCount,
  budgetDraftOf,
  budgetTotals,
  budgetUsage,
  commandsOf,
  govText,
  initials,
  missionsOf,
  officeById,
  officeHint,
  officesIn,
  missionIcon,
  missionTypes,
  toBudget,
  type DefenseSection,
} from '../lib/government.js';
import { nationName, provinceName, researchName, systemName } from '../lib/game.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useSend } from './armyCommand.js';
import { BudgetPicker, GoalField, MissionWizard, useUnit } from './GovernmentWizard.js';
import './government.css';

/**
 * Gouvernement : ministères de la Défense (commandements, infrastructures et logistique, directions
 * de l'armement et du renseignement) et de l'Économie. Pour chaque poste : le titulaire (carte avec
 * compétences, coût, remplacer), ses missions (priorité, enveloppe, suspendre, retirer) et son
 * journal ; assistant « Nouvelle mission » en trois étapes avec les coûts prévus.
 */

// Textes du moteur (journal, raisons) : en français, le dictionnaire du moteur n'est pas embarqué dans
// le paquet principal ; on ajoute les sections utiles ici.
let enginePatched = false;
function ensureEngineTexts(): void {
  if (enginePatched) return;
  enginePatched = true;
  const e = (frEngine as { engine: Record<string, unknown> }).engine;
  i18n.addResourceBundle(
    'fr',
    'translation',
    { engine: { gov: e.gov, intelOp: e.intelOp } },
    true,
    false,
  );
}

/** Rendu d'un texte du moteur (sommes en dollars, nœuds de recherche, lieux). */
export function useGovText() {
  const { t } = useTranslation();
  const research = useWorld((s) => s.research);
  const provinces = useWorld((s) => s.provinces);
  return (lt: Parameters<typeof govText>[0]) =>
    govText(lt, t, {
      money: (v) => formatMoney(v),
      nation: nationName,
      province: (id) => provinces[id]?.cityName ?? provinces[id]?.name ?? provinceName(id),
      system: systemName,
      node: (id) => researchName(id, research),
    });
}

/** Libellé court de la cible d'une mission (ressource, domaine, matériel, pays, zone). */
export function targetLabel(
  m: Pick<
    GovMissionView,
    'resource' | 'branch' | 'category' | 'nationId' | 'provinceId' | 'radiusKm'
  >,
  t: (k: string, o?: Record<string, unknown>) => string,
  intel: boolean,
): string | null {
  const parts: string[] = [];
  if (m.resource) parts.push(t(`game.resources.${m.resource}`));
  if (m.branch) parts.push(t(`research.branches.${m.branch}`));
  if (m.category) parts.push(t(`categories.${m.category}`));
  if (m.nationId)
    parts.push(
      intel ? nationName(m.nationId) : t('gov.zone.borderWith', { nation: nationName(m.nationId) }),
    );
  if (m.provinceId)
    parts.push(
      t('gov.zone.aroundShort', {
        place: useWorld.getState().provinces[m.provinceId]?.cityName ?? provinceName(m.provinceId),
        km: m.radiusKm ?? 400,
      }),
    );
  return parts.length ? parts.join(' · ') : null;
}

// ——— Titulaire ———

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Portrait stylisé : médaillon aux initiales (aucune photo, personnage fictif). */
export function HeadAvatar({ h, size = 52 }: { h: GovHeadView; size?: number }) {
  const c = hue(`${h.first}${h.last}${h.culture}`);
  const ring =
    h.rating >= 70 ? 'var(--rl-amber)' : h.rating >= 55 ? 'var(--rl-cyan)' : 'var(--rl-text-dim)';
  return (
    <svg
      className="gov-avatar"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`${h.first} ${h.last}`}
    >
      <defs>
        <linearGradient id={`ga-${h.id}-${size}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`hsl(${c} 20% 26%)`} />
          <stop offset="1" stopColor={`hsl(${c} 16% 12%)`} />
        </linearGradient>
      </defs>
      <rect
        x="4"
        y="4"
        width="56"
        height="56"
        rx="14"
        fill={`url(#ga-${h.id}-${size})`}
        stroke={ring}
        strokeWidth="2"
      />
      <text
        x="32"
        y="39"
        textAnchor="middle"
        fontFamily="var(--rl-font-mono)"
        fontSize="19"
        fontWeight="700"
        fill="var(--rl-text-strong)"
        letterSpacing="1"
      >
        {initials(h.first, h.last)}
      </text>
    </svg>
  );
}

function SkillBar({ k, v, main }: { k: GovSkill; v: number; main?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={main ? 'gov-skill gov-skill--main' : 'gov-skill'}>
      <span className="gov-skill__label">{t(`gov.skills.${k}`)}</span>
      <span className="gov-skill__bar" aria-hidden>
        <i style={{ width: `${v}%` }} />
      </span>
      <b className="gov-skill__v">{v}</b>
    </div>
  );
}

/** Effets mesurables du titulaire (vitesse, rabais, actions simultanées, réserve de prudence). */
function EffectChips({ h }: { h: GovHeadView }) {
  const { t } = useTranslation();
  const e = h.effects;
  const pct = pctFmt;
  return (
    <div className="gov-chips">
      <span title={t('gov.effects.speedTip')}>
        <Icon name="clock" size={11} /> {t('gov.effects.speed', { v: pct(e.speed) })}
      </span>
      <span title={t('gov.effects.discountTip')}>
        <Icon name="money" size={11} /> {t('gov.effects.discount', { v: pct(-e.discount) })}
      </span>
      <span title={t('gov.effects.slotsTip')}>
        <Icon name="layers" size={11} /> {t('gov.effects.slots', { count: e.slots })}
      </span>
      <span title={t('gov.effects.reserveTip')}>
        <Icon name="wallet" size={11} />{' '}
        {t('gov.effects.reserve', { days: Math.round(e.reserveDays) })}
      </span>
    </div>
  );
}

function HeadCard({
  office,
  h,
  skills,
  candidate,
  action,
  compact,
}: {
  office: GovOffice;
  h: GovHeadView;
  skills: GovSkill[];
  candidate?: boolean;
  action?: ReactNode;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <article
      className={candidate ? 'gov-head gov-head--cand' : 'gov-head'}
      data-testid={candidate ? `gov-cand-${office}-${h.id}` : `gov-head-${office}`}
    >
      <header className="gov-head__top">
        <HeadAvatar h={h} size={compact ? 40 : 52} />
        <div className="gov-head__id">
          <b className="gov-head__name">
            {h.first} {h.last}
          </b>
          <span className="gov-head__role">{t(`gov.offices.${office}.head`)}</span>
          {h.traits.length ? (
            <span className="gov-head__traits">
              {h.traits.map((x) => (
                <Badge key={x} tone="violet" variant="outline" title={t(`gov.traits.${x}.tip`)}>
                  {t(`gov.traits.${x}.name`)}
                </Badge>
              ))}
            </span>
          ) : null}
        </div>
        <span className="gov-head__rating" title={t('gov.head.ratingTip')}>
          <small>{t('gov.head.rating')}</small>
          <b>{h.rating}</b>
        </span>
      </header>
      <div className="gov-skills">
        {skills.map((k, i) => (
          <SkillBar key={k} k={k} v={h.skills[k]} main={i === 1} />
        ))}
      </div>
      {compact && !candidate ? null : <EffectChips h={h} />}
      <footer className="gov-head__foot">
        <span className="gov-head__cost">
          <small>{t('gov.head.cost')}</small>
          <b>{formatMoney(h.salaryPerDay)}</b>
          <em>{t('gov.perDay')}</em>
        </span>
        {h.unpaidDays ? (
          <Badge tone="red" dot>
            {t('gov.head.unpaid', { count: h.unpaidDays })}
          </Badge>
        ) : null}
        {action}
      </footer>
    </article>
  );
}

/** Choix d'un titulaire parmi les candidats du vivier (nomination, remplacement). */
/** Pourcentage signé localisé (effets des compétences). */
function pctFmt(v: number): string {
  const f = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  });
  return `${f.format(Math.round(v * 1000) / 10)} %`;
}

/** Candidat en une ligne dense : note, compétences utiles, effets, coût, nomination. */
function CandidateRow({
  o,
  c,
  skills,
  onDone,
}: {
  o: GovOfficeView;
  c: GovHeadView;
  skills: GovSkill[];
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const send = useSend();
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const cost = c.hireCost + (o.head?.severance ?? 0);
  const e = c.effects;
  return (
    <li className="gov-cand" data-testid={`gov-cand-${o.id}-${c.id}`}>
      <HeadAvatar h={c} size={38} />
      <div className="gov-cand__body">
        <div className="gov-cand__top">
          <b>
            {c.first} {c.last}
          </b>
          {c.traits.map((x) => (
            <Badge key={x} tone="violet" variant="outline" title={t(`gov.traits.${x}.tip`)}>
              {t(`gov.traits.${x}.name`)}
            </Badge>
          ))}
          <span className="gov-cand__rating" title={t('gov.head.ratingTip')}>
            {c.rating}
          </span>
        </div>
        <div className="gov-cand__skills">
          {skills.map((k, i) => (
            <span key={k} className={i === 1 ? 'is-main' : ''}>
              {t(`gov.skills.${k}`)} <b>{c.skills[k]}</b>
            </span>
          ))}
        </div>
        <div className="gov-cand__fx">
          {t('gov.effects.speed', { v: pctFmt(e.speed) })} ·{' '}
          {t('gov.effects.discount', { v: pctFmt(-e.discount) })} ·{' '}
          {t('gov.effects.slots', { count: e.slots })} ·{' '}
          {t('gov.effects.reserve', { days: Math.round(e.reserveDays) })}
        </div>
        <div className="gov-cand__foot">
          <span className="gov-head__cost">
            <small>{t('gov.head.cost')}</small>
            <b>{formatMoney(c.salaryPerDay)}</b>
            <em>{t('gov.perDay')}</em>
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={money < cost}
            onClick={async () => {
              const ok = await send(
                { kind: 'govAppoint', office: o.id, candidateId: c.id },
                t('gov.toast.appointed', { name: `${c.first} ${c.last}` }),
              );
              if (ok) onDone?.();
            }}
            data-testid={`gov-appoint-${o.id}`}
            title={t('gov.head.appointTip', { cost: formatMoney(cost) })}
          >
            {t('gov.head.appoint', { cost: formatMoney(cost) })}
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Choix d'un titulaire parmi les candidats du vivier (nomination, remplacement). */
function CandidateList({
  o,
  skills,
  onDone,
}: {
  o: GovOfficeView;
  skills: GovSkill[];
  onDone?: () => void;
}) {
  return (
    <ul className="gov-cands" data-testid={`gov-cands-${o.id}`}>
      {o.candidates.map((c) => (
        <CandidateRow key={c.id} o={o} c={c} skills={skills} onDone={onDone} />
      ))}
    </ul>
  );
}

function HeadPane({ o, compact }: { o: GovOfficeView; compact?: boolean }) {
  const { t } = useTranslation();
  const gv = useGame((s) => s.view?.government)!;
  const send = useSend();
  const [replace, setReplace] = useState(false);
  const [dismiss, setDismiss] = useState(false);
  const skills = gv.officeDefs[o.id]?.skills ?? [];
  if (!o.head)
    return (
      <section className="gov-headpane gov-headpane--vacant" data-testid={`gov-vacant-${o.id}`}>
        <p className="gov-vacant">
          <Icon name="user" size={14} />
          <span>
            <b>{t('gov.head.vacant')}</b> {t('gov.head.vacantText')}
          </span>
        </p>
        <CandidateList o={o} skills={skills} />
      </section>
    );
  return (
    <section className="gov-headpane">
      <HeadCard
        office={o.id}
        h={o.head}
        skills={skills}
        compact={compact}
        action={
          <span className="gov-head__actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReplace(true)}
              data-testid={`gov-replace-${o.id}`}
            >
              {t('gov.head.replace')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismiss(true)}>
              {t('gov.head.dismiss')}
            </Button>
          </span>
        }
      />
      <Dialog
        open={replace}
        title={t('gov.head.replaceTitle', { office: t(`gov.offices.${o.id}.name`) })}
        onClose={() => setReplace(false)}
        closeLabel={t('app.close')}
      >
        <p className="gov-muted">
          {t('gov.head.replaceText', { cost: formatMoney(o.head.severance) })}
        </p>
        <CandidateList o={o} skills={skills} onDone={() => setReplace(false)} />
      </Dialog>
      <Dialog
        open={dismiss}
        title={t('gov.head.dismissTitle')}
        tone="red"
        onClose={() => setDismiss(false)}
        closeLabel={t('app.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDismiss(false)}>
              {t('app.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void send({ kind: 'govDismiss', office: o.id }, t('gov.toast.dismissed'));
                setDismiss(false);
              }}
            >
              {t('gov.head.dismiss')}
            </Button>
          </>
        }
      >
        <p>
          {t('gov.head.dismissText', {
            name: `${o.head.first} ${o.head.last}`,
            cost: formatMoney(o.head.severance),
          })}
        </p>
      </Dialog>
    </section>
  );
}

// ——— Missions ———

const PRIORITIES = [1, 2, 3] as const;

function MissionCard({ m, gv }: { m: GovMissionView; gv: GovernmentView }) {
  const { t } = useTranslation();
  const send = useSend();
  const text = useGovText();
  const [edit, setEdit] = useState(false);
  const [cancel, setCancel] = useState(false);
  const def = gv.missionDefs[m.type];
  const target = targetLabel(m, t, m.office === 'intel_exterior');
  const u = budgetUsage(m);
  const unit = def?.unit ?? 'projects';
  const done = m.status === 'done';
  return (
    <li className={`gov-mission gov-mission--${m.status}`} data-testid={`gov-mission-${m.id}`}>
      <div className="gov-mission__top">
        <span className="gov-mission__icon">
          <Icon name={missionIcon(m)} size={16} />
        </span>
        <div className="gov-mission__title">
          <b>{t(`gov.missions.${m.type}.name`)}</b>
          {target ? <span className="gov-mission__target">{target}</span> : null}
        </div>
        <Badge tone={STATUS_TONE[m.status]} dot pulse={m.status === 'active'}>
          <span data-testid="gov-mission-status" data-status={m.status}>
            {m.cancelled ? t('gov.status.cancelled') : t(`gov.status.${m.status}`)}
          </span>
        </Badge>
      </div>
      <div className="gov-mission__bars">
        <div className="gov-meter">
          <div className="gov-meter__row">
            <span>{t('gov.mission.progress')}</span>
            <b data-testid="gov-mission-progress">
              {m.goal > 0
                ? t(`gov.units.${unit}`, {
                    done: formatInt(m.done),
                    goal: formatInt(m.goal),
                  })
                : t('gov.mission.goalAuto')}
              {m.pending ? <em> · {t('gov.mission.pending', { count: m.pending })}</em> : null}
            </b>
          </div>
          <ProgressBar
            value={m.progress}
            size="xs"
            tone={m.status === 'blocked' ? 'amber' : m.status === 'done' ? 'green' : 'cyan'}
            label={t('gov.mission.progress')}
          />
        </div>
        <div className="gov-meter" title={t('gov.mission.budgetTip')}>
          <div className="gov-meter__row">
            <span>
              {m.budget.mode === 'share'
                ? t('gov.budget.shareShort', { pct: m.budget.pct })
                : t('gov.budget.amountShort')}
            </span>
            <b>
              {formatMoney(u.spent)}
              {u.cap !== null ? <em> / {formatMoney(u.cap)}</em> : null}
            </b>
          </div>
          {u.cap !== null ? (
            <ProgressBar
              value={u.ratio}
              size="xs"
              tone="amber"
              label={t('gov.mission.budgetTip')}
            />
          ) : (
            <span className="gov-meter__note">
              {t('gov.budget.left', { v: formatMoney(m.available) })}
            </span>
          )}
        </div>
      </div>
      {m.why && (m.status === 'blocked' || m.status === 'waiting') ? (
        <p
          className={m.status === 'blocked' ? 'gov-why gov-why--warn' : 'gov-why'}
          data-testid="gov-mission-why"
        >
          <Icon name={m.status === 'blocked' ? 'warning' : 'info'} size={12} />
          {text(m.why)}
        </p>
      ) : null}
      {m.last ? (
        <p className="gov-last" data-testid="gov-mission-last">
          <Icon name="chevronRight" size={11} />
          {text(m.last)}
        </p>
      ) : null}
      {done ? null : (
        <div className="gov-mission__actions">
          <Segmented
            label={t('gov.mission.priority')}
            size="sm"
            value={m.priority}
            onChange={(p) =>
              void send(
                { kind: 'govMissionEdit', missionId: m.id, priority: p },
                t('gov.toast.edited'),
              )
            }
            options={PRIORITIES.map((p) => ({
              value: p,
              label: t(`gov.priority.${p}`),
              title: t('gov.mission.priority'),
            }))}
          />
          <span className="gov-spacer" />
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="edit" size={12} />}
            onClick={() => setEdit(true)}
          >
            {t('gov.mission.edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name={m.status === 'suspended' ? 'play' : 'pause'} size={12} />}
            onClick={() =>
              void send(
                { kind: 'govMissionSuspend', missionId: m.id, on: m.status !== 'suspended' },
                m.status === 'suspended' ? t('gov.toast.resumed') : t('gov.toast.suspended'),
              )
            }
            data-testid="gov-mission-suspend"
          >
            {m.status === 'suspended' ? t('gov.mission.resume') : t('gov.mission.suspend')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="trash" size={12} />}
            onClick={() => setCancel(true)}
            data-testid="gov-mission-cancel"
          >
            {t('gov.mission.cancel')}
          </Button>
        </div>
      )}
      {edit ? <EditDialog m={m} onClose={() => setEdit(false)} /> : null}
      <Dialog
        open={cancel}
        title={t('gov.mission.cancelTitle')}
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
                void send({ kind: 'govMissionCancel', missionId: m.id }, t('gov.toast.cancelled'));
                setCancel(false);
              }}
              data-testid="gov-mission-cancel-confirm"
            >
              {t('gov.mission.cancel')}
            </Button>
          </>
        }
      >
        <p>{t('gov.mission.cancelText', { mission: t(`gov.missions.${m.type}.name`) })}</p>
      </Dialog>
    </li>
  );
}

function EditDialog({ m, onClose }: { m: GovMissionView; onClose: () => void }) {
  const { t } = useTranslation();
  const send = useSend();
  const gv = useGame((s) => s.view?.government)!;
  const unit = useUnit();
  const def = gv.missionDefs[m.type]!;
  const [goal, setGoal] = useState(m.goal);
  const [budget, setBudget] = useState(() => budgetDraftOf(m.budget, unit));
  return (
    <Dialog
      open
      title={t('gov.mission.editTitle', { mission: t(`gov.missions.${m.type}.name`) })}
      onClose={onClose}
      closeLabel={t('app.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              const ok = await send(
                {
                  kind: 'govMissionEdit',
                  missionId: m.id,
                  budget: toBudget(budget, unit),
                  ...(def.goal > 0 ? { goal } : {}),
                },
                t('gov.toast.edited'),
              );
              if (ok) onClose();
            }}
          >
            {t('gov.mission.save')}
          </Button>
        </>
      }
    >
      <div className="gov-form">
        {def.goal > 0 ? <GoalField def={def} value={goal} onChange={setGoal} /> : null}
        <BudgetPicker value={budget} onChange={setBudget} />
      </div>
    </Dialog>
  );
}

function Journal({ o }: { o: GovOfficeView }) {
  const { t } = useTranslation();
  const text = useGovText();
  const list = [...o.journal].reverse().slice(0, 30);
  return (
    <details className="gov-journal" data-testid={`gov-journal-${o.id}`} open={list.length > 0}>
      <summary>
        <Icon name="document" size={12} /> {t('gov.journal.title')}
        <span className="gov-count">{list.length}</span>
      </summary>
      {list.length ? (
        <ol>
          {list.map((e, i) => {
            const c = fmtClock(e.t);
            return (
              <li key={`${e.t}-${i}`} className={`gov-jl gov-jl--${e.tone ?? 'info'}`}>
                <time>
                  {c.day} {c.time}
                </time>
                <span>{text(e.text)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="gov-muted">{t('gov.journal.empty')}</p>
      )}
    </details>
  );
}

function OfficePanel({
  office,
  onNew,
  compact,
}: {
  office: GovOffice;
  onNew: (o: GovOffice, type?: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const gv = useGame((s) => s.view?.government)!;
  const o = officeById(gv, office);
  if (!o) return null;
  const ms = missionsOf(gv, office);
  const hist = gv.history.filter((m) => m.office === office);
  const full = ms.length >= gv.maxMissions;
  const hint = officeHint(o, ms);
  return (
    <section
      className={compact ? 'gov-office gov-office--compact' : 'gov-office'}
      data-testid={`gov-office-${office}`}
    >
      <header className="gov-office__head">
        <h3>
          {t(`gov.offices.${office}.name`)}
          <small>{t(`gov.offices.${office}.scope`)}</small>
        </h3>
      </header>
      <div className="gov-office__grid">
        <HeadPane o={o} compact={compact} />
        <div className="gov-office__missions">
          <div className="gov-office__bar">
            <span className="gov-office__label">
              {t('gov.missionsTitle')} <span className="gov-count">{ms.length}</span>
            </span>
            <Button
              size="sm"
              variant="primary"
              icon={<Icon name="plus" size={12} />}
              disabled={full}
              onClick={() => onNew(office)}
              data-testid={`gov-new-${office}`}
            >
              {t('gov.newMission')}
            </Button>
          </div>
          {hint ? (
            <p className="gov-hint">
              <Icon name="info" size={12} /> {t(hint)}
            </p>
          ) : null}
          {!ms.length ? <Suggestions office={office} onNew={onNew} /> : null}
          {ms.length ? (
            <ul className="gov-missions">
              {ms.map((m) => (
                <MissionCard key={m.id} m={m} gv={gv} />
              ))}
            </ul>
          ) : null}
          {hist.length ? (
            <details className="gov-history">
              <summary>
                {t('gov.history')} <span className="gov-count">{hist.length}</span>
              </summary>
              <ul className="gov-missions">
                {hist.map((m) => (
                  <MissionCard key={m.id} m={m} gv={gv} />
                ))}
              </ul>
            </details>
          ) : null}
          <Journal o={o} />
        </div>
      </div>
    </section>
  );
}

/** Missions possibles du poste, en accès direct (assistant ouvert sur la mission choisie). */
function Suggestions({
  office,
  onNew,
}: {
  office: GovOffice;
  onNew: (o: GovOffice, type?: string) => void;
}) {
  const { t } = useTranslation();
  const gv = useGame((s) => s.view?.government)!;
  const types = missionTypes(gv, office);
  return (
    <div className="gov-suggest" data-testid={`gov-suggest-${office}`}>
      <span className="gov-office__label">{t('gov.suggest')}</span>
      <ul>
        {types.map(([type]) => (
          <li key={type}>
            <button type="button" onClick={() => onNew(office, type)}>
              <Icon name={missionIcon({ type })} size={14} />
              <span>
                <b>{t(`gov.missions.${type}.name`)}</b>
                <small>{t(`gov.missions.${type}.desc`)}</small>
              </span>
              <Icon name="chevronRight" size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ——— Défense : commandements ———

const COMMAND_ICON: Record<string, IconName> = {
  land: 'army',
  air: 'target',
  sea: 'anchor',
  air_defense: 'radio',
};

function CommandsPanel() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const openWindow = useUi((s) => s.openWindow);
  const list = commandsOf(view);
  const armies = view?.command?.armies.length ?? 0;
  const generals = view?.command?.generals.length ?? 0;
  const cards =
    list ??
    (['land', 'air', 'sea', 'air_defense'] as const).map((d) => ({
      id: d,
      domain: d,
      chief: null,
      generals: 0,
      operations: 0,
    }));
  return (
    <section className="gov-office" data-testid="gov-commands">
      <header className="gov-office__head">
        <h3>
          {t('gov.commands.title')}
          <small>{t('gov.commands.scope')}</small>
        </h3>
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="star" size={12} />}
          onClick={() => openWindow('command')}
        >
          {t('gov.commands.open')}
        </Button>
      </header>
      <div className="gov-commands">
        {cards.map((c) => (
          <article key={c.id} className={list ? 'gov-cmd' : 'gov-cmd gov-cmd--soon'}>
            <span className="gov-cmd__icon">
              <Icon name={COMMAND_ICON[c.domain] ?? 'star'} size={18} />
            </span>
            <div>
              <b>{t(`gov.commands.${c.domain}`)}</b>
              {list ? (
                <span>
                  {c.chief ?? t('gov.commands.noChief')} ·{' '}
                  {t('gov.commands.ops', { count: c.operations })}
                </span>
              ) : (
                <span>{t('gov.commands.soon')}</span>
              )}
            </div>
            {list ? null : <Badge tone="neutral">{t('gov.commands.soonBadge')}</Badge>}
          </article>
        ))}
      </div>
      {list ? null : (
        <p className="gov-hint">
          <Icon name="info" size={12} /> {t('gov.commands.now', { armies, generals })}
        </p>
      )}
    </section>
  );
}

// ——— Vues des ministères ———

function MinistryHeader({
  ministry,
  offices,
}: {
  ministry: 'defense' | 'economy';
  offices: GovOffice[];
}) {
  const { t } = useTranslation();
  const gv = useGame((s) => s.view?.government)!;
  const ms = gv.missions.filter((m) => offices.includes(m.office));
  const tot = budgetTotals(ms);
  const minister = officeById(gv, ministry)?.head;
  return (
    <div className="gov-mhead" data-testid={`gov-ministry-${ministry}`}>
      <span className="gov-mhead__who">
        <Icon name="building" size={14} />
        <b>{t(`gov.ministries.${ministry}`)}</b>
        <em>{minister ? `${minister.first} ${minister.last}` : t('gov.head.vacant')}</em>
      </span>
      <span className="gov-mhead__kpis">
        <span>
          <small>{t('gov.kpi.missions')}</small>
          <b>{ms.length}</b>
        </span>
        <span>
          <small>{t('gov.kpi.spent')}</small>
          <b>
            {formatMoney(tot.spent)}
            {tot.allocated > 0 ? <em> / {formatMoney(tot.allocated)}</em> : null}
          </b>
        </span>
      </span>
    </div>
  );
}

function DefenseView({
  onNew,
  mobile,
  section,
  setSection,
}: {
  onNew: (o: GovOffice, type?: string) => void;
  mobile: boolean;
  section: DefenseSection;
  setSection: (s: DefenseSection) => void;
}) {
  const { t } = useTranslation();
  const gv = useGame((s) => s.view?.government)!;
  const offices = gv.offices.filter((o) => o.ministry === 'defense').map((o) => o.id);
  const groupOf: Record<DefenseSection, GovOffice[]> = {
    commands: [],
    infra: officesIn(gv, 'infra').map((o) => o.id),
    armament: officesIn(gv, 'armament').map((o) => o.id),
    intel: officesIn(gv, 'intel').map((o) => o.id),
  };
  return (
    <div className="gov-ministry">
      <MinistryHeader ministry="defense" offices={offices} />
      <div className="gov-sections" role="tablist" aria-label={t('gov.ministries.defense')}>
        {DEFENSE_SECTIONS.map((s) => {
          const blocked = blockedCount(gv, groupOf[s]);
          const count = gv.missions.filter((m) => groupOf[s].includes(m.office)).length;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={section === s}
              className={section === s ? 'gov-sec gov-sec--on' : 'gov-sec'}
              onClick={() => setSection(s)}
              data-testid={`gov-section-${s}`}
            >
              <Icon name={SECTION_ICON[s]} size={13} />
              <span>{t(`gov.sections.${s}`)}</span>
              {count ? (
                <span className={blocked ? 'gov-count gov-count--warn' : 'gov-count'}>{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="gov-scroll">
        {section === 'commands' ? (
          <CommandsPanel />
        ) : (
          groupOf[section].map((o) => (
            <OfficePanel
              key={o}
              office={o}
              onNew={onNew}
              compact={mobile || groupOf[section].length > 1}
            />
          ))
        )}
      </div>
    </div>
  );
}

const SECTION_ICON: Record<DefenseSection, IconName> = {
  commands: 'star',
  infra: 'building',
  armament: 'factory',
  intel: 'spy',
};

function EconomyView({ onNew }: { onNew: (o: GovOffice, type?: string) => void }) {
  const gv = useGame((s) => s.view?.government)!;
  const offices = gv.offices.filter((o) => o.ministry === 'economy').map((o) => o.id);
  return (
    <div className="gov-ministry">
      <MinistryHeader ministry="economy" offices={offices} />
      <div className="gov-scroll">
        {offices.map((o) => (
          <OfficePanel key={o} office={o} onNew={onNew} />
        ))}
      </div>
    </div>
  );
}

function Kpis({ gv }: { gv: GovernmentView }) {
  const { t } = useTranslation();
  const tot = budgetTotals(gv.missions);
  const heads = gv.offices.filter((o) => o.head).length;
  return (
    <div className="gov-kpis" data-testid="gov-kpis">
      <span>
        <small>{t('gov.kpi.heads')}</small>
        <b>
          {heads}
          <em>/{gv.offices.length}</em>
        </b>
      </span>
      <span>
        <small>{t('gov.kpi.missions')}</small>
        <b>{gv.missions.length}</b>
      </span>
      <span>
        <small>{t('gov.kpi.payroll')}</small>
        <b className="is-amber">
          {formatMoney(gv.salaryPerDay)}
          <em>{t('gov.perDay')}</em>
        </b>
      </span>
      <span title={t('gov.kpi.floorTip')}>
        <small>{t('gov.kpi.floor')}</small>
        <b>{formatMoney(gv.reserveFloor)}</b>
      </span>
      <span>
        <small>{t('gov.kpi.spent')}</small>
        <b>{formatMoney(tot.spent)}</b>
      </span>
    </div>
  );
}

type Tab = 'defense' | 'economy';

export function GovernmentWindow({ frame, mobile, win }: WindowContentProps) {
  const { t } = useTranslation();
  const gv = useGame((s) => s.view?.government);
  const [tab, setTab] = useState<Tab>('defense');
  const [section, setSection] = useState<DefenseSection>('infra');
  const [wizard, setWizard] = useState<{ office: GovOffice; type?: string } | null>(null);
  const openWizard = (office: GovOffice, type?: string) => setWizard({ office, type });
  ensureEngineTexts();
  useEffect(() => {
    const p = win.params.tab;
    if (p === 'economy' || p === 'defense') setTab(p);
    else if (p && (DEFENSE_SECTIONS as string[]).includes(p)) {
      setTab('defense');
      setSection(p as DefenseSection);
    }
  }, [win.seq, win.params.tab]);
  const counts = useMemo(() => {
    if (!gv) return { defense: 0, economy: 0, dBlocked: 0, eBlocked: 0 };
    const d = gv.offices.filter((o) => o.ministry === 'defense').map((o) => o.id);
    const e = gv.offices.filter((o) => o.ministry === 'economy').map((o) => o.id);
    return {
      defense: gv.missions.filter((m) => d.includes(m.office)).length,
      economy: gv.missions.filter((m) => e.includes(m.office)).length,
      dBlocked: blockedCount(gv, d),
      eBlocked: blockedCount(gv, e),
    };
  }, [gv]);
  if (!gv)
    return (
      <Window {...frame}>
        <EmptyState icon="building" title={t('gov.unavailable')} />
      </Window>
    );
  return (
    <Window
      {...frame}
      className="gov-window"
      path={[
        t('sections.path.government'),
        wizard ? t('gov.wizard.path') : t(`gov.ministries.${tab}`),
      ]}
      flush
      tabs={
        wizard ? undefined : (
          <Tabs
            label={t('sections.government')}
            value={tab}
            onChange={setTab}
            tabs={[
              {
                id: 'defense',
                label: mobile ? t('gov.ministriesShort.defense') : t('gov.ministries.defense'),
                count: counts.defense,
                icon: <Icon name="shield" size={13} />,
                dot: counts.dBlocked > 0,
              },
              {
                id: 'economy',
                label: mobile ? t('gov.ministriesShort.economy') : t('gov.ministries.economy'),
                count: counts.economy,
                icon: <Icon name="economy" size={13} />,
                dot: counts.eBlocked > 0,
              },
            ]}
          />
        )
      }
      toolbar={wizard || mobile ? undefined : <Kpis gv={gv} />}
    >
      {wizard ? (
        <MissionWizard
          office={wizard.office}
          type={wizard.type}
          mobile={mobile}
          onClose={() => setWizard(null)}
        />
      ) : tab === 'defense' ? (
        <DefenseView onNew={openWizard} mobile={mobile} section={section} setSection={setSection} />
      ) : (
        <EconomyView onNew={openWizard} />
      )}
    </Window>
  );
}
