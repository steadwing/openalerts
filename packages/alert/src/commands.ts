import type { SteadwingEngine } from "@steadwing/core";
import { formatAlertsOutput, formatHealthOutput, type AlertEvent } from "@steadwing/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginCommandDef = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: Record<string, unknown>) => { text: string } | Promise<{ text: string }>;
};

// Engine reference, set when service starts
let _engine: SteadwingEngine | null = null;
let _api: OpenClawPluginApi | null = null;

/** Called by service to wire commands to the live engine instance. */
export function bindEngine(engine: SteadwingEngine, api: OpenClawPluginApi): void {
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
      description: "Show recent alerts from Steadwing Monitor",
      acceptsArgs: false,
      handler: () => handleAlerts(),
    },
    {
      name: "dashboard",
      description: "Get link to the real-time Steadwing monitoring dashboard",
      acceptsArgs: false,
      handler: () => handleDashboard(),
    },
  ];
}

function handleHealth(): { text: string } {
  if (!_engine) {
    return { text: "Steadwing Alert not initialized yet. Wait for gateway startup." };
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
    return { text: "Steadwing Alert not initialized yet." };
  }

  const events = _engine.getRecentEvents(100);
  return { text: formatAlertsOutput(events) };
}

function handleDashboard(): { text: string } {
  if (!_engine) {
    return { text: "Steadwing Alert not initialized yet. Wait for gateway startup." };
  }
  return {
    text: "Steadwing Dashboard: http://127.0.0.1:18789/steadwing\n\nOpen in your browser to see real-time events, alerts, and rule status.",
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
