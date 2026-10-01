import { useTranslation } from 'react-i18next';
import {
  RECON_KNOWN_LEVEL,
  RECON_OPS,
  type Balance,
  type Department,
  type IntelOpCost,
  type IntelOpView,
  type NationId,
  type PlayerView,
  type ProvinceView,
  type ReconOpKind,
} from '@redline/shared';
import { Button, Flag, Icon, ProgressBar, formatHours, formatMoney } from '@redline/ui';
import { fmtDuration } from '../i18n/index.js';
import { nationForms } from '../lib/game.js';
import { useGameTime } from '../shell/helpers.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { orderError } from '../lib/loc.js';

/** Département qui mène chaque reconnaissance (identique à OP_META du moteur). */
export const RECON_DEPT: Record<ReconOpKind, Department> = {
  recon_military: 'military',
  recon_economic: 'exterior',
};

/** Niveau de connaissance d'une province sur l'axe d'une mission (vues anciennes : niveau global). */
export function axisLevel(p: ProvinceView, op: ReconOpKind): number {
  const k = p.intel;
  if (!k) return 3;
  if (op === 'recon_military') return k.m ?? (k.military ? k.level : 0);
  return k.e ?? (k.economic ? k.level : 0);
}

export interface NationReconState {
  /** Provinces de la nation. */
  total: number;
  /** Provinces bien connues (niveau ≥ RECON_KNOWN_LEVEL) par axe. */
  known: Record<ReconOpKind, number>;
  /** Mission en cours sur tout le pays, par type. */
  running: Partial<Record<ReconOpKind, IntelOpView>>;
}

export function nationReconState(view: PlayerView | null, nationId: NationId): NationReconState {
  const out: NationReconState = {
    total: 0,
    known: { recon_military: 0, recon_economic: 0 },
    running: {},
  };
  if (!view) return out;
  for (const p of Object.values(view.provinces)) {
    if (p.owner !== nationId) continue;
    out.total++;
    for (const op of RECON_OPS) if (axisLevel(p, op) >= RECON_KNOWN_LEVEL) out.known[op]++;
  }
  for (const o of view.intel?.operations ?? []) {
    const k = o.kind as ReconOpKind;
    if (
      o.status === 'running' &&
      (RECON_OPS as readonly string[]).includes(k) &&
      o.target.nationId === nationId &&
      !o.target.provinceId
    )
      out.running[k] = o;
  }
  return out;
}

/** Coût d'une reconnaissance sur un pays entier (data/balance, intel.reconNation). */
export function reconNationCost(balance: Balance | null, op: ReconOpKind): IntelOpCost | undefined {
  const c = balance?.intel?.reconNation?.ops[op];
  return c ? { ...c, dept: RECON_DEPT[op], source: 'sigint' } : undefined;
}

/**
 * Renseignement sur un pays entier : reconnaissances militaire et économique (coût, durée, état,
 * provinces révélées n/N), lancées sans passer par une province. Affiché dans la fiche d'une province
 * étrangère (un clic n'importe où sur le pays) et dans la fenêtre de lancement du renseignement.
 */
export function NationRecon({
  nationId,
  ops = RECON_OPS,
  bare,
  readOnly,
}: {
  nationId: NationId;
  ops?: readonly ReconOpKind[];
  /** Sans en-tête (fenêtre de lancement : la nation est déjà choisie au-dessus). */
  bare?: boolean;
  /** État seul, sans bouton (le lancement passe par la fenêtre). */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const conn = useGame((s) => s.connection);
  const balance = useWorld((s) => s.balance);
  const toast = useUi((s) => s.toast);
  const now = useGameTime(2000);
  if (!view?.intel) return null;
  const st = nationReconState(view, nationId);
  const forms = nationForms(nationId);

  const launch = async (op: ReconOpKind) => {
    const res = await conn?.sendOrder({ kind: 'intelOp', op, target: { nationId } });
    if (res?.ok) toast(t(`nationRecon.started.${op}`, forms), 'ok');
    else if (res)
      toast(orderError(res), 'error');
  };

  return (
    <section
      className={bare ? 'nrecon nrecon--bare' : 'nrecon'}
      aria-label={t('nationRecon.aria', forms)}
      data-testid="nation-recon"
    >
      {!bare ? (
        <header className="nrecon__head">
          <Flag nationId={nationId} size={11} />
          <span className="selpanel__label nrecon__title">{t('nationRecon.title', forms)}</span>
          <span className="nrecon__total">{t('nationRecon.provinces', { count: st.total })}</span>
        </header>
      ) : null}
      {ops.map((op) => {
        const run = st.running[op];
        const cost = reconNationCost(balance, op);
        const known = st.known[op];
        const dept = view.intel?.departments.find((d) => d.id === RECON_DEPT[op]);
        const full = !!dept && dept.running >= dept.capacity;
        const poor = !!cost && view.economy.money < cost.money;
        const f = run ? (now - run.startedAt) / Math.max(1, run.completesAt - run.startedAt) : 0;
        const blocked = full
          ? t('nationRecon.capacity')
          : poor
            ? t('game.orders.errors.insufficient_funds')
            : undefined;
        return (
          <div
            key={op}
            className={[
              'nrecon__row',
              run ? 'nrecon__row--run' : '',
              readOnly ? 'nrecon__row--ro' : '',
            ].join(' ')}
            data-testid={`nation-recon-${op}`}
          >
            <span className={`nrecon__ico nrecon__ico--${op}`} aria-hidden>
              <Icon name={op === 'recon_military' ? 'target' : 'economy'} size={14} />
            </span>
            <div className="nrecon__main">
              <div className="nrecon__line">
                <span className="nrecon__name">{t(`nationRecon.ops.${op}`)}</span>
                <span className="nrecon__meta">
                  {run
                    ? t('nationRecon.phase', {
                        done: run.recon?.done ?? 0,
                        waves: run.recon?.waves ?? 1,
                      })
                    : readOnly
                      ? null
                      : cost
                        ? `${formatMoney(cost.money)} · ${formatHours(cost.durationH, t('time.dayUnit'))}`
                        : '—'}
                </span>
              </div>
              {run ? (
                <ProgressBar
                  value={f}
                  size="xs"
                  tone="cyan"
                  label={t('intel.progress')}
                  trailing={fmtDuration(Math.max(0, run.completesAt - now))}
                />
              ) : (
                <ProgressBar
                  value={st.total ? known / st.total : 0}
                  size="xs"
                  tone={known >= st.total && st.total ? 'green' : known ? 'amber' : 'red'}
                  label={t('nationRecon.revealedAria', { known, total: st.total })}
                  trailing={
                    <span className="nrecon__count" data-testid={`nation-recon-count-${op}`}>
                      {known}/{st.total}
                    </span>
                  }
                />
              )}
            </div>
            {readOnly ? null : (
              <Button
                size="sm"
                variant={op === 'recon_military' ? 'primary' : 'default'}
                disabled={!!run || full || poor}
                title={run ? undefined : (blocked ?? t(`nationRecon.tips.${op}`, forms))}
                onClick={() => void launch(op)}
                data-testid={`nation-recon-launch-${op}`}
              >
                {run ? t('nationRecon.running') : t('nationRecon.launch')}
              </Button>
            )}
            <div className="nrecon__sub">
              {run
                ? t('nationRecon.covered', { count: run.recon?.provinces ?? 0 })
                : !st.total
                  ? null
                  : known >= st.total
                    ? t('nationRecon.complete')
                    : known === 0
                      ? t('nationRecon.priority')
                      : t('nationRecon.remaining', { count: st.total - known })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
