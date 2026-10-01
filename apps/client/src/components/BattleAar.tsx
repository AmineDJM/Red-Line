import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BattleAar,
  BattleAarSide,
  BattleFactor,
  BattleForceLine,
  BattlePhase,
  Estimate,
} from '@redline/shared';
import { Badge, Panel, WeaponPhoto, formatInt, formatMoney } from '@redline/ui';
import { NationTag } from './Common.js';
import { fmtClock, fmtDuration } from '../i18n/index.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { nationName } from '../lib/game.js';
import { useWorld } from '../store/world.js';

/**
 * Rapport après action (AAR) : situation, forces en présence, bilan humain et matériel, courbe des
 * pertes, déroulé par phases, facteurs décisifs, conséquences. Le camp du lecteur est exact ; le camp
 * adverse est estimé par le renseignement (fourchettes, cote de fiabilité A–F / 1–6).
 */

type Tone = 'red' | 'cyan';
const toneOf = (side: 'attacker' | 'defender'): Tone => (side === 'attacker' ? 'red' : 'cyan');

/** « 12 » si exact, « ≈ 12 (8–16) » sinon. */
export function fmtEstimate(e: Estimate, fmt: (n: number) => string = formatInt): string {
  if (e.min === e.max) return fmt(e.best);
  return `≈ ${fmt(e.best)} (${fmt(e.min)}–${fmt(e.max)})`;
}

function Est({ e, fmt, tone }: { e: Estimate; fmt?: (n: number) => string; tone?: string }) {
  const exact = e.min === e.max;
  const f = fmt ?? formatInt;
  return (
    <span className={`aar-est${exact ? '' : ' aar-est--range'}${tone ? ` ${tone}` : ''}`}>
      {exact ? f(e.best) : <>≈&nbsp;{f(e.best)}</>}
      {exact ? null : (
        <small>
          {f(e.min)}–{f(e.max)}
        </small>
      )}
    </span>
  );
}

function sideLabel(t: (k: string) => string, s: BattleAarSide): string {
  return t(`battles.${s.side}`) + (s.own ? ` · ${t('battles.you')}` : '');
}

// ——— En-tête de situation ———

export function AarHeader({ aar, id }: { aar: BattleAar; id: string }) {
  const { t } = useTranslation();
  const p = aar.place;
  const v = aar.result.verdict;
  const tone =
    v === 'ongoing'
      ? 'cyan'
      : v === 'stalemate'
        ? 'amber'
        : (v.endsWith('attacker') ? 'attacker' : 'defender') === aar.mySide
          ? 'green'
          : 'red';
  return (
    <div className="aar-head">
      <span className="aar-ref">
        {t('battles.aar.ref', { id: id.toUpperCase() })} · {t('battles.aar.classification')}
      </span>
      <div className="aar-place">
        <span>
          <b>{t('battles.aar.where')}</b>{' '}
          {p.province
            ? `${p.city && p.city !== p.province ? `${p.city}, ` : ''}${p.province}`
            : t('battles.aar.openSea')}
          {p.owner ? (
            <>
              {' '}
              · <NationTag id={p.owner} size={10} />
            </>
          ) : null}
        </span>
        <span>
          <b>{t('battles.aar.terrain')}</b> {t(`battles.aar.domain.${p.domain}`)}
          {p.urban ? ` · ${t('battles.aar.urban')}` : ''}
        </span>
      </div>
      <Badge tone={tone} variant="solid">
        {t(`battles.aar.verdict.${v}`)}
      </Badge>
    </div>
  );
}

// ——— Bilan en chiffres (deux colonnes) ———

