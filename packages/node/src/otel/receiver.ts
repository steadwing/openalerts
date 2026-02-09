import type { OpenAlertsEvent, OpenAlertsEventType } from "@steadwing/openalerts-core";

/**
 * OpenInference span kinds → OpenAlertsEvent types.
 * OpenInference is the standard used by Phoenix/Arize for AI observability.
 */
const SPAN_KIND_MAP: Record<string, OpenAlertsEventType> = {
  LLM: "llm.call",
  TOOL: "tool.call",
  AGENT: "agent.end",
  CHAIN: "agent.end",
  EMBEDDING: "llm.call",
  RETRIEVER: "tool.call",
};

/**
 * Minimal OTLP span shape (subset of opentelemetry-proto).
 * We only need the fields we map to OpenAlertsEvent.
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
 * Convert an OTLP span (OpenInference conventions) to an OpenAlertsEvent.
 *
 * Works with traces exported by Phoenix, Arize, LangSmith, etc.
 * Apps exporting OTLP spans can pipe them through OpenAlerts with no code changes.
 *
 * ```ts
 * import { otlpSpanToEvent } from "@steadwing/openalerts-node/otel";
 * const event = otlpSpanToEvent(span);
 * if (event) captureEvent(event);
 * ```
 */
export function otlpSpanToEvent(span: OtlpSpan): OpenAlertsEvent | null {
  // Determine span kind from OpenInference attribute
  const openInferenceKind = getAttr(span, "openinference.span.kind") as string | undefined;
  const eventType = openInferenceKind ? SPAN_KIND_MAP[openInferenceKind] : undefined;

  if (!eventType) return null;

  const startMs = nanosToMs(span.startTimeUnixNano);
  const endMs = nanosToMs(span.endTimeUnixNano);

  const isError = span.status?.code === 2; // OTLP StatusCode.ERROR

  const event: OpenAlertsEvent = {
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
 * Returns array of OpenAlertsEvents (nulls filtered out).
 */
export function otlpBatchToEvents(
  resourceSpans: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>,
): OpenAlertsEvent[] {
  const events: OpenAlertsEvent[] = [];

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
