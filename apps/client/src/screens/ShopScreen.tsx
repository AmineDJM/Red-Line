import { useTranslation } from 'react-i18next';
import { Page } from '../components/Page.js';
import { ShopContent } from '../components/ShopContent.js';

export function ShopScreen() {
  const { t } = useTranslation();
  return (
    <Page path={[t('shop.path')]} title={t('shop.title')} subtitle={t('shop.subtitle')}>
      <ShopContent />
    </Page>
  );
}
