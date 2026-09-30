import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BUILDING_TYPES,
  type Balance,
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

export const MAX_BUILDING_LEVEL = 5;

/** Familles de bâtiments (menu « Construire »). */
export const BUILDING_GROUPS: { id: string; types: BuildingType[] }[] = [
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
    types: ['bunker', 'air_defense_site', 'coastal_battery', 'radar_station', 'missile_silo'],
  },
];

const COASTAL_ONLY = new Set<BuildingType>(['port', 'naval_base', 'coastal_battery']);

/** Coût et durée d'une construction ou amélioration (data/balance ; × niveau visé). */
export function buildCost(
  balance: Balance | null,
  type: BuildingType,
  level: number,
): { money: number | null; hours: number | null } {
  const b = balance?.buildings;
  const money = b?.buildCostUsd[type];
  const hours = b?.buildHours[type];
  return {
    money: money !== undefined ? money * level : null,
    hours: hours !== undefined ? hours * level : null,
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
  const conn = useGame((s) => s.connection);
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const balance = useWorld((s) => s.balance);
  const toast = useUi((s) => s.toast);
  const level = b.level ?? 1;
  const upgrading = b.upgradeUntil && b.upgradeUntil > now;
  const repairing = b.repairUntil && b.repairUntil > now;
  const next = buildCost(balance, b.type, level + 1);
  const send = async (kind: 'build' | 'repair') => {
    const res = await conn?.sendOrder(
      kind === 'build'
        ? { kind: 'build', provinceId, building: b.type }
        : { kind: 'repair', provinceId, building: b.type },
    );
    if (res?.ok)
      toast(
        t(kind === 'build' ? 'buildings.ui.upgradeStarted' : 'buildings.ui.repairStarted', {
          name: t(`buildings.${b.type}`),
        }),
        'ok',
      );
    else if (res)
      toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  };
  return (
    <li className={compact ? 'bldg bldg--compact' : 'bldg'}>
      <span className={b.health < 0.5 ? 'bldg__icon bldg__icon--hit' : 'bldg__icon'}>
        <Pictogram id={pictogramForBuilding(b.type)} size={18} />
      </span>
      <span className="bldg__main">
        <span className="bldg__name">
          {t(`buildings.${b.type}`)}
          <LevelPips level={level} />
        </span>
        <span className="bldg__state">
          {upgrading ? (
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
      {editable ? (
        <span className="bldg__actions">
          {b.health < 1 && !repairing ? (
            <Button
              size="sm"
              variant="subtle"
              icon={<Icon name="wrench" size={12} />}
              onClick={() => void send('repair')}
            >
              {t('buildings.ui.repair')}
            </Button>
          ) : null}
          {level < MAX_BUILDING_LEVEL && !upgrading ? (
            <Button
              size="sm"
              icon={<Icon name="arrowUp" size={12} />}
              disabled={next.money !== null && money < next.money}
              title={
                next.money !== null
                  ? t('buildings.ui.costTip', {
                      cost: formatMoney(next.money),
                      time: next.hours ? formatHours(next.hours, t('time.dayUnit')) : '—',
                    })
                  : undefined
              }
              onClick={() => void send('build')}
            >
              {compact ? `N${level + 1}` : t('buildings.ui.upgrade', { level: level + 1 })}
              {next.money !== null && !compact ? (
                <span className="bldg__cost">{formatMoney(next.money)}</span>
              ) : null}
            </Button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** Menu de construction d'un nouveau bâtiment dans une province. */
export function BuildMenu({
  provinceId,
  existing,
  coastal,
}: {
  provinceId: ProvinceId;
  existing: BuildingType[];
  coastal: boolean;
}) {
  const { t } = useTranslation();
  const conn = useGame((s) => s.connection);
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const balance = useWorld((s) => s.balance);
  const toast = useUi((s) => s.toast);
  const [group, setGroup] = useState(BUILDING_GROUPS[0]!.id);
  const g = BUILDING_GROUPS.find((x) => x.id === group)!;
  const build = async (type: BuildingType) => {
    const res = await conn?.sendOrder({ kind: 'build', provinceId, building: type });
    if (res?.ok) toast(t('buildings.ui.buildStarted', { name: t(`buildings.${type}`) }), 'ok');
    else if (res)
      toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  };
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
          .filter((type) => BUILDING_TYPES.includes(type))
          .map((type) => {
            const has = existing.includes(type);
            const blocked = COASTAL_ONLY.has(type) && !coastal;
            const c = buildCost(balance, type, 1);
            return (
              <li key={type}>
                <button
                  type="button"
                  className="buildmenu__item"
                  disabled={has || blocked || (c.money !== null && money < c.money)}
                  onClick={() => void build(type)}
                  title={t(`buildings.effects.${type}`, { defaultValue: '' })}
                >
                  <Pictogram id={pictogramForBuilding(type)} size={18} />
                  <span className="buildmenu__name">
                    {t(`buildings.${type}`)}
                    <span className="buildmenu__desc">
                      {has
                        ? t('buildings.ui.already')
                        : blocked
                          ? t('buildings.ui.coastalOnly')
                          : t(`buildings.effects.${type}`, { defaultValue: '' })}
                    </span>
                  </span>
                  <span className="buildmenu__cost">
                    {c.money !== null ? formatMoney(c.money) : '—'}
                    <span>{c.hours !== null ? formatHours(c.hours, t('time.dayUnit')) : ''}</span>
                  </span>
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
