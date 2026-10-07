# OpenAlerts – Architecture Handover

## 1. What it is

OpenAlerts watches AI agents while they run. When something goes wrong (LLM errors, tool errors, a stuck agent, high cost), it sends an alert and shows it on a live dashboard. Everything runs on the user's own machine. There is no cloud part.

The repo has two separate products. They share no code.

| | Node (`node/`) | Python (`python/`) |
|---|---|---|
| Published as | `@steadwing/openalerts` on npm (0.2.8) | `openalerts` on PyPI (0.1.5) |
| Monitors | OpenClaw | CrewAI, OpenManus, nanobot |
| Runs as | A separate program next to OpenClaw | A library inside the user's agent program |
| Gets data from | OpenClaw's WebSocket gateway and its files | Wrapping framework methods, or CrewAI's event bus |
| Stores data in | `~/.openalerts/openalerts.db` (SQLite) and `~/.openalerts/events/events.jsonl` | `~/.openalerts/events.jsonl` and `~/.openalerts/collections/` |
| Dashboard | http://127.0.0.1:4242 | http://localhost:9464/openalerts |
| Sends alerts to | Telegram, webhook, console | Slack, Discord, webhook |
| Extras | REST API, MCP server | `openalerts serve` (a dashboard that keeps running after the agent stops) |

## 2. How it works (both packages)

```
agent does something
  -> adapter turns it into an event (for example "llm.error" or "tool.call")
  -> engine.ingest(event)
       -> save it to disk
       -> update dashboard data and push it to the browser
       -> run every rule on it
            -> did a rule return an alert?
                 -> same alert sent recently (cooldown, default 15 min)? skip
                 -> already 5 alerts this hour? skip
                 -> otherwise send it to every channel
```

Words used in the code:
- **Event**: one thing that happened. It has a type, a time, and some details.
- **Adapter**: the only part that knows about a specific framework.
- **Rule**: looks at each event and decides whether to alert. It keeps a short list of recent events to count things like "errors in the last minute".
- **Fingerprint**: the key that means "this is the same problem". Cooldowns use it.
- **Warm start**: on restart, old alerts are read back from the JSONL file so cooldowns carry on. Old events are not checked again.

Errors are caught almost everywhere, so monitoring never crashes the agent. The downside is that when something breaks, it usually breaks silently.

## 3. Node package (OpenClaw)

**Start here:** `node/src/cli.ts`, function `startDaemon()`. It sets everything up in this order: config, SQLite, channels, engine, read OpenClaw files, HTTP server, file watcher, gateway connection.

**Where the data comes from:**
1. `watchers/gateway.ts` connects to the OpenClaw gateway (`ws://127.0.0.1:18789`) as a read-only operator. The token is read automatically from `~/.openclaw/openclaw.json`. If the connection drops, it reconnects by itself.
2. `watchers/gateway-adapter.ts` handles each gateway message. It does three things: it creates an engine event (for the rules), writes to SQLite (for the dashboard), and builds a live message for the browser.
   - `health` / `tick` become a heartbeat (with queue depth)
   - a `chat` error becomes `llm.error`; a final `chat` becomes `llm.token_usage`
   - `agent` start / end / tool use become `agent.start` / `agent.end` / `tool.call`
   - `exec.completed` with a non-zero exit code becomes `tool.error`
3. `readers/openclaw.ts` and `watchers/files.ts` read files in `~/.openclaw/` (agent docs like SOUL.md, cron jobs, delivery queue, config) into SQLite, and read them again when they change. This data is only for the dashboard. It never triggers alerts.

**Other parts:**
- `core/`: the engine, the 10 rules, the evaluator (cooldown and hourly cap), and the JSONL log.
- `db/`: SQLite schema and queries. There are no migrations. Tables are created with `CREATE TABLE IF NOT EXISTS`, so a new column will not reach existing users unless you add a migration step.
- `server/`: a plain `node:http` REST API, a live stream to the browser (SSE), and the dashboard. The whole dashboard is one HTML/JS string in `server/dashboard.ts`. Inside that JS, backticks must be written as `\x60`.
- `mcp/`: `openalerts mcp` lets AI assistants (Claude Code, Cursor) read the monitoring data. It asks the running daemon first, and reads SQLite directly if the daemon is off. Its list of rules is a hand-written copy in `mcp/tools.ts` and `mcp/resources.ts`.

