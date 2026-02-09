import type { SteadwingEvent, SteadwingEventType } from "@steadwing/core";

/**
 * OpenInference span kinds → SteadwingEvent types.
 * OpenInference is the standard used by Phoenix/Arize for AI observability.
 */
const SPAN_KIND_MAP: Record<string, SteadwingEventType> = {
  LLM: "llm.call",
  TOOL: "tool.call",
  AGENT: "agent.end",
  CHAIN: "agent.end",
  EMBEDDING: "llm.call",
  RETRIEVER: "tool.call",
};

/**
 * Minimal OTLP span shape (subset of opentelemetry-proto).
 * We only need the fields we map to SteadwingEvent.
 */
export type OtlpSpan = {
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  status?: { code?: number; message?: string };
  attributes?: Array<{
    key: string;
    value: { stringValue?: string; intValue?: string | number; doubleValue?: number };
  }>;
};

function getAttr(span: OtlpSpan, key: string): string | number | undefined {
  const attr = span.attributes?.find((a) => a.key === key);
  if (!attr) return undefined;
  return attr.value.stringValue ?? attr.value.intValue ?? attr.value.doubleValue;
}

function nanosToMs(nanos: string | number | undefined): number {
  if (nanos === undefined) return Date.now();
  const n = typeof nanos === "string" ? BigInt(nanos) : BigInt(nanos);
  return Number(n / BigInt(1_000_000));
}

/**
 * Convert an OTLP span (OpenInference conventions) to a SteadwingEvent.
 *
 * Works with traces exported by Phoenix, Arize, LangSmith, etc.
 * Apps exporting OTLP spans can pipe them through Steadwing with no code changes.
 *
 * ```ts
 * import { otlpSpanToEvent } from "@steadwing/node/otel";
 * const event = otlpSpanToEvent(span);
 * if (event) captureEvent(event);
 * ```
 */
export function otlpSpanToEvent(span: OtlpSpan): SteadwingEvent | null {
  // Determine span kind from OpenInference attribute
  const openInferenceKind = getAttr(span, "openinference.span.kind") as string | undefined;
  const eventType = openInferenceKind ? SPAN_KIND_MAP[openInferenceKind] : undefined;

  if (!eventType) return null;

  const startMs = nanosToMs(span.startTimeUnixNano);
  const endMs = nanosToMs(span.endTimeUnixNano);

  const isError = span.status?.code === 2; // OTLP StatusCode.ERROR

  const event: SteadwingEvent = {
    type: eventType,
    ts: endMs || startMs,
    outcome: isError ? "error" : "success",
    durationMs: endMs && startMs ? endMs - startMs : undefined,
    error: isError ? span.status?.message : undefined,
  };

  // Extract token counts if present (OpenInference conventions)
  const inputTokens = getAttr(span, "llm.token_count.prompt") as number | undefined;
  const outputTokens = getAttr(span, "llm.token_count.completion") as number | undefined;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    event.tokenCount = (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  // Extract model name as meta
  const model = getAttr(span, "llm.model_name") as string | undefined;
  if (model) {
    event.meta = { model, spanName: span.name };
  } else if (span.name) {
    event.meta = { spanName: span.name };
  }

  return event;
}

/**
 * Process a batch of OTLP resource spans.
 * Returns array of SteadwingEvents (nulls filtered out).
 */
export function otlpBatchToEvents(
  resourceSpans: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>,
): SteadwingEvent[] {
  const events: SteadwingEvent[] = [];

  for (const rs of resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const event = otlpSpanToEvent(span);
        if (event) events.push(event);
      }
    }
  }

  return events;
}
