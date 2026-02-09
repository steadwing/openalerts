import {
  OpenAlertsEngine,
  type AlertChannel,
  type MonitorConfig,
  type OpenAlertsEvent,
  type OpenAlertsLogger,
} from "@steadwing/openalerts-core";
import os from "node:os";
import path from "node:path";
import { ConsoleAlertChannel } from "./channels/console.js";

export type { AlertChannel, MonitorConfig, OpenAlertsEvent, OpenAlertsLogger };
export { OpenAlertsEngine } from "@steadwing/openalerts-core";

// Re-export built-in channels
export { ConsoleAlertChannel } from "./channels/console.js";
export { DiscordWebhookAlertChannel } from "./channels/discord-webhook.js";
export { GenericWebhookAlertChannel } from "./channels/webhook.js";
export { SlackWebhookAlertChannel } from "./channels/slack-webhook.js";
export { TelegramBotAlertChannel } from "./channels/telegram-bot.js";

// ─── Global singleton ────────────────────────────────────────────────────────

let _engine: OpenAlertsEngine | null = null;

export type OpenAlertsNodeOptions = {
  /** Alert channels to send notifications to. Defaults to [ConsoleAlertChannel]. */
  channels?: AlertChannel[];
  /** Monitor config (rules, cooldowns, etc.) */
  config?: MonitorConfig;
  /** Where to store event logs. Defaults to ~/.openalerts/ */
  stateDir?: string;
  /** Logger. Defaults to console. */
  logger?: OpenAlertsLogger;
  /** Diagnosis hint for critical alerts. */
  diagnosisHint?: string;
};

/**
 * Initialize OpenAlerts monitoring. Call once at app startup.
 *
 * ```ts
 * import { init, TelegramBotAlertChannel } from "@steadwing/openalerts-node";
 * init({ channels: [new TelegramBotAlertChannel("BOT_TOKEN", "CHAT_ID")] });
 * ```
 */
export function init(options: OpenAlertsNodeOptions = {}): OpenAlertsEngine {
  if (_engine?.isRunning) {
    _engine.stop();
  }

  const stateDir = options.stateDir ?? path.join(os.homedir(), ".openalerts");
  const channels = options.channels ?? [new ConsoleAlertChannel()];

  _engine = new OpenAlertsEngine({
    stateDir,
    config: options.config ?? {},
    channels,
    logger: options.logger,
    diagnosisHint: options.diagnosisHint,
  });

  _engine.start();
  return _engine;
}

/**
 * Capture a monitoring event. Must call init() first.
 *
 * ```ts
 * captureEvent({ type: "llm.call", ts: Date.now(), outcome: "success", durationMs: 1200 });
 * ```
 */
export function captureEvent(event: OpenAlertsEvent): void {
  if (!_engine) {
    console.warn("[openalerts] captureEvent called before init(). Event dropped.");
    return;
  }
  _engine.ingest(event);
}

/**
 * Gracefully shut down OpenAlerts. Flushes pending platform syncs.
 */
export function shutdown(): void {
  if (_engine) {
    _engine.stop();
    _engine = null;
  }
}

/**
 * Get the current engine instance (for advanced usage).
 */
export function getEngine(): OpenAlertsEngine | null {
  return _engine;
}
