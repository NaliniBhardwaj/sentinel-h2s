/**
 * Deterministic plant-map layout. Codes MUST match backend seed zones
 * (`backend/app/seed.py` ZONES). This is geometry only — risk/ppm always
 * come from GET /zones, never from values invented in this file.
 */
export interface ZoneLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export const ZONE_LAYOUT: Record<string, ZoneLayout> = {
  'comp-a': { x: 10, y: 10, w: 150, h: 90, label: 'Compressor A' },
  'comp-b': { x: 200, y: 10, w: 150, h: 90, label: 'Compressor B' },
  storage: { x: 10, y: 120, w: 60, h: 110, label: 'Storage' },
  processing: { x: 90, y: 120, w: 180, h: 110, label: 'Processing Unit' },
  pipeline: { x: 290, y: 120, w: 70, h: 110, label: 'Pipeline' },
  workshop: { x: 10, y: 250, w: 60, h: 60, label: 'Workshop' },
  control: { x: 90, y: 250, w: 180, h: 60, label: 'Control Room' },
};

/** Suggested safer route polyline (not a guaranteed safe route). */
export const SAFE_ROUTE_PATH = 'M 304 168 L 304 242 L 270 242 Q 260 242 260 252 L 260 278 L 178 278';
