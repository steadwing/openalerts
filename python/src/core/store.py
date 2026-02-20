from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import aiofiles

from openalerts.core.types import AlertEvent, OpenAlertsEvent

logger = logging.getLogger("openalerts.store")


async def append_event(state_dir: Path, event_json: str) -> None:
    """Append a single JSON line to the events log."""
    state_dir.mkdir(parents=True, exist_ok=True)
    log_path = state_dir / "events.jsonl"
    async with aiofiles.open(log_path, "a") as f:
        await f.write(event_json + "\n")


async def read_recent_events(state_dir: Path, limit: int = 100) -> list[str]:
    """Read the last `limit` JSON lines from the events log."""
    log_path = state_dir / "events.jsonl"
    if not log_path.exists():
        return []
    async with aiofiles.open(log_path) as f:
        lines = await f.readlines()
    return [line.strip() for line in lines[-limit:] if line.strip()]


def load_history(
    state_dir: Path,
    event_limit: int = 500,
    alert_limit: int = 50,
) -> tuple[list[OpenAlertsEvent], list[AlertEvent]]:
    """Load recent events and alerts from JSONL for dashboard replay.

    Returns (events, alerts) parsed from the persisted log.
    """
    log_path = state_dir / "events.jsonl"
    if not log_path.exists():
        return [], []

    events: list[OpenAlertsEvent] = []
    alerts: list[AlertEvent] = []

    try:
        with open(log_path) as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    data = json.loads(stripped)
                    if "rule_id" in data and "fingerprint" in data:
                        alerts.append(AlertEvent.model_validate(data))
                    elif "type" in data:
                        events.append(OpenAlertsEvent.model_validate(data))
                except (json.JSONDecodeError, Exception):
                    continue
    except OSError:
        logger.warning("Could not read history from %s", log_path)

    return events[-event_limit:], alerts[-alert_limit:]


async def prune_log(
    state_dir: Path,
    max_size_kb: int = 5120,
    max_age_days: int = 7,
) -> None:
    """Remove old entries from the events log based on size and age."""
    log_path = state_dir / "events.jsonl"
    if not log_path.exists():
        return

    cutoff_ts = time.time() - (max_age_days * 86400)
    kept: list[str] = []

    async with aiofiles.open(log_path) as f:
        lines = await f.readlines()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        # Quick timestamp extraction — look for "ts": <float>
        try:
            idx = stripped.index('"ts"')
            colon = stripped.index(":", idx + 3)
            # Find the number after the colon
            rest = stripped[colon + 1 :].lstrip()
            end = 0
            while end < len(rest) and (rest[end].isdigit() or rest[end] == "."):
                end += 1
            ts = float(rest[:end])
            if ts >= cutoff_ts:
                kept.append(stripped)
        except (ValueError, IndexError):
            kept.append(stripped)

    # Trim by size — keep the tail
    total = sum(len(line) + 1 for line in kept)
    max_bytes = max_size_kb * 1024
    while total > max_bytes and kept:
        removed = kept.pop(0)
        total -= len(removed) + 1

    async with aiofiles.open(log_path, "w") as f:
        for line in kept:
            await f.write(line + "\n")
