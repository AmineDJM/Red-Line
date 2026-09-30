import { useTranslation } from 'react-i18next';
import type { InfoCredibility, NationId, SourceReliability } from '@redline/shared';
import { Badge, Flag } from '@redline/ui';
import { fmtDuration } from '../i18n/index.js';
import { nationName } from '../lib/game.js';
import { useGame } from '../store/game.js';

/** Drapeau + nom de nation (violet si c'est le joueur). */
export function NationTag({
  id,
  strong,
  size = 12,
}: {
  id: NationId;
  strong?: boolean;
  size?: number;
}) {
  const me = useGame((s) => s.me);
  const color = useGame((s) => s.view?.nations[id]?.color);
  return (
    <span className={strong ? 'nat nat--strong' : 'nat'}>
      <Flag nationId={id} size={size} color={color} />
      <span className="nat__name" style={id === me ? { color: '#b99bff' } : undefined}>
        {nationName(id)}
      </span>
    </span>
  );
}

/** Cotation OTAN d'un rapport (fiabilité A-F, crédibilité 1-6). */
export function Cotation({ r, c }: { r: SourceReliability; c: InfoCredibility }) {
  const { t } = useTranslation();
  const score = 'ABCDEF'.indexOf(r) + (c - 1);
  const tone = score <= 2 ? 'green' : score <= 5 ? 'amber' : 'red';
  return (
    <span
      className={`cot cot--${tone}`}
      title={t('intel.cotationTip', {
        r: t(`intel.reliability.${r}`),
        c: t(`intel.credibility.${c}`),
      })}
    >
      {r}
      {c}
    </span>
  );
}

export function isLowCotation(r: SourceReliability, c: InfoCredibility): boolean {
  return 'ABCDEF'.indexOf(r) >= 3 || c >= 4;
}

/** Âge relatif (« il y a 3 h 20 »). */
export function Ago({ from, now }: { from: number; now: number }) {
  const { t } = useTranslation();
  return (
    <span className="ago">{t('time.ago', { value: fmtDuration(Math.max(0, now - from)) })}</span>
  );
}

export function RelationBadge({ relation }: { relation: 'war' | 'peace' | 'ceasefire' | 'ally' }) {
  const { t } = useTranslation();
  const tone =
    relation === 'war'
      ? 'red'
      : relation === 'ally'
        ? 'green'
        : relation === 'ceasefire'
          ? 'amber'
          : 'neutral';
  return <Badge tone={tone}>{t(`diplomacy.relation.${relation}`)}</Badge>;
}
