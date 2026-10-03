import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BRANCHES,
  BRANCH_SKILL,
  GENERAL_SKILLS,
  type Branch,
  type CommandGeneralView,
  type GeneralSkill,
} from '@redline/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  Segmented,
  Select,
  formatInt,
  formatMoney,
  type IconName,
} from '@redline/ui';
import { fmtDuration } from '../i18n/index.js';
import { ratingOf } from '../lib/command.js';
import { branchOfGeneral } from '../lib/ops.js';
import { useGame } from '../store/game.js';
import { useSend } from './armyCommand.js';

/**
 * Généraux du centre de commandement : portrait sobre (insigne généré, jamais de photo), grade,
 * compétences en barres, traits, solde ; liste des généraux recrutés et vivier de candidats.
 */

/** Teinte stable d'une chaîne (portrait). */
function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Portrait stylisé : écusson aux initiales, liseré au grade (aucune photo, personnage fictif). */
export function GeneralAvatar({ g, size = 56 }: { g: CommandGeneralView; size?: number }) {
  const initials = `${g.first[0] ?? ''}${g.last.replace(/^(Al-|Ben-|De |Di )/, '')[0] ?? ''}`;
  const h = hue(`${g.first}${g.last}${g.culture}`);
  const ring = ['var(--rl-text-dim)', 'var(--rl-cyan)', 'var(--rl-green)', 'var(--rl-amber)'][
    Math.min(3, g.rank - 1)
  ];
  return (
    <svg
      className="cmd-avatar"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`${g.first} ${g.last}`}
    >
      <defs>
        <linearGradient id={`cg-${g.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`hsl(${h} 22% 24%)`} />
          <stop offset="1" stopColor={`hsl(${h} 18% 12%)`} />
        </linearGradient>
      </defs>
      <path
        d="M32 3 L57 12 V33 C57 47 46 56 32 61 C18 56 7 47 7 33 V12 Z"
        fill={`url(#cg-${g.id})`}
        stroke={ring}
        strokeWidth="2"
      />
      {/* Épaulette : une barrette par grade. */}
      {Array.from({ length: Math.max(1, g.rank) }, (_, i) => (
        <rect key={i} x={20 + i * 6.5} y={47} width={4.5} height={4} rx={0.8} fill={ring} />
      ))}
      <text
        x="32"
        y="36"
        textAnchor="middle"
        fontFamily="var(--rl-font-mono)"
        fontSize="17"
        fontWeight="700"
        fill="var(--rl-text-strong)"
        letterSpacing="1"
      >
        {initials.toUpperCase()}
      </text>
    </svg>
  );
}

export function Stars({ n }: { n: number }) {
  const { t } = useTranslation();
  return (
    <span className="cmd-stars" title={t(`command.rank.${Math.min(4, Math.max(1, n))}`)}>
      {'★'.repeat(n)}
      <span className="cmd-stars__off">{'★'.repeat(Math.max(0, 4 - n))}</span>
    </span>
  );
}

const SKILL_ORDER: GeneralSkill[] = [...GENERAL_SKILLS];

export function SkillBars({
  g,
  compact,
  highlight,
}: {
  g: CommandGeneralView;
  compact?: boolean;
  highlight?: GeneralSkill;
}) {
  const { t } = useTranslation();
  const skills = compact
    ? SKILL_ORDER.filter((k) => k !== 'audacity' && k !== 'experience')
    : SKILL_ORDER;
  return (
    <dl className={compact ? 'cmd-skills cmd-skills--compact' : 'cmd-skills'}>
      {skills.map((k) => {
        const v = g.skills[k];
        const audacity = k === 'audacity';
        return (
          <div
            key={k}
            className={k === highlight ? 'cmd-skill cmd-skill--key' : 'cmd-skill'}
            title={t(`command.skills.${k}.help`)}
          >
            <dt>{t(`command.skills.${k}.label`)}</dt>
            <dd>
              {audacity ? (
                <span className="cmd-scale" aria-label={`${v}/100`}>
                  <i style={{ left: `${v}%` }} />
                  <small>{t('command.skills.audacity.low')}</small>
                  <small>{t('command.skills.audacity.high')}</small>
                </span>
              ) : (
                <span className="cmd-bar" aria-label={`${v}/100`}>
                  <i
                    style={{ width: `${v}%` }}
                    className={v >= 75 ? 'is-high' : v >= 50 ? 'is-mid' : 'is-low'}
                  />
                </span>
              )}
              {!audacity ? <b>{v}</b> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function TraitChips({ traits }: { traits: string[] }) {
  const { t } = useTranslation();
  if (!traits.length) return <span className="cmd-muted">{t('command.traits.none')}</span>;
  return (
    <span className="cmd-traits">
      {traits.map((x) => (
        <Badge key={x} tone="violet" variant="outline" title={t(`command.traits.${x}.help`)}>
          {t(`command.traits.${x}.label`)}
        </Badge>
      ))}
    </span>
  );
}

/** Carte d'un général (assistant, vivier, armée). */
export function GeneralCard({
  g,
  selected,
  onSelect,
  footer,
  highlight,
  cost,
  testId,
}: {
  g: CommandGeneralView;
  selected?: boolean;
  onSelect?: () => void;
  footer?: ReactNode;
  highlight?: GeneralSkill;
  cost?: number | null;
  testId?: string;
}) {
  const { t } = useTranslation();
  const army = useGame((s) =>
    g.armyId ? s.view?.command?.armies.find((a) => a.id === g.armyId)?.name : null,
  );
  const body = (
    <>
      <div className="cmd-gcard__head">
        <GeneralAvatar g={g} size={52} />
        <div className="cmd-gcard__id">
          <span className="cmd-gcard__rank">
            <Stars n={g.rank} /> {t(`command.rank.${Math.min(4, Math.max(1, g.rank))}`)}
          </span>
          <b className="cmd-gcard__name">
            {g.first} {g.last}
          </b>
          <span className="cmd-gcard__meta">
            {t('command.general.rating', { value: ratingOf(g) })}
            {g.victories ? ` · ${t('command.general.victories', { count: g.victories })}` : ''}
            {g.status === 'wounded' ? (
              <Badge tone="red" dot>
                {t('command.general.wounded')}
              </Badge>
            ) : null}
            {g.unpaidDays ? (
              <Badge tone="amber" dot>
                {t('command.general.unpaid', { count: g.unpaidDays })}
              </Badge>
            ) : null}
          </span>
        </div>
        <div className="cmd-gcard__pay">
          <b>{formatMoney(g.salaryPerDay)}</b>
          <span>{t('command.general.perDay')}</span>
          {g.status === 'candidate' ? (
            <small>{t('command.general.signing', { value: formatMoney(g.hireCost) })}</small>
          ) : army ? (
            <small className="cmd-gcard__army">{army}</small>
          ) : (
            <small>{t('command.general.reserve')}</small>
          )}
        </div>
      </div>
      <SkillBars g={g} highlight={highlight} />
      <TraitChips traits={g.traits} />
      {cost !== undefined && cost !== null ? (
        <div className="cmd-gcard__cost">
          <span>{t('command.general.missionCost')}</span>
          <b>{formatMoney(cost)}</b>
        </div>
      ) : null}
    </>
  );
  if (onSelect)
    return (
      <div className="cmd-gcard-wrap">
        <button
          type="button"
          className={selected ? 'cmd-gcard cmd-gcard--sel' : 'cmd-gcard'}
          aria-pressed={!!selected}
          onClick={onSelect}
          data-testid={testId}
        >
          {selected ? (
            <span className="cmd-gcard__check" aria-hidden>
              <Icon name="check" size={13} />
            </span>
          ) : null}
          {body}
        </button>
        {footer}
      </div>
    );
  return (
    <div className="cmd-gcard" data-testid={testId}>
      {body}
      {footer}
    </div>
  );
}

const BRANCH_ICON: Record<Branch, IconName> = {
  land: 'army',
  air: 'radio',
  sea: 'anchor',
  ad: 'shield',
};

/**
 * Onglet « Généraux », par commandement (armée de terre, armée de l'air, marine, défense
 * antiaérienne) : général en chef, généraux recrutés (affectation, limogeage), forces de l'arme et
 * vivier propre au commandement (recrutement).
 */
export function GeneralsPane({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const command = useGame((s) => s.view?.command);
  const send = useSend();
  const [dismiss, setDismiss] = useState<CommandGeneralView | null>(null);
  const [branch, setBranch] = useState<Branch>('land');
  if (!command) return null;
  const armies = command.armies;
  const info = command.branches?.find((b) => b.id === branch);
  const hired = command.generals.filter((g) => branchOfGeneral(g) === branch);
  const pool = info?.candidates ?? (branch === 'land' ? command.candidates : []);
  const chief = info?.chiefId ? command.generals.find((g) => g.id === info.chiefId) : null;
  const key = BRANCH_SKILL[branch];
  return (
    <div className={mobile ? 'cmd-roster cmd-roster--mobile' : 'cmd-roster'}>
      <div className="ops-branchbar">
        <Segmented<Branch>
          size={mobile ? 'md' : 'sm'}
          label={t('command.generals.branch')}
          value={branch}
          onChange={setBranch}
          options={BRANCHES.map((b) => ({
            value: b,
            label: t(`command.branch.${b}.short`),
            title: t(`command.branch.${b}.name`),
          }))}
        />
        <span className="cmd-detail__spacer" />
        <small className="cmd-muted">
          {t('command.generals.payroll', { value: formatMoney(command.salaryPerDay) })}
        </small>
      </div>
      <section className="ops-branchinfo" data-testid={`branch-${branch}`}>
        <Icon name={BRANCH_ICON[branch]} size={18} />
        <div>
          <b>{t(`command.branch.${branch}.name`)}</b>
          <p>{t(`command.branch.${branch}.desc`)}</p>
        </div>
        <dl>
          <div>
            <dt>{t('command.generals.chief')}</dt>
            <dd>{chief ? `${chief.first} ${chief.last}` : t('command.generals.noChief')}</dd>
          </div>
          <div>
            <dt>{t('command.generals.forces')}</dt>
            <dd>
              {info
                ? `${t('command.piles', { count: info.forces.piles })} · ${formatInt(info.forces.elements)} · ${formatMoney(info.forces.value)}`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>{t('command.generals.freeForces')}</dt>
            <dd>{info ? t('command.piles', { count: info.forces.free }) : '—'}</dd>
          </div>
        </dl>
      </section>
      <section>
        <h3 className="cmd-h">
          {t('command.generals.hired')} <span>{hired.length}</span>
        </h3>
        {hired.length ? (
          <div className="cmd-grid">
            {hired.map((g) => (
              <GeneralCard
                key={g.id}
                g={g}
                highlight={key}
                testId={`general-${g.id}`}
                footer={
                  <div className="cmd-gcard__actions">
                    {g.chief ? (
                      <Badge tone="amber" variant="solid">
                        <Icon name="crown" size={10} /> {t('command.generals.isChief')}
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon name="crown" size={12} />}
                        title={t('command.generals.chiefHelp')}
                        disabled={g.status !== 'active'}
                        onClick={() =>
                          void send(
                            { kind: 'commandChief', branch, generalId: g.id },
                            t('command.generals.chiefNamed', { name: `${g.first} ${g.last}` }),
                          )
                        }
                        data-testid={`chief-${g.id}`}
                      >
                        {t('command.generals.makeChief')}
                      </Button>
                    )}
                    <Select
                      label={t('command.general.assign')}
                      value={g.armyId ?? ''}
                      onChange={(v) =>
                        void send(
                          { kind: 'generalAssign', generalId: g.id, armyId: v || null },
                          t('command.toast.assigned'),
                        )
                      }
                      options={[
                        { value: '', label: t('command.general.reserve') },
                        ...armies.map((a) => ({ value: a.id, label: a.name })),
                      ]}
                    />
                    <Button size="sm" variant="ghost" onClick={() => setDismiss(g)}>
                      {t('command.general.dismiss')}
                    </Button>
                  </div>
                }
              />
            ))}
          </div>
        ) : (
          <EmptyState compact icon="user" title={t('command.generals.none')} />
        )}
      </section>
      <section>
        <h3 className="cmd-h">
          {t('command.generals.pool')} <span>{pool.length}</span>
          <small>{t('command.generals.poolHint')}</small>
        </h3>
        <div className="cmd-grid">
          {pool.map((g) => (
            <GeneralCard
              key={g.id}
              g={g}
              highlight={key}
              testId={`candidate-${g.id}`}
              footer={
                <div className="cmd-gcard__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Icon name="plus" size={12} />}
                    onClick={() =>
                      void send(
                        { kind: 'generalHire', candidateId: g.id },
                        t('command.toast.hired', { name: `${g.first} ${g.last}` }),
                      )
                    }
                  >
                    {t('command.general.hire', { value: formatMoney(g.hireCost) })}
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      </section>
      <Dialog
        open={!!dismiss}
        title={t('command.general.dismissTitle')}
        tone="red"
        onClose={() => setDismiss(null)}
        closeLabel={t('app.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDismiss(null)}>
              {t('app.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (dismiss)
                  void send(
                    { kind: 'generalDismiss', generalId: dismiss.id },
                    t('command.toast.dismissed'),
                  );
                setDismiss(null);
              }}
            >
              {t('command.general.dismissConfirm', {
                value: formatMoney(dismiss?.severance ?? 0),
              })}
            </Button>
          </>
        }
      >
        {dismiss ? (
          <p>
            {t('command.general.dismissText', {
              name: `${dismiss.first} ${dismiss.last}`,
              value: formatMoney(dismiss.severance),
            })}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

/** Pictogramme de chaque cerveau de mission. */
export const MISSION_ICON: Record<string, IconName> = {
  conquer: 'target',
  defend: 'shield',
  hold_front: 'flag',
  air_superiority: 'radio',
  air_defense: 'missile',
  deep_strike: 'bolt',
  sea_control: 'anchor',
  landing: 'box',
  reserve: 'clock',
};

/** Durée lisible (heures de jeu). */
export function etaLabel(h: number | null): string {
  return h === null ? '—' : fmtDuration(h * 3_600_000);
}
