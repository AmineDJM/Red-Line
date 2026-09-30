import type { ReactNode } from 'react';
import { HexIcon } from './HexIcon.js';
import type { PictogramId } from '../pictograms.js';

export type LegendItem =
  | { kind: 'hex'; label: string; color: string; pictogram?: PictogramId }
  | {
      kind: 'line';
      label: string;
      color: string;
      dashed?: boolean;
      arrow?: boolean;
      width?: number;
    }
  | { kind: 'swatch'; label: string; color: string; glow?: boolean }
  | { kind: 'ring'; label: string; color: string }
  | { kind: 'hatch'; label: string; color: string }
  | { kind: 'triangle'; label: string; color: string; badge?: string };

export interface LegendProps {
  title: string;
  items: LegendItem[];
  footer?: ReactNode;
  className?: string;
}

function Mark({ item }: { item: LegendItem }) {
  switch (item.kind) {
    case 'hex':
      return <HexIcon pictogram={item.pictogram} color={item.color} size={22} outline={null} />;
    case 'line':
      return (
        <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden>
          <line
            x1="2"
            y1="7"
            x2={item.arrow ? 21 : 26}
            y2="7"
            stroke={item.color}
            strokeWidth={item.width ?? 2.5}
            strokeDasharray={item.dashed ? '4 3' : undefined}
            strokeLinecap="round"
          />
          {item.arrow ? <path d="M20 2.5 L27 7 L20 11.5 Z" fill={item.color} /> : null}
        </svg>
      );
    case 'swatch':
      return (
        <span
          className="rl-legend__swatch"
          style={{
            background: item.color,
            boxShadow: item.glow ? `0 0 6px 1px ${item.color}` : undefined,
          }}
          aria-hidden
        />
      );
    case 'ring':
      return (
        <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden>
          <path d="M3 16 A11 11 0 0 1 25 16" fill="none" stroke={item.color} strokeWidth="2.5" />
          <path
            d="M8 16 A6 6 0 0 1 20 16"
            fill="none"
            stroke={item.color}
            strokeOpacity="0.5"
            strokeWidth="1"
          />
          <path
            d="M3 16 A11 11 0 0 1 25 16 L20 16 A6 6 0 0 0 8 16 Z"
            fill={item.color}
            fillOpacity="0.28"
          />
        </svg>
      );
    case 'hatch':
      return (
        <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden>
          <defs>
            <pattern
              id={`rl-h-${item.color.replace(/[^a-z0-9]/gi, '')}`}
              width="4"
              height="4"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="4" stroke={item.color} strokeWidth="1.6" />
            </pattern>
          </defs>
          <rect
            x="1"
            y="1"
            width="26"
            height="14"
            fill={`url(#rl-h-${item.color.replace(/[^a-z0-9]/gi, '')})`}
            stroke={item.color}
            strokeOpacity="0.6"
          />
        </svg>
      );
    case 'triangle':
      return (
        <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden>
          <path d="M4 16 L12 2 L20 16 Z" fill={item.color} />
          {item.badge ? (
            <>
              <circle cx="21" cy="6" r="5" fill="var(--rl-red)" />
              <text
                x="21"
                y="8.6"
                textAnchor="middle"
                fontSize="7.5"
                fontWeight="700"
                fill="#fff"
                fontFamily="var(--rl-font-mono)"
              >
                {item.badge}
              </text>
            </>
          ) : null}
        </svg>
      );
  }
}

/** Légende : panneau gris clair translucide, icônes hexagonales et lignes colorées. */
export function Legend({ title, items, footer, className }: LegendProps) {
  return (
    <section className={className ? `rl-legend ${className}` : 'rl-legend'} aria-label={title}>
      <h3 className="rl-legend__title">{title}</h3>
      <ul className="rl-legend__list">
        {items.map((it, i) => (
          <li key={i} className="rl-legend__item">
            <span className="rl-legend__mark">
              <Mark item={it} />
            </span>
            <span className="rl-legend__label">{it.label}</span>
          </li>
        ))}
      </ul>
      {footer}
    </section>
  );
}
