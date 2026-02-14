import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	OpenAlertsEngine,
	OpenAlertsEvent,
	AlertEvent,
} from "../core/index.js";
import { getDashboardHtml } from "./dashboard-html.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type HttpHandler = (
	req: IncomingMessage,
	res: ServerResponse,
) => Promise<boolean> | boolean;
type SSEConnection = {
	res: ServerResponse;
	unsub: () => void;
	heartbeat: ReturnType<typeof setInterval>;
	logTailer: ReturnType<typeof setInterval>;
};

// ─── SSE connection tracking ─────────────────────────────────────────────────

const sseConnections = new Set<SSEConnection>();

/** Close all active SSE connections. Call on engine stop. */
export function closeDashboardConnections(): void {
	for (const conn of sseConnections) {
		clearInterval(conn.heartbeat);
		clearInterval(conn.logTailer);
		conn.unsub();
		try {
			conn.res.end();
		} catch {
			/* already closed */
		}
	}
	sseConnections.clear();
}

// ─── Rule status helper ──────────────────────────────────────────────────────

const RULE_IDS = [
	"infra-errors",
	"llm-errors",
	"session-stuck",
	"heartbeat-fail",
	"queue-depth",
	"high-error-rate",
	"tool-errors",
	"gateway-down",
];

function getRuleStatuses(
	engine: OpenAlertsEngine,
): Array<{ id: string; status: "ok" | "fired" }> {
	const state = engine.state;
	const now = Date.now();
	const cooldownWindow = 15 * 60 * 1000;

	return RULE_IDS.map((id) => {
		// Cooldown keys are fingerprints like "llm-errors:unknown", not bare rule IDs.
		// Check if ANY cooldown key starting with this rule ID has fired recently.
		let fired = false;
		for (const [key, ts] of state.cooldowns) {
			if (key === id || key.startsWith(id + ":")) {
				if (ts > now - cooldownWindow) {
					fired = true;
					break;
				}
			}
		}
		return { id, status: fired ? ("fired" as const) : ("ok" as const) };
	});
}

// ─── OpenClaw log file ──────────────────────────────────────────────────────

function getOpenClawLogDir(): string {
	// Use platform-appropriate default: C:\tmp\openclaw on Windows, /tmp/openclaw elsewhere
	if (process.platform === "win32") {
		return join("C:", "tmp", "openclaw");
	}
	return join("/tmp", "openclaw");
}

function getOpenClawLogPath(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return join(getOpenClawLogDir(), `openclaw-${y}-${m}-${day}.log`);
}

interface ParsedLogEntry {
	ts: string;
	tsMs: number;
	level: string;
	subsystem: string;
	message: string;
	sessionId?: string;
	runId?: string;
	durationMs?: number;
	filePath?: string;
	method?: string;
	hostname?: string;
	extra: Record<string, string>;
}

/** Parse key=value pairs from a log message string. */
function parseLogKVs(msg: string): Record<string, string> {
	const kvs: Record<string, string> = {};
	// Match key=value or key="quoted value"
	const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(msg)) !== null) {
		kvs[m[1]] = m[2] ?? m[3];
	}
	return kvs;
}

function parseLogLine(line: string): ParsedLogEntry | null {
	try {
		const obj = JSON.parse(line);
		const ts = obj.time || obj._meta?.date || "";
		const tsMs = ts ? new Date(ts).getTime() : 0;

		let subsystem = "";
		try {
			const nameObj = JSON.parse(obj["0"] || "{}");
			subsystem = nameObj.subsystem || "";
		} catch {
			subsystem = obj["0"] || "";
		}

		const message: string = obj["1"] || "";
		const extra = parseLogKVs(message);

		return {
			ts,
			tsMs,
			level: obj._meta?.logLevelName || "DEBUG",
			subsystem,
			message,
			sessionId: extra.sessionId,
			runId: extra.runId,
			durationMs: extra.durationMs ? parseInt(extra.durationMs, 10) : undefined,
			filePath: obj._meta?.path?.fileNameWithLine,
			method: obj._meta?.path?.method,
			hostname: obj._meta?.hostname,
			extra,
		};
	} catch {
		return null;
	}
}

function readOpenClawLogs(
	maxEntries: number,
	afterTs?: string,
): { entries: ParsedLogEntry[]; truncated: boolean; subsystems: string[] } {
	const logPath = getOpenClawLogPath();
	if (!existsSync(logPath))
		return { entries: [], truncated: false, subsystems: [] };

	try {
		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const entries: ParsedLogEntry[] = [];
		const subsystemSet = new Set<string>();

		for (const line of lines) {
			const parsed = parseLogLine(line);
			if (!parsed) continue;
			if (afterTs && parsed.ts <= afterTs) continue;
			entries.push(parsed);
			subsystemSet.add(parsed.subsystem);
		}

		const truncated = entries.length > maxEntries;
		const sliced = entries.slice(-maxEntries);
		const subsystems = Array.from(subsystemSet).sort();

		return { entries: sliced, truncated, subsystems };
	} catch {
		return { entries: [], truncated: false, subsystems: [] };
	}
}

/**
 * Create a log tailer for an SSE connection.
 * Polls the log file every 2 seconds, sends new lines as `event: oclog`.
 */
