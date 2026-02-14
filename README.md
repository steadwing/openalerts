<p align="center">
  <h1 align="center">OpenAlerts</h1>
  <p align="center">
    An alerting layer for agentic frameworks.
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@steadwing/openalerts"><img src="https://img.shields.io/npm/v/@steadwing/openalerts?style=flat&color=blue" alt="npm"></a>
  <a href="https://github.com/steadwing/openalerts/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="License"></a>
  <a href="https://github.com/steadwing/openalerts/stargazers"><img src="https://img.shields.io/github/stars/steadwing/openalerts?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#alert-rules">Alert Rules</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="#commands">Commands</a>
</p>

---

AI agents fail silently. LLM errors, stuck sessions, gateway outages — nobody knows until a user complains.

OpenAlerts watches your agent in real-time and alerts you the moment something goes wrong. A framework-agnostic core with adapter plugins — starting with [OpenClaw](https://github.com/openclaw/openclaw).

## Quickstart

> Currently supports OpenClaw. More framework adapters coming soon.

### 1. Install

```bash
openclaw plugins install @steadwing/openalerts
```

### 2. Configure

If you already have a channel paired with OpenClaw (e.g. Telegram via `openclaw pair`), **no config is needed** — OpenAlerts auto-detects where to send alerts.

Otherwise, set it explicitly in `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openalerts": {
        "enabled": true,
        "config": {
          "alertChannel": "telegram",  // telegram | discord | slack | whatsapp | signal
          "alertTo": "YOUR_CHAT_ID"
        }
      }
    }
  }
}
```

**Auto-detection priority:** explicit config > static `allowFrom` in channel config > pairing store.

### 3. Restart & verify

```bash
openclaw gateway stop && openclaw gateway run
```


Send `/health` to your bot. You should get a live status report back — zero LLM tokens consumed.

That's it. OpenAlerts is now watching your agent.

## Dashboard

A real-time web dashboard is embedded in the gateway at:

```
http://127.0.0.1:18789/openalerts
```

- **Activity** — Live event timeline with session flows, tool calls, LLM usage
- **System Logs** — Filtered, structured logs with search
- **Health** — Rule status, alert history, system stats

## Alert Rules

Eight rules run against every event in real-time:

| Rule | Watches for | Severity |
|---|---|---|
| **llm-errors** | 1+ LLM/agent failure in 1 minute | ERROR |
| **infra-errors** | 1+ infrastructure error in 1 minute | ERROR |
| **gateway-down** | No heartbeat for 30+ seconds | CRITICAL |
| **session-stuck** | Session idle for 120+ seconds | WARN |
| **high-error-rate** | 50%+ of last 20 messages failed | ERROR |
| **queue-depth** | 10+ items queued | WARN |
| **tool-errors** | 1+ tool failure in 1 minute | WARN |
| **heartbeat-fail** | 3 consecutive heartbeat failures | ERROR |

All thresholds and cooldowns are [configurable per-rule](#advanced-configuration).

## LLM-Enriched Alerts

By default, OpenAlerts uses your configured LLM model to enrich alerts with a human-friendly summary and an actionable suggestion. The enrichment is appended below the original alert detail:

```
1 agent error(s) on unknown in the last minute. Last: 401 Incorrect API key...

Summary: Your OpenAI API key is invalid or expired — the agent cannot make LLM calls.
Action: Update your API key in ~/.openclaw/.env with a valid key from platform.openai.com/api-keys
```

- **Model**: reads from `agents.defaults.model.primary` in your `openclaw.json` (e.g. `"openai/gpt-4o-mini"`)
- **API key**: reads from the corresponding environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, etc.)
- **Supported providers**: OpenAI, Anthropic, Groq, Together, DeepSeek (and any OpenAI-compatible API)
- **Graceful fallback**: if the LLM call fails or times out (10s), the original alert is sent unchanged

To disable LLM enrichment, set `"llmEnriched": false` in your plugin config:

```jsonc
{
  "plugins": {
    "entries": {
      "openalerts": {
        "config": {
          "llmEnriched": false
        }
      }
    }
  }
}
```

## Advanced Configuration

Each rule can be individually tuned or disabled. You can also set global options like `cooldownMinutes` (default: `15`) and `quiet: true` for log-only mode.

**Step 1.** Add a `rules` object inside `plugins.entries.openalerts.config` in your `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openalerts": {
        "enabled": true,
        "config": {
          "rules": {
            "llm-errors": { "threshold": 5 },
            "infra-errors": { "cooldownMinutes": 30 },
            "high-error-rate": { "enabled": false },
            "gateway-down": { "threshold": 60000 }
          }
        }
      }
    }
  }
}
```

**Step 2.** Restart the gateway to apply:

```bash
openclaw gateway stop && openclaw gateway run
```

### Rule reference

| Rule | `threshold` unit | Default |
|---|---|---|
| `llm-errors` | Error count in 1 min window | `1` |
| `infra-errors` | Error count in 1 min window | `1` |
| `gateway-down` | Milliseconds without heartbeat | `30000` (30s) |
| `session-stuck` | Milliseconds idle | `120000` (2 min) |
| `high-error-rate` | Error percentage (0-100) | `50` |
| `queue-depth` | Number of queued items | `10` |
| `tool-errors` | Error count in 1 min window | `1` |
| `heartbeat-fail` | Consecutive failures | `3` |

Every rule also accepts:
- **`enabled`** — `false` to disable the rule (default: `true`)
- **`cooldownMinutes`** — minutes before the same rule can fire again (default: `15`)

## Commands

Zero-token chat commands available in any connected channel:

| Command | What it does |
|---|---|
| `/health` | System health snapshot — uptime, active alerts, stats |
| `/alerts` | Recent alert history with severity and timestamps |
| `/dashboard` | Returns the dashboard URL |

## Development

```bash
npm install        # install dependencies
npm run build      # compile TypeScript
npm run typecheck  # type-check without emitting
npm run clean      # remove dist/
```

## License

Apache-2.0
