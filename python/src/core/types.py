from __future__ import annotations

import time
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class EventType(StrEnum):
    # LLM events
    LLM_CALL = "llm.call"
    LLM_ERROR = "llm.error"
    LLM_TOKEN_USAGE = "llm.token_usage"
    # Tool events
    TOOL_CALL = "tool.call"
    TOOL_ERROR = "tool.error"
    # Agent events
    AGENT_START = "agent.start"
    AGENT_END = "agent.end"
    AGENT_ERROR = "agent.error"
    AGENT_STUCK = "agent.stuck"
    AGENT_STEP = "agent.step"
    # Token/cost events
    TOKEN_LIMIT = "token.limit_exceeded"
    STEP_LIMIT = "step.limit_warning"
    # Custom
    CUSTOM = "custom"


class Severity(StrEnum):
    INFO = "info"
    WARN = "warn"
    ERROR = "error"
    CRITICAL = "critical"


class OpenAlertsEvent(BaseModel):
    type: EventType
    ts: float = Field(default_factory=time.time)
    severity: Severity = Severity.INFO
    agent_name: str | None = None
    agent_class: str | None = None
    tool_name: str | None = None
    duration_ms: float | None = None
    token_count: int | None = None
    error: str | None = None
    outcome: str | None = None
    step_number: int | None = None
    max_steps: int | None = None
    meta: dict[str, Any] | None = None


class AlertEvent(BaseModel):
    rule_id: str
    severity: Severity
    title: str
    detail: str
    fingerprint: str
    ts: float = Field(default_factory=time.time)
    events: list[OpenAlertsEvent] = Field(default_factory=list)
