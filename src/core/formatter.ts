import type { AlertEvent, EvaluatorState, StoredEvent } from "./types.js";

// ─── Alert Messages (sent to user's channel) ────────────────────────────────

export function formatAlertMessage(alert: AlertEvent, opts?: { diagnosisHint?: string }): string {
  const prefix =
    alert.severity === "critical"
      ? "[OpenAlerts] CRITICAL: "
      : "[OpenAlerts] ";

  const lines = [prefix + alert.title, "", alert.detail, "", "/health for full status."];

  if (alert.severity === "critical" && opts?.diagnosisHint) {
    lines[lines.length - 1] = opts.diagnosisHint;
  }

  return lines.join("\n");
}

// ─── /health Command Output ──────────────────────────────────────────────────

export function formatHealthOutput(opts: {
  state: EvaluatorState;
  channelActivity: Array<{ channel: string; lastInbound: number | null }>;
  activeAlerts: AlertEvent[];
  platformConnected: boolean;
}): string {
  const { state, channelActivity, activeAlerts, platformConnected } = opts;

  const uptime = formatDuration(Date.now() - state.startedAt);
  const heartbeatAgo = state.lastHeartbeatTs > 0
    ? `${formatDuration(Date.now() - state.lastHeartbeatTs)} ago`
    : "none yet";

  const status = activeAlerts.length > 0 ? "DEGRADED" : "OK";

  const lines: string[] = [
    "System Health -- OpenAlerts",
    "",
    `Status: ${status}`,
    `Uptime: ${uptime} | Last heartbeat: ${heartbeatAgo}`,
  ];

  // Active alerts
  if (activeAlerts.length > 0) {
    lines.push("");
    lines.push(`!! ${activeAlerts.length} active alert${activeAlerts.length > 1 ? "s" : ""}:`);
    for (const a of activeAlerts.slice(0, 5)) {
      const ago = formatDuration(Date.now() - a.ts);
      lines.push(`  [${a.severity.toUpperCase()}] ${a.title} (${ago} ago)`);
    }
  }

  // Channel activity
  if (channelActivity.length > 0) {
    lines.push("");
    lines.push("Channels:");
    for (const ch of channelActivity) {
      const ago = ch.lastInbound
        ? `active (${formatDuration(Date.now() - ch.lastInbound)} ago)`
        : "no activity";
      lines.push(`  ${ch.channel.padEnd(10)}: ${ago}`);
    }
  }

  // 24h stats
  lines.push("");
  const s = state.stats;
  const rcvd = s.messagesReceived > 0 ? `, ${s.messagesReceived} received` : "";
  lines.push(
    `24h: ${s.messagesProcessed} msgs processed${rcvd}, ${s.messageErrors} errors, ${s.stuckSessions} stuck`,
  );
  if (s.toolCalls > 0 || s.agentStarts > 0 || s.sessionsStarted > 0) {
    const parts: string[] = [];
    if (s.toolCalls > 0) parts.push(`${s.toolCalls} tools${s.toolErrors > 0 ? ` (${s.toolErrors} err)` : ""}`);
    if (s.agentStarts > 0) parts.push(`${s.agentStarts} agents${s.agentErrors > 0 ? ` (${s.agentErrors} err)` : ""}`);
    if (s.sessionsStarted > 0) parts.push(`${s.sessionsStarted} sessions`);
    if (s.compactions > 0) parts.push(`${s.compactions} compactions`);
    lines.push(`     ${parts.join(", ")}`);
  }
  if (s.totalTokens > 0) {
    const tokenStr = s.totalTokens >= 1000 ? `${(s.totalTokens / 1000).toFixed(1)}k` : `${s.totalTokens}`;
    const costStr = s.totalCostUsd > 0 ? ` ($${s.totalCostUsd.toFixed(4)})` : "";
    lines.push(`     ${tokenStr} tokens${costStr}`);
  }

  // Platform
  lines.push("");
  lines.push(
    platformConnected
      ? "Platform: connected (openalerts.dev)"
      : "Platform: not connected (add apiKey for diagnosis)",
  );

  return lines.join("\n");
}

// ─── /alerts Command Output ──────────────────────────────────────────────────

export function formatAlertsOutput(events: StoredEvent[]): string {
  const alerts = events.filter(
    (e): e is AlertEvent => e.type === "alert",
  );

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = alerts.filter((a) => a.ts >= cutoff);

  if (recent.length === 0) {
    return [
      "Recent Alerts",
      "",
      "No alerts in the last 24h. All systems normal.",
    ].join("\n");
  }

  const lines: string[] = [
    `Recent Alerts (${recent.length} in 24h)`,
    "",
  ];

  // Show most recent first, cap at 10
  const shown = recent.slice(-10).reverse();
  for (const alert of shown) {
    const time = new Date(alert.ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    lines.push(`[${alert.severity.toUpperCase()}] ${time} -- ${alert.title}`);
    lines.push(`  ${alert.detail}`);
    lines.push("");
  }

  if (recent.length > 10) {
    lines.push(`Showing 10 of ${recent.length} alerts.`);
  }

  return lines.join("\n").trimEnd();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  if (hr < 24) return remainMin > 0 ? `${hr}h ${remainMin}m` : `${hr}h`;
  const days = Math.floor(hr / 24);
  const remainHr = hr % 24;
  return remainHr > 0 ? `${days}d ${remainHr}h` : `${days}d`;
}
