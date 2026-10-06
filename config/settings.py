"""
config/settings.py
==================
Application-level configuration & environment defaults.
All tunable parameters are centralised here. Do NOT scatter magic
strings or port numbers across the codebase.
"""

import os

# ---------------------------------------------------------------------------
# Server / Network
# ---------------------------------------------------------------------------

# Port the uvicorn server listens on; override via PORT env-var at runtime.
APP_PORT: int = int(os.environ.get("PORT", 8095))

# FastAPI application display title (shown in /docs Swagger UI).
APP_TITLE: str = "FnO Stock Trading Application"

# CORS – allow all origins so the React frontend can connect from any tab.
CORS_ALLOW_ORIGINS: list = ["*"]

# ---------------------------------------------------------------------------
# Trading Mode
# ---------------------------------------------------------------------------

# Default trade mode on fresh startup.  Switch via /api/set_trade_mode.
DEFAULT_TRADE_MODE: str = "PAPER"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

# Active log file location (relative to project root at startup time).
LOG_FILE: str = "app_log.txt"

# Number of days of historical logs to maintain in FIFO order.
LOG_RETENTION_DAYS: int = 10
LOG_BACKUP_COUNT: int = 10

# Max size per log file rotation (legacy fallback).
LOG_MAX_BYTES: int = 20 * 1024 * 1024

# ---------------------------------------------------------------------------
# Static / Frontend
# ---------------------------------------------------------------------------

# Directory that holds the compiled React / JS frontend assets.
STATIC_DIR: str = "static"
