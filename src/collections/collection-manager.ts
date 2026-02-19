import { BoundedMap } from "../core/bounded-map.js";
import {
	parseSessionKey,
	type MonitorSession,
	type MonitorAction,
	type MonitorExecEvent,
	type MonitorExecProcess,
	type MonitorExecOutputChunk,
	type MonitorExecProcessStatus,
	type CollectionStats,
	type CostUsageSummary,
} from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_SESSIONS = 200;
const MAX_ACTIONS = 2000;
const MAX_EXECS = 500;
const MAX_ACTION_HISTORY = 10;
const SPAWN_INFERENCE_WINDOW_MS = 10000;
const EXEC_PLACEHOLDER_COMMAND = "Exec";
const MAX_EXEC_OUTPUT_CHUNKS = 200;
const MAX_EXEC_OUTPUT_CHARS = 50000;
const MAX_EXEC_CHUNK_CHARS = 4000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSubagentSession(key: string): boolean {
	return key.includes("subagent");
}

function isParentSession(key: string): boolean {
	return !isSubagentSession(key) && !key.includes("lifecycle");
}

function mapExecStatus(
	exitCode?: number,
	status?: string,
): MonitorExecProcessStatus {
	if (typeof exitCode === "number" && exitCode !== 0) return "failed";
	if (typeof status === "string") {
		const normalized = status.toLowerCase();
		if (normalized.includes("fail") || normalized.includes("error")) {
			return "failed";
		}
	}
	return "completed";
}

function capExecOutputs(outputs: MonitorExecOutputChunk[]): {
	outputs: MonitorExecOutputChunk[];
	truncated: boolean;
} {
	let truncated = false;
	const normalized: MonitorExecOutputChunk[] = outputs.map((chunk) => {
		if (chunk.text.length <= MAX_EXEC_CHUNK_CHARS) {
			return chunk;
		}
		truncated = true;
		return {
			...chunk,
			text: chunk.text.slice(0, MAX_EXEC_CHUNK_CHARS) + "\n...[truncated]",
		};
	});

	let capped = normalized;
	if (capped.length > MAX_EXEC_OUTPUT_CHUNKS) {
		truncated = true;
		capped = capped.slice(-MAX_EXEC_OUTPUT_CHUNKS);
	}

	const totalChars = capped.reduce((sum, chunk) => sum + chunk.text.length, 0);
	if (totalChars > MAX_EXEC_OUTPUT_CHARS) {
		truncated = true;
		let dropped = 0;
		let startIdx = 0;
		for (let i = 0; i < capped.length; i++) {
			if (totalChars - dropped <= MAX_EXEC_OUTPUT_CHARS) break;
			dropped += capped[i]!.text.length;
			startIdx = i + 1;
		}
		capped = capped.slice(startIdx);
	}

	return { outputs: capped, truncated };
}

// ─── Collection Manager ──────────────────────────────────────────────────────

export class CollectionManager {
	private sessions: BoundedMap<string, MonitorSession>;
	private actions: BoundedMap<string, MonitorAction>;
	private execs: BoundedMap<string, MonitorExecProcess>;

	private runSessionMap = new Map<string, string>();
	private parentActionHistory = new Map<string, number[]>();

	private onSessionChange?: (session: MonitorSession) => void;
	private onActionChange?: (action: MonitorAction) => void;
	private onExecChange?: (exec: MonitorExecProcess) => void;

	constructor() {
		this.sessions = new BoundedMap({ maxSize: MAX_SESSIONS });
		this.actions = new BoundedMap({ maxSize: MAX_ACTIONS });
		this.execs = new BoundedMap({ maxSize: MAX_EXECS });
	}

	setCallbacks(callbacks: {
		onSessionChange?: (session: MonitorSession) => void;
		onActionChange?: (action: MonitorAction) => void;
		onExecChange?: (exec: MonitorExecProcess) => void;
	}): void {
		this.onSessionChange = callbacks.onSessionChange;
		this.onActionChange = callbacks.onActionChange;
		this.onExecChange = callbacks.onExecChange;
	}

	private trackParentAction(sessionKey: string, timestamp?: number): void {
		if (!isParentSession(sessionKey)) return;
		const ts = timestamp ?? Date.now();

		let history = this.parentActionHistory.get(sessionKey);
		if (!history) {
			history = [];
			this.parentActionHistory.set(sessionKey, history);
		}

		history.push(ts);

		if (history.length > MAX_ACTION_HISTORY) {
			history.shift();
		}
	}

