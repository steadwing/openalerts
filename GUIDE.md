# OpenAlerts Development Guide

How the codebase works, how to extend it, and what's planned next.

---

## How the Monitoring System Works

### Event Flow

```
Framework Event (e.g., OpenClaw's "webhook.error")
  |
  v
Adapter translates to OpenAlertsEvent { type: "infra.error", ts, channel, ... }
  |
  v
OpenAlertsEngine.ingest(event)
  |
  v
EventBus.emit(event) → all listeners notified
  |
  v
handleEvent():
  1. Persist as DiagnosticSnapshot to JSONL
  2. Run through Evaluator (all 10 rules)
  3. Push to Platform sync batch
  |
  v
If rule fires → AlertEvent created
  |
  v
fireAlert():
  1. Persist AlertEvent to JSONL
  2. Push to Platform sync batch
  3. AlertDispatcher.dispatch() → all channels get the formatted message
```

### What OpenClaw Already Provides

OpenClaw emits diagnostic events through its plugin SDK. These events are what OpenAlerts listens to:

| OpenClaw Event | What It Means | OpenAlerts Translation |
|----------------|---------------|----------------------|
| `webhook.error` | Inbound webhook (Telegram, etc.) failed to process | `infra.error` |
| `message.processed` | LLM finished processing a message (success or error) | `llm.call` |
| `session.stuck` | A session hasn't progressed for too long | `session.stuck` |
| `diagnostic.heartbeat` | Periodic health check with queue depth | `infra.heartbeat` |
| `agent.start/end/error` | Agent lifecycle events | `agent.start/end/error` |
| `tool.call/error` | Tool execution events | `tool.call/error` |
| `session.start/end` | Session lifecycle | `session.start/end` |

OpenClaw also provides:
- **Channel system** (Telegram, Discord, Slack, etc.) — OpenAlerts routes alerts through this
- **Plugin config** with JSON schema validation — OpenAlerts uses this for user-facing settings
- **State directory** — OpenAlerts stores its JSONL event log here
- **Plugin commands** (/health, /alerts) — zero LLM tokens, handled directly by plugin

### What OpenAlerts Adds On Top

Things OpenClaw does NOT have natively that OpenAlerts provides:

- **Rule-based alerting** — pattern detection across events (error spikes, stuck sessions, gateway down, spend spikes, daily budget overruns)
- **Sliding window aggregation** — tracks error counts over time windows (5min, 20 messages, etc.)
- **Cooldown deduplication** — prevents alert spam (configurable per-rule + global)
- **Hourly alert cap** — max 5 alerts per hour hard cap
- **Watchdog timer** — detects gateway-down by monitoring heartbeat silence (30s tick)
- **JSONL persistence** — survives restarts, warm-starts evaluator state from history
- **Log pruning** — auto-prune by age (7d) and size (512KB) every 6 hours
- **Platform sync** — batch events to openalerts.dev with retry logic
- **Formatted /health and /alerts commands** — quick status check from chat

---

## How to Add a New Adapter (for another framework)

Adding support for a new AI agent framework (Nanobot, LangChain, Mastra, Vercel AI SDK, CrewAI, etc.) follows a consistent pattern. All adapters live in this same repo.

### Step 1: Create the adapter package

Create a new package (separate repo or directory) for the framework adapter:

```
openalerts-nanobot/
  package.json
  tsconfig.json
  src/
    index.ts          # Public API
    adapter.ts         # Event translation + channel bridge
```

**package.json:**
```json
{
  "name": "@steadwing/openalerts-nanobot",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@steadwing/openalerts": "0.2.0"
  },
  "peerDependencies": {
    "nanobot": "*"
  }
}
```

### Step 2: Write the event translator

The translator maps framework-specific events to `OpenAlertsEvent`:

```typescript
// src/adapter.ts
import type { OpenAlertsEvent, OpenAlertsEventType } from "@steadwing/openalerts";

const EVENT_MAP: Record<string, OpenAlertsEventType> = {
  "nanobot.llm.complete": "llm.call",
  "nanobot.llm.error": "llm.error",
  "nanobot.tool.run": "tool.call",
  "nanobot.agent.crash": "agent.error",
  // ... map all relevant framework events
};

export function translateNanobotEvent(event: NanobotEvent): OpenAlertsEvent | null {
  const type = EVENT_MAP[event.kind];
  if (!type) return null;

  return {
    type,
    ts: event.timestamp ?? Date.now(),
    outcome: event.success ? "success" : "error",
    error: event.errorMessage,
    durationMs: event.duration,
    channel: event.source,
    meta: { nanobotEventKind: event.kind },
  };
}
```

### Step 3: Wire it up

Two options depending on the framework:

**Option A: Plugin/hook system (like OpenClaw)**
```typescript
// src/index.ts
import { OpenAlertsEngine } from "@steadwing/openalerts";
import { translateNanobotEvent } from "./adapter.js";

export function createNanobotMonitor(nanobotApp: NanobotApp, opts: OpenAlertsInitOptions) {
  const engine = new OpenAlertsEngine(opts);
  engine.start();

  nanobotApp.on("event", (event) => {
    const translated = translateNanobotEvent(event);
    if (translated) engine.ingest(translated);
  });

  return engine;
}
```

