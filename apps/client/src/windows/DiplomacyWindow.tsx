import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AllianceView, NationId, Order, Relation } from '@redline/shared';
import {
  Badge,
  Button,
  Countdown,
  Dialog,
  EmptyState,
  Field,
  Flag,
  Gauge,
  Icon,
  Input,
  KeyValue,
  Money,
  Panel,
  ProgressBar,
  SearchInput,
  Segmented,
  Select,
  Stat,
  Table,
  Tabs,
  Toggle,
  Window,
  formatMoney,
  formatNumber,
  formatPct,
} from '@redline/ui';
import { getApi } from '../api/index.js';
import { Ago, NationTag, RelationBadge } from '../components/Common.js';
import { NationRecon } from '../components/NationRecon.js';
import { norm } from '../lib/commands.js';
import { nationForms, nationName, relationOf } from '../lib/game.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { orderError } from '../lib/loc.js';

type Tab = 'nation' | 'relations' | 'alliances' | 'neutrals' | 'disputed' | 'stability';

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res) toast(orderError(res), 'error');
    return !!res?.ok;
  };
}

function Relations({ onPick }: { onPick: (id: NationId) => void }) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const nations = useWorld((s) => s.nations);
  const now = useGameTime(5000);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'known' | Relation | 'all'>('known');
  const [war, setWar] = useState<NationId | null>(null);
  const dip = view?.diplomacy;
  const known = new Map((dip?.relations ?? []).map((r) => [r.nationId, r]));
  const defs = useWorld((s) => s.provinces);
  // Nations frontalières (provinces voisines des nôtres), toujours listées avec les relations actives.
  const neighbors = useMemo(() => {
    const out = new Set<NationId>();
    if (!view || !me) return out;
    for (const p of Object.values(view.provinces)) {
      if (p.owner !== me) continue;
      for (const nb of defs[p.id]?.neighbors ?? []) {
        const o = view.provinces[nb]?.owner;
        if (o && o !== me) out.add(o);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.provinces, me, defs]);
  const rows = useMemo(
    () =>
      Object.values(nations)
        .filter((n) => n.id !== me && (view?.nations[n.id]?.provinceCount ?? 1) > 0)
        .filter((n) =>
          filter === 'all'
            ? true
            : filter === 'known'
              ? known.has(n.id) || neighbors.has(n.id)
              : relationOf(view, n.id) === filter,
        )
        .filter((n) => !q || norm(n.name).includes(norm(q)))
        .map((n) => ({ id: n.id, rel: known.get(n.id) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nations, me, filter, q, dip, view?.nations, neighbors],
  );
  const order: Record<Relation, number> = { war: 0, ceasefire: 1, ally: 2, peace: 3 };
  const relationActions = (r: (typeof rows)[number]) => (
    <RelationActions nationId={r.id} onWar={setWar} />
  );
  return (
    <div className="vstack">
      <div className="kpis">
        <Stat
          label={t('diplomacy.reputation')}
          value={`${dip?.reputation ?? '—'}`}
          tone={(dip?.reputation ?? 50) >= 50 ? 'green' : 'amber'}
          sub={t('diplomacy.reputationHint')}
        />
        <Stat
          label={t('diplomacy.atWar')}
          value={(dip?.relations ?? []).filter((r) => r.relation === 'war').length}
          tone="red"
        />
        <Stat
          label={t('diplomacy.allies')}
          value={(dip?.relations ?? []).filter((r) => r.relation === 'ally').length}
          tone="green"
        />
        <Stat
          label={t('diplomacy.pending')}
          value={(dip?.relations ?? []).filter((r) => r.pending && r.pending.from !== me).length}
          tone="amber"
        />
      </div>
      <div className="row row--between">
        <Segmented
          size="sm"
          label={t('diplomacy.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'known', label: t('diplomacy.filters.known') },
            { value: 'war', label: t('diplomacy.relation.war') },
            { value: 'ally', label: t('diplomacy.relation.ally') },
            { value: 'all', label: t('app.all') },
          ]}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          label={t('app.search')}
          placeholder={t('newGame.searchPlaceholder')}
          className="army-search"
        />
      </div>
      <Table
        label={t('diplomacy.tabs.relations')}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => onPick(r.id)}
        empty={
          <EmptyState
            compact
            icon="diplomacy"
            title={t('diplomacy.noRelations')}
            text={t('diplomacy.noRelationsHint')}
          />
        }
        defaultSort={{ key: 'rel', dir: 'asc' }}
        rowClass={(r) => (r.rel?.pending && r.rel.pending.from !== me ? 'tr-attn' : undefined)}
        columns={[
          {
            key: 'n',
            header: t('diplomacy.cols.nation'),
            render: (r) => (
              <>
                <span className="relcell">
                  <NationTag id={r.id} strong />
                  <span className="rl-only-mobile">
                    <RelationBadge relation={relationOf(view, r.id)} />
                  </span>
                </span>
                <span className="rl-only-mobile rowactions rowactions--below">
                  {relationActions(r)}
                </span>
              </>
            ),
            sort: (a, b) => nationName(a.id).localeCompare(nationName(b.id)),
          },
          {
            key: 'rel',
            header: t('diplomacy.cols.relation'),
            hideOnMobile: true,
            render: (r) => <RelationBadge relation={relationOf(view, r.id)} />,
            sort: (a, b) => order[relationOf(view, a.id)] - order[relationOf(view, b.id)],
          },
          {
            key: 'since',
            header: t('diplomacy.cols.since'),
            hideOnMobile: true,
            render: (r) => (r.rel ? <Ago from={r.rel.since} now={now} /> : '—'),
          },
          {
            key: 'al',
            header: t('diplomacy.cols.alliance'),
            hideOnMobile: true,
            render: (r) => {
              const a = dip?.alliances.find((x) => x.members.includes(r.id));
              return a ? (
                <span className="altag">
                  [{a.flag}] {a.name}
                </span>
              ) : (
                <span className="muted">—</span>
              );
            },
          },
          {
            key: 'stab',
            header: t('diplomacy.cols.stability'),
            align: 'right',
            hideOnMobile: true,
            render: (r) => {
              const s = view?.nations[r.id]?.stability;
              return s === undefined ? (
                '—'
              ) : (
                <span className={s < 35 ? 'rl-tone-red' : s < 55 ? 'rl-tone-amber' : ''}>
                  {s} %
                </span>
              );
            },
          },
          {
            key: 'act',
            header: '',
            align: 'right',
            hideOnMobile: true,
            render: (r) => relationActions(r),
          },
        ]}
      />
      <WarDialog nationId={war} onClose={() => setWar(null)} />
    </div>
  );
}

/** Actions diplomatiques avec une nation : réponse à une proposition, paix, cessez-le-feu, guerre. */
function RelationActions({
  nationId,
  onWar,
}: {
  nationId: NationId;
  onWar: (id: NationId) => void;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const send = useSend();
  const rel = relationOf(view, nationId);
  const p = view?.diplomacy?.relations.find((x) => x.nationId === nationId)?.pending;
  // Clics et touches ne doivent pas ouvrir la fiche du pays (ligne de tableau cliquable).
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  if (p && p.from !== me)
    return (
      <span className="rowactions" onClick={stop} onKeyDown={stop}>
        <Badge tone="amber">{t(`diplomacy.proposal.${p.kind}`)}</Badge>
        <Button
          size="sm"
          variant="success"
          onClick={() =>
            void send({ kind: 'answerPeace', nationId, accept: true }, t('diplomacy.accepted'))
          }
        >
          {t('diplomacy.accept')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void send({ kind: 'answerPeace', nationId, accept: false }, t('diplomacy.refused'))
          }
        >
          {t('diplomacy.refuse')}
        </Button>
      </span>
    );
  if (p && p.from === me) return <Badge tone="neutral">{t('diplomacy.sent')}</Badge>;
  return rel === 'war' ? (
    <span className="rowactions" onClick={stop} onKeyDown={stop}>
      <Button
        size="sm"
        variant="subtle"
        onClick={() =>
          void send(
            { kind: 'proposePeace', nationId, type: 'ceasefire' },
            t('console.done.ceasefire', nationForms(nationId)),
          )
        }
      >
        {t('diplomacy.ceasefire')}
      </Button>
      <Button
        size="sm"
        variant="subtle"
        onClick={() =>
          void send(
            { kind: 'proposePeace', nationId, type: 'peace' },
            t('console.done.peace', nationForms(nationId)),
          )
        }
      >
        {t('diplomacy.peace')}
      </Button>
    </span>
  ) : rel !== 'ally' ? (
    <span className="rowactions" onClick={stop} onKeyDown={stop}>
      <Button size="sm" variant="danger" onClick={() => onWar(nationId)}>
        {t('diplomacy.declareWar')}
      </Button>
    </span>
  ) : null;
}

/** Confirmation de déclaration de guerre. */
function WarDialog({ nationId, onClose }: { nationId: NationId | null; onClose: () => void }) {
  const { t } = useTranslation();
  const send = useSend();
  return (
    <Dialog
      open={!!nationId}
      tone="red"
      title={t('diplomacy.warTitle')}
      path={[t('sections.path.diplomacy'), 'guerre']}
      onClose={onClose}
      closeLabel={t('app.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (nationId)
                void send(
                  { kind: 'declareWar', nationId },
                  t('console.done.war', nationForms(nationId)),
                );
              onClose();
            }}
          >
            {t('diplomacy.declareWar')}
          </Button>
        </>
      }
    >
      <p>{t('diplomacy.warText', nationForms(nationId))}</p>
    </Dialog>
  );
}

/**
 * Fiche pays (ouverte depuis une province ou la liste des relations) : identité, dirigeant,
 * relation et accords, actions diplomatiques, message privé, renseignement connu.
 */
function Country({
  nationId,
  onPick,
}: {
  nationId: NationId | null;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const nations = useWorld((s) => s.nations);
  const info = useWorld((s) => (nationId ? s.nationInfo[nationId] : undefined));
  const openWindow = useUi((s) => s.openWindow);
  const send = useSend();
  const now = useGameTime(5000);
  const [war, setWar] = useState<NationId | null>(null);
  useEffect(() => {
    void getApi().then((api) => useWorld.getState().loadNationInfo(api));
  }, []);
  const picker = (
    <Select
      label={t('diplomacy.country.pick')}
      value={nationId ?? ''}
      onChange={onPick}
      options={[
        { value: '', label: t('diplomacy.country.pick') },
        ...Object.values(nations)
          .filter((n) => n.id !== me && (view?.nations[n.id]?.provinceCount ?? 1) > 0)
          .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
          .map((n) => ({ value: n.id, label: n.name })),
      ]}
    />
  );
  if (!nationId || nationId === me || !view)
    return (
      <div className="vstack">
        <EmptyState
          icon="flag"
          title={t('diplomacy.country.none')}
          text={t('diplomacy.country.noneHint')}
        />
        <div className="country__picker">{picker}</div>
      </div>
    );
  const nv = view.nations[nationId];
  const dip = view.diplomacy;
  const rel = relationOf(view, nationId);
  const rv = dip?.relations.find((r) => r.nationId === nationId);
  const theirAlliance = dip?.alliances.find((a) => a.members.includes(nationId));
  const myAlliance = dip?.alliances.find((a) => a.id === dip.myAllianceId);
  const sameAlliance = !!theirAlliance && theirAlliance.id === myAlliance?.id;
  const canInvite = !!myAlliance && myAlliance.leader === me && !theirAlliance && rel !== 'war';
  const session = view.council?.session;
  const channel = me ? `private:${[me, nationId].sort().join('|')}` : 'game';
  const yes = t('app.yes');
  const no = t('diplomacy.country.no');
  return (
    <div className="country" data-testid="country-panel">
      <header className="country__head">
        <Flag nationId={nationId} size={26} color={nv?.color} />
        <div className="country__titles">
          <h3>{nationName(nationId)}</h3>
          <div className="country__badges">
            <RelationBadge relation={rel} />
            <Badge tone={nv?.isPlayer ? 'violet' : 'neutral'} variant="outline">
              {nv?.isPlayer ? t('diplomacy.country.player') : t('diplomacy.country.ai')}
            </Badge>
            {theirAlliance ? (
              <Badge tone={sameAlliance ? 'green' : 'blue'} variant="outline">
                [{theirAlliance.flag}] {theirAlliance.name}
              </Badge>
            ) : null}
            {nv?.embargoed ? <Badge tone="amber">{t('diplomacy.country.embargoed')}</Badge> : null}
            {nv?.sanctioned ? (
              <Badge tone="amber">{t('diplomacy.country.sanctioned')}</Badge>
            ) : null}
            {nv?.mobilized ? <Badge tone="red">{t('diplomacy.country.mobilized')}</Badge> : null}
          </div>
        </div>
        <div className="country__picker">{picker}</div>
      </header>
      <Panel title={t('diplomacy.country.actions')}>
        <div className="country__actions">
          <RelationActions nationId={nationId} onWar={setWar} />
          {canInvite ? (
            <Button
              size="sm"
              variant="subtle"
              icon={<Icon name="users" size={12} />}
              onClick={() =>
                void send(
                  { kind: 'inviteToAlliance', nationId },
                  t('diplomacy.country.invited', nationForms(nationId)),
                )
              }
            >
              {t('diplomacy.country.invite')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="subtle"
            icon={<Icon name="gavel" size={12} />}
            disabled={session?.phase !== 'proposals'}
            title={
              session?.phase !== 'proposals' ? t('diplomacy.country.sanctionsClosed') : undefined
            }
            onClick={() =>
              void send(
                {
                  kind: 'proposeResolution',
                  type: 'economic_sanctions',
                  target: { nationId },
                  text: t('diplomacy.country.sanctionsText', nationForms(nationId)),
                },
                t('diplomacy.country.sanctionsProposed'),
              )
            }
          >
            {t('diplomacy.country.sanctions')}
          </Button>
          <Button
            size="sm"
            icon={<Icon name="chat" size={12} />}
            onClick={() => openWindow('chat', { channel })}
            data-testid="country-message"
          >
            {t('diplomacy.country.message')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="intel" size={12} />}
            onClick={() => openWindow('intel', { nationId })}
          >
            {t('diplomacy.country.intel')}
          </Button>
        </div>
      </Panel>
      {info?.description ? <p className="country__desc">{info.description}</p> : null}
      <div className="cols2 country__cols">
        <Panel title={t('diplomacy.country.relation')}>
          <KeyValue
            items={[
              {
                label: t('diplomacy.cols.relation'),
                value: t(`diplomacy.relation.${rel}`),
                tone: rel === 'war' ? 'red' : rel === 'ally' ? 'green' : undefined,
              },
              {
                label: t('diplomacy.cols.since'),
                value: rv ? <Ago from={rv.since} now={now} /> : '—',
                tone: 'dim',
              },
              {
                label: t('diplomacy.country.pending'),
                value: rv?.pending
                  ? t(
                      rv.pending.from === me
                        ? 'diplomacy.country.pendingMine'
                        : 'diplomacy.country.pendingTheirs',
                      { kind: t(`diplomacy.proposal.${rv.pending.kind}`) },
                    )
                  : '—',
                tone: rv?.pending ? 'amber' : 'dim',
              },
              {
                label: t('diplomacy.country.passage'),
                value: rel === 'ally' || (sameAlliance && myAlliance?.charter.passage) ? yes : no,
                tone: rel === 'ally' || sameAlliance ? 'green' : 'dim',
              },
              {
                label: t('diplomacy.country.mutualDefense'),
                value: sameAlliance && myAlliance?.charter.mutualDefense ? yes : no,
                tone: sameAlliance && myAlliance?.charter.mutualDefense ? 'green' : 'dim',
              },
              {
                label: t('diplomacy.country.intelSharing'),
                value: sameAlliance && myAlliance?.charter.intelSharing ? yes : no,
                tone: sameAlliance && myAlliance?.charter.intelSharing ? 'green' : 'dim',
              },
            ]}
          />
        </Panel>
        <Panel title={t('diplomacy.country.profile')}>
          <KeyValue
            items={[
              { label: t('diplomacy.country.provinces'), value: nv?.provinceCount ?? '—' },
              {
                label: t('diplomacy.cols.stability'),
                value: nv?.stability !== undefined ? `${nv.stability} %` : '—',
                tone:
                  nv?.stability === undefined
                    ? 'dim'
                    : nv.stability < 35
                      ? 'red'
                      : nv.stability < 55
                        ? 'amber'
                        : undefined,
              },
              {
                label: t('diplomacy.reputation'),
                value: nv?.reputation !== undefined ? `${nv.reputation}` : '—',
              },
              {
                label: t('diplomacy.country.budget'),
                value: info?.defenseBudgetUsd ? formatMoney(info.defenseBudgetUsd) : '—',
                tone: 'amber',
              },
              {
                label: t('diplomacy.country.personnel'),
                value: info?.activePersonnel ? formatNumber(info.activePersonnel, 0) : '—',
              },
              {
                label: t('diplomacy.country.doctrine'),
                value: info?.doctrine ? t(`doctrines.${info.doctrine}`) : '—',
              },
            ]}
          />
        </Panel>
      </div>
      <NationRecon nationId={nationId} />
      <WarDialog nationId={war} onClose={() => setWar(null)} />
    </div>
  );
}

function AllianceCard({ a, mine }: { a: AllianceView; mine: boolean }) {
  const { t } = useTranslation();
  const me = useGame((s) => s.me);
  const openWindow = useUi((s) => s.openWindow);
  const send = useSend();
  const now = useGameTime(5000);
  return (
    <Panel
      title={
        <span className="alliance__title">
          <span className="alliance__flag">{a.flag}</span>
          {a.name}
        </span>
      }
      meta={t('diplomacy.members', { count: a.members.length })}
      accent={mine ? 'green' : undefined}
      actions={mine ? <Badge tone="green">{t('diplomacy.yourAlliance')}</Badge> : null}
    >
      <div className="alliance">
        <div className="alliance__members">
          {a.members.map((m) => (
            <span
              key={m}
              className={m === a.leader ? 'alliance__m alliance__m--lead' : 'alliance__m'}
            >
              <NationTag id={m} size={10} />
              {m === a.leader ? <Icon name="crown" size={12} /> : null}
            </span>
          ))}
        </div>
        <div className="alliance__charter">
          {(['mutualDefense', 'intelSharing', 'passage'] as const).map((k) => (
            <span key={k} className={a.charter[k] ? 'charter charter--on' : 'charter'}>
              <Icon name={a.charter[k] ? 'check' : 'close'} size={11} />
              {t(`diplomacy.charter.${k}`)}
            </span>
          ))}
        </div>
        {mine ? (
          <>
            <div className="alliance__treasury">
              <span className="dept__label">{t('diplomacy.treasury')}</span>
              <Money value={a.treasury} />
              <span className="grow" />
              {[100e6, 500e6].map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant="subtle"
                  onClick={() =>
                    void send(
                      { kind: 'allianceTreasury', amount: v },
                      t('diplomacy.deposited', { amount: formatMoney(v) }),
                    )
                  }
                >
                  +{formatMoney(v)}
                </Button>
              ))}
            </div>
            {a.votes.map((v) => {
              const total = a.members.length;
              const voted = v.yes.includes(me ?? '') || v.no.includes(me ?? '');
              return (
                <div key={v.id} className="vote">
                  <div className="vote__head">
                    <Icon name="vote" size={14} />
                    <b>{t(`diplomacy.votes.${v.kind}`, nationForms(v.subject))}</b>
                    <span className="grow" />
                    <Countdown ms={v.endsAt - now} dayUnit={t('time.dayUnit')} />
                  </div>
                  <div className="vote__bar">
                    <span
                      className="vote__yes"
                      style={{ width: `${(v.yes.length / total) * 100}%` }}
                    />
                    <span
                      className="vote__no"
                      style={{ width: `${(v.no.length / total) * 100}%` }}
                    />
                  </div>
                  <div className="vote__foot">
                    <span className="rl-tone-green">
                      {t('diplomacy.yes')} {v.yes.length}
                    </span>
                    <span className="rl-tone-red">
                      {t('diplomacy.no')} {v.no.length}
                    </span>
                    <span className="grow" />
                    {!voted ? (
                      <>
                        <Button
                          size="sm"
                          variant="success"
                          onClick={() =>
                            void send(
                              { kind: 'allianceVote', voteId: v.id, yes: true },
                              t('diplomacy.voted'),
                            )
                          }
                        >
                          {t('diplomacy.yes')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() =>
                            void send(
                              { kind: 'allianceVote', voteId: v.id, yes: false },
                              t('diplomacy.voted'),
                            )
                          }
                        >
                          {t('diplomacy.no')}
                        </Button>
                      </>
                    ) : (
                      <Badge tone="neutral">{t('diplomacy.hasVoted')}</Badge>
                    )}
                  </div>
                </div>
              );
            })}
            {a.invites.length ? (
              <p className="hint">
                {t('diplomacy.invited')} {a.invites.map((n) => nationName(n)).join(', ')}
              </p>
            ) : null}
            <div className="row">
              <Button
                size="sm"
                icon={<Icon name="chat" size={12} />}
                onClick={() => openWindow('chat', { channel: 'alliance' })}
              >
                {t('diplomacy.allianceChat')}
              </Button>
              <span className="grow" />
              <Button
                size="sm"
                variant="danger"
                onClick={() => void send({ kind: 'leaveAlliance' }, t('diplomacy.left'))}
              >
                {t('diplomacy.leave')}
              </Button>
            </div>
          </>
        ) : (
          <div className="alliance__treasury">
            <span className="dept__label">{t('diplomacy.treasury')}</span>
            <Money value={a.treasury} />
            <span className="grow" />
            <span className="muted small">
              {t('diplomacy.leader')} <NationTag id={a.leader} size={9} />
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}

function CreateAlliance() {
  const { t } = useTranslation();
  const send = useSend();
  const [name, setName] = useState('');
  const [flag, setFlag] = useState('');
  const [charter, setCharter] = useState({
    mutualDefense: true,
    intelSharing: true,
    passage: false,
  });
  return (
    <Panel title={t('diplomacy.create')}>
      <div className="stack">
        <div className="cols2">
          <Field label={t('diplomacy.allianceName')}>
            <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('diplomacy.allianceFlag')}>
            <Input
              value={flag}
              maxLength={4}
              onChange={(e) => setFlag(e.target.value.toUpperCase())}
            />
          </Field>
        </div>
        {(['mutualDefense', 'intelSharing', 'passage'] as const).map((k) => (
          <Toggle
            key={k}
            checked={charter[k]}
            onChange={(v) => setCharter({ ...charter, [k]: v })}
            label={t(`diplomacy.charter.${k}`)}
            description={t(`diplomacy.charterHelp.${k}`)}
          />
        ))}
        <Button
          variant="primary"
          disabled={name.trim().length < 2}
          onClick={() =>
            void send(
              {
                kind: 'createAlliance',
                name: name.trim(),
                flag: flag || name.slice(0, 2).toUpperCase(),
                charter,
              },
              t('diplomacy.created', { name }),
            )
          }
        >
          {t('diplomacy.createBtn')}
        </Button>
      </div>
    </Panel>
  );
}

function Alliances() {
  const { t } = useTranslation();
  const dip = useGame((s) => s.view?.diplomacy);
  const send = useSend();
  if (!dip) return <EmptyState icon="diplomacy" title={t('diplomacy.unavailable')} />;
  const mine = dip.alliances.find((a) => a.id === dip.myAllianceId);
  const others = dip.alliances.filter((a) => a.id !== dip.myAllianceId);
  return (
    <div className="vstack">
      {dip.invitations.map((id) => {
        const a = dip.alliances.find((x) => x.id === id);
        return a ? (
          <div key={id} className="invite">
            <Icon name="users" size={15} />
            <span>{t('diplomacy.invitation', { name: a.name })}</span>
            <span className="grow" />
            <Button
              size="sm"
              variant="success"
              onClick={() =>
                void send(
                  { kind: 'answerInvite', allianceId: id, accept: true },
                  t('diplomacy.joined', { name: a.name }),
                )
              }
            >
              {t('diplomacy.accept')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void send(
                  { kind: 'answerInvite', allianceId: id, accept: false },
                  t('diplomacy.refused'),
                )
              }
            >
              {t('diplomacy.refuse')}
            </Button>
          </div>
        ) : null;
      })}
      {mine ? <AllianceCard a={mine} mine /> : <CreateAlliance />}
      {others.length ? <div className="section-gap" /> : null}
      <div className="generals">
        {others.map((a) => (
          <AllianceCard key={a.id} a={a} mine={false} />
        ))}
      </div>
    </div>
  );
}

function Neutrals() {
  const { t } = useTranslation();
  const dip = useGame((s) => s.view?.diplomacy);
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const send = useSend();
  const [aid, setAid] = useState(200e6);
  const [q, setQ] = useState('');
  if (!dip?.neutrals.length) return <EmptyState icon="globe" title={t('diplomacy.noNeutrals')} />;
  const alliances = dip.alliances;
  const inAlliance = !!dip.myAllianceId;
  const rows = dip.neutrals
    .filter((n) => !q || norm(nationName(n.nationId)).includes(norm(q)))
    .map((n) => ({
      ...n,
      mine: dip.myAllianceId ? (n.leaning[dip.myAllianceId] ?? 0) : 0,
      top: Object.entries(n.leaning).sort((a, b) => b[1] - a[1])[0] ?? null,
    }))
    .sort(
      (a, b) => b.mine - a.mine || nationName(a.nationId).localeCompare(nationName(b.nationId)),
    );
  return (
    <div className="vstack">
      {!inAlliance ? (
        <p className="hint hint--warn">
          <Icon name="warning" size={13} /> {t('diplomacy.neutralsNeedAlliance')}
        </p>
      ) : (
        <p className="hint">{t('diplomacy.neutralsHelp')}</p>
      )}
      <div className="row row--between">
        <SearchInput
          value={q}
          onChange={setQ}
          label={t('app.search')}
          placeholder={t('newGame.searchPlaceholder')}
          className="army-search"
        />
        <Segmented
          size="sm"
          label={t('diplomacy.aid')}
          value={aid}
          onChange={setAid}
          options={[100e6, 200e6, 500e6, 1e9].map((v) => ({ value: v, label: formatMoney(v) }))}
        />
      </div>
      <Table
        label={t('diplomacy.tabs.neutrals')}
        rows={rows.slice(0, 60)}
        rowKey={(r) => r.nationId}
        columns={[
          {
            key: 'n',
            header: t('diplomacy.cols.nation'),
            render: (r) => <NationTag id={r.nationId} strong />,
          },
          {
            key: 'l',
            header: t('diplomacy.cols.leaning'),
            width: '40%',
            render: (r) => {
              if (!r.top) return <span className="muted small">{t('diplomacy.noLeaning')}</span>;
              const a = alliances.find((x) => x.id === r.top![0]);
              const mine = r.top[0] === dip.myAllianceId;
              return (
                <ProgressBar
                  value={r.top[1]}
                  size="xs"
                  tone={mine ? 'green' : 'blue'}
                  trailing={`${a ? `[${a.flag}] ` : ''}${formatPct(r.top[1])}`}
                  label={t('diplomacy.cols.leaning')}
                />
              );
            },
          },
          {
            key: 'a',
            header: '',
            align: 'right',
            render: (r) => (
              <Button
                size="sm"
                variant="subtle"
                disabled={!inAlliance || money < aid}
                onClick={() =>
                  void send(
                    { kind: 'courtNeutral', nationId: r.nationId, aid },
                    t('diplomacy.courted', nationForms(r.nationId)),
                  )
                }
              >
                {t('diplomacy.court', { amount: formatMoney(aid) })}
              </Button>
            ),
          },
        ]}
      />
      {rows.length > 60 ? (
        <p className="hint">{t('diplomacy.moreNeutrals', { count: rows.length - 60 })}</p>
      ) : null}
    </div>
  );
}

function Disputed() {
  const { t } = useTranslation();
  const dip = useGame((s) => s.view?.diplomacy);
  const provinces = useWorld((s) => s.provinces);
  const focusOn = useUi((s) => s.focusOn);
  const send = useSend();
  if (!dip?.disputed.length) return <EmptyState icon="flag" title={t('diplomacy.noDisputed')} />;
  return (
    <div className="generals">
      {dip.disputed.map((d) => (
        <Panel
          key={d.id}
          title={d.name}
          meta={t('diplomacy.provinces', { count: d.provinceIds.length })}
          accent={d.tension >= 70 ? 'red' : d.tension >= 45 ? 'amber' : undefined}
        >
          <div className="stack">
            <div className="row row--between">
              <span className="dept__label">{t('diplomacy.holder')}</span>
              <NationTag id={d.holder} strong />
            </div>
            <div className="row row--between">
              <span className="dept__label">{t('diplomacy.claimants')}</span>
              <span className="row">
                {d.claimants.map((c) => (
                  <NationTag key={c} id={c} size={10} />
                ))}
              </span>
            </div>
            <div className="row row--between">
              <span className="dept__label">{t('diplomacy.tension')}</span>
              <Gauge
                value={d.tension / 100}
                tone={d.tension >= 70 ? 'red' : d.tension >= 45 ? 'amber' : 'green'}
                cells={10}
              />
            </div>
            <div className="row">
              <Button
                size="sm"
                variant="subtle"
                icon={<Icon name="mapPin" size={12} />}
                onClick={() => {
                  const p = provinces[d.provinceIds[0] ?? ''];
                  if (p) focusOn(p.cityPoint, 6);
                }}
              >
                {t('economy.show')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<Icon name="money" size={12} />}
                onClick={() =>
                  void send(
                    { kind: 'fundRebels', provinceId: d.provinceIds[0] ?? '', amount: 100e6 },
                    t('diplomacy.rebelsFunded'),
                  )
                }
              >
                {t('diplomacy.fundRebels')}
              </Button>
            </div>
          </div>
        </Panel>
      ))}
    </div>
  );
}

function Stability() {
  const { t } = useTranslation();
  const s = useGame((st) => st.view?.stability);
  if (!s) return <EmptyState icon="shield" title={t('diplomacy.noStability')} />;
  const max = Math.max(1, ...s.factors.map((f) => Math.abs(f.delta)));
  return (
    <div className="vstack">
      <div className="kpis">
        <Stat
          label={t('diplomacy.stability')}
          value={`${Math.round(s.value)} %`}
          tone={s.value < 30 ? 'red' : s.value < 50 ? 'amber' : 'green'}
          sub={<Gauge value={s.value / 100} tone="auto" cells={14} showValue={false} />}
        />
        <Stat
          label={t('diplomacy.trend')}
          value={`${s.trend >= 0 ? '+' : '−'}${formatNumber(Math.abs(s.trend), 1)} / j`}
          tone={s.trend >= 0 ? 'green' : 'amber'}
        />
        <Stat
          label={t('diplomacy.coupRisk')}
          value={formatPct(s.coupRisk, 1)}
          tone={s.coupRisk > 0.15 ? 'red' : 'default'}
          sub={t('diplomacy.coupHint')}
        />
      </div>
      <Panel title={t('diplomacy.factors')}>
        <ul className="factors">
          {s.factors.map((f, i) => (
            <li key={i}>
              <span className="factors__label">{f.label}</span>
              <span className="factors__bar">
                <span
                  className={f.delta >= 0 ? 'factors__pos' : 'factors__neg'}
                  style={{ width: `${(Math.abs(f.delta) / max) * 50}%` }}
                />
              </span>
              <b
                className={f.delta >= 0 ? 'rl-tone-green' : 'rl-tone-red'}
              >{`${f.delta >= 0 ? '+' : '−'}${formatNumber(Math.abs(f.delta), 1)}`}</b>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/** Diplomatie : relations, alliances, neutres, territoires disputés, stabilité. */
export function DiplomacyWindow({ win, frame }: WindowContentProps) {
  const { t } = useTranslation();
  const dip = useGame((s) => s.view?.diplomacy);
  const me = useGame((s) => s.me);
  const [tab, setTab] = useState<Tab>(
    (win.params.tab as Tab) ?? (win.params.nationId ? 'nation' : 'relations'),
  );
  const [nation, setNation] = useState<string | null>(win.params.nationId ?? null);
  useEffect(() => {
    if (win.params.nationId) {
      setNation(win.params.nationId);
      setTab((win.params.tab as Tab) ?? 'nation');
    } else if (win.params.tab) setTab(win.params.tab as Tab);
  }, [win.seq, win.params.tab, win.params.nationId]);
  const pick = (id: string) => {
    setNation(id || null);
    setTab('nation');
  };
  const pending = dip?.relations.filter((r) => r.pending && r.pending.from !== me).length ?? 0;
  return (
    <Window
      {...frame}
      path={[
        t('sections.path.diplomacy'),
        tab === 'nation' && nation ? nationName(nation) : t(`diplomacy.tabs.${tab}`),
      ]}
      tabs={
        <Tabs
          label={t('sections.diplomacy')}
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'nation',
              label: nation ? nationName(nation) : t('diplomacy.tabs.nation'),
              icon: nation ? <Flag nationId={nation} size={11} /> : <Icon name="flag" size={13} />,
            },
            {
              id: 'relations',
              label: t('diplomacy.tabs.relations'),
              dot: pending > 0,
              icon: <Icon name="handshake" size={13} />,
            },
            {
              id: 'alliances',
              label: t('diplomacy.tabs.alliances'),
              count: dip?.alliances.length,
              dot: !!dip?.invitations.length,
              icon: <Icon name="users" size={13} />,
            },
            {
              id: 'neutrals',
              label: t('diplomacy.tabs.neutrals'),
              count: dip?.neutrals.length,
              icon: <Icon name="globe" size={13} />,
            },
            {
              id: 'disputed',
              label: t('diplomacy.tabs.disputed'),
              count: dip?.disputed.length,
              icon: <Icon name="flag" size={13} />,
            },
            {
              id: 'stability',
              label: t('diplomacy.tabs.stability'),
              icon: <Icon name="shield" size={13} />,
            },
          ]}
        />
      }
    >
      {tab === 'nation' ? (
        <Country nationId={nation} onPick={pick} />
      ) : !dip && tab !== 'stability' ? (
        <EmptyState icon="diplomacy" title={t('diplomacy.unavailable')} />
      ) : tab === 'relations' ? (
        <Relations onPick={pick} />
      ) : tab === 'alliances' ? (
        <Alliances />
      ) : tab === 'neutrals' ? (
        <Neutrals />
      ) : tab === 'disputed' ? (
        <Disputed />
      ) : (
        <Stability />
      )}
    </Window>
  );
}
