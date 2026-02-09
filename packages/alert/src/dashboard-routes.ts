import type { IncomingMessage, ServerResponse } from "node:http";
import type { SteadwingEngine, SteadwingEvent, AlertEvent } from "@steadwing/core";
import { getDashboardHtml } from "./dashboard-html.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
type SSEConnection = { res: ServerResponse; unsub: () => void; heartbeat: ReturnType<typeof setInterval> };

// ─── SSE connection tracking ─────────────────────────────────────────────────

const sseConnections = new Set<SSEConnection>();

/** Close all active SSE connections. Call on engine stop. */
export function closeDashboardConnections(): void {
  for (const conn of sseConnections) {
    clearInterval(conn.heartbeat);
    conn.unsub();
    try { conn.res.end(); } catch { /* already closed */ }
  }
  sseConnections.clear();
}

// ─── Simulate scenarios ──────────────────────────────────────────────────────

function buildSimulateEvent(key: string): SteadwingEvent | null {
  const ts = Date.now();
  const scenarios: Record<string, SteadwingEvent> = {
    // Success scenarios
    heartbeat_ok: {
      type: "infra.heartbeat",
      ts,
      outcome: "success",
      queueDepth: Math.floor(Math.random() * 3),
      meta: { source: "simulate" },
    },
    llm_success: {
      type: "llm.call",
      ts,
      outcome: "success",
      durationMs: 500 + Math.floor(Math.random() * 3000),
      tokenCount: 200 + Math.floor(Math.random() * 2000),
      channel: "telegram",
      meta: { source: "simulate" },
    },
    tool_success: {
      type: "tool.call",
      ts,
      outcome: "success",
      durationMs: 50 + Math.floor(Math.random() * 500),
      meta: { toolName: ["web_search", "read_file", "write_file", "bash"][Math.floor(Math.random() * 4)], source: "simulate" },
    },
    agent_start: {
      type: "agent.start",
      ts,
      outcome: "success",
      agentId: "agent-" + Math.random().toString(36).slice(2, 8),
      meta: { source: "simulate" },
    },
    agent_end: {
      type: "agent.end",
      ts,
      outcome: "success",
      durationMs: 2000 + Math.floor(Math.random() * 10000),
      tokenCount: 500 + Math.floor(Math.random() * 5000),
      agentId: "agent-" + Math.random().toString(36).slice(2, 8),
      meta: { source: "simulate" },
    },

    // Error scenarios (trigger alert rules)
    webhook_error: {
      type: "infra.error",
      ts,
      outcome: "error",
      error: "HTTP 502 Bad Gateway on telegram webhook",
      channel: "telegram",
      meta: { source: "simulate" },
    },
    llm_failure: {
      type: "llm.call",
      ts,
      outcome: "error",
      error: "Provider returned 429 Too Many Requests",
      durationMs: 100 + Math.floor(Math.random() * 500),
      channel: "telegram",
      meta: { source: "simulate" },
    },
    session_stuck: {
      type: "session.stuck",
      ts,
      outcome: "error",
      ageMs: 180_000,
      sessionKey: "sess-" + Math.random().toString(36).slice(2, 8),
      meta: { source: "simulate" },
    },
    heartbeat_fail: {
      type: "infra.heartbeat",
      ts,
      outcome: "error",
      error: "Gateway health check failed",
      meta: { source: "simulate" },
    },
    tool_error: {
      type: "tool.error",
      ts,
      outcome: "error",
      error: "Command exited with code 1",
      durationMs: 30_000,
      meta: { toolName: "bash", source: "simulate" },
    },
    queue_spike: {
      type: "infra.queue_depth",
      ts,
      outcome: "success",
      queueDepth: 15,
      meta: { source: "simulate" },
    },
  };

  return scenarios[key] ?? null;
}

// ─── Rule status helper ──────────────────────────────────────────────────────

const RULE_IDS = [
  "infra-errors",
  "llm-errors",
  "session-stuck",
  "heartbeat-fail",
  "queue-depth",
  "high-error-rate",
  "gateway-down",
];

function getRuleStatuses(engine: SteadwingEngine): Array<{ id: string; status: "ok" | "fired" }> {
  const state = engine.state;
  const now = Date.now();
  return RULE_IDS.map(id => {
    // A rule is "fired" if it's on cooldown (meaning it fired recently)
    const cooldownTs = state.cooldowns.get(id);
    const fired = cooldownTs != null && cooldownTs > now - 15 * 60 * 1000;
    return { id, status: fired ? "fired" as const : "ok" as const };
  });
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

/**
 * Create a middleware-style HTTP handler for all /steadwing* routes.
 * Returns `true` if the request was handled, `false` to pass through.
 */
export function createDashboardHandler(getEngine: () => SteadwingEngine | null): HttpHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url ?? "";

    // Only handle /steadwing prefix
    if (!url.startsWith("/steadwing")) return false;

    const engine = getEngine();

    // ── GET /steadwing → Dashboard HTML ──────────────────────
    if ((url === "/steadwing" || url === "/steadwing/") && req.method === "GET") {
      if (!engine) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Steadwing engine not running.");
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(getDashboardHtml());
      return true;
    }

    // ── GET /steadwing/events → SSE stream ───────────────────
    if (url === "/steadwing/events" && req.method === "GET") {
      if (!engine) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Engine not running.");
        return true;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();

      // Subscribe to all engine events
      const unsub = engine.bus.on((event: SteadwingEvent) => {
        try {
          res.write(`event: steadwing\ndata: ${JSON.stringify(event)}\n\n`);
        } catch { /* connection closed */ }
      });

      // Heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        try { res.write(":heartbeat\n\n"); } catch { /* closed */ }
      }, 15_000);

      const conn: SSEConnection = { res, unsub, heartbeat };
      sseConnections.add(conn);

      // Clean up on close
      req.on("close", () => {
        clearInterval(heartbeat);
        unsub();
        sseConnections.delete(conn);
      });

      return true;
    }

    // ── GET /steadwing/state → JSON snapshot ─────────────────
    if (url === "/steadwing/state" && req.method === "GET") {
      if (!engine) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Engine not running" }));
        return true;
      }

      const state = engine.state;
      const recentAlerts = engine.getRecentEvents(50).filter(
        (e): e is AlertEvent => e.type === "alert",
      );

      const body = JSON.stringify({
        uptimeMs: Date.now() - state.startedAt,
        stats: state.stats,
        busListeners: engine.bus.size,
        platformConnected: engine.platformConnected,
        recentAlerts: recentAlerts.slice(0, 20),
        rules: getRuleStatuses(engine),
        cooldowns: Object.fromEntries(state.cooldowns),
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
      return true;
    }

    // ── POST /steadwing/simulate → Inject test event ─────────
    if (url === "/steadwing/simulate" && req.method === "POST") {
      if (!engine) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Engine not running" }));
        return true;
      }

      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const bodyStr = Buffer.concat(chunks).toString("utf-8");

      let scenario: string;
      try {
        const parsed = JSON.parse(bodyStr);
        scenario = parsed.scenario;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return true;
      }

      const event = buildSimulateEvent(scenario);
      if (!event) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown scenario: " + scenario }));
        return true;
      }

      engine.ingest(event);

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ ok: true, type: event.type, outcome: event.outcome }));
      return true;
    }

    // ── CORS preflight for simulate ──────────────────────────
    if (url === "/steadwing/simulate" && req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return true;
    }

    // Unknown /steadwing sub-route
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return true;
  };
}
