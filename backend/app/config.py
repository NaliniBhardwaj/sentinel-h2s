"""
Application configuration, loaded from environment variables (.env).

DATABASE_URL defaults to a local SQLite file so the backend can be run
immediately for development/testing without standing up PostgreSQL.
For production, set DATABASE_URL to a postgresql+psycopg2:// URL --
all models/queries in this codebase use portable SQLAlchemy types and
run unmodified against PostgreSQL.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "SENTINEL API"
    ENV: str = "development"

    DATABASE_URL: str = "sqlite:///./sentinel_dev.db"

    JWT_SECRET_KEY: str = "CHANGE_ME_INSECURE_DEV_SECRET"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 12  # 12h shift-length token

    # Default reference safety profile (site-configurable; NOT a claimed
    # universal medical "safe limit"). Values are illustrative/demo only.
    DEFAULT_DOSE_ELEVATED_PPM_MIN: float = 30.0
    DEFAULT_DOSE_HIGH_PPM_MIN: float = 60.0
    DEFAULT_DOSE_CRITICAL_PPM_MIN: float = 100.0
    DEFAULT_PPM_ELEVATED: float = 5.0
    DEFAULT_PPM_HIGH: float = 10.0
    DEFAULT_PPM_CRITICAL: float = 20.0
    MIN_CONFIDENCE_FOR_ESTIMATE: float = 0.55

    CORS_ORIGINS: str = "*"

    # ML / camera analysis (h2s pipeline)
    ML_ENABLED: bool = True
    ML_MODEL_PATH: str = "model.pkl"
    ML_DELTA_E_MAX: float = 47.28


settings = Settings()
