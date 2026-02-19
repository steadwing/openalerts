import type {
	ChatEvent,
	AgentEvent,
	ExecStartedEvent,
	ExecOutputEvent,
	ExecCompletedEvent,
	MonitorSession,
	MonitorAction,
	MonitorExecEvent,
	DiagnosticUsageEvent,
} from "./types.js";

// ─── Session Info Conversion ─────────────────────────────────────────────────

export interface SessionInfo {
	key: string;
	agentId: string;
	createdAt: number;
	lastActivityAt: number;
	messageCount: number;
	lastMessage?: unknown;
	spawnedBy?: string;
}

export function sessionInfoToMonitor(info: SessionInfo): Partial<MonitorSession> {
	return {
		key: info.key,
		agentId: info.agentId,
		lastActivityAt: info.lastActivityAt,
		status: "idle",
		spawnedBy: info.spawnedBy,
		messageCount: info.messageCount,
	};
}

// ─── Chat Event Parser ───────────────────────────────────────────────────────

export function chatEventToAction(event: ChatEvent): MonitorAction {
	let type: MonitorAction["type"] = "streaming";
	if (event.state === "final") type = "complete";
	else if (event.state === "delta") type = "streaming";
	else if (event.state === "aborted") type = "aborted";
	else if (event.state === "error") type = "error";

	const action: MonitorAction = {
		id: `${event.runId}-${event.seq}`,
		runId: event.runId,
		sessionKey: event.sessionKey,
		seq: event.seq,
		type,
		eventType: "chat",
		timestamp: Date.now(),
	};

	if (event.state === "final") {
		if (event.usage) {
			action.inputTokens = event.usage.inputTokens;
			action.outputTokens = event.usage.outputTokens;
		}
		if (event.stopReason) {
			action.stopReason = event.stopReason;
		}
	}

	if (event.message) {
		if (typeof event.message === "string") {
			action.content = event.message;
		} else if (typeof event.message === "object") {
			const msg = event.message as Record<string, unknown>;

			if (Array.isArray(msg.content)) {
				const texts: string[] = [];
				for (const block of msg.content) {
					if (typeof block === "object" && block) {
						const b = block as Record<string, unknown>;
						if (b.type === "text" && typeof b.text === "string") {
							texts.push(b.text);
						} else if (b.type === "tool_use") {
							action.type = "tool_call";
							action.toolName = String(b.name || "unknown");
							action.toolArgs = b.input;
						} else if (b.type === "tool_result") {
							action.type = "tool_result";
							if (typeof b.content === "string") {
								texts.push(b.content);
							}
						}
					}
				}
				if (texts.length > 0) {
					action.content = texts.join("");
				}
			} else if (typeof msg.content === "string") {
				action.content = msg.content;
			} else if (typeof msg.text === "string") {
				action.content = msg.text;
			}
		}
	}

	if (event.errorMessage) {
		action.content = event.errorMessage;
	}

	return action;
}

// ─── Agent Event Parser ──────────────────────────────────────────────────────

export function agentEventToAction(event: AgentEvent): MonitorAction {
	const data = event.data;

	let type: MonitorAction["type"] = "streaming";
	let content: string | undefined;
	let toolName: string | undefined;
	let toolArgs: unknown | undefined;
	let startedAt: number | undefined;
	let endedAt: number | undefined;

	if (event.stream === "lifecycle") {
		if (data.phase === "start") {
			type = "start";
			startedAt = typeof data.startedAt === "number" ? data.startedAt : event.ts;
		} else if (data.phase === "end") {
			type = "complete";
			endedAt = typeof data.endedAt === "number" ? data.endedAt : event.ts;
		}
	} else if (data.type === "tool_use") {
		type = "tool_call";
		toolName = String(data.name || "unknown");
		toolArgs = data.input;
		content = `Tool: ${toolName}`;
	} else if (data.type === "tool_result") {
		type = "tool_result";
		content = String(data.content || "");
	} else if (data.type === "text" || typeof data.text === "string") {
		type = "streaming";
		content = String(data.text || "");
	}

	return {
		id: `${event.runId}-${event.seq}`,
		runId: event.runId,
		sessionKey: event.sessionKey || event.stream,
		seq: event.seq,
		type,
		eventType: "agent",
		timestamp: event.ts,
		content,
		toolName,
		toolArgs,
		startedAt,
		endedAt,
	};
}

// ─── Exec Event Parser ───────────────────────────────────────────────────────

export function execStartedToEvent(
	event: ExecStartedEvent,
	seq?: number,
): MonitorExecEvent {
	const execId = `exec-${event.runId}-${event.pid}`;
	const timestamp = Date.now();
	const id =
		seq != null ? `${execId}-started-${seq}` : `${execId}-started-${timestamp}`;

	return {
		id,
		execId,
		runId: event.runId,
		pid: event.pid,
		sessionId: event.sessionId,
		eventType: "started",
		command: event.command,
		startedAt: event.startedAt,
		timestamp,
	};
}

export function execOutputToEvent(
	event: ExecOutputEvent,
	seq?: number,
): MonitorExecEvent {
	const execId = `exec-${event.runId}-${event.pid}`;
	const timestamp = Date.now();
	const id =
		seq != null ? `${execId}-output-${seq}` : `${execId}-output-${timestamp}`;

	return {
		id,
		execId,
		runId: event.runId,
		pid: event.pid,
		sessionId: event.sessionId,
		eventType: "output",
		stream: event.stream,
		output: event.output,
		timestamp,
	};
}

