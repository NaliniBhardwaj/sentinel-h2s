"""
Seeds the database with demo accounts, zones, strips, and 7 days of
deterministic (fixed-seed RNG) historical scan/exposure data so every
dashboard reads from the same coherent backend dataset.

Run with: python -m app.seed
"""
import random
from datetime import datetime, timedelta

from app.database import Base, engine, SessionLocal
from app import models
from app.security import hash_password
from app.calibration import ML_CURVE_POINTS, apply_curve
from app.risk_engine import evaluate_risk, DEFAULT_THRESHOLDS

RNG = random.Random(42)  # fixed seed -> deterministic, not random per render

ZONES = [
    ("Z01", "Processing Unit"),
    ("Z02", "Coal Handling"),
    ("Z03", "Maintenance"),
    ("Z04", "Storage Area"),
]

WORKERS = [
    # email, full name, display_id, zone code
    ("worker@sentinel.demo", "Rahul Sharma", "W001", "Z01"),
    ("worker2@sentinel.demo", "Amit Kumar", "W002", "Z02"),
    ("worker3@sentinel.demo", "Priya Singh", "W003", "Z03"),
    ("worker4@sentinel.demo", "Arjun Verma", "W004", "Z04"),
]

# strip_code, batch_code, mfg_date, exp_date, active-for worker display_id (or None)
STRIPS = [
    ("ST-2026-00421", "BA-2607-A", "2026-07-15", "2026-12-15", "W001"),
    ("ST-2026-00422", "BA-2607-A", "2026-07-15", "2026-12-15", "W002"),
    ("ST-2026-00118", "BA-2601-C", "2026-01-20", "2026-10-01", "W003"),
    ("ST-2025-00077", "BA-2512-B", "2025-12-01", "2026-09-20", "W004"),
    # Extra strip guaranteed EXPIRED for testing the block flow (not
    # anyone's active strip, so it doesn't distort worker/manager alerts).
    ("ST-2025-00050", "BA-2512-B", "2025-12-01", "2026-08-01", None),
]

# DEMO concentration bands (ppm) — demo values only, not universal safety limits.
LOW_RANGE = (0.1, 0.8)
MODERATE_RANGE = (0.8, 2.0)
HIGH_RANGE = (2.0, 5.0)
CRITICAL_RANGE = (5.0, 8.0)


def _optical_response_for_ppm(target_ppm: float) -> float:
    """Inverse-samples the DEMO curve to find an optical_response that yields
    ~target_ppm through the *same* calibration path scans normally use."""
    lo, hi = 0.0, 1.0
    for _ in range(24):
        mid = (lo + hi) / 2
        if apply_curve(mid, ML_CURVE_POINTS) < target_ppm:
            lo = mid
        else:
            hi = mid
    return round((lo + hi) / 2, 4)


