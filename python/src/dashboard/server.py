"""Stdlib asyncio HTTP server for the OpenAlerts dashboard.

Serves the embedded HTML dashboard, SSE event stream, and JSON state endpoint.
No external dependencies — uses only asyncio and http modules from the stdlib.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

from openalerts.dashboard.html import get_dashboard_html

if TYPE_CHECKING:
    from openalerts.core.engine import OpenAlertsEngine
    from openalerts.core.types import AlertEvent, OpenAlertsEvent

logger = logging.getLogger("openalerts.dashboard")

_HEARTBEAT_INTERVAL = 15  # seconds
_DEFAULT_PORT = 9464


class DashboardServer:
    """Lightweight HTTP server that serves the OpenAlerts dashboard.

    Routes:
        GET /openalerts        → HTML dashboard page
        GET /openalerts/events → SSE stream (real-time events + history replay)
        GET /openalerts/state  → JSON engine state snapshot
    """

    def __init__(self, engine: OpenAlertsEngine, port: int = _DEFAULT_PORT) -> None:
        self._engine = engine
        self._port = port
        self._server: asyncio.Server | None = None
        self._sse_clients: set[asyncio.StreamWriter] = set()
        self._unsubscribe: Any = None
        self._heartbeat_task: asyncio.Task | None = None
        self._html: str = get_dashboard_html()

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle_connection, "0.0.0.0", self._port)
        self._unsubscribe = self._engine.bus.on(self._on_event)
        self._engine.on_alert(self._on_alert)
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info("Dashboard server started on http://localhost:%d/openalerts", self._port)

    async def stop(self) -> None:
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None

        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

        # Close all SSE clients
        for writer in list(self._sse_clients):
            try:
                writer.close()
            except Exception:
                pass
        self._sse_clients.clear()

        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

        logger.info("Dashboard server stopped")

    async def _handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Handle a raw TCP connection — parse HTTP request and route."""
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=10)
            if not request_line:
                writer.close()
                return

            request_text = request_line.decode("utf-8", errors="replace").strip()
            parts = request_text.split(" ")
            if len(parts) < 2:
                writer.close()
                return

            method = parts[0]
            path = parts[1].split("?")[0]  # Strip query string

            # Read and discard remaining headers
            while True:
                header_line = await asyncio.wait_for(reader.readline(), timeout=5)
                if header_line in (b"\r\n", b"\n", b""):
                    break

            if method != "GET":
                await self._send_response(writer, HTTPStatus.METHOD_NOT_ALLOWED, "text/plain", "Method Not Allowed")
                return

            if path == "/openalerts" or path == "/openalerts/":
                await self._send_response(writer, HTTPStatus.OK, "text/html; charset=utf-8", self._html)
            elif path == "/openalerts/events":
                await self._handle_sse(writer)
                return  # SSE keeps connection open
            elif path == "/openalerts/state":
                await self._handle_state(writer)
            else:
                await self._send_response(writer, HTTPStatus.NOT_FOUND, "text/plain", "Not Found")
        except (asyncio.TimeoutError, ConnectionError, OSError):
            pass
        except Exception:
            logger.debug("Dashboard connection error", exc_info=True)
        finally:
            if writer and not writer.is_closing():
                try:
                    writer.close()
                except Exception:
                    pass

    async def _send_response(
        self,
        writer: asyncio.StreamWriter,
        status: HTTPStatus,
        content_type: str,
        body: str,
    ) -> None:
        body_bytes = body.encode("utf-8")
        header = (
            f"HTTP/1.1 {status.value} {status.phrase}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(body_bytes)}\r\n"
            f"Access-Control-Allow-Origin: *\r\n"
            f"Connection: close\r\n"
            f"\r\n"
        )
        writer.write(header.encode("utf-8"))
        writer.write(body_bytes)
        await writer.drain()

    async def _handle_state(self, writer: asyncio.StreamWriter) -> None:
        snapshot = self._engine.get_state_snapshot()
        body = json.dumps(snapshot)
        await self._send_response(writer, HTTPStatus.OK, "application/json", body)

    async def _handle_sse(self, writer: asyncio.StreamWriter) -> None:
        """Start an SSE stream: send headers, replay history, then keep alive."""
        header = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: text/event-stream\r\n"
            "Cache-Control: no-cache\r\n"
            "Connection: keep-alive\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "\r\n"
        )
        writer.write(header.encode("utf-8"))
        await writer.drain()

        # Send event history replay
        history = self._engine.get_recent_live_events(limit=200)
        if history:
            history_data = [ev.model_dump(mode="json") for ev in history]
            sse_msg = f"event: history\ndata: {json.dumps(history_data)}\n\n"
            writer.write(sse_msg.encode("utf-8"))
            await writer.drain()

        # Send alert history replay
        snapshot = self._engine.get_state_snapshot()
        if snapshot.get("recent_alerts"):
            sse_msg = f"event: alert_history\ndata: {json.dumps(snapshot['recent_alerts'])}\n\n"
            writer.write(sse_msg.encode("utf-8"))
            await writer.drain()

        # Register this client for live events
        self._sse_clients.add(writer)
        logger.debug("SSE client connected (total=%d)", len(self._sse_clients))

        # Keep connection open until client disconnects
        try:
            while not writer.is_closing():
                await asyncio.sleep(1)
                # Check if connection is still alive by trying a zero-byte check
                if writer.transport.is_closing():
                    break
        except (ConnectionError, OSError, asyncio.CancelledError):
            pass
        finally:
            self._sse_clients.discard(writer)
            logger.debug("SSE client disconnected (total=%d)", len(self._sse_clients))

    async def _on_event(self, event: OpenAlertsEvent) -> None:
        """Broadcast an event to all connected SSE clients."""
        await self._broadcast_sse("openalerts", event.model_dump(mode="json"))

    async def _on_alert(self, alert: AlertEvent) -> None:
        """Broadcast an alert to all connected SSE clients."""
        data = {
            "rule_id": alert.rule_id,
            "severity": alert.severity,
            "title": alert.title,
            "detail": alert.detail,
            "ts": alert.ts,
        }
        await self._broadcast_sse("alert", data)

    async def _broadcast_sse(self, event_type: str, data: object) -> None:
        """Send an SSE message to all connected clients."""
        if not self._sse_clients:
            return

        sse_msg = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
        msg_bytes = sse_msg.encode("utf-8")

        dead: list[asyncio.StreamWriter] = []
        for writer in list(self._sse_clients):
            try:
                writer.write(msg_bytes)
                await writer.drain()
            except (ConnectionError, OSError):
                dead.append(writer)
            except Exception:
                dead.append(writer)

        for w in dead:
            self._sse_clients.discard(w)
            try:
                w.close()
            except Exception:
                pass

    async def _heartbeat_loop(self) -> None:
        """Send periodic SSE comments to keep connections alive."""
        while True:
            try:
                await asyncio.sleep(_HEARTBEAT_INTERVAL)
                if not self._sse_clients:
                    continue

                msg = f": heartbeat {int(time.time())}\n\n".encode("utf-8")
                dead: list[asyncio.StreamWriter] = []
                for writer in list(self._sse_clients):
                    try:
                        writer.write(msg)
                        await writer.drain()
                    except (ConnectionError, OSError):
                        dead.append(writer)
                    except Exception:
                        dead.append(writer)

                for w in dead:
                    self._sse_clients.discard(w)
                    try:
                        w.close()
                    except Exception:
                        pass
            except asyncio.CancelledError:
                break
            except Exception:
                logger.debug("Heartbeat error", exc_info=True)

    @property
    def port(self) -> int:
        return self._port

    @property
    def url(self) -> str:
        return f"http://localhost:{self._port}/openalerts"