**Option B: Middleware/wrapper (for frameworks without event hooks)**
```typescript
export function withOpenAlerts(handler: LLMHandler, engine: OpenAlertsEngine): LLMHandler {
  return async (input) => {
    const start = Date.now();
    try {
      const result = await handler(input);
      engine.ingest({ type: "llm.call", ts: start, outcome: "success", durationMs: Date.now() - start });
      return result;
    } catch (err) {
      engine.ingest({ type: "llm.call", ts: start, outcome: "error", error: String(err) });
      throw err;
    }
  };
}
```

### Step 4: Publish and use

The adapter is a standalone package that depends on `@steadwing/openalerts`.

### What You Don't Need to Touch

- **No changes to `@steadwing/openalerts`** — the core engine is framework-agnostic
- **No changes to other adapters** — each adapter is independent

---

## How to Add a New Alert Rule

Rules live in `src/core/rules.ts`.

```typescript
const myNewRule: AlertRuleDefinition = {
  id: "my-rule",
  defaultCooldownMs: 15 * 60 * 1000,
  defaultThreshold: 5,

  evaluate(event: OpenAlertsEvent, ctx: RuleContext): AlertEvent | null {
    if (event.type !== "llm.call") return null;
    if (!isRuleEnabled(ctx, "my-rule")) return null;

    // Your detection logic here
    // Use pushWindow(), countInWindow(), getRuleThreshold() helpers

    const fingerprint = "my-rule";
    return {
      type: "alert",
      id: makeAlertId("my-rule", fingerprint, ctx.now),
      ruleId: "my-rule",
      severity: "warn",
      title: "My alert title",
      detail: "What happened and why it matters.",
      ts: ctx.now,
      fingerprint,
    };
  },
};

// Add to the export array:
export const ALL_RULES: AlertRuleDefinition[] = [
  // ... existing rules
  myNewRule,
];
```

Rules automatically get:
- Cooldown deduplication (via fingerprint)
- Per-rule config override (users can set `rules.my-rule.threshold` and `rules.my-rule.enabled`)
- Hourly alert cap protection
- JSONL persistence
- Platform sync

---

## How to Add a New Alert Channel

Implement the `AlertChannel` interface:

```typescript
// pagerduty-channel.ts
import type { AlertChannel, AlertEvent } from "@steadwing/openalerts";

export class PagerDutyAlertChannel implements AlertChannel {
  readonly name = "pagerduty";

  constructor(private routingKey: string) {}

  async send(alert: AlertEvent, formatted: string): Promise<void> {
    await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: this.routingKey,
        event_action: "trigger",
        payload: {
          summary: formatted,
          severity: alert.severity === "critical" ? "critical" : "warning",
          source: "openalerts",
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}
```

Then pass the channel instance to `OpenAlertsEngine` via the `channels` option.

---

## Future Plans

### Short Term
- [ ] Add more OpenClaw event mappings as the SDK exposes new event types
- [ ] Token usage tracking (cost alerts when spend exceeds threshold)
- [ ] Rate limiting rule (alert when LLM calls exceed N/minute)
- [ ] Configurable alert message templates

### Medium Term
- [ ] `@steadwing/openalerts-langchain` — LangChain/LangGraph callback handler
- [ ] `@steadwing/openalerts-vercel-ai` — Vercel AI SDK telemetry hook
- [ ] `@steadwing/openalerts-mastra` — Mastra framework integration
- [ ] Hosted dashboard at openalerts.dev (event timeline, rule configuration UI)
- [ ] Email alert channel
- [ ] PagerDuty / Opsgenie integration

### Long Term
- [ ] Anomaly detection (ML-based, learns normal patterns and alerts on deviation)
- [ ] Multi-agent correlation (detect cascading failures across agents)
- [ ] Cost tracking and budget alerts (aggregate token spend across providers)
- [ ] SLA monitoring (response time percentiles, availability tracking)
- [ ] Incident management (alert grouping, acknowledgment, escalation)

---

## Key Design Decisions

**Why not just use Sentry/Datadog?**
They don't understand AI agent failure modes. A "stuck session" or "high error rate over 20 LLM calls" isn't something generic APM tools detect. OpenAlerts rules are purpose-built for agent monitoring.

**Why a separate event type system?**
Every framework uses different event names (`webhook.error` in OpenClaw, `llm.error` in LangChain, etc.). The universal `OpenAlertsEvent` type is the normalization layer that lets one set of rules work across all frameworks.

**Why JSONL and not SQLite?**
JSONL is zero-dependency, append-only, human-readable, and works on every platform including edge runtimes. For the volume of events we handle (hundreds per day, not millions), it's the right choice. The pruning logic keeps it bounded.

**Why fire-and-forget alert delivery?**
Alert delivery should never block the agent. If Telegram is down, we log the failure and move on. The alert is already persisted to JSONL and queued for platform sync — the user can always check `/alerts` later.
