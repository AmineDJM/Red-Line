import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { BattleReport, BattleReportSummary, BattleSide, SystemId } from '@redline/shared';
import { Badge, Button, Flag, Icon, formatInt } from '@redline/ui';
import { getApi } from '../api/index.js';
import { fmtClock, fmtDuration } from '../i18n/index.js';
import { glyphFor } from '../map/glyphs.js';
import { useMapSel } from '../map/mapSel.js';
import { glyphDataUrl } from '../map/pions.js';
import { stackRows } from '../map/stackMenu.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useGameTime } from './helpers.js';
import './mapui.css';

const total = (l: { count: number }[]) => l.reduce((n, x) => n + x.count, 0);

/** Colonne d'un camp : nations, pertes / engagés, systèmes engagés (les plus nombreux). */
function SideCol({
  side,
  label,
  tone,
  mine,
}: {
  side: BattleSide;
  label: string;
  tone: 'red' | 'green';
  mine: boolean;
}) {
  const { t } = useTranslation();
  const catalog = useWorld((s) => s.catalog);
  const lost = new Map<SystemId, number>(side.losses.map((l) => [l.systemId, l.count]));
  const list = [...side.engaged].sort((a, b) => b.count - a.count).slice(0, 5);
  const eng = total(side.engaged);
  const los = total(side.losses);
  return (
    <div className={`btp__side btp__side--${tone}`}>
      <div className="btp__sidehead">
        <span className="btp__flags">
          {side.nations.map((n) => (
            <Flag key={n} nationId={n} size={12} />
          ))}
        </span>
        <span className="btp__sidelabel">
          {label}
          {mine ? <em> · {t('map.battle.you')}</em> : null}
        </span>
      </div>
      <div className="btp__loss">
        <b>−{formatInt(los)}</b>
        <span>{t('map.battle.engaged', { count: eng })}</span>
      </div>
      <ul className="btp__sys">
        {list.map((e) => {
          const s = catalog[e.systemId];
          const l = lost.get(e.systemId) ?? 0;
          return (
            <li key={e.systemId} title={s?.name ?? e.systemId}>
              <img src={glyphDataUrl(s ? glyphFor(s) : 'unknown', '#e6ecf2', 14)} alt="" />
              <span className="btp__sysname">{s?.name ?? e.systemId}</span>
              <span className="btp__sysn">
                {formatInt(e.count)}
                {l ? <i>−{formatInt(l)}</i> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Détail d'une bataille en cours (rapport) : camps, pertes en direct, tirs, chronologie. */
function ReportDetail({ b }: { b: BattleReportSummary }) {
  const { t } = useTranslation();
  const me = useGame((s) => s.me);
  const meta = useGame((s) => s.meta);
  const def = useWorld((s) => (b.provinceId ? s.provinces[b.provinceId] : undefined));
  const now = useGameTime(1000);
  const [report, setReport] = useState<BattleReport | null>(null);
  const live = b.outcome === 'ongoing';
  // Chronologie : rapport complet, rafraîchi pendant les combats.
  useEffect(() => {
    let alive = true;
    const load = () =>
      void getApi()
        .then((api) => api.battleReport(meta?.id ?? 'demo', b.id))
        .then((r) => alive && setReport(r))
        .catch(() => undefined);
    load();
    const timer = live ? setInterval(load, 15_000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [b.id, meta?.id, live]);
  const mineAtt = !!me && b.attacker.nations.includes(me);
  const mineDef = !!me && b.defender.nations.includes(me);
  const la = total(b.attacker.losses);
  const ld = total(b.defender.losses);
  const ratio = la + ld > 0 ? la / (la + ld) : 0.5;
  const recent = (b.live?.shots ?? []).filter((s) => now - s.t < 10 * 60_000);
  const hits = recent.filter((s) => s.hit).length;
  const last = b.live?.lastAt ?? b.endedAt ?? b.startedAt;
  return (
    <>
      <div className="btp__stats">
        <div>
          <span>{t('map.battle.since')}</span>
          <b>{fmtDuration(Math.max(0, (b.endedAt ?? now) - b.startedAt))}</b>
        </div>
        <div>
          <span>{t('map.battle.lastShot')}</span>
          <b className={live && now - last < 10 * 60_000 ? 'rl-tone-red' : undefined}>
            {now - last < 60_000 ? t('map.tip.seenNow') : fmtDuration(now - last)}
          </b>
        </div>
        <div>
          <span>{t('map.battle.fire')}</span>
          <b>{recent.length ? t('map.battle.fireValue', { count: recent.length, hits }) : '—'}</b>
        </div>
      </div>
      <div className="btp__balance" aria-label={t('map.battle.balance')}>
        <span className="btp__balancelabel">{t('map.battle.balance')}</span>
        <div className="btp__bar">
          <i
            className="btp__bar-a"
            style={{ width: `${Math.round(ratio * 100)}%` } as CSSProperties}
          />
          <i className="btp__bar-d" style={{ width: `${Math.round((1 - ratio) * 100)}%` }} />
        </div>
      </div>
      <div className="btp__sides">
        <SideCol
          side={b.attacker}
          label={t('map.battle.attacker')}
          tone={mineAtt ? 'green' : 'red'}
          mine={mineAtt}
        />
        <SideCol
          side={b.defender}
          label={t('map.battle.defender')}
          tone={mineDef || !mineAtt ? 'green' : 'red'}
          mine={mineDef}
        />
      </div>
      <div className="btp__timeline">
        <span className="selpanel__label">{t('map.battle.timeline')}</span>
        {report ? (
          <ol>
            {report.timeline
              .slice(-5)
              .reverse()
              .map((e, i) => (
                <li key={i}>
                  <time>{fmtClock(e.t).time}</time>
                  <p>{e.text}</p>
                </li>
              ))}
          </ol>
        ) : (
          <p className="muted small">{t('map.battle.loading')}</p>
        )}
      </div>
      {def ? <span className="btp__where">{def.name}</span> : null}
    </>
  );
}

/** Accrochage sans rapport : unités au combat visibles. */
function SkirmishDetail({ unitIds }: { unitIds: string[] }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);
  const now = useGameTime(2000);
  const rows = useMemo(
    () =>
      view
        ? stackRows(unitIds.map((id) => view.units[id]!).filter(Boolean), {
            me,
            nations: view.nations,
            catalog,
            t: now,
            unknown: t('map.tip.unknown'),
          })
        : [],
    [view, unitIds, me, catalog, now, t],
  );
  return (
    <>
      <p className="muted small">{t('map.battle.noReport')}</p>
      <ul className="btp__units">
        {rows.map((r) => (
          <li key={r.id}>
            <Flag nationId={r.owner} size={11} />
            <img src={glyphDataUrl(r.glyph, '#e6ecf2', 14)} alt="" />
            <span>{r.name}</span>
            {r.count !== undefined ? <b>×{formatInt(r.count)}</b> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Panneau de détail des combats (marqueur de bataille cliqué sur la carte). */
export function BattlePanel({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const sel = useMapSel((s) => s.battle);
  const selectBattle = useMapSel((s) => s.selectBattle);
  const reports = useGame((s) => s.view?.battleReports);
  const focusOn = useUi((s) => s.focusOn);
  const openWindow = useUi((s) => s.openWindow);
  if (!sel) return null;
  const b = sel.reportId ? reports?.find((r) => r.id === sel.reportId) : undefined;
  const live = !b || b.outcome === 'ongoing';
  return (
    <section
      className={compact ? 'selpanel selpanel--compact btp' : 'selpanel btp'}
      aria-label={b?.title ?? t('map.battle.skirmish')}
      data-map-avoid
      data-testid="battle-panel"
    >
      <header className="selpanel__head">
        <div className="btp__icon" aria-hidden>
          <Icon name="battle" size={18} />
        </div>
        <div className="selpanel__titles">
          <div className="selpanel__kicker">
            <Badge tone={live ? 'red' : 'neutral'} dot pulse={live}>
              {live ? t('map.battle.live') : t('map.battle.ended')}
            </Badge>
          </div>
          <h2 className="selpanel__name">{b?.title ?? t('map.battle.skirmish')}</h2>
        </div>
        <button
          type="button"
          className="selpanel__close"
          onClick={() => selectBattle(null)}
          aria-label={t('map.battle.close')}
          title={`${t('map.battle.close')} · Échap`}
        >
          <Icon name="close" size={15} />
        </button>
      </header>
      {b ? <ReportDetail b={b} /> : <SkirmishDetail unitIds={sel.unitIds} />}
      <div className="selpanel__actions">
        <Button
          size="sm"
          variant="subtle"
          icon={<Icon name="mapPin" size={12} />}
          onClick={() => focusOn(sel.at, 7.5)}
        >
          {t('map.battle.locate')}
        </Button>
        {b ? (
          <Button
            size="sm"
            icon={<Icon name="battle" size={12} />}
            onClick={() => openWindow('battles', { reportId: b.id })}
            data-testid="battle-report-link"
          >
            {t('map.battle.report')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
