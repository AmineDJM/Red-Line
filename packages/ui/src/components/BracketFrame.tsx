import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

export interface BracketFrameProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** Couleur des crochets. */
  accent?: string;
  /** Fond du cadre : sombre (défaut), clair (légende) ou transparent. */
  tone?: 'dark' | 'light' | 'none';
  padded?: boolean;
}

/** Cadre sombre à coins en crochets (fiche d'arme, panneaux d'information). */
export function BracketFrame({
  children,
  accent,
  tone = 'dark',
  padded = true,
  className,
  style,
  ...rest
}: BracketFrameProps) {
  const s: CSSProperties = accent ? { ...style, ['--rl-bracket-color' as string]: accent } : { ...style };
  return (
    <div
      {...rest}
      className={['rl-bracket', `rl-bracket--${tone}`, padded ? 'rl-bracket--padded' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      style={s}
    >
      <span className="rl-bracket__c rl-bracket__c--tl" aria-hidden />
      <span className="rl-bracket__c rl-bracket__c--tr" aria-hidden />
      <span className="rl-bracket__c rl-bracket__c--bl" aria-hidden />
      <span className="rl-bracket__c rl-bracket__c--br" aria-hidden />
      {children}
    </div>
  );
}
