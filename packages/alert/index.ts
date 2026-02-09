import { OpenAlertsEngine } from "@steadwing/openalerts-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";
import { createLogBridge } from "./src/log-bridge.js";
import {
	OpenClawAlertChannel,
	parseConfig,
	resolveAlertTarget,
	translateOpenClawEvent,
	translateToolCallHook,
	translateAgentStartHook,
	translateAgentEndHook,
	translateSessionStartHook,
	translateSessionEndHook,
	translateMessageSentHook,
	translateMessageReceivedHook,
	translateBeforeToolCallHook,
	translateBeforeCompactionHook,
	translateAfterCompactionHook,
	translateMessageSendingHook,
	translateToolResultPersistHook,
	translateGatewayStartHook,
	translateGatewayStopHook,
} from "./src/adapter.js";
import { bindEngine, createMonitorCommands } from "./src/commands.js";
import {
	createDashboardHandler,
	closeDashboardConnections,
} from "./src/dashboard-routes.js";

const PLUGIN_ID = "openalerts";
const LOG_PREFIX = "openalerts";

type OpenClawPluginService = {
	id: string;
	start: (ctx: {
		config: Record<string, unknown>;
		stateDir: string;
		logger: PluginLogger;
	}) => Promise<void> | void;
	stop?: () => Promise<void> | void;
};

type PluginLogger = {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
};

let engine: OpenAlertsEngine | null = null;
let unsubDiagnostic: (() => void) | null = null;
let unsubLogTransport: (() => void) | null = null;
let logBridgeCleanup: (() => void) | null = null;

