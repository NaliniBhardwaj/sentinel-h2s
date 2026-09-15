/**
 * Applies a calibration profile's piecewise-linear curve to a normalized
 * optical response (0..1) -> estimated ppm. Mirrors backend/app/calibration.py.
 * Optical response and ppm are kept as distinct named values throughout —
 * optical intensity is NEVER labeled ppm anywhere in the app.
 */
export interface CurvePoint {
  response: number;
  ppm: number;
}

export function applyCurve(opticalResponse: number, curvePoints: CurvePoint[]): number {
  const pts = [...curvePoints].sort((a, b) => a.response - b.response);
  if (pts.length === 0) throw new Error('Calibration profile has no curve points');

  if (opticalResponse <= pts[0].response) return Math.max(0, pts[0].ppm);
  if (opticalResponse >= pts[pts.length - 1].response) return Math.max(0, pts[pts.length - 1].ppm);

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (opticalResponse >= a.response && opticalResponse <= b.response) {
      const span = b.response - a.response;
      if (span === 0) return a.ppm;
      const t = (opticalResponse - a.response) / span;
      return a.ppm + t * (b.ppm - a.ppm);
    }
  }
  return pts[pts.length - 1].ppm;
}

/**
 * Demo-only calibration curve for explicit simulated scenario chips.
 * NOT used for live camera ML inference. NOT scientifically validated.
 */
export const DEMO_CALIBRATION_PROFILE = {
  id: 'demo-cal-v0',
  name: 'DEMO-CAL-v0',
  chemistryVersion: 'demo-v0',
  modelVersion: 'demo',
  isValidated: false,
  curvePoints: [
    { response: 0.0, ppm: 0.0 },
    { response: 0.15, ppm: 1.0 },
    { response: 0.35, ppm: 4.0 },
    { response: 0.5, ppm: 8.0 },
    { response: 0.65, ppm: 15.0 },
    { response: 0.8, ppm: 28.0 },
    { response: 1.0, ppm: 50.0 },
  ] as CurvePoint[],
};
