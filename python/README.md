# OpenAlerts

Real-time monitoring & alerting SDK for AI agent frameworks. Python port of [openalerts](https://github.com/steadwing/openalerts).

One line to enable monitoring — alerts go to Slack, Discord, or any webhook.

## Install

```bash
pip install openalerts
```

## Quick Start

```python
import openalerts

await openalerts.init({
    "channels": [
        {"type": "slack", "webhook_url": "https://hooks.slack.com/services/..."},
    ]
})

# Use your agents as normal — they're automatically monitored
agent = await Manus.create()
await agent.run("Research quantum computing")
```

That's it. Every LLM call, tool execution, agent step, and error is tracked. When things go wrong, you get an alert. Cleanup happens automatically on exit. All events are persisted to `~/.openalerts/` as JSONL.

## Dashboard

A real-time dashboard starts automatically at [http://localhost:9464/openalerts](http://localhost:9464/openalerts).

Three tabs: **Activity** (live timeline grouped by agent run), **Health** (stats & rule statuses), **Debug** (engine internals).

Disable with `"dashboard": False`. Change port with `"dashboard_port": 8080`.

### Standalone Dashboard (`openalerts serve`)

By default, the dashboard runs in-process — when your agent exits, the dashboard dies too. For a **persistent dashboard** that survives agent restarts, use `openalerts serve`:

```bash
# Terminal 1 — start persistent dashboard (stays running)
openalerts serve

# Terminal 2 — run your agent (writes events, no dashboard of its own)
python my_agent.py

# Terminal 2 — run another agent later — dashboard still shows everything
python another_agent.py
```

The standalone dashboard reads historical events from `~/.openalerts/events.jsonl` on startup, then tails the file for new events written by agent processes.

**Agent setup for standalone mode** — disable the in-process dashboard so only the standalone one runs:

```python
import openalerts

await openalerts.init({
    "dashboard": False,  # don't start in-process dashboard
    "channels": [...]
})
```

**Options:**

```
openalerts serve [--port 9464] [--state-dir ~/.openalerts] [--log-level INFO]
```

| Flag | Default | Description |
|---|---|---|
| `--port` | `9464` | Dashboard HTTP port |
| `--state-dir` | `~/.openalerts` | Directory containing `events.jsonl` |
| `--log-level` | `INFO` | Logging verbosity |

Also works via `python -m openalerts serve`.

## Channels

```python
# Slack
{"type": "slack", "webhook_url": "https://hooks.slack.com/services/..."}

# Discord
{"type": "discord", "webhook_url": "https://discord.com/api/webhooks/..."}

# Generic webhook
{"type": "webhook", "webhook_url": "https://your-server.com/alerts", "headers": {"Authorization": "Bearer ..."}}
```

Or via environment variables (no code changes needed):

```bash
OPENALERTS_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
OPENALERTS_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
OPENALERTS_WEBHOOK_URL="https://your-server.com/alerts"
```

## Alert Rules

6 built-in rules, all configurable:

| Rule | Fires When | Severity |
|---|---|---|
| `llm-errors` | LLM API failures in 1-min window | ERROR |
| `tool-errors` | Tool execution failures in 1-min window | WARN |
| `agent-stuck` | Agent enters stuck state | WARN |
| `token-limit` | Token limit exceeded | ERROR |
| `step-limit-warning` | Agent reaches 80% of max_steps | WARN |
| `high-error-rate` | >50% of last 20 tool calls failed | ERROR |

## Configuration

```python
await openalerts.init({
    "channels": [...],
    "rules": {
        "llm-errors": {"threshold": 3},
        "high-error-rate": {"enabled": False},
        "tool-errors": {"cooldown_seconds": 1800},
    },
    "cooldown_seconds": 900,
    "max_alerts_per_hour": 5,
    "quiet": False,
    "dashboard": True,
    "dashboard_port": 9464,
    "state_dir": "~/.openalerts",
    "log_level": "INFO",
})
```

## API

```python
engine = await openalerts.init({...})   # async init
engine = openalerts.init_sync({...})    # sync init
await openalerts.send_test_alert()      # verify channels
engine = openalerts.get_engine()        # get engine instance
await openalerts.shutdown()             # optional — runs automatically on exit
```

## License

Apache-2.0
