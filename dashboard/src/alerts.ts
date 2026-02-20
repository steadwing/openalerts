import type { AlertEvent } from "./types";
import { esc, fAgo } from "./utils";

const MAX_ALERTS = 50;

/** Render an alert into the alerts sidebar. */
export function addAlert(a: AlertEvent, alList: HTMLElement, alEmpty: HTMLElement): void {
  alEmpty.style.display = "none";
  const d = document.createElement("div");
  d.className = "al";
  const sv = a.severity || "error";
  d.innerHTML =
    '<div class="al-sev ' + esc(sv) + '">[' + esc(sv.toUpperCase()) + "] " + esc(a.rule_id || "") + "</div>" +
    '<div class="al-title">' + esc(a.title || "") + "</div>" +
    '<div class="al-detail">' + esc(a.detail || "") + "</div>" +
    '<div class="al-time">' + fAgo(a.ts) + "</div>";
  alList.insertBefore(d, alList.firstChild);

  while (alList.children.length > MAX_ALERTS + 1) {
    alList.removeChild(alList.lastChild!);
  }
}
