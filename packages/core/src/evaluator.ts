import { ALL_RULES } from "./rules.js";
import {
  DEFAULTS,
  type AlertEvent,
  type EvaluatorState,
  type MonitorConfig,
  type OpenAlertsEvent,
  type StoredEvent,
} from "./types.js";

/** Create a fresh evaluator state. */
export function createEvaluatorState(): EvaluatorState {
  const now = Date.now();
  return {
    windows: new Map(),
    cooldowns: new Map(),
    consecutives: new Map(),
    hourlyAlerts: { count: 0, resetAt: now + 60 * 60 * 1000 },
    lastHeartbeatTs: 0,
    startedAt: now,
    stats: {
      messagesProcessed: 0,
      messageErrors: 0,
      webhookErrors: 0,
      stuckSessions: 0,
      toolCalls: 0,
      toolErrors: 0,
      agentStarts: 0,
      agentErrors: 0,
      sessionsStarted: 0,
      lastResetTs: now,
    },
  };
}

/**
 * Warm the evaluator state from persisted events.
 * Replays recent events to rebuild windows/counters without re-firing alerts.
 */
export function warmFromHistory(
  state: EvaluatorState,
  events: StoredEvent[],
): void {
  for (const event of events) {
    if (event.type === "alert") {
      // Restore cooldowns from recent alerts
      state.cooldowns.set(event.fingerprint, event.ts);
    }
    // Don't replay diagnostic/heartbeat events through rules —
    // that would re-fire alerts. Just restore cooldown state.
  }
}

/**
 * Process a single event through all rules.
 * Returns alerts that should be fired (already filtered by cooldown + hourly cap).
 */
export function processEvent(
  state: EvaluatorState,
  config: MonitorConfig,
  event: OpenAlertsEvent,
): AlertEvent[] {
  const now = Date.now();

  // Reset 24h stats daily
  if (now - state.stats.lastResetTs > 24 * 60 * 60 * 1000) {
    state.stats.messagesProcessed = 0;
    state.stats.messageErrors = 0;
    state.stats.webhookErrors = 0;
    state.stats.stuckSessions = 0;
    state.stats.toolCalls = 0;
    state.stats.toolErrors = 0;
    state.stats.agentStarts = 0;
    state.stats.agentErrors = 0;
    state.stats.sessionsStarted = 0;
    state.stats.lastResetTs = now;
  }

  // Track event types in stats
  if (event.type === "infra.error") {
    state.stats.webhookErrors++;
  }
  if (event.type === "tool.call" || event.type === "tool.error") {
    state.stats.toolCalls++;
    if (event.type === "tool.error") state.stats.toolErrors++;
  }
  if (event.type === "agent.start") {
    state.stats.agentStarts++;
  }
  if (event.type === "agent.error") {
    state.stats.agentErrors++;
  }
  if (event.type === "session.start") {
    state.stats.sessionsStarted++;
  }

  // Reset hourly cap if expired
  if (now >= state.hourlyAlerts.resetAt) {
    state.hourlyAlerts.count = 0;
    state.hourlyAlerts.resetAt = now + 60 * 60 * 1000;
  }

  const ctx = { state, config, now };
  const fired: AlertEvent[] = [];

  for (const rule of ALL_RULES) {
    const alert = rule.evaluate(event, ctx);
    if (!alert) continue;

    // Check cooldown
    const cooldownMs = resolveCooldownMs(config, rule);
    const lastFired = state.cooldowns.get(alert.fingerprint);
    if (lastFired && now - lastFired < cooldownMs) continue;

    // Check hourly cap
    if (state.hourlyAlerts.count >= DEFAULTS.maxAlertsPerHour) continue;

    // Fire the alert
    state.cooldowns.set(alert.fingerprint, now);
    state.hourlyAlerts.count++;
    fired.push(alert);
  }

  // Prune cooldown map if too large
  if (state.cooldowns.size > DEFAULTS.maxCooldownEntries) {
    const entries = [...state.cooldowns.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, entries.length - DEFAULTS.maxCooldownEntries);
    for (const [key] of toRemove) {
      state.cooldowns.delete(key);
    }
  }

  return fired;
}

/**
 * Run the watchdog tick — checks for gateway-down condition.
 * Called every 30 seconds by the engine timer.
 */
export function processWatchdogTick(
  state: EvaluatorState,
  config: MonitorConfig,
): AlertEvent[] {
  return processEvent(state, config, { type: "watchdog.tick", ts: Date.now() });
}

/** Resolve the effective cooldown for a rule. */
function resolveCooldownMs(config: MonitorConfig, rule: { id: string; defaultCooldownMs: number }): number {
  const override = config.rules?.[rule.id]?.cooldownMinutes;
  if (typeof override === "number" && override > 0) {
    return override * 60 * 1000;
  }
  const globalOverride = config.cooldownMinutes;
  if (typeof globalOverride === "number" && globalOverride > 0) {
    return globalOverride * 60 * 1000;
  }
  return rule.defaultCooldownMs;
}
