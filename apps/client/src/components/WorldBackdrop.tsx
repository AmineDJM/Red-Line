import { memo } from 'react';

/**
 * Fond animé discret de l'accueil : carte du monde en matrice de points (/world.svg, ~9 Kio, générée par
 * « pnpm --filter @redline/site world »), échos radar sur quelques capitales et trajectoires en grand
 * cercle. Sans WebGL ni données à charger ; seules des animations composées (transform, opacity), donc
 * sans travail du fil principal ; coupées si l'utilisateur préfère réduire les mouvements. Repère identique à world.svg : 1 unité = 1°, lon −180…180, lat 84…−56.
 */
const NORTH = 84;
const W = 360;
const H = 140;

type LonLat = [number, number];

const CAPITALS: Record<string, LonLat> = {
  usa: [-77.04, 38.9],
  rus: [37.62, 55.75],
  chn: [116.4, 39.9],
  fra: [2.35, 48.86],
  gbr: [-0.13, 51.5],
  ind: [77.2, 28.6],
  bra: [-47.9, -15.8],
  irn: [51.4, 35.7],
  jpn: [139.7, 35.7],
  ukr: [30.5, 50.45],
  tur: [32.85, 39.93],
  egy: [31.24, 30.04],
  aus: [149.1, -35.3],
  zaf: [28.19, -25.75],
  kor: [126.98, 37.57],
  isr: [35.2, 31.77],
  pak: [73.05, 33.7],
  nga: [7.5, 9.06],
};

const ARCS: [string, string][] = [
  ['usa', 'rus'],
  ['chn', 'jpn'],
  ['fra', 'egy'],
  ['irn', 'isr'],
  ['ind', 'chn'],
  ['gbr', 'ukr'],
];

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Points d'un grand cercle (interpolation sphérique). */
export function greatCircle(a: LonLat, b: LonLat, n = 32): LonLat[] {
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
      ),
    );
  if (!d) return [a, b];
  return Array.from({ length: n + 1 }, (_, i) => {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    return [deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))] as LonLat;
  });
}

const xy = ([lon, lat]: LonLat) => [lon + 180, NORTH - lat] as const;

const PATHS = ARCS.map(
  ([a, b]) =>
    'M' +
    greatCircle(CAPITALS[a]!, CAPITALS[b]!)
      .map((p) =>
        xy(p)
          .map((v) => v.toFixed(1))
          .join(' '),
      )
      .join('L'),
);

export const WorldBackdrop = memo(function WorldBackdrop() {
  return (
    <div className="worldbg" aria-hidden>
      <div className="worldbg__box">
        <img className="worldbg__dots" src="/world.webp" width={W * 4} height={H * 4} alt="" />
        <svg className="worldbg__arcs" viewBox={`0 0 ${W} ${H}`} focusable="false">
          {PATHS.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
        <div className="worldbg__pings">
          {Object.values(CAPITALS).map(([lon, lat], i) => (
            <i
              key={i}
              style={{
                left: `${(((lon + 180) / W) * 100).toFixed(2)}%`,
                top: `${(((NORTH - lat) / H) * 100).toFixed(2)}%`,
                animationDelay: `${(i * 0.45).toFixed(2)}s`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
