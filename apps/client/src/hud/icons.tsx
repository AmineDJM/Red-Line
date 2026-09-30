/** Icônes d'interface au trait (barre d'outils, ressources, horloge). */
import type { ReactNode } from 'react';

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const Icons = {
  army: (s?: number) => (
    <Svg size={s}>
      <path d="M21 12 L16.5 19.8 L7.5 19.8 L3 12 L7.5 4.2 L16.5 4.2 Z" />
      <path d="M8.5 13.5 L12 9.5 L15.5 13.5" />
    </Svg>
  ),
  factory: (s?: number) => (
    <Svg size={s}>
      <path d="M3 20 L3 11 L8 14 L8 11 L13 14 L13 11 L18 14 L18 5 L21 5 L21 20 Z" />
      <path d="M9 20 L9 17 L12 17 L12 20" />
    </Svg>
  ),
  bell: (s?: number) => (
    <Svg size={s}>
      <path d="M6 16 L6 11 C6 7.5 8.5 5 12 5 C15.5 5 18 7.5 18 11 L18 16 L20 18 L4 18 Z" />
      <path d="M10 20.5 C10.5 21.3 11.2 21.6 12 21.6 C12.8 21.6 13.5 21.3 14 20.5" />
    </Svg>
  ),
  layers: (s?: number) => (
    <Svg size={s}>
      <path d="M12 4 L21 9 L12 14 L3 9 Z" />
      <path d="M3 13 L12 18 L21 13" />
    </Svg>
  ),
  legend: (s?: number) => (
    <Svg size={s}>
      <path d="M4 5 L20 5 L20 19 L4 19 Z" />
      <path d="M7 9 L9 9 M11 9 L17 9 M7 12 L9 12 M11 12 L17 12 M7 15 L9 15 M11 15 L17 15" />
    </Svg>
  ),
  pause: (s?: number) => (
    <Svg size={s}>
      <path d="M8 5 L8 19 M16 5 L16 19" strokeWidth="2.6" />
    </Svg>
  ),
  play: (s?: number) => (
    <Svg size={s}>
      <path d="M7 4.5 L19 12 L7 19.5 Z" fill="currentColor" />
    </Svg>
  ),
  target: (s?: number) => (
    <Svg size={s}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2 L12 6 M12 18 L12 22 M2 12 L6 12 M18 12 L22 12" />
    </Svg>
  ),
  close: (s?: number) => (
    <Svg size={s}>
      <path d="M6 6 L18 18 M18 6 L6 18" strokeWidth="2" />
    </Svg>
  ),
  sandbox: (s?: number) => (
    <Svg size={s}>
      <path d="M4 20 L20 20 M6 20 L6 12 L10 12 L10 20 M14 20 L14 8 L18 8 L18 20" />
      <path d="M8 12 L8 8 M16 8 L16 4" />
    </Svg>
  ),
  money: (s?: number) => (
    <Svg size={s}>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.8 9 C14.2 8.2 13.2 7.8 12 7.8 C10.5 7.8 9.4 8.6 9.4 9.8 C9.4 12.6 14.8 11.2 14.8 14.1 C14.8 15.4 13.6 16.2 12 16.2 C10.7 16.2 9.6 15.7 9 14.8 M12 6 L12 7.8 M12 16.2 L12 18" />
    </Svg>
  ),
  oil: (s?: number) => (
    <Svg size={s}>
      <path d="M12 3.5 C12 3.5 6.5 10 6.5 14 C6.5 17.2 9 19.8 12 19.8 C15 19.8 17.5 17.2 17.5 14 C17.5 10 12 3.5 12 3.5 Z" />
    </Svg>
  ),
  metals: (s?: number) => (
    <Svg size={s}>
      <path d="M3 17 L6 10 L13 10 L10 17 Z" />
      <path d="M11 17 L14 10 L21 10 L18 17 Z" />
      <path d="M7 10 L9.5 5 L16.5 5 L14 10" />
    </Svg>
  ),
  electronics: (s?: number) => (
    <Svg size={s}>
      <path d="M7 7 L17 7 L17 17 L7 17 Z" />
      <path d="M10 10 L14 10 L14 14 L10 14 Z" />
      <path d="M9.5 4 L9.5 7 M14.5 4 L14.5 7 M9.5 17 L9.5 20 M14.5 17 L14.5 20 M4 9.5 L7 9.5 M4 14.5 L7 14.5 M17 9.5 L20 9.5 M17 14.5 L20 14.5" />
    </Svg>
  ),
  food: (s?: number) => (
    <Svg size={s}>
      <path d="M12 21 L12 8" />
      <path d="M12 9 C9.5 9 8.5 7 8.5 5 C10.8 5 12 6.5 12 9 Z M12 9 C14.5 9 15.5 7 15.5 5 C13.2 5 12 6.5 12 9 Z" />
      <path d="M12 14 C9.5 14 8.5 12 8.5 10 C10.8 10 12 11.5 12 14 Z M12 14 C14.5 14 15.5 12 15.5 10 C13.2 10 12 11.5 12 14 Z" />
    </Svg>
  ),
  search: (s?: number) => (
    <Svg size={s}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15 L20 20" />
    </Svg>
  ),
  stop: (s?: number) => (
    <Svg size={s}>
      <path d="M7 7 L17 7 L17 17 L7 17 Z" fill="currentColor" />
    </Svg>
  ),
};
