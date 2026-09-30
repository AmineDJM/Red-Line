/** Boutique : packs de monnaie premium, promotions, achats et remboursements. */
import { useMemo, useState } from 'react';
import { useSession } from '../context';
import type {
  AdminPack,
  PackBody,
  PromoBody,
  Promotion,
  Purchase,
  PurchaseStatus,
} from '../api/types';
import { DataTable } from '../components/DataTable';
import { useConfirm, useToast } from '../components/overlay';
import {
  Badge,
  Button,
  ErrorBox,
  Icon,
  PageHead,
  Spinner,
  Stat,
  Tabs,
  Win,
} from '../components/term';
import { T, fmt } from '../i18n';
import { errorMessage } from '../lib/errors';
import { ago, date, num, price } from '../lib/format';
import { fromLocalInput, toLocalInput } from '../lib/dates';
import { useLoad } from '../lib/hooks';
import { href, type ShopTab } from '../lib/router';

export function ShopScreen({ tab }: { tab: ShopTab }) {
  return (
    <>
      <PageHead title={T.shop.title} sub={T.shop.sub} />
      <Tabs
        value={tab}
        tabs={(['packs', 'promotions', 'purchases'] as const).map((k) => ({
          key: k,
          label: T.shop.tabs[k],
          href: href({ name: 'shop', tab: k }),
        }))}
      />
      {tab === 'packs' ? <Packs /> : tab === 'promotions' ? <Promotions /> : <Purchases />}
    </>
  );
}

const emptyPack = (): PackBody => ({
  id: '',
  name: '',
  amount: 1000,
  bonus: 0,
  priceCents: 999,
  currency: 'eur',
  active: true,
  sort: 0,
});

