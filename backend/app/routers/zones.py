from datetime import datetime, timedelta
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app import models, schemas
from app.deps import get_current_user

router = APIRouter(prefix="/zones", tags=["zones"])


def _zone_risk_and_avg(db: Session, zone: models.Zone):
    since = datetime.utcnow() - timedelta(hours=4)
    recent_scans = (
        db.query(models.Scan)
        .filter(models.Scan.zone_id == zone.id, models.Scan.captured_at >= since, models.Scan.estimated_ppm.isnot(None))
        .all()
    )
    if not recent_scans:
        return "LOW", 0.0
    avg_ppm = sum(s.estimated_ppm for s in recent_scans) / len(recent_scans)
    order = {"LOW": 0, "ELEVATED": 1, "HIGH": 2, "CRITICAL": 3}
    worst = max((s.risk_level.value if s.risk_level else "LOW" for s in recent_scans), key=lambda r: order[r])
    return worst, round(avg_ppm, 2)


@router.get("", response_model=List[schemas.ZoneResponse])
def list_zones(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    zones = db.query(models.Zone).all()
    out = []
    for z in zones:
        worker_count = db.query(models.Worker).filter(models.Worker.zone_id == z.id).count()
        risk, avg_ppm = _zone_risk_and_avg(db, z)
        out.append(schemas.ZoneResponse(id=z.id, code=z.code, name=z.name, worker_count=worker_count, avg_ppm=avg_ppm, risk_level=risk))
    return out


@router.get("/{zone_id}", response_model=schemas.ZoneResponse)
def get_zone(zone_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    z = db.query(models.Zone).filter((models.Zone.id == zone_id) | (models.Zone.code == zone_id)).first()
    if not z:
        raise HTTPException(status_code=404, detail="Zone not found")
    worker_count = db.query(models.Worker).filter(models.Worker.zone_id == z.id).count()
    risk, avg_ppm = _zone_risk_and_avg(db, z)
    return schemas.ZoneResponse(id=z.id, code=z.code, name=z.name, worker_count=worker_count, avg_ppm=avg_ppm, risk_level=risk)
