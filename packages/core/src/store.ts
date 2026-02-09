import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, LOG_FILENAME, STORE_DIR_NAME, type StoredEvent } from "./types.js";

function resolveDir(stateDir: string): string {
  return path.join(stateDir, STORE_DIR_NAME);
}

function resolveLogPath(stateDir: string): string {
  return path.join(resolveDir(stateDir), LOG_FILENAME);
}

function ensureDir(stateDir: string): void {
  const dir = resolveDir(stateDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Append a single event to the JSONL log. */
export function appendEvent(stateDir: string, event: StoredEvent): void {
  ensureDir(stateDir);
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(resolveLogPath(stateDir), line, "utf-8");
}

/** Read the most recent N events from the log. Skips malformed lines. */
export function readRecentEvents(
  stateDir: string,
  limit: number,
): StoredEvent[] {
  const logPath = resolveLogPath(stateDir);
  if (!fs.existsSync(logPath)) return [];

  let content: string;
  try {
    content = fs.readFileSync(logPath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.trim().split("\n").filter(Boolean);
  const recent = lines.slice(-limit);
  const events: StoredEvent[] = [];

  for (const line of recent) {
    try {
      const parsed = JSON.parse(line) as StoredEvent;
      if (parsed && typeof parsed.type === "string" && typeof parsed.ts === "number") {
        events.push(parsed);
      }
    } catch {
      // Skip malformed lines silently
    }
  }

  return events;
}

/** Read all events (for warm-start). Caps at 1000 most recent. */
export function readAllEvents(stateDir: string): StoredEvent[] {
  return readRecentEvents(stateDir, 1000);
}

/** Prune the log by age and size. Atomic rewrite via .tmp + rename. */
export function pruneLog(
  stateDir: string,
  opts?: { maxAgeMs?: number; maxSizeKb?: number },
): void {
  const logPath = resolveLogPath(stateDir);
  if (!fs.existsSync(logPath)) return;

  const maxAgeMs = opts?.maxAgeMs ?? DEFAULTS.maxLogAgeDays * 24 * 60 * 60 * 1000;
  const maxSizeBytes = (opts?.maxSizeKb ?? DEFAULTS.maxLogSizeKb) * 1024;

  let content: string;
  try {
    content = fs.readFileSync(logPath, "utf-8");
  } catch {
    return;
  }

  // Check size first — skip if well within limits
  if (Buffer.byteLength(content, "utf-8") < maxSizeBytes * 0.8) {
    // Only prune by age if size is okay
    const cutoff = Date.now() - maxAgeMs;
    const lines = content.trim().split("\n").filter(Boolean);
    const filtered = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as { ts?: number };
        return typeof parsed.ts === "number" && parsed.ts >= cutoff;
      } catch {
        return false; // Drop malformed lines during prune
      }
    });

    if (filtered.length < lines.length) {
      writeAtomic(logPath, filtered.join("\n") + "\n");
    }
    return;
  }

  // Over size limit — filter by age first, then trim oldest if still too large
  const cutoff = Date.now() - maxAgeMs;
  let lines = content.trim().split("\n").filter(Boolean);

  // Remove expired
  lines = lines.filter((line) => {
    try {
      const parsed = JSON.parse(line) as { ts?: number };
      return typeof parsed.ts === "number" && parsed.ts >= cutoff;
    } catch {
      return false;
    }
  });

  // Still too large? Keep only the newest lines that fit
  let result = lines.join("\n") + "\n";
  while (Buffer.byteLength(result, "utf-8") > maxSizeBytes && lines.length > 10) {
    lines = lines.slice(Math.floor(lines.length * 0.25)); // Drop oldest quarter
    result = lines.join("\n") + "\n";
  }

  writeAtomic(logPath, result);
}

/** Atomic write: write to .tmp, then rename. Falls back to direct write on Windows. */
function writeAtomic(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Windows fallback: direct write (rename can be flaky)
    fs.writeFileSync(filePath, content, "utf-8");
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
  }
}
