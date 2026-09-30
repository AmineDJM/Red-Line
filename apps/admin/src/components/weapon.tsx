/** Fiche d'arme : pictogramme hexagonal, photo réelle avec crédit, aperçu au style du jeu. */
import { useState, type ReactNode } from 'react';
import { TARGET_CLASSES, type WeaponSystem } from '@redline/shared';
import type { PhotoEntry } from '../api/types';
import { T, fmt } from '../i18n';
import { hours, num, usd } from '../lib/format';
import { photoUrl } from '../lib/refs';

const GLYPHS: Record<string, ReactNode> = {
  fighter: (
    <path d="M12 3l1.4 5.2 6.1 3.6v1.6l-6-1.6-.5 4.3 2.2 1.7v1.3L12 18.4l-3.2.7v-1.3l2.2-1.7-.5-4.3-6 1.6v-1.6l6.1-3.6z" />
  ),
  bomber: (
    <path d="M12 4l1.2 5 7.8 4v1.8l-7.6-2-.4 4.2 2.5 1.8v1.2L12 19l-3.5 1v-1.2l2.5-1.8-.4-4.2-7.6 2V13l7.8-4z" />
  ),
  tank: <path d="M5 13h14l1.5 2.5-1.5 2.5H5l-1.5-2.5zM8 9.5h6l1.5 3.5h-9zM14 10.5h6v1h-6z" />,
  ifv: <path d="M4 12.5h15l1.5 2.5-1.5 2.5H5.5L4 15zM7 9.5h7l2 3H7zM15 10.5h4v1h-4z" />,
  artillery: <path d="M4 15h12l1.5 2H3zM9 12l9-6 .8 1.2-9 6zM6 12.5h6v2.5H6z" />,
  air_defense: (
    <path d="M6 16h12v2H6zM8 13h8l1 3H7zM11 13l4-8 1.3.6-4 7.4zM8.2 13l2.2-6 1.2.4-2 5.6z" />
  ),
  radar: (
    <path d="M11 11h2v7h-2zM7 18h10v1.5H7zM12 4a7 7 0 016.3 4l-1.4.7A5.5 5.5 0 0012 5.5a5.5 5.5 0 00-4.9 3.2L5.7 8A7 7 0 0112 4zm0 3a4 4 0 013.6 2.3l-1.4.7A2.5 2.5 0 0012 8.5a2.5 2.5 0 00-2.2 1.5l-1.4-.7A4 4 0 0112 7z" />
  ),
  drone: <path d="M3 11.2h18v1.6H3zM11 7h2v10h-2zM8.5 16h7v1.4h-7zM10.5 5.5h3V8h-3z" />,
  helicopter: (
    <path d="M3 6h18v1.3H3zM11.3 7h1.4v2h-1.4zM7 10h8.5a3 3 0 010 6H9l-2-2.2zM15 12.5h6v1h-6zM8 17h9v1.2H8z" />
  ),
  infantry: <path d="M12 4.5a2 2 0 110 4 2 2 0 010-4zM9.5 9.5h5l1 5h-1.8l-.5 5h-2.4l-.5-5H8.5z" />,
  surface_ship: <path d="M3 14h18l-2.5 4h-13zM7 10h8l1 4H6zM10 6.5h2v3.5h-2z" />,
  submarine: (
    <path d="M4 12.5c0-1.4 1.6-2.5 3.5-2.5h9c1.9 0 3.5 1.1 3.5 2.5S18.4 15 16.5 15h-9C5.6 15 4 13.9 4 12.5zM10 7.5h3V10h-3z" />
  ),
  strike_missile: (
    <path d="M4 18l11-11 2 .5.5 2L6.5 20.5zM15 7l3-3 2 2-3 3zM5 15l-2 1 1 2zM9 19l-1 2 2-1z" />
  ),
  nuclear: (
    <path d="M12 10.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 4a8 8 0 016.9 4L14.3 11a2.6 2.6 0 00-4.6 0L5.1 8A8 8 0 0112 4zM5 16.1l4.6-2.7a2.6 2.6 0 002.4 1.4V20a8 8 0 01-7-3.9zM19 16.1A8 8 0 0112 20v-5.2a2.6 2.6 0 002.4-1.4z" />
  ),
  space: <path d="M10 10h4v4h-4zM3 9.5h6v5H3zM15 9.5h6v5h-6zM11.3 5h1.4v5h-1.4z" />,
  logistics: (
    <path d="M3 8h11v8H3zM14 11h4l3 3v2h-7zM6 16.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM17 16.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" />
  ),
  air_support: (
    <path d="M12 3.5l1 5.5 7.5 3.2v1.5l-7.3-1.6-.4 4.5 2.3 1.7v1.2L12 18.6l-3.1.9v-1.2l2.3-1.7-.4-4.5-7.3 1.6v-1.5L11 9z" />
  ),
};

