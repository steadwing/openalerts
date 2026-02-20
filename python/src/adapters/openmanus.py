from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from openalerts.core.engine import OpenAlertsEngine
from openalerts.core.types import EventType, OpenAlertsEvent, Severity

logger = logging.getLogger("openalerts.adapters.openmanus")


class OpenManusAdapter:
    """Monkey-patching adapter for OpenManus agent framework.

    Patches the OpenManus class hierarchy to emit monitoring events:
      BaseAgent.run()              -> agent.start / agent.end / agent.error
      ReActAgent.step()            -> agent.step (with step_number / max_steps)
      BaseAgent.is_stuck()         -> agent.stuck
      ToolCallAgent.execute_tool() -> tool.call / tool.error (detected from return value)
      LLM.ask_tool()               -> llm.call / llm.error / llm.token_usage / token.limit_exceeded
      LLM.ask()                    -> llm.call / llm.error / llm.token_usage / token.limit_exceeded

    OpenManus's execute_tool() catches all exceptions internally and returns
    error strings prefixed with "Error:". This adapter detects that pattern
    to emit tool.error events rather than relying on exception propagation.
    """

    def __init__(self) -> None:
        self._originals: dict[str, Any] = {}
        self._engine: OpenAlertsEngine | None = None

    @property
    def name(self) -> str:
        return "openmanus"

    def patch(self, engine: OpenAlertsEngine) -> None:
        self._engine = engine

        try:
            from app.agent.base import BaseAgent
            from app.agent.react import ReActAgent
            from app.agent.toolcall import ToolCallAgent
            from app.llm import LLM
        except ImportError as e:
            raise ImportError(
                "OpenManus not found. Install it or ensure app/ is on your Python path."
            ) from e

        self._patch_base_agent_run(BaseAgent, engine)
        self._patch_react_agent_step(ReActAgent, engine)
        self._patch_is_stuck(BaseAgent, engine)
        self._patch_execute_tool(ToolCallAgent, engine)
        self._patch_llm(LLM, engine)

        logger.info("OpenManus adapter patched successfully")

    # ------------------------------------------------------------------
    # BaseAgent.run() -> agent.start / agent.end / agent.error
    # ------------------------------------------------------------------
    def _patch_base_agent_run(self, cls: type, engine: OpenAlertsEngine) -> None:
        original_run = cls.run
        self._originals["BaseAgent.run"] = original_run

        async def patched_run(self_agent: Any, request: str | None = None) -> str:
            agent_name = getattr(self_agent, "name", None)
            agent_class = type(self_agent).__name__
            start = time.time()

            await engine.ingest(OpenAlertsEvent(
                type=EventType.AGENT_START,
                agent_name=agent_name,
                agent_class=agent_class,
            ))
            try:
                result = await original_run(self_agent, request)
                duration_ms = (time.time() - start) * 1000
                await engine.ingest(OpenAlertsEvent(
                    type=EventType.AGENT_END,
                    agent_name=agent_name,
                    agent_class=agent_class,
                    duration_ms=duration_ms,
                    outcome="success",
                ))
                return result
            except Exception as e:
                duration_ms = (time.time() - start) * 1000
                await engine.ingest(OpenAlertsEvent(
                    type=EventType.AGENT_ERROR,
                    agent_name=agent_name,
                    agent_class=agent_class,
                    duration_ms=duration_ms,
                    error=str(e),
                    severity=Severity.ERROR,
                ))
                raise

        cls.run = patched_run

    # ------------------------------------------------------------------
    # ReActAgent.step() -> agent.step  (concrete implementation lives here,
    # BaseAgent.step() is abstract)
    # ------------------------------------------------------------------
    def _patch_react_agent_step(self, cls: type, engine: OpenAlertsEngine) -> None:
        original_step = cls.step
        self._originals["ReActAgent.step"] = original_step

        async def patched_step(self_agent: Any) -> str:
            # current_step is already incremented by BaseAgent.run() before calling step()
            step_num = getattr(self_agent, "current_step", None)
            max_steps = getattr(self_agent, "max_steps", None)
            start = time.time()

            result = await original_step(self_agent)
            duration_ms = (time.time() - start) * 1000

            await engine.ingest(OpenAlertsEvent(
                type=EventType.AGENT_STEP,
                agent_name=getattr(self_agent, "name", None),
                agent_class=type(self_agent).__name__,
                step_number=step_num,
                max_steps=max_steps,
                duration_ms=duration_ms,
            ))
            return result

        cls.step = patched_step

    # ------------------------------------------------------------------
    # BaseAgent.is_stuck() -> agent.stuck  (sync method, fire-and-forget)
    # ------------------------------------------------------------------
    def _patch_is_stuck(self, cls: type, engine: OpenAlertsEngine) -> None:
        if not hasattr(cls, "is_stuck"):
            return

        original_is_stuck = cls.is_stuck
        self._originals["BaseAgent.is_stuck"] = original_is_stuck

        def patched_is_stuck(self_agent: Any) -> bool:
            result = original_is_stuck(self_agent)
            if result:
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(engine.ingest(OpenAlertsEvent(
                        type=EventType.AGENT_STUCK,
                        agent_name=getattr(self_agent, "name", None),
                        agent_class=type(self_agent).__name__,
                        severity=Severity.WARN,
                    )))
                except RuntimeError:
                    pass
            return result

        cls.is_stuck = patched_is_stuck

    # ------------------------------------------------------------------
    # ToolCallAgent.execute_tool() -> tool.call / tool.error
    #
    # CRITICAL: OpenManus's execute_tool catches ALL exceptions internally
    # and returns error strings like "Error: Tool 'x' encountered a problem: ..."
    # We detect errors by checking the return value, not via try/except.
    # ------------------------------------------------------------------
    def _patch_execute_tool(self, cls: type, engine: OpenAlertsEngine) -> None:
        if not hasattr(cls, "execute_tool"):
            return

        original_execute = cls.execute_tool
        self._originals["ToolCallAgent.execute_tool"] = original_execute

        async def patched_execute_tool(self_agent: Any, command: Any) -> str:
            # Extract tool name from ToolCall.function.name
            tool_name = None
            if command and hasattr(command, "function"):
                tool_name = getattr(command.function, "name", None)

            agent_name = getattr(self_agent, "name", None)
            start = time.time()

            result = await original_execute(self_agent, command)
            duration_ms = (time.time() - start) * 1000

            # OpenManus returns "Error: ..." strings on failure instead of raising
            is_error = isinstance(result, str) and result.startswith("Error:")

            if is_error:
                await engine.ingest(OpenAlertsEvent(
                    type=EventType.TOOL_ERROR,
                    agent_name=agent_name,
                    tool_name=tool_name,
                    duration_ms=duration_ms,
                    error=result,
                    severity=Severity.WARN,
                ))
            else:
                await engine.ingest(OpenAlertsEvent(
                    type=EventType.TOOL_CALL,
                    agent_name=agent_name,
                    tool_name=tool_name,
                    duration_ms=duration_ms,
                    outcome="success",
                ))

            return result

        cls.execute_tool = patched_execute_tool

    # ------------------------------------------------------------------
    # LLM.ask_tool() / LLM.ask() -> llm.call / llm.error / llm.token_usage
    #
    # Token tracking: OpenManus's LLM class accumulates total_input_tokens
    # and total_completion_tokens internally. We snapshot before/after to
    # get the delta for each call. This works correctly even with retries
    # (the delta includes all retry attempts' tokens).
    #
    # TokenLimitExceeded: OpenManus raises this when token limits are hit.
    # After tenacity exhausts retries, a RetryError propagates up. We
    # detect this and emit a token.limit_exceeded event.
    # ------------------------------------------------------------------
    def _patch_llm(self, cls: type, engine: OpenAlertsEngine) -> None:
        for method_name in ("ask_tool", "ask"):
            if not hasattr(cls, method_name):
                continue

            original = getattr(cls, method_name)
            self._originals[f"LLM.{method_name}"] = original

            async def patched_llm_method(
                self_llm: Any,
                *args: Any,
                _original: Any = original,
                **kwargs: Any,
            ) -> Any:
                # Snapshot token counters before call
                input_before = getattr(self_llm, "total_input_tokens", 0)
                completion_before = getattr(self_llm, "total_completion_tokens", 0)
                start = time.time()

                try:
                    result = await _original(self_llm, *args, **kwargs)
                    duration_ms = (time.time() - start) * 1000

                    # Calculate token delta
                    input_delta = getattr(self_llm, "total_input_tokens", 0) - input_before
                    completion_delta = getattr(self_llm, "total_completion_tokens", 0) - completion_before
                    token_count = input_delta + completion_delta

                    await engine.ingest(OpenAlertsEvent(
                        type=EventType.LLM_CALL,
                        duration_ms=duration_ms,
                        token_count=token_count if token_count > 0 else None,
                        outcome="success",
                    ))

                    # Emit separate token_usage event if tokens were consumed
                    if token_count > 0:
                        await engine.ingest(OpenAlertsEvent(
                            type=EventType.LLM_TOKEN_USAGE,
                            token_count=token_count,
                            meta={
                                "input_tokens": input_delta,
                                "completion_tokens": completion_delta,
                                "model": getattr(self_llm, "model", None),
                            },
                        ))

                    return result
                except Exception as e:
                    duration_ms = (time.time() - start) * 1000

                    # Detect TokenLimitExceeded (raised by OpenManus when token limits hit)
                    # After tenacity retries, it arrives as RetryError.__cause__
                    cause = getattr(e, "__cause__", e)
                    is_token_limit = type(cause).__name__ == "TokenLimitExceeded"

                    if is_token_limit:
                        await engine.ingest(OpenAlertsEvent(
                            type=EventType.TOKEN_LIMIT,
                            duration_ms=duration_ms,
                            error=str(cause),
                            severity=Severity.ERROR,
                        ))

                    await engine.ingest(OpenAlertsEvent(
                        type=EventType.LLM_ERROR,
                        duration_ms=duration_ms,
                        error=str(e),
                        severity=Severity.ERROR,
                    ))
                    raise

            setattr(cls, method_name, patched_llm_method)

    # ------------------------------------------------------------------
    # Unpatch: restore all original methods
    # ------------------------------------------------------------------
    def unpatch(self) -> None:
        _class_map = {
            "BaseAgent": "app.agent.base",
            "ReActAgent": "app.agent.react",
            "ToolCallAgent": "app.agent.toolcall",
            "LLM": "app.llm",
        }

        for key, original in self._originals.items():
            cls_name, method_name = key.split(".")
            module_path = _class_map.get(cls_name)
            if not module_path:
                continue
            try:
                import importlib

                mod = importlib.import_module(module_path)
                cls = getattr(mod, cls_name)
                setattr(cls, method_name, original)
            except (ImportError, AttributeError):
                pass

        self._originals.clear()
        self._engine = None
        logger.info("OpenManus adapter unpatched")
