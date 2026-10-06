# OpenAlerts – Architecture Handover

Written by Dev Khant, October 2026. Based on `main` at commit `faa1ddf`.

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

## 7. Known problems (most important first)

1. **The npm package has no `openalerts` command.** `node/package.json` points to `bin/openalerts.js`, but `bin/` is listed in `node/.gitignore`, and the file was lost when the code moved in February. The published 0.2.8 does not contain it. This file used to start `dist/cli.js` with `--experimental-sqlite`. To fix it, restore the file with `git show 63a04e7^:standalone/bin/openalerts.js > node/bin/openalerts.js`, remove `bin/` from `node/.gitignore`, and release through CI.
2. **npm 0.2.8 also includes old, unused code** (`dist/plugin/`, `dist/collections/`), because it was built from an old local `dist/` folder. Always clean before building, or only publish from CI.
3. **4 of the 10 Node rules can never fire:** `infra-errors`, `session-stuck`, `cost-hourly-spike` and `cost-daily-budget`. Nothing sends the events they need (no cost, stuck or infra events). `high-error-rate` only ever sees errors, so in practice it means "20 LLM errors". The docs say all 10 work.
4. **There are no real tests.** `python/tests/conftest.py` has fake nanobot classes, but there are no test files. Node only has type checking. Because the adapters depend on other projects' private code, this is the biggest long-term risk.
5. **The Python dashboard has no source code.** `dashboard/html.py` contains minified JS. The TypeScript source and `build.py` were deleted in commit `96f1149`, and later changes were edited by hand into the minified code. The old source can be recovered with `git show 96f1149^:dashboard/src/main.ts` (the other files are in the same folder).
6. **The Python dashboard is open to the network.** It listens on `0.0.0.0` with no login (`dashboard/server.py:51`). Node listens only on `127.0.0.1`.
7. **New alerts don't show up live on the Node dashboard.** The page waits for an `openalerts` message that the server never sends, so alerts only appear on the next full refresh.
8. **The OpenClaw gateway token is copied into SQLite.** `readers/openclaw.ts:346` saves the whole `gateway` section of `openclaw.json`, token included, even though the code comment says keys are skipped. Anyone who can read the database file can read the token.
9. **`openalerts serve` writes to the same files as the agent.** Both processes write `collections/sessions.json` and `actions.jsonl`, so actions are saved twice and the sessions file gets overwritten.
10. **`init_sync()` hangs forever if called from async code** (`__init__.py:100`). Only call it from normal, non-async code.
11. **Not tested yet, worth checking:** the CrewAI example in the README runs `crew.kickoff()`, which blocks, inside `async def main()`. That blocks the same event loop that CrewAI events are sent to, so events may only be handled after the crew finishes. If that's the case, use `await crew.kickoff_async()` instead.

Smaller issues:
- Telegram uses HTML mode, so it can reject error text that contains `<` or `&`.
- Node config accepts `slack` and `discord` channel types but silently ignores them.
- `make build` fails because the `dashboard` workspace is empty. `make test` fails because pytest finds no tests.

## 8. Out-of-date docs

- `GUIDE.md` describes the old design, when OpenAlerts ran as a plugin inside OpenClaw (platform sync, chat commands). Treat it as history.
- Root `README.md`: the "LLM-Enriched Alerts" and "Commands" (`/health`, `/alerts`) sections describe features that were removed along with the plugin.
- `node/README.md` and `python/README.md` are mostly correct.

## 9. How to make common changes

- **New rule (Node):** add it to `ALL_RULES` in `node/src/core/rules.ts`. Make sure something actually sends the event type the rule needs. Then update the copied rule lists in `mcp/tools.ts` and `mcp/resources.ts`.
- **New rule (Python):** add a class to `ALL_RULES` in `python/src/core/rules.py`, and set `event_types`. The evaluator only keeps events for a rule if their type is in this list.
- **New channel:** for Node, add a class in `node/src/channels/` and add it to the channel loop in `cli.ts`. For Python, add a class in `python/src/channels/` and add it to `_create_channel()` in `__init__.py`.
- **New framework (Python):** subclass `BaseAdapter`, register it in `_ADAPTER_REGISTRY` in `__init__.py`, and add an optional extra in `pyproject.toml`. If the framework has its own event system, use that instead of patching private methods.
- **New gateway event (Node):** add the event name to `GW_EVENTS` in `cli.ts` and add a branch for it in `translateGatewayEvent()`.

## 10. History and people

- February 2026: OpenAlerts started as a plugin that ran inside OpenClaw. The Python package was added on 20 Feb.
- 25 Feb 2026: the plugin was deleted and replaced by the standalone daemon with SQLite and a new dashboard (commit `63a04e7`).
- March 2026: the nanobot and CrewAI adapters, the MCP server, and npm 0.2.8. Since then there have only been security and dependency updates.
- Nilay (GitHub `NILAY1556`) wrote most of the Node daemon, the dashboard and the MCP server. Dev Khant wrote the Python package and the adapters. `yash194` added the cost rules.

## 11. Handover checklist

- Give npm (`@steadwing`) and PyPI (`openalerts`) owner access to someone who is staying.
- Check that the `NPM_TOKEN` and `PYPI_TOKEN` GitHub secrets still work.
