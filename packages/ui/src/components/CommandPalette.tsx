import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Kbd } from './Kbd.js';
import { Prompt } from './Window.js';

export interface CommandSuggestion {
  id: string;
  /** Texte principal (commande, nom d'unité, lieu). */
  label: string;
  /** Texte secondaire aligné à droite (type, distance…). */
  detail?: string;
  /** Aide sous le libellé (syntaxe). */
  hint?: string;
  /** Catégorie affichée en petites capitales à gauche (`cmd`, `unité`, `lieu`). */
  kind?: string;
  /** Texte qui remplace la saisie quand la suggestion est choisie (Tab / clic). */
  insert: string;
  /** Exécute immédiatement au lieu de compléter. */
  run?: boolean;
}

export interface CommandLogLine {
  id: number;
  kind: 'in' | 'ok' | 'err' | 'info';
  text: ReactNode;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (v: string) => void;
  /** Suggestions calculées par l'application pour la saisie courante. */
  suggestions: CommandSuggestion[];
  /** Entrée : exécute la saisie (ou la suggestion active si `run`). */
  onSubmit: (value: string, active: CommandSuggestion | null) => void;
  /** Journal des dernières commandes et réponses. */
  log?: CommandLogLine[];
  /** Historique (flèche haut sur saisie vide). */
  history?: string[];
  placeholder?: string;
  path?: string[];
  /** Libellés d'aide du pied (`{ complete: 'compléter', run: 'exécuter', close: 'fermer' }`). */
  hints?: { complete: string; run: string; close: string; navigate: string };
  label?: string;
  /** Contenu affiché quand aucune suggestion (aide). */
  emptyHelp?: ReactNode;
}

/**
 * Console de commande (Ctrl+K ou `:`) : invite PowerShell, autocomplétion, historique, journal.
 * Composant d'affichage : l'analyse des commandes appartient à l'application.
 */
export function CommandPalette({
  open,
  onClose,
  value,
  onChange,
  suggestions,
  onSubmit,
  log = [],
  history = [],
  placeholder,
  path = ['console'],
  hints = { complete: 'compléter', run: 'exécuter', close: 'fermer', navigate: 'choisir' },
  label = 'Console de commande',
  emptyHelp,
}: CommandPaletteProps) {
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [hist, setHist] = useState(-1);

  useEffect(() => {
    if (open) {
      setHist(-1);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  useEffect(() => setActive(0), [value, suggestions.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log.length]);

  if (!open) return null;
  const cur = suggestions[active] ?? null;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length) setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!value && history.length) {
        const h = Math.min(history.length - 1, hist + 1);
        setHist(h);
        onChange(history[history.length - 1 - h] ?? '');
      } else if (suggestions.length)
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (cur) onChange(cur.insert);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit(value, cur);
    }
  };

  return (
    <div
      className="rl-palette"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="rl-palette__card" role="dialog" aria-modal="true" aria-label={label}>
        {log.length ? (
          <div className="rl-palette__log" ref={logRef} aria-live="polite">
            {log.slice(-8).map((l) => (
              <div key={l.id} className={`rl-palette__line rl-palette__line--${l.kind}`}>
                {l.kind === 'in' ? <span className="rl-palette__line-prompt">&gt;</span> : null}
                {l.text}
              </div>
            ))}
          </div>
        ) : null}
        <div className="rl-palette__input">
          <Prompt path={path} caret={false} />
          <input
            ref={input}
            value={value}
            onChange={(e) => {
              setHist(-1);
              onChange(e.target.value);
            }}
            onKeyDown={onKey}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="rl-palette-list"
            aria-activedescendant={cur ? `rl-palette-${cur.id}` : undefined}
            aria-label={label}
          />
        </div>
        {suggestions.length ? (
          <ul className="rl-palette__list" id="rl-palette-list" role="listbox" ref={listRef}>
            {suggestions.map((s, i) => (
              <li
                key={s.id}
                id={`rl-palette-${s.id}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'rl-palette__opt rl-palette__opt--on' : 'rl-palette__opt'}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (s.run) onSubmit(s.insert, s);
                  else {
                    onChange(s.insert);
                    input.current?.focus();
                  }
                }}
              >
                {s.kind ? <span className="rl-palette__kind">{s.kind}</span> : null}
                <span className="rl-palette__main">
                  <span className="rl-palette__label">{s.label}</span>
                  {s.hint ? <span className="rl-palette__hint">{s.hint}</span> : null}
                </span>
                {s.detail ? <span className="rl-palette__detail">{s.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : emptyHelp ? (
          <div className="rl-palette__help">{emptyHelp}</div>
        ) : null}
        <footer className="rl-palette__foot">
          <span>
            <Kbd keys={['↑', '↓']} /> {hints.navigate}
          </span>
          <span>
            <Kbd>Tab</Kbd> {hints.complete}
          </span>
          <span>
            <Kbd>Entrée</Kbd> {hints.run}
          </span>
          <span>
            <Kbd>Échap</Kbd> {hints.close}
          </span>
        </footer>
      </div>
    </div>
  );
}
