import type { AlertChannel, AlertEvent } from "@steadwing/openalerts-core";

const SEVERITY_COLORS: Record<string, string> = {
  info: "\x1b[36m",    // cyan
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
  critical: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";

/**
 * Default alert channel — logs to stderr with color.
 * Always available, no configuration needed.
 */
export class ConsoleAlertChannel implements AlertChannel {
  readonly name = "console";

  send(alert: AlertEvent, formatted: string): void {
    const color = SEVERITY_COLORS[alert.severity] ?? "";
    const prefix = `${color}[${alert.severity.toUpperCase()}]${RESET}`;
    console.error(`${prefix} ${formatted.replace(/\n/g, "\n  ")}`);
  }
}