**Config:** `~/.openalerts/config.json` (created by `openalerts init`). Channel types that work: `telegram` (`token`, `chatId`), `webhook` (`webhookUrl`) and `console`. Rule settings: `rules.<id>.enabled`, `.threshold`, `.cooldownMinutes`.

## 4. Python package (CrewAI, OpenManus, nanobot)

**Start here:** `python/src/__init__.py`, function `init()`. It builds the config, creates the engine and channels, loads the adapter for the chosen framework, calls `adapter.patch()`, starts the engine and the dashboard, and registers cleanup for when the process exits. There is one global engine per process. If no framework is given, it uses `openmanus`.

**Adapters** (`src/adapters/`):
- **OpenManus and nanobot** replace framework methods with wrappers that send events (this is called monkey-patching). Examples: `BaseAgent.run`, `LLM.ask`, `AgentLoop._process_message`, `ToolRegistry.execute`. The current session id is stored in Python `contextvars` (`adapters/base.py`). That is how nested tool and LLM calls get linked to the right run.
- **CrewAI** does not patch anything. It adds a listener to CrewAI's own event bus. CrewAI runs these listeners on other threads, so the adapter passes events back to the main event loop with `asyncio.run_coroutine_threadsafe`. Mapping: a Crew is a session, an Agent is a sub-agent, and a Task is a step.

Some patches depend on private method names in other projects (like `_process_message`). A new release of those frameworks can quietly break monitoring.

**Other parts:**
- `core/`: the engine, the 7 rules, the evaluator, the JSONL store, config (pydantic) and the Slack/Discord message formats.
- `collections/`: sessions and actions for the dashboard. They are saved to `~/.openalerts/collections/` every 5 seconds.
- `dashboard/`: a small HTTP and live-stream server built on asyncio, plus `html.py`, which holds the page.
- `cli.py`: `openalerts serve` runs as a separate process. Every 0.5 seconds it reads new lines from `events.jsonl` and shows them. The agent process sends the alerts; `serve` only displays them.

**Config:** a dict passed to `init()` (see `python/README.md`). These environment variables also work: `OPENALERTS_SLACK_WEBHOOK_URL`, `OPENALERTS_DISCORD_WEBHOOK_URL`, `OPENALERTS_WEBHOOK_URL`, `OPENALERTS_QUIET` and `OPENALERTS_STATE_DIR`. They are only read when `init()` gets a dict, not an `OpenAlertsConfig` object.

## 5. Node and Python behave differently

The Python code was copied from the Node design, but the two have drifted apart:
- Times are in milliseconds in Node and in seconds in Python.
- Only `llm-errors`, `tool-errors` and `high-error-rate` exist in both. `high-error-rate` counts LLM calls in Node but tool calls in Python.
- The hourly cap is fixed at 5 in Node (the `maxAlertsPerHour` config is ignored). In Python it can be changed.
- When an alert fires, Node sends it in the background. Python waits for Slack or Discord to answer (up to 5 seconds) before the agent's call continues.

## 6. Build, test, release

```
make install                  # npm install + uv sync

cd node
npm run build                 # TypeScript -> dist/
npm run typecheck             # the only check Node has
node --experimental-sqlite dist/cli.js start

cd python
uv sync --extra dev           # add --extra crewai OR --extra nanobot (not both) to try one
uv run pytest                 # finds no tests today (exit code 5)
uv run openalerts serve
```

**Release:** `.github/workflows/publish.yml` publishes when you push a tag named `node-vX.Y.Z` (npm) or `python-vX.Y.Z` (PyPI). It needs the GitHub secrets `NPM_TOKEN` and `PYPI_TOKEN`.
- Python releases have gone through this correctly (`python-v0.1.0` to `python-v0.1.5`).
- Node releases have not. npm 0.2.8 was published by hand from a laptop.
- `make tag-node` and `make tag-python` create tags with a slash (`node/vX`), which CI ignores. Until the Makefile is fixed, create the tag yourself with a dash.