function createLogTailer(res: ServerResponse): ReturnType<typeof setInterval> {
	let lastLineCount = 0;
	let lastPath = "";

	// Initialize: count existing lines so we only send new ones
	try {
		const path = getOpenClawLogPath();
		if (existsSync(path)) {
			const content = readFileSync(path, "utf-8");
			lastLineCount = content.trim().split("\n").length;
			lastPath = path;
		}
	} catch {
		/* ignore */
	}

	return setInterval(() => {
		try {
			const path = getOpenClawLogPath();
			if (!existsSync(path)) return;

			// If date changed (new log file), reset counter
			if (path !== lastPath) {
				lastLineCount = 0;
				lastPath = path;
			}

			const content = readFileSync(path, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length <= lastLineCount) return;

			// Send only new lines
			const newLines = lines.slice(lastLineCount);
			lastLineCount = lines.length;

			for (const line of newLines) {
				const parsed = parseLogLine(line);
				if (!parsed) continue;
				res.write(`event: oclog\ndata: ${JSON.stringify(parsed)}\n\n`);
			}
		} catch {
			/* ignore read errors */
		}
	}, 2000);
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

export function createDashboardHandler(
	getEngine: () => OpenAlertsEngine | null,
): HttpHandler {
	return async (
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<boolean> => {
		const url = req.url ?? "";
		if (!url.startsWith("/openalerts")) return false;

		const engine = getEngine();

		// ── GET /openalerts → Dashboard HTML ──────────────────────
		if (
			(url === "/openalerts" || url === "/openalerts/") &&
			req.method === "GET"
		) {
			if (!engine) {
				res.writeHead(503, { "Content-Type": "text/plain" });
				res.end("OpenAlerts engine not running.");
				return true;
			}
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-cache",
			});
			res.end(getDashboardHtml());
			return true;
		}

		// ── GET /openalerts/events → SSE stream (engine events + log tailing) ──
		if (url === "/openalerts/events" && req.method === "GET") {
			if (!engine) {
				res.writeHead(503, { "Content-Type": "text/plain" });
				res.end("Engine not running.");
				return true;
			}

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Access-Control-Allow-Origin": "*",
			});
			res.flushHeaders();

			// Send initial connection event so the browser knows the stream is live
			res.write(`:ok\n\n`);

			// Send current state snapshot as initial event
			const state = engine.state;
			res.write(`event: state\ndata: ${JSON.stringify({
				uptimeMs: Date.now() - state.startedAt,
				stats: state.stats,
				rules: getRuleStatuses(engine),
			})}\n\n`);

			// Send event history so dashboard survives refreshes
			const history = engine.getRecentLiveEvents(200);
			if (history.length > 0) {
				res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
			}

			// Subscribe to engine events
			const unsub = engine.bus.on((event: OpenAlertsEvent) => {
				try {
					res.write(`event: openalerts\ndata: ${JSON.stringify(event)}\n\n`);
				} catch {
					/* closed */
				}
			});

			// Start log file tailer — streams OpenClaw internal logs as `event: oclog`
			const logTailer = createLogTailer(res);

			// Heartbeat every 15s
			const heartbeat = setInterval(() => {
				try {
					res.write(":heartbeat\n\n");
				} catch {
					/* closed */
				}
			}, 15_000);

			const conn: SSEConnection = { res, unsub, heartbeat, logTailer };
			sseConnections.add(conn);

			req.on("close", () => {
				clearInterval(heartbeat);
				clearInterval(logTailer);
				unsub();
				sseConnections.delete(conn);
			});

			return true;
		}

		// ── GET /openalerts/state → JSON snapshot ─────────────────
		if (url === "/openalerts/state" && req.method === "GET") {
			if (!engine) {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Engine not running" }));
				return true;
			}

			const state = engine.state;
			const recentAlerts = engine
				.getRecentEvents(50)
				.filter((e): e is AlertEvent => e.type === "alert");

			const body = JSON.stringify({
				uptimeMs: Date.now() - state.startedAt,
				startedAt: state.startedAt,
				lastHeartbeatTs: state.lastHeartbeatTs,
				hourlyAlerts: state.hourlyAlerts,
				stuckSessions: state.stats.stuckSessions,
				lastResetTs: state.stats.lastResetTs,
				stats: state.stats,
				busListeners: engine.bus.size,
				platformConnected: engine.platformConnected,
				recentAlerts: recentAlerts.slice(0, 20),
				rules: getRuleStatuses(engine),
				cooldowns: Object.fromEntries(state.cooldowns),
			});

			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-cache",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(body);
			return true;
		}

		// ── GET /openalerts/logs → OpenClaw log entries (for Logs tab) ────
		if (url.startsWith("/openalerts/logs") && req.method === "GET") {
			const urlObj = new URL(url, "http://localhost");
			const limit = Math.min(
				parseInt(urlObj.searchParams.get("limit") || "200", 10),
				1000,
			);
			const afterTs = urlObj.searchParams.get("after") || undefined;
			const result = readOpenClawLogs(limit, afterTs);

			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-cache",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(
				JSON.stringify({
					entries: result.entries,
					truncated: result.truncated,
					subsystems: result.subsystems,
					logFile: getOpenClawLogPath(),
				}),
			);
			return true;
		}

		// Unknown /openalerts sub-route
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
		return true;
	};
}
