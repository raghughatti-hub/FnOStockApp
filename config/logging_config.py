"""
config/logging_config.py
========================
Centralised logging setup for the WebTrader application.
Implements 10-day FIFO log retention using TimedRotatingFileHandler
and automatic startup/daily retention sweeping.
"""

import os
import re
import sys
import glob
import logging
import warnings
import datetime
from logging.handlers import TimedRotatingFileHandler

from config.settings import LOG_FILE, LOG_RETENTION_DAYS, LOG_BACKUP_COUNT


def enforce_log_retention(log_file: str = LOG_FILE, retention_days: int = LOG_RETENTION_DAYS) -> None:
    """
    Enforces a strict 10-day FIFO retention window.
    - Removes legacy size-rotated logs (e.g., app_log.txt.1, app_log.txt.2, etc.).
    - Scans for date-stamped rotated logs (e.g., app_log.txt.YYYY-MM-DD), sorts them
      chronologically (oldest first), and deletes any files older than retention_days (FIFO).
    """
    logger = logging.getLogger("WebTraderApi")
    base_dir = os.path.dirname(os.path.abspath(log_file)) or os.getcwd()
    base_name = os.path.basename(log_file)

    # 1. Clean up legacy size-rotated files (.1, .2, etc.)
    for legacy_file in glob.glob(os.path.join(base_dir, f"{base_name}.[0-9]*")):
        suffix = legacy_file.split('.')[-1]
        if suffix.isdigit():
            try:
                os.remove(legacy_file)
                logger.info(f"[LOG RETENTION] Purged legacy size-based log: {os.path.basename(legacy_file)}")
            except Exception as e:
                logger.warning(f"[LOG RETENTION] Could not delete {legacy_file}: {e}")

    # 2. Find date-stamped rotated files
    date_regex = re.compile(r'(\d{4}-\d{2}-\d{2})')
    pattern = os.path.join(base_dir, f"{base_name}.*")
    matching_files = []

    for fpath in glob.glob(pattern):
        fname = os.path.basename(fpath)
        match = date_regex.search(fname)
        if match:
            try:
                file_date = datetime.datetime.strptime(match.group(1), "%Y-%m-%d").date()
                matching_files.append((file_date, fpath))
            except ValueError:
                continue

    # Sort files chronologically: oldest first (FIFO order)
    matching_files.sort(key=lambda x: x[0])

    today = datetime.date.today()
    cutoff_date = today - datetime.timedelta(days=retention_days)

    to_delete = set()
    for file_date, fpath in matching_files:
        if file_date < cutoff_date:
            to_delete.add(fpath)

    # If there are more than retention_days files regardless of calendar gaps, drop oldest
    remaining = [f for f in matching_files if f[1] not in to_delete]
    if len(remaining) > retention_days:
        excess_count = len(remaining) - retention_days
        for i in range(excess_count):
            to_delete.add(remaining[i][1])

    for fpath in to_delete:
        try:
            os.remove(fpath)
            logger.info(f"[LOG RETENTION] FIFO pruned log file (> {retention_days} days): {os.path.basename(fpath)}")
        except Exception as e:
            logger.warning(f"[LOG RETENTION] Failed to remove {fpath}: {e}")


def setup_logging() -> logging.Logger:
    """
    Configures the root logging system with a TimedRotatingFileHandler (midnight rollover,
    10-day FIFO retention) and a stdout stream handler.
    """
    handler = TimedRotatingFileHandler(
        LOG_FILE,
        when="midnight",
        interval=1,
        backupCount=LOG_BACKUP_COUNT,
        encoding='utf-8'
    )
    handler.suffix = "%Y-%m-%d"
    handler.extMatch = re.compile(r"^\d{4}-\d{2}-\d{2}$")

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            handler,
            logging.StreamHandler(sys.stdout)
        ],
        force=True
    )

    # Suppress verbose third-party loggers
    logging.getLogger("urllib3").setLevel(logging.ERROR)
    logging.getLogger("urllib3.connectionpool").setLevel(logging.ERROR)
    logging.getLogger("websocket").setLevel(logging.WARNING)
    logging.getLogger("requests").setLevel(logging.ERROR)
    warnings.filterwarnings("ignore", message="Connection pool is full")

    logger = logging.getLogger("WebTraderApi")

    # Run initial startup retention enforcement
    try:
        enforce_log_retention(LOG_FILE, LOG_RETENTION_DAYS)
    except Exception as e:
        logger.warning(f"[LOG RETENTION] Startup retention check warning: {e}")

    return logger
