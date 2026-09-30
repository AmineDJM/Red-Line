import { useTranslation } from 'react-i18next';
import { Button, HexIcon } from '@redline/ui';
import { navigate } from '../router.js';

export function LoadingScreen({ text }: { text?: string }) {
  const { t } = useTranslation();
  return (
    <div className="screen screen--center" role="status">
      <div className="loading">
        <HexIcon pictogram="city" color="var(--rl-violet)" size={56} className="loading__hex" />
        <p>{text ?? t('app.loading')}</p>
      </div>
    </div>
  );
}

export function ErrorScreen({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="screen screen--center" role="alert">
      <div className="loading">
        <HexIcon pictogram="unknown" color="var(--rl-red)" size={56} />
        <p>{t('app.error')}</p>
        {message ? <p className="muted small">{message}</p> : null}
        <div className="row">
          <Button onClick={() => window.location.reload()}>{t('app.retry')}</Button>
          <Button variant="ghost" onClick={() => navigate('/')}>
            {t('app.back')}
          </Button>
        </div>
      </div>
    </div>
  );
}
