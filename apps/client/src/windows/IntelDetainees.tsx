import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentView,
  DetaineeOption,
  DetaineeView,
  NationId,
  Order,
  SwapItemView,
  SwapView,
} from '@redline/shared';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Segmented,
  Select,
  formatMoney,
  formatNumber,
  formatPct,
  type Tone,
} from '@redline/ui';
import { NationTag } from '../components/Common.js';
import { fmtDuration } from '../i18n/index.js';
import { nationForms, nationName } from '../lib/game.js';
import {
  agentValueOf,
  agentsAbroad,
  effectLines,
  groupOptions,
  liveDetainees,
  riskGrade,
  stillHeld,
  type FxLine,
} from '../lib/detainees.js';
import { orderError } from '../lib/loc.js';
import { useGameTime } from '../shell/helpers.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

/**
 * Onglet « Détenus » de la console de renseignement : nos prisonniers (décision à prendre avant
 * l'échéance, conséquences chiffrées affichées avant de confirmer), nos agents détenus à l'étranger
 * (sort, négociation), négociations en cours (échanges, libérations) et relations bilatérales.
 */

function useSend() {
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string): Promise<boolean> => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res) toast(orderError(res), 'error');
    return !!res?.ok;
  };
}

const STATUS_TONE: Record<DetaineeView['status'], Tone> = {
  pending: 'amber',
  held: 'cyan',
  jailed: 'red',
  expelled: 'neutral',
  returned: 'neutral',
  executed: 'red',
  released: 'green',
  exchanged: 'green',
  served: 'neutral',
  turned: 'violet',
};

const FATE_TONE: Record<NonNullable<AgentView['detention']>['fate'], Tone> = {
  held: 'amber',
  interrogation: 'amber',
  jailed: 'red',
  expelled: 'neutral',
  returned: 'neutral',
  executed: 'red',
  released: 'green',
  exchanged: 'green',
  served: 'green',
};

/** Libellé d'une décision : « expulser » (diplomate) ou « renvoyer » (sans immunité). */
function actionLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  o: Pick<DetaineeOption, 'action' | 'days'>,
  d: Pick<DetaineeView, 'kind'>,
): string {
  if (o.action === 'expel' && d.kind !== 'diplomat') return t('intel.dz.actions.return');
  if (o.action === 'jail' && o.days)
    return `${t('intel.dz.actions.jail')} · ${t('intel.dz.days', { n: o.days })}`;
  return t(`intel.dz.actions.${o.action}`);
}

