<p align="center">
  <h1 align="center">OpenAlerts</h1>
  <p align="center">
    An alerting layer for agentic frameworks.
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@steadwing/openalerts"><img src="https://img.shields.io/npm/v/@steadwing/openalerts?style=flat&color=blue" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@steadwing/openalerts"><img src="https://img.shields.io/npm/dt/@steadwing/openalerts?style=flat&color=blue" alt="npm"></a>
  <a href="https://github.com/steadwing/openalerts/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="License"></a>
  <a href="https://github.com/steadwing/openalerts/stargazers"><img src="https://img.shields.io/github/stars/steadwing/openalerts?style=flat" alt="GitHub stars"></a>
  <a href="https://discord.gg/4rUP86tSXn"><img src="https://img.shields.io/badge/discord-community-5865F2?style=flat" alt="Discord"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#alert-rules">Alert Rules</a> &middot;
  <a href="#llm-enriched-alerts">LLM Enrichment</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="#commands">Commands</a>
</p>

---

AI agents fail silently. LLM errors, stuck sessions, gateway outages — nobody knows until a user complains.

OpenAlerts watches your agent in real-time and alerts you the moment something goes wrong. Runs fully locally — no external services, no cloud dependencies, everything stays on your machine. A framework-agnostic core with adapter plugins — starting with [OpenClaw](https://github.com/openclaw/openclaw).

## Quickstart

> Currently supports OpenClaw. More framework adapters coming soon.
> This project is under revamp for the next few hours

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
					"alertChannel": "telegram", // telegram | discord | slack | whatsapp | signal
					"alertTo": "YOUR_CHAT_ID",
				},
			},
		},
	},
}
```

**Auto-detection priority:** explicit config > static `allowFrom` in channel config > pairing store.

### 3. Restart & verify

```bash
openclaw gateway stop && openclaw gateway run
```

Send `/health` to your bot. You should get a live status report back — zero LLM tokens consumed.

That's it. OpenAlerts is now watching your agent.

## Demo

https://github.com/user-attachments/assets/0b6ed26e-1eb0-47b2-ae4f-947516f024b4

## Dashboard

A real-time web dashboard is embedded in the gateway at:

```
http://127.0.0.1:18789/openalerts
```

- **Activity** — Step-by-step execution timeline with tool calls, LLM usage, costs
- **Sessions** — Active sessions with cost/token aggregation
- **Execs** — Shell command executions with output capture
- **System Logs** — Filtered, structured logs with search
- **Health** — Rule status, alert history, system stats
- **Debug** — State snapshot for troubleshooting

## Alert Rules

Ten rules run against every event in real-time. All thresholds and cooldowns are configurable.

| Rule              | Watches for                           | Severity | Threshold (default) |
| ----------------- | ------------------------------------- | -------- | ------------------- |
| `llm-errors`      | LLM/agent failures in 1 min window    | ERROR    | `1` error           |
| `infra-errors`    | Infrastructure errors in 1 min window | ERROR    | `1` error           |
| `gateway-down`    | No heartbeat received                 | CRITICAL | `30000` ms (30s)    |
| `session-stuck`   | Session idle too long                 | WARN     | `120000` ms (2 min) |
| `high-error-rate` | Message failure rate over last 20     | ERROR    | `50`%               |
| `queue-depth`     | Queued items piling up                | WARN     | `10` items          |
| `tool-errors`     | Tool failures in 1 min window         | WARN     | `1` error           |
| `heartbeat-fail`  | Consecutive heartbeat failures        | ERROR    | `3` failures        |

Every rule also accepts:

- **`enabled`** — `false` to disable the rule (default: `true`)
- **`cooldownMinutes`** — minutes before the same rule can fire again (default: `15`)

To tune rules, add a `rules` object in your plugin config:

```jsonc
{
	"plugins": {
		"entries": {
			"openalerts": {
				"config": {
					"cooldownMinutes": 10,
					"rules": {
						"llm-errors": { "threshold": 5 },
						"infra-errors": { "cooldownMinutes": 30 },
						"high-error-rate": { "enabled": false },
						"gateway-down": { "threshold": 60000 },
					},
				},
			},
		},
	},
}
```

Set `"quiet": true` at the config level for log-only mode (no messages sent).

## LLM-Enriched Alerts

OpenAlerts can optionally use your configured LLM to enrich alerts with a human-friendly summary and an actionable suggestion. **This feature is disabled by default** — opt in by setting `"llmEnriched": true` in your plugin config:

```jsonc
{
	"plugins": {
		"entries": {
			"openalerts": {
				"config": {
					"llmEnriched": true,
				},
			},
		},
	},
}
```

When enabled, alerts include an LLM-generated summary and action:

```
1 agent error(s) on unknown in the last minute. Last: 401 Incorrect API key...

Summary: Your OpenAI API key is invalid or expired — the agent cannot make LLM calls.
Action: Update your API key in ~/.openclaw/.env with a valid key from platform.openai.com/api-keys
```

- **Model**: reads from `agents.defaults.model.primary` in your `openclaw.json` (e.g. `"openai/gpt-4o-mini"`)
- **API key**: reads from the corresponding environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, etc.)
- **Supported providers**: OpenAI, Anthropic, Groq, Together, DeepSeek (and any OpenAI-compatible API)
- **Graceful fallback**: if the LLM call fails or times out (10s), the original alert is sent unchanged

## Commands

Zero-token chat commands available in any connected channel:

| Command      | What it does                                          |
| ------------ | ----------------------------------------------------- |
| `/health`    | System health snapshot — uptime, active alerts, stats |
| `/alerts`    | Recent alert history with severity and timestamps     |
| `/dashboard` | Returns the dashboard URL                             |

## Roadmap

- [ ] [nanobot](https://github.com/HKUDS/nanobot) adapter
- [ ] [OpenManus](https://github.com/FoundationAgents/OpenManus) adapter

## Development

```bash
npm install        # install dependencies
npm run build      # compile TypeScript
npm run typecheck  # type-check without emitting
npm run clean      # remove dist/
```

## License

Apache-2.0

---

<p align="center">Made with ❤️ by Steadwing Team</p>