function createMonitorService(api: OpenClawPluginApi): OpenClawPluginService {
	return {
		id: PLUGIN_ID,

		start(ctx) {
			const logger = ctx.logger;
			const config = parseConfig(api.pluginConfig);

			// Resolve alert target + create OpenClaw alert channel
			const target = resolveAlertTarget(api, config);
			const channels = target ? [new OpenClawAlertChannel(api, target)] : [];

			// Create and start the universal engine
			engine = new OpenAlertsEngine({
				stateDir: ctx.stateDir,
				config,
				channels,
				logger,
				logPrefix: LOG_PREFIX,
				diagnosisHint: 'Run "openclaw doctor" to diagnose.',
			});

			engine.start();

			// Wire commands to engine
			bindEngine(engine, api);

			// ── Bridge 1: Diagnostic events → engine ──────────────────────────────
			// Covers: webhook.*, message.*, session.stuck, session.state,
			//         model.usage, queue.lane.*, diagnostic.heartbeat, run.attempt
			unsubDiagnostic = onDiagnosticEvent(
				(event: { type: string; [key: string]: unknown }) => {
					const translated = translateOpenClawEvent(event);
					if (translated) {
						engine!.ingest(translated);
					}
				},
			);

			// ── Bridge 2: Log transport → engine (fills gaps from non-firing hooks) ─
			// Parses structured log records to synthesize tool.call, session.start/end,
			// and run duration events that hooks don't provide in long-polling mode.
			const logBridge = createLogBridge(engine);
			unsubLogTransport = registerLogTransport(logBridge.transport);
			logBridgeCleanup = logBridge.cleanup;

			// ── Bridge 3: Plugin hooks → engine ───────────────────────────────────
			// Covers: tool calls, agent lifecycle, session lifecycle, gateway, messages
			// These events are NOT emitted as diagnostic events — they come through
			// the plugin hook system (api.on).

			const apiOn = api.on?.bind(api);
			if (apiOn) {
				// Tool execution tracking
				apiOn("after_tool_call", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateToolCallHook(
							data as {
								toolName: string;
								params: Record<string, unknown>;
								result?: unknown;
								error?: string;
								durationMs?: number;
							},
							{
								sessionId: (hookCtx as Record<string, unknown>).sessionId as
									| string
									| undefined,
								agentId: (hookCtx as Record<string, unknown>).agentId as
									| string
									| undefined,
							},
						),
					);
				});

				// Agent lifecycle
				apiOn("before_agent_start", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateAgentStartHook(
							data as { prompt: string; messages?: unknown[] },
							{
								sessionId: (hookCtx as Record<string, unknown>).sessionId as
									| string
									| undefined,
								agentId: (hookCtx as Record<string, unknown>).agentId as
									| string
									| undefined,
							},
						),
					);
				});

				apiOn("agent_end", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateAgentEndHook(
							data as {
								messages: unknown[];
								success: boolean;
								error?: string;
								durationMs?: number;
							},
							{
								sessionId: (hookCtx as Record<string, unknown>).sessionId as
									| string
									| undefined,
								agentId: (hookCtx as Record<string, unknown>).agentId as
									| string
									| undefined,
							},
						),
					);
				});

				// Session lifecycle
				apiOn("session_start", (data) => {
					if (!engine) return;
					engine.ingest(
						translateSessionStartHook(
							data as { sessionId: string; resumedFrom?: string },
						),
					);
				});

				apiOn("session_end", (data) => {
					if (!engine) return;
					engine.ingest(
						translateSessionEndHook(
							data as {
								sessionId: string;
								messageCount: number;
								durationMs?: number;
							},
						),
					);
				});

				// Message delivery tracking (all messages — success and failure)
				apiOn("message_sent", (data, hookCtx) => {
					if (!engine) return;
					const d = data as {
						to: string;
						content: string;
						success: boolean;
						error?: string;
					};
					engine.ingest(
						translateMessageSentHook(d, {
							channel: (hookCtx as Record<string, unknown>).channel as
								| string
								| undefined,
							sessionId: (hookCtx as Record<string, unknown>).sessionId as
								| string
								| undefined,
						}),
					);
				});

				// Inbound message tracking (fires reliably in all modes)
				apiOn("message_received", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateMessageReceivedHook(
							data as {
								from: string;
								content: string;
								timestamp?: number;
								metadata?: Record<string, unknown>;
							},
							{
								channelId: (hookCtx as Record<string, unknown>).channelId as
									| string
									| undefined,
								accountId: (hookCtx as Record<string, unknown>).accountId as
									| string
									| undefined,
							},
						),
					);
				});

				// Tool start tracking (fires reliably — complements log-bridge tool end)
				apiOn("before_tool_call", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateBeforeToolCallHook(
							data as { toolName: string; params: Record<string, unknown> },
							{
								sessionId: (hookCtx as Record<string, unknown>).sessionId as
									| string
									| undefined,
								agentId: (hookCtx as Record<string, unknown>).agentId as
									| string
									| undefined,
							},
						),
					);
				});

				// Tool result persistence tracking
				apiOn("tool_result_persist", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateToolResultPersistHook(
							data as {
								toolName?: string;
								toolCallId?: string;
								isSynthetic?: boolean;
							},
							{
								sessionKey: (hookCtx as Record<string, unknown>).sessionKey as
									| string
									| undefined,
								agentId: (hookCtx as Record<string, unknown>).agentId as
									| string
									| undefined,
								toolName: (hookCtx as Record<string, unknown>).toolName as
									| string
									| undefined,
							},
						),
					);
				});

				// Compaction lifecycle (before + after)
				apiOn("before_compaction", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateBeforeCompactionHook(
							data as { messageCount: number; tokenCount?: number },
							{
								sessionKey: (hookCtx as Record<string, unknown>).sessionKey as
									| string
									| undefined,
								agentId: (hookCtx as Record<string, unknown>).agentId as
									| string
									| undefined,
							},
						),
					);
				});

				apiOn("after_compaction", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateAfterCompactionHook(
							data as {
								messageCount: number;
								tokenCount?: number;
								compactedCount: number;
							},
							{
								sessionKey: (hookCtx as Record<string, unknown>).sessionKey as
									| string
									| undefined,
								agentId: (hookCtx as Record<string, unknown>).agentId as
									| string
									| undefined,
							},
						),
					);
				});

				// Pre-send message tracking (fires before message_sent)
				apiOn("message_sending", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateMessageSendingHook(
							data as {
								to: string;
								content: string;
								metadata?: Record<string, unknown>;
							},
							{
								channelId: (hookCtx as Record<string, unknown>).channelId as
									| string
									| undefined,
								accountId: (hookCtx as Record<string, unknown>).accountId as
									| string
									| undefined,
							},
						),
					);
				});

				// Gateway lifecycle
				apiOn("gateway_start", (data) => {
					if (!engine) return;
					engine.ingest(translateGatewayStartHook(data as { port: number }));
				});

				apiOn("gateway_stop", (data) => {
					if (!engine) return;
					engine.ingest(translateGatewayStopHook(data as { reason?: string }));
				});

				logger.info(
					`${LOG_PREFIX}: subscribed to 13 plugin hooks (100% coverage: tool, agent, session, gateway, message, compaction)`,
				);
			}

			const targetDesc = target
				? `alerting to ${target.channel}:${target.to}`
				: "log-only (no alert channel detected)";
			logger.info(
				`${LOG_PREFIX}: started, ${targetDesc}, log-bridge active, 7 rules active`,
			);
		},

		stop() {
			closeDashboardConnections();
			if (unsubLogTransport) {
				unsubLogTransport();
				unsubLogTransport = null;
			}
			if (logBridgeCleanup) {
				logBridgeCleanup();
				logBridgeCleanup = null;
			}
			if (unsubDiagnostic) {
				unsubDiagnostic();
				unsubDiagnostic = null;
			}
			if (engine) {
				engine.stop();
				engine = null;
			}
		},
	};
}

const plugin = {
	id: PLUGIN_ID,
	name: "OpenAlerts",
	description: "Alerting & monitoring — texts you when your bot is sick",

	register(api: OpenClawPluginApi) {
		api.registerService(createMonitorService(api));

		for (const cmd of createMonitorCommands(api)) {
			api.registerCommand(cmd);
		}

		// Register dashboard HTTP routes under /openalerts*
		api.registerHttpHandler(createDashboardHandler(() => engine));
	},
};

export default plugin;
