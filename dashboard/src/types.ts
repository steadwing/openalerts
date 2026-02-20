/** Event types matching Python's OpenAlertsEvent model. */
export interface OpenAlertsEvent {
  type: string;
  ts: number;
  severity?: string;
  agent_name?: string | null;
  agent_class?: string | null;
  tool_name?: string | null;
  duration_ms?: number | null;
  token_count?: number | null;
  error?: string | null;
  outcome?: string | null;
  step_number?: number | null;
  max_steps?: number | null;
  meta?: Record<string, unknown> | null;
}

/** Alert event matching Python's AlertEvent model. */
export interface AlertEvent {
  rule_id: string;
  severity: string;
  title: string;
  detail: string;
  ts: number;
}

/** Engine state snapshot from /openalerts/state. */
export interface StateSnapshot {
  uptime_ms: number;
  started_at: number;
  stats: Record<string, number>;
  bus_listeners: number;
  recent_alerts: AlertEvent[];
  rules: RuleStatus[];
  cooldowns: Record<string, number>;
}

export interface RuleStatus {
  id: string;
  status: "ok" | "fired";
  last_fired: number | null;
}

/** Flow tracker state for grouping events by agent run. */
export interface FlowState {
  el: HTMLElement;
  body: HTMLElement;
  hdr: HTMLElement;
  summary: HTMLElement;
  st: "active" | "done" | "error";
  n: number;
  err: boolean;
  errCount: number;
  dur: number;
  tok: number;
  tools: number;
  llms: number;
  steps: number;
  toolNames: Record<string, boolean>;
}
