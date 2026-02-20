/** Escape HTML to prevent XSS. */
export function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** Get event category from event type string. */
export function cat(t: string | undefined): string {
  if (!t) return "custom";
  const p = t.split(".")[0];
  return ["llm", "tool", "agent", "token", "step"].includes(p) ? p : "custom";
}

/** Format Unix timestamp (seconds) as HH:MM:SS. */
export function fT(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Format duration in milliseconds to human-readable string. */
export function fD(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

/** Format uptime in milliseconds. */
export function fU(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? h + "h " + (m % 60) + "m" : m + "m " + (s % 60) + "s";
}

/** Format timestamp as relative "ago" string. */
export function fAgo(ts: number | undefined): string {
  if (!ts) return "never";
  let d = Date.now() / 1000 - ts;
  if (d < 0) d = 0;
  if (d < 1) return "just now";
  if (d < 60) return Math.floor(d) + "s ago";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  return Math.floor(d / 3600) + "h ago";
}

/** Event type → [icon, label] mapping. */
const EVT_LABELS: Record<string, [string, string]> = {
  "llm.call": ["\u{1F916}", "LLM Called"],
  "llm.error": ["\u26A0", "LLM Failed"],
  "llm.token_usage": ["\u{1F4CA}", "Token Usage"],
  "tool.call": ["\u{1F527}", "Tool Executed"],
  "tool.error": ["\u{1F527}", "Tool Failed"],
  "agent.start": ["\u25B6", "Agent Started"],
  "agent.end": ["\u23F9", "Agent Finished"],
  "agent.error": ["\u{1F6A8}", "Agent Error"],
  "agent.stuck": ["\u23F3", "Agent Stuck"],
  "agent.step": ["\u{1F463}", "Agent Step"],
  "token.limit_exceeded": ["\u{1F6AB}", "Token Limit"],
  "step.limit_warning": ["\u26A0", "Step Limit"],
  custom: ["\u2022", "Custom"],
};

/** Get friendly label for an event type. */
export function friendlyLabel(t: string): [string, string] {
  return EVT_LABELS[t] || ["\u2022", t];
}

/** Shorthand for getElementById. */
export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}
