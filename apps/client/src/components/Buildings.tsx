import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BUILDING_TYPES,
  type Balance,
  type BuildOptionView,
  type BuildingType,
  type BuildingView,
  type ProvinceId,
} from '@redline/shared';
import {
  Badge,
  Button,
  Countdown,
  Icon,
  Pictogram,
  ProgressBar,
  formatHours,
  formatMoney,
  pictogramForBuilding,
} from '@redline/ui';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { orderError } from '../lib/loc.js';

export const MAX_BUILDING_LEVEL = 5;

type BuildKind = BuildingType | 'fortification';

/** Familles de bâtiments (menu « Construire »). */
export const BUILDING_GROUPS: { id: string; types: BuildKind[] }[] = [
  {
    id: 'resources',
    types: ['oil_field', 'refinery', 'mine', 'farm', 'electronics_plant', 'power_plant'],
  },
  { id: 'industry', types: ['local_industry', 'arms_factory', 'research_center', 'secret_lab'] },
  {
    id: 'military',
    types: [
      'military_base',
      'air_base',
      'port',
      'naval_base',
      'recruiting_office',
      'forward_base',
      'hospital',
    ],
  },
  {
    id: 'defense',
    types: [
      'fortification',
      'bunker',
      'air_defense_site',
      'coastal_battery',
      'radar_station',
      'missile_silo',
    ],
  },
];

const COASTAL_ONLY = new Set<BuildKind>(['port', 'naval_base', 'coastal_battery']);

/**
 * Devis d'un chantier à partir de data/balance (repli quand le moteur ne publie pas `next` /
 * `buildOptions`) : coût × croissance^(niveau − 1), durée × (1 + croissance × (niveau − 1)).
 */
export function buildCost(
  balance: Balance | null,
  type: BuildKind,
  level: number,
): { money: number | null; hours: number | null } {
  const b = balance?.buildings;
  const money = b?.buildCostUsd[type];
  const hours = b?.buildHours[type];
  const g = b?.levelCostGrowth ?? 1.6;
  const tg = b?.levelTimeGrowth ?? 0.25;
  return {
    money: money !== undefined ? money * Math.pow(g, level - 1) : null,
    hours: hours !== undefined ? hours * (1 + tg * (level - 1)) : null,
  };
}

function LevelPips({ level }: { level: number }) {
  return (
    <span className="lvlpips" aria-label={`${level} / ${MAX_BUILDING_LEVEL}`}>
      {Array.from({ length: MAX_BUILDING_LEVEL }, (_, i) => (
        <i key={i} className={i < level ? 'on' : ''} />
      ))}
    </span>
  );
}

function picto(type: BuildKind) {
  return pictogramForBuilding(type === 'fortification' ? 'bunker' : type);
}

/** Envoie un ordre de chantier avec retour visuel (toast). */
function useBuildOrder() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (
    order:
      | { kind: 'build'; provinceId: ProvinceId; building: BuildKind }
      | { kind: 'repair'; provinceId: ProvinceId; building: BuildingType },
    ok: string,
  ) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res)
      toast(orderError(res), 'error');
    return !!res?.ok;
  };
}

