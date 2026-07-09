import { AlertDispatcher } from "./alert-channel.js";
import { OpenAlertsEventBus } from "./event-bus.js";
import { createEvaluatorState, processEvent, processWatchdogTick, warmFromHistory } from "./evaluator.js";
import { ALL_RULES } from "./rules.js";
import { appendEvent, pruneLog, readAllEvents, readRecentEvents } from "./store.js";
import {
  DEFAULTS,
  type AlertEvent,
  type AlertEnricher,
  type EvaluatorState,
  type MonitorConfig,
  type OpenAlertsEvent,
  type OpenAlertsInitOptions,
  type OpenAlertsLogger,
  type StoredEvent,
} from "./types.js";
import type { DatabaseSync } from "node:sqlite";
import { upsertAlert, insertDiagnostic } from "../db/queries.js";

export class OpenAlertsEngine {
  readonly bus: OpenAlertsEventBus;
  readonly state: EvaluatorState;

  private config: MonitorConfig;
  private stateDir: string;
  private dispatcher: AlertDispatcher;
  private enricher: AlertEnricher | null;
  private logger: OpenAlertsLogger;
  private logPrefix: string;
  private db: DatabaseSync | null;

  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private eventRing: OpenAlertsEvent[] = [];
  private static readonly RING_MAX = 500;
  private alertCallbacks: ((alert: AlertEvent) => void)[] = [];

  constructor(options: OpenAlertsInitOptions & { db?: DatabaseSync | null }) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.enricher = options.enricher ?? null;
    this.logger = options.logger ?? console;
    this.logPrefix = options.logPrefix ?? "openalerts";
    this.db = options.db ?? null;

    this.bus = new OpenAlertsEventBus();
    this.state = createEvaluatorState();
    this.dispatcher = new AlertDispatcher({
      channels: options.channels,
      logger: this.logger,
      diagnosisHint: options.diagnosisHint,
    });

    this.bus.on(event => this.handleEvent(event));
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    try {
      const history = readAllEvents(this.stateDir);
      warmFromHistory(this.state, history);
      this.logger.info(`${this.logPrefix}: warmed from ${history.length} events`);
    } catch (err) {
      this.logger.warn(`${this.logPrefix}: warm-start failed: ${err}`);
    }

    this.watchdogTimer = setInterval(() => {
      const alerts = processWatchdogTick(this.state, this.config);
      for (const alert of alerts) {
        void this.fireAlert(alert).catch(err =>
          this.logger.error(`${this.logPrefix}: watchdog alert failed: ${err}`)
        );
      }
    }, DEFAULTS.watchdogIntervalMs);

    this.pruneTimer = setInterval(() => {
      try {
        pruneLog(this.stateDir, {
          maxAgeMs: (this.config.maxLogAgeDays ?? DEFAULTS.maxLogAgeDays) * 24 * 60 * 60 * 1000,
          maxSizeKb: this.config.maxLogSizeKb ?? DEFAULTS.maxLogSizeKb,
        });
      } catch (err) {
        this.logger.warn(`${this.logPrefix}: prune failed: ${err}`);
      }
    }, DEFAULTS.pruneIntervalMs);

    const ch = this.dispatcher.hasChannels ? `${this.dispatcher.channelCount} channel(s)` : "log-only";
    this.logger.info(`${this.logPrefix}: started — ${ch}, ${ALL_RULES.length} rules active`);
  }

  ingest(event: OpenAlertsEvent): void { this.bus.emit(event); }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    this.bus.clear();
    this.logger.info(`${this.logPrefix}: stopped`);
  }

  addChannel(channel: { readonly name: string; send(alert: AlertEvent, formatted: string): Promise<void> | void }): void {
    this.dispatcher.addChannel(channel);
  }

  sendTestAlert(): void {
    void this.fireAlert({
      type: "alert", id: `test:manual:${Date.now()}`,
      ruleId: "test", severity: "info",
      title: "Test alert — delivery verified",
      detail: "If you see this, alert delivery is working.",
      ts: Date.now(), fingerprint: "test:manual",
    }).catch(err => this.logger.error(`${this.logPrefix}: test alert failed: ${err}`));
  }

  get isRunning(): boolean { return this.running; }

  /** Register a callback that fires every time an alert is dispatched. */
  onAlert(cb: (alert: AlertEvent) => void): void {
    this.alertCallbacks.push(cb);
  }

  getRecentEvents(limit = 100): StoredEvent[] { return readRecentEvents(this.stateDir, limit); }
  getRecentLiveEvents(limit = 200): OpenAlertsEvent[] { return this.eventRing.slice(-limit); }

  private handleEvent(event: OpenAlertsEvent): void {
    this.eventRing.push(event);
    if (this.eventRing.length > OpenAlertsEngine.RING_MAX)
      this.eventRing = this.eventRing.slice(-OpenAlertsEngine.RING_MAX);

    const snapshot: StoredEvent = {
      type: "diagnostic", eventType: event.type, ts: event.ts,
      summary: `${event.type}${event.outcome ? `:${event.outcome}` : ""}`,
      channel: event.channel, sessionKey: event.sessionKey,
    };

    try { appendEvent(this.stateDir, snapshot); } catch { /* ignore */ }

    // Write to SQLite
    if (this.db) {
      try {
        insertDiagnostic(this.db, {
          event_type: event.type, ts: event.ts,
          summary: snapshot.summary, channel: event.channel,
          session_key: event.sessionKey, agent_id: event.agentId,
        });
      } catch { /* ignore */ }
    }

    const alerts = processEvent(this.state, this.config, event);
    for (const alert of alerts) {
      void this.fireAlert(alert).catch(err =>
        this.logger.error(`${this.logPrefix}: alert fire failed: ${err}`)
      );
    }
  }

  private async fireAlert(alert: AlertEvent): Promise<void> {
    try { appendEvent(this.stateDir, alert); } catch { /* ignore */ }

    // Write to SQLite
    if (this.db) {
      try {
        upsertAlert(this.db, {
          id: alert.id, rule_id: alert.ruleId,
          severity: alert.severity, title: alert.title,
          detail: alert.detail, ts: alert.ts, fingerprint: alert.fingerprint,
        });
      } catch { /* ignore */ }
    }

    let enriched = alert;
    if (this.enricher) {
      try {
        const result = await this.enricher(alert);
        if (result) enriched = result;
      } catch { /* ignore */ }
    }

    if (!this.config.quiet) {
      void this.dispatcher.dispatch(enriched).catch(err =>
        this.logger.error(`${this.logPrefix}: dispatch failed: ${err}`)
      );
    }

    this.logger.info(`${this.logPrefix}: [${alert.severity}] ${alert.title}`);
    for (const cb of this.alertCallbacks) { try { cb(alert); } catch { /* ignore */ } }
  }
}
