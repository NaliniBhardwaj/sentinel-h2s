"""
Applies a CalibrationProfile's piecewise-linear curve to a normalized
optical response value (0..1) to produce an estimated ppm.

This module deliberately keeps "optical response" and "ppm" as distinct
named values end-to-end -- optical intensity is never labeled ppm.
"""
from typing import List, Dict


def apply_curve(optical_response: float, curve_points: List[Dict[str, float]]) -> float:
    pts = sorted(curve_points, key=lambda p: p["response"])
    if not pts:
        raise ValueError("Calibration profile has no curve points")

    if optical_response <= pts[0]["response"]:
        return max(0.0, pts[0]["ppm"])
    if optical_response >= pts[-1]["response"]:
        return max(0.0, pts[-1]["ppm"])

    for a, b in zip(pts, pts[1:]):
        if a["response"] <= optical_response <= b["response"]:
            span = b["response"] - a["response"]
            if span == 0:
                return a["ppm"]
            t = (optical_response - a["response"]) / span
            return a["ppm"] + t * (b["ppm"] - a["ppm"])

    return pts[-1]["ppm"]


# DEMO calibration curve -- NOT scientifically validated. Roughly maps a
# normalized 0..1 colorimetric response to a 0..50 ppm demo range so the
# full pipeline (scan -> ppm -> dose -> risk) can be exercised end-to-end
# during development. Must always be served with is_validated=False.
DEMO_CURVE_POINTS = [
    {"response": 0.0, "ppm": 0.0},
    {"response": 0.15, "ppm": 1.0},
    {"response": 0.35, "ppm": 4.0},
    {"response": 0.5, "ppm": 8.0},
    {"response": 0.65, "ppm": 15.0},
    {"response": 0.8, "ppm": 28.0},
    {"response": 1.0, "ppm": 50.0},
]


# Demo curve for seed data and explicit demo scenarios only — not used for live ML inference.
ML_CURVE_POINTS = DEMO_CURVE_POINTS
