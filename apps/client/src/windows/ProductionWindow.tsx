import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProvinceId, WeaponSystem } from '@redline/shared';
import {
  Badge,
  Button,
  Countdown,
  EmptyState,
  Icon,
  Money,
  ProgressBar,
  Select,
  Table,
  Tabs,
  Window,
  WeaponPhoto,
  formatHours,
  formatMoney,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { ArsenalBrowser } from '../components/ArsenalBrowser.js';
import { productionStatus, provinceName, requiredBuilding, researchName } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

type Tab = 'arsenal' | 'queue' | 'licences';

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (
    order: Parameters<
      NonNullable<ReturnType<typeof useGame.getState>['connection']>['sendOrder']
    >[0],
    okText: string,
  ) => {
    const conn = useGame.getState().connection;
    const res = await conn?.sendOrder(order);
    if (res?.ok) toast(okText, 'ok');
    else if (res)
      toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
    return !!res?.ok;
  };
}

/** Actions de la fiche : province, quantité, produire / importer / licence. */
function ProduceActions({
  s,
  provinceId,
  setProvinceId,
}: {
  s: WeaponSystem;
  provinceId: ProvinceId;
  setProvinceId: (p: ProvinceId) => void;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const defs = useWorld((s) => s.provinces);
  const balance = useWorld((s) => s.balance);
  const research = useWorld((s) => s.research);
  const openWindow = useUi((s) => s.openWindow);
  const send = useSend();
  const [count, setCount] = useState(1);
  const st = productionStatus(s, view, me);
  const need = requiredBuilding(s);
  const mine = useMemo(
    () =>
      Object.values(view?.provinces ?? {})
        .filter((p) => p.owner === me)
        .map((p) => ({
          id: p.id,
          ok: p.buildings.includes(need),
          name: provinceName(p.id),
          capital: !!defs[p.id]?.isCapital,
        }))
        .sort(
          (a, b) =>
            Number(b.ok) - Number(a.ok) ||
            Number(b.capital) - Number(a.capital) ||
            a.name.localeCompare(b.name),
        ),
    [view?.provinces, me, need, defs],
  );
  const prov = mine.find((p) => p.id === provinceId) ?? mine[0];
  const money = view?.economy.money ?? 0;
  const ind = balance?.industry;
  // Même calcul que le moteur (eco/production) : modificateur de coût de la recherche, remise de
  // licence ; importation au prix × importPriceFactor, livrée après fabrication + délai de transport.
  const costMod = view?.research?.modifiers['production.cost'] ?? 1;
  const discount = st.licensed ? 1 - (balance?.licences?.productionDiscount ?? 0.3) : 1;
  const importing = !st.producible && st.importable;
  const total = importing
    ? s.cost.money * count * (ind?.importPriceFactor ?? 1.3)
    : s.cost.money * count * costMod * discount;
  const batchH = s.buildTimeH * (1 + (ind?.batchTimeFactor ?? 0.25) * (count - 1));
  const speed = view?.research?.modifiers['production.speed'] ?? 1;
  const delayH = importing ? batchH + (ind?.importDeliveryHours ?? 72) : batchH / speed;
  const licencePrice = (s.unitPriceUsd ?? s.cost.money) * (balance?.licences?.priceFactor ?? 20);
  return (
    <div className="produce">
      <div className="produce__row">
        <label className="produce__field">
          <span>{t('production.site')}</span>
          <Select
            value={prov?.id ?? ''}
            onChange={setProvinceId}
            options={mine.map((p) => ({ value: p.id, label: `${p.ok ? '●' : '○'} ${p.name}` }))}
            label={t('production.site')}
          />
        </label>
        <div className="produce__field">
          <span>{t('production.quantity')}</span>
          <div className="stepper">
            <button type="button" onClick={() => setCount(Math.max(1, count - 1))} aria-label="−">
              <Icon name="minus" size={12} />
            </button>
            <output>{count}</output>
            <button type="button" onClick={() => setCount(Math.min(20, count + 1))} aria-label="+">
              <Icon name="plus" size={12} />
            </button>
          </div>
        </div>
      </div>
      {prov && !prov.ok ? (
        <p className="produce__warn">
          <Icon name="warning" size={13} />{' '}
          {t('production.needBuilding', { building: t(`buildings.${need}`) })}
        </p>
      ) : null}
      <div className="produce__total">
        <span>{importing ? t('production.importTotal') : t('production.total')}</span>
        <Money value={total} />
        <span className="produce__delay">
          <Icon name="clock" size={12} /> {formatHours(delayH, t('time.dayUnit'))}
        </span>
        {money < total ? <Badge tone="red">{t('production.insufficient')}</Badge> : null}
      </div>
      <div className="produce__buttons">
        {st.producible ? (
          <Button
            variant="primary"
            icon={<Icon name="production" size={14} />}
            disabled={!prov || money < total}
            onClick={() =>
              void send(
                { kind: 'produce', provinceId: prov!.id, systemId: s.id, count },
                t('production.ordered', { count, unit: s.name }),
              )
            }
            data-testid="produce-button"
          >
            {t('production.produce')}
          </Button>
        ) : (
          <Button
            variant="subtle"
            icon={<Icon name="research" size={14} />}
            onClick={() => openWindow('research', { nodeId: st.missing[0] })}
          >
            {t('production.goResearch', { node: researchName(st.missing[0] ?? '', research) })}
          </Button>
        )}
        {!st.producible && st.importable ? (
          <Button
            icon={<Icon name="truck" size={14} />}
            disabled={!prov || money < total}
            onClick={() =>
              void send(
                { kind: 'produce', provinceId: prov!.id, systemId: s.id, count },
                t('production.imported', { count, unit: s.name }),
              )
            }
          >
            {t('production.import')}
          </Button>
        ) : null}
        {st.licensable && !st.producible ? (
          <Button
            variant="subtle"
            icon={<Icon name="document" size={14} />}
            disabled={money < licencePrice}
            onClick={() =>
              void send(
                { kind: 'buyLicence', systemId: s.id },
                t('production.licenceBought', { unit: s.name }),
              )
            }
          >
            {t('production.buyLicence', { price: formatMoney(licencePrice) })}
          </Button>
        ) : null}
        {!st.producible && !st.importable && st.embargoed ? (
          <Button
            variant="danger"
            icon={<Icon name="spy" size={14} />}
            onClick={() =>
              void send(
                { kind: 'blackMarket', systemId: s.id, count: Math.min(10, count) },
                t('production.blackMarketOrdered'),
              )
            }
          >
            {t('production.blackMarket')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Queue() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const meta = useGame((s) => s.meta);
  const catalog = useWorld((s) => s.catalog);
  const photos = usePhotos();
  const toast = useUi((s) => s.toast);
  const send = useSend();
  const now = useGameTime(1000);
  const items = view?.economy.production ?? [];
  if (!items.length)
    return (
      <EmptyState
        icon="production"
        title={t('production.queueEmpty')}
        text={t('production.queueHint')}
      />
    );
  return (
    <Table
      label={t('production.queue')}
      rows={items}
      rowKey={(p) => p.id}
      columns={[
        {
          key: 'unit',
          header: t('production.cols.unit'),
          render: (p) => {
            const s = catalog[p.systemId];
            return (
              <span className="qrow">
                {s ? <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" /> : null}
                <span>
                  <b>
                    {(p.count ?? 1) > 1 ? `${p.count} × ` : ''}
                    {s?.name ?? p.systemId}
                  </b>
                  <span className="qrow__sub">
                    {s ? t(`categories.${s.category}`) : ''}
                    {p.source && p.source !== 'factory'
                      ? ` · ${t(`production.source.${p.source}`)}`
                      : ''}
                  </span>
                </span>
              </span>
            );
          },
        },
        {
          key: 'site',
          header: t('production.site'),
          render: (p) => provinceName(p.provinceId),
          hideOnMobile: true,
        },
        {
          key: 'progress',
          header: t('production.cols.progress'),
          width: '28%',
          render: (p) => (
            <ProgressBar
              value={(now - p.startedAt) / Math.max(1, p.completesAt - p.startedAt)}
              trailing={`${Math.round(((now - p.startedAt) / Math.max(1, p.completesAt - p.startedAt)) * 100)} %`}
              label={t('production.cols.progress')}
            />
          ),
        },
        {
          key: 'eta',
          header: t('production.cols.eta'),
          align: 'right',
          render: (p) => (
            <Countdown ms={p.completesAt - now} dayUnit={t('time.dayUnit')} urgentBelowMs={-1} />
          ),
          sort: (a, b) => a.completesAt - b.completesAt,
        },
        {
          key: 'act',
          header: '',
          align: 'right',
          render: (p) => (
            <span className="rowactions">
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon name="bolt" size={12} />}
                title={t('production.accelerate')}
                onClick={() =>
                  void getApi()
                    .then((api) =>
                      api.accelerate(meta?.id ?? 'demo', { type: 'production', id: p.id }, 6),
                    )
                    .then((r) =>
                      toast(
                        r.ok ? t('shop.accelerated', { balance: r.balance }) : t('shop.notEnough'),
                        r.ok ? 'ok' : 'error',
                      ),
                    )
                    .catch(() => toast(t('shop.unavailable'), 'error'))
                }
              >
                {t('production.accelerateShort')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon name="close" size={12} />}
                aria-label={t('production.cancel')}
                onClick={() =>
                  void send(
                    { kind: 'cancelProduction', productionId: p.id },
                    t('production.cancelled'),
                  )
                }
              />
            </span>
          ),
        },
      ]}
    />
  );
}

function Licences() {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const catalog = useWorld((s) => s.catalog);
  const photos = usePhotos();
  const now = useGameTime(5000);
  const list = view?.licences ?? [];
  if (!list.length)
    return (
      <EmptyState
        icon="document"
        title={t('production.noLicences')}
        text={t('production.licenceHint')}
      />
    );
  return (
    <ul className="licences">
      {list.map((l) => {
        const s = catalog[l.systemId];
        return (
          <li key={l.systemId} className="licence">
            {s ? <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="thumb" /> : null}
            <div>
              <b>{s?.name ?? l.systemId}</b>
              <span className="muted small">
                {s ? t(`doctrines.${s.doctrine}`) : ''} ·{' '}
                {t('production.acquired', {
                  value: Math.max(0, Math.round((now - l.acquiredAt) / 86_400_000)),
                })}
              </span>
              <Badge tone="violet">{t('arsenal.licence')}</Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Production et arsenal : doctrines, fiches avec photo, file de production, licences. */
export function ProductionWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const selectedProvince = useUi((s) => s.selectedProvince);
  const [tab, setTab] = useState<Tab>((win.params.tab as Tab) ?? 'arsenal');
  const [provinceId, setProvinceId] = useState<ProvinceId>(
    win.params.provinceId ?? selectedProvince ?? '',
  );
  useEffect(() => {
    if (win.params.tab) setTab(win.params.tab as Tab);
    if (win.params.provinceId) setProvinceId(win.params.provinceId);
  }, [win.seq, win.params.tab, win.params.provinceId]);
  const queue = view?.economy.production.length ?? 0;
  const mine = Object.values(view?.provinces ?? {}).filter((p) => p.owner === me).length;
  return (
    <Window
      {...frame}
      path={[t('sections.path.production'), t(`production.tabs.${tab}`)]}
      flush
      tabs={
        <Tabs
          label={t('sections.production')}
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'arsenal',
              label: t('production.tabs.arsenal'),
              icon: <Icon name="encyclopedia" size={13} />,
            },
            {
              id: 'queue',
              label: t('production.tabs.queue'),
              count: queue,
              icon: <Icon name="clock" size={13} />,
            },
            {
              id: 'licences',
              label: t('production.tabs.licences'),
              count: view?.licences?.length ?? 0,
              icon: <Icon name="document" size={13} />,
            },
          ]}
        />
      }
      headerExtra={
        !mobile ? (
          <span className="win-meta">
            <span>{t('production.treasury')}</span> <Money value={view?.economy.money ?? 0} />
            <span className="win-meta__sep" />
            <span>{t('production.sites', { count: mine })}</span>
          </span>
        ) : null
      }
    >
      {tab === 'arsenal' ? (
        <ArsenalBrowser
          mode="production"
          mobile={mobile}
          initialSystemId={win.params.systemId}
          renderActions={(s) => (
            <ProduceActions s={s} provinceId={provinceId} setProvinceId={setProvinceId} />
          )}
        />
      ) : tab === 'queue' ? (
        <div className="win-pad">
          <Queue />
        </div>
      ) : (
        <div className="win-pad">
          <Licences />
        </div>
      )}
    </Window>
  );
}
