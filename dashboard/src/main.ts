import { $ } from "./utils";
import { addEvent } from "./events";
import { addAlert } from "./alerts";
import { cleanupFlows } from "./flows";
import { connectSSE } from "./sse";
import { pollState, refreshHealth, refreshDebug } from "./state";
import type { AlertEvent } from "./types";

/** Track already-rendered alert IDs to avoid duplicates from both SSE and polling. */
const seenAlerts: Record<string, boolean> = {};

/** Bootstrap the dashboard. */
(function boot() {
  const total = { value: 0 };
  const paused = { value: false };

  const evList = $("evList");
  const emptyMsg = $("emptyMsg");
  const evCnt = $("evCnt");
  const alList = $("alList");
  const alEmpty = $("alEmpty");

  // Pause live updates on hover
  evList.addEventListener("mouseenter", () => { paused.value = true; });
  evList.addEventListener("mouseleave", () => { paused.value = false; });

  // Tab switching
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const tabId = (t as HTMLElement).dataset.tab;
      const tgt = document.getElementById("tab-" + tabId);
      if (tgt) tgt.classList.add("active");
      if (tabId === "health") refreshHealth();
      if (tabId === "debug") refreshDebug();
    });
  });

  // Handle alert from SSE (real-time push)
  const handleAlert = (a: AlertEvent) => {
    const id = a.rule_id + ":" + a.ts;
    if (!seenAlerts[id]) {
      addAlert(a, alList, alEmpty);
      seenAlerts[id] = true;
    }
  };

  // Connect SSE — events + alerts
  connectSSE(
    (ev) => addEvent(ev, evList, emptyMsg, evCnt, total, paused),
    handleAlert,
  );

  // State polling (stats, rules — alerts now come via SSE too)
  const poll = () => pollState(alList, alEmpty);
  poll();
  setInterval(poll, 4000);

  // Stale flow cleanup
  setInterval(cleanupFlows, 30000);
})();
