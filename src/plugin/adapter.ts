import type {
	AlertChannel,
	AlertEvent,
	AlertTarget,
	MonitorConfig,
	OpenAlertsEvent,
	OpenAlertsEventType,
} from "../core/index.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ─── Diagnostic Event Translation ───────────────────────────────────────────
//
// OpenClaw emits 12 diagnostic event types through onDiagnosticEvent():
//   model.usage, webhook.received, webhook.processed, webhook.error,
//   message.queued, message.processed, session.state, session.stuck,
//   queue.lane.enqueue, queue.lane.dequeue, diagnostic.heartbeat,
//   run.attempt (reserved, not yet emitted)
//
// Agent/tool/session lifecycle events come through plugin hooks (api.on()),
// not diagnostic events. Those are handled separately in index.ts.
// ────────────────────────────────────────────────────────────────────────────

const DIAGNOSTIC_EVENT_MAP: Record<string, OpenAlertsEventType> = {
	// Infrastructure
	"webhook.error": "infra.error",
	"webhook.received": "custom", // inbound webhook arrival (informational)
	"webhook.processed": "custom", // webhook fully handled (informational)

	// LLM / Message processing
	"message.processed": "llm.call",
	"message.queued": "infra.queue_depth",
	"model.usage": "llm.token_usage",

	// Session
	"session.stuck": "session.stuck",
	"session.state": "custom", // state transitions (idle→processing→waiting)

	// Heartbeat
	"diagnostic.heartbeat": "infra.heartbeat",
	heartbeat: "infra.heartbeat",

	// Queue lanes
	"queue.lane.enqueue": "infra.queue_depth",
	"queue.lane.dequeue": "infra.queue_depth",

	// Watchdog (internal, injected by engine timer)
	"watchdog.tick": "watchdog.tick",

	// Reserved (not yet emitted by OpenClaw)
	"run.attempt": "agent.start",
};

/**
 * Normalize OpenClaw outcome values to OpenAlertsEvent outcome.
 * OpenClaw uses "completed"/"failed"/"success"/"error" inconsistently
 * across different event types.
 */
function normalizeOutcome(
	raw: unknown,
): OpenAlertsEvent["outcome"] | undefined {
	if (typeof raw !== "string") return undefined;
	switch (raw) {
		case "success":
		case "completed":
		case "ok":
			return "success";
		case "error":
		case "failed":
		case "failure":
			return "error";
		case "skipped":
			return "skipped";
		case "timeout":
		case "timed_out":
			return "timeout";
		default:
			return undefined;
	}
}

/**
 * Translate an OpenClaw diagnostic event into a universal OpenAlertsEvent.
 * Returns null for unmapped event types.
 */
export function translateOpenClawEvent(event: {
	type: string;
	[key: string]: unknown;
}): OpenAlertsEvent | null {
	const type = DIAGNOSTIC_EVENT_MAP[event.type];
	if (!type) return null;

	const base: OpenAlertsEvent = {
		type,
		ts: typeof event.ts === "number" ? event.ts : Date.now(),
		channel: event.channel as string | undefined,
		sessionKey: event.sessionKey as string | undefined,
		agentId: event.agentId as string | undefined,
		durationMs: event.durationMs as number | undefined,
		outcome: normalizeOutcome(event.outcome ?? event.status),
		error: event.error as string | undefined,
		ageMs: event.ageMs as number | undefined,
		meta: { openclawEventType: event.type },
	};

	// ── Queue depth: from heartbeat, message.queued, or queue.lane events ────
	if (typeof event.queued === "number") {
		base.queueDepth = event.queued;
	} else if (typeof event.queueDepth === "number") {
		base.queueDepth = event.queueDepth;
	} else if (typeof event.depth === "number") {
		base.queueDepth = event.depth;
	}

	// ── model.usage: extract token counts and cost ───────────────────────────
	if (event.type === "model.usage") {
		const usage = event.usage as Record<string, unknown> | undefined;
		if (usage) {
			if (typeof usage.totalTokens === "number") {
				base.tokenCount = usage.totalTokens;
			} else if (
				typeof usage.inputTokens === "number" ||
				typeof usage.outputTokens === "number"
			) {
				base.tokenCount =
					((usage.inputTokens as number) ?? 0) +
					((usage.outputTokens as number) ?? 0);
			}
			if (typeof usage.costUsd === "number") {
				base.costUsd = usage.costUsd;
			}
		}
		if (typeof event.tokenCount === "number")
			base.tokenCount = event.tokenCount;
		if (typeof event.costUsd === "number") base.costUsd = event.costUsd;
		if (event.model) base.meta!.model = event.model;
		if (event.provider) base.meta!.provider = event.provider;
	}

	// ── session.state: carry transition info ─────────────────────────────────
	if (event.type === "session.state") {
		if (event.state) base.meta!.sessionState = event.state;
		if (event.previousState) base.meta!.previousState = event.previousState;
		// Map terminal states to specific event types
		const state = event.state as string | undefined;
		if (state === "ended" || state === "closed") {
			(base as { type: OpenAlertsEventType }).type = "session.end";
		} else if (state === "started" || state === "created") {
			(base as { type: OpenAlertsEventType }).type = "session.start";
		}
	}

	// ── queue.lane.*: extract lane info and wait time ────────────────────────
	if (
		event.type === "queue.lane.enqueue" ||
		event.type === "queue.lane.dequeue"
	) {
		if (typeof event.waitMs === "number") base.durationMs = event.waitMs;
		if (event.lane) base.meta!.lane = event.lane;
	}

	// ── webhook.*: preserve HTTP method and path ─────────────────────────────
	if (event.type === "webhook.received" || event.type === "webhook.processed") {
		if (event.method) base.meta!.method = event.method;
		if (event.path) base.meta!.path = event.path;
		base.outcome = base.outcome ?? "success";
	}

	// ── message.queued: ensure queue depth is set ────────────────────────────
	if (event.type === "message.queued") {
		base.outcome = base.outcome ?? "success";
	}

	return base;
}