function Packs() {
  const { api } = useSession();
  const toast = useToast();
  const { data, error, reload } = useLoad(
    () => api.listPacks().then((r) => r.packs),
    [api],
    T.roles.superadmin,
  );
  const [edit, setEdit] = useState<{ body: PackBody; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      if (edit.isNew) await api.createPack(edit.body);
      else await api.updatePack(edit.body.id, edit.body);
      toast(T.shop.packSaved);
      setEdit(null);
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };
  const b = edit?.body;
  const setB = (p: Partial<PackBody>) =>
    setEdit((e) => (e ? { ...e, body: { ...e.body, ...p } } : e));
  const valid =
    !!b &&
    /^[a-z0-9._-]+$/.test(b.id) &&
    b.name.trim().length > 0 &&
    b.amount > 0 &&
    b.priceCents > 0;
  return (
    <div className="split-side">
      <Win
        title={T.shop.tabs.packs}
        cmd="Get-ShopPack | Sort-Object sort"
        actions={
          <Button
            small
            variant="primary"
            onClick={() => setEdit({ body: emptyPack(), isNew: true })}
          >
            <Icon name="plus" size={12} /> {T.shop.newPack}
          </Button>
        }
      >
        {error && <ErrorBox message={error} onRetry={() => void reload()} />}
        {!data && !error && <Spinner />}
        {data && (
          <DataTable
            rows={data}
            rowKey={(p) => p.id}
            selected={edit && !edit.isNew ? edit.body.id : null}
            onRowClick={(p: AdminPack) =>
              setEdit({
                body: {
                  id: p.id,
                  name: p.name,
                  amount: p.amount,
                  bonus: p.bonus,
                  priceCents: p.priceCents,
                  currency: p.currency,
                  active: p.active,
                  sort: p.sort,
                },
                isNew: false,
              })
            }
            rowClass={(p) => (p.active ? '' : 'off')}
            columns={[
              {
                key: 'o',
                label: T.shop.sort,
                align: 'right',
                sort: (p) => p.sort,
                render: (p) => <span className="dim">{p.sort}</span>,
              },
              {
                key: 'n',
                label: T.shop.name,
                className: 'two',
                sort: (p) => p.name,
                render: (p) => (
                  <>
                    <b className="bright">{p.name}</b>
                    <span className="sub">{p.id}</span>
                  </>
                ),
              },
              {
                key: 'a',
                label: T.shop.amount,
                align: 'right',
                sort: (p) => p.amount + p.bonus,
                render: (p) => (
                  <>
                    {num(p.amount)}
                    {p.bonus > 0 && <span className="c-green"> +{num(p.bonus)}</span>}
                  </>
                ),
              },
              {
                key: 'p',
                label: T.shop.price,
                align: 'right',
                sort: (p) => p.priceCents,
                render: (p) => price(p.priceCents, p.currency),
              },
              {
                key: 'v',
                label: T.shop.playerPrice,
                align: 'right',
                render: (p) =>
                  p.view.promo ? (
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      <Badge tone="warn">−{p.view.promo.percentOff} %</Badge>
                      <span className="val">{price(p.view.priceCents, p.view.currency)}</span>
                    </span>
                  ) : (
                    <span className="val">{price(p.view.priceCents, p.view.currency)}</span>
                  ),
              },
              {
                key: 's',
                label: T.shop.active,
                render: (p) => (
                  <Badge tone={p.active ? 'ok' : 'off'}>
                    {p.active ? T.catalog.active : T.catalog.inactive}
                  </Badge>
                ),
              },
            ]}
          />
        )}
      </Win>
      <Win
        title={edit ? (edit.isNew ? T.shop.newPack : T.shop.editPack) : T.shop.editPack}
        glyph="$"
      >
        {!b ? (
          <p className="dim small">{T.shop.selectPack}</p>
        ) : (
          <div className="stack">
            <div className="grid g2">
              <div className="field">
                <label htmlFor="p-id">{T.shop.id}</label>
                <input
                  id="p-id"
                  value={b.id}
                  readOnly={!edit!.isNew}
                  onChange={(e) => setB({ id: e.target.value.trim() })}
                />
              </div>
              <div className="field">
                <label htmlFor="p-name">{T.shop.name}</label>
                <input
                  id="p-name"
                  value={b.name}
                  onChange={(e) => setB({ name: e.target.value })}
                />
              </div>
              <NumIn
                id="p-amount"
                label={T.shop.amount}
                value={b.amount}
                onChange={(amount) => setB({ amount })}
              />
              <NumIn
                id="p-bonus"
                label={T.shop.bonus}
                value={b.bonus}
                onChange={(bonus) => setB({ bonus })}
              />
              <NumIn
                id="p-price"
                label={T.shop.priceCents}
                value={b.priceCents}
                onChange={(priceCents) => setB({ priceCents })}
                affix={price(b.priceCents, b.currency)}
              />
              <div className="field">
                <label htmlFor="p-cur">{T.shop.currency}</label>
                <select
                  id="p-cur"
                  value={b.currency}
                  onChange={(e) => setB({ currency: e.target.value as 'eur' | 'usd' })}
                >
                  <option value="eur">EUR</option>
                  <option value="usd">USD</option>
                </select>
              </div>
              <NumIn
                id="p-sort"
                label={T.shop.sort}
                value={b.sort}
                onChange={(sort) => setB({ sort })}
              />
              <label className="switch" style={{ alignSelf: 'end', height: 30 }}>
                <input
                  type="checkbox"
                  checked={b.active}
                  onChange={(e) => setB({ active: e.target.checked })}
                />
                <span className="track" aria-hidden />
                {T.shop.active}
              </label>
            </div>
            <div className="row">
              <Button variant="primary" disabled={!valid || busy} onClick={() => void save()}>
                <Icon name="save" size={14} /> {busy ? T.app.saving : T.app.save}
              </Button>
              <Button variant="ghost" onClick={() => setEdit(null)}>
                {T.app.cancel}
              </Button>
            </div>
          </div>
        )}
      </Win>
    </div>
  );
}

function NumIn(p: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  affix?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={p.id}>{p.label}</label>
      <div className="input-affix">
        <input
          id={p.id}
          inputMode="numeric"
          className="num"
          value={String(p.value)}
          onChange={(e) => p.onChange(Math.round(Number(e.target.value.replace(/\s/g, '')) || 0))}
        />
        {p.affix && <span className="affix">{p.affix}</span>}
      </div>
    </div>
  );
}

function promoState(p: Promotion, now = Date.now()): keyof typeof T.shop.promoState {
  if (!p.active) return 'off';
  if (new Date(p.endsAt).getTime() <= now) return 'ended';
  if (new Date(p.startsAt).getTime() > now) return 'planned';
  return 'live';
}
const PROMO_TONE = { live: 'ok', planned: 'info', ended: 'off', off: 'off' } as const;

