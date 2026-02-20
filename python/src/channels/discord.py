from __future__ import annotations

import logging

import httpx

from openalerts.core.formatter import format_alert_discord
from openalerts.core.types import AlertEvent

logger = logging.getLogger("openalerts.channels.discord")


class DiscordChannel:
    def __init__(self, webhook_url: str, display_name: str | None = None) -> None:
        self._webhook_url = webhook_url
        self._display_name = display_name or "discord"
        self._client = httpx.AsyncClient(timeout=5.0)

    @property
    def name(self) -> str:
        return self._display_name

    async def send(self, alert: AlertEvent) -> None:
        payload = format_alert_discord(alert)
        try:
            resp = await self._client.post(self._webhook_url, json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            logger.error("Discord delivery failed: %s", e)
