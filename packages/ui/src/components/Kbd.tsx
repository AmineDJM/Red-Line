import type { ReactNode } from 'react';

/** Touche de clavier (`Ctrl`, `K`, `Entrée`). Plusieurs touches : `<Kbd keys={['Ctrl', 'K']} />`. */
export function Kbd({
  children,
  keys,
  className,
}: {
  children?: ReactNode;
  keys?: string[];
  className?: string;
}) {
  if (keys?.length)
    return (
      <span className={className ? `rl-kbds ${className}` : 'rl-kbds'}>
        {keys.map((k, i) => (
          <kbd key={i} className="rl-kbd">
            {k}
          </kbd>
        ))}
      </span>
    );
  return <kbd className={className ? `rl-kbd ${className}` : 'rl-kbd'}>{children}</kbd>;
}
