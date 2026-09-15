from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pathlib import Path

from app.config import settings
from app.database import Base, engine
from app.routers import auth, users, strips, scans, zones, manager, alerts, reports, health, exposure

_ML_MODEL = Path(__file__).resolve().parent / "ml" / "artifacts" / settings.ML_MODEL_PATH

# For SQLite dev DB, create tables directly. When DATABASE_URL points at
# PostgreSQL, use Alembic migrations instead (see alembic/ and README).
if settings.DATABASE_URL.startswith("sqlite"):
    Base.metadata.create_all(bind=engine)

app = FastAPI(title=settings.APP_NAME)

if settings.ML_ENABLED and not _ML_MODEL.is_file():
    import logging
    logging.getLogger("uvicorn.error").warning(
        "ML_ENABLED=true but model not found at %s — POST /scans/from-image will return 503. "
        "Run: cd ../ml && python run_pipeline.py",
        _ML_MODEL,
    )

origins = ["*"] if settings.CORS_ORIGINS == "*" else settings.CORS_ORIGINS.split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(strips.router)
app.include_router(scans.router)
app.include_router(scans.sync_router)
app.include_router(exposure.router)
app.include_router(zones.router)
app.include_router(manager.router)
app.include_router(alerts.router)
app.include_router(reports.router)


@app.get("/")
def root():
    return {"name": settings.APP_NAME, "status": "running"}
