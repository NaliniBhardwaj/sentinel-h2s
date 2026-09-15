import uuid
import enum
from datetime import datetime

from sqlalchemy import (
    Column, String, Float, Integer, Boolean, DateTime, ForeignKey, Text, JSON, Enum
)
from sqlalchemy.orm import relationship

from app.database import Base


def gen_uuid() -> str:
    return str(uuid.uuid4())


class RoleEnum(str, enum.Enum):
    WORKER = "WORKER"
    SUPERVISOR = "SUPERVISOR"
    MANAGER = "MANAGER"
    SAFETY_ADMIN = "SAFETY_ADMIN"


class RiskLevel(str, enum.Enum):
    LOW = "LOW"
    ELEVATED = "ELEVATED"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class StripStatus(str, enum.Enum):
    VALID = "VALID"
    EXPIRING_SOON = "EXPIRING_SOON"
    EXPIRED = "EXPIRED"
    INVALID = "INVALID"


class SyncStatus(str, enum.Enum):
    SYNCED = "SYNCED"
    PENDING = "PENDING"
    SYNC_FAILED = "SYNC_FAILED"


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=gen_uuid)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    full_name = Column(String, nullable=False)
    role = Column(Enum(RoleEnum), nullable=False, default=RoleEnum.WORKER)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    worker_profile = relationship(
        "Worker", back_populates="user", uselist=False, foreign_keys="Worker.user_id"
    )


class Zone(Base):
    __tablename__ = "zones"

    id = Column(String, primary_key=True, default=gen_uuid)
    code = Column(String, unique=True, index=True, nullable=False)  # e.g. 'comp-b'
    name = Column(String, nullable=False)
    site_threshold_profile_id = Column(String, ForeignKey("site_threshold_profiles.id"), nullable=True)

    workers = relationship("Worker", back_populates="zone")
    scans = relationship("Scan", back_populates="zone")
    threshold_profile = relationship("SiteThresholdProfile")


class SiteThresholdProfile(Base):
    """Configurable risk thresholds per site/zone. NOT a claimed universal
    medical safe limit -- explicitly a 'configured site threshold' /
    'reference safety profile' that a SAFETY_ADMIN sets for their site."""
    __tablename__ = "site_threshold_profiles"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    description = Column(Text, default="")
    ppm_elevated = Column(Float, nullable=False)
    ppm_high = Column(Float, nullable=False)
    ppm_critical = Column(Float, nullable=False)
    dose_elevated_ppm_min = Column(Float, nullable=False)
    dose_high_ppm_min = Column(Float, nullable=False)
    dose_critical_ppm_min = Column(Float, nullable=False)
    min_confidence = Column(Float, default=0.55)
    is_default = Column(Boolean, default=False)


class Worker(Base):
    __tablename__ = "workers"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id"), unique=True, nullable=False)
    display_id = Column(String, unique=True, nullable=False)  # e.g. 'W-1042'
    supervisor_id = Column(String, ForeignKey("users.id"), nullable=True)
    zone_id = Column(String, ForeignKey("zones.id"), nullable=True)
    shift_label = Column(String, default="")
    active_strip_id = Column(String, ForeignKey("strips.id"), nullable=True)

    user = relationship("User", back_populates="worker_profile", foreign_keys=[user_id])
    zone = relationship("Zone", back_populates="workers")
    scans = relationship("Scan", back_populates="worker", foreign_keys="Scan.worker_id")


class StripBatch(Base):
    __tablename__ = "strip_batches"

    id = Column(String, primary_key=True, default=gen_uuid)
    batch_code = Column(String, unique=True, nullable=False)
    profile_id = Column(String, ForeignKey("calibration_profiles.id"), nullable=False)
    manufactured_at = Column(DateTime, default=datetime.utcnow)

    strips = relationship("Strip", back_populates="batch")
    calibration_profile = relationship("CalibrationProfile")


