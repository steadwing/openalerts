import type { AlertChannel, AlertEvent } from "@steadwing/openalerts-core";

/**
 * Send alerts to Slack via incoming webhook URL.
 *
 * ```ts
 * new SlackWebhookAlertChannel("https://hooks.slack.com/services/T.../B.../xxx")
 * ```
 */
export class SlackWebhookAlertChannel implements AlertChannel {
  readonly name = "slack";

  constructor(private webhookUrl: string) {}

  async send(alert: AlertEvent, formatted: string): Promise<void> {
    const emoji =
      alert.severity === "critical" ? ":rotating_light:" :
      alert.severity === "error" ? ":x:" :
      alert.severity === "warn" ? ":warning:" : ":information_source:";

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${emoji} ${formatted}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Slack webhook ${res.status}`);
    }
  }
}