export function HexIcon(props: { icon: string; size?: number; muted?: boolean }) {
  const size = props.size ?? 30;
  return (
    <svg
      className={`hex ${props.muted ? 'muted' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <polygon points="12,0.8 21.8,6.4 21.8,17.6 12,23.2 2.2,17.6 2.2,6.4" className="hex-bg" />
      <g className="hex-glyph" transform="translate(3.6 3.6) scale(0.7)">
        {GLYPHS[props.icon] ?? (
          <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700">
            {props.icon.slice(0, 2).toUpperCase()}
          </text>
        )}
      </g>
    </svg>
  );
}

/** Vignette de la liste (photo réduite, sinon pictogramme). */
export function Thumb({
  photo,
  icon,
  muted,
}: {
  photo?: PhotoEntry | null;
  icon: string;
  muted?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  if (photo && !broken)
    return (
      <img
        className="thumb"
        src={photoUrl(photo.file, true)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  return (
    <span className="thumb-ph">
      <HexIcon icon={icon} size={24} muted={muted} />
    </span>
  );
}

/** Photo réelle avec crédit, licence et source (exigence d'Amine). */
export function Photo({ photo, alt }: { photo: PhotoEntry | null | undefined; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (!photo)
    return (
      <div className="photo">
        <div className="photo-empty">{T.editor.photoNone}</div>
      </div>
    );
  return (
    <figure className="photo">
      {broken ? (
        <div className="photo-empty">{photo.file}</div>
      ) : (
        <img src={photoUrl(photo.file)} alt={alt} onError={() => setBroken(true)} />
      )}
      <figcaption>
        © {photo.credit} · {photo.license} ·{' '}
        <a href={photo.sourceUrl} target="_blank" rel="noreferrer noopener">
          {T.editor.source}
        </a>
      </figcaption>
    </figure>
  );
}

type Loose<X> = { [K in keyof X]?: X[K] extends object ? Partial<X[K]> | null : X[K] };
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Aperçu de la fiche au style du jeu. */
export function WeaponCard({
  system,
  photo,
}: {
  system: Loose<WeaponSystem>;
  photo?: PhotoEntry | null;
}) {
  const s = system;
  const sheet = s.sheet ?? {};
  const rows: [string, string][] = [];
  const add = (label: string, v: string | null) => v && rows.push([label, v]);
  add(T.sheet.unitPrice, n(s.unitPriceUsd) != null ? usd(s.unitPriceUsd) : null);
  add(T.sheet.cost, n(s.cost?.money) != null ? usd(s.cost!.money) : null);
  add(
    T.sheet.upkeep,
    n(s.upkeepPerDay) != null ? `${usd(s.upkeepPerDay)} ${T.sheet.perDay}` : null,
  );
  add(T.sheet.build, n(s.buildTimeH) != null ? hours(s.buildTimeH) : null);
  add(
    T.sheet.era,
    s.era?.introduced ? `${s.era.introduced}${s.era.retired ? ` – ${s.era.retired}` : ''}` : null,
  );
  add(T.sheet.engine, sheet.engine ?? null);
  add(
    T.sheet.speed,
    sheet.speedLabel ?? (n(s.speedKmh) != null ? `${num(s.speedKmh)} km/h` : null),
  );
  add(T.sheet.radius, n(s.operationalRadiusKm) != null ? `${num(s.operationalRadiusKm)} km` : null);
  add(
    T.sheet.weaponRange,
    s.weaponRangeKm ? `${num(n(s.weaponRangeKm.min))} – ${num(n(s.weaponRangeKm.max))} km` : null,
  );
  add(T.sheet.detection, n(s.detectionRangeKm) != null ? `${num(s.detectionRangeKm)} km` : null);
  add(
    T.sheet.hp,
    n(s.hp) != null
      ? `${num(s.hp)}${n(s.unitSize) && s.unitSize! > 1 ? ` ${fmt(T.sheet.unitSize, { n: s.unitSize! })}` : ''}`
      : null,
  );
  if (n(s.stealth) && s.stealth! > 0) add(T.sheet.stealth, `${Math.round(s.stealth! * 100)} %`);
  add(
    T.sheet.gates,
    s.requires?.length
      ? s.requires.map((r) => String(r).replace(/^research\./, '')).join(', ')
      : null,
  );
  const dmg = s.damage ?? {};
  const maxDmg = Math.max(20, ...TARGET_CLASSES.map((c) => n(dmg[c]) ?? 0));
  return (
    <article className={`wcard ${s.enabled === false ? 'off' : ''}`}>
      <Photo photo={photo} alt={s.name ?? ''} />
      <header className="wcard-head">
        <HexIcon icon={s.icon || s.category || '?'} size={38} />
        <div className="grow">
          <div className="wcard-name">{s.name || '—'}</div>
          <div className="wcard-sub">
            {s.doctrine ? T.doctrines[s.doctrine] : '—'} ·{' '}
            {s.category ? T.categories[s.category] : '—'}
            {n(s.generation) != null && <> · {fmt(T.sheet.generation, { n: s.generation! })}</>}
          </div>
        </div>
        {s.enabled === false && <span className="badge badge-off">{T.sheet.disabled}</span>}
      </header>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd className={k === T.sheet.unitPrice || k === T.sheet.cost ? 'c-amber' : undefined}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="section-title">{T.sheet.damageTitle}</div>
        <div className="dmg">
          {TARGET_CLASSES.map((c) => {
            const v = n(dmg[c]) ?? 0;
            return (
              <div key={c} style={{ display: 'contents' }}>
                <span className="muted">{T.targetClasses[c]}</span>
                <span className="bar">
                  <span style={{ width: `${(v / maxDmg) * 100}%` }} />
                </span>
                <span className="v">{num(v)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}