function Promotions() {
  const { api } = useSession();
  const toast = useToast();
  const { data, error, reload } = useLoad(
    () =>
      Promise.all([api.listPromotions(), api.listPacks()]).then(([a, b]) => ({
        promos: a.promotions,
        packs: b.packs,
      })),
    [api],
    T.roles.superadmin,
  );
  const [edit, setEdit] = useState<{ id: number | null; body: PromoBody } | null>(null);
  const [busy, setBusy] = useState(false);
  const blank = (): PromoBody => ({
    packId: null,
    label: '',
    percentOff: 20,
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    active: true,
  });
  const b = edit?.body;
  const setB = (p: Partial<PromoBody>) =>
    setEdit((e) => (e ? { ...e, body: { ...e.body, ...p } } : e));
  const valid =
    !!b &&
    b.label.trim().length > 0 &&
    b.percentOff >= 1 &&
    b.percentOff <= 90 &&
    new Date(b.endsAt) > new Date(b.startsAt);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      if (edit.id === null) await api.createPromotion(edit.body);
      else await api.updatePromotion(edit.id, edit.body);
      toast(T.shop.promoSaved);
      setEdit(null);
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="split-side">
      <Win
        title={T.shop.tabs.promotions}
        cmd="Get-ShopPromotion"
        actions={
          <Button small variant="primary" onClick={() => setEdit({ id: null, body: blank() })}>
            <Icon name="plus" size={12} /> {T.shop.newPromo}
          </Button>
        }
      >
        {error && <ErrorBox message={error} onRetry={() => void reload()} />}
        {!data && !error && <Spinner />}
        {data && (
          <DataTable
            rows={data.promos}
            rowKey={(p) => String(p.id)}
            selected={edit?.id != null ? String(edit.id) : null}
            onRowClick={(p) =>
              setEdit({
                id: p.id,
                body: {
                  packId: p.packId,
                  label: p.label,
                  percentOff: p.percentOff,
                  startsAt: p.startsAt,
                  endsAt: p.endsAt,
                  active: p.active,
                },
              })
            }
            columns={[
              {
                key: 'l',
                label: T.shop.label,
                className: 'two',
                render: (p) => (
                  <>
                    <b className="bright">{p.label}</b>
                    <span className="sub">#{p.id}</span>
                  </>
                ),
              },
              {
                key: 'p',
                label: T.shop.pack,
                render: (p) => p.packId ?? <span className="dim">{T.shop.allPacks}</span>,
              },
              {
                key: '%',
                label: T.shop.percentOff,
                align: 'right',
                sort: (p) => p.percentOff,
                render: (p) => <span className="val">−{p.percentOff} %</span>,
              },
              {
                key: 'd',
                label: `${T.shop.startsAt} → ${T.shop.endsAt}`,
                hideM: true,
                render: (p) => (
                  <span className="small">
                    {date(p.startsAt)} → {date(p.endsAt)}
                  </span>
                ),
              },
              {
                key: 's',
                label: T.shop.status,
                render: (p) => {
                  const s = promoState(p);
                  return <Badge tone={PROMO_TONE[s]}>{T.shop.promoState[s]}</Badge>;
                },
              },
            ]}
          />
        )}
      </Win>
      <Win title={edit?.id === null ? T.shop.newPromo : T.shop.editPromo} glyph="%">
        {!b ? (
          <p className="dim small">{T.shop.selectPromo}</p>
        ) : (
          <div className="stack">
            <div className="field">
              <label htmlFor="pr-l">{T.shop.label}</label>
              <input
                id="pr-l"
                value={b.label}
                maxLength={80}
                onChange={(e) => setB({ label: e.target.value })}
              />
            </div>
            <div className="grid g2">
              <div className="field">
                <label htmlFor="pr-p">{T.shop.pack}</label>
                <select
                  id="pr-p"
                  value={b.packId ?? ''}
                  onChange={(e) => setB({ packId: e.target.value || null })}
                >
                  <option value="">{T.shop.allPacks}</option>
                  {(data?.packs ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <NumIn
                id="pr-pct"
                label={T.shop.percentOff}
                value={b.percentOff}
                onChange={(percentOff) => setB({ percentOff })}
              />
              <div className="field">
                <label htmlFor="pr-s">{T.shop.startsAt}</label>
                <input
                  id="pr-s"
                  type="datetime-local"
                  value={toLocalInput(b.startsAt)}
                  onChange={(e) => setB({ startsAt: fromLocalInput(e.target.value) ?? b.startsAt })}
                />
              </div>
              <div className="field">
                <label htmlFor="pr-e">{T.shop.endsAt}</label>
                <input
                  id="pr-e"
                  type="datetime-local"
                  value={toLocalInput(b.endsAt)}
                  onChange={(e) => setB({ endsAt: fromLocalInput(e.target.value) ?? b.endsAt })}
                />
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={b.active}
                onChange={(e) => setB({ active: e.target.checked })}
              />
              <span className="track" aria-hidden />
              {T.shop.active}
            </label>
            <div className="row">
              <Button variant="primary" disabled={!valid || busy} onClick={() => void save()}>
                <Icon name="save" size={14} /> {busy ? T.app.saving : T.app.save}
              </Button>
              <Button variant="ghost" onClick={() => setEdit(null)}>
                {T.app.cancel}
              </Button>
            </div>
          </div>
        )}
      </Win>
    </div>
  );
}

const PURCHASE_TONE = { paid: 'ok', refunded: 'blue', pending: 'warn', failed: 'crit' } as const;

function Purchases() {
  const { api } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<PurchaseStatus | ''>('');
  const { data, error, reload } = useLoad(
    () => api.listPurchases({ status: status || undefined, limit: 500 }).then((r) => r.purchases),
    [api, status],
    T.roles.superadmin,
  );
  const totals = useMemo(() => {
    const rows = data ?? [];
    return {
      paid: rows.filter((p) => p.status === 'paid').reduce((a, p) => a + p.priceCents, 0),
      refunded: rows.filter((p) => p.status === 'refunded').reduce((a, p) => a + p.priceCents, 0),
    };
  }, [data]);
  const refund = async (p: Purchase) => {
    const ok = await confirm({
      title: T.shop.refund,
      danger: true,
      confirm: T.shop.refund,
      message: fmt(T.shop.refundConfirm, {
        id: p.id.slice(0, 8),
        price: price(p.priceCents, p.currency),
        user: p.userName ?? '—',
        credits: num(p.credits),
      }),
    });
    if (!ok) return;
    try {
      const r = await api.refund(p.id);
      toast(fmt(T.shop.refunded, { n: num(r.balance) }));
      void reload(true);
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    }
  };
  return (
    <>
      <div className="stats">
        <Stat k={T.shop.count} v={data?.length ?? '…'} />
        <Stat k={T.shop.revenue} v={price(totals.paid, 'eur')} tone="var(--t-green)" />
        <Stat k={T.shop.refundedTotal} v={price(totals.refunded, 'eur')} tone="var(--t-blue)" />
      </div>
      <Win title={T.shop.tabs.purchases} cmd={`Get-Purchase${status ? ` -Status ${status}` : ''}`}>
        <div className="toolbar">
          <select
            className="input"
            aria-label={T.shop.status}
            value={status}
            onChange={(e) => setStatus(e.target.value as PurchaseStatus | '')}
          >
            <option value="">{T.shop.allStatuses}</option>
            {(['paid', 'pending', 'refunded', 'failed'] as const).map((s) => (
              <option key={s} value={s}>
                {T.shop.statuses[s]}
              </option>
            ))}
          </select>
        </div>
        {error && <ErrorBox message={error} onRetry={() => void reload()} />}
        <DataTable
          rows={data ?? []}
          rowKey={(p) => p.id}
          maxHeight="calc(100vh - 380px)"
          columns={[
            {
              key: 'd',
              label: T.shop.date,
              sort: (p) => p.createdAt,
              render: (p) => <span title={date(p.createdAt)}>{ago(p.createdAt)}</span>,
            },
            {
              key: 'u',
              label: T.shop.user,
              sort: (p) => p.userName ?? '',
              render: (p) =>
                p.userId ? (
                  <a href={href({ name: 'users', id: p.userId })}>
                    {p.userName ?? p.userId.slice(0, 8)}
                  </a>
                ) : (
                  '—'
                ),
            },
            { key: 'p', label: T.shop.pack, render: (p) => p.packId },
            {
              key: 'c',
              label: T.shop.credits,
              align: 'right',
              sort: (p) => p.credits,
              render: (p) => num(p.credits),
            },
            {
              key: 'm',
              label: T.shop.price,
              align: 'right',
              sort: (p) => p.priceCents,
              render: (p) => <span className="val">{price(p.priceCents, p.currency)}</span>,
            },
            {
              key: 's',
              label: T.shop.status,
              sort: (p) => p.status,
              render: (p) => (
                <Badge tone={PURCHASE_TONE[p.status]}>{T.shop.statuses[p.status]}</Badge>
              ),
            },
            {
              key: 'id',
              label: 'Stripe',
              hideM: true,
              render: (p) => (
                <code className="dim small">{p.paymentIntent ?? p.stripeSessionId ?? '—'}</code>
              ),
            },
            {
              key: 'a',
              label: '',
              align: 'right',
              render: (p) =>
                p.status === 'paid' ? (
                  <Button small variant="danger" onClick={() => void refund(p)}>
                    <Icon name="undo" size={12} /> {T.shop.refund}
                  </Button>
                ) : null,
            },
          ]}
        />
      </Win>
    </>
  );
}
