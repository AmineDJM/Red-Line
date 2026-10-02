import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LegalDocRef } from '@redline/shared';
import { Button, Checkbox, Dialog } from '@redline/ui';
import { getApi } from '../api/index.js';

/**
 * Consentement avant chaque paiement (CGV + art. L221-28 13° du Code de la consommation) : acceptation
 * des CGV et demande expresse de fourniture immédiate avec renonciation au droit de rétractation. Les
 * versions en vigueur des CGV et du document « Rétractation » sont enregistrées (POST /api/legal/accept)
 * avant l'ouverture du paiement Stripe ; sans les deux cases, le bouton de paiement reste inactif.
 */
export function PurchaseConsent({
  label,
  price,
  onConfirm,
  onClose,
}: {
  label: string;
  price: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [cgv, setCgv] = useState(false);
  const [waiver, setWaiver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const docLink = (id: 'cgv' | 'withdrawal', text: string) => (
    <a href={`/legal/${id}`} target="_blank" rel="noopener">
      {text}
    </a>
  );
  const confirm = async () => {
    setBusy(true);
    setError(false);
    try {
      const api = await getApi();
      const refs: LegalDocRef[] = (
        await Promise.all([api.legal('cgv'), api.legal('withdrawal')])
      ).map((d) => ({ id: d.id, version: d.version }));
      await api.acceptLegal(refs);
      await onConfirm();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={t('shop.consent.title')}
      path={[t('shop.path'), 'paiement']}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!cgv || !waiver || busy}
            onClick={() => void confirm()}
            data-testid="purchase-confirm"
          >
            {t('shop.consent.pay', { price })}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          {t('shop.consent.summary', { label })} <b>{price}</b>
        </p>
        <Checkbox
          checked={cgv}
          onChange={setCgv}
          label={
            <>
              {t('shop.consent.cgv')} {docLink('cgv', t('legal.docs.cgv'))}
            </>
          }
        />
        <Checkbox
          checked={waiver}
          onChange={setWaiver}
          label={
            <>
              {t('shop.consent.waiver')} {docLink('withdrawal', t('legal.docs.withdrawal'))}
            </>
          }
        />
        {error ? <p className="error-text">{t('shop.consent.error')}</p> : null}
      </div>
    </Dialog>
  );
}
