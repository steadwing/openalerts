import { DEFAULTS, type OpenAlertsLogger, type StoredEvent } from "./types.js";

export type PlatformSync = {
  enqueue: (event: StoredEvent) => void;
  flush: () => Promise<void>;
  stop: () => void;
  isConnected: () => boolean;
};

/**
 * Create a platform sync instance that batches events and pushes them
 * to the OpenAlerts backend API. Only active when apiKey is provided.
 */
export function createPlatformSync(opts: {
  apiKey: string;
  baseUrl?: string;
  logger: OpenAlertsLogger;
  logPrefix?: string;
}): PlatformSync {
  const { apiKey, logger } = opts;
  const baseUrl = opts.baseUrl?.replace(/\/+$/, "") ?? "https://api.openalerts.dev";
  const prefix = opts.logPrefix ?? "openalerts";

  let batch: StoredEvent[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let disabled = false;
  let connected = true;

  // Start periodic flush
  flushTimer = setInterval(() => {
    void doFlush().catch(() => {});
  }, DEFAULTS.platformFlushIntervalMs);

  async function doFlush(): Promise<void> {
    if (disabled || batch.length === 0) return;

    const events = batch.splice(0, DEFAULTS.platformBatchSize);
    const body = JSON.stringify({
      events,
      plugin_version: "0.1.0",
      ts: Date.now(),
    });

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/api/monitor/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });

        if (res.ok) {
          connected = true;
          return; // Success
        }

        if (res.status === 401 || res.status === 403) {
          logger.warn(
            `${prefix}: invalid API key (${res.status}). Platform sync disabled. Check your key at app.openalerts.dev.`,
          );
          disabled = true;
          connected = false;
          return;
        }

        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err;
      }

      // Wait before retry
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // Failed after retries — put events back and log
    batch.unshift(...events);
    // Cap batch to prevent unbounded growth
    if (batch.length > DEFAULTS.platformBatchSize * 2) {
      batch = batch.slice(-DEFAULTS.platformBatchSize);
    }
    connected = false;
    logger.warn(`${prefix}: platform sync failed: ${String(lastErr)}`);
  }

  return {
    enqueue(event: StoredEvent): void {
      if (disabled) return;
      batch.push(event);
      // Auto-flush if batch full
      if (batch.length >= DEFAULTS.platformBatchSize) {
        void doFlush().catch(() => {});
      }
    },

    async flush(): Promise<void> {
      await doFlush();
    },

    stop(): void {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      // Final flush attempt (best-effort, don't await in stop)
      void doFlush().catch(() => {});
    },

    isConnected(): boolean {
      return connected && !disabled;
    },
  };
}
