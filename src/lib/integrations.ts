/**
 * Integration catalog — AI coding tools that can use Flint's local
 * OpenAI-compatible endpoint as a backend.
 *
 * Each entry declares OS-aware setup snippets, a verification status, and
 * any known limitations. The UI in the Integrations tab renders cards from
 * this catalog; the same data also feeds the compact snippet list shown
 * in the Learn tab.
 *
 * Adding a tool: pick the most accurate status. Do NOT mark `verified`
 * unless the snippet has been actually exercised against a running Flint
 * endpoint. When unsure, use `community` or `research-needed`.
 */

export type IntegrationStatus =
  /** Snippet has been exercised end-to-end against a Flint endpoint. */
  | 'verified'
  /** Reported to work by users / docs but not yet exercised by the Flint team. */
  | 'community'
  /** Config not yet confirmed — snippet is a best-effort starting point only. */
  | 'research-needed'
  /** Tool cannot use Flint directly (proprietary backend or non-OpenAI protocol). */
  | 'unsupported';

export type IntegrationCategory =
  | 'editor'        // IDE / editor extensions
  | 'cli'           // Command-line coding agents
  | 'sdk'           // Generic SDK / library usage
  | 'agent';        // Standalone agent frameworks

export interface SetupSnippet {
  /** Short label, e.g. "Set environment variables" or "config.json". */
  label: string;
  /** Snippet language hint for the renderer (shell / json / javascript / python / yaml / text). */
  language: 'shell' | 'powershell' | 'json' | 'javascript' | 'python' | 'yaml' | 'text';
  /** Snippet body. Use the template tokens `{ENDPOINT}` and `{MODEL}` —
   *  the renderer substitutes them with the live endpoint and a placeholder
   *  model alias hint. */
  body: string;
}

export interface IntegrationOSSnippets {
  /** Steps shown when the Windows OS toggle is selected. */
  windows: SetupSnippet[];
  /** Steps shown when the macOS / Linux toggle is selected. */
  unix: SetupSnippet[];
}

export interface Integration {
  id: string;
  name: string;
  vendor: string;
  category: IntegrationCategory;
  status: IntegrationStatus;
  /** One-sentence summary shown on the card. */
  description: string;
  /** Setup snippets per OS. */
  snippets: IntegrationOSSnippets;
  /** Caveats, edge cases, or proxy requirements — rendered in an
   *  expandable section. Each entry is a single sentence/paragraph. */
  limitations?: string[];
  /** Upstream docs URL for verification. */
  docsUrl?: string;
}

/**
 * Substitute `{ENDPOINT}` and `{MODEL}` placeholders in a snippet body.
 * The endpoint is the client-facing loopback URL (always `http://127.0.0.1:<port>/v1`);
 * bind address may be broader for LAN access — snippets still use the loopback connect URL.
 * The model placeholder is a generic alias hint shown in code.
 */
export function renderSnippet(
  body: string,
  endpoint: string,
  modelHint: string = 'your-loaded-model-alias'
): string {
  return body
    .replaceAll('{ENDPOINT}', endpoint || 'http://localhost:PORT/v1')
    .replaceAll('{MODEL}', modelHint);
}

/**
 * Detect the platform for choosing default OS snippets in the UI.
 * Falls back to 'unix' for unknown platforms.
 */
