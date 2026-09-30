import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CosmeticItem, ShopPack, ShopPolicy, WalletEntry } from '@redline/shared';
import { Badge, Button, EmptyState, Icon, Panel, Spinner, Stat, formatInt } from '@redline/ui';
import { getApi } from '../api/index.js';
import { useUi } from '../store/ui.js';

const PREVIEW: Record<string, string[]> = {
  amber: ['#1c1300', '#ffb020', '#ffd27a'],
  green: ['#04130a', '#3ddc84', '#9ff5c4'],
  night: ['#05070c', '#1b2a4a', '#9b6bff'],
  desert: ['#2b2216', '#c9a66b', '#f0dca8'],
  arctic: ['#0f1a22', '#cfe8f5', '#ffffff'],
  veteran: ['#141a22', '#ffb020', '#d6dde6'],
};

function euros(cents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

/** Boutique : portefeuille, paquets de monnaie premium, cosmétiques, historique (sans loot box). */
export function ShopContent({ policy }: { policy?: ShopPolicy | null }) {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  const [packs, setPacks] = useState<ShopPack[] | null>(null);
  const [wallet, setWallet] = useState<{ balance: number; history: WalletEntry[] } | null>(null);
  const [cosm, setCosm] = useState<{ items: CosmeticItem[]; owned: string[] } | null>(null);
  const [error, setError] = useState(false);
  const reload = () =>
    void getApi().then((api) =>
      Promise.all([api.shopPacks(), api.wallet(), api.cosmetics()])
        .then(([p, w, c]) => {
          setPacks(p);
          setWallet(w);
          setCosm(c);
        })
        .catch(() => setError(true)),
    );
  useEffect(reload, []);
  if (error) return <EmptyState icon="shop" title={t('shop.unavailable')} text={t('shop.unavailableHint')} />;
  if (!packs || !wallet || !cosm) return <Spinner label={t('app.loading')} />;
  const buy = async (id: string) => {
    const api = await getApi();
    const { url } = await api.checkout(id);
    if (url) window.location.assign(url);
    else {
      toast(t('shop.credited'), 'ok');
      reload();
    }
  };
  const buyCosm = async (id: string) => {
    const r = await (await getApi()).buyCosmetic(id);
    toast(r.ok ? t('shop.cosmeticBought') : t('shop.notEnough'), r.ok ? 'ok' : 'error');
    reload();
  };
  return (
    <div className="vstack shop">
      <div className="kpis">
        <Stat label={t('shop.balance')} value={<span className="gems"><Icon name="gem" size={18} /> {formatInt(wallet.balance)}</span>} tone="cyan" sub={t('shop.currency')} />
        <Stat label={t('shop.policy')} value={t(`shop.policies.${policy?.mode ?? 'open'}`)} sub={policy?.mode === 'limited' ? t('shop.cap', { cap: policy.capPerPlayer ?? 0 }) : t('shop.policyHint')} />
      </div>
      <p className="shop__fair">
        <Icon name="shield" size={14} /> {t('shop.fair')}
      </p>
      <Panel title={t('shop.packs')}>
        <div className="packs">
          {packs.map((p, i) => (
            <div key={p.id} className={i === 2 ? 'pack pack--best' : 'pack'}>
              {p.promo ? <Badge tone="amber" variant="solid">{p.promo.label} −{p.promo.percentOff} %</Badge> : i === 2 ? <Badge tone="cyan" variant="solid">{t('shop.best')}</Badge> : <span className="pack__spacer" />}
              <span className="pack__name">{p.name}</span>
              <span className="pack__amount">
                <Icon name="gem" size={16} /> {formatInt(p.amount)}
              </span>
              <span className="pack__bonus">{p.bonus ? t('shop.bonus', { value: formatInt(p.bonus) }) : ' '}</span>
              <Button variant={i === 2 ? 'primary' : 'default'} block onClick={() => void buy(p.id)}>
                {euros(p.promo ? Math.round(p.priceCents * (1 - p.promo.percentOff / 100)) : p.priceCents, p.currency)}
              </Button>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title={t('shop.cosmetics')}>
        <div className="cosmetics">
          {cosm.items.map((c) => {
            const owned = cosm.owned.includes(c.id);
            return (
              <div key={c.id} className="cosm">
                <div className="cosm__preview" aria-hidden>
                  {(PREVIEW[c.preview] ?? PREVIEW.night!).map((col, i) => (
                    <span key={i} style={{ background: col }} />
                  ))}
                </div>
                <span className="cosm__kind">{t(`shop.kinds.${c.kind}`)}</span>
                <span className="cosm__name">{c.name}</span>
                {owned ? (
                  <Badge tone="green">{t('shop.owned')}</Badge>
                ) : (
                  <Button size="sm" disabled={wallet.balance < c.price} onClick={() => void buyCosm(c.id)}>
                    <Icon name="gem" size={12} /> {formatInt(c.price)}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      <Panel title={t('shop.accelerations')}>
        <p className="hint">{t('shop.accelerationsHelp')}</p>
      </Panel>
      <Panel title={t('shop.history')} flush>
        <table className="rl-table rl-table--dense">
          <tbody>
            {wallet.history.map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.createdAt).toLocaleDateString('fr-FR')}</td>
                <td>{t(`shop.reasons.${h.reason}`)}</td>
                <td className="muted">{h.ref ?? ''}</td>
                <td style={{ textAlign: 'right' }} className={h.delta >= 0 ? 'rl-tone-green' : 'rl-tone-red'}>
                  {h.delta >= 0 ? '+' : '−'}
                  {formatInt(Math.abs(h.delta))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
