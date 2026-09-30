import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOLUTION_TYPES, type NationId, type Order, type ResolutionType, type ResolutionView } from '@redline/shared';
import {
  Badge,
  Button,
  Countdown,
  EmptyState,
  Field,
  Flag,
  Icon,
  Panel,
  Select,
  Window,
} from '@redline/ui';
import { NationTag } from '../components/Common.js';
import { nationName, provinceName } from '../lib/game.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res) toast(res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`), 'error');
    return !!res?.ok;
  };
}

function targetText(r: ResolutionView, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (r.target.nationId) return nationName(r.target.nationId);
  if (r.target.provinceIds?.length) return r.target.provinceIds.map((p) => provinceName(p)).join(', ');
  if (r.target.at) return t('council.zone', { km: r.target.radiusKm ?? 0 });
  return '—';
}

function Resolution({ r, voters, permanent }: { r: ResolutionView; voters: NationId[]; permanent: NationId[] }) {
  const { t } = useTranslation();
  const me = useGame((s) => s.me);
  const send = useSend();
  const tally = { yes: 0, no: 0, abstain: 0 };
  for (const v of Object.values(r.votes)) tally[v]++;
  const pending = voters.length - tally.yes - tally.no - tally.abstain;
  const veto = permanent.filter((p) => r.votes[p] === 'no');
  const mine = me ? r.votes[me] : undefined;
  const canVote = !!me && voters.includes(me) && (r.status === 'voting' || r.status === 'proposed');
  const tone = r.status === 'passed' ? 'green' : r.status === 'rejected' || r.status === 'vetoed' ? 'red' : 'amber';
  return (
    <article className="reso">
      <header className="reso__head">
        <Badge tone="cyan" variant="outline">
          {t(`council.types.${r.type}`)}
        </Badge>
        <span className="reso__target">{targetText(r, t)}</span>
        <span className="grow" />
        {veto.length && r.status === 'voting' ? <Badge tone="red">{t('council.vetoThreat', { nations: veto.map((v) => nationName(v)).join(', ') })}</Badge> : null}
        <Badge tone={tone}>{t(`council.status.${r.status}`)}</Badge>
      </header>
      <blockquote className="reso__text">
        <span className="reso__num">S/RES/{r.id.replace(/\D/g, '').padStart(4, '0')}</span>
        {r.text}
      </blockquote>
      <div className="reso__meta">
        <span>
          {t('council.proposer')} <NationTag id={r.proposer} size={9} />
        </span>
        <span>{t('council.duration', { days: r.durationDays })}</span>
      </div>
      <div className="reso__tally">
        <div className="reso__bar" aria-hidden>
          <span className="reso__yes" style={{ flex: tally.yes }} />
          <span className="reso__abs" style={{ flex: tally.abstain }} />
          <span className="reso__no" style={{ flex: tally.no }} />
          <span className="reso__pend" style={{ flex: pending }} />
        </div>
        <div className="reso__counts">
          <span className="rl-tone-green">{t('council.votes.yes')} {tally.yes}</span>
          <span className="muted">{t('council.votes.abstain')} {tally.abstain}</span>
          <span className="rl-tone-red">{t('council.votes.no')} {tally.no}</span>
          <span className="muted">{t('council.waiting', { count: pending })}</span>
        </div>
      </div>
      <ul className="reso__voters">
        {voters.map((v) => (
          <li key={v} className={`voter voter--${r.votes[v] ?? 'none'}`} title={`${nationName(v)} : ${t(`council.votes.${r.votes[v] ?? 'none'}`)}`}>
            <Flag nationId={v} size={11} />
            <span>{v.toUpperCase()}</span>
            {permanent.includes(v) ? <i className="voter__veto">V</i> : null}
          </li>
        ))}
      </ul>
      {canVote ? (
        <div className="reso__actions">
          <span className="dept__label">{t('council.yourVote')}</span>
          {(['yes', 'abstain', 'no'] as const).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={mine === v ? (v === 'yes' ? 'success' : v === 'no' ? 'danger' : 'primary') : 'subtle'}
              pressed={mine === v}
              onClick={() => void send({ kind: 'voteResolution', resolutionId: r.id, vote: v }, t('council.voted'))}
              data-testid={`vote-${r.id}-${v}`}
            >
              {t(`council.votes.${v}`)}
            </Button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function Propose({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const nations = useWorld((s) => s.nations);
  const me = useGame((s) => s.me);
  const send = useSend();
  const [type, setType] = useState<ResolutionType>('ceasefire');
  const [target, setTarget] = useState<NationId>('');
  const [text, setText] = useState('');
  const list = Object.values(nations).filter((n) => n.id !== me).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return (
    <Panel title={t('council.propose')} accent="cyan">
      <div className="stack">
        <div className="cols2">
          <Field label={t('council.type')}>
            <Select value={type} onChange={(v) => setType(v as ResolutionType)} options={RESOLUTION_TYPES.map((x) => ({ value: x, label: t(`council.types.${x}`) }))} />
          </Field>
          <Field label={t('council.target')}>
            <Select value={target} onChange={setTarget} options={[{ value: '', label: t('council.pickTarget') }, ...list.map((n) => ({ value: n.id, label: n.name }))]} />
          </Field>
        </div>
        <Field label={t('council.text')} hint={t('council.textHint')}>
          <textarea className="rl-textarea" rows={4} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('council.textPlaceholder')} />
        </Field>
        <div className="row">
          <span className="grow" />
          <Button variant="ghost" onClick={onDone}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!target || text.trim().length < 10}
            onClick={() => void send({ kind: 'proposeResolution', type, target: { nationId: target }, text: text.trim() }, t('council.proposed')).then((ok) => ok && onDone())}
          >
            {t('council.submit')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** Conseil de sécurité : membres, ordre du jour, textes des résolutions, votes en direct, résultats. */
export function CouncilWindow({ frame }: WindowContentProps) {
  const { t } = useTranslation();
  const council = useGame((s) => s.view?.council);
  const now = useGameTime(1000);
  const [proposing, setProposing] = useState(false);
  if (!council)
    return (
      <Window {...frame}>
        <EmptyState icon="council" title={t('council.unavailable')} />
      </Window>
    );
  const voters = [...council.members, ...council.rotatingSeats];
  const s = council.session;
  return (
    <Window
      {...frame}
      path={[t('sections.path.council'), s ? t(`council.phase.${s.phase}`) : t('council.recess')]}
      toolbar={
        <div className="council__bar">
          <div className="council__seats">
            <span className="dept__label">{t('council.permanent')}</span>
            {council.members.map((m) => (
              <NationTag key={m} id={m} size={10} />
            ))}
          </div>
          <div className="council__seats">
            <span className="dept__label">{t('council.rotating')}</span>
            {council.rotatingSeats.map((m) => (
              <NationTag key={m} id={m} size={10} />
            ))}
          </div>
          <span className="grow" />
          <Badge tone="neutral">{t(`council.majority.${council.rule.majority}`)}</Badge>
          {council.rule.veto ? <Badge tone="amber" variant="outline">{t('council.veto')}</Badge> : null}
        </div>
      }
    >
      <div className="vstack">
        <div className="council__session">
          <Icon name="gavel" size={18} />
          {s ? (
            <>
              <div>
                <b>{t(`council.phase.${s.phase}`)}</b>
                <span className="muted small">{t('council.agenda', { count: s.resolutions.length })}</span>
              </div>
              <span className="grow" />
              <span className="dept__label">{t('council.closesIn')}</span>
              <Countdown ms={s.votingEndsAt - now} total={s.votingEndsAt - s.opensAt} urgentBelowMs={3_600_000} dayUnit={t('time.dayUnit')} />
            </>
          ) : (
            <>
              <b>{t('council.recess')}</b>
              <span className="grow" />
              <span className="dept__label">{t('council.nextSession')}</span>
              <Countdown ms={council.nextSessionAt - now} dayUnit={t('time.dayUnit')} />
            </>
          )}
          {!proposing ? (
            <Button size="sm" variant="primary" icon={<Icon name="plus" size={12} />} onClick={() => setProposing(true)}>
              {t('council.propose')}
            </Button>
          ) : null}
        </div>
        {proposing ? <Propose onDone={() => setProposing(false)} /> : null}
        {s?.resolutions.length ? (
          s.resolutions.map((r) => <Resolution key={r.id} r={r} voters={voters} permanent={council.rule.veto ? council.members : []} />)
        ) : (
          <EmptyState compact icon="vote" title={t('council.noResolutions')} />
        )}
        {council.inForce.length ? (
          <Panel title={t('council.inForce')} meta={String(council.inForce.length)}>
            <ul className="plainlist">
              {council.inForce.map((r) => (
                <li key={r.id} className="inforce">
                  <Badge tone="green">{t(`council.types.${r.type}`)}</Badge>
                  <span>{targetText(r, t)}</span>
                  <span className="grow" />
                  <span className="muted small">{t('council.until')}</span>
                  <Countdown ms={r.until - now} dayUnit={t('time.dayUnit')} />
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    </Window>
  );
}
