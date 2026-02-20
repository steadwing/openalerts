from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Protocol

from openalerts.core.types import AlertEvent, EventType, OpenAlertsEvent, Severity

if TYPE_CHECKING:
    from openalerts.core.evaluator import RuleContext


class AlertRule(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def default_cooldown_seconds(self) -> int: ...

    @property
    def default_threshold(self) -> int | float: ...

    def evaluate(self, event: OpenAlertsEvent, ctx: RuleContext) -> AlertEvent | None: ...


def _fingerprint(*parts: str) -> str:
    return hashlib.md5(":".join(parts).encode()).hexdigest()[:12]


class LLMErrorsRule:
    id = "llm-errors"
    default_cooldown_seconds = 900
    default_threshold = 1

    def evaluate(self, event: OpenAlertsEvent, ctx: RuleContext) -> AlertEvent | None:
        if event.type != EventType.LLM_ERROR:
            return None
        window = ctx.get_window(self.id, window_seconds=60)
        errors = [e for e in window if e.type == EventType.LLM_ERROR]
        threshold = ctx.get_threshold(self.id, self.default_threshold)
        if len(errors) >= threshold:
            return AlertEvent(
                rule_id=self.id,
                severity=Severity.ERROR,
                title="LLM API Errors Detected",
                detail=f"{len(errors)} LLM error(s) in the last 60s. Latest: {event.error or 'unknown'}",
                fingerprint=_fingerprint(self.id),
                events=errors,
            )
        return None


class ToolErrorsRule:
    id = "tool-errors"
    default_cooldown_seconds = 900
    default_threshold = 1

    def evaluate(self, event: OpenAlertsEvent, ctx: RuleContext) -> AlertEvent | None:
        if event.type != EventType.TOOL_ERROR:
            return None
        window = ctx.get_window(self.id, window_seconds=60)
        errors = [e for e in window if e.type == EventType.TOOL_ERROR]
        threshold = ctx.get_threshold(self.id, self.default_threshold)
        if len(errors) >= threshold:
            return AlertEvent(
                rule_id=self.id,
                severity=Severity.WARN,
                title="Tool Execution Errors",
                detail=f"{len(errors)} tool error(s) in the last 60s. Tool: {event.tool_name or 'unknown'}",
                fingerprint=_fingerprint(self.id, event.tool_name or ""),
                events=errors,
            )
        return None


class AgentStuckRule:
    id = "agent-stuck"
    default_cooldown_seconds = 900
    default_threshold = 1

    def evaluate(self, event: OpenAlertsEvent, ctx: RuleContext) -> AlertEvent | None:
        if event.type != EventType.AGENT_STUCK:
            return None
        return AlertEvent(
            rule_id=self.id,
            severity=Severity.WARN,
            title="Agent Stuck",
            detail=f"Agent '{event.agent_name or 'unknown'}' appears stuck (repeating actions).",
            fingerprint=_fingerprint(self.id, event.agent_name or ""),
            events=[event],
        )


class TokenLimitRule:
    id = "token-limit"
    default_cooldown_seconds = 900
    default_threshold = 1

    def evaluate(self, event: OpenAlertsEvent, ctx: RuleContext) -> AlertEvent | None:
        if event.type != EventType.TOKEN_LIMIT:
            return None
        return AlertEvent(
            rule_id=self.id,
            severity=Severity.ERROR,
            title="Token Limit Exceeded",
            detail=f"Agent '{event.agent_name or 'unknown'}' exceeded token limit.",
            fingerprint=_fingerprint(self.id, event.agent_name or ""),
            events=[event],
        )


class StepLimitWarningRule:
    id = "step-limit-warning"
    default_cooldown_seconds = 900
    default_threshold = 80  # percentage

    def evaluate(self, event: OpenAlertsEvent, ctx: RuleContext) -> AlertEvent | None:
        if event.type != EventType.AGENT_STEP:
            return None
        if event.step_number is None or event.max_steps is None:
            return None
        threshold_pct = ctx.get_threshold(self.id, self.default_threshold)
        pct = (event.step_number / event.max_steps) * 100
        if pct >= threshold_pct:
            return AlertEvent(
                rule_id=self.id,
                severity=Severity.WARN,
                title="Step Limit Warning",
                detail=(
                    f"Agent '{event.agent_name or 'unknown'}' at step "
                    f"{event.step_number}/{event.max_steps} ({pct:.0f}%)."
                ),
                fingerprint=_fingerprint(self.id, event.agent_name or ""),
                events=[event],
            )
        return None


class HighErrorRateRule:
    id = "high-error-rate"
    default_cooldown_seconds = 900
    default_threshold = 50  # percentage

    def evaluate(self, event: OpenAlertsEvent, ctx: RuleContext) -> AlertEvent | None:
        if event.type not in (EventType.TOOL_CALL, EventType.TOOL_ERROR):
            return None
        window = ctx.get_window(self.id, window_seconds=300)
        tool_events = [
            e for e in window if e.type in (EventType.TOOL_CALL, EventType.TOOL_ERROR)
        ]
        if len(tool_events) < 20:
            return None
        recent = tool_events[-20:]
        errors = [e for e in recent if e.type == EventType.TOOL_ERROR]
        rate = (len(errors) / 20) * 100
        threshold_pct = ctx.get_threshold(self.id, self.default_threshold)
        if rate > threshold_pct:
            return AlertEvent(
                rule_id=self.id,
                severity=Severity.ERROR,
                title="High Tool Error Rate",
                detail=f"{rate:.0f}% of last 20 tool calls failed ({len(errors)}/20).",
                fingerprint=_fingerprint(self.id),
                events=recent,
            )
        return None


ALL_RULES: list[AlertRule] = [  # type: ignore[list-item]
    LLMErrorsRule(),
    ToolErrorsRule(),
    AgentStuckRule(),
    TokenLimitRule(),
    StepLimitWarningRule(),
    HighErrorRateRule(),
]
