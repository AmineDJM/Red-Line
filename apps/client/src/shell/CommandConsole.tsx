import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandPalette, type CommandLogLine, type CommandSuggestion } from '@redline/ui';
import { t as tr } from '../i18n/index.js';
import { COMMANDS, parseCommand, suggest, type CommandCtx } from '../lib/commands.js';
import { useGame } from '../store/game.js';
import { useUi } from '../store/ui.js';
import { useWorld } from '../store/world.js';

const HISTORY_KEY = 'rl.console.history';

function readHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Console de commande (Ctrl+K ou « : ») : tout faire au clavier. */
export function CommandConsole() {
  const { t } = useTranslation();
  const open = useUi((s) => s.paletteOpen);
  const seed = useUi((s) => s.paletteSeed);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const view = useGame((s) => s.view);
  const me = useGame((s) => s.me);
  const selection = useUi((s) => s.selection);
  const world = useWorld();
  const [value, setValue] = useState('');
  const [log, setLog] = useState<CommandLogLine[]>([]);
  const [history, setHistory] = useState<string[]>(readHistory);
  const seq = useRef(0);

  useEffect(() => {
    if (open) setValue(seed);
  }, [open, seed]);

  const ctx: CommandCtx | null = useMemo(
    () =>
      view && me
        ? {
            view,
            me,
            catalog: world.catalog,
            provinces: world.provinces,
            nations: world.nations,
            research: world.research,
            selection,
            label: (k, o) => tr(k, o),
          }
        : null,
    [view, me, world.catalog, world.provinces, world.nations, world.research, selection],
  );

  const suggestions: CommandSuggestion[] = useMemo(
    () => (ctx && open ? suggest(value, ctx) : []),
    [ctx, value, open],
  );

  const add = (kind: CommandLogLine['kind'], text: string) =>
    setLog((l) => [...l.slice(-30), { id: ++seq.current, kind, text }]);

  const run = async (input: string, active: CommandSuggestion | null) => {
    if (!ctx) return;
    // Entrée sur une suggestion de commande incomplète : on complète d'abord.
    const trimmed = input.trim();
    if (active && !active.run && (!trimmed || !parseOk(trimmed, ctx))) {
      setValue(active.insert);
      return;
    }
    const line = active?.run && active.insert.startsWith(trimmed.split(' ')[0] ?? '') ? active.insert : trimmed;
    if (!line) return;
    add('in', line);
    const h = [...history.filter((x) => x !== line), line].slice(-50);
    setHistory(h);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    } catch {
      /* stockage indisponible */
    }
    setValue('');
    const a = parseCommand(line, ctx);
    const ui = useUi.getState();
    const conn = useGame.getState().connection;
    switch (a.type) {
      case 'error':
        add('err', a.message);
        return;
      case 'help':
        for (const c of COMMANDS) add('info', `${c.id.padEnd(10)} ${t(`console.help.${c.id}`)}`);
        return;
      case 'clear':
        setLog([]);
        return;
      case 'open':
        ui.openWindow(a.window);
        setOpen(false);
        return;
      case 'goto':
        ui.focusOn(a.at, a.zoom);
        add('ok', a.summary);
        return;
      case 'select':
        ui.select(a.unitIds);
        add('ok', t('console.done.select', { count: a.unitIds.length }));
        return;
      case 'speed':
        conn?.setSpeed(a.speed);
        conn?.setPaused(false);
        add('ok', t('console.done.speed', { speed: a.speed }));
        return;
      case 'pause':
        conn?.setPaused(a.paused);
        add('ok', t(a.paused ? 'console.done.pause' : 'console.done.resume'));
        return;
      case 'order': {
        if (!conn) return add('err', t('game.orders.errors.disconnected'));
        const res = await conn.sendOrder(a.order);
        if (res.ok) add('ok', a.summary);
        else add('err', res.message || t(`game.orders.errors.${res.error ?? 'not_allowed'}`));
      }
    }
  };

  return (
    <CommandPalette
      open={open}
      onClose={() => setOpen(false)}
      value={value}
      onChange={setValue}
      suggestions={suggestions}
      onSubmit={(v, s) => void run(v, s)}
      log={log}
      history={history}
      placeholder={t('console.placeholder')}
      path={[t('console.path')]}
      label={t('console.title')}
      hints={{
        complete: t('console.hints.complete'),
        run: t('console.hints.run'),
        close: t('console.hints.close'),
        navigate: t('console.hints.navigate'),
      }}
      emptyHelp={
        <span>
          {t('console.examples')}{' '}
          <code>move sel alger</code> · <code>produce 4 su-30mka</code> · <code>research aero.gen5</code> ·{' '}
          <code>goto paris</code> · <code>intel infiltrate_spy maroc</code>
        </span>
      }
    />
  );
}

function parseOk(line: string, ctx: CommandCtx): boolean {
  return parseCommand(line, ctx).type !== 'error';
}
