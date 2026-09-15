from datetime import datetime
from typing import Optional, List, Dict, Any

from pydantic import BaseModel, EmailStr, Field


# ---------- Auth ----------
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    user_id: str
    full_name: str


class MeResponse(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    worker_id: Optional[str] = None
    zone_id: Optional[str] = None
    active_strip_code: Optional[str] = None


# ---------- Strips ----------
class StripValidateRequest(BaseModel):
    strip_code: str
    batch_code: Optional[str] = None
    profile_id: Optional[str] = None


class StripActivateRequest(BaseModel):
    strip_code: str


class StripResponse(BaseModel):
    id: str
    strip_code: str
    batch_code: str
    status: str
    health_pct: float
    manufacture_date: Optional[datetime] = None
    activated_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    days_remaining: Optional[int] = None
    warn_threshold_days: int = 30
    calibration_profile_id: Optional[str] = None
    calibration_profile_name: Optional[str] = None
    calibration_is_validated: Optional[bool] = None

    class Config:
        from_attributes = True


class StripExpiringResponse(BaseModel):
    worker_id: str
    worker_name: str
    display_id: str
    zone: Optional[str] = None
    strip_code: str
    days_remaining: int
    status: str


# ---------- Scans ----------
class ScanCreateRequest(BaseModel):
    client_scan_uuid: str = Field(..., description="Client-generated UUID for idempotency")
    strip_code: Optional[str] = None
    zone_code: Optional[str] = None
    captured_at: datetime
    duration_seconds: int = 0
    optical_response: Optional[float] = Field(None, ge=0, le=1)
    quality_ok: bool = True
    temperature_c: Optional[float] = None
    humidity_pct: Optional[float] = None
    is_demo: bool = False
    cumulative_dose_ppm_min_before: float = 0.0


class MlProofResponse(BaseModel):
    strip_rgb: Optional[List[float]] = None
    corrected_strip_rgb: Optional[List[float]] = None
    hsv: Optional[Dict[str, float]] = None
    lab: Optional[Dict[str, float]] = None
    reference_patches_measured: Optional[List[List[float]]] = None
    reference_patch_delta_e: Optional[float] = None
    preprocessing_method: Optional[str] = None
    model_version: Optional[str] = None
    dataset_type: Optional[str] = None
    top_features: Optional[List[Dict[str, Any]]] = None
    test_mae: Optional[float] = None
    test_rmse: Optional[float] = None
    test_r2: Optional[float] = None


class ScanResponse(BaseModel):
    id: str
    client_scan_uuid: str
    worker_id: str
    strip_id: Optional[str] = None
    zone_id: Optional[str] = None
    captured_at: datetime
    duration_seconds: int
    optical_response: Optional[float] = None
    estimated_ppm: Optional[float] = None
    dose_ppm_min: Optional[float] = None
    confidence: Optional[float] = None
    quality_ok: bool
    quality_state: Optional[str] = None
    risk_level: Optional[str] = None
    risk_explanation: Optional[str] = None
    recommended_action: Optional[str] = None
    is_demo: bool
    calibration_is_validated: Optional[bool] = None
    sync_status: str
    ml_status: Optional[str] = None
    model_version: Optional[str] = None
    dataset_type: Optional[str] = None
    analysis_note: Optional[str] = None
    ml_proof: Optional[MlProofResponse] = None

    class Config:
        from_attributes = True


class SyncScansRequest(BaseModel):
    scans: List[ScanCreateRequest]


class SyncScansResponse(BaseModel):
    accepted: List[ScanResponse]
    duplicates: List[str]
    errors: List[Dict[str, Any]]


# ---------- Exposure ----------
class ExposureSummaryResponse(BaseModel):
    worker_id: str
    cumulative_dose_ppm_min_today: float
    scan_count_today: int
    risk_level: Optional[str]
    last_scan_at: Optional[datetime]


class ExposureTimelinePoint(BaseModel):
    time: datetime
    dose_ppm_min: float
    zone: Optional[str]
    risk_level: Optional[str]


# ---------- Zones ----------
class ZoneResponse(BaseModel):
    id: str
    code: str
    name: str
    worker_count: int
    avg_ppm: float
    risk_level: str

    class Config:
        from_attributes = True


# ---------- Manager ----------
class ManagerOverviewResponse(BaseModel):
    active_workers: int
    workers_at_risk: int
    zones_attention: int
    valid_strips_pct: float
    last_sync: Optional[datetime]


class ManagerWorkerResponse(BaseModel):
    worker_id: str
    display_id: str
    name: str
    zone: Optional[str]
    estimated_ppm: Optional[float]
    dose_ppm_min: Optional[float]
    risk_level: Optional[str]
    confidence: Optional[float]
    last_scan_at: Optional[datetime]
    strip_status: Optional[str]


class AlertResponse(BaseModel):
    id: str
    type: str
    worker_id: Optional[str] = None
    zone_id: Optional[str] = None
    title: str
    body: str
    acknowledged: bool
    created_at: datetime

    class Config:
        from_attributes = True


# ---------- Reports ----------
class ReportCreateRequest(BaseModel):
    title: str
    report_type: str = "daily_briefing"
    period_start: Optional[datetime] = None
    period_end: Optional[datetime] = None


class ReportResponse(BaseModel):
    id: str
    title: str
    report_type: str
    period_start: Optional[datetime]
    period_end: Optional[datetime]
    payload: Dict[str, Any]
    created_at: datetime

    class Config:
        from_attributes = True
