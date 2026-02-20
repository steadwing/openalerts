from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from openalerts.core.types import OpenAlertsEvent

logger = logging.getLogger("openalerts.event_bus")

Listener = Callable[[OpenAlertsEvent], Awaitable[None]]


class OpenAlertsEventBus:
    """Async pub/sub event bus."""

    def __init__(self) -> None:
        self._listeners: set[Listener] = set()

    def on(self, listener: Listener) -> Callable[[], None]:
        """Subscribe a listener. Returns an unsubscribe callable."""
        self._listeners.add(listener)

        def unsubscribe() -> None:
            self._listeners.discard(listener)

        return unsubscribe

    async def emit(self, event: OpenAlertsEvent) -> None:
        """Broadcast event to all listeners. Errors caught per-listener."""
        for listener in list(self._listeners):
            try:
                await listener(event)
            except Exception:
                logger.exception("Listener %s failed for event %s", listener, event.type)

    def clear(self) -> None:
        self._listeners.clear()

    @property
    def size(self) -> int:
        return len(self._listeners)
