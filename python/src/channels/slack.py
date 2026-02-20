from __future__ import annotations

import logging

import httpx

from openalerts.core.formatter import format_alert_slack
from openalerts.core.types import AlertEvent

logger = logging.getLogger("openalerts.channels.slack")


class SlackChannel:
    def __init__(self, webhook_url: str, display_name: str | None = None) -> None:
        self._webhook_url = webhook_url
        self._display_name = display_name or "slack"
        self._client = httpx.AsyncClient(timeout=5.0)

    @property
    def name(self) -> str:
        return self._display_name

    async def send(self, alert: AlertEvent) -> None:
        payload = format_alert_slack(alert)
        try:
            resp = await self._client.post(self._webhook_url, json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            logger.error("Slack delivery failed: %s", e)
