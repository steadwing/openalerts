/**
 * Correlation ID Tracking
 * 
 * Tracks requests across their entire lifecycle:
 * webhook → message → session → agent → tools → response
 * 
 * Enables distributed tracing and request flow visualization.
 */

import type { OpenAlertsEvent } from "./types.js";

export type CorrelationContext = {
  correlationId: string;
  startTs: number;
  endTs?: number;
  events: OpenAlertsEvent[];
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  meta?: Record<string, unknown>;
};

export class CorrelationTracker {
  private contexts = new Map<string, CorrelationContext>();
  private sessionToCorrelation = new Map<string, string>();
  private ttlMs: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(
    ttlMs = 3600_000, // 1 hour default TTL
    cleanupIntervalMs = 300_000, // Cleanup every 5 minutes
  ) {
    this.ttlMs = ttlMs;
    if (cleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
    }
  }

  /** Generate a new correlation ID */
  static generateId(): string {
    return `corr_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /** Start a new correlation context */
  startCorrelation(opts: {
    correlationId?: string;
    sessionKey?: string;
    agentId?: string;
    channel?: string;
    meta?: Record<string, unknown>;
  }): string {
    const correlationId = opts.correlationId ?? CorrelationTracker.generateId();
    
    const context: CorrelationContext = {
      correlationId,
      startTs: Date.now(),
      events: [],
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      channel: opts.channel,
      meta: opts.meta,
    };

    this.contexts.set(correlationId, context);

    // Index by session key for quick lookup
    if (opts.sessionKey) {
      this.sessionToCorrelation.set(opts.sessionKey, correlationId);
    }

    return correlationId;
  }

  /** Add an event to a correlation context */
  addEvent(correlationId: string, event: OpenAlertsEvent): void {
    const context = this.contexts.get(correlationId);
    if (context) {
      context.events.push(event);
    }
  }

  /** End a correlation context */
  endCorrelation(correlationId: string): void {
    const context = this.contexts.get(correlationId);
    if (context) {
      context.endTs = Date.now();
    }
  }

  /** Get correlation context by ID */
  getContext(correlationId: string): CorrelationContext | undefined {
    return this.contexts.get(correlationId);
  }

  /** Get correlation ID by session key */
  getCorrelationBySession(sessionKey: string): string | undefined {
    return this.sessionToCorrelation.get(sessionKey);
  }

  /** Get all active correlation contexts */
  getAllContexts(): CorrelationContext[] {
    return Array.from(this.contexts.values());
  }

  /** Get correlation trace (all events in order) */
  getTrace(correlationId: string): OpenAlertsEvent[] {
    const context = this.contexts.get(correlationId);
    return context ? [...context.events] : [];
  }

  /** Cleanup expired contexts */
  cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, context] of this.contexts) {
      const age = now - context.startTs;
      if (age > this.ttlMs) {
        expired.push(id);
        // Also remove session index
        if (context.sessionKey) {
          this.sessionToCorrelation.delete(context.sessionKey);
        }
      }
    }

    for (const id of expired) {
      this.contexts.delete(id);
    }
  }

  /** Destroy tracker and cleanup */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.contexts.clear();
    this.sessionToCorrelation.clear();
  }

  /** Get stats */
  getStats(): {
    activeContexts: number;
    totalEvents: number;
    oldestContextAge: number;
  } {
    const now = Date.now();
    let totalEvents = 0;
    let oldestAge = 0;

    for (const context of this.contexts.values()) {
      totalEvents += context.events.length;
      const age = now - context.startTs;
      if (age > oldestAge) oldestAge = age;
    }

    return {
      activeContexts: this.contexts.size,
      totalEvents,
      oldestContextAge: oldestAge,
    };
  }
}

