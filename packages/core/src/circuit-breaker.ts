/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures when dependencies (LLM providers, tools, channels) are broken.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests are blocked
 * - HALF_OPEN: Testing if dependency has recovered
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type CircuitBreakerConfig = {
  /** Failure threshold before opening circuit */
  failureThreshold: number;
  /** Success threshold in HALF_OPEN before closing circuit */
  successThreshold: number;
  /** Time in ms before attempting recovery (OPEN → HALF_OPEN) */
  resetTimeoutMs: number;
  /** Time window in ms for counting failures */
  windowMs: number;
};

export type CircuitBreakerStats = {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTs?: number;
  lastSuccessTs?: number;
  lastStateChangeTs: number;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
  tripCount: number;
};

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 60_000, // 1 minute
  windowMs: 60_000, // 1 minute
};

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTs?: number;
  private lastSuccessTs?: number;
  private lastStateChangeTs = Date.now();
  private totalRequests = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private tripCount = 0;
  private resetTimer?: NodeJS.Timeout;

  constructor(
    public readonly name: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_CONFIG,
    private readonly onStateChange?: (name: string, oldState: CircuitState, newState: CircuitState, stats: CircuitBreakerStats) => void,
  ) {}

  /** Check if request should be allowed */
  canExecute(): boolean {
    const now = Date.now();

    // If OPEN, check if we should transition to HALF_OPEN
    if (this.state === "OPEN") {
      if (this.lastStateChangeTs + this.config.resetTimeoutMs <= now) {
        this.transitionTo("HALF_OPEN");
      } else {
        return false; // Still open, reject request
      }
    }

    return true; // CLOSED or HALF_OPEN allows requests
  }

  /** Record successful execution */
  recordSuccess(): void {
    this.totalRequests++;
    this.totalSuccesses++;
    this.lastSuccessTs = Date.now();

    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo("CLOSED");
      }
    } else if (this.state === "CLOSED") {
      // Reset failure count on success in CLOSED state
      this.failureCount = 0;
    }
  }

  /** Record failed execution */
  recordFailure(): void {
    this.totalRequests++;
    this.totalFailures++;
    this.lastFailureTs = Date.now();

    if (this.state === "HALF_OPEN") {
      // Any failure in HALF_OPEN immediately reopens circuit
      this.transitionTo("OPEN");
    } else if (this.state === "CLOSED") {
      this.failureCount++;
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo("OPEN");
      }
    }
  }

  /** Get current stats */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTs: this.lastFailureTs,
      lastSuccessTs: this.lastSuccessTs,
      lastStateChangeTs: this.lastStateChangeTs,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      tripCount: this.tripCount,
    };
  }

  /** Force state transition (for testing/manual control) */
  forceState(newState: CircuitState): void {
    this.transitionTo(newState);
  }

  /** Cleanup timers */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    this.lastStateChangeTs = Date.now();

    // Reset counters on state change
    if (newState === "CLOSED") {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === "HALF_OPEN") {
      this.successCount = 0;
      this.failureCount = 0;
    } else if (newState === "OPEN") {
      this.tripCount++;
    }

    this.onStateChange?.(this.name, oldState, newState, this.getStats());
  }
}