export function detectPlatform(): 'windows' | 'unix' {
  if (typeof navigator === 'undefined') return 'unix';
  const platform = (navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  if (platform.startsWith('win') || ua.includes('windows')) return 'windows';
  return 'unix';
}

// -- Catalog helpers ---------------------------------------------------------

/** Use when windows and unix steps are identical — avoids duplicating snippet bodies. */
function sameForAllOS(snippets: SetupSnippet[]): IntegrationOSSnippets {
  return { windows: snippets, unix: snippets };
}

// -- Catalog -----------------------------------------------------------------

export const integrations: Integration[] = [
  {
    id: 'generic-openai',
    name: 'OpenAI SDK (generic)',
    vendor: 'OpenAI',
    category: 'sdk',
    status: 'verified',
    description:
      'Any OpenAI-compatible client library (Python, JavaScript, Go, etc.) can point at Flint by overriding the base URL. API key is unused locally but most clients require a non-empty value.',
    snippets: sameForAllOS([
      {
        label: 'JavaScript / TypeScript',
        language: 'javascript',
        body:
`import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "{ENDPOINT}",
  apiKey: "not-needed-for-local"
});

const res = await openai.chat.completions.create({
  model: "{MODEL}",
  messages: [{ role: "user", content: "Hello" }],
});`,
      },
      {
        label: 'Python',
        language: 'python',
        body:
`from openai import OpenAI

client = OpenAI(
    base_url="{ENDPOINT}",
    api_key="not-needed-for-local",
)

res = client.chat.completions.create(
    model="{MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
)`,
      },
    ]),
    limitations: [
      'Set any non-empty API key string; Flint ignores the value but most SDKs reject an empty key.',
      'Replace the model alias with the alias of a model you have loaded in Flint.',
    ],
    docsUrl: 'https://platform.openai.com/docs/api-reference',
  },

  {
    id: 'continue-dev',
    name: 'Continue.dev',
    vendor: 'Continue',
    category: 'editor',
    status: 'verified',
    description:
      'Open-source VS Code and JetBrains extension for AI-assisted coding. Connects to any OpenAI-compatible endpoint via its config file.',
    snippets: sameForAllOS([
      {
        label: 'Add to ~/.continue/config.json',
        language: 'json',
        body:
`{
  "models": [
    {
      "title": "Flint (local)",
      "provider": "openai",
      "model": "{MODEL}",
      "apiBase": "{ENDPOINT}",
      "apiKey": "not-needed"
    }
  ]
}`,
      },
    ]),
    limitations: [
      'Restart the Continue extension after editing config.json for changes to take effect.',
    ],
    docsUrl: 'https://docs.continue.dev/customize/model-providers/openai',
  },

  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'Anomaly / community',
    category: 'cli',
    status: 'research-needed',
    description:
      'Open-source terminal coding agent. Provider configuration varies by build — verify against upstream docs before relying on the snippet below.',
    snippets: {
      windows: [
        {
          label: 'Set environment variables (PowerShell)',
          language: 'powershell',
          body:
`$env:OPENAI_BASE_URL = "{ENDPOINT}"
$env:OPENAI_API_KEY  = "not-needed-for-local"
# then run opencode pointing at the {MODEL} alias`,
        },
      ],
      unix: [
        {
          label: 'Set environment variables (bash/zsh)',
          language: 'shell',
          body:
`export OPENAI_BASE_URL="{ENDPOINT}"
export OPENAI_API_KEY="not-needed-for-local"
# then run opencode pointing at the {MODEL} alias`,
        },
      ],
    },
    limitations: [
      'OpenCode env-var names have shifted across releases — confirm `OPENAI_BASE_URL` (or `OPENAI_API_BASE`) against your installed version.',
      'Some builds require a provider declaration in opencode config; check upstream docs.',
    ],
    docsUrl: 'https://github.com/opencode-ai/opencode',
  },

  {
    id: 'openai-codex-cli',
    name: 'Codex CLI (open source)',
    vendor: 'OpenAI',
    category: 'cli',
    status: 'research-needed',
    description:
      "OpenAI's open-source terminal coding agent. Accepts a custom base URL via env vars in recent releases — confirm against your installed version.",
    snippets: {
      windows: [
        {
          label: 'PowerShell',
          language: 'powershell',
          body:
`$env:OPENAI_BASE_URL = "{ENDPOINT}"
$env:OPENAI_API_KEY  = "not-needed-for-local"
codex --model {MODEL}`,
        },
      ],
      unix: [
        {
          label: 'bash / zsh',
          language: 'shell',
          body:
`export OPENAI_BASE_URL="{ENDPOINT}"
export OPENAI_API_KEY="not-needed-for-local"
codex --model {MODEL}`,
        },
      ],
    },
    limitations: [
      'Some Codex CLI releases pin to OpenAI hosted endpoints and ignore base-URL overrides — verify with a small request first.',
      'Tool-calling features may depend on the loaded model supporting OpenAI-style `tool_calls`.',
    ],
    docsUrl: 'https://github.com/openai/codex',
  },

  {
    id: 'cline',
    name: 'Cline',
    vendor: 'Cline (formerly Claude Dev)',
    category: 'editor',
    status: 'research-needed',
    description:
      'VS Code extension for autonomous coding. Supports OpenAI-compatible endpoints in settings — exact field names depend on the installed version.',
    snippets: sameForAllOS([
      {
        label: 'VS Code settings (OpenAI-compatible provider)',
        language: 'json',
        body:
`{
  "cline.apiProvider": "openai",
  "cline.openAiBaseUrl": "{ENDPOINT}",
  "cline.openAiApiKey": "not-needed",
  "cline.openAiModelId": "{MODEL}"
}`,
      },
    ]),
    limitations: [
      'Setting keys have changed across Cline versions — check the extension settings UI for the exact key names in your install.',
    ],
    docsUrl: 'https://github.com/cline/cline',
  },

  {
    id: 'claude-code',
    name: 'Claude Code (CLI + VS Code extension)',
    vendor: 'Anthropic',
    category: 'cli',
    status: 'unsupported',
    description:
      "Anthropic's terminal coding agent and the matching VS Code extension are wire-bound to the Anthropic Messages API shape. Flint speaks OpenAI-compatible, so there is no direct path. Translation proxies exist but lose features Claude Code actually uses (prompt caching, extended thinking, content-block tool use, computer-use tools) — we don't recommend that workaround.",
    snippets: { windows: [], unix: [] },
    limitations: [
      'No direct OpenAI-compatible mode — Claude Code uses the Anthropic Messages API exclusively.',
      'The VS Code extension drives the same CLI binary, so it inherits the same limitation; it does not expose a custom-backend setting.',
      'For OpenAI-compatible terminal coding agents on Flint, see OpenClaw, OpenCode, or Codex CLI instead.',
    ],
  },

  {
    id: 'github-copilot-vscode',
    name: 'GitHub Copilot (VS Code)',
    vendor: 'GitHub / Microsoft',
    category: 'editor',
    status: 'community',
    description:
      'GitHub Copilot in VS Code integrates natively with Foundry Local through its Bring-Your-Own model provider surface. Loaded Flint models appear in the Copilot model picker.',
    snippets: sameForAllOS([
      {
        label: 'Steps (VS Code)',
        language: 'text',
        body:
`1. Install the GitHub Copilot extension in VS Code (sign in if prompted).
2. Make sure Flint is running and a model is loaded (alias: {MODEL}).
3. Open the Copilot Chat model picker → "Manage Models" → choose
   the Foundry Local / OpenAI-compatible provider option.
4. Set base URL: {ENDPOINT}
   API key: any non-empty value (Flint ignores it)
   Model: {MODEL}
5. Select the new model in the Copilot Chat dropdown.

Exact menu wording shifts between Copilot releases; check upstream docs if
the picker layout differs from the steps above.`,
      },
    ]),
    limitations: [
      'Requires a recent Copilot Chat build that exposes the BYO-model picker — older versions do not show this menu.',
      'Only the chat surface accepts custom providers; inline completions still go through the hosted Copilot backend.',
    ],
    docsUrl: 'https://docs.github.com/en/copilot',
  },

  {
    id: 'github-copilot-cli',
    name: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    category: 'cli',
    status: 'unsupported',
    description:
      "GitHub's terminal AI tool (`gh copilot`) connects to GitHub's hosted backend and does not support custom endpoints. Distinct from the Copilot VS Code extension above, which does support Flint.",
    snippets: { windows: [], unix: [] },
    limitations: [
      'No public mechanism to point gh copilot at a custom backend.',
      'For terminal coding agents on Flint, consider OpenCode or Codex CLI; for editor integration, use Copilot for VS Code (entry above) or Continue.dev.',
    ],
    docsUrl: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
  },

  {
    id: 'openai-codex-app',
    name: 'Codex App (hosted)',
    vendor: 'OpenAI',
    category: 'agent',
    status: 'unsupported',
    description:
      "OpenAI's hosted Codex agent product runs in OpenAI's cloud and cannot be redirected to a local backend.",
    snippets: { windows: [], unix: [] },
    limitations: [
      'Hosted product with no self-hosted or BYO-endpoint mode.',
      'Use the open-source Codex CLI instead if you want a local-backed coding agent.',
    ],
    docsUrl: 'https://openai.com/codex',
  },

  {
    id: 'hermes-agent',
    name: 'Hermes Agent',
    vendor: 'Nous Research',
    category: 'agent',
    status: 'research-needed',
    description:
      'Self-improving agent framework from Nous Research. Backend configuration not yet verified against Flint.',
    snippets: {
      windows: [
        {
          label: 'Likely env-var pattern (unverified)',
          language: 'powershell',
          body:
`$env:OPENAI_BASE_URL = "{ENDPOINT}"
$env:OPENAI_API_KEY  = "not-needed-for-local"
# Confirm the exact env-var names against Hermes docs before relying on this.`,
        },
      ],
      unix: [
        {
          label: 'Likely env-var pattern (unverified)',
          language: 'shell',
          body:
`export OPENAI_BASE_URL="{ENDPOINT}"
export OPENAI_API_KEY="not-needed-for-local"
# Confirm the exact env-var names against Hermes docs before relying on this.`,
        },
      ],
    },
    limitations: [
      'No verified recipe yet — please open an issue if you confirm a working configuration.',
    ],
    docsUrl: 'https://nousresearch.com',
  },

  {
    id: 'openclaw',
    name: 'OpenClaw',
    vendor: 'OpenClaw',
    category: 'agent',
    status: 'community',
    description:
      'Agentic coding tool. OpenClaw natively supports OpenAI-compatible local endpoints — point it at Flint directly per its "local models" gateway docs. No translation proxy required for the standard path.',
    snippets: {
      windows: [
        {
          label: 'Direct OpenAI-compatible config (PowerShell)',
          language: 'powershell',
          body:
`$env:OPENAI_BASE_URL = "{ENDPOINT}"
$env:OPENAI_API_KEY  = "not-needed-for-local"

openclaw  # then select {MODEL} in the model picker

# Exact env-var names and any required provider hint live in the OpenClaw
# "Other OpenAI-compatible local proxies" section linked below.`,
        },
      ],
      unix: [
        {
          label: 'Direct OpenAI-compatible config (bash/zsh)',
          language: 'shell',
          body:
`export OPENAI_BASE_URL="{ENDPOINT}"
export OPENAI_API_KEY="not-needed-for-local"

openclaw  # then select {MODEL} in the model picker

# Exact env-var names and any required provider hint live in the OpenClaw
# "Other OpenAI-compatible local proxies" section linked below.`,
        },
      ],
    },
    limitations: [
      'Tool-calling and streaming features depend on the loaded Flint model exposing OpenAI-style `tool_calls` / streaming.',
      'Optional advanced setup — a LiteLLM proxy in front of Flint provides cross-backend routing (e.g. fallback between local Flint and Azure AI Foundry) and uniform API-key handling, but is not required for direct OpenClaw → Flint use.',
      'See also: flthibau/sample-OpenClaw-on-Azure-with-AI-Foundry, the techbloat.com OpenClaw + Azure Foundry + LiteLLM guide, and the Feb 2026 azurefeeds.com walkthrough — those describe the LiteLLM routing pattern for multi-backend setups.',
    ],
    docsUrl: 'https://open-claw.bot/docs/gateway/local-models/#other-openai-compatible-local-proxies',
  },

  {
    id: 'droid',
    name: 'Droid',
    vendor: 'Factory',
    category: 'cli',
    status: 'research-needed',
    description:
      "Factory's coding agent for terminal and IDEs. Custom-backend configuration not yet verified.",
    snippets: {
      windows: [
        {
          label: 'Placeholder (unverified)',
          language: 'powershell',
          body:
`$env:OPENAI_BASE_URL = "{ENDPOINT}"
$env:OPENAI_API_KEY  = "not-needed-for-local"
# Confirm Droid-specific env vars or config file location against upstream docs.`,
        },
      ],
      unix: [
        {
          label: 'Placeholder (unverified)',
          language: 'shell',
          body:
`export OPENAI_BASE_URL="{ENDPOINT}"
export OPENAI_API_KEY="not-needed-for-local"
# Confirm Droid-specific env vars or config file location against upstream docs.`,
        },
      ],
    },
    limitations: [
      'No verified recipe yet against Flint. Factory.ai\'s docs describe BYO-model paths for some plans — confirm the exact env vars / config keys for your installed Droid version before relying on the snippet.',
      'If Droid only accepts hosted Factory backends in your tier, an OpenAI→whatever-protocol LiteLLM proxy may be required (see the 0.3 "local API-key proxy" roadmap item).',
    ],
    docsUrl: 'https://factory.ai/',
  },

  {
    id: 'pi-toolkit',
    name: 'Pi',
    vendor: 'pi.dev',
    category: 'agent',
    status: 'research-needed',
    description:
      'Minimal AI agent toolkit with plugin support (pi.dev). Backend / model-provider configuration not yet verified against Flint.',
    snippets: {
      windows: [
        {
          label: 'Likely env-var pattern (unverified)',
          language: 'powershell',
          body:
`$env:OPENAI_BASE_URL = "{ENDPOINT}"
$env:OPENAI_API_KEY  = "not-needed-for-local"
# Confirm Pi's actual provider config (package manifest, plugin config, or
# CLI flags at pi.dev/packages) before relying on this.`,
        },
      ],
      unix: [
        {
          label: 'Likely env-var pattern (unverified)',
          language: 'shell',
          body:
`export OPENAI_BASE_URL="{ENDPOINT}"
export OPENAI_API_KEY="not-needed-for-local"
# Confirm Pi's actual provider config (package manifest, plugin config, or
# CLI flags at pi.dev/packages) before relying on this.`,
        },
      ],
    },
    limitations: [
      'No verified Pi recipe yet — please open an issue if you confirm a working Pi plugin/package that targets Flint.',
      'Pi is plugin-based; the backend setting may live in a per-plugin manifest rather than global env vars.',
    ],
    docsUrl: 'https://pi.dev/packages',
  },
];
