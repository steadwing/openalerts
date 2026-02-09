import { OpenAlertsEngine } from "@steadwing/openalerts-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
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
  translateGatewayStartHook,
  translateGatewayStopHook,
} from "./src/adapter.js";
import { bindEngine, createMonitorCommands } from "./src/commands.js";
import { createDashboardHandler, closeDashboardConnections } from "./src/dashboard-routes.js";

const PLUGIN_ID = "openalerts";
const LOG_PREFIX = "openalerts";

type OpenClawPluginService = {
  id: string;
  start: (ctx: { config: Record<string, unknown>; stateDir: string; logger: PluginLogger }) => Promise<void> | void;
  stop?: () => Promise<void> | void;
};

type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

let engine: OpenAlertsEngine | null = null;
let unsubDiagnostic: (() => void) | null = null;

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
      unsubDiagnostic = onDiagnosticEvent((event: { type: string; [key: string]: unknown }) => {
        const translated = translateOpenClawEvent(event);
        if (translated) {
          engine!.ingest(translated);
        }
      });

      // ── Bridge 2: Plugin hooks → engine ───────────────────────────────────
      // Covers: tool calls, agent lifecycle, session lifecycle, gateway, messages
      // These events are NOT emitted as diagnostic events — they come through
      // the plugin hook system (api.on).

      const apiOn = api.on?.bind(api);
      if (apiOn) {
        // Tool execution tracking
        apiOn("after_tool_call", (data, hookCtx) => {
          if (!engine) return;
          engine.ingest(translateToolCallHook(
            data as { toolName: string; params: Record<string, unknown>; result?: unknown; error?: string; durationMs?: number },
            { sessionId: (hookCtx as Record<string, unknown>).sessionId as string | undefined,
              agentId: (hookCtx as Record<string, unknown>).agentId as string | undefined },
          ));
        });

        // Agent lifecycle
        apiOn("before_agent_start", (data, hookCtx) => {
          if (!engine) return;
          engine.ingest(translateAgentStartHook(
            data as { prompt: string; messages?: unknown[] },
            { sessionId: (hookCtx as Record<string, unknown>).sessionId as string | undefined,
              agentId: (hookCtx as Record<string, unknown>).agentId as string | undefined },
          ));
        });

        apiOn("agent_end", (data, hookCtx) => {
          if (!engine) return;
          engine.ingest(translateAgentEndHook(
            data as { messages: unknown[]; success: boolean; error?: string; durationMs?: number },
            { sessionId: (hookCtx as Record<string, unknown>).sessionId as string | undefined,
              agentId: (hookCtx as Record<string, unknown>).agentId as string | undefined },
          ));
        });

        // Session lifecycle
        apiOn("session_start", (data) => {
          if (!engine) return;
          engine.ingest(translateSessionStartHook(
            data as { sessionId: string; resumedFrom?: string },
          ));
        });

        apiOn("session_end", (data) => {
          if (!engine) return;
          engine.ingest(translateSessionEndHook(
            data as { sessionId: string; messageCount: number; durationMs?: number },
          ));
        });

        // Message delivery tracking (all messages — success and failure)
        apiOn("message_sent", (data, hookCtx) => {
          if (!engine) return;
          const d = data as { to: string; content: string; success: boolean; error?: string };
          engine.ingest(translateMessageSentHook(d, {
            channel: (hookCtx as Record<string, unknown>).channel as string | undefined,
            sessionId: (hookCtx as Record<string, unknown>).sessionId as string | undefined,
          }));
        });

        // Gateway lifecycle
        apiOn("gateway_start", (data) => {
          if (!engine) return;
          engine.ingest(translateGatewayStartHook(
            data as { port: number },
          ));
        });

        apiOn("gateway_stop", (data) => {
          if (!engine) return;
          engine.ingest(translateGatewayStopHook(
            data as { reason?: string },
          ));
        });

        logger.info(`${LOG_PREFIX}: subscribed to 7 plugin hooks (tool, agent, session, gateway, message)`);
      }

      const targetDesc = target
        ? `alerting to ${target.channel}:${target.to}`
        : "log-only (no alert channel detected)";
      logger.info(`${LOG_PREFIX}: started, ${targetDesc}, 7 rules active`);
    },

    stop() {
      closeDashboardConnections();
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
