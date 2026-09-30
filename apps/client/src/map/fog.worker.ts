import { fogPolygon, unionAll, type SensorCircle } from './fogGeometry.js';

type Poly = [number, number][][];

export type FogRequest =
  | { type: 'territory'; key: string; polygons: Poly[] }
  | { type: 'sensors'; seq: number; circles: SensorCircle[] };

export interface FogResponse {
  seq: number;
  coordinates: Poly[];
  ms: number;
}

let territory: Poly[] = [];
let lastCircles: SensorCircle[] = [];
let lastSeq = 0;

const scope = self as unknown as { onmessage: ((e: MessageEvent<FogRequest>) => void) | null; postMessage(m: FogResponse): void };

function compute(seq: number) {
  const t0 = performance.now();
  const coordinates = fogPolygon(territory, lastCircles);
  scope.postMessage({ seq, coordinates, ms: performance.now() - t0 });
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'territory') {
    territory = unionAll(msg.polygons.map((p) => [p]));
    compute(lastSeq);
  } else {
    lastCircles = msg.circles;
    lastSeq = msg.seq;
    compute(msg.seq);
  }
};
