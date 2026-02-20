"""CLI entry point for OpenAlerts.

Usage:
    openalerts serve [--port 9464] [--state-dir ~/.openalerts] [--log-level INFO]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
from pathlib import Path

logger = logging.getLogger("openalerts.cli")


async def _tail_events(engine: object, events_path: Path, poll_interval: float = 0.5) -> None:
    """Tail events.jsonl for new lines written by external agent processes.

    Seeks to end of file (history already loaded by engine.start()) and polls
    for new data. Handles file truncation by resetting position.
    """
    from openalerts.core.engine import OpenAlertsEngine
    from openalerts.core.types import OpenAlertsEvent

    assert isinstance(engine, OpenAlertsEngine)

    # Wait for the file to exist
    while not events_path.exists():
        await asyncio.sleep(poll_interval)

    pos = events_path.stat().st_size

    while True:
        await asyncio.sleep(poll_interval)

        if not events_path.exists():
            pos = 0
            continue

        try:
            size = events_path.stat().st_size
        except OSError:
            continue

        # File was truncated (e.g. by pruning) — reset
        if size < pos:
            pos = 0

        if size == pos:
            continue

        try:
            with open(events_path) as f:
                f.seek(pos)
                new_data = f.read()
                pos = f.tell()
        except OSError:
            continue

        for line in new_data.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                data = json.loads(stripped)
            except json.JSONDecodeError:
                continue

            # Skip alert lines (they have rule_id) — only ingest events
            if "rule_id" in data and "fingerprint" in data:
                continue

            if "type" not in data:
                continue

            try:
                event = OpenAlertsEvent.model_validate(data)
                await engine.ingest(event)
            except Exception:
                logger.debug("Failed to parse tailed event", exc_info=True)


async def _run_serve(args: argparse.Namespace) -> None:
    from openalerts.core.config import OpenAlertsConfig
    from openalerts.core.engine import OpenAlertsEngine
    from openalerts.dashboard import DashboardServer

    state_dir = Path(args.state_dir)

    config = OpenAlertsConfig(
        persist=False,
        dashboard=False,
        state_dir=str(state_dir),
        log_level=args.log_level,
        dashboard_port=args.port,
    )

    engine = OpenAlertsEngine(config)
    await engine.start()

    dashboard = DashboardServer(engine, port=args.port)
    await dashboard.start()

    events_path = state_dir / "events.jsonl"
    tail_task = asyncio.create_task(_tail_events(engine, events_path))

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    print(f"OpenAlerts dashboard running at http://localhost:{args.port}/openalerts")
    print(f"Tailing events from {events_path}")
    print("Press Ctrl+C to stop")

    await stop_event.wait()

    print("\nShutting down...")
    tail_task.cancel()
    try:
        await tail_task
    except asyncio.CancelledError:
        pass
    await dashboard.stop()
    await engine.stop()


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="openalerts",
        description="OpenAlerts — real-time monitoring & alerting for AI agents",
    )
    subparsers = parser.add_subparsers(dest="command")

    serve_parser = subparsers.add_parser("serve", help="Start the standalone monitoring dashboard")
    serve_parser.add_argument("--port", type=int, default=9464, help="Dashboard port (default: 9464)")
    serve_parser.add_argument(
        "--state-dir",
        default=os.path.expanduser("~/.openalerts"),
        help="State directory containing events.jsonl (default: ~/.openalerts)",
    )
    serve_parser.add_argument("--log-level", default="INFO", help="Log level (default: INFO)")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.command == "serve":
        asyncio.run(_run_serve(args))


if __name__ == "__main__":
    main()
