import type { AlertEnricher, AlertEvent, OpenAlertsLogger } from "./types.js";

// ─── Provider Config ────────────────────────────────────────────────────────

type ProviderType = "openai-compatible" | "anthropic";

type ProviderConfig = {
  type: ProviderType;
  baseUrl: string;
  apiKeyEnvVar: string;
};

const PROVIDER_MAP: Record<string, ProviderConfig> = {
  openai: {
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  groq: {
    type: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
  },
  together: {
    type: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnvVar: "TOGETHER_API_KEY",
  },
  deepseek: {
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
  },
  anthropic: {
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
  },
};

// ─── Types ──────────────────────────────────────────────────────────────────

export type LlmEnricherOptions = {
  /** Model string from config, e.g. "openai/gpt-5-nano" */
  modelString: string;
  /** Logger for debug/warn messages */
  logger?: OpenAlertsLogger;
  /** Timeout in ms (default: 10000) */
  timeoutMs?: number;
};

// ─── Prompt ─────────────────────────────────────────────────────────────────

function buildPrompt(alert: AlertEvent): string {
  return `You are a concise DevOps alert analyst. Given this monitoring alert, provide:
1. A brief human-friendly summary (1 sentence, plain language)
2. One actionable suggestion to resolve it

Alert:
- Rule: ${alert.ruleId}
- Severity: ${alert.severity}
- Title: ${alert.title}
- Detail: ${alert.detail}

Reply in exactly this format (2 lines only):
Summary: <your summary>
Action: <your suggestion>`;
}

// ─── Response Parsing ───────────────────────────────────────────────────────

function parseEnrichment(text: string): { summary: string; action: string } | null {
  const lines = text.trim().split("\n");
  let summary = "";
  let action = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith("summary:")) {
      summary = trimmed.slice("summary:".length).trim();
    } else if (trimmed.toLowerCase().startsWith("action:")) {
      action = trimmed.slice("action:".length).trim();
    }
  }

  if (!summary && !action) return null;
  return { summary, action };
}

// ─── HTTP Calls ─────────────────────────────────────────────────────────────

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const textBlock = data.content?.find((b) => b.type === "text");
    return textBlock?.text ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an AlertEnricher that calls an LLM to add a summary + action to alerts.
 * Returns null if provider or API key can't be resolved.
 */
export function createLlmEnricher(opts: LlmEnricherOptions): AlertEnricher | null {
  const { modelString, logger, timeoutMs = 10_000 } = opts;

  // Parse "provider/model-name" format
  const slashIdx = modelString.indexOf("/");
  if (slashIdx < 1) {
    logger?.warn(`openalerts: llm-enrichment skipped — invalid model string "${modelString}"`);
    return null;
  }

  const providerKey = modelString.slice(0, slashIdx).toLowerCase();
  const model = modelString.slice(slashIdx + 1);

  const providerConfig = PROVIDER_MAP[providerKey];
  if (!providerConfig) {
    logger?.warn(`openalerts: llm-enrichment skipped — unknown provider "${providerKey}"`);
    return null;
  }

  const apiKey = process.env[providerConfig.apiKeyEnvVar];
  if (!apiKey) {
    logger?.warn(
      `openalerts: llm-enrichment skipped — ${providerConfig.apiKeyEnvVar} not set in environment`,
    );
    return null;
  }

  logger?.info(`openalerts: llm-enrichment enabled (${providerKey}/${model})`);

  return async (alert: AlertEvent): Promise<AlertEvent | null> => {
    const prompt = buildPrompt(alert);

    let responseText: string | null = null;
    if (providerConfig.type === "anthropic") {
      responseText = await callAnthropic(
        providerConfig.baseUrl,
        apiKey,
        model,
        prompt,
        timeoutMs,
      );
    } else {
      responseText = await callOpenAICompatible(
        providerConfig.baseUrl,
        apiKey,
        model,
        prompt,
        timeoutMs,
      );
    }

    if (!responseText) return null;

    const parsed = parseEnrichment(responseText);
    if (!parsed) return null;

    // Append enrichment to the original detail
    let enrichedDetail = alert.detail;
    if (parsed.summary) {
      enrichedDetail += `\n\nSummary: ${parsed.summary}`;
    }
    if (parsed.action) {
      enrichedDetail += `\nAction: ${parsed.action}`;
    }

    return { ...alert, detail: enrichedDetail };
  };
}
