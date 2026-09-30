import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DOCTRINES,
  HOUR,
  RESOURCES,
  type Doctrine,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import {
  Bullet,
  Button,
  Drawer,
  HexIcon,
  Meter,
  Tabs,
  WeaponCard,
  pictogramFor,
} from '@redline/ui';
import { fmtClock, fmtDuration, fmtInt } from '../i18n/index.js';
import { unitPosition } from '../map/interpolation.js';
import { VIOLET_UNIT } from '../map/features.js';
import { gameNow, useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { describeNotification, useGameTime, weaponLabels, weaponSubtitle } from './helpers.js';
import { Icons } from './icons.js';

// ——— Centre d'alertes ———

export function AlertsDrawer() {
  const { t } = useTranslation();
  const open = useUi((s) => s.drawer === 'alerts');
  const close = useUi((s) => s.openDrawer);
  const focusOn = useUi((s) => s.focusOn);
  const notifications = useGame((s) => s.notifications);
  const markAllRead = useGame((s) => s.markAllRead);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  return (
    <Drawer
      open={open}
      onClose={() => close(null)}
      title={t('game.alerts.title')}
      side="right"
      closeLabel={t('app.close')}
      footer={
        notifications.some((n) => !n.read) ? (
          <Button block onClick={markAllRead}>
            {t('game.alerts.markRead')}
          </Button>
        ) : null
      }
    >
      {notifications.length === 0 ? <p className="empty">{t('game.alerts.empty')}</p> : null}
      <ul className="alerts">
        {notifications.map((n) => {
          const d = describeNotification(n.item, view, me);
          const c = fmtClock(n.item.time);
          return (
            <li key={n.id}>
              <button
                type="button"
                className={[
                  'alert',
                  d.critical ? 'alert--critical' : d.major ? 'alert--major' : '',
                  n.read ? '' : 'alert--unread',
                ].join(' ')}
                disabled={!d.at}
                onClick={() => {
                  if (!d.at) return;
                  focusOn(d.at, 5.5);
                  if (isMobile) close(null);
                }}
              >
                <span className="alert__dot" aria-hidden />
                <span className="alert__text">{d.text}</span>
                <span className="alert__time rl-mono">
                  {c.day} {c.time}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Drawer>
  );
}

// ——— Armée ———

export function ArmyDrawer() {
  const { t } = useTranslation();
  const open = useUi((s) => s.drawer === 'army');
  const openDrawer = useUi((s) => s.openDrawer);
  const select = useUi((s) => s.select);
  const focusOn = useUi((s) => s.focusOn);
  const selection = useUi((s) => s.selection);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const catalog = useWorld((s) => s.catalog);

  const groups = useMemo(() => {
    const own = Object.values(view?.units ?? {}).filter(
      (u) => u.owner === me && u.level === 'own' && u.status !== 'destroyed',
    );
    const byCat = new Map<string, UnitView[]>();
    for (const u of own) {
      const cat = (u.systemId && catalog[u.systemId]?.category) || 'other';
      byCat.set(cat, [...(byCat.get(cat) ?? []), u]);
    }
    return [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [view?.units, me, catalog]);
  const total = groups.reduce((s, [, l]) => s + l.length, 0);

  return (
    <Drawer
      open={open}
      onClose={() => openDrawer(null)}
      title={`${t('game.army.title')} · ${t('game.army.units', { count: total })}`}
      closeLabel={t('app.close')}
    >
      {total === 0 ? <p className="empty">{t('game.army.empty')}</p> : null}
      {groups.map(([cat, list]) => (
        <section key={cat} className="army-group">
          <h3 className="section-title">{t(`categories.${cat}`, { defaultValue: cat })}</h3>
          <ul className="army-list">
            {list.map((u) => {
              const sys = u.systemId ? catalog[u.systemId] : undefined;
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    className={selection.includes(u.id) ? 'army-row army-row--sel' : 'army-row'}
                    onClick={() => {
                      select([u.id]);
                      focusOn(unitPosition(u, gameNow()), 5.5);
                      if (window.innerWidth < 768) openDrawer(null);
                    }}
                  >
                    <HexIcon pictogram={pictogramFor(sys)} color={VIOLET_UNIT} size={30} />
                    <span className="army-row__main">
                      <span className="army-row__name">{sys?.name ?? u.systemId}</span>
                      <span className="army-row__sub">
                        {u.status ? t(`game.status.${u.status}`) : ''}
                        {u.count !== undefined
                          ? ` · ${t('game.army.count', { count: u.count })}`
                          : ''}
                      </span>
                    </span>
                    {u.hpRatio !== undefined ? (
                      <span className="army-row__hp">
                        <Meter
                          value={u.hpRatio}
                          tone={u.hpRatio < 0.3 ? 'critical' : 'violet'}
                          label={t('game.army.hp')}
                        />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Drawer>
  );
}

// ——— Production ———

export function ProductionDrawer() {
  const { t } = useTranslation();
  const open = useUi((s) => s.drawer === 'production');
  const openDrawer = useUi((s) => s.openDrawer);
  const selectedProvince = useUi((s) => s.selectedProvince);
  const selectProvince = useUi((s) => s.selectProvince);
  const toast = useUi((s) => s.toast);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const conn = useGame((s) => s.connection);
  const catalog = useWorld((s) => s.catalog);
  const defs = useWorld((s) => s.provinces);
  const now = useGameTime(2000);

  const systems = useMemo(
    () => Object.values(catalog).filter((s) => s.enabled !== false),
    [catalog],
  );
  const doctrines = DOCTRINES.filter((d) => systems.some((s) => s.doctrine === d));
  const [tab, setTab] = useState<Doctrine>(doctrines[0] ?? 'us');
  const [detail, setDetail] = useState<WeaponSystem | null>(null);

  const myProvinces = useMemo(
    () =>
      Object.values(view?.provinces ?? {})
        .filter((p) => p.owner === me)
        .map((p) => ({
          id: p.id,
          name: defs[p.id]?.name ?? p.id,
          capital: !!defs[p.id]?.isCapital,
        }))
        .sort((a, b) => Number(b.capital) - Number(a.capital) || a.name.localeCompare(b.name)),
    [view?.provinces, me, defs],
  );
  const province =
    myProvinces.find((p) => p.id === selectedProvince)?.id ?? myProvinces[0]?.id ?? '';
  const eco = view?.economy;
  const list = systems
    .filter((s) => s.doctrine === tab)
    .sort((a, b) => a.category.localeCompare(b.category) || a.cost.money - b.cost.money);

  const produce = async (s: WeaponSystem) => {
    if (!conn || !province) return;
    const res = await conn.sendOrder({ kind: 'produce', provinceId: province, systemId: s.id });
    if (res.ok) toast(t('game.production.ordered', { unit: s.name }), 'ok');
    else toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
  };

  const costLine = (s: WeaponSystem) => (
    <span className="cost rl-mono">
      <span className="cost__item">
        {Icons.money(13)}
        {fmtInt(s.cost.money)}
      </span>
      {RESOURCES.filter((r) => s.cost.resources?.[r]).map((r) => (
        <span key={r} className="cost__item" title={t(`game.resources.${r}`)}>
          {Icons[r](13)}
          {fmtInt(s.cost.resources[r] ?? 0)}
        </span>
      ))}
    </span>
  );

  return (
    <Drawer
      open={open}
      onClose={() => openDrawer(null)}
      title={t('game.production.title')}
      closeLabel={t('app.close')}
      width={420}
    >
      <section className="prod-queue">
        <h3 className="section-title">{t('game.production.queue')}</h3>
        {eco?.production.length ? (
          eco.production.map((p) => {
            const s = catalog[p.systemId];
            const f = (now - p.startedAt) / Math.max(1, p.completesAt - p.startedAt);
            return (
              <div key={p.id} className="prod-item">
                <HexIcon pictogram={pictogramFor(s)} color={VIOLET_UNIT} size={26} />
                <div className="prod-item__main">
                  <div className="prod-item__name">
                    {s?.name ?? p.systemId}{' '}
                    <span className="muted">· {defs[p.provinceId]?.name ?? p.provinceId}</span>
                  </div>
                  <Meter value={f} tone="accent" />
                </div>
                <span className="prod-item__eta rl-mono">
                  {t('game.production.remaining', { value: fmtDuration(p.completesAt - now) })}
                </span>
              </div>
            );
          })
        ) : (
          <p className="empty">{t('game.production.queueEmpty')}</p>
        )}
      </section>

      <label className="field">
        <span className="field__label">{t('game.production.province')}</span>
        <select
          className="select"
          value={province}
          onChange={(e) => selectProvince(e.target.value)}
        >
          {myProvinces.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {detail ? (
        <div className="prod-detail">
          <Button variant="ghost" onClick={() => setDetail(null)}>
            ← {t('game.production.back')}
          </Button>
          <WeaponCard
            system={detail}
            labels={weaponLabels()}
            subtitle={weaponSubtitle(detail)}
            compact
          />
          <div className="prod-detail__cost">
            <Bullet>
              {t('game.production.cost')} : {costLine(detail)}
            </Bullet>
            <Bullet>
              {t('game.production.buildTime')} :{' '}
              <span className="rl-mono accent">{fmtDuration(detail.buildTimeH * HOUR)}</span>
            </Bullet>
          </div>
          <Button
            variant="primary"
            block
            size="lg"
            disabled={!province || (eco?.money ?? 0) < detail.cost.money}
            onClick={() => void produce(detail)}
          >
            {(eco?.money ?? 0) < detail.cost.money
              ? t('game.production.insufficient')
              : t('game.production.produce')}
          </Button>
        </div>
      ) : (
        <>
          <Tabs
            label={t('game.production.catalog')}
            tabs={doctrines.map((d) => ({ id: d, label: t(`doctrines.${d}`) }))}
            value={tab}
            onChange={setTab}
          />
          {list.length === 0 ? <p className="empty">{t('game.production.empty')}</p> : null}
          <ul className="catalog">
            {list.map((s) => (
              <li key={s.id}>
                <button type="button" className="catalog-row" onClick={() => setDetail(s)}>
                  <HexIcon
                    pictogram={pictogramFor(s)}
                    color="var(--rl-orange)"
                    size={34}
                    outline={null}
                  />
                  <span className="catalog-row__main">
                    <span className="catalog-row__name">{s.name}</span>
                    <span className="catalog-row__sub">
                      {t(`categories.${s.category}`)} ·{' '}
                      {t('game.production.generation', { value: s.generation })} ·{' '}
                      {fmtDuration(s.buildTimeH * HOUR)}
                    </span>
                    {costLine(s)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Drawer>
  );
}

// ——— Calques ———

export function LayersDrawer() {
  const { t } = useTranslation();
  const open = useUi((s) => s.drawer === 'layers');
  const openDrawer = useUi((s) => s.openDrawer);
  const layers = [
    { id: 'military', on: true, soon: false },
    { id: 'intel', on: false, soon: true },
    { id: 'economy', on: false, soon: true },
    { id: 'diplomacy', on: false, soon: true },
  ];
  return (
    <Drawer
      open={open}
      onClose={() => openDrawer(null)}
      title={t('game.layers.title')}
      side="right"
      closeLabel={t('app.close')}
      width={300}
    >
      <ul className="layer-list">
        {layers.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              className={l.soon ? 'layer-row layer-row--soon' : 'layer-row layer-row--on'}
              disabled={l.soon}
              aria-pressed={l.on}
            >
              <span className="layer-row__check" aria-hidden>
                {l.on ? '■' : ''}
              </span>
              <span className="layer-row__label">{t(`game.layers.${l.id}`)}</span>
              {l.soon ? <span className="layer-row__soon">{t('game.layers.soon')}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
