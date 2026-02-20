import type { FlowState, OpenAlertsEvent } from "./types";
import { esc, fD, fT } from "./utils";

const MAX_FLOWS = 100;

/** All tracked flows keyed by agent name/class. */
export const flows: Record<string, FlowState> = {};
export const flowOrder: string[] = [];

/** Get or create a flow group for the given key. */
export function getFlow(
  key: string,
  ev: OpenAlertsEvent,
  evList: HTMLElement,
  emptyMsg: HTMLElement,
): FlowState {
  if (flows[key]) return flows[key];

  const container = document.createElement("div");
  container.className = "flow active";

  const hdr = document.createElement("div");
  hdr.className = "flow-hdr";
  const label = ev.agent_class
    ? ev.agent_class + (ev.agent_name ? " (" + ev.agent_name + ")" : "")
    : key;
  hdr.innerHTML =
    '<span class="flow-arr">\u25BC</span>' +
    '<span class="flow-lbl" title="' + esc(label) + '">' + esc(label) + "</span>" +
    '<span class="flow-badge active" data-r="st">Running</span>' +
    '<span class="flow-info" data-r="info">' + fT(ev.ts) + "</span>";

  const summary = document.createElement("div");
  summary.className = "flow-summary";

  const body = document.createElement("div");
  body.className = "flow-body";

  hdr.addEventListener("click", () => {
    const shut = !body.classList.contains("shut");
    body.classList.toggle("shut", shut);
    summary.style.display = shut ? "none" : "flex";
    hdr.querySelector(".flow-arr")!.classList.toggle("shut", shut);
  });

  container.appendChild(hdr);
  container.appendChild(summary);
  container.appendChild(body);

  const f: FlowState = {
    el: container,
    body,
    hdr,
    summary,
    st: "active",
    n: 0,
    err: false,
    errCount: 0,
    dur: 0,
    tok: 0,
    tools: 0,
    llms: 0,
    steps: 0,
    toolNames: {},
  };

  flows[key] = f;
  flowOrder.push(key);
  emptyMsg.style.display = "none";
  evList.insertBefore(container, evList.firstChild);
  return f;
}

/** Update a flow's header, badge, and summary line. */
export function updFlow(f: FlowState, st: FlowState["st"]): void {
  f.st = st;
  f.el.className = "flow " + st;

  const sEl = f.hdr.querySelector('[data-r="st"]');
  const labels: Record<string, string> = { active: "Running", done: "Completed", error: "Failed" };
  if (sEl) {
    sEl.className = "flow-badge " + st;
    sEl.textContent = labels[st] || st;
  }

  const iEl = f.hdr.querySelector('[data-r="info"]');
  if (iEl) {
    const ps: string[] = [f.n + " events"];
    if (f.dur > 0) ps.push(fD(f.dur));
    if (f.tok > 0) ps.push(f.tok + " tok");
    if (f.tools > 0) ps.push(f.tools + " tool" + (f.tools > 1 ? "s" : ""));
    if (f.llms > 0) ps.push(f.llms + " llm");
    if (f.steps > 0) ps.push(f.steps + " step" + (f.steps > 1 ? "s" : ""));
    iEl.textContent = ps.join(" \u00B7 ");
  }

  let sh = '<span>Events: <span class="fs-v">' + f.n + "</span></span>";
  if (f.dur > 0) sh += '<span>Duration: <span class="fs-v">' + fD(f.dur) + "</span></span>";
  if (f.tok > 0) sh += '<span>Tokens: <span class="fs-v">' + f.tok + "</span></span>";
  const tn = Object.keys(f.toolNames);
  if (tn.length) sh += '<span>Tools: <span class="fs-tools">' + tn.map(esc).join(", ") + "</span></span>";
  if (f.errCount > 0) sh += '<span>Errors: <span class="fs-err">' + f.errCount + "</span></span>";
  f.summary.innerHTML = sh;
}

/** Remove stale completed flows that exceed the max. */
export function cleanupFlows(): void {
  while (flowOrder.length > MAX_FLOWS) {
    const old = flowOrder.shift()!;
    if (flows[old]) {
      flows[old].el.remove();
      delete flows[old];
    }
  }
}
