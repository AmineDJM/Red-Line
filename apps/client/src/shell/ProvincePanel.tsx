import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BuildingView } from '@redline/shared';
import {
  Badge,
  Button,
  Flag,
  Gauge,
  Icon,
  KeyValue,
  Pictogram,
  ProgressBar,
  formatCompact,
  formatMoney,
  pictogramForBuilding,
} from '@redline/ui';
import { fmtDuration } from '../i18n/index.js';
import { nationName, relationOf } from '../lib/game.js';
import { BuildingRow, BuildMenu } from '../components/Buildings.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { useGameTime } from './helpers.js';

/** Fiche de province : bâtiments (niveaux, construction) si elle est à nous, connaissance sinon. */
export function ProvincePanel({ id, compact }: { id: string; compact: boolean }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const conn = useGame((s) => s.connection);
  const def = useWorld((s) => s.provinces[id]);
  const selectProvince = useUi((s) => s.selectProvince);
  const openWindow = useUi((s) => s.openWindow);
  const toast = useUi((s) => s.toast);
  const [building, setBuilding] = useState(false);
  const now = useGameTime(2000);
  const p = view?.provinces[id];
  if (!p || !def || !view) return null;
  const own = p.owner === me;
  const rel = relationOf(view, p.owner);
  const allied = rel === 'ally';
  const intel = p.intel;
  const state: BuildingView[] =
    p.buildingState ?? p.buildings.map((type) => ({ type, level: 1, health: 1 }));
  const capture = p.capture;
  const captureF = capture
    ? (now - capture.startedAt) / Math.max(1, capture.completesAt - capture.startedAt)
    : 0;

  const intelOp = async (op: 'infiltrate_spy' | 'listen_area') => {
    const res = await conn?.sendOrder({
      kind: 'intelOp',
      op,
      target:
        op === 'listen_area'
          ? { at: def.cityPoint, radiusKm: 80, nationId: p.owner }
          : { provinceId: id, nationId: p.owner },
    });
    if (res?.ok) toast(t('province.reconStarted', { province: def.cityName ?? def.name }), 'ok');
    else if (res) toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  };

  return (
    <section
      className={compact ? 'selpanel selpanel--compact provpanel' : 'selpanel provpanel'}
      aria-label={def.name}
      data-map-avoid
      data-testid="province-panel"
    >
      <header className="selpanel__head">
        <div className="selpanel__titles">
          <div className="selpanel__kicker">
            <Flag nationId={p.owner} size={12} />
            <span>{nationName(p.owner)}</span>
            {def.isCapital ? <Badge tone="amber">{t('game.callout.capital')}</Badge> : null}
            {!own ? (
              <Badge tone={rel === 'war' ? 'red' : allied ? 'green' : 'neutral'}>
                {t(`diplomacy.relation.${rel}`)}
              </Badge>
            ) : null}
          </div>
          <h2 className="selpanel__name">{def.cityName ?? def.name}</h2>
          <div className="selpanel__sub">
            {def.cityName && def.cityName !== def.name ? `${def.name} · ` : ''}
            {t('province.title')}
          </div>
        </div>
        <button
          type="button"
          className="selpanel__close"
          onClick={() => selectProvince(null)}
          aria-label={t('app.close')}
        >
          <Icon name="close" size={15} />
        </button>
      </header>

      {capture ? (
        <div className="provpanel__capture">
          <span>
            {capture.by === me
              ? t('province.captureOwn')
              : t('province.captureBy', { nation: nationName(capture.by) })}
          </span>
          <ProgressBar
            value={captureF}
            tone={capture.by === me ? 'violet' : 'red'}
            trailing={fmtDuration(Math.max(0, capture.completesAt - now))}
            label={t('province.capture')}
          />
        </div>
      ) : null}

      {own || allied ? (
        <>
          <KeyValue
            items={[
              ...(def.population
                ? [{ label: t('province.population'), value: formatCompact(def.population) }]
                : []),
              { label: t('province.income'), value: formatMoney(def.income.money), tone: 'amber' as const },
              ...(p.fortification
                ? [{ label: t('province.fortification'), value: t('province.level', { level: p.fortification.level }) }]
                : []),
              ...(p.unrest !== undefined
                ? [{ label: t('province.unrest'), value: `${Math.round(p.unrest)} %`, tone: p.unrest > 50 ? ('red' as const) : undefined }]
                : []),
            ]}
          />
          <div className="provpanel__section">
            <span className="selpanel__label">
              {t('province.buildings')} <b>{state.length}</b>
            </span>
            {own ? (
              <Button
                size="sm"
                variant={building ? 'primary' : 'subtle'}
                icon={<Icon name={building ? 'close' : 'plus'} size={12} />}
                onClick={() => setBuilding(!building)}
                data-testid="build-toggle"
              >
                {building ? t('app.close') : t('buildings.ui.build')}
              </Button>
            ) : null}
          </div>
          {building && own ? (
            <BuildMenu provinceId={id} existing={p.buildings} coastal={def.coastal} />
          ) : (
            <ul className="bldgs">
              {state.map((b) => (
                <BuildingRow key={b.type} provinceId={id} b={b} now={now} editable={own} compact={compact} />
              ))}
              {!state.length ? <li className="muted small">{t('province.noBuildings')}</li> : null}
            </ul>
          )}
          {own ? (
            <div className="selpanel__actions">
              <Button
                size="sm"
                icon={<Icon name="production" size={13} />}
                onClick={() => openWindow('production', { provinceId: id })}
              >
                {t('province.produceHere')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon name="shield" size={13} />}
                onClick={() => void conn?.sendOrder({ kind: 'build', provinceId: id, building: 'fortification' })}
              >
                {t('province.fortify')}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="provpanel__intel">
            <span className="selpanel__label">{t('province.knowledge')}</span>
            <Gauge
              value={(intel?.level ?? 0) / 3}
              cells={3}
              tone={(intel?.level ?? 0) >= 2 ? 'green' : (intel?.level ?? 0) === 1 ? 'amber' : 'red'}
              valueText={t(`province.intelLevel.${intel?.level ?? 0}`)}
              label={t('province.knowledge')}
            />
          </div>
          <KeyValue
            items={[
              {
                label: t('province.updated'),
                value: intel ? t('province.ago', { value: fmtDuration(Math.max(0, now - intel.updatedAt)) }) : '—',
                tone: 'dim',
              },
              { label: t('province.economicIntel'), value: intel?.economic ? t('app.yes') : t('app.no') },
              { label: t('province.militaryIntel'), value: intel?.military ? t('app.yes') : t('app.no') },
            ]}
          />
          <div className="provpanel__section">
            <span className="selpanel__label">
              {t('province.knownBuildings')} <b>{state.length}</b>
            </span>
          </div>
          {state.length ? (
            <ul className="bldgs bldgs--known">
              {state.map((b) => (
                <li key={b.type} className="bldg bldg--compact">
                  <span className="bldg__icon">
                    <Pictogram id={pictogramForBuilding(b.type)} size={16} />
                  </span>
                  <span className="bldg__name">{t(`buildings.${b.type}`)}</span>
                  {b.level ? <span className="bldg__lvl">N{b.level}</span> : null}
                </li>
              ))}
              {(intel?.level ?? 0) < 3 ? <li className="bldg bldg--unknown">{t('province.moreUnknown')}</li> : null}
            </ul>
          ) : (
            <p className="provpanel__unknown">{t('province.unknownHint')}</p>
          )}
          <div className="selpanel__actions">
            <Button size="sm" variant="primary" icon={<Icon name="spy" size={13} />} onClick={() => void intelOp('infiltrate_spy')} data-testid="recon-button">
              {t('province.recon')}
            </Button>
            <Button size="sm" icon={<Icon name="radio" size={13} />} onClick={() => void intelOp('listen_area')}>
              {t('province.listen')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
