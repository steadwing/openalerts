import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ChannelConfig {
  type: "telegram" | "discord" | "slack" | "webhook" | "console";
  // telegram
  token?: string;
  chatId?: string;
  // slack / discord / webhook
  webhookUrl?: string;
  url?: string;
}

export interface RuleOverride {
  enabled?: boolean;
  threshold?: number;
  cooldownMinutes?: number;
}

export interface WatchConfig {
  /** Path to ~/.openclaw or custom openclaw data dir */
  openclawDir: string;
  /** Workspaces to watch (relative to openclawDir or absolute) */
  workspaces: string[];
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface OtlpConfig {
  /** OTLP endpoint base URL — e.g. https://otlp-gateway-prod-us-east-0.grafana.net/otlp */
  endpoint: string;
  /** Auth + custom headers — e.g. { "Authorization": "Basic <base64>" } */
  headers?: Record<string, string>;
  /** Metrics push interval in seconds (default: 30) */
  intervalSeconds?: number;
  /** Export metrics (default: true) */
  metrics?: boolean;
  /** Export alert logs (default: true) */
  logs?: boolean;
}

export interface AppConfig {
  /** OpenClaw gateway WebSocket URL */
  gatewayUrl: string;
  /** Gateway operator token (gateway.auth.token from openclaw.json) */
  gatewayToken: string;
  /** Where openalerts stores its own data */
  stateDir: string;
  /** File watching config */
  watch: WatchConfig;
  /** HTTP server config */
  server: ServerConfig;
  /** Alert channels */
  channels: ChannelConfig[];
  /** Per-rule overrides */
  rules?: Record<string, RuleOverride>;
  /** Suppress outbound alerts (log only) */
  quiet?: boolean;
  /** Hourly alert cap (default 10) */
  maxAlertsPerHour?: number;
  /** OTLP export config — disabled if omitted */
  otlp?: OtlpConfig;
}

const DEFAULTS: AppConfig = {
  gatewayUrl: "ws://127.0.0.1:18789",
  gatewayToken: "",
  stateDir: path.join(os.homedir(), ".openalerts"),
  watch: {
    openclawDir: path.join(os.homedir(), ".openclaw"),
    workspaces: ["workspace", "workspace-study"],
  },
  server: {
    port: 4242,
    host: "127.0.0.1",
  },
  channels: [],
  quiet: false,
};

export function loadConfig(configPath?: string): AppConfig {
  const candidates = [
    configPath,
    path.join(process.cwd(), "openalerts.config.json"),
    path.join(os.homedir(), ".openalerts", "config.json"),
    // legacy path migration
    path.join(os.homedir(), ".openalerts-watch", "config.json"),
    path.join(os.homedir(), ".config", "openalerts", "config.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        return mergeConfig(DEFAULTS, raw);
      } catch (err) {
        console.error(`[openalerts] Failed to parse config at ${p}: ${err}`);
      }
    }
  }

  return { ...DEFAULTS };
}

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...override,
    watch: { ...base.watch, ...(override.watch ?? {}) },
    server: { ...base.server, ...(override.server ?? {}) },
    channels: override.channels ?? base.channels,
  };
}

export function writeDefaultConfig(targetPath: string): void {
  const openclawDir = path.join(os.homedir(), ".openclaw");
  const autoToken = detectGatewayToken(openclawDir);
  const sample: AppConfig = {
    ...DEFAULTS,
    gatewayToken: autoToken || "PASTE_YOUR_OPERATOR_TOKEN_HERE",
    channels: [
      {
        type: "telegram",
        token: "YOUR_BOT_TOKEN",
        chatId: "YOUR_CHAT_ID",
      },
    ],
  };
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(sample, null, 2) + "\n");
}

/**
 * Auto-detect the OpenClaw gateway operator token.
 * Primary source: gateway.auth.token in openclaw.json (the master operator token).
 * This is the correct token for WS connect with client.id = "cli".
 */
export function detectGatewayToken(openclawDir: string): string {
  // Primary: master token from openclaw.json gateway.auth.token
  const configPath = path.join(openclawDir, "openclaw.json");
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const gw = data.gateway as Record<string, unknown> | undefined;
    const auth = gw?.auth as Record<string, unknown> | undefined;
    if (typeof auth?.token === "string" && auth.token) {
      return auth.token;
    }
  } catch { /* ignore */ }

  return "";
}
