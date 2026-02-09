import type { AlertChannel, AlertEvent } from "@steadwing/openalerts-core";

/**
 * Send alerts directly via Telegram Bot API.
 * No framework dependency — just needs a bot token and chat ID.
 *
 * ```ts
 * new TelegramBotAlertChannel("123456:ABC-DEF", "5162109058")
 * ```
 */
export class TelegramBotAlertChannel implements AlertChannel {
  readonly name = "telegram";

  constructor(
    private botToken: string,
    private chatId: string,
  ) {}

  async send(_alert: AlertEvent, formatted: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatted,
        parse_mode: undefined, // Plain text for reliability
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram API ${res.status}: ${body}`);
    }
  }
}
