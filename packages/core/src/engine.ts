import { AlertDispatcher } from "./alert-channel.js";
import { OpenAlertsEventBus } from "./event-bus.js";
import { createEvaluatorState, processEvent, processWatchdogTick, warmFromHistory } from "./evaluator.js";
import { createPlatformSync, type PlatformSync } from "./platform.js";
import { appendEvent, pruneLog, readAllEvents, readRecentEvents } from "./store.js";
import {
  DEFAULTS,
  type AlertEvent,
  type EvaluatorState,
  type MonitorConfig,
  type OpenAlertsEvent,
  type OpenAlertsInitOptions,
  type OpenAlertsLogger,
  type StoredEvent,
} from "./types.js";

/**
 * OpenAlertsEngine — central orchestrator for monitoring and alerting.
 *
 * Framework-agnostic. Adapters (OpenClaw, Nanobot, LangChain, etc.)
 * translate their events into OpenAlertsEvent and feed them to `ingest()`.
 */
export class OpenAlertsEngine {
  readonly bus: OpenAlertsEventBus;
  readonly state: EvaluatorState;

  private config: MonitorConfig;
  private stateDir: string;
  private dispatcher: AlertDispatcher;
  private platform: PlatformSync | null = null;
  private logger: OpenAlertsLogger;
  private logPrefix: string;

  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: OpenAlertsInitOptions) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.logger = options.logger ?? console;
    this.logPrefix = options.logPrefix ?? "openalerts";

    this.bus = new OpenAlertsEventBus();
    this.state = createEvaluatorState();

    this.dispatcher = new AlertDispatcher({
      channels: options.channels,
      logger: this.logger,
      diagnosisHint: options.diagnosisHint,
    });

    // Wire up: bus events → evaluator → dispatcher
    this.bus.on((event) => this.handleEvent(event));
  }

  /** Start the engine: warm from history, start timers. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Warm from persisted events
    try {
      const history = readAllEvents(this.stateDir);
      warmFromHistory(this.state, history);
      this.logger.info(`${this.logPrefix}: warmed from ${history.length} persisted events`);
    } catch (err) {
      this.logger.warn(`${this.logPrefix}: warm-start failed: ${String(err)}`);
    }

    // Start platform sync if apiKey present
    if (this.config.apiKey) {
      this.platform = createPlatformSync({
        apiKey: this.config.apiKey,
        logger: this.logger,
        logPrefix: this.logPrefix,
      });
      this.logger.info(`${this.logPrefix}: platform sync enabled`);
    }

    // Watchdog timer (checks for gateway-down every 30s)
    this.watchdogTimer = setInterval(() => {
      const alerts = processWatchdogTick(this.state, this.config);
      for (const alert of alerts) {
        this.fireAlert(alert);
      }
    }, DEFAULTS.watchdogIntervalMs);

    // Prune timer (cleans old log entries every 6h)
    this.pruneTimer = setInterval(() => {
      try {
        pruneLog(this.stateDir, {
          maxAgeMs: (this.config.maxLogAgeDays ?? DEFAULTS.maxLogAgeDays) * 24 * 60 * 60 * 1000,
          maxSizeKb: this.config.maxLogSizeKb ?? DEFAULTS.maxLogSizeKb,
        });
      } catch (err) {
        this.logger.warn(`${this.logPrefix}: prune failed: ${String(err)}`);
      }
    }, DEFAULTS.pruneIntervalMs);

    const channelNames = this.dispatcher.hasChannels
      ? `${this.dispatcher.channelCount} channel(s)`
      : "log-only (no alert channels)";
    this.logger.info(`${this.logPrefix}: started, ${channelNames}, 7 rules active`);
  }

  /** Ingest a universal event. Can be called directly or via the event bus. */
  ingest(event: OpenAlertsEvent): void {
    this.bus.emit(event);
  }

  /** Stop the engine: clear timers, flush platform, clear bus. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.platform?.stop();
    this.bus.clear();

    this.logger.info(`${this.logPrefix}: stopped`);
  }

  /** Add a channel at runtime (e.g., after detecting available transports). */
  addChannel(channel: { readonly name: string; send(alert: AlertEvent, formatted: string): Promise<void> | void }): void {
    this.dispatcher.addChannel(channel);
  }

  /** Whether the platform sync is connected. */
  get platformConnected(): boolean {
    return this.platform?.isConnected() ?? false;
  }

  /** Whether the engine is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Read recent stored events (for /alerts command). */
  getRecentEvents(limit = 100): StoredEvent[] {
    return readRecentEvents(this.stateDir, limit);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private handleEvent(event: OpenAlertsEvent): void {
    // Persist as diagnostic snapshot
    const snapshot: StoredEvent = {
      type: "diagnostic",
      eventType: event.type,
      ts: event.ts,
      summary: `${event.type}${event.outcome ? `:${event.outcome}` : ""}`,
      channel: event.channel,
      sessionKey: event.sessionKey,
    };
    try {
      appendEvent(this.stateDir, snapshot);
    } catch (err) {
      this.logger.warn(`${this.logPrefix}: failed to persist event: ${String(err)}`);
    }

    // Run through evaluator
    const alerts = processEvent(this.state, this.config, event);
    for (const alert of alerts) {
      this.fireAlert(alert);
    }

    // Forward to platform
    this.platform?.enqueue(snapshot);
  }

  private fireAlert(alert: AlertEvent): void {
    // Persist alert
    try {
      appendEvent(this.stateDir, alert);
    } catch (err) {
      this.logger.warn(`${this.logPrefix}: failed to persist alert: ${String(err)}`);
    }

    // Forward to platform
    this.platform?.enqueue(alert);

    // Dispatch to channels (unless quiet mode)
    if (!this.config.quiet) {
      void this.dispatcher.dispatch(alert).catch((err) => {
        this.logger.error(`${this.logPrefix}: alert dispatch failed: ${String(err)}`);
      });
    }

    this.logger.info(`${this.logPrefix}: [${alert.severity}] ${alert.title}`);
  }
}
