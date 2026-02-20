from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from openalerts.core.types import AlertEvent

if TYPE_CHECKING:
    from openalerts.channels.base import AlertChannel

logger = logging.getLogger("openalerts.dispatcher")


class AlertDispatcher:
    """Fans out alerts to all registered channels."""

    def __init__(self) -> None:
        self._channels: list[AlertChannel] = []

    async def dispatch(self, alert: AlertEvent) -> None:
        """Send alert to all channels. Errors caught per-channel."""
        if not self._channels:
            return

        results = await asyncio.gather(
            *(self._send_to_channel(ch, alert) for ch in self._channels),
            return_exceptions=True,
        )
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(
                    "Channel '%s' failed: %s",
                    self._channels[i].name,
                    result,
                )

    async def _send_to_channel(self, channel: AlertChannel, alert: AlertEvent) -> None:
        await channel.send(alert)

    def add_channel(self, channel: AlertChannel) -> None:
        self._channels.append(channel)

    @property
    def channel_count(self) -> int:
        return len(self._channels)
