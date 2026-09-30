/** Drapeau d'une nation (flag-icons servi par le client sous /flags), repli sur sa couleur. */
import { useState } from 'react';
import { flagUrl } from '@redline/ui';

export function Flag({ id, color }: { id: string; color?: string }) {
  const [broken, setBroken] = useState(false);
  const url = flagUrl(id);
  if (!url || broken)
    return (
      <span className="flag-ph" style={{ background: color ?? 'var(--t-line2)' }} aria-hidden />
    );
  return <img className="flag" src={url} alt="" loading="lazy" onError={() => setBroken(true)} />;
}

/** Nation : drapeau, nom et code. */
export function Nation(p: { id: string; name?: string; color?: string; code?: boolean }) {
  return (
    <span className="nation">
      <Flag id={p.id} color={p.color} />
      <span className="ellipsis">{p.name ?? p.id.toUpperCase()}</span>
      {p.code !== false && p.name && <span className="code">{p.id}</span>}
    </span>
  );
}
