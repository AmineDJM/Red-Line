import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RESEARCH_BRANCHES,
  type Order,
  type ResearchBranch,
  type ResearchNode,
} from '@redline/shared';
import {
  Badge,
  Button,
  Countdown,
  EmptyState,
  Icon,
  Money,
  ProgressBar,
  Tabs,
  WeaponPhoto,
  Window,
  formatHours,
  formatMoney,
  formatNumber,
  type IconName,
} from '@redline/ui';
import { researchName } from '../lib/game.js';
import { photoFor, usePhotos } from '../lib/photos.js';
import { useGameTime } from '../shell/helpers.js';
import type { WindowContentProps } from '../shell/WindowHost.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';
import { orderError } from '../lib/loc.js';

const BRANCH_ICON: Record<ResearchBranch, IconName> = {
  aero: 'production',
  land: 'army',
  naval: 'anchor',
  missiles: 'missile',
  sensors: 'radio',
  cyber: 'terminal',
  intel: 'intel',
  industry: 'factory',
};

const COL_W = 212;
const ROW_H = 84;
const NODE_W = 184;
const NODE_H = 62;
const PAD = 16;

type Status = 'done' | 'current' | 'queued' | 'available' | 'locked';

interface Placed {
  node: ResearchNode;
  col: number;
  row: number;
}

/** Disposition en colonnes (rang) et lignes (chaînes de dépendances de la branche). */
function layout(nodes: ResearchNode[]): { placed: Placed[]; rows: number; cols: number } {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, ResearchNode[]>();
  for (const n of nodes)
    for (const r of n.requires) if (ids.has(r)) children.set(r, [...(children.get(r) ?? []), n]);
  const size = (n: ResearchNode, seen = new Set<string>()): number => {
    if (seen.has(n.id)) return 0;
    seen.add(n.id);
    return 1 + (children.get(n.id) ?? []).reduce((s, k) => s + size(k, seen), 0);
  };
  // Les chaînes les plus longues d'abord (ligne principale de la branche en haut).
  const roots = nodes
    .filter((n) => !n.requires.some((r) => ids.has(r)))
    .sort((a, b) => size(b) - size(a) || a.tier - b.tier || a.id.localeCompare(b.id));
  const placed = new Map<string, Placed>();
  const minTier = Math.min(...nodes.map((n) => n.tier), 0);
  let row = 0;
  const visit = (n: ResearchNode, r: number) => {
    if (placed.has(n.id)) return;
    placed.set(n.id, { node: n, col: n.tier - minTier, row: r });
    const kids = (children.get(n.id) ?? []).sort(
      (a, b) => a.tier - b.tier || a.id.localeCompare(b.id),
    );
    kids.forEach((k, i) => {
      if (placed.has(k.id)) return;
      if (i === 0) visit(k, r);
      else visit(k, ++row);
    });
  };
  for (const root of roots) {
    visit(root, row);
    row++;
  }
  for (const n of nodes)
    if (!placed.has(n.id)) placed.set(n.id, { node: n, col: n.tier - minTier, row: row++ });
  // Colonnes strictement croissantes le long d'une dépendance.
  const list = [...placed.values()];
  for (let pass = 0; pass < 3; pass++)
    for (const p of list)
      for (const r of p.node.requires) {
        const q = placed.get(r);
        if (q && q.col >= p.col) p.col = q.col + 1;
      }
  return {
    placed: list,
    rows: Math.max(1, ...list.map((p) => p.row + 1)),
    cols: Math.max(1, ...list.map((p) => p.col + 1)),
  };
}

function useSend() {
  const { t } = useTranslation();
  const toast = useUi((s) => s.toast);
  return async (order: Order, ok: string) => {
    const res = await useGame.getState().connection?.sendOrder(order);
    if (res?.ok) toast(ok, 'ok');
    else if (res)
      toast(orderError(res), 'error');
  };
}

