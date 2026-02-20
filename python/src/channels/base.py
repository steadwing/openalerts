from __future__ import annotations

from typing import Protocol

from openalerts.core.types import AlertEvent


class AlertChannel(Protocol):
    @property
    def name(self) -> str: ...

    async def send(self, alert: AlertEvent) -> None: ...
