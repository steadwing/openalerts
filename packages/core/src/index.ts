// @steadwing/openalerts-core — OpenAlerts engine

// Types
export type {
	AlertChannel,
	AlertEvent,
	AlertRuleDefinition,
	AlertSeverity,
	AlertTarget,
	DiagnosticSnapshot,
	EvaluatorState,
	HeartbeatSnapshot,
	MonitorConfig,
	RuleContext,
	RuleOverride,
	OpenAlertsEvent,
	OpenAlertsEventType,
	OpenAlertsInitOptions,
	OpenAlertsLogger,
	StoredEvent,
	WindowEntry,
} from "./types.js";

// Constants
export { DEFAULTS, LOG_FILENAME, STORE_DIR_NAME } from "./types.js";

// Engine
export { OpenAlertsEngine } from "./engine.js";

// Event Bus
export { OpenAlertsEventBus } from "./event-bus.js";

// Alert Dispatcher
export { AlertDispatcher } from "./alert-channel.js";

// Evaluator
export {
	createEvaluatorState,
	processEvent,
	processWatchdogTick,
	warmFromHistory,
} from "./evaluator.js";

// Rules
export { ALL_RULES } from "./rules.js";

// Store
export {
	appendEvent,
	pruneLog,
	readAllEvents,
	readRecentEvents,
} from "./store.js";

// Formatter
export {
	formatAlertMessage,
	formatAlertsOutput,
	formatHealthOutput,
} from "./formatter.js";

// Platform
export { createPlatformSync, type PlatformSync } from "./platform.js";

// Circuit Breaker
export {
	CircuitBreaker,
	type CircuitState,
	type CircuitBreakerConfig,
	type CircuitBreakerStats,
} from "./circuit-breaker.js";
export {
	CircuitBreakerManager,
	type CircuitBreakerCategory,
	type CircuitBreakerKey,
} from "./circuit-breaker-manager.js";

// Task Timeout
export {
	TaskTimeoutMonitor,
	type TaskType,
	type TaskTimeoutConfig,
	type RunningTask,
	type TaskTimeoutEvent,
} from "./task-timeout.js";

// Correlation Tracking
export { CorrelationTracker, type CorrelationContext } from "./correlation.js";

// Bounded Map
export {
	BoundedMap,
	type BoundedMapOptions,
	type BoundedMapStats,
} from "./bounded-map.js";
