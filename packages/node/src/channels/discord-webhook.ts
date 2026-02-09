import type { AlertChannel, AlertEvent } from "@steadwing/core";

const SEVERITY_COLORS: Record<string, number> = {
  info: 0x3498db,     // blue
  warn: 0xf39c12,     // orange
  error: 0xe74c3c,    // red
  critical: 0x9b59b6, // purple
};

/**
 * Send alerts to Discord via webhook URL.
 *
 * ```ts
 * new DiscordWebhookAlertChannel("https://discord.com/api/webhooks/...")
 * ```
 */
export class DiscordWebhookAlertChannel implements AlertChannel {
  readonly name = "discord";

  constructor(private webhookUrl: string) {}

  async send(alert: AlertEvent, formatted: string): Promise<void> {
    const color = SEVERITY_COLORS[alert.severity] ?? 0x95a5a6;

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: alert.title,
          description: formatted,
          color,
          timestamp: new Date(alert.ts).toISOString(),
          footer: { text: "Steadwing Alert" },
        }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Discord webhook ${res.status}`);
    }
  }
}
