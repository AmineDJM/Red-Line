import { useTranslation } from 'react-i18next';
import { Button, Icon, Prompt } from '@redline/ui';
import { navigate } from '../router.js';

export function LoadingScreen({ text }: { text?: string }) {
  const { t } = useTranslation();
  return (
    <div className="screen screen--center" role="status">
      <div className="loading">
        <Prompt path={[t('app.loadingPath')]} />
        <div className="loading__bar" aria-hidden>
          <span />
        </div>
        <p>{text ?? t('app.loading')}</p>
      </div>
    </div>
  );
}

export function ErrorScreen({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="screen screen--center" role="alert">
      <div className="loading loading--error">
        <Prompt path={[t('app.errorPath')]} caret={false} />
        <p className="loading__err">
          <Icon name="warning" size={16} /> {t('app.error')}
        </p>
        {message ? <pre className="loading__msg">{message}</pre> : null}
        <div className="row">
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('app.retry')}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/')}>
            {t('app.back')}
          </Button>
        </div>
      </div>
    </div>
  );
}
