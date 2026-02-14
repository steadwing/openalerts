import type {
	OpenAlertsEngine,
	OpenAlertsEvent,
} from "../core/index.js";
import { BoundedMap } from "../core/index.js";
import type { LogTransportRecord } from "openclaw/plugin-sdk";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedLogRecord {
	subsystem: string;
	message: string;
	ts: number;
	kvs: Record<string, string>;
}

interface ToolFlight {
	tool: string;
	runId: string;
	sessionId?: string;
	startTs: number;
}

// ─── Parsing Helpers ─────────────────────────────────────────────────────────

const KV_RE = /(\w+)=([\S]+)/g;

/** Parse key=value pairs from a log message string. */
function parseKvs(message: string): Record<string, string> {
	const result: Record<string, string> = {};
	let m: RegExpExecArray | null;
	KV_RE.lastIndex = 0;
	while ((m = KV_RE.exec(message)) !== null) {
		result[m[1]] = m[2];
	}
	return result;
}

/** Extract subsystem string from field "0" which may be JSON or raw. */
function extractSubsystem(field0: unknown): string {
	if (typeof field0 !== "string") return "";
	if (field0.startsWith("{")) {
		try {
			const parsed = JSON.parse(field0);
			return typeof parsed.subsystem === "string" ? parsed.subsystem : "";
		} catch {
			return "";
		}
	}
	return field0;
}

/** Extract timestamp from a log record. */
function extractTimestamp(logObj: LogTransportRecord): number {
	const meta = logObj._meta as Record<string, unknown> | undefined;
	if (meta?.date && typeof meta.date === "string") {
		const t = new Date(meta.date).getTime();
		if (!isNaN(t)) return t;
	}
	if (typeof logObj.time === "string") {
		const t = new Date(logObj.time).getTime();
		if (!isNaN(t)) return t;
	}
	if (typeof logObj.time === "number") {
		return logObj.time;
	}
	return Date.now();
}

/** Subsystems the bridge cares about. Everything else is fast-skipped. */
const WATCHED_SUBSYSTEMS = new Set(["agent/embedded", "diagnostic", "exec"]);

/**
 * Parse a raw LogTransportRecord into a structured form.
 * Returns null if the record can't be parsed or is from an irrelevant subsystem.
 */
function parseLogRecord(logObj: LogTransportRecord): ParsedLogRecord | null {
	const subsystem = extractSubsystem(logObj["0"]);
	if (!WATCHED_SUBSYSTEMS.has(subsystem)) return null;

	const message = typeof logObj["1"] === "string" ? logObj["1"] : "";
	if (!message) return null;

	return {
		subsystem,
		message,
		ts: extractTimestamp(logObj),
		kvs: parseKvs(message),
	};
}

// ─── Dedup set with periodic pruning ─────────────────────────────────────────

const DEDUP_MAX_SIZE = 2000;
const DEDUP_PRUNE_TARGET = 500;

/** Prune oldest entries from a dedup set when it grows too large. */
function pruneDedupeSet(set: Set<string>): void {
	if (set.size <= DEDUP_MAX_SIZE) return;
	// Set iterates in insertion order; delete oldest entries
	const toDelete = set.size - DEDUP_PRUNE_TARGET;
	let deleted = 0;
	for (const key of set) {
		if (deleted >= toDelete) break;
		set.delete(key);
		deleted++;
	}
}

// ─── Bridge ──────────────────────────────────────────────────────────────────

/**
 * Create a log-transport bridge that parses structured log records and
 * synthesizes OpenAlertsEvents to fill gaps left by non-firing plugin hooks.
 *
 * Covers:
 * - Tool calls (tool start → tool end, with duration) — fills `after_tool_call` gap
 * - Session lifecycle (idle ↔ processing transitions) — fills `session_start/end` gap
 * - Run prompt duration — enriches session.end with durationMs
 * - Agent run lifecycle — agent start/end at run level
 * - Compaction events — detects costly context compaction
 * - Message delivery — "Committed messaging text" fills `message_sent` gap
 * - Exec commands — attaches elevated commands to tool events
 *
 * Returns the transport function to pass to registerLogTransport().
 * Call the returned cleanup function to release internal state.
 */
