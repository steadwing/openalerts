import type { OpenAlertsEngine, AlertEvent } from "../core/index.js";
import { formatAlertsOutput, formatHealthOutput } from "../core/index.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginCommandDef = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: Record<string, unknown>) => { text: string } | Promise<{ text: string }>;
};

// Engine reference, set when service starts
let _engine: OpenAlertsEngine | null = null;
let _api: OpenClawPluginApi | null = null;

/** Called by service to wire commands to the live engine instance. */
export function bindEngine(engine: OpenAlertsEngine, api: OpenClawPluginApi): void {
  _engine = engine;
  _api = api;
}

/** Create /health, /alerts, and /dashboard command definitions. */
export function createMonitorCommands(api: OpenClawPluginApi): PluginCommandDef[] {
  return [
    {
      name: "health",
      description: "Show system health and monitoring status",
      acceptsArgs: false,
      handler: () => handleHealth(),
    },
    {
      name: "alerts",
      description: "Show recent alerts from OpenAlerts Monitor",
      acceptsArgs: false,
      handler: () => handleAlerts(),
    },
    {
      name: "dashboard",
      description: "Get link to the real-time OpenAlerts monitoring dashboard",
      acceptsArgs: false,
      handler: () => handleDashboard(),
    },
    {
      name: "test_alert",
      description: "Send a test alert to verify alert delivery",
      acceptsArgs: false,
      handler: () => handleTestAlert(),
    },
  ];
}

function handleHealth(): { text: string } {
  if (!_engine) {
    return { text: "OpenAlerts not initialized yet. Wait for gateway startup." };
  }

  const channelActivity = getChannelActivity();

  const recentEvents = _engine.getRecentEvents(50);
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const activeAlerts = recentEvents.filter(
    (e): e is AlertEvent => e.type === "alert" && e.ts >= oneHourAgo,
  );

  return {
    text: formatHealthOutput({
      state: _engine.state,
      channelActivity,
      activeAlerts,
      platformConnected: _engine.platformConnected,
    }),
  };
}

function handleAlerts(): { text: string } {
  if (!_engine) {
    return { text: "OpenAlerts not initialized yet." };
  }

  const events = _engine.getRecentEvents(100);
  return { text: formatAlertsOutput(events) };
}

function handleDashboard(): { text: string } {
  if (!_engine) {
    return { text: "OpenAlerts not initialized yet. Wait for gateway startup." };
  }
  return {
    text: "OpenAlerts Dashboard: http://127.0.0.1:18789/openalerts\n\nOpen in your browser to see real-time events, alerts, and rule status.",
  };
}

function handleTestAlert(): { text: string } {
  if (!_engine) {
    return { text: "OpenAlerts not initialized yet. Wait for gateway startup." };
  }

  _engine.sendTestAlert();

  return {
    text: "Test alert sent. Check your alert channel (Telegram/Discord/etc) for delivery confirmation.\n\nIf you don't receive it, check /health for channel status.",
  };
}

function getChannelActivity(): Array<{ channel: string; lastInbound: number | null }> {
  if (!_api) return [];

  const result: Array<{ channel: string; lastInbound: number | null }> = [];
  const channels = ["telegram", "discord", "slack", "whatsapp", "signal"];

  for (const ch of channels) {
    try {
      const runtime = _api.runtime as Record<string, unknown>;
      const channelMod = runtime.channel as Record<string, unknown> | undefined;
      const activity = channelMod?.activity as Record<string, unknown> | undefined;
      const get = activity?.get as
        | ((params: { channel: string }) => { inboundAt: number | null })
        | undefined;

      if (get) {
        const entry = get({ channel: ch });
        if (entry.inboundAt) {
          result.push({ channel: ch, lastInbound: entry.inboundAt });
        }
      }
    } catch {
      // Channel not configured
    }
  }

  return result;
}
