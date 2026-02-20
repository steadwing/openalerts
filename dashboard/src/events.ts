import type { OpenAlertsEvent } from "./types";
import { flows, getFlow, updFlow } from "./flows";
import { cat, esc, fD, fT, friendlyLabel } from "./utils";

const MAX_STANDALONE = 200;

/** Build the expandable detail panel for an event. */
function buildDetail(ev: OpenAlertsEvent): HTMLElement {
  const d = document.createElement("div");
  d.className = "ev-detail";

  let h = "<h4>Identity</h4>";
  h += dv("Type", ev.type || "?");
  h += dv("Timestamp", new Date(ev.ts * 1000).toISOString());
  if (ev.agent_name) h += dv("Agent", ev.agent_name);
  if (ev.agent_class) h += dv("Class", ev.agent_class);
  if (ev.tool_name) h += dv("Tool", ev.tool_name);
  if (ev.outcome) h += dv("Outcome", ev.outcome);
  if (ev.severity && ev.severity !== "info") h += dv("Severity", ev.severity);

  const hasMetrics = ev.duration_ms != null || ev.token_count != null || ev.step_number != null;
  if (hasMetrics) {
    h += "<h4>Metrics</h4>";
    if (ev.duration_ms != null) h += dv("Duration", fD(ev.duration_ms));
    if (ev.token_count != null) h += dv("Tokens", String(ev.token_count));
    if (ev.step_number != null) {
      h += dv("Step", ev.step_number + (ev.max_steps ? "/" + ev.max_steps : ""));
    }
  }

  if (ev.error) {
    h += '<h4>Error</h4><div class="err-block">' + esc(ev.error) + "</div>";
  }

  const m = ev.meta;
  if (m) {
    const mk = Object.keys(m);
    if (mk.length) {
      h += '<h4>Meta</h4><div class="meta-grid">';
      for (const key of mk) {
        const v = m[key];
        const vs = typeof v === "object" ? JSON.stringify(v) : String(v != null ? v : "");
        h += '<span class="mk">' + esc(key) + '</span><span class="mv">' + esc(vs) + "</span>";
      }
      h += "</div>";
    }
  }

  d.innerHTML = h;
  return d;
}

function dv(label: string, value: string): string {
  return (
    '<div class="dv"><span class="dk">' + esc(label) +
    '</span><span class="dd">' + esc(String(value)) +
    "</span></div>"
  );
}

/** Build a single event row element. */
function buildRow(ev: OpenAlertsEvent, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  const div = document.createElement("div");
  div.className = "row" + (depth === 0 ? " standalone" : depth > 1 ? " deep" : "");

  const c = cat(ev.type);
  const fl = friendlyLabel(ev.type);
  const oc = ev.outcome || "";

  let h = '<div class="r-main">';
  h += '<span class="r-time">' + fT(ev.ts) + "</span>";
  h += '<span class="r-icon">' + fl[0] + "</span>";
  if (ev.severity && ev.severity !== "info") {
    h += '<span class="sev-dot ' + ev.severity + '"></span>';
  }
  h += '<span class="r-type ' + c + '">' + esc(fl[1]) + "</span>";
  if (oc) {
    h +=
      '<span class="r-oc ' + (oc === "success" ? "success" : "error") + '">' +
      (oc === "success" ? "\u2713 OK" : "\u2717 " + oc) + "</span>";
  }

  h += '<span class="r-pills">';
  if (ev.tool_name) h += '<span class="p t">' + esc(ev.tool_name) + "</span>";
  if (ev.duration_ms != null) h += '<span class="p d">' + fD(ev.duration_ms) + "</span>";
  if (ev.token_count != null) h += '<span class="p tk">' + ev.token_count + " tok</span>";
  if (ev.step_number != null) {
    h += '<span class="p step">step ' + ev.step_number + (ev.max_steps ? "/" + ev.max_steps : "") + "</span>";
  }
  if (ev.agent_class && depth === 0) {
    h += '<span class="p agent">' + esc(ev.agent_class) + "</span>";
  }
  h += "</span></div>";

  const ds: string[] = [];
  if (ev.error) {
    const errText = ev.error.length > 120 ? ev.error.slice(0, 117) + "..." : ev.error;
    ds.push('<span class="err">' + esc(errText) + "</span>");
  }
  if (ev.agent_name && depth === 0) {
    ds.push('<span class="dim">agent: ' + esc(ev.agent_name) + "</span>");
  }
  if (ds.length) h += '<div class="r-det">' + ds.join(" \u00B7 ") + "</div>";

  div.innerHTML = h;
  wrap.appendChild(div);

  const detail = buildDetail(ev);
  wrap.appendChild(detail);
  div.addEventListener("click", () => detail.classList.toggle("open"));

  return wrap;
}

/** Add an event to the live timeline. */
export function addEvent(
  ev: OpenAlertsEvent,
  evList: HTMLElement,
  emptyMsg: HTMLElement,
  evCnt: HTMLElement,
  total: { value: number },
  paused: { value: boolean },
): void {
  total.value++;
  evCnt.textContent = String(total.value);
  emptyMsg.style.display = "none";
  if (paused.value) return;

  const key = ev.agent_name || ev.agent_class;
  if (key && (flows[key] || ev.type === "agent.start")) {
    const f = getFlow(key, ev, evList, emptyMsg);
    f.n++;
    if (ev.token_count) f.tok += ev.token_count;
    if (ev.type === "tool.call" || ev.type === "tool.error") {
      f.tools++;
      if (ev.tool_name) f.toolNames[ev.tool_name] = true;
    }
    if (ev.type === "llm.call") f.llms++;
    if (ev.type === "agent.step") f.steps++;
    if (ev.outcome === "error" || ev.type.includes(".error")) {
      f.err = true;
      f.errCount++;
    }

    let depth = 1;
    if (["tool.call", "tool.error", "llm.call", "llm.token_usage", "llm.error"].includes(ev.type)) {
      depth = 2;
    }
    f.body.appendChild(buildRow(ev, depth));

    if (evList.firstChild !== f.el) {
      evList.insertBefore(f.el, evList.firstChild);
    }

    if (ev.type === "agent.end") {
      if (ev.duration_ms) f.dur = ev.duration_ms;
      updFlow(f, f.err ? "error" : "done");
    } else if (ev.type === "agent.error") {
      f.err = true;
      f.errCount++;
      if (ev.duration_ms) f.dur = ev.duration_ms;
      updFlow(f, "error");
    } else {
      updFlow(f, f.st);
    }
    return;
  }

  // Standalone event (not part of a flow)
  const row = buildRow(ev, 0);
  if (evList.firstChild && evList.firstChild !== emptyMsg) {
    evList.insertBefore(row, evList.firstChild);
  } else {
    evList.appendChild(row);
  }

  // Trim old standalone rows
  const standalones = evList.querySelectorAll(".row.standalone");
  while (standalones.length > MAX_STANDALONE) {
    const all = evList.querySelectorAll(".row.standalone");
    all[all.length - 1].parentElement!.remove();
  }
}