export function AarKpis({ aar }: { aar: BattleAar }) {
  const { t } = useTranslation();
  return (
    <div className="aar-kpis">
      {aar.sides.map((s) => {
        const c = s.casualties;
        const human: Estimate = {
          best: c.killed.best + c.wounded.best + c.missing.best + c.prisoners.best,
          min: c.killed.min + c.wounded.min + c.missing.min + c.prisoners.min,
          max: c.killed.max + c.wounded.max + c.missing.max + c.prisoners.max,
        };
        return (
          <section key={s.side} className={`aar-kpi aar-kpi--${toneOf(s.side)}`}>
            <header>
              <span className="aar-kpi__side">{sideLabel(t, s)}</span>
              <span className="row">
                {s.nations.map((n) => (
                  <NationTag key={n} id={n} size={10} />
                ))}
              </span>
              {s.grade ? (
                <span
                  className="aar-grade"
                  title={t('battles.aar.gradeHelp', {
                    source: t(`battles.aar.source.${s.grade.source}`),
                    cred: t(`battles.aar.cred.${s.grade.credibility}`),
                  })}
                >
                  {t('battles.aar.grade')} {s.grade.source}
                  {s.grade.credibility}
                </span>
              ) : (
                <span className="aar-grade aar-grade--own">{t('battles.aar.exact')}</span>
              )}
            </header>
            <dl>
              <div>
                <dt>{t('battles.aar.personnel')}</dt>
                <dd>
                  <Est e={s.totals.personnel} />
                </dd>
              </div>
              <div>
                <dt>{t('battles.aar.casualties')}</dt>
                <dd>
                  <Est e={human} tone="rl-tone-red" />
                </dd>
              </div>
              <div>
                <dt>{t('battles.aar.materielLost')}</dt>
                <dd>
                  <Est e={s.materiel.destroyed} tone="rl-tone-red" />
                </dd>
              </div>
              <div>
                <dt>{t('battles.aar.lossesUsd')}</dt>
                <dd>
                  <Est e={s.lossesUsd} fmt={(n) => formatMoney(n)} />
                </dd>
              </div>
            </dl>
          </section>
        );
      })}
    </div>
  );
}

// ——— Ordre de bataille ———

function lineName(
  t: (k: string, o?: Record<string, unknown>) => string,
  f: BattleForceLine,
  name?: string,
) {
  return f.systemId
    ? (name ?? f.systemId)
    : t('battles.aar.unidentified', { medium: t(`battles.aar.medium.${f.medium}`) });
}

