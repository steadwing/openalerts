<p align="center">
  <h1 align="center">OpenAlerts</h1>
  <p align="center">
    Real-time monitoring, alerting, and observability for AI agents.<br/>
    Know when your agent breaks — before your users do.
  </p>
</p>

<p align="center">
  <a href="#installation">Installation</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="#what-it-monitors">Monitoring</a> &middot;
  <a href="#alert-rules">Alert Rules</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#roadmap">Roadmap</a>
</p>

---

AI agents fail silently. An LLM provider starts returning errors, a session gets stuck in a loop, your gateway goes down — and nobody knows until a user complains. OpenAlerts is a monitoring plugin for [OpenClaw](https://github.com/openclaw/openclaw) that watches for these failure patterns and alerts you through your existing messaging channels the moment something goes wrong.

**Key features:**

- 7 built-in alert rules covering LLM failures, stuck sessions, infrastructure errors, and more
- Real-time web dashboard with live event stream, system logs, and health overview
- Automatic event capture — 19 event sources, zero manual instrumentation
- Alerts delivered through OpenClaw's own channels (Telegram, Discord, Slack, etc.) — no extra bot tokens
- Zero-LLM-token chat commands: `/health`, `/alerts`, `/dashboard`
- Framework-agnostic core engine (future plugins for Nanobot, CrewAI, and more)

## Why Not Just Use OpenClaw's Built-In Logging?

OpenClaw ships with structured log files and diagnostic events. That's great for debugging after the fact. OpenAlerts adds the layer that's missing:

| Capability        | OpenClaw Built-in          | OpenAlerts Plugin                                              |
| ----------------- | -------------------------- | -------------------------------------------------------------- |
| Event capture     | Log to file, read later    | Real-time event bus with SSE streaming                         |
| Alerting          | None — check logs manually | Automatic alerts through your existing bot                     |
| Alert rules       | None                       | 7 rules with sliding windows, cooldowns, and thresholds        |
| Dashboard         | None                       | Live web UI with Activity, Logs, and Health tabs               |
| Session tracking  | Per-log-entry              | Grouped session flows — every step in one place                |
| Failure detection | Manual log review          | Detects stuck sessions, LLM errors, gateway down automatically |

OpenAlerts doesn't replace your logs — it watches them (and 18 other event sources) and tells you when something needs attention.

## Installation

### 1. Set Up OpenClaw

If you don't have OpenClaw yet, install it first:

```bash
# Install OpenClaw
npm install -g openclaw@latest

# Run the interactive setup wizard
openclaw onboard --install-daemon
```

This configures your gateway, workspace, model credentials, and messaging channels. See the [OpenClaw getting started guide](https://docs.openclaw.ai/start/getting-started) for details.

Verify your gateway is running:

```bash
openclaw gateway status
openclaw doctor              # diagnose & auto-fix config issues
```

### 2. Install the OpenAlerts Plugin

```bash
# Clone the repo
git clone https://github.com/steadwing/openalerts.git
cd openalerts

# Install dependencies and build
npm install
npm run build

# Install into OpenClaw
openclaw plugins install ./packages/alert
```

Or for local development, use link mode (symlinks instead of copying):

```bash
openclaw plugins install -l ./packages/alert
```

Alternatively, point to the path directly in `openclaw.json`:

```json
{
	"plugins": {
		"load": {
			"paths": ["/path/to/openalerts/packages/alert"]
		}
	}
}
```

### 3. Configure Alerts

Add alert settings under `plugins.entries.openalerts.config` in your `openclaw.json`:

```jsonc
{
	"plugins": {
		"entries": {
			"openalerts": {
				"enabled": true,
				"config": {
					"alertChannel": "telegram", // telegram | discord | slack | whatsapp | signal
					"alertTo": "YOUR_CHAT_ID", // your user/chat ID on that channel
				},
			},
		},
	},
}
```

Alerts are delivered through OpenClaw's own channel system — the same bot that handles your conversations sends the alerts. No separate bot tokens or webhook URLs to configure.

### 4. Verify

```bash
# Restart the gateway to load the plugin
openclaw gateway stop && openclaw gateway run

# Check it loaded
openclaw plugins list
# Should show: openalerts (OpenAlerts) — enabled
```

Send `/health` to your bot — you should get a live status summary back (zero LLM tokens consumed).

Open the dashboard at **http://127.0.0.1:18789/openalerts**

## Dashboard

The dashboard is a real-time web interface embedded directly in the OpenClaw gateway. No separate process, no external dependencies.

**Access:** `http://127.0.0.1:18789/openalerts` (or send `/dashboard` to your bot for the link)

### Activity Tab

The default view. A live event timeline showing everything happening inside your agent:

- **Session flows** — Events grouped by session ID into collapsible flows. Each flow shows event count, duration, token usage, tool calls, and status (active / completed / error).
- **Event detail** — Every event shows type, outcome, duration, and relevant metadata (tool name, model, queue depth, token count, error messages).
- **Color coding** — LLM (blue), Tool (purple), Agent (green), Session (orange), Infrastructure (red).
- **Real-time streaming** — Events appear instantly via Server-Sent Events. No polling needed.
- **Log integration** — Internal OpenClaw log entries (session state changes, run registrations, prompt execution, hook activity) stream alongside engine events for full visibility.

### System Logs Tab

A filtered, structured view of OpenClaw's internal log file:

- **Filters** — By subsystem (agent, session, gateway, etc.), log level (DEBUG, INFO, WARN, ERROR), or free-text search.
- **Parsed key-value pairs** — Extracts `sessionId`, `runId`, `durationMs`, queue depth, state transitions from log entries.
- **Auto-refresh** — New log entries appear every 3 seconds.

### Health Tab

System-wide health overview:

- **Status cards** — Uptime, active SSE listeners, total errors, platform status.
- **Stats table** — Messages processed, LLM errors, webhook errors, tool calls, agent starts, sessions.
- **Rule status** — All 7 alert rules with live OK/FIRING indicators.
- **Recent alerts** — Last 20 alerts with severity, title, detail, and timestamp.

### HTTP API

The dashboard exposes endpoints you can also query programmatically:

| Endpoint             | Method | Description                                                                        |
| -------------------- | ------ | ---------------------------------------------------------------------------------- |
| `/openalerts`        | GET    | Dashboard HTML page                                                                |
| `/openalerts/events` | GET    | SSE stream (`event: openalerts` for engine events, `event: oclog` for log entries) |
| `/openalerts/state`  | GET    | JSON snapshot (stats, uptime, alerts, rule status, cooldowns)                      |
| `/openalerts/logs`   | GET    | Parsed log entries (`?limit=200&after=<timestamp>`)                                |

## What It Monitors

The plugin automatically captures 19 event sources with zero manual instrumentation:

**12 Diagnostic Events** (via OpenClaw's `onDiagnosticEvent`):

| OpenClaw Event         | Mapped To                       | What It Captures                   |
| ---------------------- | ------------------------------- | ---------------------------------- |
| `message.processed`    | `llm.call`                      | LLM call outcome, duration, errors |
| `message.queued`       | `infra.queue_depth`             | Message entering the queue         |
| `model.usage`          | `llm.token_usage`               | Token counts and cost              |
| `session.stuck`        | `session.stuck`                 | Session age exceeding threshold    |
| `session.state`        | `session.start` / `session.end` | Session lifecycle transitions      |
| `diagnostic.heartbeat` | `infra.heartbeat`               | Health check with queue depth      |
| `webhook.error`        | `infra.error`                   | Inbound webhook failures           |
| `webhook.received`     | `custom`                        | Webhook arrival (informational)    |
| `webhook.processed`    | `custom`                        | Webhook processing complete        |
| `queue.lane.enqueue`   | `infra.queue_depth`             | Per-lane queue tracking            |
| `queue.lane.dequeue`   | `infra.queue_depth`             | Dequeue with wait time             |
| `heartbeat`            | `infra.heartbeat`               | Periodic heartbeat                 |

**7 Plugin Hooks** (via OpenClaw's `api.on()`):

| Hook                             | Mapped To                         | What It Captures                              |
| -------------------------------- | --------------------------------- | --------------------------------------------- |
| `after_tool_call`                | `tool.call` / `tool.error`        | Tool name, duration, parameters, errors       |
| `before_agent_start`             | `agent.start`                     | Agent initialization                          |
| `agent_end`                      | `agent.end` / `agent.error`       | Agent completion, message count, errors       |
| `session_start`                  | `session.start`                   | New or resumed session                        |
| `session_end`                    | `session.end`                     | Session close with duration and message count |
| `message_sent`                   | `custom` / `infra.error`          | Message delivery success or failure           |
| `gateway_start` / `gateway_stop` | `infra.heartbeat` / `infra.error` | Gateway lifecycle                             |

## Alert Rules

Seven rules are evaluated in real-time against every incoming event:

| Rule                | Condition                                          | Default Threshold | Cooldown | Severity |
| ------------------- | -------------------------------------------------- | ----------------- | -------- | -------- |
| **infra-errors**    | Infrastructure errors in a 5-minute sliding window | 3 errors          | 15 min   | ERROR    |
| **llm-errors**      | LLM call failures in a 5-minute sliding window     | 3 errors          | 15 min   | ERROR    |
| **session-stuck**   | Session not progressing for too long               | 120 seconds       | 30 min   | WARN     |
| **heartbeat-fail**  | Consecutive heartbeat delivery failures            | 3 consecutive     | 30 min   | ERROR    |
| **queue-depth**     | Items queued for processing exceed threshold       | 10 items          | 15 min   | WARN     |
| **high-error-rate** | Percentage of failed messages in the last 20       | 50%               | 30 min   | ERROR    |
| **gateway-down**    | No heartbeat received (watchdog timer, 30s ticks)  | 90 seconds        | 60 min   | CRITICAL |

### How Alerting Works

1. An event arrives (via diagnostic event or plugin hook — captured automatically)
2. The evaluator runs all 7 rules against the event
3. If a rule fires and its cooldown has elapsed, an `AlertEvent` is created
4. The alert is sent through OpenClaw's channel system (same bot, same conversation)
5. The alert is persisted to the event store for history
6. A global cap of 5 alerts per hour prevents alert storms

Every threshold, cooldown, and enabled state is configurable per-rule.

## Chat Commands

Three commands are available in any connected channel (Telegram, Discord, Slack, etc.):

| Command      | Description                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| `/health`    | System health snapshot: uptime, active alerts, channel activity, stats          |
| `/alerts`    | Recent alert history (last 100 alerts with severity, title, detail, timestamps) |
| `/dashboard` | Returns the dashboard URL for quick access                                      |

All commands are handled directly by the plugin — zero LLM tokens consumed.

## Configuration

Full configuration reference under `plugins.entries.openalerts.config` in `openclaw.json`:

```jsonc
{
	"plugins": {
		"entries": {
			"openalerts": {
				"enabled": true,
				"config": {
					// Where to send alerts (uses OpenClaw's own channel system)
					"alertChannel": "telegram", // telegram | discord | slack | whatsapp | signal
					"alertTo": "YOUR_CHAT_ID",

					// Global settings
					"cooldownMinutes": 15, // Default cooldown between repeated alerts
					"quiet": false, // Suppress non-critical alerts
					"maxLogSizeKb": 512, // Max event log size before pruning
					"maxLogAgeDays": 7, // Max event log age before pruning

					// Per-rule overrides
					"rules": {
						"gateway-down": {
							"threshold": 120000, // Increase timeout to 2 minutes
						},
						"high-error-rate": {
							"enabled": false, // Disable this rule entirely
						},
						"llm-errors": {
							"threshold": 5, // Require 5 errors instead of 3
							"cooldownMinutes": 30, // Longer cooldown
						},
					},
				},
			},
		},
	},
}
```

## Architecture

OpenAlerts is a monorepo with a shared core engine and framework-specific plugin adapters:

```
@steadwing/openalerts-core             Zero external dependencies
  |                          Rules engine, evaluator, event bus, state store, formatter
  |
@steadwing/openalerts            OpenClaw plugin
                             Translates 12 diagnostic events + 7 plugin hooks
                             Routes alerts through OpenClaw's channel system
                             Serves the live monitoring dashboard
```

The **core** package is framework-agnostic — it contains the rules engine, evaluator, event bus, alert dispatcher, and state persistence. It has zero external dependencies and can run anywhere.

The **alert** package is the OpenClaw-specific adapter. It subscribes to OpenClaw's diagnostic events and plugin hooks, translates them into universal event objects, and routes alerts through OpenClaw's existing messaging channels. It also serves the embedded web dashboard.

This separation means adding monitoring support for another framework (Nanobot, CrewAI, LangChain, etc.) only requires writing a new adapter package — the core engine stays the same.

## State Persistence

OpenAlerts persists all events and alerts to a JSONL file on disk:

- **Location:** `<stateDir>/events.jsonl` (managed by OpenClaw's plugin state directory)
- **Warm-start:** On engine start, the event log is loaded to restore cooldown timers and window states. No alert is re-fired for events that were already processed.
- **Auto-pruning:** Every 6 hours, entries older than 7 days or exceeding 512KB are removed.
- **Crash recovery:** Events are appended immediately, so the engine recovers its full state after any restart.

## Project Structure

```
openalerts/
  packages/
    core/                 @steadwing/openalerts-core         Shared engine (zero dependencies)
      src/
        engine.ts           OpenAlertsEngine (start, stop, ingest, bus, state)
        rules.ts            7 built-in alert rule definitions
        evaluator.ts        processEvent(), warmFromHistory(), processWatchdogTick()
        event-bus.ts        Pub/sub event distribution
        alert-channel.ts    AlertDispatcher (parallel delivery, failure isolation)
        formatter.ts        Alert message formatting, /health and /alerts output
        store.ts            JSONL append, read, prune
        platform.ts         Optional cloud sync
        types.ts            All TypeScript type definitions

    alert/                @steadwing/openalerts        OpenClaw plugin
      index.ts              Plugin entry — service registration, hook wiring
      src/
        adapter.ts            Event translation (19 sources), OpenClawAlertChannel
        commands.ts           /health, /alerts, /dashboard command handlers
        dashboard-html.ts     Embedded web UI (Activity, Logs, Health tabs)
        dashboard-routes.ts   HTTP handler, SSE streaming, log tailing
```

## Development

```bash
npm install              # Install all workspace dependencies
npm run typecheck        # Type-check all packages
npm run build            # Build: core → alert
npm run clean            # Remove all dist/ directories
```

The monorepo uses npm workspaces. Build order matters — core must build before alert. The `build` script handles this automatically.

## Roadmap

**Plugin refinements:**

- [ ] Richer event detail cards in the dashboard — latency histograms, token usage graphs
- [ ] Custom rule definitions — define your own alert rules with threshold/window/cooldown
- [ ] Alert escalation policies — severity-based routing (CRITICAL to phone, WARN to Slack)
- [ ] Rate limiting & circuit breaker detection rules

**New framework plugins:**

- [ ] `@steadwing/openalerts-nanobot` — Nanobot adapter
- [ ] `@steadwing/openalerts-crewai` — CrewAI adapter
- [ ] `@steadwing/openalerts-langchain` — LangChain adapter
- [ ] `@steadwing/openalerts-mastra` — Mastra adapter

Each new plugin will be a thin adapter in this same repo, translating framework-specific events into the shared OpenAlerts event schema. The core engine, rules, and dashboard are reused across all adapters.

## License

MIT

<!-- # Steadwing-alerts

Universal monitoring & alerting SDK for AI agents.

Steadwing watches your AI agents (LLM calls, tool execution, session health, infrastructure) and texts you when something goes wrong. Works with any Node.js agent framework.

## Why This Exists

AI agents fail silently. An LLM starts returning errors, a session gets stuck, your gateway goes down — and nobody knows until a user complains. Steadwing sits alongside your agent and watches for these failure patterns, then alerts you through Telegram, Slack, Discord, or any webhook.

## Architecture

```
@steadwing/core          Zero external dependencies
  |                      Rules engine, evaluator, event bus, store, formatter
  |
@steadwing/node          Generic Node.js SDK
  |                      init() / captureEvent() / shutdown()
  |                      Built-in alert channels (Telegram, Slack, Discord, webhook, console)
  |                      OTLP receiver for OpenTelemetry spans
  |
@steadwing/alert         OpenClaw adapter (thin wrapper)
                         Translates OpenClaw diagnostic events to SteadwingEvent
                         Bridges alert delivery through OpenClaw's channel system
```

**Why three packages?**

- **core** has zero dependencies. It can run anywhere — browser, edge, Deno, Bun. The rules, evaluator, and engine are completely framework-agnostic. If you're building your own integration, this is all you need.
- **node** adds Node.js conveniences: a global `init()/shutdown()` lifecycle, built-in alert channels that call external APIs directly (Telegram Bot API, Slack webhooks, etc.), and an OTLP span receiver for apps already exporting OpenTelemetry traces.
- **alert** is the OpenClaw-specific adapter. It subscribes to OpenClaw's `onDiagnosticEvent`, translates those events into universal `SteadwingEvent` objects, and routes alerts through OpenClaw's built-in channel system (so alerts go through the same Telegram bot your agent uses).

This means adding support for a new framework (Nanobot, LangChain, Mastra, etc.) only requires writing a thin adapter — no changes to core or node.

## What It Monitors

Seven built-in alert rules:

| Rule                | Watches For                               | Severity |
| ------------------- | ----------------------------------------- | -------- |
| **infra-errors**    | 3+ infrastructure errors in 5 minutes     | ERROR    |
| **llm-errors**      | 3+ LLM call failures in 5 minutes         | ERROR    |
| **session-stuck**   | Session not progressing for 120+ seconds  | WARN     |
| **heartbeat-fail**  | 3 consecutive heartbeat delivery failures | ERROR    |
| **queue-depth**     | 10+ items queued for processing           | WARN     |
| **high-error-rate** | 50%+ of last 20 messages failed           | ERROR    |
| **gateway-down**    | No heartbeat for 90+ seconds              | CRITICAL |

All thresholds and cooldowns are configurable per-rule.

## Quick Start

### With OpenClaw

The plugin is already installed and configured. It activates automatically when the gateway starts.

```
openclaw plugins list        # Should show "alert" as loaded
```

Send `/health` or `/alerts` to your bot to check status.

### With Any Node.js App

```typescript
import { init, captureEvent, TelegramBotAlertChannel } from "@steadwing/node";

// Two lines to start monitoring
init({
	channels: [new TelegramBotAlertChannel("BOT_TOKEN", "CHAT_ID")],
});

// Instrument your LLM calls
captureEvent({
	type: "llm.call",
	ts: Date.now(),
	outcome: "success",
	durationMs: 1200,
	channel: "telegram",
});
```

### With OpenTelemetry

If your app already exports OTLP spans (Phoenix, Arize, LangSmith conventions):

```typescript
import { init } from "@steadwing/node";
import { otlpSpanToEvent } from "@steadwing/node/otel";

init({ channels: [...] });

// In your OTLP exporter callback:
const event = otlpSpanToEvent(span);
if (event) captureEvent(event);
```

## Alert Channels

| Channel      | Setup                                              |
| ------------ | -------------------------------------------------- |
| **Console**  | Default. Logs to stderr with color.                |
| **Telegram** | `new TelegramBotAlertChannel(botToken, chatId)`    |
| **Slack**    | `new SlackWebhookAlertChannel(webhookUrl)`         |
| **Discord**  | `new DiscordWebhookAlertChannel(webhookUrl)`       |
| **Webhook**  | `new GenericWebhookAlertChannel(url, { headers })` |

OpenClaw adapter uses OpenClaw's own channel system — alerts go through the same bot.

## Universal Event Types

```
llm.call, llm.error, llm.token_usage
tool.call, tool.error
agent.start, agent.end, agent.error, agent.stuck
session.start, session.end, session.stuck
infra.error, infra.heartbeat, infra.queue_depth
custom, watchdog.tick
```

## Configuration (OpenClaw)

In `openclaw.json` under `plugins.entries.alert.config`:

```json
{
	"alertChannel": "telegram",
	"alertTo": "5162109058",
	"cooldownMinutes": 15,
	"quiet": false,
	"rules": {
		"gateway-down": { "threshold": 120000 },
		"high-error-rate": { "enabled": false }
	}
}
```

## Platform Sync

Optional. Add `apiKey` to push events to `steadwing.dev` for dashboards and diagnosis. Events are batched (100 max) and flushed every 5 minutes with retry logic.

## Project Structure

```
packages/
  core/           @steadwing/core     Zero-dep engine
  node/           @steadwing/node     Node.js SDK + channels
  alert/          @steadwing/alert    OpenClaw adapter
```

## Development

```bash
npm install              # Install all workspace dependencies
npm run typecheck        # Type-check all packages (zero errors = good)
npm run build            # Build all packages to dist/
npm run clean            # Remove all dist/ directories
```

## License

MIT -->
