"""OpenAlerts — Real-time monitoring & alerting SDK for AI agent frameworks."""

from __future__ import annotations

import asyncio
import atexit
import logging
from typing import Any

from openalerts.channels.discord import DiscordChannel
from openalerts.channels.slack import SlackChannel
from openalerts.channels.webhook import WebhookChannel
from openalerts.core.config import ChannelConfig, OpenAlertsConfig
from openalerts.core.engine import OpenAlertsEngine
from openalerts.core.types import AlertEvent, EventType, OpenAlertsEvent, Severity
from openalerts.dashboard.server import DashboardServer

__all__ = [
    "AlertEvent",
    "ChannelConfig",
    "DashboardServer",
    "EventType",
    "OpenAlertsConfig",
    "OpenAlertsEngine",
    "OpenAlertsEvent",
    "Severity",
    "get_engine",
    "init",
    "init_sync",
    "send_test_alert",
    "shutdown",
]

logger = logging.getLogger("openalerts")

_engine: OpenAlertsEngine | None = None
_adapter: Any = None
_dashboard: DashboardServer | None = None


async def init(config: dict | OpenAlertsConfig) -> OpenAlertsEngine:
    """Initialize openalerts. Auto-instruments the configured framework.

    Cleanup happens automatically on process exit — no need to call shutdown().
    """
    global _engine, _adapter, _dashboard

    if _engine is not None and _engine.is_running:
        logger.warning("OpenAlerts already initialized.")
        return _engine

    cfg = OpenAlertsConfig.from_dict(config) if isinstance(config, dict) else config

    # Configure logging
    log_level = getattr(logging, cfg.log_level, logging.INFO)
    logging.getLogger("openalerts").setLevel(log_level)

    _engine = OpenAlertsEngine(cfg)
    _setup_channels(_engine, cfg)

    _adapter = _load_adapter(cfg.framework)
    _adapter.patch(_engine)

    await _engine.start()

    # Start dashboard server (if enabled)
    if cfg.dashboard:
        _dashboard = DashboardServer(_engine, port=cfg.dashboard_port)
        try:
            await _dashboard.start()
        except OSError as exc:
            logger.warning("Dashboard server failed to start on port %d: %s", cfg.dashboard_port, exc)
            _dashboard = None

    # Auto-cleanup on process exit
    atexit.register(_shutdown_sync)

    logger.info(
        "OpenAlerts initialized (framework=%s, channels=%d, dashboard=%s)",
        cfg.framework,
        len(cfg.channels),
        _dashboard.url if _dashboard else "disabled",
    )
    return _engine


def init_sync(config: dict | OpenAlertsConfig) -> OpenAlertsEngine:
    """Sync wrapper for init(). Creates/uses event loop."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(asyncio.run, init(config))
            return future.result()
    else:
        return asyncio.run(init(config))


async def shutdown() -> None:
    """Stop engine, remove patches, stop dashboard. Called automatically on exit."""
    global _engine, _adapter, _dashboard

    if _dashboard is not None:
        await _dashboard.stop()
        _dashboard = None

    if _adapter is not None:
        _adapter.unpatch()
        _adapter = None

    if _engine is not None:
        await _engine.stop()
        _engine = None

    logger.info("OpenAlerts shut down")


def _shutdown_sync() -> None:
    """atexit handler — runs async shutdown synchronously."""
    global _adapter, _engine, _dashboard

    if _engine is None and _adapter is None and _dashboard is None:
        return

    # Unpatch synchronously (no async needed)
    if _adapter is not None:
        _adapter.unpatch()
        _adapter = None

    # Best-effort async cleanup for dashboard and engine
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        loop.create_task(shutdown())
    else:
        try:
            asyncio.run(shutdown())
        except RuntimeError:
            # Event loop already closed at interpreter exit — just log
            logger.debug("Could not run async shutdown at exit")


async def send_test_alert() -> None:
    """Send a test alert to verify channel delivery."""
    if _engine is None:
        raise RuntimeError("OpenAlerts not initialized. Call init() first.")
    await _engine.send_test_alert()


def get_engine() -> OpenAlertsEngine | None:
    """Get the current engine instance."""
    return _engine


def _setup_channels(engine: OpenAlertsEngine, config: OpenAlertsConfig) -> None:
    """Create and register alert channels from config."""
    for ch_config in config.channels:
        channel = _create_channel(ch_config)
        if channel is not None:
            engine.add_channel(channel)


def _create_channel(config: ChannelConfig) -> Any:
    """Create a channel instance from config."""
    if not config.webhook_url:
        logger.warning("Channel '%s' has no webhook_url, skipping", config.type)
        return None

    if config.type == "slack":
        return SlackChannel(config.webhook_url, config.name)
    elif config.type == "discord":
        return DiscordChannel(config.webhook_url, config.name)
    elif config.type == "webhook":
        return WebhookChannel(config.webhook_url, config.name, config.headers)
    else:
        logger.warning("Unknown channel type: %s", config.type)
        return None


def _load_adapter(framework: str) -> Any:
    """Load the framework adapter."""
    if framework == "openmanus":
        from openalerts.adapters.openmanus import OpenManusAdapter

        return OpenManusAdapter()
    else:
        raise ValueError(f"Unknown framework adapter: {framework}")
