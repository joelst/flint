/**
 * Compact host-app context for chat models.
 *
 * Strategy (token-efficient):
 * 1. Always attach a tiny identity line so any model knows where it runs.
 * 2. Only attach the longer fact sheet when the latest user turn looks
 *    like a question about FLInt / Foundry Local / this app.
 *
 * That avoids spending hundreds of tokens on every normal coding/chat turn
 * while still letting the user ask "what is Flint?" without switching personas.
 */

/** ~25–35 tokens. Safe to send every request. */
export const FLINT_IDENTITY_LINE =
  "[Host] You run inside FLInt (Foundry Local Interface), a privacy-first desktop GUI for Microsoft Foundry Local. Foundry Local runs models on this device via an OpenAI-compatible local API. You only reply in chat—you cannot change app settings, download models, or execute tools.";

/**
 * Expanded product facts. Injected only when the user appears to ask about
 * FLInt, Foundry Local, or the local runtime/endpoint.
 * Prefer bullets; keep under ~350 tokens.
 */
export const FLINT_FACT_SHEET = `[About FLInt & Foundry Local — use when the user asks about this app or the runtime]

## Foundry Local (Microsoft)
- On-device AI runtime from Microsoft: download, cache, and run models locally (not cloud by default).
- Compact runtime; FLInt bundles it so users usually need no separate Foundry CLI install.
- Model catalog with aliases and hardware-specific variants (CPU / GPU / NPU; e.g. CUDA, DirectML, CoreML/Metal, QNN).
- OpenAI-compatible local HTTP API (chat completions, and audio/STT where models support it).
- Tool/function calling: when a model supports it, the API can return tool_calls JSON; the *client* that calls the endpoint executes tools—not the runtime itself.
- Designed for a path to Azure AI Foundry (same style of OpenAI-compatible surface), while keeping local privacy as the default.
- Native logs/diagnostics live under the Foundry Local install (often ~/.foundry/logs); FLInt surfaces app + access logs separately.
- Upstream: https://github.com/microsoft/Foundry-Local

## FLInt (this app)
- FLInt = Foundry Local Interface: desktop GUI to manage Foundry Local without deep CLI knowledge.
- Features: model catalog + multi-model pool (download/load/unload), chat (multi-image vision, host context, optional URL→context fetch), audio STT, side-by-side Compare, Monitor (pool/resources/access+audit logs), Integrations snippets, Diagnostics/Settings (bind/port, autostart, shortcuts), Learn.
- Dependencies: Foundry Local runtime is bundled; Node.js 22+ must be on PATH for the JS sidecar (until a self-contained/Rust bridge removes that). Node 22 is the oldest line still receiving security updates.
- Local-first UX: clear when inference is on-device; default bind is localhost for the service.
- Chat window is display-only: it does not parse or execute tool calls, run shell/file ops, or make network requests for the model (guarded web-fetch is user-initiated URL context only).
- External tools (Continue, Cline, Copilot custom provider, user code, etc.) can point at the local endpoint for agentic/tool workflows.
- What you (the model in FLInt chat) cannot do: change UI, load/unload models, execute tools, access files, or browse the network on the user's behalf.
- If asked how to do something in the app, give concise UI steps (Models / Chat / Audio / Compare / Monitor / Integrations / Diagnostics / Settings / Learn).
- If unsure about a version-specific detail, say so rather than inventing.`;

/** Patterns that suggest the user wants app/runtime help (not general knowledge). */
const ABOUT_APP_PATTERNS: RegExp[] = [
  /\bflint\b/i,
  /\bfl\s*int\b/i,
  /\bfoundry\s*local\b/i,
  /\bfoundry\b/i,
  /\bazure\s*ai\s*foundry\b/i,
  /\bthis\s+(app|application|program|software|client|ui|gui)\b/i,
  /\b(the|this)\s+desktop\s+app\b/i,
  /\bwhat\s+(is|are)\s+(you|this)\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bhow\s+do\s+i\s+(use|open|install|configure|connect)\b/i,
  /\b(help|guide|tutorial)\s+(with|for|on)\s+(this\s+)?(app|flint|foundry)\b/i,
  /\babout\s+(you|this\s+app|flint|foundry)\b/i,
  /\b(model\s+catalog|load\s+(a\s+)?model|download\s+(a\s+)?model)\b/i,
  /\b(local\s+endpoint|openai[- ]compatible|tool\s*call(?:ing|s)?|function\s*call(?:ing|s)?)\b/i,
  /\bintegrations?\b/i,
  /\bon[- ]?device\s+(inference|ai|model)\b/i,
];

/**
 * True when the latest user text likely needs FLInt/Foundry product context.
 * Intentionally conservative false-negatives are OK; users can say "Flint" to trigger.
 */
export function userAsksAboutFlint(text: string): boolean {
  const t = String(text || "").trim();
  if (!t || t.length > 2000) {
    // Very long pastes are rarely "about the app"; skip expanded sheet.
    return false;
  }
  // Short messages: still check patterns (e.g. "what is flint?")
  return ABOUT_APP_PATTERNS.some((re) => re.test(t));
}

/**
 * Compose system instructions for one inference call.
 * @param personaPrompt Active persona / system prompt
 * @param latestUserText Most recent user message (string); used only for expansion trigger
 * @param opts.forceFull Always include fact sheet (e.g. dedicated guide mode)
 */
export function buildFlintAwareSystemPrompt(
  personaPrompt: string,
  latestUserText?: string,
  opts?: { forceFull?: boolean },
): string {
  const persona = String(personaPrompt || "").trim() || "You are a helpful assistant.";
  const wantFull = !!opts?.forceFull || userAsksAboutFlint(latestUserText || "");

  // De-dupe if persona already embeds our identity/facts.
  const lower = persona.toLowerCase();
  const needIdentity = !lower.includes("foundry local interface") && !lower.includes("[host]");
  const needFacts =
    wantFull &&
    !lower.includes("[about flint") &&
    !lower.includes("## foundry local");

  const parts = [persona];
  if (needIdentity) parts.push(FLINT_IDENTITY_LINE);
  if (needFacts) parts.push(FLINT_FACT_SHEET);
  return parts.join("\n\n");
}

/** Extract plain text from a chat content field (string or vision parts). */
export function contentToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && p.type === "text" ? String(p.text || "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
