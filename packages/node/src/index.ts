import {
  SteadwingEngine,
  type AlertChannel,
  type MonitorConfig,
  type SteadwingEvent,
  type SteadwingLogger,
} from "@steadwing/core";
import os from "node:os";
import path from "node:path";
import { ConsoleAlertChannel } from "./channels/console.js";

export type { AlertChannel, MonitorConfig, SteadwingEvent, SteadwingLogger };
export { SteadwingEngine } from "@steadwing/core";

// Re-export built-in channels
export { ConsoleAlertChannel } from "./channels/console.js";
export { DiscordWebhookAlertChannel } from "./channels/discord-webhook.js";
export { GenericWebhookAlertChannel } from "./channels/webhook.js";
export { SlackWebhookAlertChannel } from "./channels/slack-webhook.js";
export { TelegramBotAlertChannel } from "./channels/telegram-bot.js";

// ─── Global singleton ────────────────────────────────────────────────────────

let _engine: SteadwingEngine | null = null;

export type SteadwingNodeOptions = {
  /** Alert channels to send notifications to. Defaults to [ConsoleAlertChannel]. */
  channels?: AlertChannel[];
  /** Monitor config (rules, cooldowns, etc.) */
  config?: MonitorConfig;
  /** Where to store event logs. Defaults to ~/.steadwing/ */
  stateDir?: string;
  /** Logger. Defaults to console. */
  logger?: SteadwingLogger;
  /** Diagnosis hint for critical alerts. */
  diagnosisHint?: string;
};

/**
 * Initialize Steadwing monitoring. Call once at app startup.
 *
 * ```ts
 * import { init, TelegramBotAlertChannel } from "@steadwing/node";
 * init({ channels: [new TelegramBotAlertChannel("BOT_TOKEN", "CHAT_ID")] });
 * ```
 */
export function init(options: SteadwingNodeOptions = {}): SteadwingEngine {
  if (_engine?.isRunning) {
    _engine.stop();
  }

  const stateDir = options.stateDir ?? path.join(os.homedir(), ".steadwing");
  const channels = options.channels ?? [new ConsoleAlertChannel()];

  _engine = new SteadwingEngine({
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
export function captureEvent(event: SteadwingEvent): void {
  if (!_engine) {
    console.warn("[steadwing] captureEvent called before init(). Event dropped.");
    return;
  }
  _engine.ingest(event);
}

/**
 * Gracefully shut down Steadwing. Flushes pending platform syncs.
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
export function getEngine(): SteadwingEngine | null {
  return _engine;
}