/** Ligne de bâtiment : pictogramme, niveau 1-5, état, amélioration/réparation. */
export function BuildingRow({
  provinceId,
  b,
  now,
  editable,
  compact,
}: {
  provinceId: ProvinceId;
  b: BuildingView;
  now: number;
  editable: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const balance = useWorld((s) => s.balance);
  const send = useBuildOrder();
  const level = b.level ?? 1;
  const building = !!(b.buildUntil && b.buildUntil > now);
  const upgrading = !building && !!(b.upgradeUntil && b.upgradeUntil > now);
  const repairing = !!(b.repairUntil && b.repairUntil > now);
  const fallback = buildCost(balance, b.type, level + 1);
  const next =
    b.next !== undefined
      ? b.next
      : level >= MAX_BUILDING_LEVEL
        ? null
        : { level: level + 1, cost: fallback.money, hours: fallback.hours };
  const name = t(`buildings.${b.type}`);
  return (
    <li className={compact ? 'bldg bldg--compact' : 'bldg'} data-building={b.type}>
      <span className={b.health < 0.5 && !building ? 'bldg__icon bldg__icon--hit' : 'bldg__icon'}>
        <Pictogram id={picto(b.type)} size={18} />
      </span>
      <span className="bldg__main">
        <span className="bldg__name">
          {name}
          {!building ? <LevelPips level={level} /> : null}
        </span>
        <span className="bldg__state">
          {building ? (
            <>
              <Badge tone="cyan">{t('buildings.ui.constructing')}</Badge>
              <Countdown ms={b.buildUntil! - now} dayUnit={t('time.dayUnit')} />
            </>
          ) : upgrading ? (
            <>
              <Badge tone="cyan">{t('buildings.ui.upgrading', { level: level + 1 })}</Badge>
              <Countdown ms={b.upgradeUntil! - now} dayUnit={t('time.dayUnit')} />
            </>
          ) : repairing ? (
            <>
              <Badge tone="amber">{t('buildings.ui.repairing')}</Badge>
              <Countdown ms={b.repairUntil! - now} dayUnit={t('time.dayUnit')} />
            </>
          ) : b.health < 1 ? (
            <ProgressBar
              value={b.health}
              tone="auto"
              size="xs"
              trailing={`${Math.round(b.health * 100)} %`}
              label={t('buildings.ui.health')}
            />
          ) : (
            <span className="bldg__ok">{t('buildings.ui.operational')}</span>
          )}
        </span>
      </span>
      {editable && !building ? (
        <span className="bldg__actions">
          {b.health < 1 && !repairing ? (
            <Button
              size="sm"
              variant="subtle"
              icon={<Icon name="wrench" size={12} />}
              onClick={() =>
                void send(
                  { kind: 'repair', provinceId, building: b.type },
                  t('buildings.ui.repairStarted', { name }),
                )
              }
            >
              {t('buildings.ui.repair')}
            </Button>
          ) : null}
          {next && !upgrading && b.health >= 1 ? (
            <Button
              size="sm"
              icon={<Icon name="arrowUp" size={12} />}
              disabled={next.cost !== null && money < next.cost}
              title={
                next.cost !== null
                  ? t('buildings.ui.costTip', {
                      cost: formatMoney(next.cost),
                      time: next.hours ? formatHours(next.hours, t('time.dayUnit')) : '—',
                    })
                  : undefined
              }
              onClick={() =>
                void send(
                  { kind: 'build', provinceId, building: b.type },
                  t('buildings.ui.upgradeStarted', { name, level: next.level }),
                )
              }
              data-testid={`upgrade-${b.type}`}
            >
              {compact ? `N${next.level}` : t('buildings.ui.upgrade', { level: next.level })}
              {next.cost !== null ? (
                <span className="bldg__cost">{formatMoney(next.cost)}</span>
              ) : null}
            </Button>
          ) : null}
          {!next && !upgrading ? (
            <Badge tone="neutral" variant="outline">
              {t('buildings.ui.maxLevel')}
            </Badge>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** Menu de construction d'un nouveau bâtiment (ou fortification) dans une province. */
export function BuildMenu({
  provinceId,
  existing,
  coastal,
  options,
  onDone,
}: {
  provinceId: ProvinceId;
  existing: BuildingType[];
  coastal: boolean;
  /** Options publiées par le moteur (coût et durée exacts). */
  options?: BuildOptionView[];
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const balance = useWorld((s) => s.balance);
  const send = useBuildOrder();
  const [group, setGroup] = useState(BUILDING_GROUPS[0]!.id);
  const g = BUILDING_GROUPS.find((x) => x.id === group)!;
  const byType = new Map(options?.map((o) => [o.type, o]));
  return (
    <div className="buildmenu">
      <div className="buildmenu__groups" role="tablist" aria-label={t('buildings.ui.build')}>
        {BUILDING_GROUPS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={x.id === group}
            className={
              x.id === group ? 'buildmenu__group buildmenu__group--on' : 'buildmenu__group'
            }
            onClick={() => setGroup(x.id)}
          >
            {t(`buildings.groups.${x.id}`)}
          </button>
        ))}
      </div>
      <ul className="buildmenu__list">
        {g.types
          .filter((type) => type === 'fortification' || BUILDING_TYPES.includes(type))
          .map((type) => {
            const opt = byType.get(type);
            const has = type !== 'fortification' && existing.includes(type);
            const blockedCoast = COASTAL_ONLY.has(type) && !coastal;
            const est = buildCost(balance, type, opt?.level ?? 1);
            const cost = opt ? opt.cost : est.money;
            const hours = opt ? opt.hours : est.hours;
            const reason = has
              ? t('buildings.ui.already')
              : blockedCoast
                ? t('buildings.ui.coastalOnly')
                : opt?.blocked
                  ? t(`buildings.ui.blocked.${opt.blocked}`)
                  : null;
            const poor = cost !== null && money < cost;
            return (
              <li key={type}>
                <button
                  type="button"
                  className="buildmenu__item"
                  disabled={!!reason || poor}
                  onClick={() =>
                    void send(
                      { kind: 'build', provinceId, building: type },
                      t('buildings.ui.buildStarted', { name: t(`buildings.${type}`) }),
                    ).then((ok) => ok && onDone?.())
                  }
                  title={t(`buildings.effects.${type}`, { defaultValue: '' })}
                  data-testid={`build-${type}`}
                >
                  <Pictogram id={picto(type)} size={18} />
                  <span className="buildmenu__name">
                    {type === 'fortification' && opt
                      ? `${t('buildings.fortification')} · N${opt.level}`
                      : t(`buildings.${type}`)}
                    <span className="buildmenu__desc">
                      {reason ?? t(`buildings.effects.${type}`, { defaultValue: '' })}
                    </span>
                  </span>
                  <span
                    className={poor ? 'buildmenu__cost buildmenu__cost--poor' : 'buildmenu__cost'}
                  >
                    {cost !== null ? formatMoney(cost) : '—'}
                    <span>{hours !== null ? formatHours(hours, t('time.dayUnit')) : ''}</span>
                  </span>
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
