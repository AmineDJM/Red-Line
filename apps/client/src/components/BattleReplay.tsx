import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BattleReport, NationId } from '@redline/shared';
import { Icon, Segmented, Slider } from '@redline/ui';
import { fmtClock } from '../i18n/index.js';
import { useWorld } from '../store/world.js';
import { useGame } from '../store/game.js';
import {
  drawMiniMap,
  shapesOf,
  useOwnerColor,
  type MiniMapLine,
  type MiniMapMarker,
} from './MiniMap.js';

const DURATION_MS = 7000;

/** Replay animé court d'une bataille sur une mini-carte canvas (positions et tirs échantillonnés). */
export function BattleReplay({ report, height = 260 }: { report: BattleReport; height?: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const geo = useWorld((s) => s.provincesGeo);
  const me = useGame((s) => s.me);
  const colorOf = useOwnerColor(undefined, 0.3);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const attackers = new Set<NationId>(report.attacker.nations);
  const { frames, shots, t0, t1 } = report.replay;
  // Cadrage : toutes les positions échantillonnées et tous les tirs (marge de 20 %, 15 km minimum).
  const view = useMemo(() => {
    let x0 = report.at[0],
      x1 = report.at[0],
      y0 = report.at[1],
      y1 = report.at[1];
    const add = (p: [number, number]) => {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    };
    for (const f of frames) for (const u of f.units) add(u.at);
    for (const s of shots) {
      add(s.from);
      add(s.to);
    }
    const center: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const cos = Math.max(0.2, Math.cos((center[1] * Math.PI) / 180));
    const halfW = ((x1 - x0) / 2) * 111.32 * cos;
    // Le canevas est environ 3 fois plus large que haut : la demi-hauteur compte triple.
    const halfH = ((y1 - y0) / 2) * 111.32 * 3;
    return { center, spanKm: Math.max(15, Math.max(halfW, halfH) * 1.2) };
  }, [frames, shots, report.at]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setProgress((p) => {
        const next = p + (dt * speed) / DURATION_MS;
        return next >= 1 ? 0 : next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !geo || !frames.length) return;
    const time = t0 + (t1 - t0) * progress;
    const fi = Math.max(0, Math.min(frames.length - 2, Math.floor(progress * (frames.length - 1))));
    const a = frames[fi]!;
    const b = frames[fi + 1] ?? a;
    const f = frames.length > 1 ? progress * (frames.length - 1) - fi : 0;
    const markers: MiniMapMarker[] = [];
    for (const u of a.units) {
      const nb = b.units.find((x) => x.id === u.id);
      const at: [number, number] = nb
        ? [u.at[0] + (nb.at[0] - u.at[0]) * f, u.at[1] + (nb.at[1] - u.at[1]) * f]
        : u.at;
      const own = u.owner === me;
      markers.push({
        at,
        color: own ? '#9b6bff' : attackers.has(u.owner) ? '#ff4d5e' : '#4cc9f0',
        size: 4,
        shape: 'square',
      });
    }
    const lines: MiniMapLine[] = [];
    for (const s of shots) {
      const age = time - s.t;
      if (age < 0 || age > (t1 - t0) * 0.06) continue;
      lines.push({
        from: s.from,
        to: s.to,
        color: s.hit ? '#ffb020' : 'rgba(255, 176, 32, 0.4)',
        width: s.hit ? 1.4 : 0.8,
        dashed: !s.hit,
      });
      if (s.hit) markers.push({ at: s.to, color: '#ffb020', size: 5, shape: 'ring' });
    }
    drawMiniMap(c, shapesOf(geo), colorOf, {
      center: view.center,
      spanKm: view.spanKm,
      markers,
      lines,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, geo, report]);

  const clock = fmtClock(t0 + (t1 - t0) * progress);
  return (
    <div className="replay">
      <canvas
        ref={ref}
        className="minimap replay__canvas"
        style={{ height }}
        role="img"
        aria-label={t('battles.replay')}
      />
      <div className="replay__hud" aria-hidden>
        <span className="replay__rec">REPLAY</span>
        <span>
          {clock.day} {clock.time}
        </span>
      </div>
      <div className="replay__legend" aria-hidden>
        <span>
          <i style={{ background: '#ff4d5e' }} /> {t('battles.attacker')}
        </span>
        <span>
          <i style={{ background: '#4cc9f0' }} /> {t('battles.defender')}
        </span>
        <span>
          <i style={{ background: '#9b6bff' }} /> {t('battles.you')}
        </span>
      </div>
      <div className="replay__controls">
        <button
          type="button"
          className="replay__play"
          onClick={() => setPlaying(!playing)}
          aria-label={playing ? t('game.clock.pause') : t('game.clock.play')}
        >
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        <Slider
          value={Math.round(progress * 1000)}
          min={0}
          max={1000}
          onChange={(v) => {
            setPlaying(false);
            setProgress(v / 1000);
          }}
          label={t('battles.scrub')}
          format={() => `${Math.round(progress * 100)} %`}
        />
        <Segmented
          size="sm"
          label={t('battles.speed')}
          value={speed}
          onChange={setSpeed}
          options={[1, 2, 4].map((s) => ({ value: s, label: `×${s}` }))}
        />
      </div>
    </div>
  );
}
