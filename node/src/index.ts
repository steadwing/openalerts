import { ALL_RULES, OpenAlertsEngine } from "./core/index.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";
import { createLogBridge } from "./plugin/log-bridge.js";
import { GatewayClient } from "./plugin/gateway-client.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	OpenClawAlertChannel,
	createOpenClawEnricher,
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
} from "./plugin/adapter.js";
import { bindEngine, createMonitorCommands } from "./plugin/commands.js";
import {
	createDashboardHandler,
	closeDashboardConnections,
	emitAgentMonitorEvent,
	recordGatewayEvent,
} from "./plugin/dashboard-routes.js";
import {
	CollectionManager,
	CollectionPersistence,
	parseGatewayEvent,
	diagnosticUsageToSessionUpdate,
	type MonitorSession,
	type MonitorAction,
	type MonitorExecEvent,
	type DiagnosticUsageEvent,
} from "./collections/index.js";

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
let gatewayClient: GatewayClient | null = null;
let collections: CollectionManager | null = null;
let collectionsPersistence: CollectionPersistence | null = null;
let sessionSyncInterval: ReturnType<typeof setInterval> | null = null;

function createMonitorService(api: OpenClawPluginApi): OpenClawPluginService {
	return {
		id: PLUGIN_ID,

		async start(ctx) {
			const logger = ctx.logger;
			const config = parseConfig(api.pluginConfig);

			// Resolve alert target + create OpenClaw alert channel
			const target = await resolveAlertTarget(api, config);
			const channels = target ? [new OpenClawAlertChannel(api, target)] : [];

			// Create LLM enricher if enabled (default: false)
			const enricher =
				config.llmEnriched === true
					? createOpenClawEnricher(api, logger)
					: null;

			// Create and start the universal engine
			engine = new OpenAlertsEngine({
				stateDir: ctx.stateDir,
				config,
				channels,
				logger,
				logPrefix: LOG_PREFIX,
				diagnosisHint: 'Run "openclaw doctor" to diagnose.',
				enricher: enricher ?? undefined,
			});

			engine.start();

			// Wire commands to engine
			bindEngine(engine, api);

			// ── Bridge 1: Diagnostic events → engine + collections ───────────────────
			// Covers: webhook.*, message.*, session.stuck, session.state,
			//         model.usage, queue.lane.*, diagnostic.heartbeat, run.attempt
			unsubDiagnostic = onDiagnosticEvent(
				(event: { type: string; [key: string]: unknown }) => {
					const translated = translateOpenClawEvent(event);
					if (translated) {
						engine!.ingest(translated);
					}

					// Feed model.usage to collections for cost tracking
					if (event.type === "model.usage" && collections) {
						const parsed = diagnosticUsageToSessionUpdate(
							event as unknown as DiagnosticUsageEvent,
						);
						if (parsed.session) {
							collections.upsertSession(parsed.session);
						}
						if (parsed.action && collectionsPersistence) {
							collections.addAction(parsed.action);
							collectionsPersistence.queueAction(parsed.action);
						}
					}
				},
			);

			// ── Bridge 2: Log transport → engine (fills gaps from non-firing hooks) ─
			// Parses structured log records to synthesize tool.call, session.start/end,
			// and run duration events that hooks don't provide in long-polling mode.
			const logBridge = createLogBridge(engine);
			unsubLogTransport = registerLogTransport(logBridge.transport);
			logBridgeCleanup = logBridge.cleanup;

			// Helper to track actions in collections (for sessions, tools, messages)
			const trackAction = (
				type: MonitorAction["type"],
				eventType: MonitorAction["eventType"],
				data: Record<string, unknown>,
				context: Record<string, unknown>,
			) => {
				if (!collections || !collectionsPersistence) return;

				const action: MonitorAction = {
					id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
					runId: (data.runId as string) || `run-${Date.now()}`,
					sessionKey:
						(context.sessionKey as string) ||
						(context.sessionId as string) ||
						"unknown",
					seq: Date.now() % 1000000,
					type,
					eventType,
					timestamp: Date.now(),
					content:
						typeof data.content === "string"
							? data.content
							: JSON.stringify(data).slice(0, 500),
				};
				collections.addAction(action);
				collectionsPersistence.queueAction(action);
			};

			// ── Bridge 3: Plugin hooks → engine ───────────────────────────────────
			// Covers: tool calls, agent lifecycle, session lifecycle, gateway, messages
			// These events are NOT emitted as diagnostic events — they come through
			// the plugin hook system (api.on).

			const apiOn = api.on?.bind(api);
			if (apiOn) {
				// Tool execution tracking
				apiOn("after_tool_call", (data, hookCtx) => {
					if (!engine) return;
					const d = data as {
						toolName: string;
						params: Record<string, unknown>;
						result?: unknown;
						error?: string;
						durationMs?: number;
					};
					const ctx = hookCtx as Record<string, unknown>;
					const sessionId =
						(ctx.sessionKey as string) ||
						(ctx.sessionId as string) ||
						undefined;
					const agentId = ctx.agentId as string | undefined;
					const runId = ctx.runId as string | undefined;
					engine.ingest(translateToolCallHook(d, { sessionId, agentId }));
					const _toolKey =
						sessionId && isRealSessionKey(sessionId)
							? sessionId
							: runSessionMap.get(runId || "");
					const _toolParamSummary = d.params
						? JSON.stringify(d.params).slice(0, 200)
						: undefined;
					const _toolResultSummary = d.result
						? JSON.stringify(d.result).slice(0, 300)
						: undefined;
					if (_toolKey)
						emitAgentMonitorEvent({
							type: "agent",
							data: {
								ts: Date.now(),
								type: "agent",
								sessionKey: _toolKey,
								runId: runId || `tool-${Date.now()}`,
								data: {
									phase: "tool",
									toolName: d.toolName,
									durationMs: d.durationMs,
									error: d.error,
									params: _toolParamSummary,
									result: _toolResultSummary,
								},
							},
						});
				});

				// Agent lifecycle
				apiOn("before_agent_start", (data, hookCtx) => {
					if (!engine) return;
					const ctx = hookCtx as Record<string, unknown>;
					const sessionId =
						(ctx.sessionKey as string) ||
						(ctx.sessionId as string) ||
						undefined;
					const agentId = ctx.agentId as string | undefined;
					const runId = ctx.runId as string | undefined;
					engine.ingest(
						translateAgentStartHook(
							data as { prompt: string; messages?: unknown[] },
							{ sessionId, agentId },
						),
					);
					const _startKey =
						sessionId && isRealSessionKey(sessionId)
							? sessionId
							: runSessionMap.get(runId || "");
					const _msgs = (data as { messages?: unknown[] }).messages;
					const _lastUMsg = Array.isArray(_msgs)
						? (_msgs as Array<Record<string, unknown>>)
								.filter((m) => m.role === "user")
								.pop()
						: null;
					const _startCtx = _lastUMsg
						? (typeof _lastUMsg.content === "string"
								? _lastUMsg.content
								: JSON.stringify(_lastUMsg.content)
							).slice(0, 300)
						: undefined;
					if (_startKey) {
						runSessionMap.set(runId || "", _startKey);
						emitAgentMonitorEvent({
							type: "agent",
							data: {
								ts: Date.now(),
								type: "agent",
								sessionKey: _startKey,
								runId: runId || `run-${Date.now()}`,
								data: { phase: "start", agentId, content: _startCtx },
							},
						});
					}
				});

				apiOn("agent_end", (data, hookCtx) => {
					if (!engine) return;
					const d = data as {
						messages: unknown[];
						success: boolean;
						error?: string;
						durationMs?: number;
					};
					const ctx = hookCtx as Record<string, unknown>;
					const sessionId =
						(ctx.sessionKey as string) ||
						(ctx.sessionId as string) ||
						undefined;
					const agentId = ctx.agentId as string | undefined;
					const runId = ctx.runId as string | undefined;
					engine.ingest(translateAgentEndHook(d, { sessionId, agentId }));
					const _endKey =
						sessionId && isRealSessionKey(sessionId)
							? sessionId
							: runSessionMap.get(runId || "");
					if (_endKey)
						emitAgentMonitorEvent({
							type: "agent",
							data: {
								ts: Date.now(),
								type: "agent",
								sessionKey: _endKey,
								runId: runId || `run-${Date.now()}`,
								data: {
									phase: "end",
									durationMs: d.durationMs,
									success: d.success,
									error: d.error,
								},
							},
						});
				});

				// Session lifecycle
				apiOn("session_start", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateSessionStartHook(
							data as { sessionId: string; resumedFrom?: string },
						),
					);
					// Track in collections
					const ctx = hookCtx as Record<string, unknown>;
					trackAction(
						"start",
						"system",
						{ sessionId: (data as { sessionId: string }).sessionId },
						ctx,
					);
				});

				apiOn("session_end", (data, hookCtx) => {
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
					// Track in collections
					const ctx = hookCtx as Record<string, unknown>;
					trackAction(
						"complete",
						"system",
						{
							sessionId: (data as { sessionId: string }).sessionId,
							messageCount: (data as { messageCount: number }).messageCount,
						},
						ctx,
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
				// Inbound message tracking (fires reliably in all modes)
				apiOn("message_received", (data, hookCtx) => {
					if (!engine) return;
					const d = data as {
						from: string;
						content: string;
						timestamp?: number;
						metadata?: Record<string, unknown>;
					};
					const ctx = hookCtx as Record<string, unknown>;
					const channelId = ctx.channelId as string | undefined;
					const accountId = ctx.accountId as string | undefined;
					engine.ingest(
						translateMessageReceivedHook(d, { channelId, accountId }),
					);
					// Emit inbound message to agent monitor live view
					const _inboundKey = channelId || "unknown";
					// Register channelId as a known session so subsequent agent events can link to it
					if (_inboundKey !== "unknown" && isRealSessionKey(_inboundKey)) {
						// Will be linked by runId once agent starts
					}
					emitAgentMonitorEvent({
						type: "chat",
						data: {
							ts: d.timestamp || Date.now(),
							type: "chat",
							sessionKey: _inboundKey,
							runId: "inbound",
							data: {
								state: "inbound",
								content: d.content,
								from: d.from,
								isInbound: true,
							},
						},
					});
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
					const _sendCtx = hookCtx as Record<string, unknown>;
					const _sendChannelId = _sendCtx.channelId as string | undefined;
					const _sendData = data as {
						to: string;
						content: string;
						metadata?: Record<string, unknown>;
					};
					if (_sendChannelId) {
						emitAgentMonitorEvent({
							type: "chat",
							data: {
								ts: Date.now(),
								type: "chat",
								sessionKey: _sendChannelId,
								runId: "outbound",
								data: {
									state: "outbound",
									content: _sendData.content,
									to: _sendData.to,
								},
							},
						});
					}
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

			// ── Collections: Session/Action/Exec tracking ───────────────────────────
			// NOTE: Direct filesystem reading for sessions (no gateway pairing needed)
			// Sessions are read from ~/.openclaw/agents/<agent>/sessions/sessions.json
			collections = new CollectionManager();
			collectionsPersistence = new CollectionPersistence(ctx.stateDir);
			collectionsPersistence.start();

			// Read sessions from filesystem
			const agentsDir = path.join(
				process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw"),
				"agents",
			);
			const loadSessionsFromFilesystem = () => {
				try {
					if (!fs.existsSync(agentsDir)) return;
					const agentDirs = fs
						.readdirSync(agentsDir, { withFileTypes: true })
						.filter((d) => d.isDirectory());

					let loadedCount = 0;
					for (const agentDir of agentDirs) {
						const sessionsFile = path.join(
							agentsDir,
							agentDir.name,
							"sessions",
							"sessions.json",
						);
						if (fs.existsSync(sessionsFile)) {
							const content = fs.readFileSync(sessionsFile, "utf-8");
							const sessionsObj = JSON.parse(content);
							// sessions.json is an object with keys like "agent:main:main"
							for (const [key, session] of Object.entries(sessionsObj)) {
								const s = session as Record<string, unknown>;
								if (s.sessionId) {
									collections?.upsertSession({
										key: key,
										agentId: (s.agentId as string) || agentDir.name,
										platform: (s.platform as string) || "unknown",
										recipient: (s.recipient as string) || "",
										isGroup: (s.isGroup as boolean) || false,
										lastActivityAt: (s.updatedAt as number) || Date.now(),
										status: "idle" as const,
										messageCount: s.messageCount as number,
									});
									loadedCount++;
								}
							}
						}
					}
					logger.info(
						`${LOG_PREFIX}: loaded ${loadedCount} sessions from filesystem`,
					);
				} catch (err) {
					logger.warn(
						`${LOG_PREFIX}: failed to load sessions from filesystem: ${err}`,
					);
				}
			};
			loadSessionsFromFilesystem();

			// Persist sessions immediately after loading
			if (collections && collectionsPersistence) {
				collectionsPersistence.saveSessions(collections.getSessions());
			}

			// Persist sessions periodically
			sessionSyncInterval = setInterval(() => {
				if (collections && collectionsPersistence) {
					collectionsPersistence.saveSessions(collections.getSessions());
				}
			}, 30000);

			// Hydrate from persisted data
			const hydrated = collectionsPersistence.hydrate();
			if (hydrated.sessions.length > 0 || hydrated.actions.length > 0) {
				collections.hydrate(
					hydrated.sessions,
					hydrated.actions,
					hydrated.execEvents,
				);
				logger.info(
					`${LOG_PREFIX}: hydrated ${hydrated.sessions.length} sessions, ${hydrated.actions.length} actions, ${hydrated.execEvents.length} exec events`,
				);
			}

			// Wire collection changes to persistence
			collections.setCallbacks({
				onSessionChange: (session: MonitorSession) => {
					if (collections && collectionsPersistence) {
						collectionsPersistence.saveSessions(collections.getSessions());
					}
				},
				onActionChange: (action: MonitorAction) => {
					collectionsPersistence?.queueAction(action);
				},
				onExecChange: (exec) => {
					// Exec changes tracked via hooks
				},
			});

			// ── runId → real session key map ─────────────────────────────────
			// Chat events always carry the real sessionKey (agent:agentId:platform:recipient).
			// Agent events often omit it, falling back to stream name ("assistant", "lifecycle").
			// We build this map from chat events and use it to normalize agent events.
			const runSessionMap = new Map<string, string>();
			const isRealSessionKey = (k: string) =>
				k.split(":")[0] === "agent" && k.split(":").length >= 3;

			// ── Bridge 4: Gateway WebSocket → engine + collections ─────────────────
			// Connects to gateway WS for real-time session/action/exec tracking.
			// Falls back gracefully if not paired (NOT_PAIRED error is handled).
			// Use token from config or fall back to empty (will show pairing warning)
			// Bug 4 fix: read token from config instead of hardcoding
			const _gatewayCfg = (api.config as Record<string, unknown>).gateway as
				| Record<string, unknown>
				| undefined;
			const _gatewayAuth = _gatewayCfg?.auth as
				| Record<string, unknown>
				| undefined;
			const gatewayToken = (_gatewayAuth?.token as string) || "";
			if (gatewayToken) {
				gatewayClient = new GatewayClient({
					token: gatewayToken,
				});

				gatewayClient.on("ready", () => {
					logger.info(`${LOG_PREFIX}: gateway client connected`);
				});

				gatewayClient.on("error", (err: Error) => {
					// Ignore pairing errors - plugin works without full gateway client
					if (
						err.message.includes("NOT_PAIRED") ||
						err.message.includes("device identity")
					) {
						logger.warn(
							`${LOG_PREFIX}: gateway pairing not configured (optional)`,
						);
					} else {
						logger.warn(`${LOG_PREFIX}: gateway client error: ${err.message}`);
					}
				});

				gatewayClient.on("disconnected", () => {
					logger.info(`${LOG_PREFIX}: gateway client disconnected`);
				});

				// Wire gateway events to collections
				const gatewayEventNames = ["chat", "agent", "health", "tick"];
				for (const eventName of gatewayEventNames) {
					gatewayClient.on(eventName, (payload: unknown) => {
						// Record for test endpoint
						recordGatewayEvent(eventName, payload);

						if (collections) {
							const parsed = parseGatewayEvent(eventName, payload);
							if (parsed) {
								if (parsed.session) collections.upsertSession(parsed.session);
								if (parsed.action) {
									// Register real keys in runSessionMap
									if (
										parsed.action.sessionKey &&
										!parsed.action.sessionKey.includes("lifecycle") &&
										isRealSessionKey(parsed.action.sessionKey)
									) {
										runSessionMap.set(
											parsed.action.runId,
											parsed.action.sessionKey,
										);
									}
									// Route to real key via runId; fall back to original key — never filter (frontend handles grouping)
									const realKey = isRealSessionKey(parsed.action.sessionKey)
										? parsed.action.sessionKey
										: runSessionMap.get(parsed.action.runId) ||
											parsed.action.sessionKey;
									collections.addAction(parsed.action);
									// Forward parsed WS actions to the live agent monitor SSE stream
									const action = parsed.action;
									const sseType =
										action.eventType === "chat" ? "chat" : "agent";
									const sseData: Record<string, unknown> = {
										ts: action.timestamp,
										sessionKey: realKey,
										runId: action.runId,
									};
									if (action.eventType === "chat") {
										const state =
											action.type === "complete"
												? "final"
												: action.type === "streaming"
													? "delta"
													: action.type === "error"
														? "error"
														: "final";
										sseData.data = {
											state,
											content: action.content,
											inputTokens: action.inputTokens,
											outputTokens: action.outputTokens,
											stopReason: action.stopReason,
										};
									} else {
										const phase =
											action.type === "start"
												? "start"
												: action.type === "complete"
													? "end"
													: action.type === "error"
														? "error"
														: action.type === "tool_call"
															? "tool"
															: action.type === "streaming"
																? "streaming"
																: action.type;
										sseData.data = {
											phase,
											content: action.content,
											toolName: action.toolName,
											toolArgs: action.toolArgs,
											durationMs:
												action.endedAt && action.startedAt
													? action.endedAt - action.startedAt
													: undefined,
										};
									}
									emitAgentMonitorEvent({ type: sseType, data: sseData });
								}
								if (parsed.execEvent) {
									collections.addExecEvent(parsed.execEvent);
									collectionsPersistence?.queueExecEvent(parsed.execEvent);
								}
							}
						}
					});
				}

				gatewayClient.start();
				// Bug 1 fix: cost sync via usage.cost RPC removed
				// Gateway denies operator.read scope; cost flows via model.usage diagnostic events
			}

			const targetDesc = target
				? `alerting to ${target.channel}:${target.to}`
				: "log-only (no alert channel detected)";
			logger.info(
				`${LOG_PREFIX}: started, ${targetDesc}, log-bridge active, ${ALL_RULES.length} rules active`,
			);
		},

		stop() {
			closeDashboardConnections();
			if (sessionSyncInterval) {
				clearInterval(sessionSyncInterval);
				sessionSyncInterval = null;
			}
			if (gatewayClient) {
				gatewayClient.stop();
				gatewayClient = null;
			}
			if (collectionsPersistence) {
				collectionsPersistence.stop();
				collectionsPersistence = null;
			}
			if (collections) {
				collections.clear();
				collections = null;
			}
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
		api.registerHttpHandler(
			createDashboardHandler(
				() => engine,
				() => collections,
			),
		);
	},
};

export default plugin;
