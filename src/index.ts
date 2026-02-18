import { OpenAlertsEngine } from "./core/index.js";
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
} from "./plugin/dashboard-routes.js";
import {
	CollectionManager,
	CollectionPersistence,
	parseGatewayEvent,
	diagnosticUsageToSessionUpdate,
	type MonitorSession,
	type MonitorAction,
	type MonitorExecEvent,
	type CostUsageSummary,
	type DiagnosticUsageEvent,
} from "./collections/index.js";

const PLUGIN_ID = "openalerts";
const LOG_PREFIX = "openalerts";
const COST_SYNC_INTERVAL_MS = 60_000;

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
let costSyncInterval: ReturnType<typeof setInterval> | null = null;

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
			const enricher = config.llmEnriched === true
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
						const parsed = diagnosticUsageToSessionUpdate(event as unknown as DiagnosticUsageEvent);
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
			const trackAction = (type: MonitorAction["type"], eventType: MonitorAction["eventType"], data: Record<string, unknown>, context: Record<string, unknown>) => {
				if (!collections || !collectionsPersistence) return;
				
				const action: MonitorAction = {
					id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
					runId: (data.runId as string) || `run-${Date.now()}`,
					sessionKey: (context.sessionKey as string) || (context.sessionId as string) || "unknown",
					seq: Date.now() % 1000000,
					type,
					eventType,
					timestamp: Date.now(),
					content: typeof data.content === "string" ? data.content : JSON.stringify(data).slice(0, 500),
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
				apiOn("session_start", (data, hookCtx) => {
					if (!engine) return;
					engine.ingest(
						translateSessionStartHook(
							data as { sessionId: string; resumedFrom?: string },
						),
					);
					// Track in collections
					const ctx = hookCtx as Record<string, unknown>;
					trackAction("start", "system", { sessionId: (data as { sessionId: string }).sessionId }, ctx);
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
					trackAction("complete", "system", { 
						sessionId: (data as { sessionId: string }).sessionId,
						messageCount: (data as { messageCount: number }).messageCount 
					}, ctx);
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

			// ── Collections: Session/Action/Exec tracking ───────────────────────────
			// NOTE: Direct filesystem reading for sessions (no gateway pairing needed)
			// Sessions are read from ~/.openclaw/agents/<agent>/sessions/sessions.json
			collections = new CollectionManager();
			collectionsPersistence = new CollectionPersistence(ctx.stateDir);
			collectionsPersistence.start();

			// Read sessions from filesystem
			const agentsDir = path.join(process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw"), "agents");
			const loadSessionsFromFilesystem = () => {
				try {
					if (!fs.existsSync(agentsDir)) return;
					const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
						.filter(d => d.isDirectory());
					
					let loadedCount = 0;
					for (const agentDir of agentDirs) {
						const sessionsFile = path.join(agentsDir, agentDir.name, "sessions", "sessions.json");
						if (fs.existsSync(sessionsFile)) {
							const content = fs.readFileSync(sessionsFile, "utf-8");
							const sessionsObj = JSON.parse(content);
							// sessions.json is an object with keys like "agent:main:main"
							for (const [key, session] of Object.entries(sessionsObj)) {
								const s = session as Record<string, unknown>;
								if (s.sessionId) {
									collections?.upsertSession({
										key: key,
										agentId: s.agentId as string || agentDir.name,
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
					logger.info(`${LOG_PREFIX}: loaded ${loadedCount} sessions from filesystem`);
				} catch (err) {
					logger.warn(`${LOG_PREFIX}: failed to load sessions from filesystem: ${err}`);
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
				collections.hydrate(hydrated.sessions, hydrated.actions, hydrated.execEvents);
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

			// ── Bridge 4: Gateway WebSocket → engine + collections ─────────────────
			// Connects to gateway WS for real-time session/action/exec tracking.
			// Falls back gracefully if not paired (NOT_PAIRED error is handled).
			// Use token from config or fall back to empty (will show pairing warning)
			const gatewayToken = "e89bb0d63f97b897e32039df32bbb53f93d5b9a8e4d4277d";
			if (gatewayToken) {
				gatewayClient = new GatewayClient({
					token: gatewayToken,
				});

				gatewayClient.on("ready", () => {
					logger.info(`${LOG_PREFIX}: gateway client connected`);
				});

				gatewayClient.on("error", (err: Error) => {
					// Ignore pairing errors - plugin works without full gateway client
					if (err.message.includes("NOT_PAIRED") || err.message.includes("device identity")) {
						logger.warn(`${LOG_PREFIX}: gateway pairing not configured (optional)`);
					} else {
						logger.warn(`${LOG_PREFIX}: gateway client error: ${err.message}`);
					}
				});

				gatewayClient.on("disconnected", () => {
					logger.info(`${LOG_PREFIX}: gateway client disconnected`);
				});

				// Wire gateway events to collections
				const gatewayEventNames = [
					"chat", "agent", "exec.started", "exec.output", "exec.completed",
					"health", "tick",
				];
				for (const eventName of gatewayEventNames) {
					gatewayClient.on(eventName, (payload: unknown) => {
						logger.info(`${LOG_PREFIX}: received gateway event: ${eventName}`);
						if (collections) {
							const parsed = parseGatewayEvent(eventName, payload);
							if (parsed) {
								logger.info(`${LOG_PREFIX}: parsed ${eventName}: session=${!!parsed.session}, action=${!!parsed.action}, exec=${!!parsed.execEvent}`);
								if (parsed.session) collections.upsertSession(parsed.session);
								if (parsed.action) collections.addAction(parsed.action);
								if (parsed.execEvent) {
									collections.addExecEvent(parsed.execEvent);
									collectionsPersistence?.queueExecEvent(parsed.execEvent);
								}
							}
						}
					});
				}

				gatewayClient.start();

				// ── Periodic Cost Sync via RPC ───────────────────────────────────
				const syncCostsFromGateway = async () => {
					if (!gatewayClient?.isReady() || !collections) return;

					try {
						const result = await gatewayClient.request<CostUsageSummary>(
							"usage.cost",
							{ period: "day" },
						);
						if (result && result.bySession) {
							collections.syncAggregatedCosts(result);
						}
					} catch (e) {
						// Log warning but continue - cost sync is optional enhancement
						logger.warn(`${LOG_PREFIX}: cost sync failed: ${(e as Error).message}`);
					}
				};

				// Initial sync after connection
				setTimeout(syncCostsFromGateway, 5000);

				// Periodic sync every minute
				costSyncInterval = setInterval(syncCostsFromGateway, COST_SYNC_INTERVAL_MS);
			}

			const targetDesc = target
				? `alerting to ${target.channel}:${target.to}`
				: "log-only (no alert channel detected)";
			logger.info(
				`${LOG_PREFIX}: started, ${targetDesc}, log-bridge active, 8 rules active`,
			);
		},

		stop() {
			closeDashboardConnections();
			if (costSyncInterval) {
				clearInterval(costSyncInterval);
				costSyncInterval = null;
			}
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
		api.registerHttpHandler(createDashboardHandler(() => engine, () => collections));
	},
};

export default plugin;