export function createLogBridge(engine: OpenAlertsEngine): {
	transport: (logObj: LogTransportRecord) => void;
	cleanup: () => void;
} {
	// ── State ──────────────────────────────────────────────────────────────────
	// Use bounded maps to prevent memory leaks (max 1000 entries each)
	const toolFlights = new BoundedMap<string, ToolFlight>({ maxSize: 1000 });
	const sessionStates = new BoundedMap<string, string>({ maxSize: 500 });
	const dedupeSet = new Set<string>();
	let pendingCommand: string | null = null;
	let lastRunDurationMs: number | null = null;
	let pruneCounter = 0;

	function ingest(event: OpenAlertsEvent): void {
		engine.ingest(event);
	}

	// ── Tool call handling (agent/embedded) ────────────────────────────────────
	// Fills the `after_tool_call` hook gap (hook is declared but never fires)

	function handleToolStart(rec: ParsedLogRecord): void {
		const { toolCallId, tool, runId } = rec.kvs;
		if (!toolCallId || !tool) return;

		toolFlights.set(toolCallId, {
			tool,
			runId: runId ?? "",
			startTs: rec.ts,
		});
	}

	function handleToolEnd(rec: ParsedLogRecord): void {
		const { toolCallId, tool, runId } = rec.kvs;
		if (!toolCallId) return;

		const dedupeKey = `tool:${toolCallId}`;
		if (dedupeSet.has(dedupeKey)) return;
		dedupeSet.add(dedupeKey);

		const flight = toolFlights.get(toolCallId);
		toolFlights.delete(toolCallId);

		const durationMs = flight ? rec.ts - flight.startTs : undefined;
		const toolName = flight?.tool ?? tool ?? "unknown";

		const event: OpenAlertsEvent = {
			type: "tool.call",
			ts: rec.ts,
			durationMs,
			outcome: "success",
			meta: {
				toolName,
				toolCallId,
				runId: flight?.runId ?? runId,
				source: "log-bridge",
			},
		};

		if (pendingCommand) {
			event.meta!.command = pendingCommand;
			pendingCommand = null;
		}

		ingest(event);
	}

	// ── Session lifecycle handling (diagnostic) ────────────────────────────────
	// Fills the `session_start/end` hook gap (hooks declared but never fire)

	function handleSessionState(rec: ParsedLogRecord): void {
		const { sessionId, sessionKey, prev, new: newState, reason } = rec.kvs;
		const sid = sessionId ?? sessionKey;
		if (!sid || !newState) return;

		const prevState = prev ?? sessionStates.get(sid);
		sessionStates.set(sid, newState);

		// session.start: idle → processing
		if (newState === "processing" && prevState === "idle") {
			const startKey = `session:start:${sid}`;
			if (!dedupeSet.has(startKey)) {
				dedupeSet.add(startKey);
				ingest({
					type: "session.start",
					ts: rec.ts,
					sessionKey: sid,
					outcome: "success",
					meta: { source: "log-bridge" },
				});
			}
		}

		// session.end: processing → idle with reason=run_completed
		if (
			newState === "idle" &&
			prevState === "processing" &&
			reason === "run_completed"
		) {
			const endKey = `session:end:${sid}`;
			if (!dedupeSet.has(endKey)) {
				dedupeSet.add(endKey);
				const event: OpenAlertsEvent = {
					type: "session.end",
					ts: rec.ts,
					sessionKey: sid,
					outcome: "success",
					meta: { source: "log-bridge" },
				};
				if (lastRunDurationMs !== null) {
					event.durationMs = lastRunDurationMs;
					lastRunDurationMs = null;
				}
				ingest(event);
			}
		}
	}

	// ── Run prompt duration (agent/embedded) ──────────────────────────────────

	function handleRunPromptEnd(rec: ParsedLogRecord): void {
		const { durationMs } = rec.kvs;
		if (durationMs) {
			lastRunDurationMs = parseInt(durationMs, 10) || null;
		}
	}

	// ── Agent run lifecycle (agent/embedded) ──────────────────────────────────
	// Complements before_agent_start / agent_end hooks with run-level tracking

	function handleAgentRunStart(rec: ParsedLogRecord): void {
		const { runId } = rec.kvs;
		ingest({
			type: "custom",
			ts: rec.ts,
			outcome: "success",
			meta: { runId, openclawLog: "agent_run_start", source: "log-bridge" },
		});
	}

	function handleAgentRunEnd(rec: ParsedLogRecord): void {
		const { runId } = rec.kvs;
		ingest({
			type: "custom",
			ts: rec.ts,
			outcome: "success",
			meta: { runId, openclawLog: "agent_run_end", source: "log-bridge" },
		});
	}

	// ── Compaction (agent/embedded) ───────────────────────────────────────────
	// OpenClaw compacts when context is full — costly, can lose context.
	// No hook exists for this. Only available via logs.

	function handleCompactionStart(rec: ParsedLogRecord): void {
		const { runId } = rec.kvs;
		ingest({
			type: "custom",
			ts: rec.ts,
			outcome: "success",
			meta: {
				runId,
				compaction: true,
				openclawLog: "compaction_start",
				source: "log-bridge",
			},
		});
	}

	function handleCompactionRetry(rec: ParsedLogRecord): void {
		const { runId } = rec.kvs;
		ingest({
			type: "custom",
			ts: rec.ts,
			outcome: "success",
			meta: {
				runId,
				compaction: true,
				openclawLog: "compaction_retry",
				source: "log-bridge",
			},
		});
	}

	// ── Message delivery (agent/embedded) ─────────────────────────────────────
	// "Committed messaging text" fires when a messaging tool (Telegram, Discord,
	// etc.) successfully delivers a message. Fills the `message_sent` hook gap.

	function handleMessageCommitted(rec: ParsedLogRecord): void {
		const { tool, len } = rec.kvs;
		ingest({
			type: "custom",
			ts: rec.ts,
			outcome: "success",
			meta: {
				toolName: tool,
				textLength: len ? parseInt(len, 10) : undefined,
				openclawLog: "message_committed",
				source: "log-bridge",
			},
		});
	}

	// ── Exec command (exec) ────────────────────────────────────────────────────

	function handleExecCommand(rec: ParsedLogRecord): void {
		pendingCommand = rec.message;
	}

	// ── Main transport function ────────────────────────────────────────────────

	function transport(logObj: LogTransportRecord): void {
		const rec = parseLogRecord(logObj);
		if (!rec) return;

		const msg = rec.message;

		if (rec.subsystem === "agent/embedded") {
			if (msg.startsWith("embedded run tool start:")) {
				handleToolStart(rec);
			} else if (msg.startsWith("embedded run tool end:")) {
				handleToolEnd(rec);
			} else if (msg.startsWith("embedded run prompt end:")) {
				handleRunPromptEnd(rec);
			} else if (msg.startsWith("embedded run agent start:")) {
				handleAgentRunStart(rec);
			} else if (msg.startsWith("embedded run agent end:")) {
				handleAgentRunEnd(rec);
			} else if (msg.startsWith("embedded run compaction start:")) {
				handleCompactionStart(rec);
			} else if (msg.startsWith("embedded run compaction retry:")) {
				handleCompactionRetry(rec);
			} else if (msg.startsWith("Committed messaging text:")) {
				handleMessageCommitted(rec);
			}
		} else if (rec.subsystem === "diagnostic") {
			if (msg.startsWith("session state:")) {
				handleSessionState(rec);
			}
		} else if (rec.subsystem === "exec") {
			if (msg.startsWith("elevated command")) {
				handleExecCommand(rec);
			}
		}

		// Periodic dedup set pruning (check every 100 log records)
		if (++pruneCounter >= 100) {
			pruneCounter = 0;
			pruneDedupeSet(dedupeSet);
		}
	}

	function cleanup(): void {
		toolFlights.clear();
		sessionStates.clear();
		dedupeSet.clear();
		pendingCommand = null;
		lastRunDurationMs = null;
		pruneCounter = 0;
	}

	return { transport, cleanup };
}