// ─── Plugin Hook Event Translation ──────────────────────────────────────────
//
// Plugin hooks provide lifecycle events that diagnostic events don't cover:
// tool calls, agent lifecycle, session lifecycle, gateway lifecycle.
// These functions are called from index.ts where api.on() is wired.
// ────────────────────────────────────────────────────────────────────────────

/** Translate after_tool_call hook data into OpenAlertsEvent. */
export function translateToolCallHook(
	data: {
		toolName: string;
		params: Record<string, unknown>;
		result?: unknown;
		error?: string;
		durationMs?: number;
	},
	context: { sessionId?: string; agentId?: string },
): OpenAlertsEvent {
	return {
		type: data.error ? "tool.error" : "tool.call",
		ts: Date.now(),
		sessionKey: context.sessionId,
		agentId: context.agentId,
		durationMs: data.durationMs,
		outcome: data.error ? "error" : "success",
		error: data.error,
		meta: { toolName: data.toolName, source: "hook:after_tool_call" },
	};
}

/** Translate before_agent_start hook data into OpenAlertsEvent. */
export function translateAgentStartHook(
	data: {
		prompt: string;
		messages?: unknown[];
	},
	context: { sessionId?: string; agentId?: string },
): OpenAlertsEvent {
	return {
		type: "agent.start",
		ts: Date.now(),
		sessionKey: context.sessionId,
		agentId: context.agentId,
		outcome: "success",
		meta: { source: "hook:before_agent_start" },
	};
}

/** Translate agent_end hook data into OpenAlertsEvent. */
export function translateAgentEndHook(
	data: {
		messages: unknown[];
		success: boolean;
		error?: string;
		durationMs?: number;
	},
	context: { sessionId?: string; agentId?: string },
): OpenAlertsEvent {
	return {
		type: data.success ? "agent.end" : "agent.error",
		ts: Date.now(),
		sessionKey: context.sessionId,
		agentId: context.agentId,
		durationMs: data.durationMs,
		outcome: data.success ? "success" : "error",
		error: data.error,
		meta: {
			messageCount: data.messages?.length ?? 0,
			source: "hook:agent_end",
		},
	};
}

/** Translate session_start hook data into OpenAlertsEvent. */
export function translateSessionStartHook(data: {
	sessionId: string;
	resumedFrom?: string;
}): OpenAlertsEvent {
	return {
		type: "session.start",
		ts: Date.now(),
		sessionKey: data.sessionId,
		outcome: "success",
		meta: {
			resumedFrom: data.resumedFrom,
			source: "hook:session_start",
		},
	};
}

/** Translate session_end hook data into OpenAlertsEvent. */
export function translateSessionEndHook(data: {
	sessionId: string;
	messageCount: number;
	durationMs?: number;
}): OpenAlertsEvent {
	return {
		type: "session.end",
		ts: Date.now(),
		sessionKey: data.sessionId,
		durationMs: data.durationMs,
		outcome: "success",
		meta: { messageCount: data.messageCount, source: "hook:session_end" },
	};
}