export function execCompletedToEvent(
	event: ExecCompletedEvent,
	seq?: number,
): MonitorExecEvent {
	const execId = `exec-${event.runId}-${event.pid}`;
	const timestamp = Date.now();
	const id =
		seq != null
			? `${execId}-completed-${seq}`
			: `${execId}-completed-${timestamp}`;

	return {
		id,
		execId,
		runId: event.runId,
		pid: event.pid,
		sessionId: event.sessionId,
		eventType: "completed",
		durationMs: event.durationMs,
		exitCode: event.exitCode,
		status: event.status,
		timestamp,
	};
}

// ─── Main Event Parser ───────────────────────────────────────────────────────

export interface ParsedGatewayEvent {
	session?: Partial<MonitorSession>;
	action?: MonitorAction;
	execEvent?: MonitorExecEvent;
}

export function parseGatewayEvent(
	eventName: string,
	payload: unknown,
	seq?: number,
): ParsedGatewayEvent | null {
	if (eventName === "health" || eventName === "tick") {
		return null;
	}

	if (eventName === "chat" && payload) {
		const chatEvent = payload as ChatEvent;
		return {
			action: chatEventToAction(chatEvent),
			session: {
				key: chatEvent.sessionKey,
				status: chatEvent.state === "delta" ? "thinking" : "active",
				lastActivityAt: Date.now(),
			},
		};
	}

	if (eventName === "agent" && payload) {
		const agentEvent = payload as AgentEvent;

		if (agentEvent.stream === "lifecycle") {
			return {
				action: agentEventToAction(agentEvent),
				session: agentEvent.sessionKey
					? {
							key: agentEvent.sessionKey,
							status:
								agentEvent.data?.phase === "start" ? "thinking" : "active",
							lastActivityAt: Date.now(),
						}
					: undefined,
			};
		}

		if (
			agentEvent.stream === "assistant" &&
			typeof agentEvent.data?.text === "string"
		) {
			return {
				action: agentEventToAction(agentEvent),
				session: agentEvent.sessionKey
					? {
							key: agentEvent.sessionKey,
							status: "thinking",
							lastActivityAt: Date.now(),
						}
					: undefined,
			};
		}

		if (
			agentEvent.data?.type === "tool_use" ||
			agentEvent.data?.type === "tool_result"
		) {
			return {
				action: agentEventToAction(agentEvent),
				session: agentEvent.sessionKey
					? {
							key: agentEvent.sessionKey,
							status: "thinking",
							lastActivityAt: Date.now(),
						}
					: undefined,
			};
		}

		return null;
	}

	if (eventName === "exec.started" && payload) {
		const exec = payload as ExecStartedEvent;
		const execEvent = execStartedToEvent(exec, seq);

		return {
			execEvent,
			session: exec.sessionId
				? {
						key: exec.sessionId,
						status: "thinking",
						lastActivityAt: execEvent.timestamp,
					}
				: undefined,
		};
	}

	if (eventName === "exec.output" && payload) {
		const exec = payload as ExecOutputEvent;
		const execEvent = execOutputToEvent(exec, seq);

		return {
			execEvent,
			session: exec.sessionId
				? {
						key: exec.sessionId,
						lastActivityAt: execEvent.timestamp,
					}
				: undefined,
		};
	}

	if (eventName === "exec.completed" && payload) {
		const exec = payload as ExecCompletedEvent;
		const execEvent = execCompletedToEvent(exec, seq);

		return {
			execEvent,
			session: exec.sessionId
				? {
						key: exec.sessionId,
						status: "active",
						lastActivityAt: execEvent.timestamp,
					}
				: undefined,
		};
	}

	return null;
}

// ─── Diagnostic Usage Event Parser ───────────────────────────────────────────

export interface ParsedDiagnosticUsage {
	session?: Partial<MonitorSession>;
	action?: MonitorAction;
}

export function diagnosticUsageToSessionUpdate(
	event: DiagnosticUsageEvent,
): ParsedDiagnosticUsage {
	const sessionKey = event.sessionKey || event.sessionId;
	const now = Date.now();

	const result: ParsedDiagnosticUsage = {};

	if (sessionKey) {
		const inputTokens =
			event.usage?.input ?? event.usage?.promptTokens ?? 0;
		const outputTokens = event.usage?.output ?? 0;

		result.session = {
			key: sessionKey,
			lastActivityAt: now,
			status: "active",
			totalInputTokens: inputTokens,
			totalOutputTokens: outputTokens,
		};

		if (typeof event.costUsd === "number") {
			result.session.totalCostUsd = event.costUsd;
		}
	}

	if (typeof event.costUsd === "number" || event.usage) {
		const actionId = `usage-${event.ts}-${event.seq}`;
		result.action = {
			id: actionId,
			runId: actionId,
			sessionKey: sessionKey || "unknown",
			seq: event.seq,
			type: "complete",
			eventType: "system",
			timestamp: event.ts,
			inputTokens: event.usage?.input ?? event.usage?.promptTokens,
			outputTokens: event.usage?.output,
			costUsd: event.costUsd,
			model: event.model,
			provider: event.provider,
			duration: event.durationMs,
		};
	}

	return result;
}
