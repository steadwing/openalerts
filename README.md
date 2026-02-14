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

Add to your `openclaw.json`:

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

### 3. Restart & verify

```bash
openclaw gateway stop && openclaw gateway run
```

Send `/health` to your bot. You should get a live status report back — zero LLM tokens consumed.

That's it. OpenAlerts is now watching your agent.

## Alert Rules

Seven rules run against every event in real-time:

| Rule | Watches for | Severity |
|---|---|---|
| **llm-errors** | 3+ LLM failures in 5 minutes | ERROR |
| **infra-errors** | 3+ infrastructure errors in 5 minutes | ERROR |
| **gateway-down** | No heartbeat for 90+ seconds | CRITICAL |
| **session-stuck** | Session idle for 120+ seconds | WARN |
| **high-error-rate** | 50%+ of last 20 messages failed | ERROR |
| **queue-depth** | 10+ items queued | WARN |
| **heartbeat-fail** | 3 consecutive heartbeat failures | ERROR |

All thresholds and cooldowns are [configurable per-rule](#configuration).

## Configuration

Full config reference under `plugins.entries.openalerts.config`:

```jsonc
{
  "alertChannel": "telegram",       // telegram | discord | slack | whatsapp | signal
  "alertTo": "YOUR_CHAT_ID",        // chat/user ID on that channel
  "cooldownMinutes": 15,            // minutes between repeated alerts (default: 15)
  "quiet": false,                   // true = log only, no messages sent

  "rules": {
    "gateway-down": {
      "threshold": 120000            // override: 2 min instead of 90s
    },
    "high-error-rate": {
      "enabled": false               // disable a rule entirely
    },
    "llm-errors": {
      "threshold": 5,                // require 5 errors instead of 3
      "cooldownMinutes": 30          // longer cooldown for this rule
    }
  }
}
```

## Dashboard

A real-time web dashboard is embedded in the gateway at:

```
http://127.0.0.1:18789/openalerts
```

- **Activity** — Live event timeline with session flows, tool calls, LLM usage
- **System Logs** — Filtered, structured logs with search
- **Health** — Rule status, alert history, system stats

## Commands

Zero-token chat commands available in any connected channel:

| Command | What it does |
|---|---|
| `/health` | System health snapshot — uptime, active alerts, stats |
| `/alerts` | Recent alert history with severity and timestamps |
| `/dashboard` | Returns the dashboard URL |

## Architecture

```
src/core/          Framework-agnostic engine, zero dependencies
                   Rules engine, evaluator, event bus, state store, formatter

src/plugin/        OpenClaw adapter plugin
                   Event translation, alert routing, dashboard, chat commands
```

Everything ships as a single `@steadwing/openalerts` package. The core is completely framework-agnostic — adding monitoring for a new framework only requires writing an adapter.

## Development

```bash
npm install        # install dependencies
npm run build      # compile TypeScript
npm run typecheck  # type-check without emitting
npm run clean      # remove dist/
```

## License

Apache-2.0
