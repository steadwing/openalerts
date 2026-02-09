import {
  DEFAULTS,
  type AlertEvent,
  type AlertRuleDefinition,
  type RuleContext,
  type SteadwingEvent,
  type WindowEntry,
} from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAlertId(ruleId: string, fingerprint: string, ts: number): string {
  return `${ruleId}:${fingerprint}:${ts}`;
}

function pushWindow(
  ctx: RuleContext,
  name: string,
  entry: WindowEntry,
): void {
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

function getRuleThreshold(ctx: RuleContext, ruleId: string, defaultVal: number): number {
  return ctx.config.rules?.[ruleId]?.threshold ?? defaultVal;
}

function isRuleEnabled(ctx: RuleContext, ruleId: string): boolean {
  return ctx.config.rules?.[ruleId]?.enabled !== false;
}

// ─── Rule: infra-errors (was: webhook-errors) ───────────────────────────────

const infraErrors: AlertRuleDefinition = {
  id: "infra-errors",
  defaultCooldownMs: 15 * 60 * 1000,
  defaultThreshold: 3,

  evaluate(event: SteadwingEvent, ctx): AlertEvent | null {
    if (event.type !== "infra.error") return null;
    if (!isRuleEnabled(ctx, "infra-errors")) return null;

    const channel = event.channel ?? "unknown";
    pushWindow(ctx, "infra-errors", { ts: ctx.now });

    const threshold = getRuleThreshold(ctx, "infra-errors", 3);
    const windowMs = 5 * 60 * 1000; // 5 minutes
    const count = countInWindow(ctx, "infra-errors", windowMs);

    if (count < threshold) return null;

    const fingerprint = `infra-errors:${channel}`;
    return {
      type: "alert",
      id: makeAlertId("infra-errors", fingerprint, ctx.now),
      ruleId: "infra-errors",
      severity: "error",
      title: "Infrastructure errors spike",
      detail: `${count} infra errors on ${channel} in the last 5 minutes.`,
      ts: ctx.now,
      fingerprint,
    };
  },
};

// ─── Rule: llm-errors (was: message-errors) ─────────────────────────────────

const llmErrors: AlertRuleDefinition = {
  id: "llm-errors",
  defaultCooldownMs: 15 * 60 * 1000,
  defaultThreshold: 3,

  evaluate(event: SteadwingEvent, ctx): AlertEvent | null {
    if (event.type !== "llm.call") return null;
    if (!isRuleEnabled(ctx, "llm-errors")) return null;

    // Track all LLM calls for stats
    ctx.state.stats.messagesProcessed++;

    if (event.outcome !== "error") return null;

    ctx.state.stats.messageErrors++;
    const channel = event.channel ?? "unknown";
    pushWindow(ctx, "llm-errors", { ts: ctx.now });

    const threshold = getRuleThreshold(ctx, "llm-errors", 3);
    const windowMs = 5 * 60 * 1000;
    const count = countInWindow(ctx, "llm-errors", windowMs);

    if (count < threshold) return null;

    const fingerprint = `llm-errors:${channel}`;
    return {
      type: "alert",
      id: makeAlertId("llm-errors", fingerprint, ctx.now),
      ruleId: "llm-errors",
      severity: "error",
      title: "LLM call errors",
      detail: `${count} LLM errors on ${channel} in the last 5 minutes.`,
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

  evaluate(event: SteadwingEvent, ctx): AlertEvent | null {
    if (event.type !== "session.stuck") return null;
    if (!isRuleEnabled(ctx, "session-stuck")) return null;

    ctx.state.stats.stuckSessions++;

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

  evaluate(event: SteadwingEvent, ctx): AlertEvent | null {
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

    // Reset on success
    if (event.outcome === "success") {
      ctx.state.consecutives.set(counterKey, 0);
    }

    return null;
  },
};

// ─── Rule: queue-depth ───────────────────────────────────────────────────────

const queueDepth: AlertRuleDefinition = {
  id: "queue-depth",
  defaultCooldownMs: 15 * 60 * 1000,
  defaultThreshold: 10,

  evaluate(event: SteadwingEvent, ctx): AlertEvent | null {
    // Fire on heartbeat (which carries queue depth) and dedicated queue_depth events
    if (event.type !== "infra.heartbeat" && event.type !== "infra.queue_depth") return null;
    if (!isRuleEnabled(ctx, "queue-depth")) return null;

    // Update last heartbeat timestamp (used by gateway-down rule)
    if (event.type === "infra.heartbeat") {
      ctx.state.lastHeartbeatTs = ctx.now;
    }

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

  evaluate(event: SteadwingEvent, ctx): AlertEvent | null {
    if (event.type !== "llm.call") return null;
    if (!isRuleEnabled(ctx, "high-error-rate")) return null;

    const isError = event.outcome === "error";
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

// ─── Rule: gateway-down ──────────────────────────────────────────────────────

const gatewayDown: AlertRuleDefinition = {
  id: "gateway-down",
  defaultCooldownMs: 60 * 60 * 1000,
  defaultThreshold: 90_000, // 90 seconds

  evaluate(event: SteadwingEvent, ctx): AlertEvent | null {
    // This rule is called by the watchdog timer, not by events directly.
    if (event.type !== "watchdog.tick") return null;
    if (!isRuleEnabled(ctx, "gateway-down")) return null;
    if (ctx.state.lastHeartbeatTs === 0) return null; // No heartbeat received yet

    const silenceMs = ctx.now - ctx.state.lastHeartbeatTs;
    const threshold = getRuleThreshold(ctx, "gateway-down", DEFAULTS.gatewayDownThresholdMs);
    if (silenceMs < threshold) return null;

    const fingerprint = "gateway-down";
    const silenceSec = Math.round(silenceMs / 1000);
    const lastTime = new Date(ctx.state.lastHeartbeatTs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

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
  gatewayDown,
];
