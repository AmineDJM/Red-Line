import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { distanceKm, type ProvinceDef } from '@redline/shared';
import { formatCompact, formatInt } from '@redline/ui';
import { cityClass, cityClassThresholds } from '../map/features.js';
import { glyphFor } from '../map/glyphs.js';
import { unitPosition } from '../map/interpolation.js';
import { glyphDataUrl } from '../map/pions.js';
import { CAT_TONE, UNIT_CATS, unitCat, type UnitCat } from '../map/unitCat.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import './mapui.css';

/** Rayon de la garnison autour de la ville (km). */
const GARRISON_KM = 40;

let thresholds: [number, number] | null = null;
function rankOf(def: ProvinceDef, defs: Record<string, ProvinceDef>): number {
  thresholds ??= cityClassThresholds(Object.values(defs));
  return cityClass(def, thresholds);
}

/**
 * Bandeau de la fiche de province : rang de la ville, population, moral (sa province), et garnison
 * visible autour de la ville par famille (ses unités : clic pour les sélectionner).
 */
export function ProvinceStrip({ id }: { id: string }) {
  const { t } = useTranslation();
  const def = useWorld((s) => s.provinces[id]);
  const defs = useWorld((s) => s.provinces);
  const catalog = useWorld((s) => s.catalog);
  const view = useGame((s) => s.view);
  const units = view?.units;
  const time = view?.time ?? 0;
  const me = useGame((s) => s.me);
  const select = useUi((s) => s.select);
  const garrison = useMemo(() => {
    const out = new Map<
      UnitCat,
      { own: string[]; foreign: number; count: number; glyph: ReturnType<typeof glyphFor> }
    >();
    if (!def || !units) return out;
    for (const u of Object.values(units)) {
      if (u.missile || u.status === 'destroyed' || u.status === 'embarked') continue;
      if (distanceKm(unitPosition(u, time), def.cityPoint) > GARRISON_KM) continue;
      const sys = u.systemId && u.level !== 'detected' ? catalog[u.systemId] : undefined;
      const cat = unitCat(sys);
      const g = out.get(cat) ?? {
        own: [],
        foreign: 0,
        count: 0,
        glyph: sys ? glyphFor(sys) : 'unknown',
      };
      if (u.level === 'own') g.own.push(u.id);
      else g.foreign++;
      g.count += u.count ?? 0;
      out.set(cat, g);
    }
    return out;
  }, [def, units, catalog, time]);
  if (!def || !view) return null;
  const p = view.provinces[id];
  const own = p?.owner === me;
  const eco = own ? view.economy.detail?.provinces.find((x) => x.id === id) : undefined;
  const rank = rankOf(def, defs);
  const cats = UNIT_CATS.filter((c) => garrison.has(c));
  return (
    <div className="pvs" data-testid="province-strip">
      <div className="pvs__facts">
        <span className={`pvs__rank pvs__rank--${rank}`}>{t(`map.city.rank${rank}`)}</span>
        {def.population ? (
          <span className="pvs__fact">
            <b>{formatCompact(def.population)}</b> {t('province.population').toLowerCase()}
          </span>
        ) : null}
        {eco ? (
          <span className="pvs__fact">
            {t('province.morale')}{' '}
            <b
              className={
                eco.morale < 40
                  ? 'rl-tone-red'
                  : eco.morale < 65
                    ? 'rl-tone-amber'
                    : 'rl-tone-green'
              }
            >
              {Math.round(eco.morale)}
            </b>
          </span>
        ) : null}
      </div>
      <div className="pvs__garrison">
        <span className="selpanel__label">{t('map.prov.garrison')}</span>
        {cats.length ? (
          <div className="pvs__chips">
            {cats.map((c) => {
              const g = garrison.get(c)!;
              const mine = g.own.length > 0;
              return (
                <button
                  key={c}
                  type="button"
                  className={mine ? 'pvs__chip pvs__chip--own' : 'pvs__chip'}
                  style={{ '--tone': CAT_TONE[c] } as CSSProperties}
                  disabled={!mine}
                  onClick={() => select(g.own)}
                  title={t(`map.stack.cat.${c}`)}
                >
                  <img src={glyphDataUrl(g.glyph, '#eef3f8', 14)} alt="" />
                  <b>{g.own.length + g.foreign}</b>
                  {g.count ? <i>×{formatInt(g.count)}</i> : null}
                  {g.foreign && mine ? <em>+{g.foreign}</em> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="muted small">{t('map.prov.garrisonNone')}</span>
        )}
      </div>
    </div>
  );
}