	private inferSpawnedBy(
		subagentKey: string,
		timestamp?: number,
	): string | undefined {
		if (!isSubagentSession(subagentKey)) return undefined;

		const subagentTime = timestamp ?? Date.now();
		const cutoff = subagentTime - SPAWN_INFERENCE_WINDOW_MS;

		let bestParent: string | undefined;
		let bestTime = 0;

		for (const [parentKey, history] of this.parentActionHistory) {
			for (let i = history.length - 1; i >= 0; i--) {
				const actionTime = history[i]!;
				if (actionTime <= subagentTime && actionTime >= cutoff) {
					if (actionTime > bestTime) {
						bestTime = actionTime;
						bestParent = parentKey;
					}
					break;
				}
			}
		}

		return bestParent;
	}

	private resolveSessionKey(event: MonitorExecEvent): string | undefined {
		return (
			event.sessionKey ||
			this.runSessionMap.get(event.runId) ||
			event.sessionId
		);
	}

	private backfillExecSessionKey(runId: string, sessionKey: string): void {
		for (const [id, exec] of this.execs.entries()) {
			if (exec.runId !== runId) continue;
			if (exec.sessionKey && exec.sessionKey !== exec.sessionId) continue;
			this.execs.set(id, {
				...exec,
				sessionKey,
			});
		}
	}

