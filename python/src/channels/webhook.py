from __future__ import annotations

import logging

import httpx

from openalerts.core.formatter import format_alert
from openalerts.core.types import AlertEvent

logger = logging.getLogger("openalerts.channels.webhook")


class WebhookChannel:
    def __init__(
        self,
        webhook_url: str,
        display_name: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._webhook_url = webhook_url
        self._display_name = display_name or "webhook"
        self._headers = headers or {}
        self._client = httpx.AsyncClient(timeout=5.0)

    @property
    def name(self) -> str:
        return self._display_name

    async def send(self, alert: AlertEvent) -> None:
        payload = {
            "rule_id": alert.rule_id,
            "severity": alert.severity,
            "title": alert.title,
            "detail": alert.detail,
            "fingerprint": alert.fingerprint,
            "ts": alert.ts,
            "formatted": format_alert(alert),
        }
        try:
            resp = await self._client.post(
                self._webhook_url,
                json=payload,
                headers=self._headers,
            )
            resp.raise_for_status()
        except httpx.HTTPError as e:
            logger.error("Webhook delivery failed: %s", e)
