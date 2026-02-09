import type { SteadwingEvent } from "./types.js";

export type EventListener = (event: SteadwingEvent) => void;

/**
 * Simple pub/sub event bus for SteadwingEvents.
 * Replaces framework-specific event subscriptions (e.g., OpenClaw's onDiagnosticEvent).
 */
export class SteadwingEventBus {
  private listeners = new Set<EventListener>();

  /** Subscribe to all events. Returns an unsubscribe function. */
  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Emit an event to all listeners. Errors in listeners are caught and logged. */
  emit(event: SteadwingEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[steadwing] event listener error:", err);
      }
    }
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.clear();
  }

  /** Current listener count. */
  get size(): number {
    return this.listeners.size;
  }
}
