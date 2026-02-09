import { formatAlertMessage } from "./formatter.js";
import type { AlertChannel, AlertEvent, SteadwingLogger } from "./types.js";

/**
 * Dispatches alerts to all registered channels.
 * Fire-and-forget: individual channel failures don't block others.
 */
export class AlertDispatcher {
  private channels: AlertChannel[] = [];
  private logger: SteadwingLogger;
  private diagnosisHint?: string;

  constructor(opts: {
    channels?: AlertChannel[];
    logger?: SteadwingLogger;
    diagnosisHint?: string;
  }) {
    this.channels = opts.channels ?? [];
    this.logger = opts.logger ?? console;
    this.diagnosisHint = opts.diagnosisHint;
  }

  /** Add a channel at runtime. */
  addChannel(channel: AlertChannel): void {
    this.channels.push(channel);
  }

  /** Send an alert to all registered channels. */
  async dispatch(alert: AlertEvent): Promise<void> {
    if (this.channels.length === 0) return;

    const formatted = formatAlertMessage(alert, {
      diagnosisHint: this.diagnosisHint,
    });

    const results = this.channels.map(async (ch) => {
      try {
        await ch.send(alert, formatted);
      } catch (err) {
        this.logger.error(`[steadwing] alert channel "${ch.name}" failed: ${String(err)}`);
      }
    });

    await Promise.allSettled(results);
  }

  /** Whether any channels are registered. */
  get hasChannels(): boolean {
    return this.channels.length > 0;
  }

  /** Number of registered channels. */
  get channelCount(): number {
    return this.channels.length;
  }
}