export function AarForces({ side }: { side: BattleAarSide }) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const photos = usePhotos();
  const rows = [...side.forces].sort((a, b) => b.engaged.best - a.engaged.best);
  return (
    <Panel
      title={`${t('battles.aar.orbat')} · ${sideLabel(t, side)}`}
      accent={toneOf(side.side)}
      meta={
        side.grade ? (
          <span className="muted small">{t('battles.aar.estimated')}</span>
        ) : (
          <span className="muted small">{t('battles.aar.exact')}</span>
        )
      }
      flush
    >
      <div className="aar-scroll">
        <table className="rl-table rl-table--dense aar-table">
          <thead>
            <tr>
              <th>{t('battles.system')}</th>
              <th>{t('battles.engaged')}</th>
              <th>{t('battles.aar.destroyed')}</th>
              <th>{t('battles.aar.damaged')}</th>
              <th>{t('battles.aar.captured')}</th>
              <th>{t('battles.aar.personnel')}</th>
              {side.own ? <th>{t('battles.aar.munitions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={side.own ? 7 : 6} className="muted">
                  {t('battles.aar.noContact')}
                </td>
              </tr>
            ) : null}
            {rows.map((f, i) => {
              const s = f.systemId ? catalog[f.systemId] : undefined;
              return (
                <tr key={`${f.systemId ?? f.medium}-${i}`}>
                  <td>
                    <span className="qrow">
                      {s ? (
                        <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" />
                      ) : (
                        <span className="aar-unknown" aria-hidden="true">
                          ?
                        </span>
                      )}
                      <b>{lineName(t, f, s?.name)}</b>
                    </span>
                  </td>
                  <td>
                    <Est e={f.engaged} />
                  </td>
                  <td>
                    <Est e={f.destroyed} tone={f.destroyed.best ? 'rl-tone-red' : 'muted'} />
                  </td>
                  <td>
                    <Est e={f.damaged} tone={f.damaged.best ? 'rl-tone-amber' : 'muted'} />
                  </td>
                  <td>
                    <Est e={f.captured} tone={f.captured.best ? '' : 'muted'} />
                  </td>
                  <td>
                    <Est e={f.personnel} />
                  </td>
                  {side.own ? (
                    <td>
                      <Est e={f.munitions} />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ——— Bilan humain, matériel, feux ———

export function AarLosses({ aar }: { aar: BattleAar }) {
  const { t } = useTranslation();
  const [a, d] = aar.sides;
  const row = (label: string, f: (s: BattleAarSide) => Estimate, tone?: string, help?: string) => (
    <tr key={label} title={help}>
      <th scope="row">{label}</th>
      <td>
        <Est e={f(a)} tone={tone} />
      </td>
      <td>
        <Est e={f(d)} tone={tone} />
      </td>
    </tr>
  );
  return (
    <Panel title={t('battles.aar.balance')} flush>
      <div className="aar-scroll">
        <table className="rl-table rl-table--dense aar-table aar-balance">
          <thead>
            <tr>
              <th />
              <th className="aar-col--red">{sideLabel(t, a)}</th>
              <th className="aar-col--cyan">{sideLabel(t, d)}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="aar-sep">
              <th colSpan={3}>{t('battles.aar.human')}</th>
            </tr>
            {row(t('battles.aar.killed'), (s) => s.casualties.killed, 'rl-tone-red')}
            {row(t('battles.aar.wounded'), (s) => s.casualties.wounded, 'rl-tone-amber')}
            {row(t('battles.aar.missing'), (s) => s.casualties.missing)}
            {row(t('battles.aar.prisoners'), (s) => s.casualties.prisoners)}
            <tr className="aar-sep">
              <th colSpan={3}>{t('battles.aar.materiel')}</th>
            </tr>
            {row(t('battles.aar.vehicles'), (s) => s.totals.vehicles)}
            {row(t('battles.aar.aircraft'), (s) => s.totals.aircraft)}
            {row(t('battles.aar.ships'), (s) => s.totals.ships)}
            {row(t('battles.aar.destroyed'), (s) => s.materiel.destroyed, 'rl-tone-red')}
            {row(t('battles.aar.damaged'), (s) => s.materiel.damaged, 'rl-tone-amber')}
            {row(t('battles.aar.captured'), (s) => s.materiel.captured)}
            <tr className="aar-sep">
              <th colSpan={3}>{t('battles.aar.fires')}</th>
            </tr>
            {row(
              t('battles.aar.munitions'),
              (s) => s.munitions,
              undefined,
              t('battles.aar.munitionsHelp'),
            )}
            {row(t('battles.aar.missilesLaunched'), (s) => s.missiles.launched)}
            {row(t('battles.aar.missilesShotDown'), (s) => s.missiles.shotDown)}
            {row(t('battles.aar.interceptions'), (s) => s.interceptions, 'rl-tone-green')}
            {row(t('battles.aar.sorties'), (s) => s.sorties)}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ——— Courbe des pertes cumulées ———

/** Largeur par défaut (rendu serveur, avant mesure) ; la hauteur est fixe. */
const W0 = 640;
const H = 200;
const PAD = { l: 40, r: 14, t: 14, b: 26 };

export function AarLossChart({ aar }: { aar: BattleAar }) {
  const { t } = useTranslation();
  const pts = aar.losses;
  const [hover, setHover] = useState<number | null>(null);
  const fig = useRef<HTMLElement | null>(null);
  const [W, setW] = useState(W0);
  useEffect(() => {
    const el = fig.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => {
      const w = Math.round(es[0]?.contentRect.width ?? W0);
      if (w > 0) setW(Math.max(260, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0]!.t;
    const t1 = Math.max(t0 + 1, pts[pts.length - 1]!.t);
    const maxY = Math.max(1, ...pts.map((p) => Math.max(p.attacker, p.defender)));
    const x = (tt: number) => PAD.l + ((tt - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => H - PAD.b - (v / maxY) * (H - PAD.t - PAD.b);
    const path = (k: 'attacker' | 'defender') =>
      pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
    const ticks = [0, Math.round(maxY / 2), maxY].filter((v, i, a) => a.indexOf(v) === i);
    return { t0, t1, maxY, x, y, path, ticks };
  }, [pts, W]);
  if (!geo) return null;
  const [a, d] = aar.sides;
  const last = pts[pts.length - 1]!;
  const hp = hover !== null ? pts[hover] : null;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++)
      if (Math.abs(geo.x(pts[i]!.t) - px) < Math.abs(geo.x(pts[best]!.t) - px)) best = i;
    setHover(best);
  };
  return (
    <Panel
      title={t('battles.aar.lossChart')}
      meta={
        <span className="aar-legend">
          <span>
            <i className="aar-sw aar-sw--red" /> {sideLabel(t, a)}
          </span>
          <span>
            <i className="aar-sw aar-sw--cyan" /> {sideLabel(t, d)}
          </span>
        </span>
      }
    >
      <figure className="aar-chart" ref={fig}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t('battles.aar.lossChartAria', {
            a: formatInt(last.attacker),
            d: formatInt(last.defender),
          })}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {aar.phases.map((p, i) => (
            <rect
              key={i}
              className={`aar-band aar-band--${p.kind}`}
              x={geo.x(Math.max(geo.t0, p.t0))}
              y={PAD.t}
              width={Math.max(2, geo.x(Math.min(geo.t1, p.t1)) - geo.x(Math.max(geo.t0, p.t0)))}
              height={H - PAD.t - PAD.b}
            />
          ))}
          {geo.ticks.map((v) => (
            <g key={v}>
              <line className="aar-grid" x1={PAD.l} x2={W - PAD.r} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="aar-axis" x={PAD.l - 6} y={geo.y(v) + 4} textAnchor="end">
                {formatInt(v)}
              </text>
            </g>
          ))}
          <text className="aar-axis" x={PAD.l} y={H - 6}>
            {fmtClock(geo.t0).time}
          </text>
          <text className="aar-axis" x={W - PAD.r} y={H - 6} textAnchor="end">
            {fmtClock(geo.t1).time}
          </text>
          <path className="aar-line aar-line--red" d={geo.path('attacker')} />
          <path className="aar-line aar-line--cyan" d={geo.path('defender')} />
          <text
            className="aar-direct"
            x={geo.x(last.t) - 4}
            y={geo.y(last.attacker) - 6}
            textAnchor="end"
          >
            {formatInt(last.attacker)}
          </text>
          <text
            className="aar-direct"
            x={geo.x(last.t) - 4}
            y={geo.y(last.defender) + 14}
            textAnchor="end"
          >
            {formatInt(last.defender)}
          </text>
          {hp ? (
            <g>
              <line
                className="aar-cross"
                x1={geo.x(hp.t)}
                x2={geo.x(hp.t)}
                y1={PAD.t}
                y2={H - PAD.b}
              />
              <circle
                className="aar-dot aar-dot--red"
                cx={geo.x(hp.t)}
                cy={geo.y(hp.attacker)}
                r={4}
              />
              <circle
                className="aar-dot aar-dot--cyan"
                cx={geo.x(hp.t)}
                cy={geo.y(hp.defender)}
                r={4}
              />
            </g>
          ) : null}
        </svg>
        {hp ? (
          <figcaption className="aar-tip" style={{ left: `${(geo.x(hp.t) / W) * 100}%` }}>
            <b>{fmtClock(hp.t).time}</b>
            <span>
              <i className="aar-sw aar-sw--red" /> {formatInt(hp.attacker)}
            </span>
            <span>
              <i className="aar-sw aar-sw--cyan" /> {formatInt(hp.defender)}
            </span>
          </figcaption>
        ) : null}
        <p className="hint small">{t('battles.aar.lossChartHelp')}</p>
      </figure>
    </Panel>
  );
}

// ——— Déroulé ———

function PhaseItem({ p }: { p: BattlePhase }) {
  const { t } = useTranslation();
  return (
    <li className={`aar-phase aar-phase--${p.kind}`}>
      <span className="aar-phase__time">
        {fmtClock(p.t0).time}
        {p.t1 > p.t0 ? `–${fmtClock(p.t1).time}` : ''}
      </span>
      <div>
        <b>{t(`battles.aar.phase.${p.kind}`)}</b>
        {p.side ? <span className="muted"> · {t(`battles.${p.side}`)}</span> : null}
        <p className="small">
          {t(`battles.aar.phaseText.${p.kind}`)}
          {p.t1 > p.t0 ? ` (${fmtDuration(p.t1 - p.t0)})` : ''}
          {p.attackerLosses + p.defenderLosses > 0
            ? ` — ${t('battles.aar.phaseLosses', { a: p.attackerLosses, d: p.defenderLosses })}`
            : ''}
        </p>
      </div>
    </li>
  );
}

export function AarPhases({ aar }: { aar: BattleAar }) {
  const { t } = useTranslation();
  if (!aar.phases.length) return null;
  return (
    <Panel title={t('battles.aar.phases')}>
      <ol className="aar-phases">
        {aar.phases.map((p, i) => (
          <PhaseItem key={i} p={p} />
        ))}
      </ol>
    </Panel>
  );
}

// ——— Facteurs décisifs et conséquences ———

function factorText(t: (k: string, o?: Record<string, unknown>) => string, f: BattleFactor) {
  const params: Record<string, unknown> = { ...f.params };
  if (typeof f.params.nation === 'string') params.nation = nationName(f.params.nation);
  return t(`battles.aar.factor.${f.kind}`, params);
}

export function AarFactors({ aar }: { aar: BattleAar }) {
  const { t } = useTranslation();
  return (
    <Panel title={t('battles.aar.factors')}>
      {aar.factors.length === 0 ? (
        <p className="hint small">{t('battles.aar.noFactor')}</p>
      ) : (
        <ul className="aar-factors">
          {aar.factors.map((f, i) => (
            <li key={i} className={`aar-factor aar-factor--${toneOf(f.side)}`}>
              <span className={f.positive ? 'aar-sign aar-sign--plus' : 'aar-sign aar-sign--minus'}>
                {f.positive ? '+' : '−'}
              </span>
              <div>
                <b>{t(`battles.aar.factorName.${f.kind}`)}</b>
                <span className="muted small"> · {t(`battles.${f.side}`)}</span>
                <p className="small">{factorText(t, f)}</p>
                <span className="aar-weight" style={{ width: `${Math.round(f.weight * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <h4 className="aar-sub">{t('battles.aar.consequences')}</h4>
      <ul className="plainlist small">
        {aar.result.captured.map((c) => (
          <li key={`${c.provinceId}-${c.at}`}>
            {t('battles.aar.captured1', { name: c.name, by: nationName(c.by) })}{' '}
            <span className="muted">({fmtClock(c.at).time})</span>
          </li>
        ))}
        {aar.result.held ? (
          <li>{t('battles.aar.held', { name: aar.place.province ?? '' })}</li>
        ) : null}
        {!aar.result.captured.length && !aar.result.held ? (
          <li className="muted">{t('battles.aar.noChange')}</li>
        ) : null}
      </ul>
    </Panel>
  );
}

/** Rapport après action complet (sous le replay). */
export function BattleAarView({ aar }: { aar: BattleAar }) {
  return (
    <>
      <AarKpis aar={aar} />
      <AarLossChart aar={aar} />
      <div className="battle__sides">
        <AarForces side={aar.sides[0]} />
        <AarForces side={aar.sides[1]} />
      </div>
      <div className="cols2 aar-cols">
        <AarLosses aar={aar} />
        <AarFactors aar={aar} />
      </div>
      <AarPhases aar={aar} />
    </>
  );
}
