import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NewsCategory } from '@redline/shared';
import { EmptyState, Flag, Icon, Window, type IconName } from '@redline/ui';
import { fmtClock } from '../i18n/index.js';
import { nationName } from '../lib/game.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { Ago } from '../components/Common.js';

const CAT_ICON: Record<NewsCategory, IconName> = {
  strike: 'missile',
  war: 'battle',
  peace: 'handshake',
  council: 'council',
  leak: 'document',
  revolt: 'flag',
  coup: 'warning',
  alliance: 'users',
  economy: 'economy',
  nuclear: 'nuclear',
  capture: 'flag',
  refugees: 'users',
  event: 'news',
};
const HOT: NewsCategory[] = ['war', 'strike', 'nuclear', 'coup'];

/** Actualité mondiale : fil de dépêches (agence de presse), filtres par catégorie. */
export function NewsWindow({ frame }: WindowContentProps) {
  const { t } = useTranslation();
  const news = useGame((s) => s.view?.news ?? []);
  const focusOn = useUi((s) => s.focusOn);
  const now = useGameTime(10_000);
  const [cat, setCat] = useState<NewsCategory | 'all'>('all');
  const cats = [...new Set(news.map((n) => n.category))];
  const list = news.filter((n) => cat === 'all' || n.category === cat).sort((a, b) => b.time - a.time);
  return (
    <Window
      {...frame}
      path={[t('sections.path.news')]}
      toolbar={
        <div className="newsfilters" role="radiogroup" aria-label={t('news.filter')}>
          <button type="button" role="radio" aria-checked={cat === 'all'} className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>
            {t('app.all')} <b>{news.length}</b>
          </button>
          {cats.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={cat === c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
              <Icon name={CAT_ICON[c]} size={12} />
              {t(`news.cats.${c}`)}
            </button>
          ))}
        </div>
      }
    >
      {!list.length ? (
        <EmptyState icon="news" title={t('news.empty')} />
      ) : (
        <ol className="wire">
          {list.map((n, i) => {
            const c = fmtClock(n.time);
            const hot = HOT.includes(n.category);
            return (
              <li key={n.id} className={['dispatch', hot ? 'dispatch--hot' : '', i === 0 && cat === 'all' ? 'dispatch--top' : ''].join(' ')}>
                <div className="dispatch__time">
                  <span>{c.day}</span>
                  <b>{c.time}</b>
                </div>
                <div className="dispatch__body">
                  <div className="dispatch__meta">
                    <span className={hot ? 'dispatch__cat dispatch__cat--hot' : 'dispatch__cat'}>
                      <Icon name={CAT_ICON[n.category]} size={11} />
                      {t(`news.cats.${n.category}`)}
                    </span>
                    {i === 0 && cat === 'all' ? <span className="dispatch__urgent">{t('news.urgent')}</span> : null}
                    <Ago from={n.time} now={now} />
                  </div>
                  <h3 className="dispatch__headline">{n.headline}</h3>
                  <p className="dispatch__text">
                    <span className="dispatch__source">{t('news.source')} — </span>
                    {n.body}
                  </p>
                  {n.nations.length || n.at ? (
                    <div className="dispatch__foot">
                      {n.nations.map((id) => (
                        <span key={id} className="nat">
                          <Flag nationId={id} size={10} />
                          <span className="nat__name">{nationName(id)}</span>
                        </span>
                      ))}
                      {n.at ? (
                        <button type="button" className="dispatch__locate" onClick={() => focusOn(n.at!, 5.5)}>
                          <Icon name="mapPin" size={12} /> {t('news.locate')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Window>
  );
}
