import {
	DEFAULTS,
	type AlertEvent,
	type AlertRuleDefinition,
	type RuleContext,
	type OpenAlertsEvent,
	type WindowEntry,
} from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAlertId(ruleId: string, fingerprint: string, ts: number): string {
	return `${ruleId}:${fingerprint}:${ts}`;
}

function pushWindow(ctx: RuleContext, name: string, entry: WindowEntry): void {
	let window = ctx.state.windows.get(name);
	if (!window) {
		window = [];
		ctx.state.windows.set(name, window);
	}
	window.push(entry);
	// Evict old entries beyond max
	if (window.length > DEFAULTS.maxWindowEntries) {
		window.splice(0, window.length - DEFAULTS.maxWindowEntries);
	}
}

function countInWindow(
	ctx: RuleContext,
	name: string,
	windowMs: number,
): number {
	const window = ctx.state.windows.get(name);
	if (!window) return 0;
	const cutoff = ctx.now - windowMs;
	return window.filter((e) => e.ts >= cutoff).length;
}

function sumInWindow(
	ctx: RuleContext,
	name: string,
	windowMs: number,
): number {
	const window = ctx.state.windows.get(name);
	if (!window) return 0;
	const cutoff = ctx.now - windowMs;
	let total = 0;
	for (const entry of window) {
		if (entry.ts >= cutoff) {
			total += entry.value ?? 0;
		}
	}
	return total;
}

function pushSummedBucket(
	ctx: RuleContext,
	name: string,
	value: number,
	bucketMs: number,
	maxEntries: number,
): void {
	if (!Number.isFinite(value) || value <= 0) return;
	const bucketTs = Math.floor(ctx.now / bucketMs) * bucketMs;
	let window = ctx.state.windows.get(name);
	if (!window) {
		window = [];
		ctx.state.windows.set(name, window);
	}

	const last = window[window.length - 1];
	if (last && last.ts === bucketTs) {
		last.value = (last.value ?? 0) + value;
	} else {
		window.push({ ts: bucketTs, value });
	}

	if (window.length > maxEntries) {
		window.splice(0, window.length - maxEntries);
	}
}

function getRuleThreshold(
	ctx: RuleContext,
	ruleId: string,
	defaultVal: number,
): number {
	return ctx.config.rules?.[ruleId]?.threshold ?? defaultVal;
}

function isRuleEnabled(ctx: RuleContext, ruleId: string): boolean {
	return ctx.config.rules?.[ruleId]?.enabled !== false;
}

// ─── Rule: infra-errors (was: webhook-errors) ───────────────────────────────

