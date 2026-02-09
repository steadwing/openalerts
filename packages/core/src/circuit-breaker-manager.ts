/**
 * Circuit Breaker Manager
 * 
 * Manages multiple circuit breakers and emits events to OpenAlerts engine.
 */

import { CircuitBreaker, type CircuitBreakerConfig, type CircuitBreakerStats, type CircuitState } from "./circuit-breaker.js";
import type { OpenAlertsEvent } from "./types.js";

export type CircuitBreakerCategory = "llm" | "tool" | "channel" | "custom";

export type CircuitBreakerKey = {
  category: CircuitBreakerCategory;
  name: string;
};

export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreaker>();
  private eventCallbacks: Array<(event: OpenAlertsEvent) => void> = [];

  constructor(
    private readonly defaultConfig?: Partial<CircuitBreakerConfig>,
  ) {}

  /** Get or create a circuit breaker */
  getBreaker(key: CircuitBreakerKey, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    const breakerId = this.makeBreakerId(key);
    let breaker = this.breakers.get(breakerId);

    if (!breaker) {
      const finalConfig = { ...this.defaultConfig, ...config } as CircuitBreakerConfig;
      breaker = new CircuitBreaker(
        breakerId,
        finalConfig,
        (name, oldState, newState, stats) => this.onStateChange(key, oldState, newState, stats),
      );
      this.breakers.set(breakerId, breaker);
    }

    return breaker;
  }

  /** Execute function with circuit breaker protection */
  async execute<T>(
    key: CircuitBreakerKey,
    fn: () => Promise<T>,
    config?: Partial<CircuitBreakerConfig>,
  ): Promise<T> {
    const breaker = this.getBreaker(key, config);

    if (!breaker.canExecute()) {
      const error = new Error(`Circuit breaker open for ${key.category}:${key.name}`);
      (error as any).circuitBreakerOpen = true;
      throw error;
    }

    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }

  /** Get all circuit breaker stats */
  getAllStats(): Map<string, CircuitBreakerStats> {
    const stats = new Map<string, CircuitBreakerStats>();
    for (const [id, breaker] of this.breakers) {
      stats.set(id, breaker.getStats());
    }
    return stats;
  }

  /** Get stats for specific breaker */
  getStats(key: CircuitBreakerKey): CircuitBreakerStats | undefined {
    const breakerId = this.makeBreakerId(key);
    return this.breakers.get(breakerId)?.getStats();
  }

  /** Subscribe to circuit breaker events */
  onEvent(callback: (event: OpenAlertsEvent) => void): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const idx = this.eventCallbacks.indexOf(callback);
      if (idx >= 0) this.eventCallbacks.splice(idx, 1);
    };
  }

  /** Cleanup all breakers */
  destroy(): void {
    for (const breaker of this.breakers.values()) {
      breaker.destroy();
    }
    this.breakers.clear();
    this.eventCallbacks = [];
  }

  private makeBreakerId(key: CircuitBreakerKey): string {
    return `${key.category}:${key.name}`;
  }

  private onStateChange(
    key: CircuitBreakerKey,
    oldState: CircuitState,
    newState: CircuitState,
    stats: CircuitBreakerStats,
  ): void {
    const event: OpenAlertsEvent = {
      type: newState === "OPEN" ? "infra.error" : "custom",
      ts: Date.now(),
      outcome: newState === "OPEN" ? "error" : "success",
      error: newState === "OPEN" ? `Circuit breaker tripped for ${key.category}:${key.name}` : undefined,
      meta: {
        circuitBreaker: {
          category: key.category,
          name: key.name,
          oldState,
          newState,
          failureCount: stats.failureCount,
          successCount: stats.successCount,
          tripCount: stats.tripCount,
          totalRequests: stats.totalRequests,
          totalFailures: stats.totalFailures,
        },
        source: "circuit-breaker",
      },
    };

    // Emit to all subscribers
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (err) {
        console.error("Circuit breaker event callback error:", err);
      }
    }
  }
}

