"""Load trained sklearn model and run strip-card ML analysis on raw JPEG bytes."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import joblib
import numpy as np

from app.config import settings
from app.ml.badge_layout import FEATURE_SCHEMA_VERSION, STRIP_RECT
from app.ml.features import (
    FEATURE_SCHEMA,
    check_quality,
    extract_features_from_corrected,
    features_to_vector,
)
from app.ml.preprocessing import preprocess_strip_card, roi_bgr

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"
MODEL_NAME = "sentinel_h2s_model_v1.joblib"
METADATA_NAME = "sentinel_h2s_model_v1_metadata.json"


class MlNotAvailableError(Exception):
    pass


class MlStatus(str, Enum):
    OK = "OK"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"


class QualityState(str, Enum):
    GOOD = "GOOD"
    ACCEPTABLE = "ACCEPTABLE"
    LOW_QUALITY = "LOW_QUALITY"
    RETRY_REQUIRED = "RETRY_REQUIRED"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"


@dataclass
class MlProof:
    strip_rgb: List[float]
    corrected_strip_rgb: List[float]
    hsv: Dict[str, float]
    lab: Dict[str, float]
    reference_patches_measured: List[List[float]]
    reference_patch_delta_e: float
    preprocessing_method: str
    model_version: str
    dataset_type: str
    top_features: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class MlAnalysisResult:
    status: MlStatus
    quality_state: QualityState
    delta_e: float
    strip_lab: Tuple[float, float, float]
    predicted_ppm: Optional[float]
    optical_response: float
    dose_ppm_min: Optional[float]
    estimated_ppm: Optional[float]
    model_version: str
    label_source: str
    is_lab_validated: bool
    delta_e_max: float
    quality_ok: bool
    quality_reason: Optional[str] = None
    ml_proof: Optional[MlProof] = None


_payload_cache: Optional[Dict[str, Any]] = None


def _load_payload() -> Dict[str, Any]:
    global _payload_cache
    if _payload_cache is not None:
        return _payload_cache

    candidates = [
        ARTIFACTS_DIR / MODEL_NAME,
        Path(settings.ML_MODEL_PATH) if settings.ML_MODEL_PATH else None,
    ]
    for model_path in candidates:
        if model_path and model_path.exists():
            _payload_cache = joblib.load(model_path)
            return _payload_cache

    raise MlNotAvailableError("ML model not found. Run sentinel/ml/run_pipeline.py.")


def _quality_state_from_signals(
    quality_ok: bool,
    ref_delta_e: float,
    uniformity_ok: bool,
    card_detected: bool,
) -> QualityState:
    if not quality_ok:
        return QualityState.RETRY_REQUIRED
    if ref_delta_e > 12.0 or not uniformity_ok:
        return QualityState.LOW_QUALITY
    if not card_detected:
        return QualityState.ACCEPTABLE
    if ref_delta_e <= 3.0:
        return QualityState.GOOD
    return QualityState.ACCEPTABLE


def delta_e_to_optical_response(delta_e: float, delta_e_max: float) -> float:
    if delta_e_max <= 0:
        return 0.0
    return float(np.clip(delta_e / delta_e_max, 0.0, 1.0))


def analyze_strip_image(
    image_bytes: bytes,
    *,
    temperature_c: float = 0.0,
    humidity_pct: float = 0.0,
    exposure_duration_min: float = 0.0,
) -> MlAnalysisResult:
    if not settings.ML_ENABLED:
        raise MlNotAvailableError("ML inference is disabled (ML_ENABLED=false).")

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image_bgr is None:
        raise ValueError("Could not decode image bytes as JPEG/PNG.")

    prep = preprocess_strip_card(image_bgr)
    feats = extract_features_from_corrected(
        prep.corrected_bgr,
        ref_patch_delta_e=prep.reference_patch_delta_e,
        temperature_c=temperature_c,
        humidity_pct=humidity_pct,
        exposure_duration_min=exposure_duration_min,
    )
    quality = check_quality(feats)
    quality_state = _quality_state_from_signals(
        quality.ok,
        prep.reference_patch_delta_e,
        prep.lighting_uniformity_ok,
        prep.card_detected,
    )
    if not quality.ok:
        raise ValueError(quality.reason or "Image quality check failed.")

    delta_e = feats["delta_e"]
    strip_lab = (feats["lab_l_mean"], feats["lab_a_mean"], feats["lab_b_mean"])

    try:
        payload = _load_payload()
    except MlNotAvailableError:
        delta_e_max = settings.ML_DELTA_E_MAX
        return MlAnalysisResult(
            status=MlStatus.MODEL_UNAVAILABLE,
            quality_state=QualityState.MODEL_UNAVAILABLE,
            delta_e=round(delta_e, 3),
            strip_lab=strip_lab,
            predicted_ppm=None,
            optical_response=round(delta_e_to_optical_response(delta_e, delta_e_max), 4),
            dose_ppm_min=None,
            estimated_ppm=None,
            model_version="none",
            label_source="none",
            is_lab_validated=False,
            delta_e_max=delta_e_max,
            quality_ok=True,
        )

    schema = payload.get("feature_schema", FEATURE_SCHEMA)
    if schema != FEATURE_SCHEMA:
        raise MlNotAvailableError("Model feature schema mismatch.")

    model = payload["model"]
    predicted_ppm = float(max(0.0, model.predict(features_to_vector(feats))[0]))

    meta_path = ARTIFACTS_DIR / METADATA_NAME
    file_metrics: Dict[str, Any] = {}
    if meta_path.exists():
        with open(meta_path, encoding="utf-8") as f:
            file_metrics = json.load(f)

    delta_e_max = float(payload.get("delta_e_max") or file_metrics.get("delta_e_max") or settings.ML_DELTA_E_MAX)
    optical_response = delta_e_to_optical_response(delta_e, delta_e_max)
    duration_min = max(exposure_duration_min, 0.0)
    dose_ppm_min = predicted_ppm * duration_min

    strip_bgr = roi_bgr(prep.corrected_bgr, STRIP_RECT)
    strip_rgb = cv2.cvtColor(strip_bgr, cv2.COLOR_BGR2RGB).reshape(-1, 3).mean(axis=0)

    top_features: List[Dict[str, Any]] = []
    if hasattr(model, "feature_importances_"):
        imp = model.feature_importances_
        idx = np.argsort(imp)[::-1][:3]
        top_features = [{"name": FEATURE_SCHEMA[i], "importance": round(float(imp[i]), 4)} for i in idx]

    ml_proof = MlProof(
        strip_rgb=[round(float(c), 1) for c in strip_rgb],
        corrected_strip_rgb=[round(float(c), 1) for c in strip_rgb],
        hsv={"h": round(feats["hsv_h_mean"], 1), "s": round(feats["hsv_s_mean"], 1), "v": round(feats["hsv_v_mean"], 1)},
        lab={"l": round(feats["lab_l_mean"], 1), "a": round(feats["lab_a_mean"], 1), "b": round(feats["lab_b_mean"], 1)},
        reference_patches_measured=prep.reference_patches_measured,
        reference_patch_delta_e=round(prep.reference_patch_delta_e, 2),
        preprocessing_method=prep.method,
        model_version=str(payload.get("model_version", "SENTINEL-H2S-v1")),
        dataset_type=str(payload.get("dataset_type", "synthetic_development")),
        top_features=top_features,
    )

    return MlAnalysisResult(
        status=MlStatus.OK,
        quality_state=quality_state,
        delta_e=round(delta_e, 3),
        strip_lab=strip_lab,
        predicted_ppm=round(predicted_ppm, 2),
        optical_response=round(optical_response, 4),
        dose_ppm_min=round(dose_ppm_min, 2),
        estimated_ppm=round(predicted_ppm, 2),
        model_version=str(payload.get("model_version", "SENTINEL-H2S-v1")),
        label_source=str(payload.get("label_source", "literature_derived_proxy")),
        is_lab_validated=bool(payload.get("is_lab_validated", False)),
        delta_e_max=delta_e_max,
        quality_ok=True,
        ml_proof=ml_proof,
    )


# Backward-compatible alias
analyze_badge_image = analyze_strip_image


__all__ = [
    "analyze_strip_image",
    "analyze_badge_image",
    "MlAnalysisResult",
    "MlNotAvailableError",
    "MlStatus",
    "QualityState",
    "MlProof",
]