/** Translate message_sent hook data into OpenAlertsEvent (delivery tracking). */
export function translateMessageSentHook(
	data: {
		to: string;
		content: string;
		success: boolean;
		error?: string;
	},
	context: { channel?: string; sessionId?: string },
): OpenAlertsEvent {
	return {
		type: data.success ? "custom" : "infra.error",
		ts: Date.now(),
		channel: context.channel,
		sessionKey: context.sessionId,
		outcome: data.success ? "success" : "error",
		error: data.error,
		meta: { to: data.to, source: "hook:message_sent" },
	};
}

/** Translate gateway_start hook data into OpenAlertsEvent. */
export function translateGatewayStartHook(data: {
	port: number;
}): OpenAlertsEvent {
	return {
		type: "infra.heartbeat",
		ts: Date.now(),
		outcome: "success",
		meta: { port: data.port, source: "hook:gateway_start" },
	};
}

/** Translate gateway_stop hook data into OpenAlertsEvent. */
export function translateGatewayStopHook(data: {
	reason?: string;
}): OpenAlertsEvent {
	return {
		type: "infra.error",
		ts: Date.now(),
		outcome: "error",
		error: data.reason ?? "Gateway stopped",
		meta: { source: "hook:gateway_stop" },
	};
}

/** Translate message_received hook data into OpenAlertsEvent (inbound tracking). */
export function translateMessageReceivedHook(
	data: {
		from: string;
		content: string;
		timestamp?: number;
		metadata?: Record<string, unknown>;
	},
	context: { channelId?: string; accountId?: string },
): OpenAlertsEvent {
	return {
		type: "custom",
		ts: data.timestamp ?? Date.now(),
		channel: context.channelId,
		outcome: "success",
		meta: {
			from: data.from,
			accountId: context.accountId,
			openclawHook: "message_received",
			source: "hook:message_received",
		},
	};
}

/** Translate before_tool_call hook data into OpenAlertsEvent (tool start tracking). */
export function translateBeforeToolCallHook(
	data: {
		toolName: string;
		params: Record<string, unknown>;
	},
	context: { sessionId?: string; agentId?: string },
): OpenAlertsEvent {
	return {
		type: "custom",
		ts: Date.now(),
		sessionKey: context.sessionId,
		agentId: context.agentId,
		outcome: "success",
		meta: {
			toolName: data.toolName,
			openclawHook: "before_tool_call",
			source: "hook:before_tool_call",
		},
	};
}

/** Translate before_compaction hook data into OpenAlertsEvent. */
export function translateBeforeCompactionHook(
	data: {
		messageCount: number;
		tokenCount?: number;
	},
	context: { sessionKey?: string; agentId?: string },
): OpenAlertsEvent {
	return {
		type: "custom",
		ts: Date.now(),
		sessionKey: context.sessionKey,
		agentId: context.agentId,
		outcome: "success",
		meta: {
			messageCount: data.messageCount,
			tokenCount: data.tokenCount,
			openclawHook: "before_compaction",
			source: "hook:before_compaction",
		},
	};
}

/** Translate after_compaction hook data into OpenAlertsEvent. */
export function translateAfterCompactionHook(
	data: {
		messageCount: number;
		tokenCount?: number;
		compactedCount: number;
	},
	context: { sessionKey?: string; agentId?: string },
): OpenAlertsEvent {
	return {
		type: "custom",
		ts: Date.now(),
		sessionKey: context.sessionKey,
		agentId: context.agentId,
		outcome: "success",
		meta: {
			messageCount: data.messageCount,
			tokenCount: data.tokenCount,
			compactedCount: data.compactedCount,
			openclawHook: "after_compaction",
			source: "hook:after_compaction",
		},
	};
}

/** Translate message_sending hook data into OpenAlertsEvent (pre-send tracking). */
export function translateMessageSendingHook(
	data: {
		to: string;
		content: string;
		metadata?: Record<string, unknown>;
	},
	context: { channelId?: string; accountId?: string },
): OpenAlertsEvent {
	return {
		type: "custom",
		ts: Date.now(),
		channel: context.channelId,
		outcome: "success",
		meta: {
			to: data.to,
			accountId: context.accountId,
			openclawHook: "message_sending",
			source: "hook:message_sending",
		},
	};
}

/** Translate tool_result_persist hook data into OpenAlertsEvent. */
export function translateToolResultPersistHook(
	data: {
		toolName?: string;
		toolCallId?: string;
		isSynthetic?: boolean;
	},
	context: { sessionKey?: string; agentId?: string; toolName?: string },
): OpenAlertsEvent {
	return {
		type: "custom",
		ts: Date.now(),
		sessionKey: context.sessionKey,
		agentId: context.agentId,
		outcome: "success",
		meta: {
			toolName: data.toolName ?? context.toolName,
			toolCallId: data.toolCallId,
			isSynthetic: data.isSynthetic,
			openclawHook: "tool_result_persist",
			source: "hook:tool_result_persist",
		},
	};
}