def run():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(models.User).filter(models.User.email == "worker@sentinel.demo").first():
            print("DB already seeded, skipping.")
            return

        profile = models.SiteThresholdProfile(
            name="Default Plant Profile (DEMO)",
            description="Illustrative demo thresholds. Replace with a site-approved reference "
                        "safety profile before production use.",
            ppm_elevated=DEFAULT_THRESHOLDS.ppm_elevated,
            ppm_high=DEFAULT_THRESHOLDS.ppm_high,
            ppm_critical=DEFAULT_THRESHOLDS.ppm_critical,
            dose_elevated_ppm_min=DEFAULT_THRESHOLDS.dose_elevated_ppm_min,
            dose_high_ppm_min=DEFAULT_THRESHOLDS.dose_high_ppm_min,
            dose_critical_ppm_min=DEFAULT_THRESHOLDS.dose_critical_ppm_min,
            min_confidence=DEFAULT_THRESHOLDS.min_confidence,
            is_default=True,
        )
        db.add(profile)
        db.flush()

        zones = {}
        for code, name in ZONES:
            z = models.Zone(code=code, name=name, site_threshold_profile_id=profile.id)
            db.add(z)
            db.flush()
            zones[code] = z

        # DEV-CAL-v1: a simple, isolated, replaceable development calibration.
        # NOT scientifically validated -- see notes below and calibration_is_validated=False.
        cal = models.CalibrationProfile(
            name="H2S-SYN-CAL-v1",
            chemistry_version="synthetic-lab-v1",
            model_version="synthetic-v1",
            camera_profile="aruco-lab-normalized",
            concentration_range_min_ppm=0.0,
            concentration_range_max_ppm=50.0,
            curve_points=ML_CURVE_POINTS,
            is_validated=False,
            notes="Synthetic LAB ΔE-trained calibration — not scientifically validated. "
                  "Shared online ML and offline curve lookup. Replace with lab data when available.",
        )
        db.add(cal)
        db.flush()

        batches = {}
        for strip_code, batch_code, mfg, exp, _ in STRIPS:
            if batch_code not in batches:
                b = models.StripBatch(
                    batch_code=batch_code,
                    profile_id=cal.id,
                    manufactured_at=datetime.fromisoformat(mfg),
                )
                db.add(b)
                db.flush()
                batches[batch_code] = b

        strips = {}
        for strip_code, batch_code, mfg, exp, _ in STRIPS:
            expires_at = datetime.fromisoformat(exp)
            status = models.StripStatus.EXPIRED if expires_at < datetime.utcnow() else models.StripStatus.VALID
            s = models.Strip(
                strip_code=strip_code,
                batch_id=batches[batch_code].id,
                activated_at=datetime.fromisoformat(mfg),
                expires_at=expires_at,
                status=status,
                health_pct=100.0 if status == models.StripStatus.VALID else 0.0,
            )
            db.add(s)
            db.flush()
            strips[strip_code] = s

        def mkuser(email, name, role):
            u = models.User(email=email, full_name=name, role=models.RoleEnum[role],
                             hashed_password=hash_password("Password123!"))
            db.add(u)
            db.flush()
            return u

        supervisor_user = mkuser("supervisor@sentinel.demo", "J. Morales", "SUPERVISOR")
        manager_user = mkuser("manager@sentinel.demo", "R. Iyer", "MANAGER")
        admin_user = mkuser("admin@sentinel.demo", "S. Kapoor", "SAFETY_ADMIN")

        strip_for_worker = {w: code for code, _, _, _, w in STRIPS if w}

        workers = {}
        for email, name, display_id, zone_code in WORKERS:
            u = mkuser(email, name, "WORKER")
            active_code = strip_for_worker.get(display_id)
            w = models.Worker(
                user_id=u.id, display_id=display_id, supervisor_id=supervisor_user.id,
                zone_id=zones[zone_code].id, shift_label="Day Shift 06:00–18:00",
                active_strip_id=strips[active_code].id if active_code else None,
            )
            db.add(w)
            db.flush()
            workers[display_id] = w

        # ---- 7 days of deterministic historical scans ----
        # Mostly LOW, with a handful of MODERATE/HIGH/CRITICAL events, using
        # a fixed RNG seed so the dataset is identical on every seed run.
        now = datetime.utcnow()
        cumulative_by_worker_day = {}

        for day_offset in range(6, -1, -1):  # oldest -> newest
            day_start = (now - timedelta(days=day_offset)).replace(hour=7, minute=0, second=0, microsecond=0)
            for display_id, worker in workers.items():
                cumulative_by_worker_day[(display_id, day_offset)] = 0.0
                # 2-4 scans per worker per day, deterministic count from RNG
                scan_count = RNG.choice([2, 3, 3, 4])
                for i in range(scan_count):
                    captured_at = day_start + timedelta(hours=i * RNG.choice([2, 3]), minutes=RNG.randint(0, 45))
                    if captured_at > now:
                        continue

                    roll = RNG.random()
                    if roll < 0.78:
                        target_ppm = RNG.uniform(*LOW_RANGE)
                    elif roll < 0.92:
                        target_ppm = RNG.uniform(*MODERATE_RANGE)
                    elif roll < 0.98:
                        target_ppm = RNG.uniform(*HIGH_RANGE)
                    else:
                        target_ppm = RNG.uniform(*CRITICAL_RANGE)

                    duration_seconds = RNG.choice([180, 300, 420, 600, 900])
                    optical_response = _optical_response_for_ppm(target_ppm)
                    estimated_ppm = apply_curve(optical_response, ML_CURVE_POINTS)
                    edge_penalty = min(optical_response, 1 - optical_response)
                    confidence = round(min(0.98, 0.6 + edge_penalty * 0.8), 2)

                    duration_min = duration_seconds / 60.0
                    dose_this_scan = estimated_ppm * duration_min
                    cumulative_before = cumulative_by_worker_day[(display_id, day_offset)]

                    risk = evaluate_risk(
                        estimated_ppm=estimated_ppm,
                        duration_seconds=duration_seconds,
                        cumulative_dose_ppm_min=cumulative_before,
                        confidence=confidence,
                        strip_valid=True,
                        calibration_valid=True,
                        quality_ok=True,
                        thresholds=DEFAULT_THRESHOLDS,
                    )

                    cumulative_by_worker_day[(display_id, day_offset)] = cumulative_before + dose_this_scan

                    scan = models.Scan(
                        client_scan_uuid=f"seed-{display_id}-{day_offset}-{i}",
                        worker_id=worker.id,
                        strip_id=worker.active_strip_id,
                        zone_id=worker.zone_id,
                        calibration_profile_id=cal.id,
                        captured_at=captured_at,
                        duration_seconds=duration_seconds,
                        optical_response=optical_response,
                        estimated_ppm=round(estimated_ppm, 2),
                        dose_ppm_min=round(dose_this_scan, 2),
                        confidence=confidence,
                        quality_ok=True,
                        temperature_c=round(RNG.uniform(26, 34), 1),
                        humidity_pct=round(RNG.uniform(45, 75), 1),
                        risk_level=models.RiskLevel(risk.risk_level),
                        risk_explanation=risk.explanation,
                        recommended_action=risk.recommended_action,
                        is_demo=True,
                        sync_status=models.SyncStatus.SYNCED,
                    )
                    db.add(scan)
                    db.flush()

                    db.add(models.ExposureEvent(
                        worker_id=worker.id, scan_id=scan.id, zone_id=worker.zone_id,
                        occurred_at=captured_at, dose_ppm_min=round(dose_this_scan, 2),
                        cumulative_dose_ppm_min=round(cumulative_by_worker_day[(display_id, day_offset)], 2),
                        risk_level=models.RiskLevel(risk.risk_level),
                    ))

                    if risk.risk_level in ("HIGH", "CRITICAL"):
                        db.add(models.Alert(
                            type=models.RiskLevel(risk.risk_level),
                            worker_id=worker.id, zone_id=worker.zone_id, scan_id=scan.id,
                            title=f"{risk.risk_level} exposure — {worker.display_id}",
                            body=risk.explanation,
                        ))

        db.commit()

        from app.strip_alerts import generate_strip_expiry_alerts
        generate_strip_expiry_alerts(db)

        print("Seed complete. Demo accounts (password: Password123!):")
        print("  worker@sentinel.demo (Rahul Sharma, W001)")
        print("  worker2@sentinel.demo (Amit Kumar, W002)")
        print("  worker3@sentinel.demo (Priya Singh, W003)")
        print("  worker4@sentinel.demo (Arjun Verma, W004)")
        print("  supervisor@sentinel.demo / manager@sentinel.demo / admin@sentinel.demo")
    finally:
        db.close()


if __name__ == "__main__":
    run()