const infraErrors: AlertRuleDefinition = {
	id: "infra-errors",
	defaultCooldownMs: 15 * 60 * 1000,
	defaultThreshold: 1,

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		if (event.type !== "infra.error") return null;
		if (!isRuleEnabled(ctx, "infra-errors")) return null;

		const channel = event.channel ?? "unknown";
		pushWindow(ctx, "infra-errors", { ts: ctx.now });

		const threshold = getRuleThreshold(ctx, "infra-errors", 1);
		const windowMs = 60 * 1000; // 1 minute
		const count = countInWindow(ctx, "infra-errors", windowMs);

		if (count < threshold) return null;

		const fingerprint = `infra-errors:${channel}`;
		return {
			type: "alert",
			id: makeAlertId("infra-errors", fingerprint, ctx.now),
			ruleId: "infra-errors",
			severity: "error",
			title: "Infrastructure errors spike",
			detail: `${count} infra error(s) on ${channel} in the last minute.${event.error ? ` Last: ${event.error}` : ""}`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: llm-errors (was: message-errors) ─────────────────────────────────

const llmErrors: AlertRuleDefinition = {
	id: "llm-errors",
	defaultCooldownMs: 15 * 60 * 1000,
	defaultThreshold: 1,

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		// Trigger on LLM call/error events AND agent errors (agent failing before/during LLM call)
		if (event.type !== "llm.call" && event.type !== "llm.error" && event.type !== "agent.error") return null;
		if (!isRuleEnabled(ctx, "llm-errors")) return null;

		// Stats are tracked in the evaluator (independent of rule state).
		// Only proceed for actual errors:
		if (event.type === "llm.call") {
			// Only explicit error/timeout outcomes trigger alerting; undefined = OK
			if (event.outcome !== "error" && event.outcome !== "timeout") return null;
		}
		// llm.error and agent.error are always errors — no outcome check needed
		const channel = event.channel ?? "unknown";
		pushWindow(ctx, "llm-errors", { ts: ctx.now });

		const threshold = getRuleThreshold(ctx, "llm-errors", 1);
		const windowMs = 60 * 1000; // 1 minute
		const count = countInWindow(ctx, "llm-errors", windowMs);

		if (count < threshold) return null;

		const fingerprint = `llm-errors:${channel}`;
		const label = event.type === "agent.error" ? "agent error(s)" : "LLM error(s)";
		return {
			type: "alert",
			id: makeAlertId("llm-errors", fingerprint, ctx.now),
			ruleId: "llm-errors",
			severity: "error",
			title: "LLM call errors",
			detail: `${count} ${label} on ${channel} in the last minute.${event.error ? ` Last: ${event.error}` : ""}`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: session-stuck ─────────────────────────────────────────────────────

const sessionStuck: AlertRuleDefinition = {
	id: "session-stuck",
	defaultCooldownMs: 30 * 60 * 1000,
	defaultThreshold: 120_000, // 120 seconds

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		if (event.type !== "session.stuck") return null;
		if (!isRuleEnabled(ctx, "session-stuck")) return null;

		// Stats tracked in evaluator (independent of rule state)
		const ageMs = event.ageMs ?? 0;
		const threshold = getRuleThreshold(ctx, "session-stuck", 120_000);
		if (ageMs < threshold) return null;

		const sessionKey = event.sessionKey ?? "unknown";
		const fingerprint = `session-stuck:${sessionKey}`;
		const ageSec = Math.round(ageMs / 1000);

		return {
			type: "alert",
			id: makeAlertId("session-stuck", fingerprint, ctx.now),
			ruleId: "session-stuck",
			severity: "warn",
			title: "Session stuck",
			detail: `Session ${sessionKey} stuck in processing for ${ageSec}s.`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: heartbeat-fail ────────────────────────────────────────────────────

const heartbeatFail: AlertRuleDefinition = {
	id: "heartbeat-fail",
	defaultCooldownMs: 30 * 60 * 1000,
	defaultThreshold: 3, // consecutive failures

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		if (event.type !== "infra.heartbeat") return null;
		if (!isRuleEnabled(ctx, "heartbeat-fail")) return null;

		const counterKey = "heartbeat-consecutive-fail";

		if (event.outcome === "error") {
			const count = (ctx.state.consecutives.get(counterKey) ?? 0) + 1;
			ctx.state.consecutives.set(counterKey, count);

			const threshold = getRuleThreshold(ctx, "heartbeat-fail", 3);
			if (count < threshold) return null;

			const channel = event.channel ?? "";
			const fingerprint = `heartbeat-fail:${channel}`;
			return {
				type: "alert",
				id: makeAlertId("heartbeat-fail", fingerprint, ctx.now),
				ruleId: "heartbeat-fail",
				severity: "error",
				title: "Heartbeat delivery failing",
				detail: `${count} consecutive heartbeat failures.${channel ? ` Channel: ${channel}.` : ""}`,
				ts: ctx.now,
				fingerprint,
			};
		}

		// Reset on any non-error (success, undefined, etc.)
		ctx.state.consecutives.set(counterKey, 0);
		return null;
	},
};

// ─── Rule: queue-depth ───────────────────────────────────────────────────────

const queueDepth: AlertRuleDefinition = {
	id: "queue-depth",
	defaultCooldownMs: 15 * 60 * 1000,
	defaultThreshold: 10,

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		// Fire on heartbeat (which carries queue depth) and dedicated queue_depth events
		if (event.type !== "infra.heartbeat" && event.type !== "infra.queue_depth")
			return null;

		// Always update heartbeat timestamp regardless of rule state (gateway-down depends on it)
		if (event.type === "infra.heartbeat") {
			ctx.state.lastHeartbeatTs = ctx.now;
		}

		if (!isRuleEnabled(ctx, "queue-depth")) return null;

		const queued = event.queueDepth ?? 0;
		const threshold = getRuleThreshold(ctx, "queue-depth", 10);
		if (queued < threshold) return null;

		const fingerprint = "queue-depth";
		return {
			type: "alert",
			id: makeAlertId("queue-depth", fingerprint, ctx.now),
			ruleId: "queue-depth",
			severity: "warn",
			title: "Queue depth high",
			detail: `${queued} items queued for processing.`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: high-error-rate ───────────────────────────────────────────────────

const highErrorRate: AlertRuleDefinition = {
	id: "high-error-rate",
	defaultCooldownMs: 30 * 60 * 1000,
	defaultThreshold: 50, // percent

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		if (event.type !== "llm.call" && event.type !== "llm.error" && event.type !== "agent.error") return null;
		if (!isRuleEnabled(ctx, "high-error-rate")) return null;

		// agent.error and llm.error are always errors; llm.call checks outcome (timeout counts as error)
		const isError =
			event.type === "agent.error" ||
			event.type === "llm.error" ||
			event.outcome === "error" ||
			event.outcome === "timeout";
		pushWindow(ctx, "msg-outcomes", { ts: ctx.now, value: isError ? 1 : 0 });

		const window = ctx.state.windows.get("msg-outcomes");
		if (!window || window.length < 20) return null; // Need 20 messages minimum

		// Check last 20 messages
		const recent = window.slice(-20);
		const errors = recent.filter((e) => e.value === 1).length;
		const rate = (errors / recent.length) * 100;

		const threshold = getRuleThreshold(ctx, "high-error-rate", 50);
		if (rate < threshold) return null;

		const fingerprint = "high-error-rate";
		return {
			type: "alert",
			id: makeAlertId("high-error-rate", fingerprint, ctx.now),
			ruleId: "high-error-rate",
			severity: "error",
			title: "High error rate",
			detail: `${Math.round(rate)}% of the last ${recent.length} messages failed.`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: cost-hourly-spike ────────────────────────────────────────────────

const costHourlySpike: AlertRuleDefinition = {
	id: "cost-hourly-spike",
	defaultCooldownMs: 30 * 60 * 1000,
	defaultThreshold: 5.0, // USD

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		if (event.type !== "llm.token_usage") return null;
		if (!isRuleEnabled(ctx, "cost-hourly-spike")) return null;
		if (typeof event.costUsd !== "number" || !Number.isFinite(event.costUsd))
			return null;

		// Aggregate per-minute to keep 60m sums accurate under high event throughput.
		pushSummedBucket(
			ctx,
			"cost-hourly-spike-usd",
			event.costUsd,
			60_000, 
			120, // 2hrs
		);

		const hourlyUsd = sumInWindow(ctx, "cost-hourly-spike-usd", 60 * 60 * 1000);
		const threshold = getRuleThreshold(ctx, "cost-hourly-spike", 5.0);
		if (hourlyUsd <= threshold) return null; // must exceed threshold

		const fingerprint = "cost-hourly-spike";
		return {
			type: "alert",
			id: makeAlertId("cost-hourly-spike", fingerprint, ctx.now),
			ruleId: "cost-hourly-spike",
			severity: "warn",
			title: "Hourly LLM spend spike",
			detail: `LLM spend reached $${hourlyUsd.toFixed(2)} in the last 60 minutes (threshold: $${threshold.toFixed(2)}).`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: cost-daily-budget ────────────────────────────────────────────────

const costDailyBudget: AlertRuleDefinition = {
	id: "cost-daily-budget",
	defaultCooldownMs: 6 * 60 * 60 * 1000,
	defaultThreshold: 20.0, // USD

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		if (event.type !== "llm.token_usage") return null;
		if (!isRuleEnabled(ctx, "cost-daily-budget")) return null;
		if (typeof event.costUsd !== "number" || !Number.isFinite(event.costUsd))
			return null;

		// Aggregate per-minute and retain >24h buckets for boundary-safe sums.
		pushSummedBucket(
			ctx,
			"cost-daily-budget-usd",
			event.costUsd,
			60_000,
			1_500, //25hrs
		);

		const dailyUsd = sumInWindow(
			ctx,
			"cost-daily-budget-usd",
			24 * 60 * 60 * 1000,
		);
		const threshold = getRuleThreshold(ctx, "cost-daily-budget", 20.0);
		if (dailyUsd <= threshold) return null; // must exceed threshold

		const fingerprint = "cost-daily-budget";
		return {
			type: "alert",
			id: makeAlertId("cost-daily-budget", fingerprint, ctx.now),
			ruleId: "cost-daily-budget",
			severity: "error",
			title: "Daily LLM budget exceeded",
			detail: `LLM spend reached $${dailyUsd.toFixed(2)} in the last 24 hours (threshold: $${threshold.toFixed(2)}).`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: tool-errors ───────────────────────────────────────────────────

const toolErrors: AlertRuleDefinition = {
	id: "tool-errors",
	defaultCooldownMs: 15 * 60 * 1000,
	defaultThreshold: 1, // 1 tool error in 1 minute

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		if (event.type !== "tool.error") return null;
		if (!isRuleEnabled(ctx, "tool-errors")) return null;

		pushWindow(ctx, "tool-errors", { ts: ctx.now });

		const threshold = getRuleThreshold(ctx, "tool-errors", 1);
		const windowMs = 60 * 1000; // 1 minute
		const count = countInWindow(ctx, "tool-errors", windowMs);

		if (count < threshold) return null;

		const toolName = (event.meta?.toolName as string) ?? "unknown";
		const fingerprint = `tool-errors:${toolName}`;
		return {
			type: "alert",
			id: makeAlertId("tool-errors", fingerprint, ctx.now),
			ruleId: "tool-errors",
			severity: "warn",
			title: "Tool errors spike",
			detail: `${count} tool error(s) in the last minute.${event.error ? ` Last: ${event.error}` : ""}`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Rule: gateway-down ──────────────────────────────────────────────────────

const gatewayDown: AlertRuleDefinition = {
	id: "gateway-down",
	defaultCooldownMs: 60 * 60 * 1000,
	defaultThreshold: 30_000, // 30 seconds

	evaluate(event: OpenAlertsEvent, ctx): AlertEvent | null {
		// This rule is called by the watchdog timer, not by events directly.
		if (event.type !== "watchdog.tick") return null;
		if (!isRuleEnabled(ctx, "gateway-down")) return null;
		if (ctx.state.lastHeartbeatTs === 0) return null; // No heartbeat received yet

		const silenceMs = ctx.now - ctx.state.lastHeartbeatTs;
		const threshold = getRuleThreshold(
			ctx,
			"gateway-down",
			DEFAULTS.gatewayDownThresholdMs,
		);
		if (silenceMs < threshold) return null;

		const fingerprint = "gateway-down";
		const silenceSec = Math.round(silenceMs / 1000);
		const lastTime = new Date(ctx.state.lastHeartbeatTs).toLocaleTimeString(
			[],
			{
				hour: "2-digit",
				minute: "2-digit",
			},
		);

		return {
			type: "alert",
			id: makeAlertId("gateway-down", fingerprint, ctx.now),
			ruleId: "gateway-down",
			severity: "critical",
			title: "Gateway unresponsive",
			detail: `No heartbeat received for ${silenceSec}s. Last successful: ${lastTime}.`,
			ts: ctx.now,
			fingerprint,
		};
	},
};

// ─── Export all rules ────────────────────────────────────────────────────────

export const ALL_RULES: AlertRuleDefinition[] = [
	infraErrors,
	llmErrors,
	sessionStuck,
	heartbeatFail,
	queueDepth,
	highErrorRate,
	costHourlySpike,
	costDailyBudget,
	toolErrors,
	gatewayDown,
];
