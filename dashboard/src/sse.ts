import type { AlertEvent, OpenAlertsEvent } from "./types";
import { $ } from "./utils";

/** Connect to the SSE event stream. */
export function connectSSE(
  onEvent: (ev: OpenAlertsEvent) => void,
  onAlert: (al: AlertEvent) => void,
): EventSource {
  const evSrc = new EventSource("/openalerts/events");

  evSrc.addEventListener("openalerts", (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch (_) {
      // ignore parse errors
    }
  });

  evSrc.addEventListener("history", (e: MessageEvent) => {
    try {
      const evs: OpenAlertsEvent[] = JSON.parse(e.data);
      for (const ev of evs) onEvent(ev);
    } catch (_) {
      // ignore parse errors
    }
  });

  evSrc.addEventListener("alert", (e: MessageEvent) => {
    try {
      onAlert(JSON.parse(e.data));
    } catch (_) {
      // ignore parse errors
    }
  });

  evSrc.addEventListener("alert_history", (e: MessageEvent) => {
    try {
      const als: AlertEvent[] = JSON.parse(e.data);
      for (const al of als) onAlert(al);
    } catch (_) {
      // ignore parse errors
    }
  });

  evSrc.onopen = () => {
    $("sDot").className = "dot live";
    $("sConn").textContent = "live";
  };

  evSrc.onerror = () => {
    $("sDot").className = "dot dead";
    $("sConn").textContent = "reconnecting...";
  };

  return evSrc;
}