/** Recherche : arbre par branche (graphe et dépendances), recherche en cours, file, effets. */
export function ResearchWindow({ win, frame, mobile }: WindowContentProps) {
  const { t } = useTranslation();
  const nodes = useWorld((s) => s.research);
  const catalog = useWorld((s) => s.catalog);
  const r = useGame((s) => s.view?.research);
  const money = useGame((s) => s.view?.economy.money ?? 0);
  const photos = usePhotos();
  const send = useSend();
  const now = useGameTime(1000);
  const all = useMemo(() => Object.values(nodes), [nodes]);
  const branches = RESEARCH_BRANCHES.filter((b) => all.some((n) => n.branch === b));
  const [branch, setBranch] = useState<ResearchBranch>('aero');
  const [selected, setSelected] = useState<string | null>(
    win.params.nodeId ?? r?.current?.id ?? null,
  );
  // Ouverture ciblée (fiche d'arme « R&D requise ») : branche et nœud demandés.
  useEffect(() => {
    const id = win.params.nodeId;
    const n = id ? nodes[id] : undefined;
    if (n) {
      setSelected(n.id);
      setBranch(n.branch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.seq, win.params.nodeId, nodes]);
  useEffect(() => {
    if (!branches.includes(branch) && branches[0]) setBranch(branches[0]);
  }, [branches, branch]);
  const graphRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = graphRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [selected, branch]);

  const done = new Set(r?.done ?? []);
  const status = (n: ResearchNode): Status =>
    done.has(n.id)
      ? 'done'
      : r?.current?.id === n.id
        ? 'current'
        : r?.queue.includes(n.id)
          ? 'queued'
          : n.requires.every((x) => done.has(x))
            ? 'available'
            : 'locked';

  const branchNodes = all.filter((n) => n.branch === branch);
  const { placed, rows, cols } = useMemo(
    () => layout(branchNodes),
    [branchNodes.map((n) => n.id).join()],
  );
  const pos = new Map(placed.map((p) => [p.node.id, p]));
  const width = PAD * 2 + cols * COL_W - (COL_W - NODE_W);
  const height = PAD * 2 + rows * ROW_H - (ROW_H - NODE_H);
  const sel = selected ? nodes[selected] : null;
  const cur = r?.current ? nodes[r.current.id] : null;
  const unlocks = sel ? Object.values(catalog).filter((s) => s.requires.includes(sel.id)) : [];
  const branchDone = (b: ResearchBranch) =>
    all.filter((n) => n.branch === b && done.has(n.id)).length;
  const branchTotal = (b: ResearchBranch) => all.filter((n) => n.branch === b).length;
  const mods = Object.entries(r?.modifiers ?? {}).filter(([, v]) => v !== 1);

  const start = (n: ResearchNode) =>
    void send(
      { kind: 'research', nodeId: n.id },
      r?.current ? t('research.queued', { node: n.name }) : t('research.started', { node: n.name }),
    );

  /** Prérequis manquants (ni acquis, ni en cours, ni en file), dans l'ordre où les lancer. */
  const chainOf = (n: ResearchNode): ResearchNode[] => {
    const out: ResearchNode[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const x = nodes[id];
      if (!x || done.has(id) || r?.current?.id === id || r?.queue.includes(id)) return;
      for (const q of x.requires) visit(q);
      out.push(x);
    };
    visit(n.id);
    return out;
  };
  const planChain = async (n: ResearchNode) => {
    const chain = chainOf(n);
    const toast = useUi.getState().toast;
    for (const x of chain) {
      const res = await useGame
        .getState()
        .connection?.sendOrder({ kind: 'research', nodeId: x.id });
      if (!res?.ok) {
        toast(res?.message || t(`game.orders.errors.${res?.error ?? 'not_allowed'}`), 'error');
        return;
      }
    }
    toast(t('research.chainQueued', { node: n.name, count: chain.length }), 'ok');
  };

  if (!all.length)
    return (
      <Window {...frame}>
        <EmptyState icon="research" title={t('research.noTree')} text={t('research.noTreeHint')} />
      </Window>
    );

  return (
    <Window
      {...frame}
      path={[t('sections.path.research'), t(`research.branches.${branch}`)]}
      flush
      tabs={
        <Tabs
          label={t('research.branchesLabel')}
          value={branch}
          onChange={setBranch}
          tabs={branches.map((b) => ({
            id: b,
            label: t(`research.branches.${b}`),
            icon: <Icon name={BRANCH_ICON[b]} size={13} />,
            count: branchDone(b) === branchTotal(b) ? undefined : branchTotal(b) - branchDone(b),
          }))}
        />
      }
    >
      <div className={mobile ? 'research research--mobile' : 'research'}>
        <section className="research__now">
          <div className="research__current">
            <span className="research__label">{t('research.current')}</span>
            {cur && r?.current ? (
              <button type="button" className="research__cur" onClick={() => setSelected(cur.id)}>
                <span className="research__cur-name">{cur.name}</span>
                <span className="research__cur-id">{cur.id.replace(/^research\./, '')}</span>
                <ProgressBar
                  value={
                    (now - r.current.startedAt) /
                    Math.max(1, r.current.completesAt - r.current.startedAt)
                  }
                  size="md"
                  trailing={
                    <Countdown ms={r.current.completesAt - now} dayUnit={t('time.dayUnit')} />
                  }
                  label={t('research.progress')}
                />
              </button>
            ) : (
              <span className="muted">{t('research.idle')}</span>
            )}
          </div>
          <div className="research__queue">
            <span className="research__label">
              {t('research.queue')} <b>{r?.queue.length ?? 0}</b>
            </span>
            <ol>
              {(r?.queue ?? []).map((id, i) => (
                <li key={id}>
                  <button type="button" onClick={() => setSelected(id)}>
                    <span className="research__qi">{i + 1}</span>
                    {researchName(id, nodes)}
                  </button>
                  <button
                    type="button"
                    className="research__qx"
                    aria-label={t('research.remove')}
                    onClick={() =>
                      void send({ kind: 'cancelResearch', nodeId: id }, t('research.removed'))
                    }
                  >
                    <Icon name="close" size={11} />
                  </button>
                </li>
              ))}
              {!r?.queue.length ? (
                <li className="muted small">{t('research.queueEmpty')}</li>
              ) : null}
            </ol>
          </div>
          {!mobile ? (
            <div className="research__mods">
              <span className="research__label">{t('research.effects')}</span>
              <ul>
                {mods.slice(0, 6).map(([k, v]) => (
                  <li key={k}>
                    <span>{t(`modifiers.${k.replace(/\./g, '_')}`, { defaultValue: k })}</span>
                    <b className={v! >= 1 ? 'rl-tone-green' : 'rl-tone-amber'}>
                      {k.endsWith('.level')
                        ? `+${v}`
                        : `${v! >= 1 ? '+' : '−'}${formatNumber(Math.abs(v! - 1) * 100, 0)} %`}
                    </b>
                  </li>
                ))}
                {!mods.length ? <li className="muted small">—</li> : null}
              </ul>
            </div>
          ) : null}
        </section>

        <div className="research__body">
          <div
            className="research__graph"
            ref={graphRef}
            role="tree"
            aria-label={t(`research.branches.${branch}`)}
          >
            <div className="research__canvas" style={{ width, height }}>
              <svg className="research__edges" width={width} height={height} aria-hidden>
                {placed.flatMap((p) =>
                  p.node.requires
                    .map((req) => pos.get(req))
                    .filter((q): q is Placed => !!q)
                    .map((q) => {
                      const x1 = PAD + q.col * COL_W + NODE_W;
                      const y1 = PAD + q.row * ROW_H + NODE_H / 2;
                      const x2 = PAD + p.col * COL_W;
                      const y2 = PAD + p.row * ROW_H + NODE_H / 2;
                      const mx = (x1 + x2) / 2;
                      const st = status(p.node);
                      const ok = done.has(q.node.id);
                      return (
                        <path
                          key={`${q.node.id}-${p.node.id}`}
                          d={`M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                          className={`edge ${ok ? (st === 'done' ? 'edge--done' : 'edge--open') : 'edge--locked'}`}
                        />
                      );
                    }),
                )}
              </svg>
              {placed.map((p) => {
                const st = status(p.node);
                const external = p.node.requires.filter((x) => !pos.has(x));
                return (
                  <button
                    key={p.node.id}
                    type="button"
                    role="treeitem"
                    aria-selected={selected === p.node.id}
                    className={[
                      'rnode',
                      `rnode--${st}`,
                      selected === p.node.id ? 'rnode--sel' : '',
                    ].join(' ')}
                    style={{
                      left: PAD + p.col * COL_W,
                      top: PAD + p.row * ROW_H,
                      width: NODE_W,
                      height: NODE_H,
                    }}
                    onClick={() => setSelected(p.node.id)}
                    onDoubleClick={() => st === 'available' && start(p.node)}
                  >
                    <span className="rnode__top">
                      <span className="rnode__state" aria-hidden>
                        {st === 'done'
                          ? '✓'
                          : st === 'current'
                            ? '▶'
                            : st === 'queued'
                              ? `${(r?.queue.indexOf(p.node.id) ?? 0) + 1}`
                              : st === 'locked'
                                ? '·'
                                : '○'}
                      </span>
                      <span className="rnode__name">{p.node.name}</span>
                    </span>
                    <span className="rnode__meta">
                      <span>{formatMoney(p.node.cost.money)}</span>
                      <span>{formatHours(p.node.durationH, t('time.dayUnit'))}</span>
                      {external.length ? (
                        <span
                          className="rnode__ext"
                          title={external.map((x) => researchName(x, nodes)).join(', ')}
                        >
                          +{external.length}
                        </span>
                      ) : null}
                    </span>
                    {st === 'current' && r?.current ? (
                      <span className="rnode__bar">
                        <span
                          style={{
                            width: `${Math.min(100, ((now - r.current.startedAt) / Math.max(1, r.current.completesAt - r.current.startedAt)) * 100)}%`,
                          }}
                        />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <aside className="research__detail">
            {sel ? (
              <>
                <div className="research__dhead">
                  <Badge
                    tone={
                      status(sel) === 'done'
                        ? 'green'
                        : status(sel) === 'current'
                          ? 'cyan'
                          : status(sel) === 'locked'
                            ? 'neutral'
                            : 'amber'
                    }
                  >
                    {t(`research.status.${status(sel)}`)}
                  </Badge>
                  <code>{sel.id}</code>
                </div>
                <h3 className="research__dname">{sel.name}</h3>
                {sel.description ? <p className="hint">{sel.description}</p> : null}
                <dl className="research__facts">
                  <div>
                    <dt>{t('research.cost')}</dt>
                    <dd>
                      <Money value={sel.cost.money} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t('research.duration')}</dt>
                    <dd>{formatHours(sel.durationH, t('time.dayUnit'))}</dd>
                  </div>
                  {Object.entries(sel.cost.resources).map(([k, v]) => (
                    <div key={k}>
                      <dt>{t(`game.resources.${k}`)}</dt>
                      <dd>{formatNumber(v ?? 0, 0)}</dd>
                    </div>
                  ))}
                </dl>
                {sel.requires.length ? (
                  <div className="research__sec">
                    <span className="research__label">{t('research.requires')}</span>
                    <ul className="research__reqs">
                      {sel.requires.map((x) => (
                        <li key={x} className={done.has(x) ? 'ok' : ''}>
                          <Icon name={done.has(x) ? 'check' : 'lock'} size={12} />
                          <button
                            type="button"
                            onClick={() => {
                              const n = nodes[x];
                              if (n) {
                                setBranch(n.branch);
                                setSelected(x);
                              }
                            }}
                          >
                            {researchName(x, nodes)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {Object.keys(sel.effects).length ? (
                  <div className="research__sec">
                    <span className="research__label">{t('research.effects')}</span>
                    <ul className="research__effects">
                      {Object.entries(sel.effects).map(([k, v]) => (
                        <li key={k}>
                          <span>
                            {t(`modifiers.${k.replace(/\./g, '_')}`, { defaultValue: k })}
                          </span>
                          <b>
                            {k.endsWith('.level')
                              ? `+${v}`
                              : `${v >= 1 ? '+' : '−'}${formatNumber(Math.abs(v - 1) * 100, 0)} %`}
                          </b>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {unlocks.length ? (
                  <div className="research__sec">
                    <span className="research__label">
                      {t('research.unlocks')} <b>{unlocks.length}</b>
                    </span>
                    <ul className="research__unlocks">
                      {unlocks.slice(0, 8).map((s) => (
                        <li key={s.id}>
                          <WeaponPhoto system={s} photo={photoFor(s, photos)} variant="mini" />
                          <span>{s.name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="research__actions">
                  {status(sel) === 'available' ? (
                    <Button
                      variant="primary"
                      icon={<Icon name="play" size={12} />}
                      disabled={money < sel.cost.money}
                      onClick={() => start(sel)}
                      data-testid="research-start"
                    >
                      {r?.current ? t('research.enqueue') : t('research.start')}
                    </Button>
                  ) : null}
                  {status(sel) === 'locked' ? (
                    <Button
                      variant="subtle"
                      icon={<Icon name="plus" size={12} />}
                      disabled={money < chainOf(sel).reduce((a, x) => a + x.cost.money, 0)}
                      onClick={() => void planChain(sel)}
                      data-testid="research-chain"
                    >
                      {t('research.enqueueChain', {
                        count: chainOf(sel).length,
                        cost: formatMoney(chainOf(sel).reduce((a, x) => a + x.cost.money, 0)),
                      })}
                    </Button>
                  ) : null}
                  {status(sel) === 'current' || status(sel) === 'queued' ? (
                    <Button
                      variant="danger"
                      icon={<Icon name="close" size={12} />}
                      onClick={() =>
                        void send({ kind: 'cancelResearch', nodeId: sel.id }, t('research.removed'))
                      }
                    >
                      {t('research.cancel')}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <EmptyState icon="research" title={t('research.pick')} compact />
            )}
          </aside>
        </div>
      </div>
    </Window>
  );
}
