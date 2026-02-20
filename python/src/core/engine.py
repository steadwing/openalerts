from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from pathlib import Path

from openalerts.core.config import OpenAlertsConfig
from openalerts.core.dispatcher import AlertDispatcher
from openalerts.core.evaluator import EvaluatorState, process_event, warm_from_history
from openalerts.core.event_bus import OpenAlertsEventBus
from openalerts.core.rules import ALL_RULES, AlertRule
from openalerts.core.store import append_event, load_history, prune_log
from openalerts.core.types import AlertEvent, EventType, OpenAlertsEvent, Severity

logger = logging.getLogger("openalerts.engine")

_PRUNE_INTERVAL_SECONDS = 6 * 3600
_MAX_LIVE_EVENTS = 500


class OpenAlertsEngine:
    """Main orchestrator. Receives events, evaluates rules, dispatches alerts."""

    def __init__(self, config: OpenAlertsConfig) -> None:
        self._config = config
        self._bus = OpenAlertsEventBus()
        self._dispatcher = AlertDispatcher()
        self._state = EvaluatorState()
        self._rules: list[AlertRule] = list(ALL_RULES)
        self._running = False
        self._state_dir = (
            Path(config.state_dir) if config.state_dir else Path.home() / ".openalerts"
        )
        self._prune_task: asyncio.Task | None = None
        self._started_at: float = 0.0

        # Live events ring buffer for dashboard history replay
        self._live_events: deque[OpenAlertsEvent] = deque(maxlen=_MAX_LIVE_EVENTS)

        # Recent alerts ring buffer for dashboard
        self._recent_alerts: deque[AlertEvent] = deque(maxlen=50)

        # Alert listeners (for SSE push)
        self._alert_listeners: list[object] = []

        # Running stats counters
        self._stats: dict[str, int] = {
            "events_processed": 0,
            "llm_calls": 0,
            "llm_errors": 0,
            "tool_calls": 0,
            "tool_errors": 0,
            "agent_starts": 0,
            "agent_errors": 0,
            "agent_steps": 0,
            "tokens_used": 0,
        }

        # Wire up the event bus
        self._bus.on(self._on_event)

    async def start(self) -> None:
        self._state_dir.mkdir(parents=True, exist_ok=True)
        warm_from_history(self._state, self._state_dir, self._rules)

        # Load historical events/alerts so the dashboard has context on connect
        hist_events, hist_alerts = load_history(self._state_dir)
        for ev in hist_events:
            self._live_events.append(ev)
        for al in hist_alerts:
            self._recent_alerts.append(al)
        if hist_events or hist_alerts:
            logger.info(
                "Loaded %d events and %d alerts from history",
                len(hist_events),
                len(hist_alerts),
            )

        self._running = True
        self._started_at = time.time()
        self._prune_task = asyncio.create_task(self._prune_loop())
        logger.info("OpenAlerts engine started (state_dir=%s)", self._state_dir)

    async def stop(self) -> None:
        self._running = False
        if self._prune_task and not self._prune_task.done():
            self._prune_task.cancel()
            try:
                await self._prune_task
            except asyncio.CancelledError:
                pass
            self._prune_task = None
        self._bus.clear()
        logger.info("OpenAlerts engine stopped")

    async def ingest(self, event: OpenAlertsEvent) -> None:
        if not self._running:
            return
        await self._bus.emit(event)

    async def _on_event(self, event: OpenAlertsEvent) -> None:
        # Track in live buffer
        self._live_events.append(event)

        # Update stats
        self._stats["events_processed"] += 1
        _stat_map = {
            EventType.LLM_CALL: "llm_calls",
            EventType.LLM_ERROR: "llm_errors",
            EventType.TOOL_CALL: "tool_calls",
            EventType.TOOL_ERROR: "tool_errors",
            EventType.AGENT_START: "agent_starts",
            EventType.AGENT_ERROR: "agent_errors",
            EventType.AGENT_STEP: "agent_steps",
        }
        stat_key = _stat_map.get(event.type)
        if stat_key:
            self._stats[stat_key] += 1
        if event.token_count and event.type == EventType.LLM_TOKEN_USAGE:
            self._stats["tokens_used"] += event.token_count

        # Persist
        if self._config.persist:
            try:
                await append_event(self._state_dir, event.model_dump_json())
            except Exception:
                logger.exception("Failed to persist event")

        # Evaluate rules
        alerts = process_event(self._state, self._config, event, self._rules)

        # Dispatch alerts
        for alert in alerts:
            self._recent_alerts.append(alert)
            if not self._config.quiet:
                logger.info("Alert fired: [%s] %s", alert.rule_id, alert.title)
                await self._dispatcher.dispatch(alert)
            else:
                logger.info("Alert (quiet mode): [%s] %s", alert.rule_id, alert.title)
            if self._config.persist:
                try:
                    await append_event(self._state_dir, alert.model_dump_json())
                except Exception:
                    logger.exception("Failed to persist alert")
            await self._notify_alert_listeners(alert)

    def on_alert(self, listener: object) -> None:
        """Subscribe to alert events. Listener is an async callable(AlertEvent)."""
        self._alert_listeners.append(listener)

    async def _notify_alert_listeners(self, alert: AlertEvent) -> None:
        for listener in self._alert_listeners:
            try:
                await listener(alert)  # type: ignore[operator]
            except Exception:
                logger.debug("Alert listener error", exc_info=True)

    async def send_test_alert(self) -> None:
        alert = AlertEvent(
            rule_id="test",
            severity=Severity.INFO,
            title="OpenAlerts Test Alert",
            detail="This is a test alert to verify your alert channels are working.",
            fingerprint="test-alert",
            ts=time.time(),
        )
        logger.info("Sending test alert to %d channel(s)", self._dispatcher.channel_count)
        self._recent_alerts.append(alert)
        await self._dispatcher.dispatch(alert)

    def get_recent_live_events(self, limit: int = 200) -> list[OpenAlertsEvent]:
        events = list(self._live_events)
        return events[-limit:]

    def get_state_snapshot(self) -> dict:
        """Return a JSON-serializable state snapshot for the dashboard."""
        now = time.time()

        # Build last_fired timestamps per rule_id from recent alerts
        rule_last_fired: dict[str, float] = {}
        for a in self._recent_alerts:
            if a.rule_id not in rule_last_fired or a.ts > rule_last_fired[a.rule_id]:
                rule_last_fired[a.rule_id] = a.ts

        rule_statuses = []
        for rule in self._rules:
            last = rule_last_fired.get(rule.id)
            fired = last is not None and (now - last) < 900
            rule_statuses.append({
                "id": rule.id,
                "status": "fired" if fired else "ok",
                "last_fired": last,
            })

        return {
            "uptime_ms": (now - self._started_at) * 1000 if self._started_at else 0,
            "started_at": self._started_at * 1000 if self._started_at else 0,
            "stats": dict(self._stats),
            "bus_listeners": self._bus.size,
            "recent_alerts": [
                {
                    "rule_id": a.rule_id,
                    "severity": a.severity,
                    "title": a.title,
                    "detail": a.detail,
                    "ts": a.ts,
                }
                for a in self._recent_alerts
            ],
            "rules": rule_statuses,
            "cooldowns": {k: v for k, v in self._state.cooldowns.items()},
        }

    async def _prune_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(_PRUNE_INTERVAL_SECONDS)
                await prune_log(
                    self._state_dir,
                    max_size_kb=self._config.max_log_size_kb,
                    max_age_days=self._config.max_log_age_days,
                )
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Prune failed")

    def add_channel(self, channel: object) -> None:
        self._dispatcher.add_channel(channel)  # type: ignore[arg-type]

    @property
    def bus(self) -> OpenAlertsEventBus:
        return self._bus

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def config(self) -> OpenAlertsConfig:
        return self._config

    @property
    def state(self) -> EvaluatorState:
        return self._state

    @property
    def stats(self) -> dict[str, int]:
        return dict(self._stats)
