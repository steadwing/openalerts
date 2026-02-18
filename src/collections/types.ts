// ─── Session Types ───────────────────────────────────────────────────────────

export interface MonitorSession {
	key: string;
	agentId: string;
	platform: string;
	recipient: string;
	isGroup: boolean;
	lastActivityAt: number;
	status: "idle" | "active" | "thinking";
	spawnedBy?: string;
	messageCount?: number;
}

// ─── Action Types ────────────────────────────────────────────────────────────

export type MonitorActionType =
	| "start"
	| "streaming"
	| "complete"
	| "aborted"
	| "error"
	| "tool_call"
	| "tool_result";

export type MonitorActionEventType = "chat" | "agent" | "system";

export interface MonitorAction {
	id: string;
	runId: string;
	sessionKey: string;
	seq: number;
	type: MonitorActionType;
	eventType: MonitorActionEventType;
	timestamp: number;
	content?: string;
	toolName?: string;
	toolArgs?: unknown;
	startedAt?: number;
	endedAt?: number;
	duration?: number;
	inputTokens?: number;
	outputTokens?: number;
	stopReason?: string;
}

// ─── Exec Types ──────────────────────────────────────────────────────────────

export type MonitorExecEventType = "started" | "output" | "completed";

export type MonitorExecProcessStatus = "running" | "completed" | "failed";

export interface MonitorExecOutputChunk {
	id: string;
	stream: "stdout" | "stderr" | string;
	text: string;
	timestamp: number;
}

export interface MonitorExecEvent {
	id: string;
	execId: string;
	runId: string;
	pid: number;
	sessionId?: string;
	sessionKey?: string;
	eventType: MonitorExecEventType;
	command?: string;
	stream?: "stdout" | "stderr" | string;
	output?: string;
	startedAt?: number;
	durationMs?: number;
	exitCode?: number;
	status?: string;
	timestamp: number;
}

export interface MonitorExecProcess {
	id: string;
	runId: string;
	pid: number;
	command: string;
	sessionId?: string;
	sessionKey?: string;
	status: MonitorExecProcessStatus;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	exitCode?: number;
	outputs: MonitorExecOutputChunk[];
	outputTruncated?: boolean;
	timestamp: number;
	lastActivityAt: number;
}

// ─── Gateway Event Types (raw payloads) ──────────────────────────────────────

export interface ChatEvent {
	runId: string;
	sessionKey: string;
	seq: number;
	state: "delta" | "final" | "aborted" | "error";
	message?: unknown;
	errorMessage?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
	};
	stopReason?: string;
}

export interface AgentEvent {
	runId: string;
	seq: number;
	stream: string;
	ts: number;
	data: Record<string, unknown>;
	sessionKey?: string;
}

export interface ExecStartedEvent {
	pid: number;
	command: string;
	sessionId: string;
	runId: string;
	startedAt: number;
}

export interface ExecOutputEvent {
	pid: number;
	runId: string;
	sessionId?: string;
	stream: "stdout" | "stderr" | string;
	output: string;
}

export interface ExecCompletedEvent {
	pid: number;
	runId: string;
	sessionId?: string;
	exitCode: number;
	durationMs: number;
	status: string;
}

// ─── Utility Functions ───────────────────────────────────────────────────────

export function parseSessionKey(key: string): {
	agentId: string;
	platform: string;
	recipient: string;
	isGroup: boolean;
} {
	// Format: "agent:main:discord:channel:1234567890"
	// Or: "agent:main:telegram:group:12345"
	// Or: "agent:main:whatsapp:+1234567890"
	const parts = key.split(":");
	const agentId = parts[1] || "unknown";
	const platform = parts[2] || "unknown";
	// Check if 4th part indicates a type (channel, group, dm, etc)
	const hasType = ["channel", "group", "dm", "thread"].includes(parts[3] || "");
	const isGroup = parts[3] === "group" || parts[3] === "channel";
	const recipient = hasType ? parts.slice(3).join(":") : parts.slice(3).join(":");

	return { agentId, platform, recipient, isGroup };
}

// ─── Collection Stats ────────────────────────────────────────────────────────

export interface CollectionStats {
	sessions: number;
	actions: number;
	execs: number;
	runSessionMapSize: number;
}
