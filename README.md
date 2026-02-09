# Steadwing-alerts

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

MIT
