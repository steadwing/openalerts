import type { StateSnapshot } from "./types";
import { $, esc, fAgo, fU } from "./utils";
import { addAlert } from "./alerts";
import { flows } from "./flows";

/** Cached state snapshot, shared across tabs. */
let cachedState: StateSnapshot | null = null;

/** Track already-rendered alert IDs to avoid duplicates. */
const seenAlerts: Record<string, boolean> = {};

/** Get the cached state snapshot. */
export function getCachedState(): StateSnapshot | null {
  return cachedState;
}

/** Poll the /openalerts/state endpoint and update the topbar + alerts. */
export function pollState(alList: HTMLElement, alEmpty: HTMLElement): void {
  fetch("/openalerts/state")
    .then((r) => r.json())
    .then((s: StateSnapshot) => {
      if (!s) return;
      cachedState = s;

      if (s.stats) {
        $("sEvts").textContent = String(s.stats.events_processed || 0);
        $("sLlm").textContent = String(s.stats.llm_calls || 0);
        $("sTools").textContent = String(s.stats.tool_calls || 0);
        $("sErr").textContent = String(
          (s.stats.llm_errors || 0) + (s.stats.tool_errors || 0) + (s.stats.agent_errors || 0),
        );
        $("sTok").textContent = String(s.stats.tokens_used || 0);
      }
      if (s.uptime_ms != null) $("sUp").textContent = fU(s.uptime_ms);

      if (s.recent_alerts) {
        for (const a of s.recent_alerts) {
          const id = a.rule_id + ":" + a.ts;
          if (!seenAlerts[id]) {
            addAlert(a, alList, alEmpty);
            seenAlerts[id] = true;
          }
        }
      }

      if (s.rules) {
        const sec = $("rulesEl");
        let rh = "<h3>Rules</h3>";
        for (const r of s.rules) {
          const rf = r.status === "fired";
          const lfText = r.last_fired ? " \u00B7 " + fAgo(r.last_fired) : "";
          rh +=
            '<div class="rl"><span class="rl-d ' + (rf ? "fired" : "ok") + '"></span>' +
            "<span>" + esc(r.id) + "</span>" +
            '<span class="rl-s">' + (rf ? "FIRING" : "OK") + lfText + "</span></div>";
        }
        sec.innerHTML = rh;
      }
    })
    .catch(() => {});
}

/** Render the Health tab content. */
export function refreshHealth(): void {
  const s = cachedState;
  if (!s) {
    setTimeout(refreshHealth, 500);
    return;
  }

  const st = s.stats || {};
  let html = "";

  html += '<div class="h-sec"><h3>System</h3><div class="h-grid">';
  html += hCard("Uptime", fU(s.uptime_ms || 0), "ok");
  html += hCard("Events", String(st.events_processed || 0), "ok");
  const te = (st.llm_errors || 0) + (st.tool_errors || 0) + (st.agent_errors || 0);
  html += hCard("Errors", String(te), te > 0 ? "bad" : "ok");
  html += hCard("Tokens Used", String(st.tokens_used || 0), "ok");
  html += hCard("LLM Calls", String(st.llm_calls || 0), "");
  html += hCard("Tool Calls", String(st.tool_calls || 0), "");
  html += hCard("Agent Runs", String(st.agent_starts || 0), "");
  html += hCard("Agent Steps", String(st.agent_steps || 0), "");
  html += "</div></div>";

  html += '<div class="h-sec"><h3>Rules</h3><table class="h-tbl">';
  html += "<tr><th>Rule</th><th>Status</th><th>Last Fired</th></tr>";
  if (s.rules) {
    for (const r of s.rules) {
      html +=
        "<tr><td>" + esc(r.id) + "</td><td>" +
        (r.status === "fired"
          ? '<span style="color:#f85149;font-weight:700">FIRING</span>'
          : '<span style="color:#3fb950">OK</span>') +
        "</td><td>" + (r.last_fired ? fAgo(r.last_fired) : "--") + "</td></tr>";
    }
  }
  html += "</table></div>";

  if (s.recent_alerts && s.recent_alerts.length) {
    html += '<div class="h-sec"><h3>Recent Alerts (' + s.recent_alerts.length + ")</h3><table class=\"h-tbl\">";
    for (const a of s.recent_alerts) {
      const color =
        a.severity === "error" ? "#f85149" : a.severity === "warn" ? "#d29922" : "#58a6ff";
      html +=
        '<tr><td style="color:' + color + '">[' +
        esc((a.severity || "?").toUpperCase()) + "] " + esc(a.rule_id || "") +
        "</td><td>" + esc(a.title || "") + " \u2014 " + esc(a.detail || "") + "</td></tr>";
    }
    html += "</table></div>";
  }

  $("hC").innerHTML = html;
}

/** Render the Debug tab content. */
export function refreshDebug(): void {
  const s = cachedState;
  if (!s) {
    setTimeout(refreshDebug, 500);
    return;
  }

  const st = s.stats || {};
  let dh = "";
  dh += hCard("Uptime", fU(s.uptime_ms || 0), "ok");
  dh += hCard("Events", String(st.events_processed || 0), "ok");
  dh += hCard("Bus Listeners", String(s.bus_listeners || 0), "");
  $("dbState").innerHTML = dh;

  let evh = '<div style="font-family:monospace;font-size:10px;line-height:1.6">';
  for (const k in flows) {
    const f = flows[k];
    evh +=
      '<div style="margin-bottom:4px"><span style="color:#58a6ff">' +
      esc(k) + "</span> \u2014 " + f.n + " events, " + f.st + "</div>";
  }
  if (!Object.keys(flows).length) {
    evh += '<div style="color:#8b949e">No flows yet</div>';
  }
  evh += "</div>";
  $("dbEvents").innerHTML = evh;

  let rh = '<table class="h-tbl">';
  rh += "<tr><th>Rule</th><th>Status</th><th>Cooldown Key</th><th>Last Fired</th></tr>";
  const cds = s.cooldowns || {};
  for (const ck in cds) {
    rh +=
      "<tr><td>" + esc(ck) + '</td><td><span style="color:#d29922">cooled</span></td>' +
      "<td>" + esc(ck) + "</td><td>" + fAgo(cds[ck]) + "</td></tr>";
  }
  if (!Object.keys(cds).length) {
    rh += '<tr><td colspan="4" style="color:#8b949e">No cooldowns active</td></tr>';
  }
  rh += "</table>";
  $("dbRules").innerHTML = rh;
}

function hCard(label: string, value: string, cls: string): string {
  return (
    '<div class="h-card"><div class="lb">' + esc(label) +
    '</div><div class="vl ' + (cls || "") + '">' + esc(value) + "</div></div>"
  );
}

