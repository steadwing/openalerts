import type { AlertChannel, AlertEvent } from "@steadwing/openalerts-core";

/**
 * Generic webhook channel — POSTs JSON to any URL.
 *
 * ```ts
 * new GenericWebhookAlertChannel("https://my-service.com/hooks/alerts")
 * ```
 *
 * Payload shape:
 * ```json
 * { "alert": { ...AlertEvent }, "formatted": "..." }
 * ```
 */
export class GenericWebhookAlertChannel implements AlertChannel {
  readonly name: string;
  private url: string;
  private headers: Record<string, string>;

  constructor(
    url: string,
    opts?: { name?: string; headers?: Record<string, string> },
  ) {
    this.url = url;
    this.name = opts?.name ?? "webhook";
    this.headers = {
      "Content-Type": "application/json",
      ...opts?.headers,
    };
  }

  async send(alert: AlertEvent, formatted: string): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ alert, formatted }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Webhook ${res.status}: ${this.url}`);
    }
  }
}
