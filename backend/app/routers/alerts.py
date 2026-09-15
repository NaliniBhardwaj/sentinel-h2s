from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app import models, schemas
from app.deps import get_current_user, require_roles
from app.strip_alerts import generate_strip_expiry_alerts

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=List[schemas.AlertResponse])
def list_alerts(
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Worker-facing (and general) alert feed. Workers see only alerts
    addressed to them (their own worker_id, excluding manager-audience
    strip-expiry alerts). Manager-tier roles get the full feed — use
    /manager/alerts for the manager UI, this is kept generic for reuse."""
    generate_strip_expiry_alerts(db)

    q = db.query(models.Alert)
    if user.role.value == "WORKER":
        worker = db.query(models.Worker).filter(models.Worker.user_id == user.id).first()
        if not worker:
            return []
        q = q.filter(models.Alert.worker_id == worker.id, ~models.Alert.body.like("%[AUD:MGR]%"))
    alerts = q.order_by(models.Alert.created_at.desc()).limit(100).all()
    return [
        schemas.AlertResponse(
            id=a.id, type=a.type.value, worker_id=a.worker_id, zone_id=a.zone_id,
            title=a.title, body=a.body, acknowledged=a.acknowledged, created_at=a.created_at,
        )
        for a in alerts
    ]


@router.post("/{alert_id}/acknowledge", response_model=schemas.AlertResponse)
def acknowledge_alert(
    alert_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    alert = db.query(models.Alert).filter(models.Alert.id == alert_id).first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    if user.role.value == "WORKER":
        worker = db.query(models.Worker).filter(models.Worker.user_id == user.id).first()
        if not worker or alert.worker_id != worker.id:
            raise HTTPException(status_code=403, detail="Cannot acknowledge another worker's alert.")
    alert.acknowledged = True
    alert.acknowledged_by = user.id
    alert.acknowledged_at = datetime.utcnow()
    db.commit()
    db.refresh(alert)
    return schemas.AlertResponse(
        id=alert.id, type=alert.type.value, worker_id=alert.worker_id, zone_id=alert.zone_id,
        title=alert.title, body=alert.body, acknowledged=alert.acknowledged, created_at=alert.created_at,
    )
