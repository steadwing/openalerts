// ─── Alert Severity ──────────────────────────────────────────────────────────

export type AlertSeverity = "info" | "warn" | "error" | "critical";

// ─── Universal Event Types ──────────────────────────────────────────────────

export type SteadwingEventType =
  | "llm.call" | "llm.error" | "llm.token_usage"
  | "tool.call" | "tool.error"
  | "agent.start" | "agent.end" | "agent.error" | "agent.stuck"
  | "session.start" | "session.end" | "session.stuck"
  | "infra.error" | "infra.heartbeat" | "infra.queue_depth"
  | "custom" | "watchdog.tick";

export type SteadwingEvent = {
  type: SteadwingEventType;
  ts: number;
  severity?: AlertSeverity;
  channel?: string;
  sessionKey?: string;
  agentId?: string;
  durationMs?: number;
  tokenCount?: number;
  queueDepth?: number;
  ageMs?: number;
  costUsd?: number;
  outcome?: "success" | "error" | "skipped" | "timeout";
  error?: string;
  meta?: Record<string, unknown>;
};

// ─── Alert Channel Interface ────────────────────────────────────────────────

export interface AlertChannel {
  readonly name: string;
  send(alert: AlertEvent, formatted: string): Promise<void> | void;
}

// ─── Stored Events (persisted to JSONL) ──────────────────────────────────────

export type AlertEvent = {
  type: "alert";
  id: string; // `${ruleId}:${fingerprint}:${ts}`
  ruleId: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  ts: number;
  fingerprint: string; // dedup key: `${ruleId}:${contextKey}`
};

export type DiagnosticSnapshot = {
  type: "diagnostic";
  eventType: string;
  ts: number;
  summary: string;
  channel?: string;
  sessionKey?: string;
};

export type HeartbeatSnapshot = {
  type: "heartbeat";
  status: string;
  ts: number;
  reason?: string;
  channel?: string;
};

export type StoredEvent = AlertEvent | DiagnosticSnapshot | HeartbeatSnapshot;

// ─── Alert Target (where to send notifications) ─────────────────────────────

export type AlertTarget = {
  channel: string; // "telegram", "discord", "slack", etc.
  to: string; // chat/user ID
  accountId?: string;
};

// ─── Config ─────────────────────────────────────────────────────────────────

export type RuleOverride = {
  enabled?: boolean;
  threshold?: number;
  cooldownMinutes?: number;
};

export type MonitorConfig = {
  apiKey?: string;
  alertChannel?: string;
  alertTo?: string;
  alertAccountId?: string;
  cooldownMinutes?: number; // default 15
  maxLogSizeKb?: number; // default 512
  maxLogAgeDays?: number; // default 7
  quiet?: boolean; // log-only, no messages
  rules?: Record<string, RuleOverride>;
};

// ─── Init Options (for SteadwingEngine) ─────────────────────────────────────

export type SteadwingInitOptions = {
  /** Where to store JSONL event logs */
  stateDir: string;
  /** Monitor config (rules, cooldowns, etc.) */
  config: MonitorConfig;
  /** Alert channels to send to */
  channels?: AlertChannel[];
  /** Logger (defaults to console) */
  logger?: SteadwingLogger;
  /** Log prefix for messages */
  logPrefix?: string;
  /** Diagnosis hint shown in critical alerts (e.g., 'Run "openclaw doctor"') */
  diagnosisHint?: string;
};

export type SteadwingLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// ─── Evaluator State (in-memory) ─────────────────────────────────────────────

export type WindowEntry = {
  ts: number;
  value?: number; // optional numeric payload (e.g., queue depth)
};

export type EvaluatorState = {
  /** Sliding window counters keyed by window name */
  windows: Map<string, WindowEntry[]>;
  /** Cooldown: fingerprint → last alerted timestamp */
  cooldowns: Map<string, number>;
  /** Consecutive failure counters keyed by counter name */
  consecutives: Map<string, number>;
  /** Hourly alert count for hard cap */
  hourlyAlerts: { count: number; resetAt: number };
  /** Last diagnostic heartbeat timestamp (for gateway-down detection) */
  lastHeartbeatTs: number;
  /** Startup timestamp */
  startedAt: number;
  /** Aggregate 24h counters for /health display */
  stats: {
    messagesProcessed: number;
    messageErrors: number;
    webhookErrors: number;
    stuckSessions: number;
    toolCalls: number;
    toolErrors: number;
    agentStarts: number;
    agentErrors: number;
    sessionsStarted: number;
    lastResetTs: number;
  };
};

// ─── Rule Definition ─────────────────────────────────────────────────────────

export type RuleContext = {
  state: EvaluatorState;
  config: MonitorConfig;
  now: number;
};

export type AlertRuleDefinition = {
  id: string;
  defaultCooldownMs: number;
  defaultThreshold: number;
  evaluate: (
    event: SteadwingEvent,
    ctx: RuleContext,
  ) => AlertEvent | null;
};

// ─── Constants ───────────────────────────────────────────────────────────────

export const STORE_DIR_NAME = "steadwing";
export const LOG_FILENAME = "events.jsonl";

export const DEFAULTS = {
  cooldownMs: 15 * 60 * 1000, // 15 minutes
  maxLogSizeKb: 512,
  maxLogAgeDays: 7,
  maxWindowEntries: 100,
  maxCooldownEntries: 50,
  maxAlertsPerHour: 5,
  watchdogIntervalMs: 30_000, // 30 seconds
  pruneIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  platformFlushIntervalMs: 5 * 60 * 1000, // 5 minutes
  platformBatchSize: 100,
  gatewayDownThresholdMs: 90_000, // 90 seconds
} as const;
