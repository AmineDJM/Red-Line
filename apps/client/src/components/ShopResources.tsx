import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES, type Resource, type ResourceOffer, type ShopPolicy } from '@redline/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  Panel,
  Spinner,
  formatInt,
  formatMoney,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { ApiError } from '../api/types.js';
import { RESOURCE_ICON } from '../shell/TopBar.js';
import { useUi } from '../store/ui.js';
import '../styles/w-domestic.css';

/** Contenu d'une offre : dollars puis ressources, ordre fixe. */
function offerLines(o: ResourceOffer): { key: string; res: Resource | null; qty: number }[] {
  const out: { key: string; res: Resource | null; qty: number }[] = [];
  if (o.money > 0) out.push({ key: 'money', res: null, qty: o.money });
  for (const r of RESOURCES) {
    const q = o.resources[r];
    if (q && q > 0) out.push({ key: r, res: r, qty: q });
  }
  return out;
}

function OfferContent({ o }: { o: ResourceOffer }) {
  const { t } = useTranslation();
  return (
    <ul className="roffer__lines">
      {offerLines(o).map((l) => (
        <li key={l.key}>
          <span className="roffer__icon" aria-hidden>
            <Icon name={l.res ? RESOURCE_ICON[l.res] : 'money'} size={14} />
          </span>
          <span className="roffer__qty">+{l.res ? formatInt(l.qty) : formatMoney(l.qty)}</span>
          <span className="roffer__unit">
            {l.res ? t(`game.resources.${l.res}`).toLowerCase() : t('shop.resources.dollars')}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Boutique en partie : monnaie premium échangée contre des dollars du jeu et des ressources, créditées
 * à la nation (commande système journalisée). Politique de la partie respectée ; confirmation avec le
 * solde après achat.
 */
export function ShopResources({
  gameId,
  policy,
  balance,
  unlimited,
  onDone,
}: {
  gameId: string;
  policy?: ShopPolicy | null;
  balance: number;
  unlimited?: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  const [offers, setOffers] = useState<ResourceOffer[] | null>(null);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState<ResourceOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [delivered, setDelivered] = useState<string | null>(null);
  const [spent, setSpent] = useState<{ spent: number; cap: number } | null>(null);
  useEffect(() => {
    void getApi().then((api) =>
      api
        .resourceOffers()
        .then(setOffers)
        .catch(() => setError(true)),
    );
  }, []);
  useEffect(() => {
    if (!delivered) return;
    const h = setTimeout(() => setDelivered(null), 2600);
    return () => clearTimeout(h);
  }, [delivered]);

  const disabled = policy?.mode === 'disabled' && !unlimited;
  const cost = (o: ResourceOffer) => (unlimited ? 0 : o.price);
  const buy = async (o: ResourceOffer) => {
    setBusy(true);
    try {
      const r = await (await getApi()).buyResources(gameId, o.id);
      if (r.spent !== undefined && r.cap !== undefined) setSpent({ spent: r.spent, cap: r.cap });
      setDelivered(o.id);
      toast(
        r.unlimited
          ? t('shop.resources.doneUnlimited', { name: o.name })
          : t('shop.resources.done', { name: o.name, balance: formatInt(r.balance) }),
        'ok',
      );
      onDone();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      toast(
        code === 'cap_reached' || code === 'shop_disabled' || code === 'insufficient_premium'
          ? t(`shop.resources.errors.${code}`)
          : e instanceof Error && e.message
            ? e.message
            : t('shop.resources.errors.generic'),
        'error',
      );
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <Panel
      title={t('shop.resources.title')}
      meta={
        policy?.mode === 'limited'
          ? spent
            ? t('shop.resources.capUsed', { spent: spent.spent, cap: spent.cap })
            : t('shop.cap', { cap: policy.capPerPlayer ?? 0 })
          : undefined
      }
      accent={disabled ? undefined : 'cyan'}
    >
      <p className="hint">{t('shop.resources.help')}</p>
      {disabled ? (
        <p className="roffers__off">
          <Icon name="lock" size={13} /> {t('shop.resources.disabled')}
        </p>
      ) : null}
      {error ? (
        <EmptyState compact icon="shop" title={t('shop.resources.unavailable')} />
      ) : !offers ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="roffers" data-testid="resource-offers">
          {offers.map((o) => {
            const after = balance - cost(o);
            const short = !unlimited && after < 0;
            return (
              <div
                key={o.id}
                className={[
                  'roffer',
                  o.money > 0 ? 'roffer--money' : 'roffer--res',
                  delivered === o.id ? 'roffer--done' : '',
                ].join(' ')}
              >
                <div className="roffer__head">
                  <span className="roffer__name">{o.name}</span>
                </div>
                <OfferContent o={o} />
                <div className="roffer__foot">
                  <span className="roffer__price">
                    <Icon name="gem" size={13} /> {unlimited ? '0' : formatInt(o.price)}
                  </span>
                  {delivered === o.id ? (
                    <Badge tone="green" variant="solid">
                      {t('shop.resources.delivered')}
                    </Badge>
                  ) : (
                    <span className={short ? 'roffer__after rl-tone-red' : 'roffer__after'}>
                      {unlimited
                        ? t('shop.resources.free')
                        : t('shop.resources.after', { value: formatInt(after) })}
                    </span>
                  )}
                </div>
                <Button
                  block
                  size="sm"
                  disabled={disabled || short || busy}
                  onClick={() => setConfirm(o)}
                  data-testid={`buy-${o.id}`}
                >
                  {short ? t('shop.resources.short') : t('shop.resources.buy')}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <Dialog
        open={!!confirm}
        title={t('shop.resources.confirmTitle')}
        path={[t('sections.path.shop'), t('shop.resources.title')]}
        onClose={() => setConfirm(null)}
        closeLabel={t('app.cancel')}
        width={440}
        tone="cyan"
        footer={
          confirm ? (
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                {t('app.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void buy(confirm)}
                data-testid="confirm-buy"
              >
                {t('shop.resources.confirm', { price: formatInt(cost(confirm)) })}
              </Button>
            </>
          ) : null
        }
      >
        {confirm ? (
          <div className="rconfirm">
            <span className="roffer__name">{confirm.name}</span>
            <OfferContent o={confirm} />
            <dl className="rconfirm__kv">
              <dt>{t('shop.resources.price')}</dt>
              <dd>
                <Icon name="gem" size={12} /> {formatInt(cost(confirm))}
              </dd>
              <dt>{t('shop.balance')}</dt>
              <dd>{unlimited ? t('game.unlimited.value') : formatInt(balance)}</dd>
              <dt>{t('shop.resources.balanceAfter')}</dt>
              <dd className="rl-tone-cyan">
                {unlimited ? t('game.unlimited.value') : formatInt(balance - cost(confirm))}
              </dd>
            </dl>
            <p className="hint">{t('shop.resources.confirmHelp')}</p>
          </div>
        ) : null}
      </Dialog>
    </Panel>
  );
}