class CalibrationProfile(Base):
    """
    A calibration profile maps normalized optical response -> estimated ppm.
    is_validated=False (DEMO) profiles MUST be clearly labeled in every
    surface that displays results derived from them. This codebase does not
    ship a scientifically validated H2S calibration curve -- only a DEMO
    profile intended to exercise the full pipeline during development.
    """
    __tablename__ = "calibration_profiles"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    chemistry_version = Column(String, nullable=False, default="demo-v0")
    model_version = Column(String, nullable=False, default="0.1.0-demo")
    camera_profile = Column(String, default="generic-rgb")
    concentration_range_min_ppm = Column(Float, default=0.0)
    concentration_range_max_ppm = Column(Float, default=50.0)
    # Piecewise-linear curve control points stored as JSON:
    # [{"response": 0.0, "ppm": 0.0}, {"response": 1.0, "ppm": 50.0}, ...]
    curve_points = Column(JSON, nullable=False)
    is_validated = Column(Boolean, default=False)  # False => DEMO/SIMULATED
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class Strip(Base):
    __tablename__ = "strips"

    id = Column(String, primary_key=True, default=gen_uuid)
    strip_code = Column(String, unique=True, index=True, nullable=False)  # QR "strip_id"
    batch_id = Column(String, ForeignKey("strip_batches.id"), nullable=False)
    activated_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    status = Column(Enum(StripStatus), default=StripStatus.VALID)
    health_pct = Column(Float, default=100.0)

    batch = relationship("StripBatch", back_populates="strips")


class Scan(Base):
    __tablename__ = "scans"

    id = Column(String, primary_key=True, default=gen_uuid)
    client_scan_uuid = Column(String, unique=True, index=True, nullable=False)  # idempotency key from device
    worker_id = Column(String, ForeignKey("workers.id"), nullable=False)
    strip_id = Column(String, ForeignKey("strips.id"), nullable=True)
    zone_id = Column(String, ForeignKey("zones.id"), nullable=True)
    calibration_profile_id = Column(String, ForeignKey("calibration_profiles.id"), nullable=True)

    captured_at = Column(DateTime, nullable=False)
    duration_seconds = Column(Integer, nullable=False, default=0)

    optical_response = Column(Float, nullable=True)   # raw normalized CV output, NEVER called ppm
    estimated_ppm = Column(Float, nullable=True)       # derived via calibration curve
    dose_ppm_min = Column(Float, nullable=True)         # estimated_ppm * duration_minutes
    confidence = Column(Float, nullable=True)           # 0..1
    quality_ok = Column(Boolean, default=True)

    temperature_c = Column(Float, nullable=True)
    humidity_pct = Column(Float, nullable=True)

    risk_level = Column(Enum(RiskLevel), nullable=True)
    risk_explanation = Column(Text, default="")
    recommended_action = Column(Text, default="")

    is_demo = Column(Boolean, default=False)
    sync_status = Column(Enum(SyncStatus), default=SyncStatus.SYNCED)
    created_at = Column(DateTime, default=datetime.utcnow)

    worker = relationship("Worker", back_populates="scans", foreign_keys=[worker_id])
    zone = relationship("Zone", back_populates="scans")
    strip = relationship("Strip")
    calibration_profile = relationship("CalibrationProfile")


class ExposureEvent(Base):
    """Aggregated/derived rolling exposure record for a worker (used for
    cumulative dose tracking independent of individual scans, e.g. shift
    totals)."""
    __tablename__ = "exposure_events"

    id = Column(String, primary_key=True, default=gen_uuid)
    worker_id = Column(String, ForeignKey("workers.id"), nullable=False)
    scan_id = Column(String, ForeignKey("scans.id"), nullable=True)
    zone_id = Column(String, ForeignKey("zones.id"), nullable=True)
    occurred_at = Column(DateTime, default=datetime.utcnow)
    dose_ppm_min = Column(Float, default=0.0)
    cumulative_dose_ppm_min = Column(Float, default=0.0)
    risk_level = Column(Enum(RiskLevel), nullable=True)


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(String, primary_key=True, default=gen_uuid)
    type = Column(Enum(RiskLevel), nullable=False)
    worker_id = Column(String, ForeignKey("workers.id"), nullable=True)
    zone_id = Column(String, ForeignKey("zones.id"), nullable=True)
    scan_id = Column(String, ForeignKey("scans.id"), nullable=True)
    title = Column(String, nullable=False)
    body = Column(Text, default="")
    acknowledged = Column(Boolean, default=False)
    acknowledged_by = Column(String, ForeignKey("users.id"), nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Report(Base):
    __tablename__ = "reports"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    report_type = Column(String, default="daily_briefing")
    generated_by = Column(String, ForeignKey("users.id"), nullable=True)
    period_start = Column(DateTime, nullable=True)
    period_end = Column(DateTime, nullable=True)
    payload = Column(JSON, default=dict)  # bullets/recommendations/kpis snapshot
    created_at = Column(DateTime, default=datetime.utcnow)