	private createPlaceholderExec(
		event: MonitorExecEvent,
		sessionKey?: string,
	): MonitorExecProcess {
		const startedAt = event.startedAt ?? event.timestamp;
		return {
			id: event.execId,
			runId: event.runId,
			pid: event.pid,
			command: event.command || EXEC_PLACEHOLDER_COMMAND,
			sessionId: event.sessionId,
			sessionKey,
			status:
				event.eventType === "completed"
					? mapExecStatus(event.exitCode, event.status)
					: "running",
			startedAt,
			timestamp: startedAt,
			outputs: [],
			lastActivityAt: event.timestamp,
		};
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	upsertSession(session: Partial<MonitorSession>): void {
		if (!session.key) return;

		const existing = this.sessions.get(session.key);

		if (existing) {
			const preservedSpawnedBy = existing.spawnedBy;
			const accumulatedCost =
				(existing.totalCostUsd ?? 0) + (session.totalCostUsd ?? 0);
			const accumulatedInput =
				(existing.totalInputTokens ?? 0) + (session.totalInputTokens ?? 0);
			const accumulatedOutput =
				(existing.totalOutputTokens ?? 0) + (session.totalOutputTokens ?? 0);
			const updated: MonitorSession = {
				...existing,
				...session,
				spawnedBy: preservedSpawnedBy,
				totalCostUsd: session.totalCostUsd !== undefined ? accumulatedCost : existing.totalCostUsd,
				totalInputTokens: session.totalInputTokens !== undefined ? accumulatedInput : existing.totalInputTokens,
				totalOutputTokens: session.totalOutputTokens !== undefined ? accumulatedOutput : existing.totalOutputTokens,
			} as MonitorSession;
			this.sessions.set(session.key, updated);
			this.onSessionChange?.(updated);
		} else {
			let spawnedBy = session.spawnedBy;
			if (!spawnedBy && session.key && isSubagentSession(session.key)) {
				spawnedBy = this.inferSpawnedBy(
					session.key,
					session.lastActivityAt ?? Date.now(),
				);
			}
			const parsed = parseSessionKey(session.key);
			const newSession: MonitorSession = {
				key: session.key,
				agentId: session.agentId ?? parsed.agentId,
				platform: session.platform ?? parsed.platform,
				recipient: session.recipient ?? parsed.recipient,
				isGroup: session.isGroup ?? parsed.isGroup,
				lastActivityAt: session.lastActivityAt ?? Date.now(),
				status: session.status ?? "idle",
				spawnedBy,
				messageCount: session.messageCount,
				totalCostUsd: session.totalCostUsd,
				totalInputTokens: session.totalInputTokens,
				totalOutputTokens: session.totalOutputTokens,
			};
			this.sessions.set(session.key, newSession);
			this.onSessionChange?.(newSession);
		}
	}

	updateSessionStatus(key: string, status: MonitorSession["status"]): void {
		const now = Date.now();
		const session = this.sessions.get(key);
		if (session) {
			const updated: MonitorSession = {
				...session,
				status,
				lastActivityAt: now,
			};
			this.sessions.set(key, updated);
			this.onSessionChange?.(updated);
		} else if (isSubagentSession(key)) {
			const spawnedBy = this.inferSpawnedBy(key, now);
			const parsed = parseSessionKey(key);
			const newSession: MonitorSession = {
				key,
				agentId: parsed.agentId,
				platform: parsed.platform,
				recipient: parsed.recipient,
				isGroup: parsed.isGroup,
				lastActivityAt: now,
				status,
				spawnedBy,
			};
			this.sessions.set(key, newSession);
			this.onSessionChange?.(newSession);
		}
	}

	addAction(action: MonitorAction): void {
		if (action.sessionKey && !action.sessionKey.includes("lifecycle")) {
			const previous = this.runSessionMap.get(action.runId);
			this.runSessionMap.set(action.runId, action.sessionKey);
			if (previous !== action.sessionKey) {
				this.backfillExecSessionKey(action.runId, action.sessionKey);
			}

			if (isParentSession(action.sessionKey)) {
				this.trackParentAction(action.sessionKey, action.timestamp);
			}
		}

		let sessionKey = action.sessionKey;
		if (!sessionKey || sessionKey === "lifecycle") {
			sessionKey = this.runSessionMap.get(action.runId) || sessionKey;
		}

		const actionNodeId = `${action.runId}-action`;

		if (
			["start", "streaming", "complete", "error", "aborted"].includes(
				action.type,
			)
		) {
			const existing = this.actions.get(actionNodeId);

			if (existing) {
				const updated: MonitorAction = {
					...existing,
					type: action.type,
					seq: action.seq,
					timestamp: action.timestamp,
					sessionKey:
						sessionKey && sessionKey !== "lifecycle"
							? sessionKey
							: existing.sessionKey,
					content: action.content ?? existing.content,
					inputTokens: action.inputTokens ?? existing.inputTokens,
					outputTokens: action.outputTokens ?? existing.outputTokens,
					stopReason: action.stopReason ?? existing.stopReason,
					endedAt: action.endedAt ?? existing.endedAt,
					costUsd: action.costUsd ?? existing.costUsd,
					model: action.model ?? existing.model,
					provider: action.provider ?? existing.provider,
					duration:
						existing.startedAt && action.endedAt
							? action.endedAt - existing.startedAt
							: existing.duration,
				};
				this.actions.set(actionNodeId, updated);
				this.onActionChange?.(updated);
			} else {
				const newAction: MonitorAction = {
					...action,
					id: actionNodeId,
					sessionKey,
				};
				this.actions.set(actionNodeId, newAction);
				this.onActionChange?.(newAction);
			}
			return;
		}

		const existing = this.actions.get(action.id);
		if (!existing) {
			const newAction: MonitorAction = { ...action, sessionKey };
			this.actions.set(action.id, newAction);
			this.onActionChange?.(newAction);
		}
	}

	addExecEvent(event: MonitorExecEvent): void {
		const sessionKey = this.resolveSessionKey(event);
		const existing = this.execs.get(event.execId);

		if (event.eventType === "started") {
			if (existing) {
				const updated: MonitorExecProcess = {
					...existing,
					command: event.command || existing.command || EXEC_PLACEHOLDER_COMMAND,
					sessionId: event.sessionId || existing.sessionId,
					sessionKey: sessionKey || existing.sessionKey,
					status: "running",
					startedAt: event.startedAt ?? existing.startedAt ?? event.timestamp,
					timestamp: event.startedAt ?? existing.startedAt ?? event.timestamp,
					lastActivityAt: event.timestamp,
				};
				this.execs.set(event.execId, updated);
				this.onExecChange?.(updated);
				return;
			}

			const newExec = {
				...this.createPlaceholderExec(event, sessionKey),
				command: event.command || EXEC_PLACEHOLDER_COMMAND,
				startedAt: event.startedAt ?? event.timestamp,
				timestamp: event.startedAt ?? event.timestamp,
			};
			this.execs.set(event.execId, newExec);
			this.onExecChange?.(newExec);
			return;
		}

		if (event.eventType === "output") {
			const stream = event.stream || "stdout";
			const text = event.output ?? "";
			const chunk: MonitorExecOutputChunk = {
				id: event.id,
				stream,
				text,
				timestamp: event.timestamp,
			};

			if (existing) {
				const capped = capExecOutputs([...existing.outputs, chunk]);
				const updated: MonitorExecProcess = {
					...existing,
					sessionId: event.sessionId || existing.sessionId,
					sessionKey: sessionKey || existing.sessionKey,
					lastActivityAt: event.timestamp,
					outputs: text ? capped.outputs : existing.outputs,
					outputTruncated: existing.outputTruncated || capped.truncated,
				};
				this.execs.set(event.execId, updated);
				this.onExecChange?.(updated);
				return;
			}

			const placeholder = this.createPlaceholderExec(event, sessionKey);
			if (text) {
				const capped = capExecOutputs([chunk]);
				placeholder.outputs = capped.outputs;
				placeholder.outputTruncated = capped.truncated;
			}
			this.execs.set(event.execId, placeholder);
			this.onExecChange?.(placeholder);
			return;
		}

		if (event.eventType === "completed") {
			const completedStatus = mapExecStatus(event.exitCode, event.status);
			if (existing) {
				const completedAt =
					existing.durationMs != null
						? existing.startedAt + existing.durationMs
						: event.timestamp;
				const updated: MonitorExecProcess = {
					...existing,
					sessionId: event.sessionId || existing.sessionId,
					sessionKey: sessionKey || existing.sessionKey,
					command: event.command || existing.command || EXEC_PLACEHOLDER_COMMAND,
					exitCode: event.exitCode ?? existing.exitCode,
					durationMs: event.durationMs ?? existing.durationMs,
					completedAt,
					status: completedStatus,
					lastActivityAt: event.timestamp,
				};
				this.execs.set(event.execId, updated);
				this.onExecChange?.(updated);
				return;
			}

			const placeholder = this.createPlaceholderExec(event, sessionKey);
			placeholder.command = event.command || placeholder.command;
			placeholder.exitCode = event.exitCode;
			placeholder.durationMs = event.durationMs;
			placeholder.completedAt =
				placeholder.durationMs != null
					? placeholder.startedAt + placeholder.durationMs
					: event.timestamp;
			placeholder.status = completedStatus;
			this.execs.set(event.execId, placeholder);
			this.onExecChange?.(placeholder);
		}
	}

	// ─── Queries ───────────────────────────────────────────────────────────────

	getSessions(): MonitorSession[] {
		return Array.from(this.sessions.values());
	}

	getActions(opts?: { sessionKey?: string; limit?: number }): MonitorAction[] {
		let actions = Array.from(this.actions.values());
		if (opts?.sessionKey) {
			actions = actions.filter((a) => a.sessionKey === opts.sessionKey);
		}
		actions.sort((a, b) => b.timestamp - a.timestamp);
		if (opts?.limit) {
			actions = actions.slice(0, opts.limit);
		}
		return actions;
	}

	getExecs(opts?: {
		status?: MonitorExecProcessStatus;
		sessionKey?: string;
	}): MonitorExecProcess[] {
		let execs = Array.from(this.execs.values());
		if (opts?.status) {
			execs = execs.filter((e) => e.status === opts.status);
		}
		if (opts?.sessionKey) {
			execs = execs.filter((e) => e.sessionKey === opts.sessionKey);
		}
		execs.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
		return execs;
	}

	getExec(id: string): MonitorExecProcess | undefined {
		return this.execs.get(id);
	}

	getStats(): CollectionStats {
		let totalCostUsd = 0;
		for (const session of this.sessions.values()) {
			if (session.totalCostUsd) {
				totalCostUsd += session.totalCostUsd;
			}
		}
		return {
			sessions: this.sessions.size,
			actions: this.actions.size,
			execs: this.execs.size,
			runSessionMapSize: this.runSessionMap.size,
			totalCostUsd,
		};
	}

	// ─── Cost Tracking ───────────────────────────────────────────────────────────

	updateSessionCost(
		sessionKey: string,
		costUsd: number,
		inputTokens?: number,
		outputTokens?: number,
	): void {
		const existing = this.sessions.get(sessionKey);
		if (existing) {
			const updated: MonitorSession = {
				...existing,
				totalCostUsd: (existing.totalCostUsd ?? 0) + costUsd,
				totalInputTokens:
					(existing.totalInputTokens ?? 0) + (inputTokens ?? 0),
				totalOutputTokens:
					(existing.totalOutputTokens ?? 0) + (outputTokens ?? 0),
			};
			this.sessions.set(sessionKey, updated);
			this.onSessionChange?.(updated);
		} else {
			const parsed = parseSessionKey(sessionKey);
			const spawnedBy = isSubagentSession(sessionKey)
				? this.inferSpawnedBy(sessionKey, Date.now())
				: undefined;
			const newSession: MonitorSession = {
				key: sessionKey,
				agentId: parsed.agentId,
				platform: parsed.platform,
				recipient: parsed.recipient,
				isGroup: parsed.isGroup,
				lastActivityAt: Date.now(),
				status: "active",
				spawnedBy,
				totalCostUsd: costUsd,
				totalInputTokens: inputTokens ?? 0,
				totalOutputTokens: outputTokens ?? 0,
			};
			this.sessions.set(sessionKey, newSession);
			this.onSessionChange?.(newSession);
		}
	}

	syncAggregatedCosts(summary: CostUsageSummary): void {
		if (summary.bySession) {
			for (const [sessionKey, totals] of Object.entries(summary.bySession)) {
				if (totals.totalCost > 0) {
					const existing = this.sessions.get(sessionKey);
					if (existing) {
						const updated: MonitorSession = {
							...existing,
							totalCostUsd: totals.totalCost,
							totalInputTokens: totals.input,
							totalOutputTokens: totals.output,
						};
						this.sessions.set(sessionKey, updated);
					}
				}
			}
		}
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────────────

	clear(): void {
		this.runSessionMap.clear();
		this.parentActionHistory.clear();
		this.sessions.clear();
		this.actions.clear();
		this.execs.clear();
	}

	hydrate(
		sessions: MonitorSession[],
		actions: MonitorAction[],
		execEvents: MonitorExecEvent[] = [],
	): void {
		this.clear();

		const sortedActions = [...actions].sort((a, b) => a.timestamp - b.timestamp);

		for (const action of sortedActions) {
			if (action.sessionKey && isParentSession(action.sessionKey)) {
				this.trackParentAction(action.sessionKey, action.timestamp);
			}
		}

		for (const session of sessions) {
			if (isParentSession(session.key)) {
				this.trackParentAction(session.key, session.lastActivityAt);
			}
		}

		for (const session of sessions) {
			if (isSubagentSession(session.key)) {
				const spawnedBy =
					session.spawnedBy ||
					this.inferSpawnedBy(session.key, session.lastActivityAt);
				this.sessions.set(session.key, { ...session, spawnedBy });
			} else {
				this.sessions.set(session.key, session);
			}
		}

		for (const action of sortedActions) {
			this.addAction(action);
		}

		const sortedExecEvents = [...execEvents].sort(
			(a, b) => a.timestamp - b.timestamp,
		);
		for (const event of sortedExecEvents) {
			this.addExecEvent(event);
		}
	}

	exportSessions(): MonitorSession[] {
		return this.getSessions();
	}

	exportActions(): MonitorAction[] {
		return this.getActions();
	}

	exportExecEvents(): MonitorExecEvent[] {
		const events: MonitorExecEvent[] = [];
		for (const exec of this.execs.values()) {
			events.push({
				id: `${exec.id}-started`,
				execId: exec.id,
				runId: exec.runId,
				pid: exec.pid,
				sessionId: exec.sessionId,
				sessionKey: exec.sessionKey,
				eventType: "started",
				command: exec.command,
				startedAt: exec.startedAt,
				timestamp: exec.startedAt,
			});
			for (const chunk of exec.outputs) {
				events.push({
					id: chunk.id,
					execId: exec.id,
					runId: exec.runId,
					pid: exec.pid,
					sessionId: exec.sessionId,
					sessionKey: exec.sessionKey,
					eventType: "output",
					stream: chunk.stream,
					output: chunk.text,
					timestamp: chunk.timestamp,
				});
			}
			if (exec.completedAt) {
				events.push({
					id: `${exec.id}-completed`,
					execId: exec.id,
					runId: exec.runId,
					pid: exec.pid,
					sessionId: exec.sessionId,
					sessionKey: exec.sessionKey,
					eventType: "completed",
					durationMs: exec.durationMs,
					exitCode: exec.exitCode,
					status: exec.status,
					timestamp: exec.completedAt,
				});
			}
		}
		return events;
	}
}