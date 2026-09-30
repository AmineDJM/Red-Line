import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Icon, Prompt } from '@redline/ui';
import { IS_MOCK } from '../config.js';
import { navigate } from '../router.js';

/** Page hors partie (lobby, boutique, classements…) : barre d'invite, titre, contenu centré. */
export function Page({
  path,
  title,
  subtitle,
  actions,
  children,
  back = '/',
  wide,
}: {
  path: string[];
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  back?: string | null;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="page">
      <header className="page__bar">
        <span className="rl-win__lights" aria-hidden>
          <i />
        </span>
        <Prompt path={path} />
        <span className="grow" />
        {IS_MOCK ? (
          <Badge tone="amber" variant="outline">
            {t('app.mockBadge')}
          </Badge>
        ) : null}
        {back !== null ? (
          <Button variant="ghost" size="sm" icon={<Icon name="chevronLeft" size={13} />} onClick={() => navigate(back)}>
            {t('app.back')}
          </Button>
        ) : null}
      </header>
      <main className={wide ? 'page__main page__main--wide' : 'page__main'}>
        <div className="page__head">
          <div>
            <h1 className="page__title">{title}</h1>
            {subtitle ? <p className="page__sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="page__actions">{actions}</div> : null}
        </div>
        {children}
      </main>
    </div>
  );
}
