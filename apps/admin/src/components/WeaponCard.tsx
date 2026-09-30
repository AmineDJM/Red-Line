/** Aperçu de la fiche d'arme au style du jeu (cartouche marine, valeurs orange, efficacité par cible). */
import { TARGET_CLASSES, type WeaponSystem } from '@redline/shared';
import { T, fmt, num } from '../i18n';
import { HexIcon } from './ui';

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> | null : T[K] };

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function WeaponCard({ system }: { system: Partial2<WeaponSystem> }) {
  const s = system;
  const sheet = s.sheet ?? {};
  const doctrine = s.doctrine ? T.doctrines[s.doctrine] : '—';
  const category = s.category ? T.categories[s.category] : '—';
  const rows: [string, string][] = [];
  const add = (label: string, v: string | null) => v && rows.push([label, v]);
  add(T.sheet.engine, sheet.engine ?? null);
  add(T.sheet.length, n(sheet.lengthM) != null ? `${num(sheet.lengthM)} m` : null);
  add(T.sheet.wingspan, n(sheet.wingspanM) != null ? `${num(sheet.wingspanM)} m` : null);
  add(T.sheet.mtow, n(sheet.mtowKg) != null ? `${num(sheet.mtowKg)} kg` : null);
  add(T.sheet.warhead, n(sheet.warheadKg) != null ? `${num(sheet.warheadKg)} kg` : null);
  add(
    T.sheet.speed,
    sheet.speedLabel ?? (n(s.speedKmh) != null ? `${num(s.speedKmh)} km/h` : null),
  );
  add(T.sheet.range, n(sheet.rangeKm) != null ? `${num(sheet.rangeKm)} km` : null);

  const res = s.cost?.resources ?? {};
  const resText = Object.entries(res)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(
      ([k, v]) =>
        `${num(v as number)} ${T.resources[k as keyof typeof T.resources]?.toLowerCase() ?? k}`,
    )
    .join(' · ');
  const game: [string, string][] = [
    [T.sheet.cost, `${num(n(s.cost?.money))}${resText ? ` + ${resText}` : ''}`],
    [T.sheet.build, n(s.buildTimeH) != null ? `${num(s.buildTimeH)} h` : '—'],
    [
      T.sheet.weaponRange,
      s.weaponRangeKm ? `${num(n(s.weaponRangeKm.min))} – ${num(n(s.weaponRangeKm.max))} km` : '—',
    ],
    [T.sheet.detection, n(s.detectionRangeKm) != null ? `${num(s.detectionRangeKm)} km` : '—'],
    [
      T.sheet.hp,
      `${num(n(s.hp))}${n(s.unitSize) && s.unitSize! > 1 ? ` ${fmt(T.sheet.unitSize, { n: s.unitSize! })}` : ''}`,
    ],
  ];
  if (n(s.operationalRadiusKm) != null)
    game.splice(2, 0, [T.sheet.radius, `${num(s.operationalRadiusKm)} km`]);
  if (n(s.stealth) && s.stealth! > 0)
    game.push([T.sheet.stealth, `${Math.round(s.stealth! * 100)} %`]);

  const dmg = s.damage ?? {};
  const maxDmg = Math.max(20, ...TARGET_CLASSES.map((c) => n(dmg[c]) ?? 0));

  return (
    <article className={`weapon-card ${s.enabled === false ? 'weapon-card-off' : ''}`}>
      <header className="wc-head">
        <HexIcon icon={s.icon || 'unknown'} size={46} />
        <div className="wc-titles">
          <h3 className="wc-name">{s.name || '—'}</h3>
          <div className="wc-sub">
            {doctrine} · {category}
            {n(s.generation) != null && <> · {fmt(T.sheet.generation, { n: s.generation! })}</>}
          </div>
        </div>
        {s.enabled === false && <span className="wc-off">{T.sheet.disabled}</span>}
      </header>
      {rows.length > 0 && (
        <dl className="wc-rows">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <dl className="wc-rows wc-game">
        {game.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="wc-dmg">
        <div className="wc-dmg-title">{T.sheet.damageTitle}</div>
        {TARGET_CLASSES.map((c) => {
          const v = n(dmg[c]) ?? 0;
          return (
            <div className="wc-dmg-row" key={c} title={`${T.targetClasses[c]} : ${v}`}>
              <span>{T.targetClasses[c]}</span>
              <span className="wc-bar">
                <span style={{ width: `${(v / maxDmg) * 100}%` }} />
              </span>
              <span className="mono">{v}</span>
            </div>
          );
        })}
      </div>
    </article>
  );
}