// ─── OpenClaw Alert Channel ─────────────────────────────────────────────────

/**
 * AlertChannel that sends through OpenClaw's runtime channel API.
 * Bridges the universal AlertChannel interface to OpenClaw's messaging system.
 */
export class OpenClawAlertChannel implements AlertChannel {
	readonly name: string;
	private api: OpenClawPluginApi;
	private target: AlertTarget;

	constructor(api: OpenClawPluginApi, target: AlertTarget) {
		this.api = api;
		this.target = target;
		this.name = `openclaw:${target.channel}`;
	}

	async send(alert: AlertEvent, formatted: string): Promise<void> {
		const runtime = this.api.runtime as Record<string, unknown>;
		const channel = runtime.channel as Record<string, unknown> | undefined;
		if (!channel) return;

		const opts = this.target.accountId
			? { accountId: this.target.accountId }
			: {};

		const channelMethods: Record<string, string> = {
			telegram: "sendMessageTelegram",
			discord: "sendMessageDiscord",
			slack: "sendMessageSlack",
			whatsapp: "sendMessageWhatsApp",
			signal: "sendMessageSignal",
		};

		const methodName = channelMethods[this.target.channel];
		if (!methodName) return;

		const channelMod = channel[this.target.channel] as
			| Record<string, unknown>
			| undefined;
		const sendFn = channelMod?.[methodName] as
			| ((
					to: string,
					text: string,
					opts?: Record<string, unknown>,
			  ) => Promise<unknown>)
			| undefined;

		if (sendFn) {
			await sendFn(this.target.to, formatted, opts);
		}
	}
}

// ─── Alert Target Resolution ────────────────────────────────────────────────

/**
 * Resolve the alert target from plugin config or by auto-detecting from OpenClaw config.
 */
export function resolveAlertTarget(
	api: OpenClawPluginApi,
	pluginConfig: MonitorConfig,
): AlertTarget | null {
	// 1. Explicit config
	if (pluginConfig.alertChannel && pluginConfig.alertTo) {
		return {
			channel: pluginConfig.alertChannel,
			to: pluginConfig.alertTo,
			accountId: pluginConfig.alertAccountId,
		};
	}

	const cfg = api.config;

	// 2. Auto-detect from configured channels
	const channelKeys = [
		"telegram",
		"discord",
		"slack",
		"whatsapp",
		"signal",
	] as const;

	for (const channelKey of channelKeys) {
		const channelConfig = (cfg as Record<string, unknown>)[channelKey];
		if (!channelConfig || typeof channelConfig !== "object") continue;

		const target = extractFirstAllowFrom(
			channelKey,
			channelConfig as Record<string, unknown>,
		);
		if (target) return target;
	}

	return null;
}

function extractFirstAllowFrom(
	channel: string,
	channelConfig: Record<string, unknown>,
): AlertTarget | null {
	const directAllow = channelConfig.allowFrom;
	if (Array.isArray(directAllow) && directAllow.length > 0) {
		return { channel, to: String(directAllow[0]) };
	}

	for (const [key, value] of Object.entries(channelConfig)) {
		if (!value || typeof value !== "object") continue;
		const accountObj = value as Record<string, unknown>;
		const allow = accountObj.allowFrom;
		if (Array.isArray(allow) && allow.length > 0) {
			return {
				channel,
				to: String(allow[0]),
				accountId: key === "default" ? undefined : key,
			};
		}
	}

	return null;
}

// ─── Config Parsing ─────────────────────────────────────────────────────────

export function parseConfig(
	raw: Record<string, unknown> | undefined,
): MonitorConfig {
	if (!raw) return {};
	return {
		apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
		alertChannel:
			typeof raw.alertChannel === "string" ? raw.alertChannel : undefined,
		alertTo: typeof raw.alertTo === "string" ? raw.alertTo : undefined,
		alertAccountId:
			typeof raw.alertAccountId === "string" ? raw.alertAccountId : undefined,
		cooldownMinutes:
			typeof raw.cooldownMinutes === "number" ? raw.cooldownMinutes : undefined,
		maxLogSizeKb:
			typeof raw.maxLogSizeKb === "number" ? raw.maxLogSizeKb : undefined,
		maxLogAgeDays:
			typeof raw.maxLogAgeDays === "number" ? raw.maxLogAgeDays : undefined,
		quiet: typeof raw.quiet === "boolean" ? raw.quiet : undefined,
		rules:
			raw.rules && typeof raw.rules === "object"
				? (raw.rules as MonitorConfig["rules"])
				: undefined,
	};
}
