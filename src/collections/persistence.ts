import fs from "node:fs";
import path from "node:path";
import type {
	MonitorSession,
	MonitorAction,
	MonitorExecEvent,
} from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const COLLECTIONS_DIR_NAME = "collections";
const SESSIONS_FILENAME = "sessions.json";
const ACTIONS_FILENAME = "actions.jsonl";
const EXECS_FILENAME = "execs.jsonl";
const MAX_ACTIONS_LINES = 10000;
const MAX_EXECS_LINES = 20000;
const FLUSH_INTERVAL_MS = 5000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveDir(stateDir: string): string {
	return path.join(stateDir, COLLECTIONS_DIR_NAME);
}

function resolveSessionsPath(stateDir: string): string {
	return path.join(resolveDir(stateDir), SESSIONS_FILENAME);
}

function resolveActionsPath(stateDir: string): string {
	return path.join(resolveDir(stateDir), ACTIONS_FILENAME);
}

function resolveExecsPath(stateDir: string): string {
	return path.join(resolveDir(stateDir), EXECS_FILENAME);
}

function ensureDir(stateDir: string): void {
	const dir = resolveDir(stateDir);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function writeAtomic(filePath: string, content: string): void {
	const tmpPath = filePath + ".tmp";
	try {
		fs.writeFileSync(tmpPath, content, "utf-8");
		fs.renameSync(tmpPath, filePath);
	} catch {
		fs.writeFileSync(filePath, content, "utf-8");
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// Ignore cleanup failure
		}
	}
}

function appendLine(filePath: string, line: string): void {
	fs.appendFileSync(filePath, line + "\n", "utf-8");
}

function capJsonlFile(filePath: string, maxLines: number): void {
	if (!fs.existsSync(filePath)) return;

	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		if (lines.length <= maxLines) return;

		const kept = lines.slice(-maxLines);
		writeAtomic(filePath, kept.join("\n") + "\n");
	} catch {
		// Ignore errors during cap
	}
}

// ─── Persistence Class ───────────────────────────────────────────────────────

export class CollectionPersistence {
	private stateDir: string;
	private dirty = false;
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	// Cached data for tracking changes
	private lastSessionsJson: string = "";
	private pendingActions: MonitorAction[] = [];
	private pendingExecs: MonitorExecEvent[] = [];

	constructor(stateDir: string) {
		this.stateDir = stateDir;
	}

	start(): void {
		ensureDir(this.stateDir);
		this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
	}

	stop(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		this.flush();
	}

	markDirty(): void {
		this.dirty = true;
	}

	// ─── Sessions (JSON rewrite) ──────────────────────────────────────────────

	saveSessions(sessions: MonitorSession[]): void {
		const json = JSON.stringify(sessions, null, 2);
		if (json === this.lastSessionsJson) return;

		this.lastSessionsJson = json;
		this.dirty = true;
	}

	loadSessions(): MonitorSession[] {
		const filePath = resolveSessionsPath(this.stateDir);
		if (!fs.existsSync(filePath)) return [];

		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				return parsed as MonitorSession[];
			}
			return [];
		} catch {
			return [];
		}
	}

	// ─── Actions (JSONL append) ───────────────────────────────────────────────

	queueAction(action: MonitorAction): void {
		this.pendingActions.push(action);
		this.dirty = true;
	}

	loadActions(): MonitorAction[] {
		const filePath = resolveActionsPath(this.stateDir);
		if (!fs.existsSync(filePath)) return [];

		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const actions: MonitorAction[] = [];

			for (const line of lines) {
				try {
					const parsed = JSON.parse(line);
					if (parsed && typeof parsed.id === "string") {
						actions.push(parsed as MonitorAction);
					}
				} catch {
					// Skip malformed lines
				}
			}

			return actions;
		} catch {
			return [];
		}
	}

	// ─── Execs (JSONL append) ─────────────────────────────────────────────────

	queueExecEvent(event: MonitorExecEvent): void {
		this.pendingExecs.push(event);
		this.dirty = true;
	}

	loadExecEvents(): MonitorExecEvent[] {
		const filePath = resolveExecsPath(this.stateDir);
		if (!fs.existsSync(filePath)) return [];

		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const events: MonitorExecEvent[] = [];

			for (const line of lines) {
				try {
					const parsed = JSON.parse(line);
					if (parsed && typeof parsed.id === "string") {
						events.push(parsed as MonitorExecEvent);
					}
				} catch {
					// Skip malformed lines
				}
			}

			return events;
		} catch {
			return [];
		}
	}

	// ─── Flush ────────────────────────────────────────────────────────────────

	flush(): void {
		if (!this.dirty && this.pendingActions.length === 0 && this.pendingExecs.length === 0) {
			return;
		}

		ensureDir(this.stateDir);

		// Write sessions if changed
		if (this.lastSessionsJson) {
			const filePath = resolveSessionsPath(this.stateDir);
			writeAtomic(filePath, this.lastSessionsJson);
		}

		// Append pending actions
		if (this.pendingActions.length > 0) {
			const filePath = resolveActionsPath(this.stateDir);
			for (const action of this.pendingActions) {
				appendLine(filePath, JSON.stringify(action));
			}
			this.pendingActions = [];
			capJsonlFile(filePath, MAX_ACTIONS_LINES);
		}

		// Append pending exec events
		if (this.pendingExecs.length > 0) {
			const filePath = resolveExecsPath(this.stateDir);
			for (const event of this.pendingExecs) {
				appendLine(filePath, JSON.stringify(event));
			}
			this.pendingExecs = [];
			capJsonlFile(filePath, MAX_EXECS_LINES);
		}

		this.dirty = false;
	}

	// ─── Full Hydration ───────────────────────────────────────────────────────

	hydrate(): {
		sessions: MonitorSession[];
		actions: MonitorAction[];
		execEvents: MonitorExecEvent[];
	} {
		return {
			sessions: this.loadSessions(),
			actions: this.loadActions(),
			execEvents: this.loadExecEvents(),
		};
	}
}