/** Lignes de conséquences (relations, réputation, stabilité, représailles…). */
export function Consequences({ lines, nation }: { lines: FxLine[]; nation: NationId }) {
  const { t } = useTranslation();
  if (!lines.length) return <p className="hint">{t('intel.dz.fx.none')}</p>;
  return (
    <dl className="dz-fx" data-testid="dz-consequences">
      {lines.map((l) => {
        const label =
          l.key === 'relations'
            ? t('intel.dz.fx.relations', nationForms(nation))
            : t(`intel.dz.fx.${l.key}`);
        const value =
          l.format === 'signed'
            ? `${l.value > 0 ? '+' : '−'}${formatNumber(Math.abs(l.value), Math.abs(l.value) % 1 ? 1 : 0)}`
            : l.format === 'pct'
              ? l.key === 'retaliation'
                ? `${t(`intel.dz.risk.${riskGrade(l.value)}`)} · ${formatPct(l.value)}`
                : l.key === 'serviceHit' && l.days
                  ? t('intel.dz.fx.serviceDays', { pct: `−${formatPct(l.value)}`, days: l.days })
                  : formatPct(l.value)
              : l.format === 'hours'
                ? fmtDuration(l.value * 3_600_000)
                : l.format === 'perDay'
                  ? t('intel.dz.fx.perDay', { value: `−${formatNumber(Math.abs(l.value), 1)}` })
                  : '!';
        return (
          <div key={l.key} className={`dz-fx__row dz-fx__row--${l.tone}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Dialogue de décision : choix, durée de peine, conséquences prévues, confirmation. */
function DecisionDialog({
  d,
  initial,
  onClose,
}: {
  d: DetaineeView;
  initial: DetaineeOption['action'];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const send = useSend();
  const groups = groupOptions(d.options ?? []);
  const [action, setAction] = useState<DetaineeOption['action']>(initial);
  const group = groups.find((g) => g.action === action) ?? groups[0];
  const [days, setDays] = useState<number>(group?.options[1]?.days ?? group?.options[0]?.days ?? 0);
  const opt = group?.options.find((o) => (o.days ?? 0) === days) ?? group?.options[0] ?? undefined;
  if (!group || !opt) return null;
  const lines = effectLines(opt.effects);
  return (
    <Dialog
      open
      title={t('intel.dz.confirmTitle', { ref: d.ref })}
      path={[t('sections.path.intel'), t('intel.tabs.detainees'), d.ref]}
      onClose={onClose}
      closeLabel={t('app.close')}
      tone={action === 'execute' ? 'red' : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant={action === 'execute' ? 'danger' : 'primary'}
            disabled={!opt.allowed}
            icon={<Icon name="gavel" size={12} />}
            onClick={() => {
              void send(
                {
                  kind: 'detainee',
                  agentId: d.id,
                  action,
                  ...(action === 'jail' && opt.days ? { days: opt.days } : {}),
                },
                t('intel.dz.applied', { action: actionLabel(t, opt, d) }),
              );
              onClose();
            }}
            data-testid="dz-confirm"
          >
            {t('intel.dz.confirm')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="dz-who">
          <NationTag id={d.nationId} strong />
          <Badge tone="cyan" variant="outline">
            {t(`intel.dz.kinds.${d.kind}`)}
          </Badge>
          <Badge tone={STATUS_TONE[d.status]}>{t(`intel.dz.status.${d.status}`)}</Badge>
        </div>
        <Field label={t('intel.dz.decision')}>
          <Select
            value={action}
            onChange={(v) => {
              setAction(v as DetaineeOption['action']);
              const g = groups.find((x) => x.action === v);
              setDays(g?.options[1]?.days ?? g?.options[0]?.days ?? 0);
            }}
            options={groups.map((g) => ({
              value: g.action,
              label: `${actionLabel(t, { action: g.action }, d)}${g.options.some((o) => o.allowed) ? '' : ` — ${t('intel.dz.unavailable')}`}`,
            }))}
            data-testid="dz-action"
          />
        </Field>
        <p className="hint">
          {t(`intel.dz.help.${action === 'expel' && d.kind !== 'diplomat' ? 'return' : action}`)}
        </p>
        {group.options.length > 1 ? (
          <Field label={t('intel.dz.sentence')}>
            <Segmented
              label={t('intel.dz.sentence')}
              size="sm"
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              options={group.options.map((o) => ({
                value: String(o.days ?? 0),
                label: t('intel.dz.days', { n: o.days ?? 0 }),
              }))}
            />
          </Field>
        ) : null}
        {!opt.allowed && opt.reason ? (
          <p className="dz-blocked" role="alert">
            <Icon name="lock" size={12} /> {t(`intel.dz.blocked.${opt.reason}`)}
          </p>
        ) : null}
        <span className="dept__label">{t('intel.dz.consequences')}</span>
        <Consequences lines={lines} nation={d.nationId} />
      </div>
    </Dialog>
  );
}

/** Ligne d'un détenu : identité, situation, échéance, décisions rapides. */
function DetaineeRow({
  d,
  now,
  onDecide,
  onNegotiate,
}: {
  d: DetaineeView;
  now: number;
  onDecide: (d: DetaineeView, action: DetaineeOption['action']) => void;
  onNegotiate: (nation: NationId, give?: string) => void;
}) {
  const { t } = useTranslation();
  const live = !!d.options;
  const groups = groupOptions(d.options ?? []);
  return (
    <li className={`dz-row dz-row--${d.status}`} data-testid={`detainee-${d.id}`}>
      <div className="dz-row__head">
        <span className="dz-row__ref">{d.ref}</span>
        <NationTag id={d.nationId} size={10} />
        <span className="dz-row__kind">{t(`intel.dz.kinds.${d.kind}`)}</span>
        <Badge tone={STATUS_TONE[d.status]} variant={d.status === 'pending' ? 'solid' : undefined}>
          {t(`intel.dz.status.${d.status}`)}
        </Badge>
      </div>
      <div className="dz-row__meta">
        {d.status === 'pending' && d.decideBy ? (
          <span className="dz-due">
            <Icon name="clock" size={11} />{' '}
            {t('intel.dz.decideIn', { left: fmtDuration(Math.max(0, d.decideBy - now)) })}
          </span>
        ) : null}
        {d.status === 'jailed' && d.until ? (
          <span>
            {t('intel.dz.sentenceLeft', {
              days: d.days ?? 0,
              left: fmtDuration(Math.max(0, d.until - now)),
            })}
          </span>
        ) : null}
        {d.interrogating ? (
          <span className="rl-tone-amber">
            {t('intel.dz.interrogating', { left: fmtDuration(Math.max(0, d.interrogating - now)) })}
          </span>
        ) : null}
        {d.revealed ? (
          <span>{t('intel.dz.revealed', { agents: d.revealed.agents, ops: d.revealed.ops })}</span>
        ) : null}
        {d.access ? <span>{t(`intel.accessLevels.${d.access}`)}</span> : null}
        {d.op ? <span>{t('intel.dz.caughtDuring', { op: t(`intel.ops.${d.op}`) })}</span> : null}
        <span title={t('intel.dz.valueHint')}>
          {t('intel.dz.value')} <b>{formatNumber(d.value, 1)}</b>
        </span>
      </div>
      {live ? (
        <div className="dz-row__acts">
          {groups.map((g) => {
            const o = g.options[Math.min(1, g.options.length - 1)]!;
            const r = o.effects.relations;
            return (
              <button
                key={g.action}
                type="button"
                className={`dz-act dz-act--${g.action}${g.options.some((x) => x.allowed) ? '' : ' dz-act--off'}`}
                onClick={() => onDecide(d, g.action)}
                title={
                  o.reason ? t(`intel.dz.blocked.${o.reason}`) : t(`intel.dz.help.${g.action}`)
                }
                data-testid={`dz-${g.action}-${d.id}`}
              >
                <span className="dz-act__name">
                  {g.action === 'expel' && d.kind !== 'diplomat'
                    ? t('intel.dz.actions.return')
                    : t(`intel.dz.actions.${g.action}`)}
                </span>
                {r ? (
                  <span className={r < 0 ? 'rl-tone-red' : 'rl-tone-green'}>
                    {r > 0 ? '+' : '−'}
                    {formatNumber(Math.abs(r), Math.abs(r) % 1 ? 1 : 0)}
                  </span>
                ) : o.effects.chance !== undefined ? (
                  <span className="rl-tone-cyan">{formatPct(o.effects.chance)}</span>
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            className="dz-act dz-act--swap"
            onClick={() => onNegotiate(d.nationId, d.id)}
          >
            <span className="dz-act__name">{t('intel.dz.exchange')}</span>
            <Icon name="handshake" size={11} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** Nos agents détenus à l'étranger : sort connu, négociation. */
function AbroadRow({
  a,
  now,
  onNegotiate,
}: {
  a: AgentView;
  now: number;
  onNegotiate: (nation: NationId, get?: string) => void;
}) {
  const { t } = useTranslation();
  const dt = a.detention!;
  return (
    <li className={`dz-row dz-row--abroad`} data-testid={`abroad-${a.id}`}>
      <div className="dz-row__head">
        <span className="dz-row__ref">{a.codename}</span>
        <NationTag id={a.nationId} size={10} />
        <span className="dz-row__kind">
          {t(
            `intel.dz.kinds.${a.kind === 'source' ? 'source' : a.cover === 'nonofficial' ? 'illegal' : 'diplomat'}`,
          )}
        </span>
        <Badge tone={FATE_TONE[dt.fate]}>{t(`intel.dz.fate.${dt.fate}`)}</Badge>
      </div>
      <div className="dz-row__meta">
        {dt.fate === 'jailed' && dt.until ? (
          <span>
            {t('intel.dz.sentenceLeft', {
              days: dt.days ?? 0,
              left: fmtDuration(Math.max(0, dt.until - now)),
            })}
          </span>
        ) : (
          <span>{t('time.ago', { value: fmtDuration(Math.max(0, now - dt.since)) })}</span>
        )}
      </div>
      {stillHeld(a) ? (
        <div className="dz-row__acts">
          <button
            type="button"
            className="dz-act dz-act--swap"
            onClick={() => onNegotiate(a.nationId, a.id)}
            data-testid={`negotiate-${a.id}`}
          >
            <span className="dz-act__name">{t('intel.dz.negotiate')}</span>
            <Icon name="handshake" size={11} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ItemList({ items }: { items: SwapItemView[] }) {
  const { t } = useTranslation();
  if (!items.length) return <span className="muted">—</span>;
  return (
    <span className="dz-items">
      {items.map((x) => (
        <span key={x.id} className="dz-item">
          <b>{x.label}</b> <span className="muted">{t(`intel.dz.kindsShort.${x.kind}`)}</span>
        </span>
      ))}
    </span>
  );
}

/** Une proposition : qui libère quoi, argent, accord, échéance ; accepter / refuser. */
function SwapCard({ s, me, now }: { s: SwapView; me: NationId; now: number }) {
  const { t } = useTranslation();
  const send = useSend();
  const incoming = s.to === me;
  const other = incoming ? s.from : s.to;
  // Vu de nous : ce que nous libérons, ce que nous obtenons.
  const weRelease = incoming ? s.get : s.give;
  const weGet = incoming ? s.give : s.get;
  const weReceive = incoming ? s.money : -s.money;
  return (
    <article className={`dz-swap dz-swap--${s.status}`} data-testid={`swap-${s.id}`}>
      <header className="dz-swap__head">
        <Badge tone={incoming ? 'amber' : 'cyan'} variant="outline">
          {incoming ? t('intel.dz.incoming') : t('intel.dz.outgoing')}
        </Badge>
        {s.counter ? <Badge tone="violet">{t('intel.dz.counter')}</Badge> : null}
        <NationTag id={other} size={10} />
        <Badge tone={s.status === 'accepted' ? 'green' : s.status === 'open' ? 'cyan' : 'neutral'}>
          {t(`intel.dz.swapStatus.${s.status}`)}
        </Badge>
        {s.status === 'open' ? (
          <span className="muted">
            {t('intel.dz.expires', { left: fmtDuration(Math.max(0, s.expiresAt - now)) })}
          </span>
        ) : null}
      </header>
      <dl className="dz-swap__terms">
        <div>
          <dt>{t('intel.dz.weRelease')}</dt>
          <dd>
            <ItemList items={weRelease} />
          </dd>
        </div>
        <div>
          <dt>{t('intel.dz.weObtain')}</dt>
          <dd>
            <ItemList items={weGet} />
          </dd>
        </div>
        {s.money ? (
          <div>
            <dt>{t('intel.dz.money')}</dt>
            <dd className={weReceive > 0 ? 'rl-tone-green' : 'rl-tone-red'}>
              {weReceive > 0
                ? t('intel.dz.theyPay', { amount: formatMoney(weReceive) })
                : t('intel.dz.wePay', { amount: formatMoney(-weReceive) })}
            </dd>
          </div>
        ) : null}
        {s.accordDays ? (
          <div>
            <dt>{t('intel.dz.accord')}</dt>
            <dd>{t('intel.dz.days', { n: s.accordDays })}</dd>
          </div>
        ) : null}
        {s.liftSanctions ? (
          <div>
            <dt>{t('intel.dz.sanctions')}</dt>
            <dd>{t('intel.dz.sanctionsLifted', nationForms(s.from))}</dd>
          </div>
        ) : null}
      </dl>
      {incoming && s.status === 'open' ? (
        <footer className="dz-swap__acts">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void send(
                { kind: 'answerSwap', swapId: s.id, accept: false },
                t('intel.dz.refusedOk'),
              )
            }
          >
            {t('intel.dz.refuse')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Icon name="handshake" size={12} />}
            onClick={() =>
              void send(
                { kind: 'answerSwap', swapId: s.id, accept: true },
                t('intel.dz.acceptedOk'),
              )
            }
            data-testid={`swap-accept-${s.id}`}
          >
            {t('intel.dz.accept')}
          </Button>
        </footer>
      ) : null}
    </article>
  );
}

const AMOUNTS = [0, 5e6, 10e6, 25e6, 50e6, 100e6, 250e6, 500e6];
const ACCORDS = [0, 30, 90, 180];

/** Dialogue de négociation : agents libérés de part et d'autre, argent, accord, sanctions. */
export function SwapDialog({
  nation: initialNation,
  give: initialGive,
  get: initialGet,
  onClose,
}: {
  nation: NationId;
  give?: string;
  get?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const balance = useWorld((s) => s.balance);
  const send = useSend();
  const ours = liveDetainees(intel);
  const abroad = agentsAbroad(intel).filter(stillHeld);
  const nations = useMemo(
    () =>
      [...new Set([...ours.map((d) => d.nationId), ...abroad.map((a) => a.nationId)])].sort(
        (a, b) => nationName(a).localeCompare(nationName(b)),
      ),
    [ours, abroad],
  );
  const [nation, setNation] = useState<NationId>(initialNation);
  const [give, setGive] = useState<string[]>(initialGive ? [initialGive] : []);
  const [get, setGet] = useState<string[]>(initialGet ? [initialGet] : []);
  const [money, setMoney] = useState<'none' | 'pay' | 'ask'>('none');
  const [amount, setAmount] = useState<number>(25e6);
  const [accord, setAccord] = useState<number>(0);
  const [lift, setLift] = useState(false);
  const theirs = ours.filter((d) => d.nationId === nation);
  const mine = abroad.filter((a) => a.nationId === nation);
  const sponsored = (view?.council?.inForce ?? []).some(
    (r) =>
      r.proposer === me &&
      r.target.nationId === nation &&
      (r.type === 'economic_sanctions' || r.type === 'arms_embargo'),
  );
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) =>
    set(on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id));
  const giveIds = give.filter((id) => theirs.some((d) => d.id === id));
  const getIds = get.filter((id) => mine.some((a) => a.id === id));
  const dz = balance?.intel?.detainees;
  const vGive = theirs.filter((d) => giveIds.includes(d.id)).reduce((s, d) => s + d.value, 0);
  const vGet = mine
    .filter((a) => getIds.includes(a.id))
    .reduce((s, a) => s + agentValueOf(a, dz?.value, dz?.accessValue), 0);
  const signed = money === 'pay' ? amount : money === 'ask' ? -amount : 0;
  const tie = intel?.ties?.find((x) => x.nationId === nation);
  const ready = giveIds.length + getIds.length > 0;
  return (
    <Dialog
      open
      title={t('intel.dz.swapTitle', nationForms(nation))}
      path={[t('sections.path.intel'), t('intel.tabs.detainees'), t('intel.dz.negotiations')]}
      onClose={onClose}
      closeLabel={t('app.close')}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            icon={<Icon name="send" size={12} />}
            onClick={() => {
              void send(
                {
                  kind: 'proposeSwap',
                  nationId: nation,
                  give: giveIds,
                  get: getIds,
                  ...(signed ? { money: signed } : {}),
                  ...(accord ? { accordDays: accord } : {}),
                  ...(lift && sponsored ? { liftSanctions: true } : {}),
                },
                t('intel.dz.sent'),
              );
              onClose();
            }}
            data-testid="swap-send"
          >
            {t('intel.dz.send')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('intel.dz.partner')}>
          <Select
            value={nation}
            onChange={(v) => {
              setNation(v);
              setGive([]);
              setGet([]);
            }}
            options={(nations.includes(nation) ? nations : [nation, ...nations]).map((n) => ({
              value: n,
              label: nationName(n),
            }))}
          />
        </Field>
        {tie ? (
          <p className="dz-tie">
            {t('intel.dz.relationsNow', { value: formatNumber(tie.score, 0) })} ·{' '}
            {t(`intel.dz.regimes.${tie.regime}`)}
            {view?.nations[nation]?.relation === 'war' ? ` · ${t('intel.dz.atWar')}` : ''}
          </p>
        ) : null}
        <div className="dz-cols">
          <fieldset className="dz-pick">
            <legend>{t('intel.dz.weRelease')}</legend>
            {theirs.length ? (
              theirs.map((d) => (
                <Checkbox
                  key={d.id}
                  checked={giveIds.includes(d.id)}
                  onChange={(on) => toggle(give, setGive, d.id, on)}
                  label={`${d.ref} · ${t(`intel.dz.kindsShort.${d.kind}`)} · ${formatNumber(d.value, 1)}`}
                />
              ))
            ) : (
              <p className="hint">{t('intel.dz.noneToRelease')}</p>
            )}
          </fieldset>
          <fieldset className="dz-pick">
            <legend>{t('intel.dz.weObtain')}</legend>
            {mine.length ? (
              mine.map((a) => (
                <Checkbox
                  key={a.id}
                  checked={getIds.includes(a.id)}
                  onChange={(on) => toggle(get, setGet, a.id, on)}
                  label={`${a.codename} · ${t(`intel.dz.fate.${a.detention!.fate}`)} · ${formatNumber(agentValueOf(a, dz?.value, dz?.accessValue), 1)}`}
                />
              ))
            ) : (
              <p className="hint">{t('intel.dz.noneToObtain')}</p>
            )}
          </fieldset>
        </div>
        <Field label={t('intel.dz.money')}>
          <Segmented
            label={t('intel.dz.money')}
            size="sm"
            value={money}
            onChange={setMoney}
            options={[
              { value: 'none', label: t('intel.dz.moneyNone') },
              { value: 'pay', label: t('intel.dz.moneyPay') },
              { value: 'ask', label: t('intel.dz.moneyAsk') },
            ]}
          />
        </Field>
        {money !== 'none' ? (
          <Field label={t('intel.dz.amount')}>
            <Select
              value={String(amount)}
              onChange={(v) => setAmount(Number(v))}
              options={AMOUNTS.filter(Boolean).map((a) => ({
                value: String(a),
                label: formatMoney(a),
              }))}
            />
          </Field>
        ) : null}
        <Field label={t('intel.dz.accord')}>
          <Select
            value={String(accord)}
            onChange={(v) => setAccord(Number(v))}
            options={ACCORDS.map((d) => ({
              value: String(d),
              label: d ? t('intel.dz.days', { n: d }) : t('intel.dz.accordNone'),
            }))}
          />
        </Field>
        {sponsored ? (
          <Checkbox checked={lift} onChange={setLift} label={t('intel.dz.liftSanctions')} />
        ) : null}
        <p className="dz-balance">
          {t('intel.dz.balance', {
            give: formatNumber(vGive, 1),
            get: formatNumber(vGet, 1),
          })}
        </p>
        <p className="hint">{t('intel.dz.balanceHint')}</p>
      </div>
    </Dialog>
  );
}

/** Onglet Détenus. */
export function IntelDetainees({ mobile }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const me = useGame((s) => s.me) ?? '';
  const now = useGameTime(5000);
  const [decision, setDecision] = useState<{
    d: DetaineeView;
    action: DetaineeOption['action'];
  } | null>(null);
  const [swap, setSwap] = useState<{ nation: NationId; give?: string; get?: string } | null>(null);
  if (!intel) return null;
  const detainees = intel.detainees ?? [];
  const abroad = agentsAbroad(intel);
  const swaps = intel.swaps ?? [];
  const ties = intel.ties ?? [];
  const live = detainees.find((x) => x.id === decision?.d.id);
  return (
    <div className={`dz${mobile ? ' dz--mobile' : ''}`} data-testid="intel-detainees">
      <header className="dept__head dz__head">
        <span className="dept__icon">
          <Icon name="lock" size={15} />
        </span>
        <span className="dept__titles">
          <h3>{t('intel.dz.title')}</h3>
          <span>{t('intel.dz.subtitle')}</span>
        </span>
        {intel.regime ? (
          <Badge tone="cyan" variant="outline">
            {t('intel.dz.ourRegime', { regime: t(`intel.dz.regimes.${intel.regime}`) })}
          </Badge>
        ) : null}
      </header>
      <div className="intel__body">
        <div className="intel__main">
          <section className="dz-sec">
            <span className="dept__label">
              {t('intel.dz.ours')} <b>{liveDetainees(intel).length}</b>
            </span>
            {detainees.length ? (
              <ul className="dz-list">
                {detainees.map((d) => (
                  <DetaineeRow
                    key={d.id}
                    d={d}
                    now={now}
                    onDecide={(x, action) => setDecision({ d: x, action })}
                    onNegotiate={(nation, give) => setSwap({ nation, give })}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState compact icon="lock" title={t('intel.dz.noDetainees')} />
            )}
            <p className="hint">{t('intel.dz.defaultHint')}</p>
          </section>
          <section className="dz-sec">
            <span className="dept__label">
              {t('intel.dz.abroad')} <b>{abroad.filter(stillHeld).length}</b>
            </span>
            {abroad.length ? (
              <ul className="dz-list">
                {abroad.map((a) => (
                  <AbroadRow
                    key={a.id}
                    a={a}
                    now={now}
                    onNegotiate={(nation, get) => setSwap({ nation, get })}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState compact icon="spy" title={t('intel.dz.noAbroad')} />
            )}
          </section>
        </div>
        <aside className="intel__side">
          <span className="dept__label">
            {t('intel.dz.negotiations')} <b>{swaps.filter((s) => s.status === 'open').length}</b>
          </span>
          {swaps.length ? (
            swaps.map((s) => <SwapCard key={s.id} s={s} me={me} now={now} />)
          ) : (
            <p className="hint">{t('intel.dz.noSwaps')}</p>
          )}
          <span className="dept__label">{t('intel.dz.relations')}</span>
          {ties.length ? (
            <ul className="dz-ties">
              {ties.map((x) => (
                <li key={x.nationId}>
                  <NationTag id={x.nationId} size={9} />
                  <span className="muted">{t(`intel.dz.regimesShort.${x.regime}`)}</span>
                  <span
                    className={`dz-ties__score ${x.score < -20 ? 'rl-tone-red' : x.score > 20 ? 'rl-tone-green' : ''}`}
                  >
                    {x.score > 0 ? '+' : ''}
                    {formatNumber(x.score, 0)}
                  </span>
                  {x.accordUntil ? (
                    <Badge tone="green" variant="outline">
                      {t('intel.dz.accordShort')}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">{t('intel.dz.noRelations')}</p>
          )}
        </aside>
      </div>
      {decision && live?.options ? (
        <DecisionDialog d={live} initial={decision.action} onClose={() => setDecision(null)} />
      ) : null}
      {swap ? (
        <SwapDialog
          nation={swap.nation}
          give={swap.give}
          get={swap.get}
          onClose={() => setSwap(null)}
        />
      ) : null}
    </div>
  );
}
