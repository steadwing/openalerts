/**
 * Task Timeout Monitoring
 * 
 * Tracks long-running tasks and alerts when they exceed configured timeouts.
 * Prevents hung tasks from blocking lanes forever.
 */

import type { OpenAlertsEvent } from "./types.js";

export type TaskType = "agent_run" | "tool_call" | "message_processing" | "compaction" | "custom";

export type TaskTimeoutConfig = {
  /** Timeout in ms for this task type */
  timeoutMs: number;
  /** Warning threshold (% of timeout) before alerting */
  warningThreshold?: number;
};

export type RunningTask = {
  taskId: string;
  taskType: TaskType;
  startTs: number;
  timeoutMs: number;
  sessionKey?: string;
  agentId?: string;
  meta?: Record<string, unknown>;
};

export type TaskTimeoutEvent = {
  taskId: string;
  taskType: TaskType;
  durationMs: number;
  timeoutMs: number;
  sessionKey?: string;
  agentId?: string;
  meta?: Record<string, unknown>;
};

const DEFAULT_TIMEOUTS: Record<TaskType, number> = {
  agent_run: 600_000, // 10 minutes
  tool_call: 300_000, // 5 minutes
  message_processing: 120_000, // 2 minutes
  compaction: 60_000, // 1 minute
  custom: 300_000, // 5 minutes
};

export class TaskTimeoutMonitor {
  private runningTasks = new Map<string, RunningTask>();
  private checkInterval?: NodeJS.Timeout;
  private eventCallbacks: Array<(event: OpenAlertsEvent) => void> = [];

  constructor(
    private readonly config: Partial<Record<TaskType, TaskTimeoutConfig>> = {},
    private readonly checkIntervalMs = 10_000, // Check every 10 seconds
  ) {}

  /** Start monitoring */
  start(): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => this.checkTimeouts(), this.checkIntervalMs);
  }

  /** Stop monitoring */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
  }

  /** Register a task start */
  startTask(task: Omit<RunningTask, "startTs">): void {
    const runningTask: RunningTask = {
      ...task,
      startTs: Date.now(),
    };
    this.runningTasks.set(task.taskId, runningTask);
  }

  /** Register a task completion */
  endTask(taskId: string): void {
    this.runningTasks.delete(taskId);
  }

  /** Get all running tasks */
  getRunningTasks(): RunningTask[] {
    return Array.from(this.runningTasks.values());
  }

  /** Subscribe to timeout events */
  onEvent(callback: (event: OpenAlertsEvent) => void): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const idx = this.eventCallbacks.indexOf(callback);
      if (idx >= 0) this.eventCallbacks.splice(idx, 1);
    };
  }

  /** Cleanup */
  destroy(): void {
    this.stop();
    this.runningTasks.clear();
    this.eventCallbacks = [];
  }

  private checkTimeouts(): void {
    const now = Date.now();

    for (const [taskId, task] of this.runningTasks) {
      const durationMs = now - task.startTs;
      const timeoutMs = task.timeoutMs || this.getDefaultTimeout(task.taskType);

      if (durationMs >= timeoutMs) {
        // Task has exceeded timeout
        this.emitTimeoutEvent(task, durationMs, timeoutMs);
        // Remove from tracking to avoid repeated alerts
        this.runningTasks.delete(taskId);
      }
    }
  }

  private getDefaultTimeout(taskType: TaskType): number {
    return this.config[taskType]?.timeoutMs ?? DEFAULT_TIMEOUTS[taskType];
  }

  private emitTimeoutEvent(task: RunningTask, durationMs: number, timeoutMs: number): void {
    const event: OpenAlertsEvent = {
      type: "infra.error",
      ts: Date.now(),
      sessionKey: task.sessionKey,
      agentId: task.agentId,
      outcome: "error",
      error: `Task timeout: ${task.taskType} exceeded ${timeoutMs}ms (ran for ${durationMs}ms)`,
      meta: {
        taskTimeout: {
          taskId: task.taskId,
          taskType: task.taskType,
          durationMs,
          timeoutMs,
          ...task.meta,
        },
        source: "task-timeout",
      },
    };

    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (err) {
        console.error("Task timeout event callback error:", err);
      }
    }
  }
}

