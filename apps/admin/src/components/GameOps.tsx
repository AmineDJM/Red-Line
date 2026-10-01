/** Administration d'une partie en direct : spectateur, coût du mois, fin imposée, suppression. */
import { useState } from 'react';
import type { AdminGame, GameCost } from '@redline/shared';
import { useSession } from '../context';
import { useConfirm, useToast } from './overlay';
import { Button, Icon, Win } from './term';
import { T, fmt } from '../i18n';
import { O } from '../i18n/fr-ops';
import { errorMessage } from '../lib/errors';
import { bytes, num } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { money } from '../lib/money';
import { navigate } from '../lib/router';
import '../screens/ops.css';

const G = O.game;

export function GameOpsPanel({ game: g, onGone }: { game: AdminGame; onGone: () => void }) {
  const { api, user } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const superadmin = user.role === 'superadmin';
  const cost = useLoad<GameCost | null>(
    () => (superadmin ? api.gameCost(g.game.id).then((r) => r.cost) : Promise.resolve(null)),
    [api, g.game.id, superadmin],
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const live = g.game.status !== 'lobby';

  const end = async () => {
    if (
      !(await confirm({
        title: G.end,
        message: fmt(G.endConfirm, { name: g.game.name }),
        danger: true,
        confirm: G.end,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.endGame(g.game.id, message.trim() || undefined);
      toast(G.endDone);
      onGone();
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: G.delete,
        message: fmt(G.deleteConfirm, { name: g.game.name }),
        danger: true,
        confirm: G.delete,
        typeToConfirm: g.game.id.slice(0, 8),
      }))
    )
      return;
    setBusy(true);
    try {
      await api.deleteGame(g.game.id, g.game.id.slice(0, 8));
      toast(G.deleteDone);
      onGone();
      navigate({ name: 'games' });
    } catch (e) {
      toast(errorMessage(e, T.roles.superadmin), 'error');
    } finally {
      setBusy(false);
    }
  };

  const c = cost.data;
  return (
    <Win title={G.manage} glyph="⚙">
      <div className="ops-actions">
        <div className="ops-row">
          {live && (
            <a
              className="btn btn-sm"
              href={`/spectate/${encodeURIComponent(g.game.id)}`}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="eye" size={12} /> {G.spectate}
            </a>
          )}
        </div>
        {superadmin && (
          <p className="small" style={{ margin: 0 }}>
            <span className="dim">{G.cost} : </span>
            {c
              ? fmt(G.costLine, {
                  c: money(c.cost.total),
                  cpu: `${num(c.cpuS, 1)} s`,
                  mem: `${num(c.memMbH, 0)} Mo·h`,
                  st: bytes(c.storageBytes),
                })
              : G.costNone}
          </p>
        )}
        {superadmin && (
          <div className="field">
            <label htmlFor="go-msg">{G.endMessage}</label>
            <div className="ops-row">
              <input
                id="go-msg"
                className="input"
                maxLength={500}
                placeholder={G.endPlaceholder}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <Button variant="danger" disabled={busy} onClick={() => void end()}>
                <Icon name="pause" size={12} /> {G.end}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                <Icon name="close" size={12} /> {G.delete}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Win>
  );
}
